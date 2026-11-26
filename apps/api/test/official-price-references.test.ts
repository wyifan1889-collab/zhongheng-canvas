import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { OfficialPriceEntry, OfficialPriceMappingWrite, OfficialPriceSourceId } from "@infinite-canvas/shared";
import { claimOfficialPriceRefresh, completeOfficialPriceRefresh, listAdminOfficialPriceCatalog, listPublicOfficialPriceReferences, saveOfficialPriceMapping } from "@infinite-canvas/database/official-price-references";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { auditEvent, generationTask, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential,
    officialPriceMapping, officialPriceSource, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Only isolated in-memory PGlite is permitted");
const origin = "http://localhost:4037", secret = "official-price-synthetic-" + crypto.randomUUID();
const adminPath = "/api/v1/admin/official-price-references", publicPath = "/api/v1/official-price-references";
const mappingPath = "/api/v1/admin/official-price-reference-mappings", interval = 6 * 60 * 60 * 1000;
const referenceId = "openai:synthetic-standard", initialTime = Date.parse("2026-01-01T00:00:00.000Z");
type Identity = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>, app: ReturnType<typeof createApp>;
let admin: Identity, reader: Identity, mapping: OfficialPriceMappingWrite;
let rejectRate = false, queueCalls = 0, openaiTick = 0;
const entry = (id = referenceId, amount = "0.125"): OfficialPriceEntry => ({ id, modelName: "Synthetic text", context: "Standard; synthetic fixture",
    rates: [{ label: "输入", usdPerMillion: amount }, { label: "缓存输入", usdPerMillion: null }, { label: "输出", usdPerMillion: "2.5" }] });
const at = (tick: number, offset = 0) => new Date(initialTime + tick * interval + offset);
const source = async (id: OfficialPriceSourceId = "openai") => (await database.db.select().from(officialPriceSource).where(eq(officialPriceSource.id, id)))[0]!;
async function refresh(entries: OfficialPriceEntry[] | null) {
    const now = at(openaiTick++), token = await claimOfficialPriceRefresh(database.db, "openai", now, interval);
    expect(token).not.toBeNull();
    expect(await completeOfficialPriceRefresh(database.db, "openai", token!, entries, new Date(now.getTime() + 1))).toBe(true);
    return source();
}
function request(path = adminPath, identity = admin, method = "GET", body?: unknown, extra: HeadersInit = {}) {
    const headers = new Headers({ origin, cookie: identity.cookie, "x-canvas-account-id": identity.id, "content-type": "application/json" });
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return app(new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "198.51.100.37");
}
async function register(label: string): Promise<Identity> {
    const email = `official-price-${label}@example.test`, password = "synthetic-official-price-password";
    expect((await request("/api/auth/sign-up/email", { id: "", cookie: "" }, "POST", { email, password, name: label })).status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const login = await request("/api/auth/sign-in/email", { id: "", cookie: "" }, "POST", { email, password });
    expect(login.status).toBe(200);
    return { id: row!.id, cookie: login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}
async function seed(label: string): Promise<OfficialPriceMappingWrite> {
    const modelId = `official-${label}`, providerId = `private-${label}`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic channel", adapter: "openai-compatible",
        endpoint: "https://private-provider.invalid/v1", secretRef: "synthetic-private-reference", enabled: true });
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "synthetic-private-ciphertext", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, displayName: "Synthetic public model", providerId,
        providerModel: "private-upstream-model", capability: "text", enabled: true });
    return { modelId, referenceId, expectedVersion: 0, binding: { providerId, providerModel: "private-upstream-model",
        endpoint: "https://private-provider.invalid/v1", adapter: "openai-compatible", capability: "text" } };
}
const business = async () => ({ prices: await database.db.select().from(modelPricing), drafts: await database.db.select().from(modelPriceDraft),
    publications: await database.db.select().from(modelPricePublication), wallets: await database.db.select().from(wallet),
    ledger: await database.db.select().from(walletLedger), reservations: await database.db.select().from(walletReservation),
    tasks: await database.db.select().from(generationTask), queueCalls });
const mappingAudit = () => database.db.select().from(auditEvent).where(eq(auditEvent.action, "model.official-price-mapping.saved"));

