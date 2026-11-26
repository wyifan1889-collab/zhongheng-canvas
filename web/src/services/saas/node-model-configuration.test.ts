import { expect, test } from "bun:test";
import { createNodeModelConfigurationClient, type NodeModelGroups } from "./node-model-configuration";
import { fetchPlatformPricing, PlatformServiceError, type AdminGenerationScope, type AdminModel, type ModelWrite } from "./platform";

const scope: AdminGenerationScope = { accountId: "synthetic-admin", epoch: 4, role: "admin" };
const id = "11111111-1111-4111-8111-111111111111", stamp = "2026-01-01T00:00:00.000Z";
const groups: NodeModelGroups[] = [{ capability: "text", version: 0, groups: [] }, { capability: "image", version: 2, groups: [{ id, name: "GPT" }] }, { capability: "video", version: 0, groups: [] }, { capability: "audio", version: 0, groups: [] }];
const model: AdminModel = { id: "image-test", displayName: "图片模型", capability: "image", groupId: id, revision: 3, providerId: "demo", providerDisplayName: "演示渠道", providerModel: "gpt-image-2", adapter: "openai-compatible", endpoint: "https://provider.invalid", enabled: false, providerEnabled: true, secretRefConfigured: true, createdAt: stamp, updatedAt: stamp };
const library = { providerId: "demo", providerName: "演示渠道", providerModel: "gpt-image-2", providerEnabled: true, available: true, firstSeenAt: stamp, lastSeenAt: stamp, boundModelId: "image-test" };
const write: ModelWrite = { revision: 3, groupId: id, providerId: "demo", providerModel: "gpt-image-2", displayName: "新名称", capability: "image", enabled: true };
function deferred<T>() { let resolve!: (result: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(handler: (path: string, init?: RequestInit) => Promise<Response>) {
    let current: AdminGenerationScope | null = scope;
    const calls: { path: string; init?: RequestInit }[] = [];
    const fetcher = Object.assign((input: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(input), init }); return handler(String(input), init); }, { preconnect: fetch.preconnect });
    const client = createNodeModelConfigurationClient({ scope, getScope: () => current, fetcher });
    return { calls, client, change(value: AdminGenerationScope | null) { current = value; } };
}
function catalogResponse(path: string) {
    return Response.json(path.endsWith("model-groups") ? { items: groups.map(row => ({ ...row, internal: "discard" })) } : path.endsWith("provider-models") ? { models: [{ ...library, key: "discard" }] } : { items: [{ ...model, secret: "discard" }] });
}

test("CATALOG-03 node configuration reads four group types through the existing scoped catalogs", async () => {
    const f = fixture(async path => catalogResponse(path));
    expect(await f.client.load()).toEqual({ groups, models: [model], library: [library] });
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every(call => call.init?.method === "GET" && call.init.credentials === "same-origin" && call.init.cache === "no-store" && call.init.redirect === "error")).toBe(true);
    expect(f.calls.every(call => new Headers(call.init?.headers).get("x-canvas-account-id") === scope.accountId)).toBe(true);
    f.client.close();
});

test("node model writes carry current revision and reject inconsistent save acknowledgements", async () => {
    const f = fixture(async () => Response.json({ model: { ...model, ...write, revision: 4, key: "discard" } }));
    expect(await f.client.saveModel(model.id, write)).toEqual({ ...model, ...write, revision: 4 });
    expect(f.calls[0].path).toBe("/api/v1/admin/models/image-test");
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual(write);
    f.client.close();
    for (const patch of [{ revision: 5 }, { groupId: null }, { capability: "video" }, { enabled: false }]) {
        const bad = fixture(async () => Response.json({ model: { ...model, ...write, revision: 4, ...patch } }));
        await expect(bad.client.saveModel(model.id, write)).rejects.toThrow("回执不完整");
        expect(bad.calls).toHaveLength(1); bad.client.close();
    }
});

test("ordered groups save by expected version and require the same returned names and order", async () => {
    const input = { capability: "image" as const, expectedVersion: 2, groups: [{ id, name: "GPT 图片" }] };
    const f = fixture(async () => Response.json({ item: { ...input, expectedVersion: undefined, version: 3 } }));
    expect(await f.client.saveGroups(input)).toEqual({ capability: "image", version: 3, groups: input.groups });
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual(input); f.client.close();
    const bad = fixture(async () => Response.json({ item: { capability: "image", version: 3, groups: [{ id, name: "旧名字" }] } }));
    await expect(bad.client.saveGroups(input)).rejects.toBeInstanceOf(PlatformServiceError); bad.client.close();
});

test("same-account new login epochs discard pending reads and prevent any subsequent write", async () => {
    const pending = deferred<Response>(); const f = fixture(async path => path.endsWith("model-groups") ? pending.promise : catalogResponse(path));
    const result = f.client.load(); f.change({ ...scope, epoch: 5 }); pending.resolve(catalogResponse("model-groups"));
    expect(await result).toBeNull(); expect(await f.client.saveModel(model.id, write)).toBeNull();
    expect(f.calls).toHaveLength(3); expect(f.calls.every(call => call.init?.signal?.aborted)).toBe(true); f.client.close();
});

