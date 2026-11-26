import type { CanvasDraft, JsonValue } from "../../../../packages/shared/src/index";
import { createMediaClient } from "../api/media";
import type { CanvasFirstSaveContext, CanvasFirstSaveCounts, CanvasFirstSaveSummary, CanvasFirstSaveCheck } from "./canvas-first-save";
import { inspectCanvasDocument, prepareCanvasDocumentForCloudSave } from "./canvas-document";
import { CanvasCloudMediaOwnershipError, verifyCanvasCloudMediaOwnership, type CanvasCloudMediaResolver } from "./cloud-media-ownership";
import { createDraftClient, DraftError, type DraftAccountScope, type DraftInput } from "./drafts";

export type CanvasVersionPrepared = Readonly<{ id: string; expectedRevision: number; counts: CanvasFirstSaveCounts }>;
export type CanvasVersionSummary = CanvasFirstSaveSummary;
export type CanvasVersionCheck = CanvasFirstSaveCheck;
/** A version selected by the user from the current account's cloud directory. */
export type CanvasVersionSelection = Readonly<{ accountId: string; id: string; revision: number }>;
/** Only passed by a committed, explicitly confirmed mount; never persisted as a receipt. */
export type CanvasMountedVersion = CanvasVersionSelection & Readonly<{ epoch: number; localProjectId: string; updatedAt: string }>;
export type CanvasVersionSessionState = Readonly<{
    status: "empty" | "ready" | "saving" | "conflict" | "unknown" | "blocked";
    id?: string; revision?: number; observedRevision?: number;
}>;
export type CanvasVersionWindowState = Readonly<{
    phase: "idle" | "prepared" | "submitting" | "saved" | "conflict" | "unknown" | "blocked" | "closed";
    id?: string; expectedRevision?: number; counts?: CanvasFirstSaveCounts; observedRevision?: number;
}>;
type VersionClient = Pick<ReturnType<typeof createDraftClient>, "save" | "get">;
type MediaResolverFactory = (getScope: () => DraftAccountScope | null) => CanvasCloudMediaResolver;
type Outcome = "not-sent" | "rejected" | "unknown";
const messages = {
    account_changed: "账户状态已变化，本次结果未采用；已经发送的保存不能据此视为撤销。",
    context_changed: "画布会话已变化，本次结果未采用；已经发送的保存不能据此视为撤销。",
    cloud_unavailable: "云画布保存尚未开放或已关闭，请保留本机作品。",
    window_closed: "保存窗口已关闭，本次结果未采用；已发送的请求可能仍已保存，请主动核对。",
    no_baseline: "本页没有首次保存明确成功的版本基准，不能根据回执或查询结果认领并覆盖云稿。",
    invalid_baseline: "首次保存的成功信息不符合版本基准要求，本次未建立再次保存能力。",
    already_seeded: "本页已有保存会话，不能替换版本基准或通过重新绑定解除只读状态。",
    not_prepared: "请先明确准备本次快照，再提交一次版本保存。",
    already_started: "本窗口已准备或尝试保存，不能重新准备或重复提交。",
    stale_baseline: "本窗口准备后的版本基准已变化，本次未发送；请关闭后重新准备当前内容。",
    readonly: "本页保存会话已进入只读核对状态，不能自动采用新版本或再次覆盖云稿。",
    busy: "已有保存或核对正在处理，请勿并发重复提交。",
    invalid_project: "当前画布不能完整生成对应的 JSON 快照，请保留本机内容。",
    local_media: "画布含本机、外部媒体或未完成任务引用，暂不能进行此项云端 JSON 版本保存。",
    cloud_media: "画布引用的云端素材不存在或不属于当前账号，暂不能保存此版本；请先在资产页确认素材仍存在。",
    revision_conflict: "云端版本已变化，本次版本保存被拒绝；本机内容保留，不自动采用最新版本再次覆盖。",
    unavailable: "保存或核对结果未能确认，请保留本机作品；只可主动核对，不自动重试或覆盖。",
    project_mismatch: "返回的云端记录与当前画布编号不一致，本次未采用，也未改写本机内容。",
    rate_limited: "操作过于频繁，请保留本机作品，等待后主动核对；不会自动重复保存。",
    payload_too_large: "快照超过服务端大小限制，本次版本保存被拒绝，请保留本机内容。",
    invalid_origin: "请求来源不匹配，请保留作品并联系管理员检查配置。",
} as const;
type ErrorCode = keyof typeof messages;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export class CanvasVersionSaveError extends Error {
    readonly retryAfter?: number;
    readonly currentRevision?: number;
    constructor(public readonly code: ErrorCode, public readonly outcome: Outcome, retryAfter?: number, currentRevision?: number) {
        super(messages[code]);
        this.name = "CanvasVersionSaveError";
        if (code === "rate_limited" && positive(retryAfter)) this.retryAfter = retryAfter;
        if (code === "revision_conflict" && positive(currentRevision)) this.currentRevision = currentRevision;
    }
}