beforeAll(async () => {
    database = await createTestDatabase();
    const rates = createRateStore(database.pool, secret);
    app = createApp(createAccountApi({ database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) { if (bucket === "account-read" || bucket === "canvas-save") return rejectRate ? { allowed: false, retryAfter: 1 } : { allowed: true }; return rates.consume(bucket, identity, rule); } },
        generation: { enabled: false, queue: { async send() { queueCalls++; throw new Error("Reference prices must not enqueue work"); } } },
        verifyHuman: async () => true, onFault: () => undefined }), "synthetic-official-price-site");
    admin = await register("admin"); reader = await register("reader");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await database.db.insert(wallet).values({ userId: reader.id, availableUnits: "7.004" });
    mapping = await seed("primary");
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: mapping.modelId, version: 1,
        billingUnit: "request", creditsPerUnit: 7, effectiveFrom: at(0), enabled: true });
});
afterAll(async () => { await database?.close(); });

test("empty catalog reads are side-effect free and refresh claims serialize without repeated attempts", async () => {
    const before = await business();
    expect((await listAdminOfficialPriceCatalog(database.db)).sources).toEqual(["openai", "anthropic"].map(id => ({ id, version: 0,
        checkedAt: null, attemptedAt: null, changedAt: null, status: "unavailable", entries: [], changedEntryIds: [] })));
    expect(await listPublicOfficialPriceReferences(database.db)).toEqual([]);
    expect(await database.db.select().from(officialPriceSource)).toEqual([]);
    const tokens = await Promise.all([0, 1].map(() => claimOfficialPriceRefresh(database.db, "openai", at(0), interval)));
    expect(tokens.filter(Boolean)).toHaveLength(1);
    const token = tokens.find(value => value !== null)!;
    expect(await completeOfficialPriceRefresh(database.db, "openai", token, [entry(), entry("openai:second")], at(0, 1))).toBe(true);
    openaiTick = 1;
    expect(await claimOfficialPriceRefresh(database.db, "openai", at(0, 60_001), interval)).toBeNull();
    expect(await source()).toMatchObject({ version: 1, status: "ready", changedAt: null, changedEntryIds: [], previousEntries: [], previousDigest: null });
    expect(await business()).toEqual(before);
});

test("semantic versions ignore ordering and trailing zeros, preserve display order, and retain previous changed snapshots", async () => {
    const first = await source();
    const reordered = [entry("openai:second"), entry(referenceId, "0.12500")].map(value => ({ ...value, rates: [...value.rates].reverse() }));
    const second = await refresh(reordered);
    expect(second.version).toBe(1); expect(second.digest).toBe(first.digest);
    expect(second.checkedAt!.getTime()).toBeGreaterThan(first.checkedAt!.getTime());
    expect(second.entries.map(value => value.id)).toEqual(reordered.map(value => value.id));
    expect(second.entries[0]!.rates.map(rate => rate.label)).toEqual(reordered[0]!.rates.map(rate => rate.label));
    expect(second.changedAt).toBeNull(); expect(second.changedEntryIds).toEqual([]);
    const third = await refresh([entry(referenceId, "0.15"), entry("openai:added")]);
    expect(third.version).toBe(2); expect(third.digest).not.toBe(first.digest);
    expect(third.previousEntries).toEqual(second.entries); expect(third.previousDigest).toBe(second.digest);
    expect(third.changedEntryIds).toEqual(["openai:added", "openai:second", referenceId]);
    expect(third.changedAt).toEqual(third.checkedAt);
    const fourth = await refresh(third.entries);
    expect(fourth.version).toBe(2); expect(fourth.changedAt).toEqual(third.changedAt);
    expect(fourth.changedEntryIds).toEqual(third.changedEntryIds); expect(fourth.previousEntries).toEqual(second.entries);
});

test("failed, empty and invalid refreshes retain the last price; expired or superseded leases cannot replace it", async () => {
    const before = await source();
    for (const entries of [null, [], [entry(referenceId, "NaN")]]) {
        const failed = await refresh(entries);
        expect(failed).toMatchObject({ version: before.version, entries: before.entries, digest: before.digest, checkedAt: before.checkedAt,
            changedAt: before.changedAt, changedEntryIds: before.changedEntryIds, previousEntries: before.previousEntries, status: "stale", leaseToken: null });
    }
    const failedToken = await claimOfficialPriceRefresh(database.db, "anthropic", at(0), interval);
    expect(await completeOfficialPriceRefresh(database.db, "anthropic", failedToken!, null, at(0, 1))).toBe(true);
    expect(await source("anthropic")).toMatchObject({ version: 0, entries: [], status: "unavailable", checkedAt: null });
    const expired = await claimOfficialPriceRefresh(database.db, "anthropic", at(1), interval);
    expect(await completeOfficialPriceRefresh(database.db, "anthropic", expired!, [entry("anthropic:test")], at(1, 60_000))).toBe(false);
    expect(await claimOfficialPriceRefresh(database.db, "anthropic", at(1, 60_001), interval)).toBeNull();
    const current = await claimOfficialPriceRefresh(database.db, "anthropic", at(2), interval);
    expect(await completeOfficialPriceRefresh(database.db, "anthropic", expired!, [entry("anthropic:old")], at(2, 1))).toBe(false);
    expect(await completeOfficialPriceRefresh(database.db, "anthropic", current!, [entry("anthropic:test")], at(2, 2))).toBe(true);
    expect(await completeOfficialPriceRefresh(database.db, "anthropic", current!, [entry("anthropic:duplicate")], at(2, 3))).toBe(false);
    expect((await source("anthropic")).entries.map(value => value.id)).toEqual(["anthropic:test"]);
});

