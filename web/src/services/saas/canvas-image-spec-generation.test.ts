import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { ImageTargetBinding } from "@/lib/canvas/platform-image-target";
import { createCanvasImageGenerationController, createGenerationReceiptStore, createImageReceiptAtomicUpdate, parseGenerationReceipt, parseImageTargetBinding,
    type GenerationReceipt, type GenerationReceiptBacking } from "./canvas-image-generation";
import { createGenerationClient, type GenerationScope } from "./generation";

const scope: GenerationScope = { accountId: "image-owner", epoch: 2, projectId: "image-project" };
const taskId = "11111111-1111-4111-8111-111111111111";
const target: ImageTargetBinding = { schemaVersion: 1, nodeId: "image-source", guardId: "22222222-2222-4222-8222-222222222222", sourceType: "config" };
const other: ImageTargetBinding = { ...target, nodeId: "other-source", guardId: "33333333-3333-4333-8333-333333333333", sourceType: "image" };
const high = { size: "1536x1024", quality: "high" as const }, low = { size: "1024x1024", quality: "low" as const };
const input = () => ({ modelId: "image-spec-model", prompt: "保持完整要求", parameters: { ...high }, nodeId: target.nodeId });
const amount = (parameters: { quality?: string }) => parameters.quality === "low" ? 7 : 13;
const fingerprint = (parameters: { quality?: string }) => (parameters.quality === "low" ? "b" : "a").repeat(64);
const view = (parameters = high, nodeId: string | null = target.nodeId) => ({ task: { id: taskId, projectId: scope.projectId, nodeId, modelId: "image-spec-model", priceVersion: 3,
    quotedUnits: amount(parameters), imageSpecSnapshot: { status: "recorded", protocol: "openai-image-v1", parameters }, executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" },
    result: { taskId, status: "succeeded", resultSnapshot: { kind: "image", media: { mediaId: taskId, kind: "image", contentType: "image/png", sizeBytes: 232, etag: "synthetic-etag" } } } });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function memory() {
    const data = new Map<string, unknown>();
    const backing: GenerationReceiptBacking = { keys: async () => [...data.keys()], getItem: async key => structuredClone(data.get(key) ?? null),
        setItem: async (key, value) => { data.set(key, structuredClone(value)); return value; } };
    return { data, backing };
}
function fixture(run?: (path: string, init: RequestInit | undefined, reply: () => Response) => Promise<Response>, backing?: GenerationReceiptBacking) {
    const m = memory(), store = createGenerationReceiptStore(backing ?? m.backing), calls: { path: string; init?: RequestInit }[] = [];
    let current = { ...scope }, sequence = 0;
    function controller(options: Pick<Parameters<typeof createCanvasImageGenerationController>[0], "imageTarget" | "beforeImageReceipt" | "getIntentCurrent" | "readOnly"> = {}) {
        const client = createGenerationClient({ scope: { ...current }, getScope: () => current, fetcher: Object.assign(async (value: RequestInfo | URL, init?: RequestInit) => {
            const path = String(value); calls.push({ path, init });
            const reply = () => {
                const body = init?.body ? JSON.parse(String(init.body)) : undefined, selected = body?.parameters ?? high;
                return Response.json(path.endsWith("/models") ? { items: [{ id: "image-spec-model", displayName: "合成图片", capability: "image", group: null,
                    imagePricing: { protocol: "openai-image-v1", priceVersion: 3, billingUnit: "image_specs", creditsPerUnit: null, imageSpecs: [{ parameters: low, creditsPerRequest: 7 }, { parameters: high, creditsPerRequest: 13 }] } }] }
                    : path.endsWith("/quote") ? { quote: { modelId: body.modelId, priceVersion: 3, quotedUnits: amount(selected), billingUnit: "request", creditsPerUnit: amount(selected),
                        imageSpec: { protocol: "openai-image-v1", parameters: selected }, quoteFingerprint: fingerprint(selected) } }
                    : view(selected, body ? body.nodeId ?? null : target.nodeId));
            };
            return run ? run(path, init, reply) : reply();
        }, { preconnect: fetch.preconnect }) });
        return { client, value: createCanvasImageGenerationController({ client, getContext: () => current, receiptStore: store,
            createIdempotencyKey: () => `image-intent-${++sequence}`, ...options }) };
    }
    return { calls, data: m.data, store, controller, change(next: GenerationScope) { current = next; } };
}
const posts = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.path.endsWith("/tasks") && call.init?.method === "POST");

