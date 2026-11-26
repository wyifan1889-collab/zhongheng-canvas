import { expect, test } from "bun:test";
import { createAdminOfficialPriceReferenceClient, fetchPublicOfficialPriceReferences, type AdminOfficialPriceCatalog, type OfficialPriceMapping, type PublicOfficialPriceReference } from "./official-price-references";
import { PlatformServiceError, type AdminGenerationScope } from "./platform";

const time = "2026-10-23T00:00:00.000Z", scope: AdminGenerationScope = { accountId: "synthetic-admin", epoch: 4, role: "admin" };
const binding = { providerId: "synthetic-channel", providerModel: "synthetic-upstream", adapter: "openai-compatible" as const, endpoint: "https://synthetic.example.invalid/v1", capability: "text" as const };
const source: AdminOfficialPriceCatalog["sources"][number] = { id: "openai", version: 2, status: "ready", checkedAt: time, attemptedAt: time, changedAt: time, changedEntryIds: ["openai:synthetic-text"],
    entries: [{ id: "openai:synthetic-text", modelName: "Synthetic Text", context: "Standard · synthetic only", rates: [{ label: "输入", usdPerMillion: "2.5" }, { label: "缓存读取", usdPerMillion: "0.000001" }, { label: "缓存写入", usdPerMillion: null }, { label: "输出", usdPerMillion: "10" }] }] };
const mapping = (patch: Partial<OfficialPriceMapping> = {}): OfficialPriceMapping => ({ modelId: "synthetic-text", referenceId: source.entries[0].id, version: 1, binding, bindingMatchesCurrent: true, ...patch });
const catalog = (mappings: OfficialPriceMapping[] = []): AdminOfficialPriceCatalog => ({ sources: [source], mappings });
const publicRow: PublicOfficialPriceReference = { modelId: "synthetic-text", sourceId: "openai", version: 2, checkedAt: time, changedAt: time, stale: false, entry: source.entries[0] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(run: (path: string, init?: RequestInit) => Promise<Response>) {
    let current: AdminGenerationScope | null = { ...scope }; const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = Object.assign((path: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(path), init }); return run(String(path), init); }, { preconnect: fetch.preconnect });
    return { calls, fetcher, change(next: AdminGenerationScope | null) { current = next; }, client: createAdminOfficialPriceReferenceClient({ scope, getScope: () => current, fetcher }) };
}

