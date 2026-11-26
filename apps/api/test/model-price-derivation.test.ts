import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deriveModelPriceRules, type AdminModelPriceDraft, type ModelPriceDerivation, type ModelPriceDraftWrite, type ModelPriceRule, type OfficialPriceEntry, type PricingCapability } from "@infinite-canvas/shared";
import { createModelPriceDraft, modelPriceDraftView } from "@infinite-canvas/database/model-price-drafts";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { auditEvent, generationTask, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential, officialPriceSource, officialPriceMapping, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Only in-memory PGlite is permitted");
const origin = "http://localhost:4045", path = "/api/v1/admin/model-price-drafts", publicationPath = "/api/v1/admin/model-price-publications";
const secret = "synthetic-derivation-" + crypto.randomUUID(), stamp = "2026-10-25T00:00:00.000Z";
type Identity = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>, app: ReturnType<typeof createApp>, admin: Identity, reader: Identity;
let queueCalls = 0;

function request(url = path, identity = admin, method = "GET", body?: unknown) {
    return app(new Request(origin + url, { method, headers: { origin, cookie: identity.cookie, "x-canvas-account-id": identity.id, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "198.51.100.45");
}
async function register(label: string): Promise<Identity> {
    const email = `derivation-${label}@example.test`, password = "synthetic-derivation-password";
    expect((await request("/api/auth/sign-up/email", { id: "", cookie: "" }, "POST", { email, password, name: label })).status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row.id));
    const login = await request("/api/auth/sign-in/email", { id: "", cookie: "" }, "POST", { email, password });
    expect(login.status).toBe(200);
    return { id: row.id, cookie: login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}
const textBasis = (): ModelPriceRule => ({ template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "8" } }] });
async function seed(label: string, capability: PricingCapability = "text"): Promise<ModelPriceDraftWrite> {
    const providerId = `derivation-provider-${label}`, modelId = `derivation-model-${label}`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic derivation channel", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", secretRef: "synthetic-private-derivation-reference", enabled: true });
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "synthetic-private-derivation-ciphertext", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: `upstream-${capability}`, displayName: `Synthetic ${label}`, capability, enabled: true });
    return { modelId, expectedVersion: 0, binding: { providerId, providerModel: `upstream-${capability}`, adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability },
        rules: { schemaVersion: 1, cost: textBasis(), sale: { ...textBasis(), currency: "credit" } }, priceNote: "private derivation note" };
}
function derived(input: ModelPriceDraftWrite, basis = textBasis(), source: ModelPriceDerivation["source"] = { kind: "custom" }): ModelPriceDraftWrite {
    const derivation: ModelPriceDerivation = { schemaVersion: 1, kind: "multiplier", binding: { ...input.binding }, basis,
        costMultiplier: "0.3", saleMultiplier: "0.6", creditsPerCurrency: "10", source };
    const rules = deriveModelPriceRules(derivation);
    if (!rules) throw new Error("Invalid synthetic derivation");
    return { ...input, rules: { ...rules, derivation } };
}
function changeMultiplier(input: ModelPriceDraftWrite, expectedVersion: number): ModelPriceDraftWrite {
    const derivation = structuredClone(input.rules.derivation!); derivation.saleMultiplier = "0.7";
    return { ...input, expectedVersion, rules: { ...deriveModelPriceRules(derivation)!, derivation } };
}
async function save(input: ModelPriceDraftWrite): Promise<AdminModelPriceDraft> {
    const response = await request(path, admin, "POST", input);
    expect(response.status).toBe(201);
    return (await response.json()).draft;
}
const draftsAndAudits = () => Promise.all([database.db.select().from(modelPriceDraft), database.db.select().from(auditEvent)]);

