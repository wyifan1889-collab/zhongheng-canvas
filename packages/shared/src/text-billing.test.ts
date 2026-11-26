import { expect, test } from "bun:test";
import { evaluateTextCharge, parseTextQuoteSnapshot, type TextQuoteSnapshot } from "./text-billing";
import { normalizeChatUsage, normalizeResponsesUsage } from "./text-usage";

const quote: TextQuoteSnapshot = { schemaVersion: 1, budgetCredits: "0.01", inputCreditsPerMillion: "2",
    outputCreditsPerMillion: "4", usageSource: "responses" };

test("text charges use exact immutable parent totals without repeating cache or reasoning", () => {
    expect(parseTextQuoteSnapshot(quote)).toEqual(quote);
    expect(evaluateTextCharge(quote, normalizeResponsesUsage({ input_tokens: 200, output_tokens: 700,
        input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 500 } }))).toBe("0.0032");
    expect(evaluateTextCharge({ ...quote, inputCreditsPerMillion: "0.0000000000000000001" },
        normalizeResponsesUsage({ input_tokens: 1, output_tokens: 0 }))).toBe("0.0000000000000000000000001");
    expect(evaluateTextCharge(quote, normalizeResponsesUsage({ input_tokens: 0, output_tokens: 0 }))).toBe("0");
});

test("budgets are explicit positive canonical strings, never guessed from token counts", () => {
    for (const changed of [{ budgetCredits: 1 }, { budgetCredits: "0" }, { budgetCredits: "-1" }, { budgetCredits: "1.0" },
        { inputCreditsPerMillion: "0" }, { outputCreditsPerMillion: null }, { usageSource: "estimate" }, { private: "x" }]) {
        expect(parseTextQuoteSnapshot({ ...quote, ...changed })).toBeNull();
    }
    // Calculation may exceed a budget; settlement, not this pure function, decides pending review.
    expect(evaluateTextCharge(quote, normalizeResponsesUsage({ input_tokens: 1_000_000, output_tokens: 0 }))).toBe("2");
});

test("missing, invalid or wrong-protocol usage cannot become free or inferred usage", () => {
    for (const evidence of [undefined, null, normalizeResponsesUsage(null), normalizeResponsesUsage({ input_tokens: 1 }),
        normalizeResponsesUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 3 }),
        normalizeChatUsage({ prompt_tokens: 1, completion_tokens: 1 })]) {
        expect(evaluateTextCharge(quote, evidence)).toBeNull();
    }
});
