import { expect, test } from "bun:test";
import { createCanvasTextGenerationController } from "./canvas-text-generation";
import { createTextGenerationReceiptStore, type TextGenerationReceipt, type TextGenerationReceiptBacking, type TextTargetBinding, type TextConfigBinding } from "./canvas-text-receipt";
import { createTextGenerationClient, type TextGenerationQuote } from "./text-generation";
import type { GenerationScope } from "./generation";

const scope: GenerationScope = { accountId: "target-account", epoch: 2, projectId: "target-project" };
const taskId = "11111111-1111-4111-8111-111111111111";
const targetA: TextTargetBinding = { schemaVersion: 1, nodeId: "node-A", guardId: "22222222-2222-4222-8222-222222222222" };
const targetB: TextTargetBinding = { schemaVersion: 1, nodeId: "node-B", guardId: "33333333-3333-4333-8333-333333333333" };
const quote: TextGenerationQuote = { modelId: "target-text-model", priceVersion: 3, billingUnit: "text_tokens", budgetCredits: "0.01", inputCreditsPerMillion: "2", outputCreditsPerMillion: "4", usageSource: "responses" };
const input = { modelId: quote.modelId, prompt: "private creation instructions", budgetCredits: quote.budgetCredits };
const view = { task: { id: taskId, projectId: scope.projectId, modelId: quote.modelId, priceVersion: quote.priceVersion, quotedUnits: null,
    billingUnitSnapshot: null, creditsPerUnitSnapshot: null, textQuoteSnapshot: { schemaVersion: 1, budgetCredits: quote.budgetCredits,
        inputCreditsPerMillion: quote.inputCreditsPerMillion, outputCreditsPerMillion: quote.outputCreditsPerMillion, usageSource: quote.usageSource },
    executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", billing: { reservedCredits: "0.01", capturedCredits: "0.001", releasedCredits: "0.009" } },
    result: { taskId, status: "succeeded", resultSnapshot: { kind: "text", text: "synthetic completed text" } } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(run?: (path: string, init?: RequestInit) => Promise<Response>, write?: (key: string, value: TextGenerationReceipt, commit: () => Promise<unknown>) => Promise<unknown>, quoteRun?: () => Promise<Response>) {
    let current = { ...scope }, sequence = 0;
    const data = new Map<string, unknown>(), calls: { path: string; init?: RequestInit }[] = [];
    const backing: TextGenerationReceiptBacking = { keys: async () => [...data.keys()], getItem: async key => structuredClone(data.get(key) ?? null),
        async setItem(key, value) { const commit = async () => { data.set(key, structuredClone(value)); return value; }; return write ? write(key, value, commit) : commit(); } };
    const receiptStore = createTextGenerationReceiptStore(backing);
    function controller(options: { target?: TextTargetBinding; beforeTargetReceipt?: (target: TextTargetBinding) => Promise<void>;
        configTarget?: TextConfigBinding; beforeConfigReceipt?: (target: TextConfigBinding) => Promise<void>; getIntentCurrent?: () => boolean } = {}) {
        const client = createTextGenerationClient({ scope: { ...current }, getScope: () => current,
            fetcher: Object.assign(async (value: RequestInfo | URL, init?: RequestInit) => {
                const path = String(value); calls.push({ path, init });
                return path.endsWith("/quote") ? quoteRun ? quoteRun() : Response.json({ quote }) : run ? run(path, init) : Response.json(view);
            }, { preconnect: fetch.preconnect }) });
        return createCanvasTextGenerationController({ client, getContext: () => current, receiptStore, createIdempotencyKey: () => `target-receipt-${++sequence}`, ...options });
    }
    return { data, calls, receiptStore, controller, change(next: GenerationScope) { current = next; } };
}
const submissions = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.path.endsWith("/text/tasks") && call.init?.method === "POST");

test("original target is frozen and its durability barrier and initial receipt both finish before a single submit", async () => {
    const barrier = deferred(), barrierEntered = deferred(), storage = deferred(), storageEntered = deferred();
    let writes = 0;
    const mutable = { ...targetA }, f = fixture(undefined, async (_key, value, commit) => {
        if (++writes === 1) { expect(value.textTarget).toEqual(targetA); storageEntered.resolve(); await storage.promise; }
        return commit();
    });
    const c = f.controller({ target: mutable, beforeTargetReceipt: async target => { expect(target).toEqual(targetA); expect(Object.isFrozen(target)).toBe(true); barrierEntered.resolve(); await barrier.promise; } });
    mutable.nodeId = "node-B";
    await c.prepare(input); const pending = c.confirm(); await barrierEntered.promise;
    expect(f.data.size).toBe(0); expect(submissions(f)).toHaveLength(0);
    await c.confirm(); barrier.resolve(); await storageEntered.promise;
    expect(submissions(f)).toHaveLength(0); storage.resolve(); await pending; await c.confirm();
    expect(submissions(f)).toHaveLength(1);
    expect(c.getState().receipt).toMatchObject({ textTarget: targetA, taskId });
    expect(await f.receiptStore.list(scope.accountId, scope.projectId)).toEqual([c.getState().receipt!]);
    expect(JSON.stringify(JSON.parse(submissions(f)[0].init!.body as string))).not.toContain("textTarget");
    expect(JSON.stringify([...f.data.values()])).not.toContain(input.prompt);
});

test("target barrier failure cannot persist a receipt, submit or silently retry", async () => {
    const f = fixture(), c = f.controller({ target: targetA, beforeTargetReceipt: async () => { throw new Error("private guard failure"); } });
    await c.prepare(input); await c.confirm(); await c.confirm();
    expect(c.getState()).toMatchObject({ phase: "failed", error: { outcome: "not-sent" } });
    expect(String(c.getState().error)).not.toContain("private guard"); expect(f.data.size).toBe(0); expect(submissions(f)).toHaveLength(0);
});

for (const changed of ["close", "account", "epoch", "project"] as const) test(`context invalidation during target barrier prevents submit and writes: ${changed}`, async () => {
    const entered = deferred(), release = deferred(), f = fixture(), c = f.controller({ target: targetA, beforeTargetReceipt: async () => { entered.resolve(); await release.promise; } });
    await c.prepare(input); const pending = c.confirm(); await entered.promise;
    if (changed === "close") c.close();
    else f.change({ ...scope, ...(changed === "account" ? { accountId: "other" } : changed === "epoch" ? { epoch: 3 } : { projectId: "other" }) });
    release.resolve(); await pending;
    expect(c.getState().phase).toBe("closed"); expect(f.data.size).toBe(0); expect(submissions(f)).toHaveLength(0);
});

test("close during bound receipt commit retains its original partition and never submits", async () => {
    const entered = deferred(), release = deferred();
    const f = fixture(undefined, async (_key, _value, commit) => { entered.resolve(); await release.promise; return commit(); });
    const c = f.controller({ target: targetA }); await c.prepare(input); const pending = c.confirm(); await entered.promise;
    c.close(); release.resolve(); await pending;
    expect(c.getState().phase).toBe("closed"); expect(submissions(f)).toHaveLength(0);
    expect(await f.receiptStore.list(scope.accountId, scope.projectId)).toEqual([{ accountId: scope.accountId, projectId: scope.projectId,
        idempotencyKey: "target-receipt-1", priceVersion: 3, textTarget: targetA }]);
});

test("lost submission recovers only the stored A target from a B dialog or top bar and never rebinds or POSTs", async () => {
    for (const openingTarget of [targetB, undefined]) {
        let barriers = 0;
        const f = fixture(async (_path, init) => { if (init?.method === "POST") throw new Error("lost reply"); return Response.json(view); });
        const original = f.controller({ target: targetA, beforeTargetReceipt: async () => { barriers++; } });
        await original.prepare(input); await original.confirm(); const saved = original.getState().receipt!; original.close();
        const recovered = f.controller({ target: openingTarget, beforeTargetReceipt: async () => { throw new Error("restore must not bind"); } });
        await recovered.restoreReceipt(saved); await recovered.confirm(); await recovered.refresh();
        expect(recovered.getState().receipt).toMatchObject({ textTarget: targetA, taskId });
        expect(submissions(f)).toHaveLength(1); expect(barriers).toBe(1);
        expect(f.calls.slice(2).map(call => call.init?.method)).toEqual(["GET", "GET"]);
        expect(f.calls[2].path).toBe("/api/v1/generation/tasks/by-key/target-receipt-1");
    }
});

test("forged, omitted or added restore targets are rejected before reading a task", async () => {
    for (const [storedTarget, incomingTarget] of [[targetA, targetB], [targetA, undefined], [undefined, targetB]] as const) {
        const f = fixture(), stored: TextGenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "original-key", priceVersion: 3,
            ...(storedTarget ? { textTarget: storedTarget } : {}) };
        await f.receiptStore.put(stored);
        const { textTarget: _target, ...base } = stored, incoming = { ...base, ...(incomingTarget ? { textTarget: incomingTarget } : {}) };
        const c = f.controller({ target: targetB }); await c.restoreReceipt(incoming); await c.confirm();
        expect(c.getState()).toMatchObject({ phase: "uncertain", view: null, error: { code: "receipt_storage" } });
        expect(f.calls).toHaveLength(0); expect(await f.receiptStore.list(scope.accountId, scope.projectId)).toEqual([stored]);
    }
});

