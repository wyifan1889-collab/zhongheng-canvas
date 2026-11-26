import { expect, test } from "bun:test";
import { evaluateTextCharge, type TextQuoteSnapshot } from "./text-billing";
import { normalizeChatUsage, normalizeResponsesUsage, parseTextUsageEvidence } from "./text-usage";

// Synthetic values using the documented DeepSeek Chat usage contract.
const counts = { prompt_tokens: 200, completion_tokens: 700, total_tokens: 900 };
const raw = () => ({ ...counts, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 });
const quote: TextQuoteSnapshot = { schemaVersion: 1, budgetCredits: "1", inputCreditsPerMillion: "2",
    cachedInputCreditsPerMillion: "0.2", outputCreditsPerMillion: "4", usageSource: "chat_completions" };

test("DeepSeek top-level cache counts survive normalization and stored evidence without double counting", () => {
    const payload = { ...raw(), completion_tokens_details: { reasoning_tokens: 500 }, private_marker: "do-not-store" };
    const original = structuredClone(payload);
    const evidence = normalizeChatUsage(payload);
    expect(evidence).toMatchObject({ source: "chat_completions", status: "complete", inputTokens: 200, outputTokens: 700,
        totalTokens: 900, cachedInputTokens: 150, reasoningOutputTokens: 500 });
    expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    expect(evidence).not.toHaveProperty("cacheWriteTokens");
    expect(JSON.stringify(evidence)).not.toContain("do-not-store");
    expect(payload).toEqual(original);
});

test("DeepSeek documented nested and top-level cache aliases must agree", () => {
    expect(normalizeChatUsage({ ...raw(), prompt_tokens_details: { cached_tokens: 150 }, input_tokens_details: { cached_tokens: 150 } }))
        .toMatchObject({ status: "complete", cachedInputTokens: 150 });
    for (const details of [{ prompt_tokens_details: { cached_tokens: 149 } }, { input_tokens_details: { cached_tokens: 151 } },
        { prompt_tokens_details: { cached_tokens: 150 }, input_tokens_details: { cached_tokens: 149 } }]) {
        expect(normalizeChatUsage({ ...raw(), ...details })).toMatchObject({ status: "invalid", reason: "invalid_details" });
    }
});

test("DeepSeek cache hit and miss counts need a valid parent and an exact partition when both are reported", () => {
    for (const value of [undefined, null, "150", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 201]) {
        for (const field of ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
            const evidence = normalizeChatUsage({ ...raw(), [field]: value });
            expect(evidence).toMatchObject({ status: "invalid", reason: "invalid_details", cachedInputTokens: null });
            expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
        }
    }
    for (const payload of [
        { ...raw(), prompt_cache_miss_tokens: 49 }, { ...raw(), prompt_cache_miss_tokens: 51 },
        { ...counts, prompt_tokens_details: { cached_tokens: 150 }, prompt_cache_miss_tokens: 49 },
        { completion_tokens: 1, prompt_cache_hit_tokens: 0 }, { completion_tokens: 1, prompt_cache_miss_tokens: 0 },
        { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0,
            prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER, prompt_cache_miss_tokens: 1 },
    ]) expect(normalizeChatUsage(payload)).toMatchObject({ status: "invalid", reason: "invalid_details" });
});

test("DeepSeek explicit cache zero stays distinct from missing counts and no counts are inferred from misses", () => {
    for (const payload of [{ ...counts, prompt_cache_hit_tokens: 0 }, { ...counts, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 200 }]) {
        expect(normalizeChatUsage(payload)).toMatchObject({ status: "complete", cachedInputTokens: 0 });
    }
    for (const payload of [counts, { ...counts, prompt_cache_miss_tokens: 50 }]) {
        expect(normalizeChatUsage(payload)).toMatchObject({ status: "complete", cachedInputTokens: null });
    }
    expect(normalizeChatUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }))
        .toMatchObject({ status: "complete", totalTokens: 0, cachedInputTokens: 0 });
    expect(normalizeChatUsage({ ...raw(), prompt_tokens_details: null })).toMatchObject({ status: "invalid", reason: "invalid_details" });
});

test("DeepSeek Chat aliases do not alter Responses protocol parsing", () => {
    const evidence = normalizeResponsesUsage({ input_tokens: 200, output_tokens: 700,
        input_tokens_details: { cached_tokens: 100 }, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 });
    expect(evidence).toMatchObject({ source: "responses", status: "complete", cachedInputTokens: 100 });
    expect(normalizeResponsesUsage(raw())).toMatchObject({ source: "responses", status: "missing", cachedInputTokens: null });
});

test("DeepSeek cache misses never invent cache writes or bypass the existing settlement evidence policy", () => {
    expect(evaluateTextCharge(quote, normalizeChatUsage(raw()))).toBeNull();
    expect(evaluateTextCharge(quote, normalizeChatUsage({ ...raw(), prompt_tokens_details: { cache_write_tokens: 0 } }))).toBe("0.00293");
    expect(evaluateTextCharge(quote, normalizeChatUsage({ ...raw(), prompt_tokens_details: { cache_write_tokens: 1 } }))).toBeNull();
    const { cachedInputCreditsPerMillion: _cache, ...allInputQuote } = quote;
    expect(evaluateTextCharge(allInputQuote, normalizeChatUsage(raw()))).toBe("0.0032");
    expect(evaluateTextCharge(allInputQuote, normalizeChatUsage({ ...raw(), prompt_cache_miss_tokens: 49 }))).toBeNull();
});