test("I3b image target guard and original node are durable before one frozen fingerprint submission", async () => {
    const entered = deferred(), release = deferred(), f = fixture(), mutableTarget = { ...target };
    const { client, value: c } = f.controller({ imageTarget: mutableTarget, getIntentCurrent: () => true, beforeImageReceipt: async (binding, nodeId) => {
        expect(binding).toEqual(target); expect(Object.isFrozen(binding)).toBe(true); expect(nodeId).toBe(target.nodeId); entered.resolve(); await release.promise;
    } });
    mutableTarget.nodeId = other.nodeId; await client.models(); const mutable = input(); await c.prepare(mutable);
    mutable.prompt = "后来输入"; mutable.parameters.size = "999x999"; mutable.nodeId = other.nodeId;
    const pending = c.confirm(); await entered.promise; expect(posts(f)).toHaveLength(0); expect(f.data.size).toBe(0);
    release.resolve(); await pending; await c.confirm();
    expect(posts(f)).toHaveLength(1); expect(JSON.parse(String(posts(f)[0].init?.body))).toEqual({ modelId: "image-spec-model", input: { prompt: "保持完整要求" },
        parameters: high, projectId: scope.projectId, nodeId: target.nodeId, confirmedPriceVersion: 3, confirmedQuoteFingerprint: "a".repeat(64) });
    expect(c.getState().receipt).toMatchObject({ taskId, nodeId: target.nodeId, imageTarget: target });
    expect(JSON.stringify([...f.data.values()])).not.toContain("prompt"); expect(JSON.stringify([...f.data.values()])).not.toContain("保持完整要求");
});

test("I3b changing form specifications discards an in-flight old quote but permits a fresh explicit quote", async () => {
    const entered = deferred(), release = deferred(); let quotes = 0;
    const f = fixture(async (path, _init, reply) => { if (path.endsWith("/quote") && ++quotes === 1) { entered.resolve(); await release.promise; } return reply(); });
    const { client, value: c } = f.controller(); await client.models();
    const first = c.prepare(input()); await entered.promise; c.invalidateQuote();
    expect(c.getState()).toMatchObject({ phase: "idle", busy: false, quote: null, intentInvalidated: false });
    await c.prepare({ ...input(), parameters: low }); release.resolve(); await first;
    expect(c.getState()).toMatchObject({ phase: "ready", quote: { quotedUnits: 7, imageSpec: { parameters: low } } });
    await c.confirm(); expect(posts(f)).toHaveLength(1); expect(JSON.parse(String(posts(f)[0].init?.body)).confirmedQuoteFingerprint).toBe("b".repeat(64));
});

test("I3b captured target invalidation during its barrier is permanent and cannot silently create a task", async () => {
    const entered = deferred(), release = deferred(); let current = true;
    const f = fixture(), { client, value: c } = f.controller({ imageTarget: target, getIntentCurrent: () => current,
        beforeImageReceipt: async () => { entered.resolve(); await release.promise; } });
    await client.models(); await c.prepare(input()); const pending = c.confirm(); await entered.promise;
    current = false; c.invalidateIntent(); release.resolve(); await pending; current = true;
    c.invalidateQuote(); await c.prepare(input()); await c.confirm();
    expect(c.getState()).toMatchObject({ phase: "failed", quote: null, intentInvalidated: true, error: { code: "intent_changed", outcome: "not-sent" } });
    expect(c.startNew()).toBe(false); expect(posts(f)).toHaveLength(0); expect(f.data.size).toBe(0);
});