test("legacy unbound receipts remain unbound when recovered from a node dialog", async () => {
    const f = fixture(), stored = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "legacy-key", priceVersion: 3 };
    await f.receiptStore.put(stored);
    const c = f.controller({ target: targetB, beforeTargetReceipt: async () => { throw new Error("must not bind legacy"); } });
    await c.restoreReceipt(stored); await c.confirm();
    expect(c.getState().receipt).toEqual({ ...stored, taskId });
    expect(submissions(f)).toHaveLength(0); expect(f.calls.map(call => call.init?.method)).toEqual(["GET"]);
    expect(await f.receiptStore.list(scope.accountId, scope.projectId)).toEqual([{ ...stored, taskId }]);
});

for (const failAt of [1, 2]) test(`bound receipt persistence fails closed at write ${failAt}`, async () => {
    let writes = 0;
    const f = fixture(undefined, async (_key, _value, commit) => { if (++writes === failAt) throw new Error("private disk failure"); return commit(); });
    const c = f.controller({ target: targetA }); await c.prepare(input); await c.confirm(); await c.confirm();
    expect(c.getState().phase).toBe(failAt === 1 ? "failed" : "uncertain");
    expect(c.getState().view).toBeNull(); expect(submissions(f)).toHaveLength(failAt === 1 ? 0 : 1);
    if (failAt === 2) expect((await f.receiptStore.list(scope.accountId, scope.projectId))[0]).toMatchObject({ textTarget: targetA });
});

