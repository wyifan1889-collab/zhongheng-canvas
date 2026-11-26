import { GenerationError, sameGenerationScope, type GenerationScope } from "./generation";
import type { TextGenerationClient, TextGenerationIntent, TextGenerationQuote, TextGenerationTaskView } from "./text-generation";
import { createTextGenerationReceiptStore, parseTextGenerationReceipt as receipt, parseTextTargetBinding, parseTextConfigBinding, sameTextTargetBinding, sameTextConfigBinding, type TextGenerationReceipt, type TextGenerationReceiptStore, type TextTargetBinding, type TextConfigBinding } from "./canvas-text-receipt";
import { invalidatePlatformWallet } from "./platform-wallet-refresh";
type GenerationRejection = "price_changed" | "insufficient_balance";
const storageError = () => new GenerationError("receipt_storage", "本机任务回执读取未完成，请保留回执。", "not-sent");
const rejectionError = (code: GenerationRejection) => new GenerationError(code, code === "price_changed" ? "价格已变化，请重新查看并确认费用。" : "积分不足，本次未创建任务。", "rejected", code === "price_changed" ? 409 : 402);
export type CanvasTextGenerationState = Readonly<{
    phase: "idle" | "preparing" | "ready" | "submitting" | "uncertain" | "tracking" | "rejected" | "failed" | "closed";
    busy: boolean;
    intentInvalidated: boolean;
    quote: TextGenerationQuote | null;
    view: TextGenerationTaskView | null;
    receipt: TextGenerationReceipt | null;
    error: GenerationError | null;
}>;