test("I3b invalidation while the initial receipt commits keeps its key explicitly unsent without replay", async () => {
    const entered = deferred(), release = deferred(), m = memory(); let current = true;
    const backing = { ...m.backing, async setItem(key: string, value: GenerationReceipt) { entered.resolve(); await release.promise; return m.backing.setItem(key, value); } };
    const f = fixture(undefined, backing), { client, value: c } = f.controller({ imageTarget: target, getIntentCurrent: () => current, beforeImageReceipt: async () => {} });
    await client.models(); await c.prepare(input()); const pending = c.confirm(); await entered.promise;
    current = false; c.invalidateIntent(); release.resolve(); await pending;
    expect(c.getState()).toMatchObject({ phase: "failed", intentInvalidated: true, receipt: { nodeId: target.nodeId, imageTarget: target }, error: { outcome: "not-sent" } });
    expect(c.getState().receipt).not.toHaveProperty("taskId"); expect(c.getState().receipt).not.toHaveProperty("rejection");
    expect(await f.store.list(scope.accountId, scope.projectId)).toEqual([c.getState().receipt!]); expect(posts(f)).toHaveLength(0);
});

test("I3b invalid entries cannot adopt another target; a separate original read-only recovery preserves consumption", async () => {
    for (const bound of [false, true]) {
        const f = fixture(), stored: GenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: `old-image-${bound}`, priceVersion: 3, taskId,
            ...(bound ? { nodeId: target.nodeId, imageTarget: target } : {}) };
        await f.store.put(stored); await f.store.claimImageApplication(stored); await f.store.completeImageApplication(stored);
        let checks = 0;
        const { value: c } = f.controller({ imageTarget: other, getIntentCurrent: () => { checks++; return false; }, beforeImageReceipt: async () => { throw new Error("must not rebind"); } });
        await c.prepare({ ...input(), nodeId: other.nodeId }); const before = checks;
        await c.restoreReceipt(stored); c.invalidateIntent(); await c.refresh();
        expect(c.getState()).toMatchObject({ phase: "failed", intentInvalidated: true, receipt: null, error: { code: "invalid_target" } });
        expect(f.calls).toHaveLength(0); expect(checks).toBe(before); expect(c.startNew()).toBe(false);
        const recovery = f.controller({ imageTarget: stored.imageTarget, readOnly: true, getIntentCurrent: () => false }).value;
        await recovery.restoreReceipt(stored); await recovery.prepare(input()); await recovery.confirm(); await recovery.refresh();
        expect(recovery.getState()).toMatchObject({ phase: "tracking", receipt: { application: "applied" } });
        expect(recovery.getState().receipt?.imageTarget).toEqual(bound ? target : undefined); expect(recovery.startNew()).toBe(false);
        expect(f.calls.every(call => call.init?.method === "GET")).toBe(true);
    }
});

test("I3b a missing image guard, a different request node or a forged restore cannot authorize a new target", async () => {
    const f = fixture(), { client, value: missing } = f.controller({ imageTarget: target }); await client.models(); await missing.prepare(input()); await missing.confirm();
    expect(missing.getState()).toMatchObject({ phase: "failed", error: { code: "image_target_unready", outcome: "not-sent" } }); expect(posts(f)).toHaveLength(0);
    const wrong = f.controller({ imageTarget: target }).value; await wrong.prepare({ ...input(), nodeId: other.nodeId });
    expect(wrong.getState()).toMatchObject({ phase: "failed", error: { code: "invalid_target" } });
    const stored: GenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "bound-old", priceVersion: 3, taskId, nodeId: target.nodeId, imageTarget: target };
    await f.store.put(stored); const before = f.calls.length;
    const restored = f.controller({ imageTarget: other }).value;
    await restored.restoreReceipt({ ...stored, nodeId: other.nodeId, imageTarget: other });
    expect(restored.getState()).toMatchObject({ phase: "uncertain", error: { code: "receipt_storage" } }); expect(f.calls).toHaveLength(before);
});