test("definitive rejection and its restored record keep A even in a B controller", async () => {
    const f = fixture(async () => Response.json({ error: { code: "price_changed" } }, { status: 409 }));
    const original = f.controller({ target: targetA }); await original.prepare(input); await original.confirm();
    const saved = original.getState().receipt!; expect(saved).toMatchObject({ textTarget: targetA, rejection: "price_changed" }); original.close();
    const recovered = f.controller({ target: targetB }); await recovered.restoreReceipt(saved);
    expect(recovered.getState()).toMatchObject({ phase: "rejected", receipt: { textTarget: targetA, rejection: "price_changed" } });
    expect(submissions(f)).toHaveLength(1);
    expect(recovered.startNew()).toBe(true); expect(recovered.getState().receipt).toBeNull();
});

test("a new top-bar intent remains supported with no target or target callback", async () => {
    let barriers = 0;
    const f = fixture(), c = f.controller({ beforeTargetReceipt: async () => { barriers++; } });
    await c.prepare(input); await c.confirm();
    expect(c.getState().phase).toBe("tracking"); expect(c.getState().receipt).not.toHaveProperty("textTarget");
    expect(barriers).toBe(0); expect(submissions(f)).toHaveLength(1);
});

const configA: TextConfigBinding = { schemaVersion: 1, nodeId: "config-A", guardId: "44444444-4444-4444-8444-444444444444" };
const configB: TextConfigBinding = { schemaVersion: 1, nodeId: "config-B", guardId: "55555555-5555-4555-8555-555555555555" };

test("F2 Config binding and its durability barrier are frozen before one POST without leaking into server input", async () => {
    const entered = deferred(), release = deferred(), stored = deferred(), storeRelease = deferred(); let writes = 0;
    const f = fixture(undefined, async (_key, value, commit) => {
        if (++writes === 1) { expect(value.configTarget).toEqual(configA); stored.resolve(); await storeRelease.promise; }
        return commit();
    });
    const mutable = { ...configA }, c = f.controller({ configTarget: mutable, getIntentCurrent: () => true,
        beforeConfigReceipt: async value => { expect(value).toEqual(configA); expect(Object.isFrozen(value)).toBe(true); entered.resolve(); await release.promise; } });
    mutable.nodeId = "changed";
    await c.prepare(input); const pending = c.confirm(); await entered.promise;
    expect(f.data.size).toBe(0); expect(submissions(f)).toHaveLength(0);
    release.resolve(); await stored.promise; expect(submissions(f)).toHaveLength(0); storeRelease.resolve(); await pending; await c.confirm();
    expect(c.getState().receipt).toMatchObject({ configTarget: configA, taskId }); expect(c.getState().receipt).not.toHaveProperty("textTarget");
    expect(submissions(f)).toHaveLength(1); expect(String(submissions(f)[0].init?.body)).not.toContain("configTarget");
    expect(() => f.controller({ configTarget: configA, target: targetA })).toThrow();
});

