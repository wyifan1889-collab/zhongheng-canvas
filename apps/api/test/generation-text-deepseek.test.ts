import { expect, test } from "bun:test";
import { evaluateTextCharge, parseTextUsageEvidence, type TextQuoteSnapshot } from "@infinite-canvas/shared";
import { normalizeGenerationTextResponse } from "../src/generation-text";

const completion = () => ({ id: "synthetic-deepseek", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "合成文本" } }],
    usage: { prompt_tokens: 200, completion_tokens: 700, total_tokens: 900, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 } });
const quote: TextQuoteSnapshot = { schemaVersion: 1, budgetCredits: "1", inputCreditsPerMillion: "2",
    outputCreditsPerMillion: "4", cachedInputCreditsPerMillion: "0.2", usageSource: "chat_completions" };

test("DeepSeek delivered text retains cache evidence while unreported writes still block three-bucket settlement", () => {
    const result = normalizeGenerationTextResponse(completion(), "chat_completions");
    expect(result).toMatchObject({ status: "succeeded", providerTaskId: "synthetic-deepseek", resultSnapshot: { text: "合成文本",
        usageEvidence: { status: "complete", inputTokens: 200, outputTokens: 700, totalTokens: 900, cachedInputTokens: 150 } } });
    const evidence = result.resultSnapshot?.usageEvidence;
    expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
    expect(evaluateTextCharge(quote, evidence)).toBeNull();
});

test("contradictory DeepSeek usage does not turn delivered text into failed or zero-cost generation", () => {
    const payload = completion();
    payload.usage.prompt_cache_miss_tokens = 49;
    const result = normalizeGenerationTextResponse(payload, "chat_completions");
    expect(result).toMatchObject({ status: "succeeded", resultSnapshot: { text: "合成文本",
        usageEvidence: { status: "invalid", reason: "invalid_details" } } });
    expect(result.resultSnapshot).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("consumedUnits");
    expect(evaluateTextCharge(quote, result.resultSnapshot?.usageEvidence)).toBeNull();
});

test("incomplete DeepSeek text keeps normalized cache evidence without declaring success", () => {
    const payload = completion();
    payload.choices[0].finish_reason = "length";
    expect(normalizeGenerationTextResponse(payload, "chat_completions")).toMatchObject({ status: "unknown",
        resultSnapshot: { usageEvidence: { status: "complete", cachedInputTokens: 150 } } });
});
