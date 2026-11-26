import { expect, test } from "bun:test";
import { createCanvasImageGenerationController, createGenerationReceiptStore, type GenerationReceipt, type GenerationReceiptBacking } from "./canvas-image-generation";
import { createGenerationClient, type GenerationScope } from "./generation";
import { applyImageTargetResult, protectImageTargetChanges, registerImageTarget, type ImageTargetBinding } from "@/lib/canvas/platform-image-target";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const taskId = "11111111-1111-4111-8111-111111111111";
const scope: GenerationScope = { accountId: "synthetic-account", epoch: 2, projectId: "synthetic-canvas" };
const quote = { modelId: "synthetic-image", priceVersion: 3, quotedUnits: 7, billingUnit: "request", creditsPerUnit: 7 };
const task = { id: taskId, projectId: scope.projectId, modelId: quote.modelId, priceVersion: 3, quotedUnits: 7, executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved" };
const finished = { task: { ...task, executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" }, result: { taskId, status: "succeeded", resultSnapshot: { kind: "image", media: { mediaId: taskId, kind: "image", contentType: "image/png", sizeBytes: 232, etag: "synthetic-etag" } } } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function memory() {
    const data = new Map<string, unknown>();
    const backing: GenerationReceiptBacking = {
        async keys() { return [...data.keys()]; },
        async getItem(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
        async setItem(key, value) { data.set(key, structuredClone(value)); return value; },
    };
    return { data, backing };
}
function fixture(respond?: (path: string, init?: RequestInit) => Promise<Response>, backing?: GenerationReceiptBacking) {
    let current: GenerationScope = { ...scope };
    const memoryStore = memory(), receipts = createGenerationReceiptStore(backing ?? memoryStore.backing);
    const calls: { path: string; init?: RequestInit }[] = [];
    function controller() {
        const client = createGenerationClient({ scope: { ...current }, getScope: () => current, fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input);
            calls.push({ path, init });
            return path.endsWith("/quote") ? Response.json({ quote }) : respond ? respond(path, init) : Response.json(init?.method === "POST" ? { task, result: null } : finished);
        }, { preconnect: fetch.preconnect }) });
        return createCanvasImageGenerationController({ client, getContext: () => current, receiptStore: receipts, createIdempotencyKey: () => "synthetic-request" });
    }
    return { controller, calls, data: memoryStore.data, receipts, change(next: GenerationScope) { current = next; } };
}

test("one confirmed immutable intent is persisted before one POST, then only manual GET updates task state", async () => {
    const f = fixture(), session = f.controller();
    const initial = session.getState();
    expect(session.getState()).toBe(initial);
    const input = { modelId: quote.modelId, prompt: "synthetic private prompt" };
    await session.prepare(input);
    input.prompt = "changed after quote";
    expect(session.getState()).toMatchObject({ phase: "ready", busy: false, quote });
    const submitted = session.confirm();
    await session.confirm();
    await submitted;
    await session.confirm();
    expect(session.getState()).toMatchObject({ phase: "tracking", view: { task }, receipt: { taskId } });
    expect(f.calls.filter((call) => call.init?.method === "POST" && call.path.endsWith("/tasks"))).toHaveLength(1);
    const post = f.calls.find((call) => call.path.endsWith("/tasks"))!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ modelId: quote.modelId, input: { prompt: "synthetic private prompt" }, parameters: {}, projectId: scope.projectId, confirmedPriceVersion: 3 });
    const records = await session.listReceipts();
    expect(records).toEqual([{ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "synthetic-request", priceVersion: 3, taskId }]);
    expect(JSON.stringify([...f.data.values()])).not.toContain("prompt");
    expect(f.calls).toHaveLength(2);
    await session.refresh();
    expect(session.getState()).toMatchObject({ phase: "tracking", view: finished });
    expect(f.calls[2]).toMatchObject({ path: `/api/v1/generation/tasks/${taskId}`, init: { method: "GET" } });
});

test("unknown submission survives close and a new account epoch using an ID-only receipt and read-only lookup", async () => {
    let posts = 0;
    const f = fixture(async (_path, init) => {
        if (init?.method === "POST") { posts++; throw new Error("synthetic transport lost after commit"); }
        return Response.json(finished);
    });
    const first = f.controller();
    await first.prepare({ modelId: quote.modelId, prompt: "never persist this" });
    await first.confirm();
    expect(first.getState()).toMatchObject({ phase: "uncertain", error: { outcome: "unknown" }, receipt: { idempotencyKey: "synthetic-request" } });
    await first.confirm();
    first.close();
    f.change({ ...scope, epoch: 3 });
    const reopened = f.controller(), [saved] = await reopened.listReceipts();
    expect(saved).not.toHaveProperty("taskId");
    await reopened.restoreReceipt(saved);
    expect(reopened.getState()).toMatchObject({ phase: "tracking", view: finished });
    await reopened.confirm();
    await reopened.refresh();
    expect(posts).toBe(1);
    expect(f.calls.slice(2).map((call) => [call.path, call.init?.method])).toEqual([["/api/v1/generation/tasks/by-key/synthetic-request", "GET"], [`/api/v1/generation/tasks/${taskId}`, "GET"]]);
    expect(JSON.stringify([...f.data.values()])).not.toContain("never persist");
    f.change({ ...scope, projectId: "other-project" });
    const other = f.controller(), before = f.calls.length;
    expect(await other.listReceipts()).toEqual([]);
    await other.restoreReceipt(saved);
    expect(other.getState()).toMatchObject({ phase: "failed", error: { code: "context_changed" } });
    expect(f.calls).toHaveLength(before);
});