test("three-bucket model mapping is mandatory even for legacy note-only continuations, without rereading refreshed base prices", async () => {
    const input = await seed("three-mapping"), value: OfficialPriceEntry = { id: "openai:three-mapping", modelName: "Synthetic triple", context: "Synthetic standard",
        rates: [{ label: "Input", usdPerMillion: "2" }, { label: "Cache", usdPerMillion: "0.2" }, { label: "Output", usdPerMillion: "10" }] };
    await setOfficial(value);
    const derivation: ModelPriceDerivation = { schemaVersion: 1, kind: "multiplier", binding: input.binding, costMultiplier: null, saleMultiplier: "0.36", creditsPerCurrency: "100",
        basis: { template: "text_cached_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.2", output_token: "10" } }] },
        source: { kind: "official", sourceId: "openai", version: 1, checkedAt: stamp, entry: value, application: "fixed_baseline", mapping: { Input: "input_token", Cache: "cached_input_token", Output: "output_token" } } };
    input.rules = { ...deriveModelPriceRules(derivation)!, derivation };
    expect((await request(path, reader, "POST", input)).status).toBe(403);
    expect((await request(path, admin, "POST", input)).status).toBe(409);
    // A pre-upgrade stored official draft had source authentication but no model-mapping gate.
    await database.db.insert(modelPriceDraft).values({ id: crypto.randomUUID(), modelId: input.modelId, version: 1, rules: input.rules, priceNote: input.priceNote,
        providerIdSnapshot: input.binding.providerId, providerModelSnapshot: input.binding.providerModel, adapterSnapshot: input.binding.adapter,
        endpointSnapshot: input.binding.endpoint, capabilitySnapshot: "text" });
    const continuation = { ...input, expectedVersion: 1, priceNote: "only a note" }, before = await draftsAndAudits();
    expect((await request(path, admin, "POST", continuation)).status).toBe(409);
    expect(await draftsAndAudits()).toEqual(before);
    await database.db.insert(officialPriceMapping).values({ modelId: input.modelId, referenceId: value.id, version: 1,
        providerIdSnapshot: input.binding.providerId, providerModelSnapshot: "wrong-model", adapterSnapshot: input.binding.adapter,
        endpointSnapshot: input.binding.endpoint, capabilitySnapshot: "text" });
    expect((await request(path, admin, "POST", continuation)).status).toBe(409);
    await database.db.update(officialPriceMapping).set({ providerModelSnapshot: input.binding.providerModel }).where(eq(officialPriceMapping.modelId, input.modelId));
    await setOfficial(entry("3"), 2, "2026-10-29T00:00:00.000Z");
    const saved = await save(continuation);
    expect(saved.rules.derivation).toEqual(derivation); expect(saved.rules.cost).toBeNull();
    expect(saved.rules.sale.bands[0].rates).toEqual({ input_token: "72", cached_input_token: "7.2", output_token: "360" });
    expect((await request(path, admin, "POST", changeMultiplier(input, 2))).status).toBe(409);
});
const money = () => Promise.all([database.db.select().from(wallet), database.db.select().from(walletLedger), database.db.select().from(walletReservation), database.db.select().from(generationTask)]);
const entry = (amount = "2"): OfficialPriceEntry => ({ id: "openai:synthetic-derivation", modelName: "Synthetic official baseline", context: "Standard fixture; not a real official rate", rates: [{ label: "普通输入", usdPerMillion: amount }, { label: "输出", usdPerMillion: "8" }] });
function officialSource(value = entry(), version = 1, checkedAt = stamp): ModelPriceDerivation["source"] {
    return { kind: "official", sourceId: "openai", version, checkedAt, entry: value, mapping: { 普通输入: "input_token", 输出: "output_token" }, application: "fixed_baseline" };
}
async function setOfficial(value = entry(), version = 1, checkedAt = stamp) {
    await database.db.insert(officialPriceSource).values({ id: "openai", version, checkedAt: new Date(checkedAt), status: "ready", entries: [value] })
        .onConflictDoUpdate({ target: officialPriceSource.id, set: { version, checkedAt: new Date(checkedAt), status: "ready", entries: [value] } });
}
async function publish(saved: AdminModelPriceDraft) {
    return request(publicationPath, admin, "POST", { modelId: saved.modelId, draftId: saved.id, expectedDraftVersion: saved.version, expectedPriceVersion: 0, binding: saved.binding, publicPriceNote: "public synthetic price" });
}

beforeAll(async () => {
    database = await createTestDatabase();
    const rates = createRateStore(database.pool, secret);
    app = createApp(createAccountApi({ database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) { return bucket === "account-read" || bucket === "canvas-save" ? { allowed: true } : rates.consume(bucket, identity, rule); } },
        generation: { enabled: false, queue: { async send() { queueCalls++; throw new Error("Draft derivation must not generate"); } } },
        verifyHuman: async () => true, onFault: () => undefined }), "synthetic-derivation-site");
    admin = await register("admin"); reader = await register("reader");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
});
afterAll(async () => { await database?.close(); });

