import type { CanvasDraft, JsonValue } from "../../../../packages/shared/src/index";
import { createMediaClient } from "../api/media";
import { inspectCanvasDocument, prepareCanvasDocumentForCloudSave } from "./canvas-document";
import { CanvasCloudMediaOwnershipError, verifyCanvasCloudMediaOwnership, type CanvasCloudMediaResolver } from "./cloud-media-ownership";
import { createReceiptedDraftClient } from "./creation-receipts";
import { DraftError, type DraftAccountScope, type DraftCreationReference } from "./drafts";

export type CanvasFirstSaveContext = DraftAccountScope & { localProjectId: string; cloudCanvas: boolean };
export type CanvasFirstSaveCounts = Readonly<{
    nodes: number; connections: number; chats: number; localMediaReferences: number; omittedOptionalFields: number;
}>;
export type CanvasFirstSavePrepared = Readonly<{ id: string; counts: CanvasFirstSaveCounts }>;
export type CanvasFirstSaveSummary = Readonly<{ id: string; revision: number; updatedAt: string }>;
export type CanvasFirstSaveCheck = (CanvasFirstSaveSummary & { readonly status: "found-current" }) | { readonly id: string; readonly status: "not-found-yet" };
export type CanvasFirstSaveState = Readonly<{
    phase: "idle" | "preparing" | "prepared" | "submitting" | "submitted" | "blocked" | "disposed";
    id?: string; counts?: CanvasFirstSaveCounts;
}>;
type SaveClient = Pick<ReturnType<typeof createReceiptedDraftClient>, "recover" | "prepareCreate">;
type MediaResolverFactory = (getScope: () => DraftAccountScope | null) => CanvasCloudMediaResolver;
type Outcome = "not-sent" | "rejected" | "unknown";
const messages = {
    cloud_unavailable: "云画布保存尚未开放或已关闭，请继续保留本机作品。",
    account_changed: "账户状态已变化，本次结果未采用。已开始的保存不能据此视为撤销，请保留回执。",
    context_changed: "画布或窗口状态已变化，本次结果未采用。已开始的保存不能据此视为撤销，请保留回执。",
    invalid_project: "画布快照未能完整检查，请保留当前作品，不要强行提交。",
    local_media: "画布含本机、外部媒体或未完成任务引用，暂不能进行此项云端 JSON 保存；请保留本机作品。",
    cloud_media: "画布引用的云端素材不存在或不属于当前账号，暂不能保存；请先在资产页确认素材仍存在。",
    existing_receipts: "当前画布已有保存回执，请先使用只读核对入口；本次不生成新的保存编号。",
    creation_in_progress: "当前画布已有其他标签准备保存，本次未发送；请保留当前内容并先核对已有回执。",
    receipt_unavailable: "保存回执未能可靠读取或写入，请保留作品和已有回执，先核对此前结果。",
    not_prepared: "请先显式准备本次快照，再进行一次提交。",
    already_started: "本窗口已经准备或尝试过保存，不能重新创建或重复提交；请保留回执并主动核对。",
    not_submitted: "本窗口尚未尝试提交，没有可核对的本次保存结果。",
    busy: "本次操作尚未结束，请等待返回后再主动核对。",
    unavailable: "保存或核对结果尚未确认，请保留本机作品和回执，不要重复创建或覆盖。",
    project_mismatch: "云端记录与当前画布编号不一致，本次结果未采用，也未覆盖本机内容。",
    rate_limited: "操作过于频繁，请保留当前作品和回执，等待后主动核对。",
    creation_exists: "本次保存编号已有云端记录，本次没有覆盖；请保留回执并主动核对。",
    payload_too_large: "快照超过服务端大小限制，本次保存被拒绝；请保留本机作品和回执。",
    invalid_origin: "请求来源不匹配，请保留作品和回执，联系管理员检查配置。",
} as const;
type ErrorCode = keyof typeof messages;