test("F2 Config missing or failed durability guard cannot store or submit", async () => {
    for (const beforeConfigReceipt of [undefined, async () => { throw new Error("private Config guard failure"); }]) {
        const f = fixture(), c = f.controller({ configTarget: configA, beforeConfigReceipt });
        await c.prepare(input); await c.confirm(); await c.confirm();
        expect(c.getState()).toMatchObject({ phase: "failed", error: { outcome: "not-sent" } });
        expect(String(c.getState().error)).not.toContain("private Config"); expect(f.data.size).toBe(0); expect(submissions(f)).toHaveLength(0);
    }
});

test("F2 Config lost reply restores only stored binding and GETs despite a different invalid new-entry intent", async () => {
    const f = fixture(async (_path, init) => { if (init?.method === "POST") throw new Error("lost reply"); return Response.json(view); });
    const original = f.controller({ configTarget: configA, beforeConfigReceipt: async () => {} });
    await original.prepare(input); await original.confirm(); const saved = original.getState().receipt!; original.close();
    for (const opening of [{ configTarget: configB }, { target: targetB }, {}]) {
        let checks = 0;
        const c = f.controller({ ...opening, getIntentCurrent: () => { checks++; return false; }, beforeConfigReceipt: async () => { throw new Error("must not rebind"); } });
        await c.restoreReceipt(saved); c.invalidateIntent(); await c.refresh(); await c.confirm();
        expect(c.getState().receipt).toMatchObject({ configTarget: configA, taskId }); expect(c.getState().receipt).not.toHaveProperty("textTarget");
        expect(c.getState().intentInvalidated).toBe(false); expect(checks).toBe(0);
    }
    expect(submissions(f)).toHaveLength(1);
});

test("F2 Config restore rejects erased, changed, upgraded and cross-kind authority before task GET", async () => {
    for (const [storedBinding, incomingBinding] of [
        [{ configTarget: configA }, {}], [{ configTarget: configA }, { configTarget: configB }],
        [{ configTarget: configA }, { textTarget: targetA }], [{}, { configTarget: configA }],
        [{ textTarget: targetA }, { configTarget: configA }],
    ]) {
        const f = fixture(), base = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "restore-config-key", priceVersion: 3 };
        await f.receiptStore.put({ ...base, ...storedBinding });
        const c = f.controller({ configTarget: configB }); await c.restoreReceipt({ ...base, ...incomingBinding });
        expect(c.getState()).toMatchObject({ phase: "uncertain", error: { code: "receipt_storage" } }); expect(f.calls).toHaveLength(0);
    }
});

test("F2 input invalidation before or during quote is permanent even if the source returns to its original value", async () => {
    const entered = deferred(), release = deferred(); let current = true;
    const f = fixture(undefined, undefined, async () => { entered.resolve(); await release.promise; return Response.json({ quote }); });
    const c = f.controller({ getIntentCurrent: () => current });
    const pending = c.prepare(input); await entered.promise; current = false; release.resolve(); await pending;
    expect(c.getState()).toMatchObject({ phase: "failed", quote: null, intentInvalidated: true, error: { code: "intent_changed", outcome: "not-sent" } });
    current = true; await c.prepare(input); await c.confirm(); expect(c.startNew()).toBe(false);
    expect(c.getState().intentInvalidated).toBe(true); expect(f.calls).toHaveLength(1); expect(submissions(f)).toHaveLength(0);
    for (const checker of [() => false, () => { throw new Error("private source contents"); }]) {
        const first = fixture(), blocked = first.controller({ getIntentCurrent: checker }); await blocked.prepare(input);
        expect(blocked.getState()).toMatchObject({ phase: "failed", quote: null, intentInvalidated: true });
        expect(String(blocked.getState().error)).not.toContain("private source"); expect(first.calls).toHaveLength(0);
    }
});

test("F2 explicit invalidation immediately clears a quote without affecting legacy controllers", async () => {
    const f = fixture(), c = f.controller({ getIntentCurrent: () => true }); await c.prepare(input);
    c.invalidateIntent(); expect(c.getState()).toMatchObject({ quote: null, intentInvalidated: true, error: { code: "intent_changed" } });
    await c.confirm(); await c.prepare(input); expect(submissions(f)).toHaveLength(0);
    const legacy = f.controller(); await legacy.prepare(input); legacy.invalidateIntent();
    expect(legacy.getState()).toMatchObject({ phase: "ready", intentInvalidated: false, quote });
});