for (const changed of ["close", "account", "epoch", "project"] as const) test(`a late submitted result cannot reach a closed or changed view: ${changed}`, async () => {
    const response = deferred<Response>(), started = deferred<void>();
    const f = fixture(async () => { started.resolve(); return response.promise; }), session = f.controller();
    const applied: unknown[] = [];
    session.subscribe(() => { if (session.getState().view) applied.push(session.getState().view); });
    await session.prepare({ modelId: quote.modelId, prompt: "synthetic" });
    const pending = session.confirm();
    await started.promise;
    if (changed === "close") session.close();
    else f.change({ ...scope, ...(changed === "account" ? { accountId: "other-account" } : changed === "epoch" ? { epoch: 3 } : { projectId: "other-project" }) });
    response.resolve(Response.json(finished));
    await pending;
    expect(session.getState()).toMatchObject({ phase: "closed", view: null, busy: false });
    expect(session.isCurrent()).toBe(false);
    expect(applied).toEqual([]);
    expect(await f.receipts.list(scope.accountId, scope.projectId)).toEqual([{ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "synthetic-request", priceVersion: 3 }]);
    expect(await f.receipts.list("other-account", scope.projectId)).toEqual([]);
});

test("close while the initial receipt commits prevents POST and keeps the recovery hint in its original partition", async () => {
    const m = memory(), entered = deferred<void>(), release = deferred<void>();
    const f = fixture(undefined, { ...m.backing, async setItem(key, value) { entered.resolve(); await release.promise; return m.backing.setItem(key, value); } });
    const session = f.controller();
    await session.prepare({ modelId: quote.modelId, prompt: "synthetic" });
    const pending = session.confirm();
    await entered.promise;
    session.close();
    release.resolve();
    await pending;
    expect(f.calls.map((call) => call.path)).toEqual(["/api/v1/generation/quote"]);
    expect(session.getState().phase).toBe("closed");
    expect(await f.receipts.list(scope.accountId, scope.projectId)).toHaveLength(1);
});

test("receipt persistence fails closed before POST; failed task-ID persistence after POST remains uncertain", async () => {
    for (const failAt of [1, 2]) {
        const m = memory(); let writes = 0;
        const f = fixture(undefined, { ...m.backing, async setItem(key, value) { if (++writes === failAt) throw new Error("private storage detail"); return m.backing.setItem(key, value); } });
        const session = f.controller();
        await session.prepare({ modelId: quote.modelId, prompt: "synthetic" });
        await session.confirm();
        expect(session.getState().phase).toBe(failAt === 1 ? "failed" : "uncertain");
        expect(session.getState().view).toBeNull();
        expect(f.calls.filter((call) => call.path.endsWith("/tasks"))).toHaveLength(failAt === 1 ? 0 : 1);
        expect(String(session.getState().error)).not.toContain("private storage");
        await session.confirm();
        expect(f.calls.filter((call) => call.path.endsWith("/tasks"))).toHaveLength(failAt === 1 ? 0 : 1);
        if (failAt === 2) expect(await f.receipts.list(scope.accountId, scope.projectId)).toEqual([{ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "synthetic-request", priceVersion: 3 }]);
    }
});

test("an unknown submission followed by recovery 404 never re-enables submission", async () => {
    const f = fixture(async (_path, init) => Response.json({ error: { code: init?.method === "POST" ? "unconfirmed" : "not_found" } }, { status: init?.method === "POST" ? 503 : 404 }));
    const session = f.controller();
    await session.prepare({ modelId: quote.modelId, prompt: "synthetic" });
    await session.confirm();
    expect(session.getState()).toMatchObject({ phase: "uncertain", error: { code: "unconfirmed", outcome: "unknown" } });
    await session.refresh();
    expect(session.getState()).toMatchObject({ phase: "uncertain", error: { code: "not_found" } });
    await session.confirm();
    expect(f.calls.filter((call) => call.path.endsWith("/tasks"))).toHaveLength(1);
});

