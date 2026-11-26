import { expect, test } from "bun:test";
import { evaluateTextCharge, parseTextQuoteSnapshot, type TextQuoteSnapshot } from "./text-billing";
import { normalizeChatUsage, normalizeResponsesUsage, parseTextUsageEvidence } from "./text-usage";
import { publishedTextDraftRates } from "./model-price-publications";
import { evaluateTextUsageDraft } from "./text-usage-review";
import { deriveModelPriceRules, parseModelPriceDerivation, type ModelPriceDerivation } from "./model-price-derivation";
import type { AdminModelPriceDraft, ModelPriceBinding, ModelPriceRule, ModelPriceRules } from "./model-pricing-drafts";

const binding: ModelPriceBinding = { providerId: "fixture", providerModel: "fixture-text", adapter: "openai-compatible", endpoint: "https://provider.example.invalid/v1", capability: "text" };
const rates = { input_token: "2", cached_input_token: "0.2", output_token: "4" };
const quote: TextQuoteSnapshot = { schemaVersion: 1, budgetCredits: "0.01", inputCreditsPerMillion: "2", outputCreditsPerMillion: "4", cachedInputCreditsPerMillion: "0.2", usageSource: "responses" };
const rule = (cache: boolean, currency: ModelPriceRule["currency"]): ModelPriceRule => ({
    template: cache ? "text_cached_tokens" : "text_tokens", currency, bands: [{ parameters: {}, rates: cache ? { ...rates } : { input_token: "2", output_token: "4" } }],
});
const usage = (details: Record<string, unknown> = { cached_tokens: 150, cache_write_tokens: 0 }) => normalizeResponsesUsage({ input_tokens: 200, output_tokens: 700,
    input_tokens_details: details, output_tokens_details: { reasoning_tokens: 500 } });

test("tiny and half-Q8 three-bucket charges remain exact without per-request quantization", () => {
    const tiny = { ...quote, inputCreditsPerMillion: "0.5", cachedInputCreditsPerMillion: "0.05", outputCreditsPerMillion: "2.5" };
    expect(evaluateTextCharge(tiny, normalizeResponsesUsage({ input_tokens: 1, output_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }))).toBe("0.0000005");
    expect(evaluateTextCharge(tiny, normalizeResponsesUsage({ input_tokens: 1, output_tokens: 0,
        input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 } }))).toBe("0.00000005");
    for (const write of [null, "0", -1, 0.1]) expect(evaluateTextCharge(tiny, normalizeResponsesUsage({ input_tokens: 1, output_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: write } }))).toBeNull();
});

test("cache read rates are immutable exact components, with strict quote presence and no zero-rate policy change", () => {
    expect(parseTextQuoteSnapshot(quote)).toEqual(quote);
    const rules: ModelPriceRules = { schemaVersion: 1, cost: null, sale: rule(true, "credit") };
    expect(publishedTextDraftRates(binding, rules)).toEqual({ billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: "2", cachedInputCreditsPerMillion: "0.2", outputCreditsPerMillion: "4" });
    for (const value of [undefined, null, "0", "0.00", 0.2, "0.20", "-1"]) {
        expect(parseTextQuoteSnapshot({ ...quote, cachedInputCreditsPerMillion: value })).toBeNull();
    }
    for (const value of [null, "0", undefined]) {
        rules.sale.bands[0].rates.cached_input_token = value;
        expect(publishedTextDraftRates(binding, rules)).toBeNull();
    }
    expect(publishedTextDraftRates(binding, { ...rules, sale: { ...rule(false, "credit"), bands: [{ parameters: {}, rates }] } })).toBeNull();
});

test("separate read pricing subtracts cache once, keeps reasoning in output, and preserves historical all-input pricing", () => {
    const evidence = usage(), original = structuredClone({ quote, evidence });
    expect(evaluateTextCharge(quote, evidence)).toBe("0.00293");
    const { cachedInputCreditsPerMillion: _cache, ...old } = quote;
    expect(evaluateTextCharge(old, evidence)).toBe("0.0032");
    expect(evaluateTextCharge({ ...quote, usageSource: "chat_completions" }, normalizeChatUsage({ prompt_tokens: 200, completion_tokens: 700,
        prompt_tokens_details: { cached_tokens: 150, cache_write_tokens: 0 } }))).toBe("0.00293");
    expect(evaluateTextCharge(quote, normalizeResponsesUsage({ input_tokens: 0, output_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }))).toBe("0");
    expect({ quote, evidence }).toEqual(original);
});

test("missing reads, unreported writes, positive writes, invalid subsets and wrong protocol never settle a cache tariff", () => {
    for (const evidence of [usage({ cached_tokens: 150 }), usage({ cache_write_tokens: 0 }), usage({ cached_tokens: 150, cache_write_tokens: 1 }),
        usage({ cached_tokens: 150, cache_write_tokens: 51 }), usage({ cached_tokens: 201, cache_write_tokens: 0 }),
        normalizeChatUsage({ prompt_tokens: 200, completion_tokens: 700, prompt_tokens_details: { cached_tokens: 150, cache_write_tokens: 0 } })]) {
        expect(evaluateTextCharge(quote, evidence)).toBeNull();
    }
    const { cachedInputCreditsPerMillion: _cache, ...old } = quote;
    expect(evaluateTextCharge(old, usage({ cached_tokens: 150, cache_write_tokens: 1 }))).toBe("0.0032");
});