test("real account handlers enforce authentication, role, source, account header, query, body and rate guards", async () => {
    const before = await business(), beforeAudit = await mappingAudit();
    expect((await request(adminPath, { id: "", cookie: "" })).status).toBe(401);
    expect((await request(publicPath, { id: "", cookie: "" })).status).toBe(401);
    expect((await request(adminPath, reader)).status).toBe(403);
    expect((await request(mappingPath, reader, "POST", mapping)).status).toBe(403);
    expect((await request(adminPath, admin, "GET", undefined, { "x-canvas-account-id": "" })).status).toBe(400);
    expect((await request(adminPath, admin, "GET", undefined, { "x-canvas-account-id": reader.id })).status).toBe(409);
    expect((await request(publicPath, reader, "GET", undefined, { "x-canvas-account-id": "" })).status).toBe(200);
    expect((await request(mappingPath, admin, "POST", mapping, { origin: "https://wrong.invalid" })).status).toBe(403);
    for (const path of [adminPath, publicPath, mappingPath]) expect((await request(`${path}?unexpected=1`, admin, path === mappingPath ? "POST" : "GET", path === mappingPath ? mapping : undefined)).status).toBe(400);
    expect((await request(mappingPath)).status).toBe(405);
    expect((await request(adminPath, admin, "POST", {})).status).toBe(405);
    expect((await request(mappingPath, admin, "POST", { ...mapping, costAmount: "0" })).status).toBe(400);
    expect((await request(mappingPath, admin, "POST", { ...mapping, binding: { ...mapping.binding, endpoint: "https://user:password@private-provider.invalid" } })).status).toBe(400);
    rejectRate = true;
    try { expect((await request(adminPath)).status).toBe(429); expect((await request(mappingPath, admin, "POST", mapping)).status).toBe(429); }
    finally { rejectRate = false; }
    expect(await mappingAudit()).toEqual(beforeAudit); expect(await business()).toEqual(before);
});

test("explicit mapping CAS permits one competing save and exposes only reference data without changing executable prices or funds", async () => {
    const before = await business(), publicModels = await (await request("/api/v1/models", reader)).json();
    const responses = await Promise.all([0, 1].map(() => request(mappingPath, admin, "POST", mapping)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const saved = await responses.find(response => response.status === 200)!.json();
    expect(saved.mapping).toEqual({ modelId: mapping.modelId, referenceId, binding: mapping.binding, bindingMatchesCurrent: true, version: 1 });
    const repeated = await request(mappingPath, admin, "POST", { ...mapping, expectedVersion: 1 });
    expect(repeated.status).toBe(200); expect((await repeated.json()).mapping.version).toBe(2);
    expect(await mappingAudit()).toHaveLength(2);
    const catalog = await request(); expect(catalog.status).toBe(200);
    expect(catalog.headers.get("cache-control")).toContain("no-store");
    expect((await catalog.json()).mappings).toHaveLength(1);
    const response = await request(publicPath, reader); expect(response.status).toBe(200);
    const items = (await response.json()).items;
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ modelId: mapping.modelId, sourceId: "openai", stale: true, entry: entry(referenceId, "0.15") });
    expect(Object.keys(items[0]).sort()).toEqual(["modelId", "sourceId", "version", "checkedAt", "changedAt", "stale", "entry"].sort());
    for (const forbidden of [mapping.binding.providerId, mapping.binding.endpoint, mapping.binding.providerModel, "synthetic-private", "cost", "digest", "leaseToken", "binding"]) expect(JSON.stringify(items)).not.toContain(forbidden);
    expect(await business()).toEqual(before);
    expect((await (await request("/api/v1/models", reader)).json()).items).toEqual(publicModels.items);
});

