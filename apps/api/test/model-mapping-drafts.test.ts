import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { auditEvent, modelCatalog, modelMappingDraft, modelPricing, modelProvider, providerDiscoveredModel, user, session } from "@infinite-canvas/database/schema";
import { readModelMappingDraft, saveModelMappingDraft } from "@infinite-canvas/database/model-mapping-drafts";
import { emptyMappingDraft, mappingSpecKey, mappingCombinationKey, type MappingDraft } from "@infinite-canvas/shared";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase, postgresTestUrl } from "./database";

if (postgresTestUrl() && process.env.SAAS_POSTGRES_TEST_SUITE !== "model-mapping") throw new Error("Use isolated --model-mapping runner");
const origin = "http://localhost:4017", secret = "mapping-test-" + crypto.randomUUID();
let database: Awaited<ReturnType<typeof createTestDatabase>>, app: ReturnType<typeof createApp>;
let admin = { id: "", cookie: "" }, regular = { id: "", cookie: "" };
let actor: { actorId: string; sessionId: string; sessionExpiresAt: Date; requestId: string };
const mails: { url: string }[] = [];
function request(path: string, who = admin, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    return app(new Request(origin + path, { method, headers: { origin, cookie: who.cookie, "x-canvas-account-id": who.id, ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), "198.51.100.29");
}
const path = "/api/v1/admin/model-mapping-draft";
async function signup(email: string) {
    const password = "isolated-model-mapping-password";
    expect((await request("/api/auth/sign-up/email", { id: "", cookie: "" }, "POST", { email, password, name: email })).status).toBe(200);
    expect((await app(new Request(mails.at(-1)!.url), "198.51.100.29")).status).toBe(302);
    const response = await request("/api/auth/sign-in/email", { id: "", cookie: "" }, "POST", { email, password });
    expect(response.status).toBe(200);
    const [row] = await database.db.select().from(user).where(eq(user.email, email));
    return { id: row.id, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}
function draft(): MappingDraft {
    const value = emptyMappingDraft();
    value.models = [{ id: "image-2.5", displayName: "Image 2.5", capability: "image", group: "常用图片" }];
    value.specificationOptions.image.push("8K"); value.modelSpecifications["image-2.5"] = ["1K", "2K", "4K", "8K"];
    value.bindings = [{ providerId: "mapping-channel", providerModel: "image-2-5-4k", modelId: "image-2.5", specification: "4K" }];
    value.prices[mappingSpecKey("image-2.5", "4K")] = "12"; return value;
}
const input = (expectedVersion: number, value = draft(), revision: number | null = 1) => ({ expectedVersion, draft: value, providers: [{ providerId: "mapping-channel", revision }] });
beforeAll(async () => {
    database = await createTestDatabase();
    app = createApp(createAccountApi({ database: database.db, origin, auth: { secret, sendVerificationEmail: async mail => { mails.push(mail); }, sendResetPassword: async () => {} },
        rates: createRateStore(database.pool, secret), verifyHuman: async () => true, onFault: () => {} }), "mapping-test-key");
    admin = await signup("mapping-admin@example.test"); regular = await signup("mapping-user@example.test");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    const [current] = await database.db.select().from(session).where(eq(session.userId, admin.id));
    actor = { actorId: admin.id, sessionId: current.id, sessionExpiresAt: current.expiresAt, requestId: "mapping-isolated" };
    await database.db.insert(modelProvider).values({ id: "mapping-channel", displayName: "模拟图片渠道", adapter: "openai-compatible", endpoint: "https://example.test/v1", secretRef: "isolated-only", enabled: true });
    await database.db.insert(providerDiscoveredModel).values({ providerId: "mapping-channel", providerModel: "image-2-5-4k" });
}, 30_000);
afterAll(async () => { await database?.close(); });

test("mapping API enforces authentication, admin, origin, account context and exact body", async () => {
    expect((await request(path, { id: "", cookie: "" })).status).toBe(401);
    expect((await request(path, regular)).status).toBe(403);
    expect((await request(path, admin, "GET", undefined, { "x-canvas-account-id": regular.id })).status).toBe(409);
    expect((await request(path, admin, "GET", undefined, { "x-canvas-account-id": "" })).status).toBe(400);
    expect((await request(path, admin, "PUT", input(0), { origin: "https://other.test" })).status).toBe(403);
    expect((await request(path, admin, "PUT", { ...input(0), apiKey: "reject-extra" })).status).toBe(400);
    expect((await request(path + "?extra=1")).status).toBe(400);
    const response = await request(path); expect(response.status).toBe(200);
    const data = await response.json(); expect(data.catalog.version).toBe(0); expect(data.catalog.draft).toEqual(emptyMappingDraft());
    expect(JSON.stringify(data)).not.toContain("secretRef"); expect(JSON.stringify(data)).not.toContain("endpoint");
});
test("save and repository read recover exact draft without executable model or price writes", async () => {
    const response = await request(path, admin, "PUT", input(0)); expect(response.status).toBe(200);
    expect((await response.json()).saved).toEqual({ version: 1, draft: draft() });
    const reloaded = await readModelMappingDraft(database.db, actor); expect(reloaded.draft).toEqual(draft()); expect(reloaded.version).toBe(1);
    expect(await database.db.select().from(modelCatalog)).toHaveLength(0); expect(await database.db.select().from(modelPricing)).toHaveLength(0);
    expect(await database.db.select().from(auditEvent).where(eq(auditEvent.action, "model.mapping.draft.saved"))).toHaveLength(1);
});
test("two saves from the same version produce one complete winner and one conflict", async () => {
    const a = draft(), b = draft(); a.models[0].displayName = "Winner A"; b.models[0].displayName = "Winner B";
    const results = await Promise.allSettled([saveModelMappingDraft(database.db, input(1, a), actor), saveModelMappingDraft(database.db, input(1, b), actor)]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.find(item => item.status === "rejected")?.reason.code).toBe("mapping_conflict");
    const current = await readModelMappingDraft(database.db, actor);
    expect(current.version).toBe(2); expect([a, b]).toContainEqual(current.draft);
});
test("changed provider revision rejects stale input atomically", async () => {
    await database.db.update(modelProvider).set({ revision: 2 }).where(eq(modelProvider.id, "mapping-channel"));
    const response = await request(path, admin, "PUT", input(2)); expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("mapping_source_changed");
    expect((await readModelMappingDraft(database.db, actor)).version).toBe(2);
});
test("new or changed mapping to an unavailable directory entry is rejected", async () => {
    await database.db.update(providerDiscoveredModel).set({ available: false }).where(eq(providerDiscoveredModel.providerId, "mapping-channel"));
    const changed = draft(); changed.bindings[0].specification = "1K"; changed.prices = {};
    expect((await request(path, admin, "PUT", input(2, changed, 2))).status).toBe(409);
    expect((await request(path, admin, "PUT", input(2, draft(), 2))).status).toBe(200);
    const current = await readModelMappingDraft(database.db, actor); expect(current.version).toBe(3); expect(current.sources[0].available).toBe(false);
});
test("deleted channel keeps only old draft references as unavailable, no new phantom binding", async () => {
    await database.db.update(modelProvider).set({ deletedAt: new Date(), enabled: false, revision: 3 }).where(eq(modelProvider.id, "mapping-channel"));
    const current = await readModelMappingDraft(database.db, actor); expect(current.sources).toHaveLength(0); expect(current.providers).toHaveLength(0);
    expect((await request(path, admin, "PUT", input(3, draft(), null))).status).toBe(200);
    const phantom = draft(); phantom.bindings[0].providerModel = "not-discovered";
    expect((await request(path, admin, "PUT", input(4, phantom, null))).status).toBe(409);
});
test("transaction rechecks revoked administrator before saving", async () => {
    await database.db.update(user).set({ role: "user" }).where(eq(user.id, admin.id));
    await expect(saveModelMappingDraft(database.db, input(4, draft(), null), actor)).rejects.toMatchObject({ code: "account_changed" });
    const [row] = await database.db.select().from(modelMappingDraft); expect(row.version).toBe(4);
});

test("full parameter combinations round trip through API/JSONB with isolated prices and no executable writes", async () => {
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await database.db.update(modelProvider).set({ deletedAt: null, enabled: true, revision: 4 }).where(eq(modelProvider.id, "mapping-channel"));
    await database.db.update(providerDiscoveredModel).set({ available: true }).where(eq(providerDiscoveredModel.providerId, "mapping-channel"));
    const value = draft(); value.prices = {};
    value.bindings = ["1024x1024", "1024x1536"].map(size => ({ ...value.bindings[0], specification: "1K", execution: { protocol: "openai-image-v1", parameters: { size, quality: "high" } } }));
    for (const [index, binding] of value.bindings.entries()) value.prices[mappingCombinationKey(binding)] = String(6 + index);
    const response = await request(path, admin, "PUT", input(4, value, 4)); expect(response.status).toBe(200);
    const read = await request(path); expect(read.status).toBe(200); expect((await read.json()).catalog.draft).toEqual(value);
    expect(await database.db.select().from(modelCatalog)).toHaveLength(0); expect(await database.db.select().from(modelPricing)).toHaveLength(0);
    await database.db.update(providerDiscoveredModel).set({ available: false }).where(eq(providerDiscoveredModel.providerId, "mapping-channel"));
    expect((await request(path, admin, "PUT", input(5, value, 4))).status).toBe(200);
    const changed = structuredClone(value); changed.bindings[0].execution!.parameters = { size: "2048x2048", quality: "high" }; changed.prices = {};
    expect((await request(path, admin, "PUT", input(6, changed, 4))).status).toBe(409);
    expect((await readModelMappingDraft(database.db, actor)).draft).toEqual(value);
});

test("draft execution rejects a channel transport mismatch and incomplete fields before any write", async () => {
    const { draft: value, version } = await readModelMappingDraft(database.db, actor);
    await database.db.update(modelProvider).set({ adapter: "sub2api", revision: 5 }).where(eq(modelProvider.id, "mapping-channel"));
    expect((await request(path, admin, "PUT", input(version, value, 5))).status).toBe(400);
    const invalid = structuredClone(value); invalid.bindings[0].execution = { protocol: "openai-image-v1", parameters: { quality: "high" } } as never; invalid.prices = {};
    expect((await request(path, admin, "PUT", input(version, invalid, 5))).status).toBe(400);
    expect((await readModelMappingDraft(database.db, actor)).version).toBe(version);
});
