import { expect, test } from "bun:test";
import { createAdminProviderCatalogClient, PlatformServiceError, type AdminGenerationScope, type ProviderWrite } from "./platform";

const scope: AdminGenerationScope = { accountId: "synthetic-admin", epoch: 1, role: "admin" };
const stamp = "2026-01-01T00:00:00.000Z";
const input: ProviderWrite = { revision: 0, displayName: "合成渠道", adapter: "openai-compatible", endpoint: "https://synthetic.invalid/v1", enabled: false, apiKey: "synthetic-not-a-key" };
const provider = { id: "synthetic", ...input, revision: 1, credentialConfigured: true, createdAt: stamp, updatedAt: stamp, removedModelIds: [] };
const receipt = { providerId: "synthetic", revision: 0, receiptId: "11111111-1111-4111-8111-111111111111", models: ["gpt-image-2"], added: ["gpt-image-2"], missing: [], unchanged: 0, bindings: [] };
const model = { providerId: "synthetic", providerName: "合成渠道", providerEnabled: false, providerModel: "gpt-image-2", available: true, firstSeenAt: stamp, lastSeenAt: stamp, boundModelId: null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(run: (path: string, init?: RequestInit) => Promise<Response>) {
    let current: AdminGenerationScope | null = { ...scope };
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = Object.assign((path: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(path), init }); return run(String(path), init); }, { preconnect: fetch.preconnect });
    const client = createAdminProviderCatalogClient({ scope, getScope: () => current, fetcher });
    return { client, calls, change(next: AdminGenerationScope | null) { current = next; } };
}