test("receipt records are detached minimal projections and later hints cannot erase the known task ID", async () => {
    const m = memory(), store = createGenerationReceiptStore(m.backing);
    const original: GenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "first-key", priceVersion: 3 };
    await store.put({ ...original, prompt: "private", key: "private", base64: "private" } as GenerationReceipt);
    await store.put({ ...original, taskId });
    await store.put(original);
    await store.put({ ...original, idempotencyKey: "second-key" });
    expect(await store.list(scope.accountId, scope.projectId)).toEqual([{ ...original, taskId }, { ...original, idempotencyKey: "second-key" }]);
    expect(JSON.stringify([...m.data.values()])).not.toContain("private");
    await expect(store.put({ ...original, priceVersion: 4 })).rejects.toMatchObject({ code: "receipt_storage" });
    expect(await store.list("other-account", scope.projectId)).toEqual([]);
});

test("canvas target receipts persist a submission timestamp and reject malformed timestamps", async () => {
    const { backing } = memory(), store = createGenerationReceiptStore(backing);
    const imageTarget = { schemaVersion: 1 as const, nodeId: "image-node", guardId: "22222222-2222-4222-8222-222222222222", sourceType: "image" as const };
    const submittedAt = "2026-11-01T08:00:00.000Z";
    await store.put({ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "canvas-request", priceVersion: 3, taskId, nodeId: imageTarget.nodeId, imageTarget, submittedAt });
    expect(await store.list(scope.accountId, scope.projectId)).toEqual([{ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "canvas-request", priceVersion: 3, taskId, nodeId: imageTarget.nodeId, imageTarget, submittedAt }]);
    await expect(store.put({ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "bad-time", priceVersion: 3, submittedAt: "not-a-date" })).rejects.toMatchObject({ code: "receipt_storage" });
});

test("read-only recovery queries the original task after node edits without reauthorizing or overwriting its target", async () => {
    const target: ImageTargetBinding = { schemaVersion: 1, nodeId: "edited-node", guardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceType: "image" };
    const original: CanvasNodeData = { id: target.nodeId, type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { prompt: "原要求" } };
    const registered = registerImageTarget([original], target).nodes;
    const edited = protectImageTargetChanges(registered, registered.map(node => ({ ...node, metadata: { ...node.metadata, content: "blob:manual-edit" } })), [], []);
    const before = structuredClone(edited), f = fixture(), saved: GenerationReceipt = { accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "read-original", priceVersion: 3, taskId, nodeId: target.nodeId, imageTarget: target };
    await f.receipts.put(saved);
    const calls: string[] = [], client = createGenerationClient({ scope, getScope: () => scope, fetcher: Object.assign(async (path: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method} ${path}`); return Response.json({ ...finished, task: { ...finished.task, nodeId: target.nodeId } });
    }, { preconnect: fetch.preconnect }) });
    const reader = createCanvasImageGenerationController({ client, getContext: () => scope, receiptStore: f.receipts, imageTarget: target, readOnly: true, getIntentCurrent: () => false });
    await reader.prepare({ modelId: quote.modelId, prompt: "changed" }); await reader.confirm(); expect(calls).toEqual([]);
    await reader.restoreReceipt(saved); expect(reader.getState()).toMatchObject({ phase: "tracking", receipt: { taskId }, view: { task: { id: taskId } } });
    expect(calls).toEqual([`GET /api/v1/generation/tasks/${taskId}`]); expect(reader.startNew()).toBe(false);
    const image = { taskId, cloudMediaId: taskId, url: "blob:owned-result", width: 1024, height: 512, bytes: 232, mimeType: "image/png" as const, target };
    expect(applyImageTargetResult(edited, [], image, { x: 0, y: 0 }, "original")).toMatchObject({ status: "protected", reason: "edited" });
    expect(edited).toEqual(before);
    const separate = applyImageTargetResult(edited, [], image, { x: 0, y: 0 }, "new");
    expect(separate.status).toBe("saved-new"); expect(separate.nodes.find(node => node.id === target.nodeId)).toMatchObject(before[0]); expect(separate.connections).toEqual([]);
    expect(separate.nodes.find(node => node.id === target.nodeId)?.metadata?.platformImageRequests).toEqual([{ guardId: target.guardId, edited: true, taskId }]);
});

test("a target-bound recovery rejects a receipt for a different original guard before any GET", async () => {
    const f = fixture(), target: ImageTargetBinding = { schemaVersion: 1, nodeId: "node", guardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceType: "image" };
    const client = createGenerationClient({ scope, getScope: () => scope, fetcher: Object.assign(async () => { throw new Error("must not fetch"); }, { preconnect: fetch.preconnect }) });
    const reader = createCanvasImageGenerationController({ client, getContext: () => scope, receiptStore: f.receipts, imageTarget: target, readOnly: true });
    await reader.restoreReceipt({ accountId: scope.accountId, projectId: scope.projectId, idempotencyKey: "other-guard", priceVersion: 3, taskId, nodeId: target.nodeId, imageTarget: { ...target, guardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    expect(reader.getState()).toMatchObject({ phase: "failed", receipt: null, error: { code: "invalid_target" } });
});