test("binding, enablement and credential changes hide public references while admin retains the original mapping", async () => {
    const providerId = mapping.binding.providerId;
    await database.db.update(modelProvider).set({ endpoint: "https://changed-provider.invalid/v1" }).where(eq(modelProvider.id, providerId));
    try {
        expect(await listPublicOfficialPriceReferences(database.db)).toEqual([]);
        expect((await listAdminOfficialPriceCatalog(database.db)).mappings[0]).toMatchObject({ binding: mapping.binding, bindingMatchesCurrent: false });
        const stale = await request(mappingPath, admin, "POST", { ...mapping, expectedVersion: 2 });
        expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("model_binding_changed");
    } finally { await database.db.update(modelProvider).set({ endpoint: mapping.binding.endpoint }).where(eq(modelProvider.id, providerId)); }
    for (const field of ["model", "provider", "capability"] as const) {
        if (field === "model") await database.db.update(modelCatalog).set({ enabled: false }).where(eq(modelCatalog.publicId, mapping.modelId));
        if (field === "provider") await database.db.update(modelProvider).set({ enabled: false }).where(eq(modelProvider.id, providerId));
        if (field === "capability") await database.db.update(modelCatalog).set({ capability: "image" }).where(eq(modelCatalog.publicId, mapping.modelId));
        expect(await listPublicOfficialPriceReferences(database.db)).toEqual([]);
        await database.db.update(modelCatalog).set({ enabled: true, capability: "text" }).where(eq(modelCatalog.publicId, mapping.modelId));
        await database.db.update(modelProvider).set({ enabled: true }).where(eq(modelProvider.id, providerId));
    }
    const [credential] = await database.db.delete(modelProviderCredential).where(eq(modelProviderCredential.providerId, providerId)).returning();
    try { expect(await listPublicOfficialPriceReferences(database.db)).toEqual([]); }
    finally { await database.db.insert(modelProviderCredential).values(credential!); }
    expect(await listPublicOfficialPriceReferences(database.db)).toHaveLength(1);
});

test("removed references disappear without auto-remapping and explicit clear is versioned; unknown IDs cannot write", async () => {
    const before = await business();
    await refresh([entry("openai:replacement")]);
    expect(await listPublicOfficialPriceReferences(database.db)).toEqual([]);
    expect((await listAdminOfficialPriceCatalog(database.db)).mappings[0]!.referenceId).toBe(referenceId);
    const missing = await request(mappingPath, admin, "POST", { ...mapping, expectedVersion: 2 });
    expect(missing.status).toBe(409); expect((await missing.json()).error.code).toBe("official_price_reference_unavailable");
    const cleared = await request(mappingPath, admin, "POST", { ...mapping, referenceId: null, expectedVersion: 2 });
    expect(cleared.status).toBe(200); expect((await cleared.json()).mapping).toMatchObject({ referenceId: null, version: 3 });
    expect(await listPublicOfficialPriceReferences(database.db)).toEqual([]);
    const absent = await request(mappingPath, admin, "POST", { ...mapping, modelId: "not-a-model" }); expect(absent.status).toBe(404);
    expect(await business()).toEqual(before);
});

test("mapping and audit commit atomically and database constraints reject corrupt cache shapes", async () => {
    const next = await seed("audit"), before = await business(), beforeAudit = await mappingAudit();
    next.referenceId = "openai:replacement";
    await database.db.execute(sql`CREATE FUNCTION canvas_saas.reject_official_mapping_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'model.official-price-mapping.saved' THEN RAISE EXCEPTION 'synthetic audit rejection'; END IF; RETURN NEW; END $$`);
    await database.db.execute(sql`CREATE TRIGGER reject_official_mapping_audit BEFORE INSERT ON canvas_saas.audit_event FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_official_mapping_audit()`);
    try { await expect(saveOfficialPriceMapping(database.db, next, { actorId: admin.id, requestId: "synthetic-audit-rejection" })).rejects.toThrow(); }
    finally {
        await database.db.execute(sql`DROP TRIGGER reject_official_mapping_audit ON canvas_saas.audit_event`);
        await database.db.execute(sql`DROP FUNCTION canvas_saas.reject_official_mapping_audit()`);
    }
    expect(await database.db.select().from(officialPriceMapping).where(eq(officialPriceMapping.modelId, next.modelId))).toEqual([]);
    expect(await mappingAudit()).toEqual(beforeAudit); expect(await business()).toEqual(before);
    await expect(Promise.resolve(database.db.execute(sql`UPDATE canvas_saas.official_price_source SET entries='{}'::jsonb WHERE id='openai'`))).rejects.toThrow();
    await expect(database.db.update(officialPriceSource).set({ leaseToken: "orphan", leaseExpiresAt: null }).where(eq(officialPriceSource.id, "openai")).execute()).rejects.toThrow();
});