test("cancelled editor operations cannot replace a newer configuration result", async () => {
    const pending = deferred<Response>(); const f = fixture(async (_path, init) => JSON.parse(String(init?.body)).displayName === "旧输入" ? pending.promise : Response.json({ model: { ...model, ...write, revision: 4 } }));
    const old = f.client.saveModel(model.id, { ...write, displayName: "旧输入" }); f.client.cancel();
    expect(await f.client.saveModel(model.id, write)).toEqual({ ...model, ...write, revision: 4 });
    pending.resolve(Response.json({ model: { ...model, ...write, revision: 4, displayName: "旧输入" } }));
    expect(await old).toBeNull(); f.client.close();
});

test("CATALOG-03 incomplete catalogs and cross-type group references cannot populate an editor", async () => {
    for (const patch of [{ groupId: "missing" }, { capability: "video" }, { capability: "audio" }, { revision: 0 }]) {
        const f = fixture(async path => path.endsWith("/models") ? Response.json({ items: [{ ...model, ...patch }] }) : catalogResponse(path));
        await expect(f.client.load()).rejects.toThrow("回执不完整"); f.client.close();
    }
    for (const incomplete of [groups.slice(0, 3), [groups[0], groups[0], groups[2], groups[3]]]) {
        const f = fixture(async path => path.endsWith("model-groups") ? Response.json({ items: incomplete }) : catalogResponse(path));
        await expect(f.client.load()).rejects.toThrow("回执不完整"); f.client.close();
    }
});

test("conflicts and unconfirmed writes use local messages and do not retry or expose upstream text", async () => {
    for (const status of [400, 401, 403, 409, 503]) {
        const f = fixture(async () => Response.json({ message: "secret-do-not-display" }, { status }));
        try { await f.client.saveModel(model.id, write); throw new Error("must reject"); } catch (error) {
            expect(error).toBeInstanceOf(PlatformServiceError); expect((error as Error).message).not.toContain("secret-do-not-display");
            if (status === 409 || status === 503) expect((error as Error).message).toContain("重新读取");
        }
        expect(f.calls).toHaveLength(1); f.client.close();
    }
    const disconnected = fixture(async () => { throw new Error("network dropped"); });
    await expect(disconnected.client.saveModel(model.id, write)).rejects.toThrow("保存结果尚未确认");
    expect(disconnected.calls).toHaveLength(1); disconnected.client.close();
});

test("published status reads the scoped public price catalog without falling back to administrative history", async () => {
    const controller = new AbortController(), calls: { path: string; init?: RequestInit }[] = [];
    const fetcher = Object.assign(async (path: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(path), init }); return Response.json({ items: [] }); }, { preconnect: fetch.preconnect });
    expect(await fetchPlatformPricing({ accountId: scope.accountId, signal: controller.signal, fetcher })).toEqual([]);
    expect(calls[0].path).toBe("/api/v1/model-pricing");
    expect(new Headers(calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(calls[0].init?.redirect).toBe("error");
    const unavailable = Object.assign(async () => Response.json({ items: [{ modelId: "history-only" }] }, { status: 503 }), { preconnect: fetch.preconnect });
    await expect(fetchPlatformPricing({ accountId: scope.accountId, signal: controller.signal, fetcher: unavailable })).rejects.toBeInstanceOf(PlatformServiceError);
});

test("model deletion is scoped, revisioned and validates exactly the removed model", async () => {
    const f = fixture(async () => Response.json({ deleted: { id: model.id, revision: 4, modelIds: [model.id], private: "discard" } }));
    expect(await f.client.removeModel(model.id, 3)).toEqual({ id: model.id, revision: 4, modelIds: [model.id] });
    expect(f.calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({ revision: 3 });
    expect(new Headers(f.calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    f.client.close();
    for (const deleted of [{ id: model.id, revision: 3, modelIds: [model.id] }, { id: model.id, revision: 4, modelIds: ["other"] }]) {
        const bad = fixture(async () => Response.json({ deleted }));
        await expect(bad.client.removeModel(model.id, 3)).rejects.toBeInstanceOf(PlatformServiceError);
        expect(bad.calls).toHaveLength(1); bad.client.close();
    }
});

test("unfinished task rejection and uncertain deletion never retry or expose server text", async () => {
    const f = fixture(async () => Response.json({ error: { code: "catalog_in_use", message: "private" } }, { status: 409 }));
    await expect(f.client.removeModel(model.id, 3)).rejects.toThrow("未结束或待核对");
    expect(f.calls).toHaveLength(1); f.client.close();
    const lost = fixture(async () => { throw new Error("connection lost"); });
    await expect(lost.client.removeModel(model.id, 3)).rejects.toThrow("删除结果尚未确认");
    expect(lost.calls).toHaveLength(1); lost.client.close();
    const pending = deferred<Response>(), stale = fixture(async () => pending.promise);
    const request = stale.client.removeModel(model.id, 3); stale.change({ ...scope, epoch: 8 });
    pending.resolve(Response.json({ deleted: { id: model.id, revision: 4, modelIds: [model.id] } }));
    expect(await request).toBeNull(); stale.client.close();
});