/** Owns a single confirmation and its read-only recovery; never owns canvas nodes or media URLs. */
export function createCanvasTextGenerationController(options: {
    client: TextGenerationClient;
    getContext: () => GenerationScope | null;
    receiptStore?: Pick<TextGenerationReceiptStore, "put" | "list">;
    createIdempotencyKey?: () => string;
    target?: TextTargetBinding;
    beforeTargetReceipt?: (target: TextTargetBinding) => Promise<void>;
    configTarget?: TextConfigBinding;
    beforeConfigReceipt?: (target: TextConfigBinding) => Promise<void>;
    getIntentCurrent?: () => boolean;
}) {
    const initial = options.getContext(), scope = initial ? Object.freeze({ ...initial }) : null;
    const target = options.target === undefined ? undefined : parseTextTargetBinding(options.target);
    const configTarget = options.configTarget === undefined ? undefined : parseTextConfigBinding(options.configTarget);
    if (target && configTarget) throw storageError();
    const receipts = options.receiptStore ?? createTextGenerationReceiptStore(), listeners = new Set<() => void>();
    let active = true, attempted = false, intentInvalidated = false, submittedOrRestored = false, intent: TextGenerationIntent | null = null;
    let state: CanvasTextGenerationState = Object.freeze({ phase: "idle", busy: false, intentInvalidated: false, quote: null, view: null, receipt: null, error: null });
    function isCurrent() { return active && !!scope && sameGenerationScope(options.getContext(), scope); }
    function set(patch: Partial<CanvasTextGenerationState>) {
        state = Object.freeze({ ...state, ...patch });
        // An observer cannot change whether a submitted request is recorded or reconciled.
        for (const listener of listeners) { try { listener(); } catch { /* React owns observer errors. */ } }
    }
    function close() { if (active) { active = false; intent = null; set({ phase: "closed", busy: false, quote: null, view: null, error: null }); listeners.clear(); } }
    function check() {
        if (!isCurrent()) { close(); throw new GenerationError("context_changed", "当前窗口、账号或画布已变化，请重新打开原画布核对。", attempted ? "unknown" : "not-sent"); }
    }
    // Only new quote/POST preparation checks inputs. Accepted/recovered tasks keep read-only recovery.
    const intentError = () => new GenerationError("intent_changed", "原配置或引用已变化，未发送新生成请求。请重新预览并确认。", "not-sent");
    function invalidateIntent() {
        if (!active || !options.getIntentCurrent || submittedOrRestored || intentInvalidated) return;
        intentInvalidated = true; intent = null;
        set({ intentInvalidated: true, quote: null, error: intentError() });
    }
    function checkIntent() {
        let current = !intentInvalidated;
        try { if (current && options.getIntentCurrent) current = options.getIntentCurrent() === true; } catch { current = false; }
        if (!current) {
            invalidateIntent();
            throw intentError();
        }
    }
    function failure(error: unknown, uncertain: boolean) {
        if (!isCurrent()) { close(); return state; }
        const safe = error instanceof GenerationError ? error : new GenerationError("unconfirmed", "操作结果尚未确认，请保留回执并主动核对。", uncertain ? "unknown" : "not-sent");
        set({ phase: uncertain ? "uncertain" : "failed", busy: false, error: safe });
        return state;
    }
    function checkView(view: TextGenerationTaskView, reference: TextGenerationReceipt) {
        if (view.task.projectId !== reference.projectId || view.task.priceVersion !== reference.priceVersion || (reference.taskId && reference.taskId !== view.task.id)) {
            throw new GenerationError("unconfirmed", "任务与本机回执不一致，请保留回执联系管理员核对。", "unknown");
        }
    }
    async function accept(view: TextGenerationTaskView, reference: TextGenerationReceipt) {
        check();
        checkView(view, reference);
        invalidatePlatformWallet(scope!);
        const next = receipt({ ...reference, taskId: view.task.id });
        // This write always targets the captured original partition, including if the view closes while IDB commits.
        await receipts.put(next);
        check();
        const stored = next.configTarget ? (await receipts.list(next.accountId, next.projectId)).find(item => item.idempotencyKey === next.idempotencyKey) : next;
        check();
        if (!stored || stored.taskId !== next.taskId || stored.priceVersion !== next.priceVersion || !sameTextConfigBinding(stored.configTarget, next.configTarget)) throw storageError();
        set({ phase: "tracking", busy: false, view, receipt: stored, error: null });
        return state;
    }
    async function refresh() {
        if (state.busy || !state.receipt || state.receipt.rejection) return state;
        try {
            check();
            const reference = state.receipt;
            set({ busy: true, error: null });
            const view = reference.taskId ? await options.client.get(reference.taskId) : await options.client.getByKey(reference.idempotencyKey);
            check();
            return await accept(view, reference);
        } catch (error) { return failure(error, true); }
    }
    return Object.freeze({
        getState: () => state,
        isCurrent,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        close,
        invalidateIntent,
        startNew() {
            if (!isCurrent()) { close(); return false; }
            if (intentInvalidated || state.busy || state.phase !== "rejected" || !state.receipt?.rejection) return false;
            attempted = false; submittedOrRestored = false; intent = null;
            set({ phase: "idle", quote: null, view: null, receipt: null, error: null });
            return true;
        },
        async prepare(value: { modelId: string; prompt: string; budgetCredits: string }) {
            if (state.busy || attempted || state.receipt) return state;
            try {
                check();
                checkIntent();
                const next: TextGenerationIntent = { modelId: value.modelId, input: { prompt: value.prompt }, parameters: {}, projectId: scope!.projectId, budgetCredits: value.budgetCredits };
                intent = null;
                set({ phase: "preparing", busy: true, quote: null, view: null, error: null });
                const quote = await options.client.quote(next);
                check();
                checkIntent();
                intent = next;
                set({ phase: "ready", busy: false, quote: Object.freeze({ ...quote }) });
                return state;
            } catch (error) { return failure(error, false); }
        },
        async confirm() {
            if (state.busy || attempted || state.phase !== "ready" || !intent || !state.quote) return state;
            let sent = false, reference: TextGenerationReceipt | undefined;
            try {
                check();
                checkIntent();
                attempted = true;
                const fixedIntent = intent, quote = state.quote;
                reference = receipt({ accountId: scope!.accountId, projectId: scope!.projectId, idempotencyKey: (options.createIdempotencyKey ?? (() => crypto.randomUUID()))(), priceVersion: quote.priceVersion,
                    ...(target ? { textTarget: target } : {}), ...(configTarget ? { configTarget } : {}) });
                set({ phase: "submitting", busy: true, receipt: reference, error: null });
                if (target) { await options.beforeTargetReceipt?.(target); check(); checkIntent(); }
                if (configTarget) {
                    if (!options.beforeConfigReceipt) throw new GenerationError("config_target_unready", "原配置保护尚未就绪，未发送生成请求。", "not-sent");
                    await options.beforeConfigReceipt(configTarget); check(); checkIntent();
                }
                await receipts.put(reference);
                check();
                checkIntent();
                sent = true;
                submittedOrRestored = true;
                const view = await options.client.submit(fixedIntent, quote.priceVersion, reference.idempotencyKey);
                check();
                if (view.task.modelId !== quote.modelId || view.task.textQuoteSnapshot.budgetCredits !== quote.budgetCredits || view.task.textQuoteSnapshot.inputCreditsPerMillion !== quote.inputCreditsPerMillion || view.task.textQuoteSnapshot.outputCreditsPerMillion !== quote.outputCreditsPerMillion || view.task.textQuoteSnapshot.cachedInputCreditsPerMillion !== quote.cachedInputCreditsPerMillion || view.task.textQuoteSnapshot.usageSource !== quote.usageSource) throw new GenerationError("unconfirmed", "任务报价与确认内容不一致，请保留回执核对。", "unknown");
                return await accept(view, reference);
            } catch (error) {
                const rejected = error instanceof GenerationError && error.outcome === "rejected";
                // Only these complete POST responses prove this new intent was not accepted.
                if (sent && reference && isCurrent() && rejected && ((error.code === "price_changed" && error.status === 409) || (error.code === "insufficient_balance" && error.status === 402))) {
                    try {
                        const next = receipt({ ...reference, rejection: error.code as GenerationRejection });
                        await receipts.put(next);
                        check();
                        set({ phase: "rejected", busy: false, quote: null, view: null, receipt: next, error: rejectionError(next.rejection!) });
                        return state;
                    } catch {
                        return failure(new GenerationError("receipt_storage", "未受理结果未能保存，请保留回执并核对，不要重复提交。", "unknown"), true);
                    }
                }
                return failure(error, sent && !rejected);
            } finally { intent = null; }
        },
        async listReceipts(): Promise<TextGenerationReceipt[]> {
            check();
            const result = await receipts.list(scope!.accountId, scope!.projectId);
            check();
            return result;
        },
        async restoreReceipt(value: TextGenerationReceipt) {
            if (state.busy || attempted || state.receipt) return state;
            try {
                check();
                const reference = receipt(value);
                if (reference.accountId !== scope!.accountId || reference.projectId !== scope!.projectId) throw new GenerationError("context_changed", "此回执属于其他账号或画布。", "not-sent");
                attempted = true;
                submittedOrRestored = true;
                intent = null;
                set({ phase: "uncertain", busy: true, receipt: reference, quote: null, view: null, error: null });
                const stored = (await receipts.list(scope!.accountId, scope!.projectId)).find((item) => item.idempotencyKey === reference.idempotencyKey);
                check();
                if (!stored || stored.priceVersion !== reference.priceVersion || (reference.taskId && reference.taskId !== stored.taskId) || !sameTextTargetBinding(reference.textTarget, stored.textTarget) || !sameTextConfigBinding(reference.configTarget, stored.configTarget)) throw storageError();
                if (stored.rejection) {
                    set({ phase: "rejected", busy: false, receipt: stored, error: rejectionError(stored.rejection) });
                    return state;
                }
                set({ busy: false, receipt: stored });
                return await refresh();
            } catch (error) { return failure(error, !!state.receipt); }
        },
        refresh,
    });
}
