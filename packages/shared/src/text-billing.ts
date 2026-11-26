import { normalizeCreditAmount } from "./credit-amounts";
import { evaluatePriceRule, type PriceMeter, type PriceTemplate } from "./model-pricing-drafts";
import { parseTextUsageEvidence, type TextUsageEvidence } from "./text-usage";
import { contextTierRates } from "./model-price-derivation";

export type TextSettlementPolicy = { status: "legacy_fixed" } | { status: "context_tiers"; derivation: unknown } | { status: "invalid" };
type TextRates = Pick<TextQuoteSnapshot, "inputCreditsPerMillion" | "outputCreditsPerMillion" | "cachedInputCreditsPerMillion">;
/** Public explanation, never the immutable task quote or evidence of a wallet capture. */
export type TextBillingExplanation = {
    schemaVersion: 1; taskId: string; modelId: string; priceVersion: number;
    policy: TextSettlementPolicy["status"]; tier: "fixed" | "short" | "long" | null;
    totalTokens: number | null; thresholdTokens: 272000 | null; rates: TextRates | null;
    quantities: { inputTokens: number; cachedInputTokens: number | null; outputTokens: number } | null;
    expectedCredits: string | null;
};

export function parseTextBillingExplanation(value: unknown): TextBillingExplanation | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>, safeCount = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
    if (row.schemaVersion !== 1 || typeof row.taskId !== "string" || !row.taskId || typeof row.modelId !== "string" || !row.modelId ||
        !Number.isSafeInteger(row.priceVersion) || Number(row.priceVersion) <= 0 || !["legacy_fixed", "context_tiers", "invalid"].includes(String(row.policy))) return null;
    const identity = { schemaVersion: 1 as const, taskId: row.taskId, modelId: row.modelId, priceVersion: row.priceVersion as number,
        policy: row.policy as TextBillingExplanation["policy"] };
    const thresholdTokens = row.policy === "context_tiers" ? 272000 : null;
    if (row.thresholdTokens !== thresholdTokens) return null;
    if (row.tier === null) {
        if (row.rates !== null || row.quantities !== null || row.expectedCredits !== null || row.totalTokens !== null) return null;
        return { ...identity, thresholdTokens, tier: null, totalTokens: null, rates: null, quantities: null, expectedCredits: null };
    }
    if (row.policy === "invalid" || !safeCount(row.totalTokens) ||
        row.tier !== (row.policy === "legacy_fixed" ? "fixed" : row.totalTokens <= 272000 ? "short" : "long") ||
        !row.rates || typeof row.rates !== "object" || Array.isArray(row.rates) || !row.quantities || typeof row.quantities !== "object" || Array.isArray(row.quantities)) return null;
    const rawRates = row.rates as Record<string, unknown>, q = row.quantities as Record<string, unknown>;
    const rates: TextRates = { inputCreditsPerMillion: rawRates.inputCreditsPerMillion as string, outputCreditsPerMillion: rawRates.outputCreditsPerMillion as string,
        ...(Object.hasOwn(rawRates, "cachedInputCreditsPerMillion") ? { cachedInputCreditsPerMillion: rawRates.cachedInputCreditsPerMillion as string } : {}) };
    if (!safeCount(q.inputTokens) || !safeCount(q.outputTokens) || !safeCount(q.inputTokens + q.outputTokens) || row.totalTokens !== q.inputTokens + q.outputTokens ||
        (q.cachedInputTokens !== null && (!safeCount(q.cachedInputTokens) || q.cachedInputTokens > q.inputTokens)) ||
        (row.policy === "context_tiers" && rates.cachedInputCreditsPerMillion === undefined)) return null;
    const quote = parseTextQuoteSnapshot({ schemaVersion: 1, budgetCredits: "1", usageSource: "responses", ...rates });
    if (!quote || (rates.cachedInputCreditsPerMillion !== undefined && q.cachedInputTokens === null)) return null;
    const usage = { schemaVersion: 1, source: "responses", status: "complete", reason: null,
        inputTokens: q.inputTokens, outputTokens: q.outputTokens, totalTokens: row.totalTokens, totalSource: "derived",
        cachedInputTokens: q.cachedInputTokens, reasoningOutputTokens: null, ...(rates.cachedInputCreditsPerMillion === undefined ? {} : { cacheWriteTokens: 0 }) };
    const expectedCredits = evaluateTextCharge(quote, usage);
    if (expectedCredits === null || row.expectedCredits !== expectedCredits) return null;
    return { ...identity, thresholdTokens, tier: row.tier as "fixed" | "short" | "long", totalTokens: row.totalTokens,
        rates, quantities: { inputTokens: q.inputTokens, outputTokens: q.outputTokens, cachedInputTokens: q.cachedInputTokens as number | null }, expectedCredits };
}