test("channel discovery uses the scoped platform route, keeps the receipt separate, and saves only on an explicit call", async () => {
    const f = fixture(async (path) => Response.json(path.endsWith("/discover") ? { ...receipt, apiKey: "discard" } : { provider }));
    const result = await f.client.discover("synthetic", input);
    expect(result).toEqual(receipt); expect(f.calls).toHaveLength(1);
    expect(f.calls[0].path).toBe("/api/v1/admin/providers/synthetic/discover");
    expect(f.calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(new Headers(f.calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual(input);
    const saved = await f.client.save("synthetic", { ...input, discoveryReceiptId: result!.receiptId });
    expect(saved?.revision).toBe(1); expect(saved).not.toHaveProperty("apiKey");
    expect(f.calls[1].init?.method).toBe("PUT");
    expect(JSON.parse(String(f.calls[1].init?.body)).discoveryReceiptId).toBe(receipt.receiptId); f.client.close();
});

test("library retains same names from different channels, missing records and bindings without leaking extra data", async () => {
    const rows = [model, { ...model, providerId: "other", available: false, boundModelId: "public-image" }];
    const f = fixture(async () => Response.json({ models: rows.map((row) => ({ ...row, secretRef: "discard" })) }));
    expect(await f.client.load()).toEqual(rows);
    expect(f.calls[0].path).toBe("/api/v1/admin/provider-models");
    expect(f.calls[0].init?.method).toBe("GET"); expect(f.calls[0].init?.body).toBeUndefined(); f.client.close();
});

test("form invalidation and a newer request discard late discovery responses", async () => {
    const pending = deferred<Response>();
    const f = fixture(async () => f.calls.length === 1 ? pending.promise : Response.json(receipt));
    const previous = f.client.discover("synthetic", input);
    f.client.cancel();
    expect(f.calls[0].init?.signal?.aborted).toBe(true);
    expect(await f.client.discover("synthetic", input)).toEqual(receipt);
    pending.resolve(Response.json({ ...receipt, models: ["old"], added: ["old"] }));
    expect(await previous).toBeNull(); f.client.close();
});

test("a same-account new login epoch rejects late responses and sends no follow-up writes", async () => {
    const pending = deferred<Response>(); const f = fixture(async () => pending.promise);
    const previous = f.client.discover("synthetic", input);
    f.change({ ...scope, epoch: 2 }); pending.resolve(Response.json(receipt));
    expect(await previous).toBeNull();
    expect(await f.client.save("synthetic", { ...input, discoveryReceiptId: receipt.receiptId })).toBeNull();
    expect(f.calls).toHaveLength(1); f.client.close();
});

test("directory and channel conflicts use actionable local errors without displaying upstream payloads", async () => {
    for (const [status, word] of [[409, "重新编辑并测试"], [502, "已保存渠道和模型库未更改"], [401, "会话已失效"]] as const) {
        const f = fixture(async () => Response.json({ message: "upstream-secret-do-not-render" }, { status }));
        try { await f.client.discover("synthetic", input); throw new Error("must fail"); } catch (error) {
            expect(error).toBeInstanceOf(PlatformServiceError); expect((error as Error).message).toContain(word);
            expect((error as Error).message).not.toContain("upstream-secret");
        }
        expect(f.calls).toHaveLength(1); f.client.close();
    }
});

test("malformed receipts cannot become confirmable and save results must match the requested revision", async () => {
    for (const value of [{ ...receipt, revision: 1 }, { ...receipt, models: ["gpt-image-2", "gpt-image-2"] }, { ...receipt, added: ["other"] }, { ...receipt, unchanged: 1 }]) {
        const f = fixture(async () => Response.json(value));
        await expect(f.client.discover("synthetic", input)).rejects.toBeInstanceOf(PlatformServiceError); f.client.close();
    }
    const f = fixture(async () => Response.json({ provider: { ...provider, revision: 2 } }));
    await expect(f.client.save("synthetic", input)).rejects.toThrow("保存回执不一致"); f.client.close();
    const duplicate = fixture(async () => Response.json({ models: [model, model] }));
    await expect(duplicate.client.load()).rejects.toThrow("重复记录"); duplicate.client.close();
});

test("catalogues larger than one hundred remain complete in the management client", async () => {
    const models = Array.from({ length: 150 }, (_, index) => `model-${index}`);
    const f = fixture(async () => Response.json({ ...receipt, models, added: models }));
    expect((await f.client.discover("synthetic", input))?.models).toHaveLength(150); f.client.close();
});

test("channel deletion returns its complete cascade receipt and preserves the administrator scope", async () => {
    const deleted = { id: "synthetic", revision: 2, modelIds: ["image-a", "text-b"] };
    const f = fixture(async () => Response.json({ deleted: { ...deleted, private: "discard" } }));
    expect(await f.client.remove("synthetic", 1)).toEqual(deleted);
    expect(f.calls[0].path).toBe("/api/v1/admin/providers/synthetic");
    expect(f.calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({ revision: 1 });
    expect(new Headers(f.calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId); f.client.close();
    const bad = fixture(async () => Response.json({ deleted: { ...deleted, modelIds: ["same", "same"] } }));
    await expect(bad.client.remove("synthetic", 1)).rejects.toThrow("删除回执不一致"); bad.client.close();
});

test("sync requires a complete removal receipt and reports unfinished tasks without retrying", async () => {
    const saved = fixture(async () => Response.json({ provider: { ...provider, removedModelIds: ["old-image"] } }));
    expect((await saved.client.save("synthetic", input))?.removedModelIds).toEqual(["old-image"]);
    for (const removedModelIds of [undefined, ["old", "old"]]) {
        const invalid = fixture(async () => Response.json({ provider: { ...provider, removedModelIds } }));
        await expect(invalid.client.save("synthetic", input)).rejects.toThrow("同步回执不完整");
    }
    const busy = fixture(async () => Response.json({ error: { code: "catalog_in_use" } }, { status: 409 }));
    await expect(busy.client.save("synthetic", input)).rejects.toThrow("均未更新"); expect(busy.calls).toHaveLength(1);
});

test("channel deletion rejects unfinished tasks, retains uncertainty and ignores late results after logout", async () => {
    const f = fixture(async () => Response.json({ error: { code: "catalog_in_use", message: "do-not-render" } }, { status: 409 }));
    await expect(f.client.remove("synthetic", 1)).rejects.toThrow("未结束或待核对");
    expect(f.calls).toHaveLength(1); f.client.close();
    const lost = fixture(async () => { throw new Error("network lost"); });
    await expect(lost.client.remove("synthetic", 1)).rejects.toThrow("删除结果尚未确认");
    expect(lost.calls).toHaveLength(1); lost.client.close();
    const pending = deferred<Response>(), stale = fixture(async () => pending.promise);
    const request = stale.client.remove("synthetic", 1); stale.change(null);
    pending.resolve(Response.json({ deleted: { id: "synthetic", revision: 2, modelIds: [] } }));
    expect(await request).toBeNull(); expect(await stale.client.remove("synthetic", 1)).toBeNull(); expect(stale.calls).toHaveLength(1); stale.client.close();
});
