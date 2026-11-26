import { expect, test } from "bun:test";
import { normalizeChatUsage, normalizeResponsesUsage } from "./text-usage";
import { evaluateTextUsageDraft } from "./text-usage-review";
import type { AdminModelPriceDraft } from "./model-pricing-drafts";

const draft = (): AdminModelPriceDraft => ({
    id: "aa857be8-b6eb-4573-989d-b8dfc989a1ee", modelId: "fixture-text", version: 3,
    createdAt: "2026-10-23T00:00:00.000Z", bindingMatchesCurrent: true, priceNote: "Synthetic draft",
    binding: { providerId: "fixture", providerModel: "text-fixture", adapter: "openai-compatible", endpoint: "https://provider.example/v1", capability: "text" },
    rules: { schemaVersion: 1,
        cost: { template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "0.1234567", output_token: "0.7654321" } }] },
        sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "1.23", output_token: "4.56" } }] },
    },
});

test("actual reported counts produce an exact two-line draft simulation with separate currencies", () => {
    const usage = normalizeChatUsage({ prompt_tokens: 3, completion_tokens: 7, total_tokens: 10,
        prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 } });
    const original = draft(), before = structuredClone(original);
    const result = evaluateTextUsageDraft(original.modelId, usage, original);
    expect(result).toMatchObject({ status: "calculated", mode: "draft_simulation", draftId: original.id, draftVersion: 3,
        cost: { status: "calculated", currency: "USD", total: "0.0000057283948" },
        sale: { status: "calculated", currency: "credit", total: "0.00003561" } });
    if (result.status !== "calculated" || result.sale.status !== "calculated") throw new Error("fixture calculation failed");
    expect(result.sale.lines).toEqual([
        { meter: "input_token", quantity: "3", rate: "1.23", base: 1_000_000, total: "0.00000369" },
        { meter: "output_token", quantity: "7", rate: "4.56", base: 1_000_000, total: "0.00003192" },
    ]);
    expect(original).toEqual(before);
    expect(Object.keys(result).sort()).toEqual(["status", "mode", "draftId", "draftVersion", "cost", "sale"].sort());
});

test("unknown cost stays unknown, zero counts stay zero, and no wallet rounding is applied", () => {
    const zero = normalizeChatUsage({ prompt_tokens: 0, completion_tokens: 0 });
    const selected = draft(); selected.rules.cost = null;
    expect(evaluateTextUsageDraft(selected.modelId, zero, selected)).toMatchObject({ status: "calculated", cost: null, sale: { total: "0" } });
    selected.rules.cost = { template: "text_tokens", currency: "CNY", bands: [{ parameters: {}, rates: { input_token: null, output_token: "0" } }] };
    expect(evaluateTextUsageDraft(selected.modelId, zero, selected)).toMatchObject({ status: "calculated", cost: { currency: "CNY", total: null } });
});

test("Responses evidence uses the existing read-only total-input/output simulation without separate cache or reasoning charges", () => {
    const selected = draft();
    const usage = { input_tokens: 3, output_tokens: 7, total_tokens: 10,
        input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 7 } };
    const evidence = normalizeResponsesUsage(usage), before = structuredClone({ selected, evidence });
    expect(evaluateTextUsageDraft(selected.modelId, evidence, selected)).toEqual(
        evaluateTextUsageDraft(selected.modelId, normalizeChatUsage(usage), selected),
    );
    expect(evaluateTextUsageDraft(selected.modelId, evidence, selected)).toMatchObject({ mode: "draft_simulation", sale: { total: "0.00003561" } });
    expect({ selected, evidence }).toEqual(before);
    expect(evaluateTextUsageDraft(selected.modelId, normalizeResponsesUsage(null), selected)).toEqual({ status: "blocked", reason: "missing_usage" });
    expect(evaluateTextUsageDraft(selected.modelId, normalizeResponsesUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 4 }), selected))
        .toEqual({ status: "blocked", reason: "invalid_usage" });
});

test("missing and inconsistent usage are blocked instead of being filled or inferred", () => {
    const selected = draft();
    for (const usage of [null, normalizeChatUsage(undefined), normalizeChatUsage({ completion_tokens: 9 })]) {
        expect(evaluateTextUsageDraft(selected.modelId, usage, selected)).toEqual({ status: "blocked", reason: "missing_usage" });
    }
    for (const usage of [normalizeChatUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 1 }),
        { ...normalizeChatUsage({ prompt_tokens: 1, completion_tokens: 1 }), totalTokens: 999 }]) {
        expect(evaluateTextUsageDraft(selected.modelId, usage, selected)).toEqual({ status: "blocked", reason: "invalid_usage" });
    }
});

test("selected model, current binding and saved rule version must be valid without implying a historical task price", () => {
    const selected = draft(), usage = normalizeChatUsage({ prompt_tokens: 1, completion_tokens: 1 });
    expect(evaluateTextUsageDraft("other", usage, selected)).toEqual({ status: "blocked", reason: "model_mismatch" });
    expect(evaluateTextUsageDraft(selected.modelId, usage, { ...selected, bindingMatchesCurrent: false })).toEqual({ status: "blocked", reason: "binding_changed" });
    for (const invalid of [{ ...selected, version: 0 }, { ...selected, binding: { ...selected.binding, capability: "image" as const } },
        { ...selected, rules: { ...selected.rules, sale: { ...selected.rules.sale, currency: "USD" as const } } }]) {
        expect(evaluateTextUsageDraft(selected.modelId, usage, invalid)).toEqual({ status: "blocked", reason: "invalid_draft" });
    }
    const changed = structuredClone(selected); changed.version = 4; changed.rules.sale.bands[0].rates.input_token = "100";
    expect(evaluateTextUsageDraft(selected.modelId, usage, changed)).toMatchObject({ mode: "draft_simulation", draftVersion: 4, sale: { total: "0.00010456" } });
    expect(evaluateTextUsageDraft(selected.modelId, usage, selected)).toMatchObject({ mode: "draft_simulation", draftVersion: 3, sale: { total: "0.00000579" } });
});