test("custom multiplier rules save a private immutable snapshot and publish through the existing dual-rate path", async () => {
    const input = derived(await seed("custom")), before = await money();
    expect((await request(path, reader, "POST", input)).status).toBe(403);
    const saved = await save(input);
    expect(saved.rules.derivation).toEqual(input.rules.derivation);
    expect(saved.rules.cost?.bands[0].rates).toEqual({ input_token: "0.6", output_token: "2.4" });
    expect(saved.rules.sale.bands[0].rates).toEqual({ input_token: "12", output_token: "48" });
    expect(await database.db.select().from(modelPricePublication)).toHaveLength(0);
    expect(await database.db.select().from(modelPricing)).toHaveLength(0);
    const response = await publish(saved);
    expect(response.status).toBe(200);
    const publication = (await response.json()).publication;
    expect(publication.rules.derivation).toEqual(input.rules.derivation);
    const publicResponse = await (await request("/api/v1/model-pricing", reader)).json();
    const visible = publicResponse.items.find((item: { modelId: string }) => item.modelId === input.modelId);
    expect(visible).toMatchObject({ billingUnit: "text_tokens", inputCreditsPerMillion: "12", outputCreditsPerMillion: "48" });
    expect(JSON.stringify(publicResponse)).not.toContain('"derivation":');
    expect(JSON.stringify(publicResponse)).not.toContain("private derivation note");
    expect(JSON.stringify(publicResponse)).not.toContain("costMultiplier");
    expect(await money()).toEqual(before);
    expect(queueCalls).toBe(0);
});

test("altered generated rates and a different binding cannot save a claimed derivation", async () => {
    const input = derived(await seed("tampered")), before = await draftsAndAudits();
    const changed = structuredClone(input); changed.rules.sale.bands[0].rates.input_token = "13";
    expect((await request(path, admin, "POST", changed)).status).toBe(400);
    const direct = await createModelPriceDraft(database.db, changed, { actorId: admin.id, requestId: "synthetic-direct-invalid" });
    expect(direct.status).toBe("invalid_derivation");
    const wrongBinding = structuredClone(input); wrongBinding.rules.derivation!.binding.providerModel = "another-model";
    const bindingReply = await request(path, admin, "POST", wrongBinding);
    expect(bindingReply.status).toBe(400);
    expect((await bindingReply.json()).error.code).toBe("invalid_input");
    expect((await createModelPriceDraft(database.db, wrongBinding, { actorId: admin.id, requestId: "synthetic-direct-binding" })).status).toBe("invalid_derivation");
    expect(await draftsAndAudits()).toEqual(before);
});

test("official changes block new derivations while original publication and note-only continuations retain their snapshot", async () => {
    await setOfficial();
    const input = derived(await seed("official"), textBasis(), officialSource()), saved = await save(input), beforeMoney = await money();
    const before = await draftsAndAudits();
    await setOfficial(entry("3"), 2, "2026-10-25T06:00:00.000Z");
    const stale = await request(path, admin, "POST", changeMultiplier(input, 1));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("price_derivation_source_changed");
    expect(await draftsAndAudits()).toEqual(before);
    const oldPublication = await publish(saved);
    expect(oldPublication.status).toBe(200);
    expect((await oldPublication.json()).publication).toMatchObject({ inputCreditsPerMillion: "12", outputCreditsPerMillion: "48", rules: { derivation: input.rules.derivation } });
    const continued = await save({ ...input, expectedVersion: 1, priceNote: "only revised internal explanation" });
    expect(continued.version).toBe(2);
    expect(continued.rules).toEqual(saved.rules);
    expect(continued.priceNote).toBe("only revised internal explanation");
    const list = await (await request()).json();
    expect(list.items.find((item: AdminModelPriceDraft) => item.id === continued.id).rules.derivation).toEqual(input.rules.derivation);
    const stillPublished = await (await request(`${publicationPath}?modelId=${input.modelId}`)).json();
    expect(stillPublished.preview.currentPrice).toMatchObject({ version: 1, inputCreditsPerMillion: "12", outputCreditsPerMillion: "48" });
    expect(await money()).toEqual(beforeMoney);
});