test("write totals and lifetime breakdown must agree, and explicit zero is retained without private provider fields", () => {
    const evidence = usage({ cached_tokens: 10, cache_write_tokens: 70, cache_write_tokens_details: { ttl_30m_tokens: 30, ttl_12h_tokens: 40 }, secret: "private-marker" });
    expect(evidence.cacheWriteTokens).toBe(70);
    expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    expect(parseTextUsageEvidence(usage())).toHaveProperty("cacheWriteTokens", 0);
    expect(usage({ cached_tokens: 150 })).not.toHaveProperty("cacheWriteTokens");
    expect(JSON.stringify(evidence)).not.toContain("private-marker");
    for (const details of [
        { cache_write_tokens: null }, { cache_write_tokens: "1" }, { cache_write_tokens: -1 },
        { cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 } },
        { cache_write_tokens: 1, cache_write_tokens_details: { ttl_30m_tokens: 1, ttl_12h_tokens: 1 } },
        { cache_write_tokens: 1, cache_write_tokens_details: { ttl_30m_tokens: 1 } },
        { cache_write_tokens: 1, cache_write_tokens_details: { ttl_30m_tokens: 1, ttl_12h_tokens: 0, unknown: 1 } },
    ]) expect(usage(details)).toMatchObject({ status: "invalid", reason: "invalid_details" });
    expect(parseTextUsageEvidence({ ...normalizeResponsesUsage(null), cacheWriteTokens: 0 })).toBeNull();
    expect(parseTextUsageEvidence({ ...usage(), cacheWriteTokens: undefined })).toBeNull();
    expect(parseTextUsageEvidence({ ...usage(), cacheWriteTokens: 51 })).toBeNull();
    expect(normalizeChatUsage({ prompt_tokens: 200, completion_tokens: 700, prompt_tokens_details: { cache_write_tokens: 0 },
        input_tokens_details: { cache_write_tokens: 1 } })).toMatchObject({ status: "invalid", reason: "invalid_details" });
});

test("read-only cost and sale simulation each use their own total-input or separate-cache template", () => {
    const draft: AdminModelPriceDraft = { id: "fixture-draft", modelId: "fixture", version: 1, createdAt: "2026-10-25T00:00:00.000Z",
        binding, bindingMatchesCurrent: true, priceNote: "synthetic", rules: { schemaVersion: 1, cost: rule(false, "USD"), sale: rule(true, "credit") } };
    expect(evaluateTextUsageDraft("fixture", usage(), draft)).toMatchObject({ status: "calculated", cost: { total: "0.0032" }, sale: { total: "0.00293" } });
    draft.rules = { schemaVersion: 1, cost: rule(true, "USD"), sale: rule(false, "credit") };
    expect(evaluateTextUsageDraft("fixture", usage(), draft)).toMatchObject({ status: "calculated", cost: { total: "0.00293" }, sale: { total: "0.0032" } });
    expect(evaluateTextUsageDraft("fixture", usage({ cached_tokens: 150 }), draft)).toEqual({ status: "blocked", reason: "missing_usage" });
    expect(evaluateTextUsageDraft("fixture", usage({ cached_tokens: 150, cache_write_tokens: 1 }), draft)).toEqual({ status: "blocked", reason: "unsupported_usage" });
    expect(evaluateTextUsageDraft("fixture", usage({ cache_write_tokens: 0 }), draft)).toMatchObject({ status: "calculated", cost: { status: "missing_usage" } });
});

test("official multipliers can map all three read-only-cache rows but cannot discard a write row", () => {
    const basis = rule(true, "USD"), value: ModelPriceDerivation = { schemaVersion: 1, kind: "multiplier", binding, basis,
        costMultiplier: "0.5", saleMultiplier: "2", creditsPerCurrency: "10", source: { kind: "official", application: "fixed_baseline", sourceId: "openai", version: 1,
            checkedAt: "2026-10-25T00:00:00.000Z", entry: { id: "openai:fixture", modelName: "Fixture", context: "Fixed read-only cache baseline",
                rates: [{ label: "Input", usdPerMillion: "2" }, { label: "Cached input", usdPerMillion: "0.2" }, { label: "Output", usdPerMillion: "4" }] },
            mapping: { Input: "input_token", "Cached input": "cached_input_token", Output: "output_token" } } };
    expect(parseModelPriceDerivation(value, "text")).toEqual(value);
    expect(deriveModelPriceRules(value)?.sale.bands[0].rates).toEqual({ input_token: "40", cached_input_token: "4", output_token: "80" });
    if (value.source.kind !== "official") throw new Error("fixture source");
    value.source.entry.rates.push({ label: "30m cache write", usdPerMillion: "2.5" });
    expect(deriveModelPriceRules(value)).toBeNull();
});