test("admin reference catalog is scoped, projected and a mapping write contains no draft, cost or sale", async () => {
    const f = fixture(async (_, init) => Response.json(init?.method === "POST" ? { mapping: { ...mapping(), secret: "discard" } } : { ...catalog(), secret: "discard" }));
    expect(await f.client.load()).toEqual(catalog());
    expect(f.calls[0]).toMatchObject({ path: "/api/v1/admin/official-price-references", init: { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" } });
    expect(new Headers(f.calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    const body = { modelId: "synthetic-text", referenceId: source.entries[0].id, binding, expectedVersion: 0 };
    expect(await f.client.save(body)).toEqual(mapping()); expect(f.calls[1].path).toBe("/api/v1/admin/official-price-reference-mappings");
    expect(JSON.parse(String(f.calls[1].init?.body))).toEqual(body);
    expect(f.calls).toHaveLength(2); expect(JSON.stringify(f.calls[1].init?.body)).not.toContain("rates"); f.client.close();
});

test("mapping requires a loaded catalog and valid explicit entry, permits removal, and verifies the exact saved receipt", async () => {
    const f = fixture(async (_, init) => Response.json(init?.method === "POST" ? { mapping: mapping({ referenceId: null, version: 2 }) } : catalog([mapping()])));
    const body = { modelId: "synthetic-text", referenceId: null, binding, expectedVersion: 1 };
    await expect(f.client.save(body)).rejects.toBeInstanceOf(PlatformServiceError); expect(f.calls).toHaveLength(0);
    await f.client.load();
    await expect(f.client.save({ ...body, referenceId: "openai:not-in-catalog" })).rejects.toBeInstanceOf(PlatformServiceError);
    expect(await f.client.save(body)).toEqual(mapping({ referenceId: null, version: 2 })); expect(f.calls).toHaveLength(2); f.client.close();
    for (const receipt of [mapping({ version: 9 }), mapping({ referenceId: null }), mapping({ bindingMatchesCurrent: false }), mapping({ binding: { ...binding, providerModel: "wrong" } })]) {
        const g = fixture(async (_, init) => Response.json(init?.method === "POST" ? { mapping: receipt } : catalog())); await g.client.load();
        await expect(g.client.save({ ...body, referenceId: source.entries[0].id, expectedVersion: 0 })).rejects.toBeInstanceOf(PlatformServiceError);
        await expect(g.client.save({ ...body, referenceId: source.entries[0].id, expectedVersion: 0 })).rejects.toBeInstanceOf(PlatformServiceError);
        expect(g.calls).toHaveLength(2); g.client.close();
    }
});

test("conflict or uncertain mapping writes require manual GET before any new confirmation and never retry automatically", async () => {
    for (const status of [409, 503]) {
        const f = fixture(async (_, init) => init?.method === "POST" ? Response.json({ error: { code: status === 409 ? "official_price_mapping_conflict" : "unavailable" } }, { status }) : Response.json(catalog()));
        const body = { modelId: "synthetic-text", referenceId: source.entries[0].id, expectedVersion: 0, binding };
        await f.client.load(); await expect(f.client.save(body)).rejects.toBeInstanceOf(PlatformServiceError);
        await expect(f.client.save(body)).rejects.toBeInstanceOf(PlatformServiceError); expect(f.calls.map(c => c.init?.method)).toEqual(["GET", "POST"]);
        await f.client.load(); expect(f.calls.map(c => c.init?.method)).toEqual(["GET", "POST", "GET"]); f.client.close();
    }
});

for (const mode of ["epoch", "account", "role", "close"] as const) test(`official mapping rejects a late parsed body after ${mode}`, async () => {
    for (const writing of [false, true]) {
        const body = deferred<unknown>(), entered = deferred<void>();
        const f = fixture(async (_, init) => { if (writing && init?.method === "GET") return Response.json(catalog());
            const response = Response.json({}); response.json = () => { entered.resolve(); return body.promise; }; return response; });
        if (writing) await f.client.load();
        const pending = writing ? f.client.save({ modelId: "synthetic-text", referenceId: source.entries[0].id, expectedVersion: 0, binding }) : f.client.load();
        await entered.promise;
        if (mode === "close") f.client.close(); else f.change(mode === "role" ? null : { ...scope, ...(mode === "account" ? { accountId: "other" } : { epoch: 5 }) });
        body.resolve(writing ? { mapping: mapping() } : catalog()); expect(await pending).toBeNull();
        expect(f.calls.at(-1)?.init?.signal?.aborted).toBe(true); f.change(scope); expect(await f.client.load()).toBeNull(); f.client.close();
    }
});

test("a superseded reference read cannot replace the later catalog", async () => {
    const firstBody = deferred<unknown>(), entered = deferred<void>(); let reads = 0;
    const f = fixture(async () => { if (++reads > 1) return Response.json(catalog([mapping()])); const response = Response.json({}); response.json = () => { entered.resolve(); return firstBody.promise; }; return response; });
    const first = f.client.load(); await entered.promise; expect(await f.client.load()).toEqual(catalog([mapping()]));
    firstBody.resolve(catalog()); expect(await first).toBeNull(); expect(f.calls[0].init?.signal?.aborted).toBe(true); f.client.close();
});

test("public reference projects only public fields, preserves zero versus unknown, and exposes stale status", async () => {
    const row = { ...publicRow, stale: true, entry: { ...publicRow.entry, rates: [{ label: "输入", usdPerMillion: "0" }, { label: "缓存写入", usdPerMillion: null }], privateNote: "discard" }, binding, credential: "discard", rules: { cost: "discard" } };
    const f = fixture(async () => Response.json({ items: [row] }));
    expect(await fetchPublicOfficialPriceReferences({ fetcher: f.fetcher })).toEqual([{ ...publicRow, stale: true, entry: { ...publicRow.entry, rates: row.entry.rates } }]);
    expect(f.calls[0]).toMatchObject({ path: "/api/v1/official-price-references", init: { method: "GET", cache: "no-store", redirect: "error" } });
    expect(new Headers(f.calls[0].init?.headers).has("x-canvas-account-id")).toBe(false); f.client.close();
});

test("public reference rejects malformed data and does not apply a body after cancellation or context change", async () => {
    for (const row of [{ ...publicRow, sourceId: "unknown" }, { ...publicRow, checkedAt: null }, { ...publicRow, entry: { ...publicRow.entry, rates: [{ label: "输入", usdPerMillion: -1 }] } }]) {
        const f = fixture(async () => Response.json({ items: [row] })); await expect(fetchPublicOfficialPriceReferences({ fetcher: f.fetcher })).rejects.toBeInstanceOf(PlatformServiceError); expect(f.calls).toHaveLength(1); f.client.close();
    }
    for (const abort of [true, false]) {
        const body = deferred<unknown>(), entered = deferred<void>(), signal = new AbortController(); let current = true;
        const f = fixture(async () => { const response = Response.json({}); response.json = () => { entered.resolve(); return body.promise; }; return response; });
        const pending = fetchPublicOfficialPriceReferences({ fetcher: f.fetcher, signal: signal.signal, isCurrent: () => current }); await entered.promise;
        if (abort) signal.abort(); else current = false; body.resolve({ items: [publicRow] }); expect(await pending).toBeNull(); f.client.close();
    }
    const failed = fixture(async () => new Response("unavailable", { status: 503 }));
    await expect(fetchPublicOfficialPriceReferences({ fetcher: failed.fetcher })).rejects.toThrow("平台价目与余额不受影响"); expect(failed.calls).toHaveLength(1); failed.client.close();
});
