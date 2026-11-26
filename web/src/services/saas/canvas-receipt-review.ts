import { createReceiptedDraftClient } from "./creation-receipts";
import { DraftError, type DraftAccountScope, type DraftCreationCheck, type DraftCreationReference } from "./drafts";

export type CanvasReceiptReviewContext = DraftAccountScope & { localProjectId: string };
export type CanvasReceiptReviewRow =
    | { readonly id: string; readonly status: "unchecked" | "not-found-yet" }
    | { readonly id: string; readonly status: "found-current"; readonly revision: number; readonly updatedAt: string };
type ReviewClient = { recover(localProjectId: string): Promise<DraftCreationReference[]> };
const messages = {
    account_changed: "账户状态已变化，本次结果未采用。请重新确认账户后打开回执核对。",
    context_changed: "当前画布或窗口状态已变化，本次结果未采用。请重新打开回执核对。",
    superseded: "已有新的核对操作，本次较早返回未采用。",
    not_loaded: "请先读取当前画布的本机回执，再选择已有编号核对。",
    receipt_unavailable: "本机回执读取未完成，请保留作品和已有回执，不要重新创建或覆盖。",
    unavailable: "云端核对未完成，请保留当前作品和回执，稍后主动核对。",
    project_mismatch: "云端记录与当前画布编号不一致，本次未采用，也未覆盖本机内容。",
    rate_limited: "核对过于频繁，请保留当前作品和回执，等待后主动核对。",
} as const;

export class CanvasReceiptReviewError extends Error {
    readonly retryAfter?: number;
    constructor(public readonly code: keyof typeof messages, retryAfter?: number) {
        super(messages[code]);
        this.name = "CanvasReceiptReviewError";
        if (code === "rate_limited" && Number.isSafeInteger(retryAfter) && retryAfter! > 0) this.retryAfter = retryAfter;
    }
}

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** A window-scoped read controller. Full GET responses are projected, never cached or applied. */
export function createCanvasReceiptReview(
    getContext: () => CanvasReceiptReviewContext | null,
    clientFactory: (getScope: () => DraftAccountScope | null) => ReviewClient = createReceiptedDraftClient,
) {
    function context() { try { return getContext(); } catch { return null; } }
    const initial = context();
    const bound = initial ? { accountId: initial.accountId, epoch: initial.epoch, localProjectId: initial.localProjectId } : null;
    let client: ReviewClient | undefined, invalidated: "account_changed" | "context_changed" | undefined, operation = 0;
    let references = new Map<string, () => Promise<DraftCreationCheck>>();
    function invalidate(code: "account_changed" | "context_changed") {
        invalidated ??= code;
        references.clear();
        client = undefined;
    }
    function assertCurrent(expectedOperation?: number) {
        const current = context();
        if (!bound || !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) invalidate("account_changed");
        else if (current.localProjectId !== bound.localProjectId) invalidate("context_changed");
        if (invalidated) throw new CanvasReceiptReviewError(invalidated);
        if (expectedOperation !== undefined && expectedOperation !== operation) throw new CanvasReceiptReviewError("superseded");
    }
    function failure(error: unknown, expectedOperation: number, fallback: "receipt_unavailable" | "unavailable"): never {
        assertCurrent(expectedOperation);
        if (error instanceof DraftError) {
            if (["account_changed", "account_context_required", "unauthorized"].includes(error.code)) {
                invalidate("account_changed");
                throw new CanvasReceiptReviewError("account_changed");
            }
            if (error.code === "rate_limited") throw new CanvasReceiptReviewError("rate_limited", error.retryAfter);
        }
        if (error instanceof CanvasReceiptReviewError) throw new CanvasReceiptReviewError(error.code, error.retryAfter);
        throw new CanvasReceiptReviewError(fallback);
    }
    return Object.freeze({
        async load(): Promise<CanvasReceiptReviewRow[]> {
            assertCurrent();
            const currentOperation = ++operation;
            references.clear();
            try {
                client ??= clientFactory(() => {
                    const current = context();
                    return current ? { accountId: current.accountId, epoch: current.epoch } : null;
                });
                const found = await client.recover(bound!.localProjectId);
                assertCurrent(currentOperation);
                if (!Array.isArray(found)) throw new CanvasReceiptReviewError("receipt_unavailable");
                const loaded = new Map<string, () => Promise<DraftCreationCheck>>();
                for (const reference of found) {
                    if (!reference || !uuid(reference.id) || typeof reference.reconcile !== "function" || loaded.has(reference.id.toLowerCase())) throw new CanvasReceiptReviewError("receipt_unavailable");
                    loaded.set(reference.id.toLowerCase(), reference.reconcile);
                }
                assertCurrent(currentOperation);
                references = loaded;
                return [...loaded.keys()].map((id) => Object.freeze({ id, status: "unchecked" as const }));
            } catch (error) { return failure(error, currentOperation, "receipt_unavailable"); }
        },
        async check(id: string): Promise<CanvasReceiptReviewRow> {
            assertCurrent();
            const normalized = uuid(id) ? id.toLowerCase() : "", reconcile = references.get(normalized);
            if (!reconcile) throw new CanvasReceiptReviewError("not_loaded");
            const currentOperation = ++operation;
            try {
                const checked = await reconcile();
                assertCurrent(currentOperation);
                let result: CanvasReceiptReviewRow;
                if (checked?.status === "not-found-yet") result = { id: normalized, status: "not-found-yet" };
                else if (checked?.status === "found-current") {
                    const draft = checked.draft;
                    if (!draft || !uuid(draft.id) || draft.id.toLowerCase() !== normalized || !Number.isSafeInteger(draft.revision) || draft.revision <= 0 ||
                        typeof draft.updatedAt !== "string" || !Number.isFinite(Date.parse(draft.updatedAt))) throw new CanvasReceiptReviewError("unavailable");
                    if (draft.document?.id !== bound!.localProjectId) throw new CanvasReceiptReviewError("project_mismatch");
                    result = { id: normalized, status: "found-current", revision: draft.revision, updatedAt: draft.updatedAt };
                } else throw new CanvasReceiptReviewError("unavailable");
                assertCurrent(currentOperation);
                return Object.freeze(result);
            } catch (error) { return failure(error, currentOperation, "unavailable"); }
        },
        dispose() { invalidate("context_changed"); },
    });
}
