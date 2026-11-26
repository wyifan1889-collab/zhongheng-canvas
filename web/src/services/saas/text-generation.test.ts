import { expect, test } from "bun:test";
import { normalizeResponsesUsage } from "../../../../packages/shared/src/text-usage";
import { createTextGenerationClient, type TextGenerationIntent, type TextGenerationQuote } from "./text-generation";
import { createCanvasTextGenerationController } from "./canvas-text-generation";
import { createGenerationReceiptStore } from "./canvas-image-generation";
import type { GenerationScope } from "./generation";
import type { TextBillingExplanation } from "../../../../packages/shared/src/text-billing";
const id = "11111111-1111-4111-8111-111111111111", scope: GenerationScope = { accountId: "text-fixture", epoch: 2, projectId: "text-canvas" };
const intent: TextGenerationIntent = { modelId: "text-model", input: { prompt: "synthetic prompt" }, parameters: {}, projectId: scope.projectId, budgetCredits: "0.01" };
const quote: TextGenerationQuote = { modelId: intent.modelId, priceVersion: 2, billingUnit: "text_tokens", budgetCredits: "0.01", inputCreditsPerMillion: "2", outputCreditsPerMillion: "8", usageSource: "responses", priceNote: "Fixture price" };
const view = () => ({ task: { id, projectId: scope.projectId, modelId: intent.modelId, priceVersion: 2, quotedUnits: null, billingUnitSnapshot: null, creditsPerUnitSnapshot: null,
    textQuoteSnapshot: { schemaVersion: 1, budgetCredits: "0.01", inputCreditsPerMillion: "2", outputCreditsPerMillion: "8", usageSource: "responses" },
    executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", billing: { reservedCredits: "0.01", capturedCredits: "0.0001", releasedCredits: "0.0099" }, ownerId: "private-owner" },
    result: { taskId: id, status: "succeeded", resultSnapshot: { kind: "text", text: "完成的文本", usageEvidence: normalizeResponsesUsage({ input_tokens: 10, output_tokens: 10, total_tokens: 20 }), providerKey: "private-key" } } });
const fetcher = (run: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign((input: RequestInfo | URL, init?: RequestInit) => run(String(input), init), { preconnect: fetch.preconnect });
const backing = () => { const map = new Map<string, unknown>(); return { keys: async () => [...map.keys()], getItem: async (key: string) => map.get(key) ?? null, setItem: async (key: string, value: unknown) => { map.set(key, structuredClone(value)); } }; };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(run?: (path: string, init?: RequestInit) => Promise<Response>, getScope = () => scope) {
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createTextGenerationClient({ scope, getScope, fetcher: fetcher(async (path, init) => { calls.push({ path, init }); return run ? run(path, init) : Response.json(path.endsWith("/quote") ? { quote } : path.endsWith("/models") ? { items: [{ id: intent.modelId, displayName: "Fixture", capability: "text", group: { id, name: "GPT", order: 0, privateKey: "private" } }] } : view()); }) });
    return { client, calls };
}
test("text client uses explicit budget, public rates and same-owner routes; all returned values are safe projections", async () => {
    const { client, calls } = fixture();
    expect(await client.models()).toEqual([{ id: intent.modelId, displayName: "Fixture", capability: "text", group: { id, name: "GPT", order: 0 } }]);
    expect(await client.quote({ ...intent, budgetCredits: "0.0100" })).toEqual(quote);
    const result = await client.submit(intent, 2, "text-receipt");
    expect(result.task.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0.0001", releasedCredits: "0.0099" });
    expect(result.result?.resultSnapshot.text).toBe("完成的文本"); expect(JSON.stringify(result)).not.toContain("private");
    await client.get(id); await client.getByKey("text-receipt");
    expect(calls.map(call => call.path)).toEqual(["/api/v1/generation/text/models", "/api/v1/generation/text/quote", "/api/v1/generation/text/tasks", `/api/v1/generation/tasks/${id}`, "/api/v1/generation/tasks/by-key/text-receipt"]);
    expect(JSON.parse(calls[1].init!.body as string).budgetCredits).toBe("0.01");
    expect(calls.map(call => call.init?.method)).toEqual(["GET", "POST", "POST", "GET", "GET"]);
    for (const call of calls) expect(new Headers(call.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
});
test("no guessed budget or unsafe output parameters can trigger a quote", async () => {
    const { client, calls } = fixture();
    for (const budgetCredits of ["", "0", "-1", "NaN", "1e3"]) await expect(client.quote({ ...intent, budgetCredits })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(client.quote({ ...intent, parameters: { max_tokens: 20 } } as unknown as TextGenerationIntent)).rejects.toMatchObject({ code: "invalid_input" }); expect(calls).toHaveLength(0);
});

test("quote explanations project safe same-version fields without leaking into historical task snapshots", async () => {
    const metadata = { priceVersion: 2, saleMultiplier: "0.36", creditsPerCurrency: "100", currency: "USD", unit: "million_tokens", sourceId: "openai",
        sourceVersion: 4, checkedAt: "2026-10-29T00:00:00.000Z", entryId: "openai:synthetic", officialPrices: { input: "2", cachedInput: "0.2", output: "10" } } as const;
    const triple = { ...quote, inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "360" };
    const client = fixture(async path => Response.json(path.endsWith("/quote") ? { quote: { ...triple, textPriceDerivation: { ...metadata, costMultiplier: "private", endpoint: "private" } } } : view())).client;
    expect(await client.quote(intent)).toEqual({ ...triple, textPriceDerivation: metadata });
    expect((await client.get(id)).task.textQuoteSnapshot).not.toHaveProperty("textPriceDerivation");
    await expect(fixture(async () => Response.json({ quote: { ...triple, textPriceDerivation: { ...metadata, priceVersion: 3 } } })).client.quote(intent)).rejects.toMatchObject({ code: "unconfirmed" });
});
test("invalid price, result usage or billing totals do not become a trusted task", async () => {
    for (const change of [
        (v: ReturnType<typeof view>) => { v.task.billing.capturedCredits = "0.02"; },
        (v: ReturnType<typeof view>) => { v.task.billing.reservedCredits = "0.02"; },
        (v: ReturnType<typeof view>) => { v.task.textQuoteSnapshot.usageSource = "unknown"; },
        (v: ReturnType<typeof view>) => { v.result.resultSnapshot.usageEvidence.totalTokens = 900; },
    ]) {
        const data = view(); change(data); const { client } = fixture(async () => Response.json(data));
        await expect(client.get(id)).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
    }
    const data = view(); (data.task as unknown as { billing: null }).billing = null;
    expect((await fixture(async () => Response.json(data)).client.get(id)).task.billing).toBeNull();
});
for (const field of ["account", "epoch", "project"] as const) test(`late ${field} switch cannot populate the original dialog`, async () => {
    let current = scope; const response = deferred<Response>(); const { client, calls } = fixture(async () => response.promise, () => current);
    const pending = client.submit(intent, 2, "late-text"); current = { ...scope, ...(field === "account" ? { accountId: "other" } : field === "epoch" ? { epoch: 3 } : { projectId: "other" }) }; response.resolve(Response.json(view()));
    await expect(pending).rejects.toMatchObject({ code: "context_changed", outcome: "unknown" }); current = scope;
    await expect(client.get(id)).rejects.toMatchObject({ code: "context_changed" }); expect(calls).toHaveLength(1);
});
test("confirmation is explicit and single-shot; a lost response recovers by GET without another reservation", async () => {
    let posted = false; const { client, calls } = fixture(async (path) => { if (path.endsWith("/quote")) return Response.json({ quote }); if (path.endsWith("/text/tasks")) { posted = true; throw new Error("lost reply"); } return Response.json(view()); });
    const receiptStore = createGenerationReceiptStore(backing()), controller = createCanvasTextGenerationController({ client, getContext: () => scope, receiptStore, createIdempotencyKey: () => "one-text" });
    await controller.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, budgetCredits: intent.budgetCredits }); expect(posted).toBe(false);
    await controller.confirm(); await controller.confirm(); expect(controller.getState().phase).toBe("uncertain"); expect(calls.filter(call => call.path.endsWith("/text/tasks"))).toHaveLength(1);
    const receipt = controller.getState().receipt!; controller.close();
    const next = createCanvasTextGenerationController({ client, getContext: () => scope, receiptStore }); await next.restoreReceipt(receipt);
    expect(next.getState().view?.task.id).toBe(id); expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(2);
    expect(calls.at(-1)?.path).toBe("/api/v1/generation/tasks/by-key/one-text");
    expect(JSON.stringify(await next.listReceipts())).not.toContain("synthetic prompt");
});
test("quote confirmation detects task rate mismatch and does not repeat submit", async () => {
    const { client, calls } = fixture(async path => { if (path.endsWith("/quote")) return Response.json({ quote }); const data = view(); data.task.textQuoteSnapshot.outputCreditsPerMillion = "9"; return Response.json(data); });
    const c = createCanvasTextGenerationController({ client, getContext: () => scope, receiptStore: createGenerationReceiptStore(backing()) });
    await c.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, budgetCredits: intent.budgetCredits }); await c.confirm(); await c.confirm();
    expect(c.getState().phase).toBe("uncertain"); expect(calls.filter(call => call.path.endsWith("/text/tasks"))).toHaveLength(1);
});
test("price rejection saves its read-only receipt and requires new quote and confirmation", async () => {
    const { client, calls } = fixture(async path => path.endsWith("/quote") ? Response.json({ quote }) : Response.json({ error: { code: "price_changed" } }, { status: 409 }));
    const c = createCanvasTextGenerationController({ client, getContext: () => scope, receiptStore: createGenerationReceiptStore(backing()) });
    await c.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, budgetCredits: intent.budgetCredits }); await c.confirm();
    expect(c.getState().phase).toBe("rejected"); expect(c.getState().receipt?.rejection).toBe("price_changed"); expect(c.startNew()).toBe(true); await c.confirm(); expect(calls).toHaveLength(2);
});