test("F2 changed intent at confirm or after Config barrier prevents receipt persistence and POST", async () => {
    for (const point of ["confirm", "barrier"] as const) {
        const entered = deferred(), release = deferred(); let current = true;
        const f = fixture(), c = f.controller({ configTarget: configA, getIntentCurrent: () => current,
            beforeConfigReceipt: async () => { entered.resolve(); await release.promise; } });
        await c.prepare(input);
        if (point === "confirm") current = false;
        const pending = c.confirm();
        if (point === "barrier") { await entered.promise; current = false; release.resolve(); }
        await pending;
        expect(c.getState()).toMatchObject({ phase: "failed", quote: null, intentInvalidated: true, error: { outcome: "not-sent" } });
        expect(f.data.size).toBe(0); expect(submissions(f)).toHaveLength(0);
    }
});

test("F2 invalidation during receipt commit retains original key as explicitly not sent and never retries", async () => {
    const entered = deferred(), release = deferred(); let current = true;
    const f = fixture(undefined, async (_key, _value, commit) => { entered.resolve(); await release.promise; return commit(); });
    const c = f.controller({ configTarget: configA, getIntentCurrent: () => current, beforeConfigReceipt: async () => {} });
    await c.prepare(input); const pending = c.confirm(); await entered.promise; current = false; release.resolve(); await pending;
    expect(c.getState()).toMatchObject({ phase: "failed", quote: null, intentInvalidated: true, error: { code: "intent_changed", outcome: "not-sent" }, receipt: { configTarget: configA } });
    expect(c.getState().receipt).not.toHaveProperty("rejection"); expect(c.getState().receipt).not.toHaveProperty("taskId");
    expect(await f.receiptStore.list(scope.accountId, scope.projectId)).toEqual([c.getState().receipt!]);
    current = true; await c.confirm(); expect(c.startNew()).toBe(false); expect(submissions(f)).toHaveLength(0);
});

test("F2 source changes after POST do not block accepted task recovery or replace stored application state", async () => {
    const entered = deferred(), release = deferred(); let current = true, checks = 0;
    const f = fixture(async (_path, init) => { if (init?.method === "POST") { entered.resolve(); await release.promise; } return Response.json(view); });
    const c = f.controller({ configTarget: configA, getIntentCurrent: () => { checks++; return current; }, beforeConfigReceipt: async () => {} });
    await c.prepare(input); const pending = c.confirm(); await entered.promise;
    const checksAtPost = checks; current = false; c.invalidateIntent(); release.resolve(); await pending;
    expect(c.getState()).toMatchObject({ phase: "tracking", intentInvalidated: false, receipt: { configTarget: configA, taskId } });
    expect(checks).toBe(checksAtPost);
    await f.receiptStore.claimConfigApplication(c.getState().receipt!); await f.receiptStore.completeConfigApplication(c.getState().receipt!);
    await c.refresh(); expect(c.getState().receipt?.application).toBe("applied"); expect(checks).toBe(checksAtPost); expect(submissions(f)).toHaveLength(1);
});

test("F2 invalidated new input can still restore original accepted or rejected records without reviving startNew", async () => {
    for (const rejected of [false, true]) {
        const f = fixture(); let checks = 0;
        const stored: TextGenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: `old-config-${rejected}`, priceVersion: 3,
            configTarget: configA, ...(rejected ? { rejection: "price_changed" } : { taskId }) };
        await f.receiptStore.put(stored);
        const c = f.controller({ configTarget: configB, getIntentCurrent: () => { checks++; return false; } });
        await c.prepare(input); const before = checks; await c.restoreReceipt(stored);
        expect(c.getState()).toMatchObject({ phase: rejected ? "rejected" : "tracking", intentInvalidated: true, receipt: { configTarget: configA } });
        expect(checks).toBe(before); expect(c.startNew()).toBe(false); expect(submissions(f)).toHaveLength(0);
    }
});

test("F2 account epoch change during Config barrier still revokes the original write context", async () => {
    const entered = deferred(), release = deferred(), f = fixture();
    const c = f.controller({ configTarget: configA, getIntentCurrent: () => true, beforeConfigReceipt: async () => { entered.resolve(); await release.promise; } });
    await c.prepare(input); const pending = c.confirm(); await entered.promise; f.change({ ...scope, epoch: 3 }); release.resolve(); await pending;
    expect(c.getState().phase).toBe("closed"); expect(f.data.size).toBe(0); expect(submissions(f)).toHaveLength(0);
});