/** The caller must resolve the original publication first; invalid never means fixed short rates. */
export function resolveTextSettlement(snapshot: unknown, evidence: unknown, policy: TextSettlementPolicy): {
    tier: "fixed" | "short" | "long"; rates: TextRates; totalTokens: number; quantities: NonNullable<TextBillingExplanation["quantities"]>; expectedCredits: string;
} | null {
    const quote = parseTextQuoteSnapshot(snapshot), usage = parseTextUsageEvidence(evidence);
    if (!quote || !usage || usage.status !== "complete" || usage.totalTokens === null || policy.status === "invalid") return null;
    let tier: "fixed" | "short" | "long" = "fixed", rates: TextRates = { inputCreditsPerMillion: quote.inputCreditsPerMillion,
        outputCreditsPerMillion: quote.outputCreditsPerMillion, ...(quote.cachedInputCreditsPerMillion === undefined ? {} : { cachedInputCreditsPerMillion: quote.cachedInputCreditsPerMillion }) };
    if (policy.status === "context_tiers") {
        const tiers = contextTierRates(policy.derivation);
        if (!tiers || tiers.short.inputCreditsPerMillion !== quote.inputCreditsPerMillion || tiers.short.outputCreditsPerMillion !== quote.outputCreditsPerMillion ||
            tiers.short.cachedInputCreditsPerMillion !== quote.cachedInputCreditsPerMillion) return null;
        tier = usage.totalTokens <= 272000 ? "short" : "long";
        rates = tiers[tier];
    }
    const expectedCredits = evaluateTextCharge({ ...quote, ...rates }, usage);
    return expectedCredits === null ? null : { tier, rates, totalTokens: usage.totalTokens,
        quantities: { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, cachedInputTokens: usage.cachedInputTokens }, expectedCredits };
}

export function explainTextBilling(task: { id: string; modelId: string; priceVersion: number; textQuoteSnapshot: unknown }, evidence: unknown, policy: TextSettlementPolicy): TextBillingExplanation {
    const fixed = resolveTextSettlement(task.textQuoteSnapshot, evidence, policy);
    return { schemaVersion: 1, taskId: task.id, modelId: task.modelId, priceVersion: task.priceVersion, policy: policy.status,
        thresholdTokens: policy.status === "context_tiers" ? 272000 : null,
        ...(fixed ? { tier: fixed.tier, totalTokens: fixed.totalTokens, rates: fixed.rates, quantities: fixed.quantities, expectedCredits: fixed.expectedCredits }
            : { tier: null, totalTokens: null, rates: null, quantities: null, expectedCredits: null }) };
}

/** User-approved reservation budget and immutable published rates, not an upstream spend limit. */
export type TextQuoteSnapshot = {
    schemaVersion: 1;
    budgetCredits: string;
    inputCreditsPerMillion: string;
    outputCreditsPerMillion: string;
    usageSource: TextUsageEvidence["source"];
    /** Presence selects non-cached input + cached input + output pricing. */
    cachedInputCreditsPerMillion?: string;
};

export function parseTextQuoteSnapshot(value: unknown): TextQuoteSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const cached = Object.hasOwn(row, "cachedInputCreditsPerMillion");
    const keys = ["schemaVersion", "budgetCredits", "inputCreditsPerMillion", "outputCreditsPerMillion", "usageSource", ...(cached ? ["cachedInputCreditsPerMillion"] : [])];
    if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key)) || row.schemaVersion !== 1 ||
        (row.usageSource !== "chat_completions" && row.usageSource !== "responses")) return null;
    for (const key of ["budgetCredits", "inputCreditsPerMillion", "outputCreditsPerMillion", ...(cached ? ["cachedInputCreditsPerMillion"] : [])]) {
        const amount = row[key];
        if (typeof amount !== "string" || amount === "0" || amount.startsWith("-") || normalizeCreditAmount(amount) !== amount) return null;
    }
    return { schemaVersion: 1, budgetCredits: row.budgetCredits as string,
        inputCreditsPerMillion: row.inputCreditsPerMillion as string, outputCreditsPerMillion: row.outputCreditsPerMillion as string,
        usageSource: row.usageSource,
        ...(cached ? { cachedInputCreditsPerMillion: row.cachedInputCreditsPerMillion as string } : {}) };
}

/** Each side's template owns its input semantics; never share reduced quantities
 * between an all-input tariff and a separate-cache tariff. Writes need a tariff
 * of their own and are deliberately not executable with the read-only template.
 */
export function textUsagePriceQuantities(template: PriceTemplate, evidence: unknown): Partial<Record<PriceMeter, string>> | null {
    const usage = parseTextUsageEvidence(evidence);
    if (!usage || usage.status !== "complete" || !["text_tokens", "text_cached_tokens"].includes(template)) return null;
    if (template === "text_tokens") return { input_token: String(usage.inputTokens), output_token: String(usage.outputTokens) };
    if (usage.cacheWriteTokens !== 0) return null;
    return { output_token: String(usage.outputTokens), ...(usage.cachedInputTokens !== null ? {
        input_token: String(usage.inputTokens! - usage.cachedInputTokens), cached_input_token: String(usage.cachedInputTokens),
    } : {}) };
}

/** Missing/invalid required evidence is never a zero charge. */
export function evaluateTextCharge(snapshot: unknown, evidence: unknown): string | null {
    const quote = parseTextQuoteSnapshot(snapshot), usage = parseTextUsageEvidence(evidence);
    if (!quote || !usage || usage.status !== "complete" || usage.source !== quote.usageSource) return null;
    const cached = Object.hasOwn(quote, "cachedInputCreditsPerMillion"), template = cached ? "text_cached_tokens" : "text_tokens";
    const quantities = textUsagePriceQuantities(template, usage);
    if (!quantities) return null;
    const result = evaluatePriceRule({ template, currency: "credit", bands: [{ parameters: {}, rates: {
        input_token: quote.inputCreditsPerMillion, output_token: quote.outputCreditsPerMillion,
        ...(cached ? { cached_input_token: quote.cachedInputCreditsPerMillion } : {}),
    } }] }, {}, quantities);
    return result.status === "calculated" && result.total !== null ? normalizeCreditAmount(result.total) : null;
}
