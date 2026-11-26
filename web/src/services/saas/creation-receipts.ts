import { createCreationReceiptStore, type CreationReceipt } from "./creation-receipt-store";
import { createDraftClient, DraftError, type DraftAccountScope, type DraftCreationIntent, type DraftCreationReference, type DraftInput } from "./drafts";

type ReceiptStore = Pick<ReturnType<typeof createCreationReceiptStore>, "put" | "list">;
type ReceiptStoreWithClaim = ReceiptStore & Partial<Pick<ReturnType<typeof createCreationReceiptStore>, "claim">>;

/** Receipt metadata only. Does not open/replace the original canvas store or apply cloud content. */
export function createReceiptedDraftClient(
    getScope: () => DraftAccountScope | null,
    receipts: ReceiptStoreWithClaim = createCreationReceiptStore(),
    fetcher: typeof fetch = fetch,
) {
    const initial = getScope();
    const bound = initial ? { ...initial } : null;
    const drafts = createDraftClient(getScope, fetcher);
    let invalidated = false;
    function checkScope() {
        const current = getScope();
        if (invalidated || !bound || !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) {
            invalidated = true;
            throw new DraftError("account_changed", "账户状态已变化，本次未发送。请重新确认账户，不要转存旧作品。", 0, "not-sent");
        }
        return bound;
    }
    function projectId(value: string) {
        if (typeof value !== "string" || !value.trim()) {
            throw new DraftError("invalid_input", "缺少画布编号，请保留当前作品。", 0, "not-sent");
        }
        return value;
    }
    async function storage<T>(operation: () => Promise<T>, creationId?: string): Promise<T> {
        checkScope();
        try {
            const result = await operation();
            checkScope();
            return result;
        } catch (error) {
            checkScope();
            if (error instanceof DraftError && error.code === "account_changed") throw error;
            throw new DraftError("receipt_unavailable", "保存回执未能可靠读写，本次网络请求未发送。请保留作品和已有回执；先前保存结果仍需核对。", 0, "not-sent", undefined, undefined, creationId);
        }
    }
    return {
        prepareCreate(localProjectId: string, value: DraftInput): DraftCreationIntent {
            const account = checkScope();
            projectId(localProjectId);
            // Snapshot synchronously, before the first storage await; never persist this document.
            const intent = drafts.prepareCreate(value);
            if (value.document.id !== localProjectId) {
                throw new DraftError("invalid_input", "画布编号与待保存内容不一致，本次未发送。", 0, "not-sent");
            }
            const receipt: CreationReceipt = Object.freeze({ accountId: account.accountId, localProjectId, creationId: intent.id });
            return Object.freeze({
                id: intent.id,
                reconcile: intent.reconcile,
                async submit() {
                    // Every explicit submission must have a committed receipt before any POST.
                    drafts.recoverCreate(intent.id); // Also rejects a client invalidated by a prior 401.
                    const claimed = receipts.claim ? await storage(() => receipts.claim!(receipt), intent.id) : "claimed";
                    if (claimed === "busy") {
                        throw new DraftError("creation_in_progress", "当前画布已有其他标签准备保存，本次未发送；请保留当前内容并先核对已有回执。", 0, "not-sent", undefined, undefined, intent.id);
                    }
                    if (claimed === "claimed") await storage(() => receipts.put(receipt), intent.id);
                    return intent.submit();
                },
            });
        },
        async recover(localProjectId: string): Promise<DraftCreationReference[]> {
            const account = checkScope();
            projectId(localProjectId);
            return storage(async () => {
                const found = await receipts.list(account.accountId, localProjectId);
                checkScope();
                // Validate scope again at the seam. Stored identifiers never grant server access.
                if (!Array.isArray(found) || found.some((item) => !item || item.accountId !== account.accountId || item.localProjectId !== localProjectId)) {
                    throw new Error("invalid-receipt-scope");
                }
                // Keep every intent. Do not infer a winner from titles, order or a missing cloud row.
                return found.map((item) => drafts.recoverCreate(item.creationId));
            });
        },
    };
}
