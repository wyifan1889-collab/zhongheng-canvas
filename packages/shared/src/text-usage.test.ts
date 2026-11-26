import { expect, test } from "bun:test";
import { normalizeChatUsage, normalizeResponsesUsage, parseTextUsageEvidence } from "./text-usage";

test("Responses usage preserves its source and excludes private fields without double-counting subsets", () => {
    const evidence = normalizeResponsesUsage({ input_tokens: 12, output_tokens: 8, total_tokens: 20,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 8 },
        provider_secret: "private-marker" });
    expect(evidence).toEqual({ schemaVersion: 1, source: "responses", status: "complete", inputTokens: 12, outputTokens: 8,
        totalTokens: 20, totalSource: "reported", cachedInputTokens: 5, cacheWriteTokens: 3, reasoningOutputTokens: 8, reason: null });
    expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain("private-marker");
    expect(evidence).not.toHaveProperty("cache_write_tokens");
});

test("Responses usage keeps missing and partial counts distinct from explicit zero", () => {
    for (const raw of [undefined, null]) {
        const evidence = normalizeResponsesUsage(raw);
        expect(evidence).toMatchObject({ source: "responses", status: "missing", reason: "missing_usage", inputTokens: null,
            outputTokens: null, totalTokens: null, totalSource: null, cachedInputTokens: null, reasoningOutputTokens: null });
        expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    }
    for (const [raw, expected] of [
        [{}, { inputTokens: null, outputTokens: null, totalTokens: null }],
        [{ output_tokens: 9 }, { inputTokens: null, outputTokens: 9, totalTokens: null }],
        [{ input_tokens: 5, total_tokens: 8, input_tokens_details: { cached_tokens: 2 } },
            { inputTokens: 5, outputTokens: null, totalTokens: 8, cachedInputTokens: 2 }],
    ] as const) {
        const evidence = normalizeResponsesUsage(raw);
        expect(evidence).toMatchObject({ source: "responses", status: "missing", reason: "missing_counts", ...expected });
        expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    }
    expect(normalizeResponsesUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })).toMatchObject({
        status: "complete", totalTokens: 0, totalSource: "reported", cachedInputTokens: null, reasoningOutputTokens: null,
    });
    const derived = normalizeResponsesUsage({ input_tokens: 2, output_tokens: 3 });
    expect(derived).toMatchObject({ source: "responses", status: "complete", totalTokens: 5, totalSource: "derived" });
    expect(parseTextUsageEvidence(derived)).toEqual(derived);
});

test("the explicit protocol decides usage fields without relabeling historical Chat evidence", () => {
    const chatShape = { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } };
    expect(normalizeResponsesUsage(chatShape)).toMatchObject({ source: "responses", status: "missing", inputTokens: null, outputTokens: null, cachedInputTokens: null });
    const historical = normalizeChatUsage(chatShape);
    expect(parseTextUsageEvidence(historical)).toEqual(historical);
    const aliases = normalizeChatUsage({ input_tokens: 3, output_tokens: 2 });
    expect(aliases).toMatchObject({ source: "chat_completions", status: "complete", totalTokens: 5 });
    expect(parseTextUsageEvidence(aliases)).toEqual(aliases);
    expect(normalizeChatUsage(null)).toMatchObject({ source: "chat_completions", status: "invalid", reason: "invalid_counts" });
});

test("Responses rejects invalid counts, inconsistent totals and arithmetic overflow", () => {
    const cases: Array<[unknown, string]> = [
        [[], "invalid_counts"], ["private-marker", "invalid_counts"],
        ...[undefined, null, "2", -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
            .map((value): [unknown, string] => [{ input_tokens: value, output_tokens: 1 }, "invalid_counts"]),
        [{ input_tokens: 3, output_tokens: 2, total_tokens: 6 }, "inconsistent_total"],
        [{ input_tokens: 3, total_tokens: 2 }, "inconsistent_total"],
        [{ output_tokens: 3, total_tokens: 2 }, "inconsistent_total"],
        [{ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, "inconsistent_total"],
    ];
    for (const [raw, reason] of cases) {
        const evidence = normalizeResponsesUsage(raw);
        expect(evidence).toMatchObject({ source: "responses", status: "invalid", reason, inputTokens: null, outputTokens: null,
            totalTokens: null, totalSource: null, cachedInputTokens: null, reasoningOutputTokens: null });
        expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    }
});

test("Responses detail counts need valid parent totals and cannot exceed them", () => {
    for (const details of [
        { input_tokens_details: null }, { output_tokens_details: [] },
        { input_tokens_details: { cached_tokens: null } }, { output_tokens_details: { reasoning_tokens: "1" } },
        { input_tokens_details: { cached_tokens: 4 } }, { output_tokens_details: { reasoning_tokens: 3 } },
    ]) {
        const evidence = normalizeResponsesUsage({ input_tokens: 3, output_tokens: 2, ...details });
        expect(evidence).toMatchObject({ source: "responses", status: "invalid", reason: "invalid_details", inputTokens: null });
        expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    }
    expect(normalizeResponsesUsage({ output_tokens: 2, input_tokens_details: { cached_tokens: 0 } })).toMatchObject({ status: "invalid", reason: "invalid_details" });
});

test("Responses evidence DTO enforces the same strict whitelist and state arithmetic", () => {
    const complete = normalizeResponsesUsage({ input_tokens: 3, output_tokens: 2 });
    for (const changed of [
        { private: "private-marker" }, { schemaVersion: 2 }, { source: "provider_estimate" }, { status: "missing" },
        { reason: "missing_counts" }, { totalTokens: 9 }, { totalSource: null }, { inputTokens: null },
        { inputTokens: "3" }, { cachedInputTokens: 4 }, { reasoningOutputTokens: 3 },
    ]) expect(parseTextUsageEvidence({ ...complete, ...changed })).toBeNull();
    const { reason: _reason, ...missingField } = complete;
    expect(parseTextUsageEvidence(missingField)).toBeNull();
    expect(parseTextUsageEvidence({ ...normalizeResponsesUsage(null), outputTokens: 0 })).toBeNull();
    expect(parseTextUsageEvidence({ ...normalizeResponsesUsage([]), totalSource: "reported" })).toBeNull();
    expect(parseTextUsageEvidence({ ...normalizeResponsesUsage({ output_tokens: 2 }), totalSource: "derived" })).toBeNull();
});
