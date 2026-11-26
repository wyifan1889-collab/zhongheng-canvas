import { expect, test } from "bun:test";
import { createCanvasImageGenerationController, createGenerationReceiptStore, type GenerationReceipt, type GenerationReceiptBacking } from "./canvas-image-generation";
import { createGenerationClient, type GenerationScope } from "./generation";

const scope: GenerationScope = { accountId: "rejection-account", epoch: 1, projectId: "rejection-canvas" };
const quote = { modelId: "synthetic-image", priceVersion: 1, quotedUnits: 7, billingUnit: "request", creditsPerUnit: 7 };
const taskId = "11111111-1111-4111-8111-111111111111";
function fixture(reply: () => Promise<Response>, failRejectionWrite = false) {
    const data = new Map<string, unknown>(), calls: Array<{ path: string; key: string | null }> = [];
    let nextKey = 0, version = 1, writes = 0;
    const backing: GenerationReceiptBacking = {
        async keys() { return [...data.keys()]; },
        async getItem(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
        async setItem(key, value) { if (failRejectionWrite && ++writes === 2) throw new Error("synthetic storage failure"); data.set(key, structuredClone(value)); return value; },
    };
    function controller() {
        const client = createGenerationClient({ scope, getScope: () => scope, fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input); calls.push({ path, key: new Headers(init?.headers).get("Idempotency-Key") });
            if (path.endsWith("/quote")) return Response.json({ quote: { ...quote, priceVersion: version } });
            if (init?.method === "POST") return reply();
            return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }, { preconnect: fetch.preconnect }) });
        return createCanvasImageGenerationController({ client, getContext: () => scope, receiptStore: createGenerationReceiptStore(backing), createIdempotencyKey: () => `rejection-${++nextKey}` });
    }
    return { controller, data, calls, store: createGenerationReceiptStore(backing), setVersion(value: number) { version = value; } };
}

