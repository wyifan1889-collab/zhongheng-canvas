import { normalizeCreditAmount, compareCreditAmounts, addCreditAmounts } from "../../../../packages/shared/src/credit-amounts";
import { parseTextPriceDerivationMetadata, type TextPriceDerivationMetadata } from "../../../../packages/shared/src/model-price-publications";
import { parseTextUsageEvidence, type TextUsageEvidence } from "../../../../packages/shared/src/text-usage";
import { parseTextBillingExplanation, type TextBillingExplanation } from "../../../../packages/shared/src/text-billing";
import { GenerationError, sameGenerationScope, type GenerationScope, type GenerationModel } from "./generation";
export type TextGenerationModel = Omit<GenerationModel, "capability"> & { capability: "text" };
export type TextGenerationIntent = { modelId: string; input: { prompt: string }; parameters: Record<string, never>; projectId: string; budgetCredits: string };
export type TextQuoteSnapshot = { schemaVersion: 1; budgetCredits: string; inputCreditsPerMillion: string; outputCreditsPerMillion: string; cachedInputCreditsPerMillion?: string; usageSource: "chat_completions" | "responses" };
export type TextGenerationQuote = Omit<TextQuoteSnapshot, "schemaVersion"> & { modelId: string; priceVersion: number; billingUnit: "text_tokens"; priceNote?: string; textPriceDerivation?: TextPriceDerivationMetadata };
export type TextGenerationTaskView = {
    task: { id: string; projectId: string; modelId: string; priceVersion: number; textQuoteSnapshot: TextQuoteSnapshot;
        executionStatus: "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
        deliveryStatus: "pending" | "saved" | "visible" | "failed" | "unknown";
        billingStatus: "unbilled" | "reserved" | "captured" | "released" | "pending_review";
        billing: { reservedCredits: string; capturedCredits: string; releasedCredits: string } | null;
        textBillingExplanation?: TextBillingExplanation | null };
    result: { taskId: string; status: "succeeded" | "failed" | "unknown"; resultSnapshot: { kind?: "text"; text?: string; usageEvidence?: TextUsageEvidence } } | null;
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const modelId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(value);
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,197}$/.test(value);
const amount = (value: unknown, positiveOnly = false): value is string => typeof value === "string" && normalizeCreditAmount(value) === value && compareCreditAmounts(value, "0") >= (positiveOnly ? 1 : 0);
const unknownResult = (writing: boolean, status?: number) => new GenerationError("unconfirmed", writing ? "提交结果尚未确认，请保留回执并主动核对，不要重复提交。" : "任务读取未完成，请稍后主动核对。", writing ? "unknown" : "not-sent", status);
const invalid = () => new GenerationError("invalid_input", "请填写文本、模型和有效的本次预算。", "not-sent");
function snapshot(value: unknown): TextQuoteSnapshot | null {
    if (!record(value) || value.schemaVersion !== 1 || !amount(value.budgetCredits, true) || !amount(value.inputCreditsPerMillion) || !amount(value.outputCreditsPerMillion) ||
        (Object.hasOwn(value, "cachedInputCreditsPerMillion") && !amount(value.cachedInputCreditsPerMillion, true)) ||
        (value.usageSource !== "chat_completions" && value.usageSource !== "responses")) return null;
    return { schemaVersion: 1, budgetCredits: value.budgetCredits, inputCreditsPerMillion: value.inputCreditsPerMillion, outputCreditsPerMillion: value.outputCreditsPerMillion,
        ...(Object.hasOwn(value, "cachedInputCreditsPerMillion") ? { cachedInputCreditsPerMillion: value.cachedInputCreditsPerMillion as string } : {}), usageSource: value.usageSource };
}
/** Explicit text requests preserve the original account/project boundary and never retry. */
export function createTextGenerationClient(options: { scope: GenerationScope; getScope: () => GenerationScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ ...options.scope }), fetcher = options.fetcher ?? fetch;
    let invalidated = false;
    function check(outcome: "not-sent" | "unknown") {
        if (invalidated || !sameGenerationScope(options.getScope(), scope)) {
            invalidated = true;
            throw new GenerationError("context_changed", "账号或画布已变化，请在原账号和画布中重新打开回执核对。", outcome);
        }
    }
    async function request(path: string, body?: object, idempotencyKey?: string): Promise<unknown> {
        const writing = idempotencyKey !== undefined;
        check("not-sent");
        let response: Response, data: unknown;
        try {
            response = await fetcher(path, {
                method: body ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            check(writing ? "unknown" : "not-sent");
            data = await response.json();
            check(writing ? "unknown" : "not-sent");
        } catch (error) {
            check(writing ? "unknown" : "not-sent");
            if (error instanceof GenerationError) throw error;
            throw unknownResult(writing);
        }
        if (!response.ok) {
            const code = record(data) && record(data.error) ? data.error.code : undefined;
            const errors: Record<string, [number, string]> = {
                invalid_input: [400, "生成请求格式不正确。"], unsupported_generation: [400, "当前模型或参数尚不支持平台文本生成。"],
                idempotency_required: [400, "缺少生成回执编号。"], idempotency_invalid: [400, "生成回执编号无效。"],
                account_context_required: [400, "页面账号与登录状态不一致，请重新确认账号。"], account_changed: [409, "页面账号与登录状态不一致，请重新确认账号。"],
                unauthorized: [401, "登录已失效，请重新登录后核对回执。"], forbidden: [403, "当前账号无权执行此操作。"],
                invalid_origin: [403, "请求来源不匹配，请联系管理员。"], not_found: [404, "尚未查到任务；提交可能仍在处理，请保留回执稍后核对。"],
                insufficient_balance: [402, "可用积分不足，本次未创建任务。"], price_changed: [409, "价格已变化，本次未创建任务，请重新获取并确认报价。"],
                idempotency_conflict: [409, "此回执已用于另一请求，请保留回执核对。"], generation_unavailable: [503, "平台文本生成暂未开放或当前模型不可用。"],
            };
            const known = typeof code === "string" ? errors[code] : undefined;
            if (known && known[0] === response.status) {
                if (["account_changed", "account_context_required", "unauthorized"].includes(code as string)) invalidated = true;
                throw new GenerationError(code as string, known[1], code === "idempotency_conflict" ? "unknown" : "rejected", response.status);
            }
            throw unknownResult(writing, response.status);
        }
        return data;
    }
    function intent(value: TextGenerationIntent): TextGenerationIntent {
        const budget = normalizeCreditAmount(value.budgetCredits);
        if (!modelId(value.modelId) || !value.input || typeof value.input.prompt !== "string" || !value.input.prompt.trim() || value.projectId !== scope.projectId || !record(value.parameters) || Object.keys(value.parameters).length || budget === null || compareCreditAmounts(budget, "0") <= 0) throw invalid();
        return { modelId: value.modelId, input: { prompt: value.input.prompt }, parameters: {}, projectId: scope.projectId, budgetCredits: budget };
    }
    function view(data: unknown, writing: boolean, taskId?: string): TextGenerationTaskView {
        const task = record(data) ? data.task : undefined, result = record(data) ? data.result : undefined;
        if (!record(task) || !uuid(task.id) || (taskId !== undefined && task.id !== taskId) || task.projectId !== scope.projectId || !modelId(task.modelId) || !positive(task.priceVersion) ||
            task.quotedUnits !== null || task.billingUnitSnapshot !== null || task.creditsPerUnitSnapshot !== null ||
            !["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"].includes(String(task.executionStatus)) ||
            !["pending", "saved", "visible", "failed", "unknown"].includes(String(task.deliveryStatus)) || !["unbilled", "reserved", "captured", "released", "pending_review"].includes(String(task.billingStatus))) throw unknownResult(writing);
        const pricing = snapshot(task.textQuoteSnapshot), billing = task.billing;
        if (!pricing) throw unknownResult(writing);
        let safeBilling: TextGenerationTaskView["task"]["billing"] = null;
        if (billing !== null) {
            if (!record(billing) || !amount(billing.reservedCredits) || !amount(billing.capturedCredits) || !amount(billing.releasedCredits) || billing.reservedCredits !== pricing.budgetCredits) throw unknownResult(writing);
            try { if (compareCreditAmounts(addCreditAmounts(billing.capturedCredits, billing.releasedCredits), pricing.budgetCredits) > 0) throw unknownResult(writing); }
            catch { throw unknownResult(writing); }
            safeBilling = { reservedCredits: billing.reservedCredits, capturedCredits: billing.capturedCredits, releasedCredits: billing.releasedCredits };
        }
        let safeResult: TextGenerationTaskView["result"] = null;
        if (result !== null) {
            if (!record(result) || result.taskId !== task.id || !["succeeded", "failed", "unknown"].includes(String(result.status)) || !record(result.resultSnapshot)) throw unknownResult(writing);
            const resultSnapshot: NonNullable<TextGenerationTaskView["result"]>["resultSnapshot"] = {};
            if (result.resultSnapshot.kind !== undefined && result.resultSnapshot.kind !== "text") throw unknownResult(writing);
            if (result.resultSnapshot.kind === "text") resultSnapshot.kind = "text";
            if (result.resultSnapshot.text !== undefined) {
                if (typeof result.resultSnapshot.text !== "string" || result.resultSnapshot.text.length > 200_000) throw unknownResult(writing);
                resultSnapshot.text = result.resultSnapshot.text;
            }
            if (result.resultSnapshot.usageEvidence !== undefined) {
                const usage = parseTextUsageEvidence(result.resultSnapshot.usageEvidence);
                if (!usage || usage.source !== pricing.usageSource) throw unknownResult(writing);
                resultSnapshot.usageEvidence = usage;
            }
            safeResult = { taskId: task.id, status: result.status as NonNullable<TextGenerationTaskView["result"]>["status"], resultSnapshot };
        }
        let explanation = parseTextBillingExplanation(task.textBillingExplanation);
        if (explanation && (explanation.taskId !== task.id || explanation.modelId !== task.modelId || explanation.priceVersion !== task.priceVersion)) explanation = null;
        if (explanation?.quantities) {
            const usage = safeResult?.resultSnapshot.usageEvidence, quantities = explanation.quantities;
            if (!usage || usage.status !== "complete" || usage.totalTokens !== explanation.totalTokens || usage.inputTokens !== quantities.inputTokens ||
                usage.outputTokens !== quantities.outputTokens || usage.cachedInputTokens !== quantities.cachedInputTokens ||
                explanation.rates?.cachedInputCreditsPerMillion !== undefined && usage.cacheWriteTokens !== 0) explanation = null;
        }
        if (explanation?.rates && explanation.tier !== "long" && (explanation.rates.inputCreditsPerMillion !== pricing.inputCreditsPerMillion ||
            explanation.rates.outputCreditsPerMillion !== pricing.outputCreditsPerMillion || explanation.rates.cachedInputCreditsPerMillion !== pricing.cachedInputCreditsPerMillion)) explanation = null;
        return { task: { id: task.id, projectId: task.projectId, modelId: task.modelId, priceVersion: task.priceVersion, textQuoteSnapshot: pricing,
            executionStatus: task.executionStatus as TextGenerationTaskView["task"]["executionStatus"], deliveryStatus: task.deliveryStatus as TextGenerationTaskView["task"]["deliveryStatus"], billingStatus: task.billingStatus as TextGenerationTaskView["task"]["billingStatus"],
            billing: safeBilling, ...(Object.hasOwn(task, "textBillingExplanation") ? { textBillingExplanation: explanation } : {}) }, result: safeResult };
    }
    return Object.freeze({
        async models(): Promise<TextGenerationModel[]> {
            const data = await request("/api/v1/generation/text/models"); check("not-sent");
            if (!record(data) || !Array.isArray(data.items)) throw unknownResult(false);
            return data.items.map(item => {
                if (!record(item) || !modelId(item.id) || typeof item.displayName !== "string" || item.capability !== "text") throw unknownResult(false);
                const group = item.group;
                if (group !== null && (!record(group) || !uuid(group.id) || typeof group.name !== "string" || !group.name.trim() || group.name !== group.name.trim() || group.name.length > 120 || /[\u0000-\u001f\u007f]/.test(group.name) || !Number.isSafeInteger(group.order) || (group.order as number) < 0)) throw unknownResult(false);
                return { id: item.id, displayName: item.displayName, capability: "text", group: group === null ? null : { id: group.id as string, name: group.name as string, order: group.order as number } };
            });
        },
        async quote(value: TextGenerationIntent): Promise<TextGenerationQuote> {
            const input = intent(value), data = await request("/api/v1/generation/text/quote", input); check("not-sent");
            const quote = record(data) ? data.quote : undefined, pricing = record(quote) ? snapshot({ ...quote, schemaVersion: 1 }) : null;
            if (!record(quote) || !pricing || quote.modelId !== input.modelId || !positive(quote.priceVersion) || quote.billingUnit !== "text_tokens" || pricing.budgetCredits !== input.budgetCredits || (quote.priceNote !== undefined && typeof quote.priceNote !== "string")) throw unknownResult(false);
            const { schemaVersion: _schema, ...rates } = pricing;
            const explanation = quote.textPriceDerivation === undefined ? undefined : parseTextPriceDerivationMetadata(quote.textPriceDerivation, quote.priceVersion);
            if (explanation === null) throw unknownResult(false);
            return { ...rates, modelId: quote.modelId, priceVersion: quote.priceVersion, billingUnit: "text_tokens", ...(quote.priceNote !== undefined ? { priceNote: quote.priceNote } : {}), ...(explanation ? { textPriceDerivation: explanation } : {}) };
        },
        async submit(value: TextGenerationIntent, confirmedPriceVersion: number, idempotencyKey: string): Promise<TextGenerationTaskView> {
            if (!positive(confirmedPriceVersion) || !key(idempotencyKey)) throw invalid();
            const input = intent(value), result = view(await request("/api/v1/generation/text/tasks", { ...input, confirmedPriceVersion }, idempotencyKey), true); check("unknown");
            if (result.task.modelId !== input.modelId || result.task.priceVersion !== confirmedPriceVersion || result.task.textQuoteSnapshot.budgetCredits !== input.budgetCredits) throw unknownResult(true);
            return result;
        },
        async get(taskId: string): Promise<TextGenerationTaskView> {
            if (!uuid(taskId)) throw invalid();
            const result = view(await request(`/api/v1/generation/tasks/${taskId}`), false, taskId); check("not-sent"); return result;
        },
        async getByKey(idempotencyKey: string): Promise<TextGenerationTaskView> {
            if (!key(idempotencyKey)) throw invalid();
            const result = view(await request(`/api/v1/generation/tasks/by-key/${encodeURIComponent(idempotencyKey)}`), false); check("not-sent"); return result;
        },
    });
}
export type TextGenerationClient = ReturnType<typeof createTextGenerationClient>;