export class CanvasFirstSaveError extends Error {
    readonly retryAfter?: number;
    constructor(public readonly code: ErrorCode, public readonly outcome: Outcome, public readonly creationId?: string, retryAfter?: number) {
        super(messages[code]);
        this.name = "CanvasFirstSaveError";
        if (code === "rate_limited" && Number.isSafeInteger(retryAfter) && retryAfter! > 0) this.retryAfter = retryAfter;
    }
}

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** One explicit preparation and one submission per window; no retries or original-store writes. */
export function createCanvasFirstSave(
    getContext: () => CanvasFirstSaveContext | null,
    clientFactory: (getScope: () => DraftAccountScope | null) => SaveClient = createReceiptedDraftClient,
    mediaResolverFactory: MediaResolverFactory = (getScope) => createMediaClient(() => getScope()?.accountId ?? null),
) {
    function context() { try { return getContext(); } catch { return null; } }
    const initial = context();
    const bound = initial ? { accountId: initial.accountId, epoch: initial.epoch, localProjectId: initial.localProjectId, cloudCanvas: initial.cloudCanvas } : null;
    let phase: CanvasFirstSaveState["phase"] = "idle", counts: CanvasFirstSaveCounts | undefined, reference: DraftCreationReference | undefined;
    let submitter: (() => Promise<CanvasDraft>) | undefined, invalidated: "account_changed" | "context_changed" | "cloud_unavailable" | undefined;
    let disposed = false, checking = false;
    function error(code: ErrorCode, outcome: Outcome, retryAfter?: number, creationId?: string) {
        return new CanvasFirstSaveError(code, outcome, invalidated ? undefined : creationId ?? reference?.id, retryAfter);
    }
    function invalidate(code: NonNullable<typeof invalidated>) {
        invalidated ??= code;
        submitter = undefined;
        reference = undefined;
        counts = undefined;
    }
    function assertCurrent(outcome: Outcome) {
        const current = context();
        if (!bound || !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) invalidate("account_changed");
        else if (current.localProjectId !== bound.localProjectId) invalidate("context_changed");
        else if (bound.cloudCanvas !== true || current.cloudCanvas !== true) invalidate("cloud_unavailable");
        if (invalidated) throw error(invalidated, outcome);
    }
    // This complete guard is also checked inside the existing receipt await, before any POST.
    function guardedScope(): DraftAccountScope | null {
        try { assertCurrent("not-sent"); return { accountId: bound!.accountId, epoch: bound!.epoch }; }
        catch { return null; }
    }
    function failure(caught: unknown, fallback: ErrorCode, fallbackOutcome: Outcome, preserveOutcome = false): never {
        const outcome = preserveOutcome && caught instanceof DraftError && ["not-sent", "rejected", "unknown"].includes(caught.outcome) ? caught.outcome : fallbackOutcome;
        assertCurrent(outcome);
        if (caught instanceof DraftError) {
            if (["account_changed", "account_context_required", "unauthorized"].includes(caught.code)) {
                invalidate("account_changed");
                throw error("account_changed", outcome);
            }
            if (["receipt_unavailable", "creation_in_progress", "rate_limited", "creation_exists", "payload_too_large", "invalid_origin"].includes(caught.code)) throw error(caught.code as ErrorCode, outcome, caught.retryAfter);
        }
        if (caught instanceof CanvasFirstSaveError) throw error(caught.code, outcome, caught.retryAfter, caught.creationId);
        if (caught instanceof CanvasCloudMediaOwnershipError) throw error("cloud_media", outcome);
        throw error(fallback, outcome);
    }
    function summary(draft: CanvasDraft, outcome: Outcome): CanvasFirstSaveSummary {
        const current = reference;
        if (!current || !draft || !uuid(draft.id) || draft.id.toLowerCase() !== current.id || !Number.isSafeInteger(draft.revision) || draft.revision <= 0 ||
            typeof draft.updatedAt !== "string" || !Number.isFinite(Date.parse(draft.updatedAt))) throw error("unavailable", outcome);
        if (draft.document?.id !== bound!.localProjectId) throw error("project_mismatch", outcome);
        return Object.freeze({ id: current.id, revision: draft.revision, updatedAt: draft.updatedAt });
    }
    return Object.freeze({
        async prepare(project: unknown): Promise<CanvasFirstSavePrepared> {
            assertCurrent("not-sent");
            if (phase !== "idle") throw error("already_started", "not-sent");
            phase = "preparing";
            let fallback: ErrorCode = "invalid_project";
            try {
                // Snapshot before the first await; edits during the receipt read belong to another snapshot.
                const inspection = prepareCanvasDocumentForCloudSave(inspectCanvasDocument(project));
                if (inspection.snapshot.id !== bound!.localProjectId) throw error("invalid_project", "not-sent");
                const localMediaReferences = inspection.mediaReferences.filter((reference) => reference.kind !== "cloud-media");
                const snapshotCounts = Object.freeze({
                    nodes: (inspection.snapshot.nodes as JsonValue[]).length,
                    connections: (inspection.snapshot.connections as JsonValue[]).length,
                    chats: (inspection.snapshot.chatSessions as JsonValue[]).length,
                    localMediaReferences: localMediaReferences.length,
                    omittedOptionalFields: inspection.omittedOptionalPaths.length,
                });
                counts = snapshotCounts;
                if (localMediaReferences.length) throw error("local_media", "not-sent");
                if (inspection.mediaReferences.length) {
                    fallback = "cloud_media";
                    await verifyCanvasCloudMediaOwnership(inspection.mediaReferences, mediaResolverFactory(guardedScope));
                    assertCurrent("not-sent");
                }
                // Zero detected local references is NOT media completeness/safety. The overall cloud gate stays authoritative.
                // Preserve HTTPS URLs and JSON extensions as supplied; never silently strip plugin fields or secrets.
                fallback = "receipt_unavailable";
                const client = clientFactory(guardedScope);
                const existing = await client.recover(bound!.localProjectId);
                assertCurrent("not-sent");
                if (!Array.isArray(existing)) throw error("receipt_unavailable", "not-sent");
                if (existing.length) {
                    // A single scoped receipt can be explicitly promoted to a version-save
                    // baseline by the UI after it reads the current cloud draft. Multiple
                    // receipts remain read-only because there is no safe winner to infer.
                    throw error("existing_receipts", "not-sent", undefined, existing.length === 1 ? existing[0].id : undefined);
                }
                fallback = "unavailable";
                const intent = client.prepareCreate(bound!.localProjectId, {
                    title: inspection.snapshot.title as string, documentVersion: inspection.documentVersion, document: inspection.snapshot,
                });
                if (!uuid(intent.id) || typeof intent.submit !== "function" || typeof intent.reconcile !== "function") throw error("unavailable", "not-sent");
                assertCurrent("not-sent");
                reference = Object.freeze({ id: intent.id.toLowerCase(), reconcile: intent.reconcile });
                submitter = intent.submit;
                phase = "prepared";
                return Object.freeze({ id: reference.id, counts: snapshotCounts });
            } catch (caught) {
                phase = "blocked";
                return failure(caught, fallback, "not-sent");
            }
        },
        async submit(): Promise<CanvasFirstSaveSummary> {
            assertCurrent("not-sent");
            if (phase !== "prepared" || !submitter) throw error(phase === "idle" || phase === "preparing" ? "not_prepared" : "already_started", "not-sent");
            const send = submitter;
            submitter = undefined;
            phase = "submitting";
            try {
                const draft = await send();
                assertCurrent("unknown");
                const result = summary(draft, "unknown");
                assertCurrent("unknown");
                return result;
            } catch (caught) { return failure(caught, "unavailable", "unknown", true); }
            finally { phase = "submitted"; }
        },
        async reconcile(): Promise<CanvasFirstSaveCheck> {
            assertCurrent("unknown");
            if (phase === "submitting" || checking) throw error("busy", "unknown");
            if (phase !== "submitted" || !reference) throw error("not_submitted", "not-sent");
            checking = true;
            try {
                const checked = await reference.reconcile();
                assertCurrent("unknown");
                let result: CanvasFirstSaveCheck;
                if (checked?.status === "not-found-yet") result = { id: reference.id, status: "not-found-yet" };
                else if (checked?.status === "found-current") result = { ...summary(checked.draft, "unknown"), status: "found-current" };
                else throw error("unavailable", "unknown");
                assertCurrent("unknown");
                return Object.freeze(result);
            } catch (caught) { return failure(caught, "unavailable", "unknown"); }
            finally { checking = false; }
        },
        getState(): CanvasFirstSaveState {
            try { assertCurrent("unknown"); } catch { /* State access never exposes an old account's identifiers. */ }
            return Object.freeze(invalidated ? { phase: disposed ? "disposed" : "blocked" } : {
                phase, ...(reference ? { id: reference.id } : {}), ...(counts ? { counts } : {}),
            });
        },
        dispose() { disposed = true; invalidate("context_changed"); },
    });
}