test("text quote and task preserve cached-input rate and explicit zero write evidence", async () => {
    const cachedQuote = { ...quote, cachedInputCreditsPerMillion: "0.5" };
    const data = view();
    Object.assign(data.task.textQuoteSnapshot, { cachedInputCreditsPerMillion: "0.5" });
    Object.assign(data.result.resultSnapshot.usageEvidence, { cachedInputTokens: 4, cacheWriteTokens: 0 });
    const { client } = fixture(async path => Response.json(path.endsWith("/quote") ? { quote: cachedQuote } : data));
    expect(await client.quote(intent)).toEqual(cachedQuote);
    const task = await client.get(id);
    expect(task.task.textQuoteSnapshot.cachedInputCreditsPerMillion).toBe("0.5");
    expect(task.result?.resultSnapshot.usageEvidence).toMatchObject({ cachedInputTokens: 4, cacheWriteTokens: 0 });
    for (const cachedInputCreditsPerMillion of [0, "0", "0.50", "-1", null]) {
        const invalid = fixture(async () => Response.json({ quote: { ...cachedQuote, cachedInputCreditsPerMillion } }));
        await expect(invalid.client.quote(intent)).rejects.toMatchObject({ code: "unconfirmed" });
    }
});

test("confirmation refuses lost, added, or changed cached-input pricing without a second submit", async () => {
    for (const [quoted, accepted] of [["0.5", undefined], [undefined, "0.5"], ["0.5", "0.6"]]) {
        const cachedQuote = { ...quote, ...(quoted === undefined ? {} : { cachedInputCreditsPerMillion: quoted }) };
        const data = view();
        if (accepted !== undefined) Object.assign(data.task.textQuoteSnapshot, { cachedInputCreditsPerMillion: accepted });
        const { client, calls } = fixture(async path => Response.json(path.endsWith("/quote") ? { quote: cachedQuote } : data));
        const controller = createCanvasTextGenerationController({ client, getContext: () => scope, receiptStore: createGenerationReceiptStore(backing()) });
        await controller.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, budgetCredits: intent.budgetCredits });
        await controller.confirm(); await controller.confirm();
        expect(controller.getState().phase).toBe("uncertain");
        expect(calls.filter(call => call.path.endsWith("/text/tasks"))).toHaveLength(1);
    }
});