for (const [code, status] of [["price_changed", 409], ["insufficient_balance", 402]] as const) {
    test(`${code} survives reopen without lookup; only fresh quote and confirmation submit a new key`, async () => {
        let rejected = true;
        const f = fixture(async () => rejected ? Response.json({ error: { code, message: "untrusted upstream detail" } }, { status }) : Response.json({
            task: { id: taskId, projectId: scope.projectId, modelId: quote.modelId, priceVersion: 2, quotedUnits: 7, executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved" }, result: null,
        }));
        const first = f.controller();
        await first.prepare({ modelId: quote.modelId, prompt: "private description" });
        await first.confirm();
        expect(first.getState()).toMatchObject({ phase: "rejected", receipt: { rejection: code }, error: { code, outcome: "rejected" } });
        const [stored] = await first.listReceipts();
        expect(stored).toEqual({ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "rejection-1", priceVersion: 1, rejection: code });
        expect(JSON.stringify([...f.data.values()])).not.toContain("private description");
        first.close();
        const reopened = f.controller();
        // A stale list item must use the latest durable record, not lose the rejection.
        const { rejection: _ignored, ...stale } = stored as GenerationReceipt & { rejection: string };
        await reopened.restoreReceipt(stale);
        await reopened.refresh();
        await reopened.confirm();
        expect(reopened.getState()).toMatchObject({ phase: "rejected", receipt: { rejection: code }, error: { code } });
        expect(f.calls.map((call) => call.path)).toEqual(["/api/v1/generation/quote", "/api/v1/generation/tasks"]);
        expect(reopened.startNew()).toBe(true);
        await reopened.confirm();
        expect(f.calls).toHaveLength(2);
        rejected = false; f.setVersion(2);
        await reopened.prepare({ modelId: quote.modelId, prompt: "new private description" });
        await reopened.confirm();
        await reopened.confirm();
        expect(reopened.getState()).toMatchObject({ phase: "tracking", receipt: { taskId, priceVersion: 2 } });
        expect(f.calls.filter((call) => call.key).map((call) => call.key)).toEqual(["rejection-1", "rejection-2"]);
        expect(await reopened.listReceipts()).toHaveLength(2);
    });
}

test("unknown, mismatched status, conflict, and recovery 404 never become a durable rejection or allow restart", async () => {
    for (const response of [
        () => Response.json({ error: { code: "price_changed" } }, { status: 503 }),
        () => Response.json({ error: { code: "idempotency_conflict" } }, { status: 409 }),
        () => Response.json({ error: { code: "generation_unavailable" } }, { status: 503 }),
        () => new Response("not-json", { status: 402 }),
        () => Response.json({}, { status: 201 }),
    ]) {
        const f = fixture(async () => response()), first = f.controller();
        await first.prepare({ modelId: quote.modelId, prompt: "synthetic" }); await first.confirm();
        const [saved] = await first.listReceipts();
        expect(saved).not.toHaveProperty("rejection");
        first.close();
        const reopened = f.controller();
        await reopened.restoreReceipt(saved);
        expect(reopened.getState()).toMatchObject({ phase: "uncertain", error: { code: "not_found" } });
        expect(reopened.startNew()).toBe(false);
        await reopened.confirm();
        expect(f.calls.filter((call) => call.key)).toHaveLength(1);
    }
});

test("failed persistence of a definite rejection keeps the recovery receipt locked", async () => {
    const f = fixture(async () => Response.json({ error: { code: "insufficient_balance" } }, { status: 402 }), true);
    const first = f.controller();
    await first.prepare({ modelId: quote.modelId, prompt: "synthetic" }); await first.confirm();
    expect(first.getState()).toMatchObject({ phase: "uncertain", error: { code: "receipt_storage", outcome: "unknown" } });
    expect(first.startNew()).toBe(false);
    const [saved] = await first.listReceipts();
    expect(saved).not.toHaveProperty("rejection");
    first.close();
    const reopened = f.controller(); await reopened.restoreReceipt(saved);
    expect(reopened.getState().phase).toBe("uncertain");
    expect(f.calls.filter((call) => call.key)).toHaveLength(1);
});

test("receipt schema rejects contradictory or unrecognized rejection metadata and cannot erase it", async () => {
    const f = fixture(async () => Response.json({}));
    const base = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "schema-key", priceVersion: 1 };
    await expect(f.store.put({ ...base, rejection: "not_found" } as unknown as GenerationReceipt)).rejects.toMatchObject({ code: "receipt_storage" });
    for (const rejection of [["price_changed"], { reason: "insufficient_balance" }]) {
        const key = `${JSON.stringify([scope.accountId, scope.projectId])}:v1:${base.idempotencyKey}`;
        f.data.set(key, { ...base, rejection });
        await expect(f.store.list(scope.accountId, scope.projectId)).rejects.toMatchObject({ code: "receipt_storage" });
        f.data.delete(key);
    }
    await expect(f.store.put({ ...base, taskId, rejection: "price_changed" } as GenerationReceipt)).rejects.toMatchObject({ code: "receipt_storage" });
    await f.store.put({ ...base, rejection: "price_changed" } as GenerationReceipt);
    await expect(f.store.put(base)).rejects.toMatchObject({ code: "receipt_storage" });
    await expect(f.store.put({ ...base, taskId })).rejects.toMatchObject({ code: "receipt_storage" });
    await expect(f.store.put({ ...base, rejection: "insufficient_balance" } as GenerationReceipt)).rejects.toMatchObject({ code: "receipt_storage" });
    expect(await f.store.list(scope.accountId, scope.projectId)).toEqual([{ ...base, rejection: "price_changed" }]);
});

test("closing or changing account during the rejection write cannot revive the old controller", async () => {
    for (const action of ["close", "switch"] as const) {
        let context: GenerationScope = scope;
        const data = new Map<string, unknown>();
        const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        let posts = 0;
        const store = createGenerationReceiptStore({
            async keys() { return [...data.keys()]; },
            async getItem(key) { return data.get(key) ?? null; },
            async setItem(key, value) {
                if (value.rejection) { started.resolve(); await release.promise; }
                data.set(key, structuredClone(value)); return value;
            },
        });
        const client = createGenerationClient({ scope, getScope: () => context, fetcher: Object.assign(async (input: RequestInfo | URL) => {
            if (String(input).endsWith("/quote")) return Response.json({ quote });
            posts++; return Response.json({ error: { code: "price_changed" } }, { status: 409 });
        }, { preconnect: fetch.preconnect }) });
        const controller = createCanvasImageGenerationController({ client, getContext: () => context, receiptStore: store, createIdempotencyKey: () => `delayed-${action}` });
        await controller.prepare({ modelId: quote.modelId, prompt: "synthetic" });
        const submitting = controller.confirm(); await started.promise;
        if (action === "close") controller.close();
        else context = { ...scope, accountId: "other-account", epoch: 2 };
        release.resolve(); await submitting;
        expect(controller.getState().phase).toBe("closed");
        expect(controller.startNew()).toBe(false);
        expect(await store.list(scope.accountId, scope.projectId)).toEqual([{ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: `delayed-${action}`, priceVersion: 1, rejection: "price_changed" }]);
        expect(await store.list("other-account", scope.projectId)).toEqual([]);
        expect(posts).toBe(1);
    }
});