test("I3b owner recovery rejects a task whose node differs from the persisted original receipt", async () => {
    const f = fixture(async (_path, _init, _reply) => Response.json(view(high, other.nodeId)));
    const stored: GenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "node-owner", priceVersion: 3, taskId, nodeId: target.nodeId, imageTarget: target };
    await f.store.put(stored); const c = f.controller().value; await c.restoreReceipt(stored);
    expect(c.getState()).toMatchObject({ phase: "uncertain", view: null, error: { code: "unconfirmed" } }); expect(posts(f)).toHaveLength(0);
});

test("I3b image receipt authority is strict, immutable and never added to an old receipt", async () => {
    const base: GenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "strict-image", priceVersion: 3 };
    for (const value of [{ ...target, sourceType: "text" }, { ...target, extra: true }, { ...target, guardId: "invalid" }, { ...target, nodeId: " x " },
        { ...target, [Symbol("hidden")]: true }]) expect(() => parseImageTargetBinding(value)).toThrow();
    for (const value of [{ ...base, imageTarget: target }, { ...base, nodeId: other.nodeId, imageTarget: target }, { ...base, nodeId: undefined },
        { ...base, application: "pending" }, { ...base, taskId, application: "other" }]) expect(() => parseGenerationReceipt(value, true)).toThrow();
    const m = memory(), store = createGenerationReceiptStore(m.backing); await store.put(base);
    await expect(store.put({ ...base, nodeId: target.nodeId, imageTarget: target })).rejects.toMatchObject({ code: "receipt_storage" });
    const fresh = { ...base, idempotencyKey: "new-bound", nodeId: target.nodeId, imageTarget: target }; await store.put(fresh);
    await expect(store.put({ ...fresh, nodeId: other.nodeId, imageTarget: other })).rejects.toMatchObject({ code: "receipt_storage" });
    await expect(store.put({ ...fresh, imageTarget: undefined })).rejects.toMatchObject({ code: "receipt_storage" });
});

test("I3b native atomic claims cover bound and top-bar tasks and stale GET writes cannot revive applied output", async () => {
    const factory = new IDBFactory(), name = `i3b-image-receipts-${crypto.randomUUID()}`;
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(name); request.onupgradeneeded = () => { request.result.createObjectStore("receipts"); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const backing = (): GenerationReceiptBacking => ({ keys: async () => [], getItem: async () => null, setItem: async () => { throw new Error("atomic required"); }, updateItem: createImageReceiptAtomicUpdate(open) });
    const first = createGenerationReceiptStore(backing()), second = createGenerationReceiptStore(backing());
    for (const bound of [false, true]) {
        const reference: GenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: `consume-${bound}`, priceVersion: 3, taskId,
            ...(bound ? { nodeId: target.nodeId, imageTarget: target } : {}) };
        await first.put(reference);
        const [one, two] = await Promise.all([first.claimImageApplication(reference), second.claimImageApplication(reference), second.put(reference)]);
        expect([one, two].sort()).toEqual(["claimed", "pending"]);
        await first.completeImageApplication(reference); await second.put(reference);
        expect(await second.claimImageApplication(reference)).toBe("applied");
        await expect(first.put({ ...reference, application: "pending" })).rejects.toMatchObject({ code: "receipt_storage" });
    }
});

test("I3b failed claim persistence keeps pending uncertainty instead of authorizing another placement", async () => {
    const m = memory(), store = createGenerationReceiptStore(m.backing), reference: GenerationReceipt = {
        accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "claim-uncertain", priceVersion: 3, taskId };
    await store.put(reference); const write = m.backing.setItem;
    m.backing.setItem = async (key, value) => { await write(key, value); throw new Error("lost disk reply"); };
    await expect(store.claimImageApplication(reference)).rejects.toMatchObject({ code: "receipt_storage" });
    m.backing.setItem = write; expect(await store.claimImageApplication(reference)).toBe("pending");
});