/** Page memory only. seedCreation is a trusted UI seam for a direct successful first POST, never GET/receipts. */
export function createCanvasVersionSession(
    getContext: () => CanvasFirstSaveContext | null,
    clientFactory: (getScope: () => DraftAccountScope | null) => VersionClient = createDraftClient,
    mediaResolverFactory: MediaResolverFactory = (getScope) => createMediaClient(() => getScope()?.accountId ?? null),
) {
    function context() { try { return getContext(); } catch { return null; } }
    const initial = context();
    const bound = initial ? { accountId: initial.accountId, epoch: initial.epoch, localProjectId: initial.localProjectId, cloudCanvas: initial.cloudCanvas } : null;
    let status: CanvasVersionSessionState["status"] = "empty", baseline: CanvasVersionSummary | undefined, observedRevision: number | undefined;
    let invalidated: "account_changed" | "context_changed" | "cloud_unavailable" | undefined, writer: symbol | undefined, selecting = false;
    const windows = new Set<() => void>();
    function invalidate(code: NonNullable<typeof invalidated>) {
        invalidated ??= code;
        status = "blocked"; baseline = undefined; observedRevision = undefined; writer = undefined;
        for (const discard of windows) discard();
        windows.clear();
    }
    function assertCurrent(outcome: Outcome) {
        const current = context();
        if (!bound || !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) invalidate("account_changed");
        else if (current.localProjectId !== bound.localProjectId) invalidate("context_changed");
        else if (bound.cloudCanvas !== true || current.cloudCanvas !== true) invalidate("cloud_unavailable");
        if (invalidated) throw new CanvasVersionSaveError(invalidated, outcome);
    }
    function safeError(caught: unknown, outcome: Outcome): CanvasVersionSaveError {
        if (caught instanceof DraftError) {
            if (["account_changed", "account_context_required", "unauthorized"].includes(caught.code)) {
                invalidate("account_changed");
                return new CanvasVersionSaveError("account_changed", outcome);
            }
            if (["revision_conflict", "rate_limited", "payload_too_large", "invalid_origin"].includes(caught.code)) {
                return new CanvasVersionSaveError(caught.code as ErrorCode, outcome, caught.retryAfter, caught.currentRevision);
            }
        }
        return caught instanceof CanvasVersionSaveError
            ? new CanvasVersionSaveError(caught.code, outcome, caught.retryAfter, caught.currentRevision)
            : caught instanceof CanvasCloudMediaOwnershipError
            ? new CanvasVersionSaveError("cloud_media", outcome)
            : new CanvasVersionSaveError("unavailable", outcome);
    }
    function summary(draft: CanvasDraft, id: string, expectedRevision?: number, requireLocalProject = true): CanvasVersionSummary {
        if (!draft || !uuid(draft.id) || draft.id.toLowerCase() !== id || !positive(draft.revision) ||
            (expectedRevision !== undefined && draft.revision !== expectedRevision) || typeof draft.updatedAt !== "string" || !Number.isFinite(Date.parse(draft.updatedAt))) {
            throw new CanvasVersionSaveError("unavailable", "unknown");
        }
        if (typeof draft.document?.id !== "string" || !draft.document.id.trim() || (requireLocalProject && draft.document.id !== bound!.localProjectId)) throw new CanvasVersionSaveError("project_mismatch", "unknown");
        return Object.freeze({ id, revision: draft.revision, updatedAt: draft.updatedAt });
    }
    function readOnlyPhase(): CanvasVersionWindowState["phase"] {
        return status === "conflict" ? "conflict" : status === "unknown" || status === "saving" ? "unknown" : "blocked";
    }
    return Object.freeze({
        /**
         * Receipts are read-only references. They do not carry an account or a version
         * selection and therefore can never establish a write baseline after refresh.
         */
        async resumeFromReceipt(_value: string): Promise<void> {
            assertCurrent("not-sent");
            throw new CanvasVersionSaveError("invalid_baseline", "not-sent");
        },
        /**
         * Establish a baseline only after the user selected and confirmed the
         * account, cloud draft ID, and exact revision from the current directory.
         * The GET is a verification of that selection; it is never a discovery path.
         */
        async resumeFromCloudSelection(selection: CanvasVersionSelection): Promise<void> {
            assertCurrent("not-sent");
            if (status !== "empty") throw new CanvasVersionSaveError("already_seeded", "not-sent");
            if (selecting) throw new CanvasVersionSaveError("busy", "not-sent");
            if (!selection || selection.accountId !== bound?.accountId || !uuid(selection.id) || !positive(selection.revision)) {
                throw new CanvasVersionSaveError("invalid_baseline", "not-sent");
            }
            const id = selection.id.toLowerCase(), revision = selection.revision;
            selecting = true;
            try {
                const draft = await clientFactory(() => {
                    try { assertCurrent("not-sent"); return { accountId: bound!.accountId, epoch: bound!.epoch }; }
                    catch { return null; }
                }).get(id);
                assertCurrent("unknown");
                const current = summary(draft, id, undefined, false);
                if (current.revision !== revision) throw new CanvasVersionSaveError("invalid_baseline", "unknown");
                // A direct creation/mount acknowledgement wins over this older GET.
                if (status !== "empty") throw new CanvasVersionSaveError("already_seeded", "unknown");
                baseline = current;
                status = "ready";
            } catch (caught) {
                assertCurrent("unknown");
                throw safeError(caught, "unknown");
            } finally { selecting = false; }
        },
        seedMounted(value: CanvasMountedVersion): void {
            assertCurrent("not-sent");
            if (status !== "empty") throw new CanvasVersionSaveError("already_seeded", "not-sent");
            if (!value || value.accountId !== bound!.accountId || value.epoch !== bound!.epoch || value.localProjectId !== bound!.localProjectId ||
                !uuid(value.id) || !positive(value.revision) || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
                throw new CanvasVersionSaveError("invalid_baseline", "not-sent");
            }
            baseline = Object.freeze({ id: value.id.toLowerCase(), revision: value.revision, updatedAt: value.updatedAt });
            status = "ready";
        },
        seedCreation(value: CanvasVersionSummary): void {
            assertCurrent("not-sent");
            if (status !== "empty") throw new CanvasVersionSaveError("already_seeded", "not-sent");
            if (!value || !uuid(value.id) || value.revision !== 1 || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
                throw new CanvasVersionSaveError("invalid_baseline", "not-sent");
            }
            baseline = Object.freeze({ id: value.id.toLowerCase(), revision: 1, updatedAt: value.updatedAt });
            status = "ready";
        },
        getState(): CanvasVersionSessionState {
            try { assertCurrent("unknown"); } catch { return Object.freeze({ status: "blocked" }); }
            return Object.freeze({ status, ...(baseline ? { id: baseline.id, revision: baseline.revision } : {}), ...(observedRevision ? { observedRevision } : {}) });
        },
        open() {
            assertCurrent("not-sent");
            const token = Symbol("version-window");
            let phase: CanvasVersionWindowState["phase"] = status === "ready" ? "idle" : readOnlyPhase(), closed = false, checking = false;
            let prepared: CanvasVersionPrepared | undefined, payload: DraftInput | undefined, client: VersionClient | undefined;
            let cloudMediaReferences: ReturnType<typeof inspectCanvasDocument>["mediaReferences"] = [];
            const discard = () => { payload = undefined; prepared = undefined; client = undefined; cloudMediaReferences = []; if (!closed) phase = "blocked"; };
            windows.add(discard);
            function assertWindow(outcome: Outcome) {
                assertCurrent(outcome);
                if (closed) throw new CanvasVersionSaveError("window_closed", outcome);
            }
            function transport(): VersionClient {
                return client ??= clientFactory(() => {
                    try { assertWindow("not-sent"); return { accountId: bound!.accountId, epoch: bound!.epoch }; }
                    catch { return null; }
                });
            }
            return Object.freeze({
                prepare(project: unknown): CanvasVersionPrepared {
                    assertWindow("not-sent");
                    if (!baseline) throw new CanvasVersionSaveError("no_baseline", "not-sent");
                    if (status !== "ready") throw new CanvasVersionSaveError(status === "saving" ? "busy" : "readonly", "not-sent");
                    if (phase !== "idle") throw new CanvasVersionSaveError("already_started", "not-sent");
                    try {
                        const inspection = prepareCanvasDocumentForCloudSave(inspectCanvasDocument(project));
                        if (inspection.snapshot.id !== bound!.localProjectId) throw new CanvasVersionSaveError("invalid_project", "not-sent");
                        const localMediaReferences = inspection.mediaReferences.filter((reference) => reference.kind !== "cloud-media");
                        const counts = Object.freeze({
                            nodes: (inspection.snapshot.nodes as JsonValue[]).length, connections: (inspection.snapshot.connections as JsonValue[]).length,
                            chats: (inspection.snapshot.chatSessions as JsonValue[]).length, localMediaReferences: localMediaReferences.length,
                            omittedOptionalFields: inspection.omittedOptionalPaths.length,
                        });
                        if (localMediaReferences.length) throw new CanvasVersionSaveError("local_media", "not-sent");
                        cloudMediaReferences = inspection.mediaReferences.filter((reference) => reference.kind === "cloud-media");
                        // Detection is not media completeness/safety; preserve HTTPS and extension fields. Public rollout remains gated.
                        assertWindow("not-sent");
                        prepared = Object.freeze({ id: baseline.id, expectedRevision: baseline.revision, counts });
                        payload = { title: inspection.snapshot.title as string, documentVersion: inspection.documentVersion, document: inspection.snapshot };
                        phase = "prepared";
                        return prepared;
                    } catch (caught) {
                        phase = "blocked"; payload = undefined; prepared = undefined;
                        assertWindow("not-sent");
                        throw caught instanceof CanvasVersionSaveError ? safeError(caught, "not-sent") : new CanvasVersionSaveError("invalid_project", "not-sent");
                    }
                },
                async submit(): Promise<CanvasVersionSummary> {
                    assertWindow("not-sent");
                    if (!baseline) throw new CanvasVersionSaveError("no_baseline", "not-sent");
                    if (status !== "ready") throw new CanvasVersionSaveError(status === "saving" ? "busy" : "readonly", "not-sent");
                    if (phase !== "prepared" || !prepared || !payload) throw new CanvasVersionSaveError(phase === "idle" ? "not_prepared" : "already_started", "not-sent");
                    if (prepared.id !== baseline.id || prepared.expectedRevision !== baseline.revision) {
                        phase = "blocked"; payload = undefined;
                        throw new CanvasVersionSaveError("stale_baseline", "not-sent");
                    }
                    const attempt = prepared, snapshot = payload;
                    const mediaReferences = cloudMediaReferences;
                    payload = undefined;
                    // Acquire the page-wide write lock synchronously, before factory calls or the first await.
                    phase = "submitting"; status = "saving"; writer = token;
                    try {
                        if (mediaReferences.length) {
                            await verifyCanvasCloudMediaOwnership(mediaReferences, mediaResolverFactory(() => {
                                try { assertWindow("not-sent"); return { accountId: bound!.accountId, epoch: bound!.epoch }; }
                                catch { return null; }
                            }));
                            assertWindow("not-sent");
                        }
                        const draft = await transport().save(attempt.id, { ...snapshot, expectedRevision: attempt.expectedRevision });
                        assertWindow("unknown");
                        const saved = summary(draft, attempt.id, attempt.expectedRevision + 1);
                        assertWindow("unknown");
                        if (writer !== token || status !== "saving") throw new CanvasVersionSaveError("readonly", "unknown");
                        baseline = saved; observedRevision = undefined; status = "ready"; writer = undefined; phase = "saved";
                        return saved;
                    } catch (caught) {
                        const outcome = caught instanceof CanvasCloudMediaOwnershipError ? "not-sent"
                            : caught instanceof DraftError && ["not-sent", "rejected", "unknown"].includes(caught.outcome) ? caught.outcome : "unknown";
                        assertWindow(outcome);
                        const failure = safeError(caught, outcome);
                        if (!invalidated && writer === token) {
                            status = failure.code === "revision_conflict" ? "conflict" : outcome === "unknown" ? "unknown" : "blocked";
                            observedRevision = failure.code === "revision_conflict" ? failure.currentRevision : undefined;
                            writer = undefined; phase = readOnlyPhase();
                        }
                        throw failure;
                    }
                },
                async reconcile(): Promise<CanvasVersionCheck> {
                    assertWindow("unknown");
                    if (!baseline) throw new CanvasVersionSaveError("no_baseline", "not-sent");
                    if (checking) throw new CanvasVersionSaveError("busy", "unknown");
                    const id = baseline.id;
                    checking = true;
                    try {
                        const draft = await transport().get(id);
                        assertWindow("unknown");
                        const current = summary(draft, id, undefined, false);
                        assertWindow("unknown");
                        // Readback never advances the expected revision, unlocks writes, or proves this attempt succeeded.
                        return Object.freeze({ ...current, status: "found-current" as const });
                    } catch (caught) {
                        assertWindow("unknown");
                        if (caught instanceof DraftError && caught.code === "not_found" && caught.status === 404) return Object.freeze({ id, status: "not-found-yet" as const });
                        throw safeError(caught, "unknown");
                    } finally { checking = false; }
                },
                getState(): CanvasVersionWindowState {
                    if (closed) return Object.freeze({ phase: "closed" });
                    try { assertWindow("unknown"); } catch { return Object.freeze({ phase: "blocked" }); }
                    const visiblePhase = (phase === "idle" || phase === "prepared") && status !== "ready" ? readOnlyPhase() : phase;
                    return Object.freeze({ phase: visiblePhase, ...(baseline ? { id: baseline.id, expectedRevision: prepared?.expectedRevision ?? baseline.revision } : {}),
                        ...(prepared ? { counts: prepared.counts } : {}), ...(observedRevision ? { observedRevision } : {}) });
                },
                close() {
                    if (closed) return;
                    closed = true;
                    if (writer === token && status === "saving") { status = "unknown"; writer = undefined; }
                    discard(); phase = "closed"; windows.delete(discard);
                },
            });
        },
        dispose() { invalidate("context_changed"); },
    });
}