const longExplanation = (): TextBillingExplanation => ({ schemaVersion: 1, taskId: id, modelId: intent.modelId, priceVersion: 2,
    policy: "context_tiers", tier: "long", totalTokens: 272001, thresholdTokens: 272000,
    rates: { inputCreditsPerMillion: "144", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "540" },
    quantities: { inputTokens: 272000, cachedInputTokens: 100000, outputTokens: 1 }, expectedCredits: "25.48854" });
function contextView(explanation: unknown = longExplanation()) {
    const data = view();
    Object.assign(data.task, { textBillingExplanation: explanation, billing: { reservedCredits: "50", capturedCredits: "25.48854", releasedCredits: "24.51146" } });
    Object.assign(data.task.textQuoteSnapshot, { budgetCredits: "50", inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360" });
    data.result.resultSnapshot.usageEvidence = normalizeResponsesUsage({ input_tokens: 272000, output_tokens: 1, total_tokens: 272001,
        input_tokens_details: { cached_tokens: 100000, cache_write_tokens: 0 } });
    return data;
}
test("task explanation separates actual original long rates from the confirmed short quote and actual wallet capture", async () => {
    const explanation = longExplanation(), data = contextView({ ...explanation, binding: { endpoint: "private-endpoint" }, costMultiplier: "private-cost",
        rates: { ...explanation.rates, credential: "private-key" }, quantities: { ...explanation.quantities, providerId: "private-provider" } });
    const { client, calls } = fixture(async () => Response.json(data));
    for (const task of [(await client.get(id)).task, (await client.getByKey("long-receipt")).task]) {
        expect(task.textBillingExplanation).toEqual(explanation);
        expect(task.textQuoteSnapshot.inputCreditsPerMillion).toBe("72");
        expect(task.textBillingExplanation?.rates?.inputCreditsPerMillion).toBe("144");
        expect(task.billing?.capturedCredits).toBe("25.48854"); expect(task.billing?.releasedCredits).toBe("24.51146");
        expect(JSON.stringify(task)).not.toContain("private");
    }
    expect(calls.every(call => call.init?.method === "GET")).toBe(true);
});
test("malformed, mismatched or unproven explanation becomes unknown without guessing a short-tier settlement", async () => {
    const explanation = longExplanation();
    for (const patch of [{ taskId: "other-task" }, { modelId: "other-model" }, { priceVersion: 3 }, { tier: "short" }, { expectedCredits: "1" },
        { totalTokens: 272000 }, { thresholdTokens: 272001 }, { rates: { ...explanation.rates, cachedInputCreditsPerMillion: "7.20" } },
        { quantities: { ...explanation.quantities, cachedInputTokens: 99999 } }]) {
        const data = contextView({ ...explanation, ...patch });
        const task = (await fixture(async () => Response.json(data)).client.get(id)).task;
        expect(task.textBillingExplanation).toBeNull(); expect(task.textQuoteSnapshot.inputCreditsPerMillion).toBe("72");
    }
    for (const cacheWriteTokens of [undefined, 1]) {
        const data = contextView();
        if (cacheWriteTokens === undefined) delete data.result.resultSnapshot.usageEvidence.cacheWriteTokens;
        else data.result.resultSnapshot.usageEvidence.cacheWriteTokens = cacheWriteTokens;
        expect((await fixture(async () => Response.json(data)).client.get(id)).task.textBillingExplanation).toBeNull();
    }
    const data = contextView();
    (data as unknown as { result: null }).result = null;
    expect((await fixture(async () => Response.json(data)).client.get(id)).task.textBillingExplanation).toBeNull();
});
test("invalid and incomplete policies stay explicit, while absent legacy explanation remains compatible", async () => {
    for (const policy of ["invalid", "context_tiers"] as const) {
        const explanation: TextBillingExplanation = { ...longExplanation(), policy, tier: null, rates: null, quantities: null,
            expectedCredits: null, totalTokens: null, thresholdTokens: policy === "context_tiers" ? 272000 : null };
        expect((await fixture(async () => Response.json(contextView(explanation))).client.get(id)).task.textBillingExplanation).toEqual(explanation);
    }
    expect((await fixture().client.get(id)).task).not.toHaveProperty("textBillingExplanation");
});
test("lost submission restores original long-tier explanation by owner key and keeps mandatory quote note unchanged", async () => {
    const quoted = { ...quote, budgetCredits: "50", inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360",
        priceNote: "超过272K按长档计价；本平台按输入与输出总量判档。\n长档费用超预算时待核对，不追加扣款。" };
    const { client, calls } = fixture(async path => {
        if (path.endsWith("/quote")) return Response.json({ quote: quoted });
        if (path.endsWith("/text/tasks")) throw new Error("lost reply");
        return Response.json(contextView());
    });
    const store = createGenerationReceiptStore(backing());
    const controller = createCanvasTextGenerationController({ client, getContext: () => scope, receiptStore: store, createIdempotencyKey: () => "lost-long" });
    await controller.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, budgetCredits: "50" });
    expect(controller.getState().quote?.priceNote).toBe(quoted.priceNote);
    expect(calls.filter(call => call.path.endsWith("/text/tasks"))).toHaveLength(0);
    await controller.confirm();
    const receipt = controller.getState().receipt!; controller.close();
    const restored = createCanvasTextGenerationController({ client, getContext: () => scope, receiptStore: store });
    await restored.restoreReceipt(receipt);
    expect(restored.getState().view?.task.textBillingExplanation).toEqual(longExplanation());
    expect(restored.getState().view?.task.textQuoteSnapshot.inputCreditsPerMillion).toBe("72");
    expect(calls.filter(call => call.path.endsWith("/text/tasks"))).toHaveLength(1);
    expect(calls.at(-1)?.path).toBe("/api/v1/generation/tasks/by-key/lost-long");
});