test("client-crafted official prices with the right version are not accepted as verified source data", async () => {
    await setOfficial();
    const model = await seed("forged-official"), fake = entry("0.001");
    const fakeBasis = textBasis(); fakeBasis.bands[0].rates.input_token = "0.001";
    const input = derived(model, fakeBasis, officialSource(fake)), before = await draftsAndAudits();
    const forged = await request(path, admin, "POST", input);
    expect(forged.status).toBe(409);
    expect((await forged.json()).error.code).toBe("price_derivation_source_changed");
    const samePriceWrongContext = derived(model, textBasis(), officialSource({ ...entry(), context: "forged applicability" }));
    expect((await request(path, admin, "POST", samePriceWrongContext)).status).toBe(409);
    expect(await draftsAndAudits()).toEqual(before);
});

test("a later official check invalidates a pending source snapshot even when its price version did not change", async () => {
    await setOfficial();
    const input = derived(await seed("checked-time"), textBasis(), officialSource()), before = await draftsAndAudits();
    await setOfficial(entry(), 1, "2026-10-25T06:00:00.000Z");
    const stale = await request(path, admin, "POST", input);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("price_derivation_source_changed");
    expect(await draftsAndAudits()).toEqual(before);
});

test("saved-cost derivation preserves every specification band and only accepts the current same-model cost snapshot", async () => {
    const input = await seed("saved-cost", "image");
    const cost: ModelPriceRule = { template: "image_count", currency: "CNY", bands: [
        { parameters: { size: "1K", quality: "standard" }, rates: { image: "0.2" } },
        { parameters: { size: "2K", quality: "standard" }, rates: { image: "0.4" } },
    ] };
    input.rules = { schemaVersion: 1, cost, sale: { ...cost, currency: "credit" } };
    const first = await save(input);
    const next = derived({ ...input, expectedVersion: 1 }, cost, { kind: "saved_cost", draftId: first.id, draftVersion: first.version });
    const second = await save(next);
    expect(second.rules.sale.bands).toEqual([
        { parameters: { size: "1K", quality: "standard" }, rates: { image: "1.2" } },
        { parameters: { size: "2K", quality: "standard" }, rates: { image: "2.4" } },
    ]);
    const beforeMoney = await money();
    const continued = await save({ ...next, expectedVersion: 2, priceNote: "note edit preserves all multiplier evidence" });
    expect(continued.version).toBe(3);
    expect(continued.rules).toEqual(second.rules);
    expect(continued.priceNote).toBe("note edit preserves all multiplier evidence");
    expect(await money()).toEqual(beforeMoney);
    const before = await draftsAndAudits();
    const stale = await request(path, admin, "POST", changeMultiplier(next, 3));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("price_derivation_source_changed");
    expect(await draftsAndAudits()).toEqual(before);
    const blocked = await publish(continued);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("unsupported_price_rule");
    const original = (await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.id, first.id)))[0];
    expect(original.rules).toEqual(input.rules);
});

test("readback rejects a derivation whose binding disagrees with the immutable draft row", async () => {
    const input = derived(await seed("readback")), saved = await save(input);
    const [row] = await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.id, saved.id));
    expect(() => modelPriceDraftView({ ...row, providerModelSnapshot: "another-upstream" }, input.modelId, input.binding)).toThrow("Invalid stored model price draft rules");
    expect(modelPriceDraftView(row, input.modelId, input.binding).rules).toEqual(saved.rules);
});

test("a source draft from another model or a modified saved basis fails without allocating a draft or audit", async () => {
    const owner = await seed("source-owner"), original = await save(owner), target = await seed("source-target");
    const foreign = derived(target, textBasis(), { kind: "saved_cost", draftId: original.id, draftVersion: original.version });
    const before = await draftsAndAudits();
    expect((await request(path, admin, "POST", foreign)).status).toBe(409);
    const alteredBasis = textBasis(); alteredBasis.bands[0].rates.input_token = "0.1";
    const altered = derived({ ...owner, expectedVersion: 1 }, alteredBasis, { kind: "saved_cost", draftId: original.id, draftVersion: original.version });
    expect((await request(path, admin, "POST", altered)).status).toBe(409);
    expect(await draftsAndAudits()).toEqual(before);
});
