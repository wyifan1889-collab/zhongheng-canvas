import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { AdminModelPriceDraft, ModelPriceDraftWrite, ModelPricePublishWrite } from "@infinite-canvas/shared";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { getModelPricePublicationPreview, publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { listAdminModelPricing, listPublicModelPricing, resolveActiveGenerationPricing } from "@infinite-canvas/database/pricing";
import { auditEvent, generationTask, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing,
    modelProvider, modelProviderCredential, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("This suite requires isolated in-memory PGlite");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const actorId = "synthetic-text-price-admin";
const audit = () => ({ actorId, requestId: crypto.randomUUID() });
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: actorId, name: "Synthetic admin", email: "text-price@example.test", role: "admin" });
    await database.db.insert(wallet).values({ userId: actorId, availableUnits: "0.004" });
});
afterAll(async () => { await database?.close(); });

async function seed(): Promise<ModelPriceDraftWrite> {
    const modelId = crypto.randomUUID(), providerId = crypto.randomUUID();
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic provider", adapter: "openai-compatible",
        endpoint: "https://provider.invalid/v1", secretRef: "synthetic-private-reference", enabled: true });
    // Presence only. No credential is read/decrypted, and no provider is called.
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "synthetic", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, displayName: "Synthetic text", providerId,
        providerModel: "synthetic-text", capability: "text", enabled: true });
    return { modelId, expectedVersion: 0, binding: { providerId, providerModel: "synthetic-text", adapter: "openai-compatible",
        endpoint: "https://provider.invalid/v1", capability: "text" }, priceNote: "Private supplier agreement",
        rules: { schemaVersion: 1, cost: { template: "text_tokens", currency: "USD", bands: [{ parameters: {},
            rates: { input_token: null, output_token: "0" } }] }, sale: { template: "text_tokens", currency: "credit",
            bands: [{ parameters: {}, rates: { input_token: "0.0000000000000000001", output_token: "3.125" } }] } } };
}
async function save(input: ModelPriceDraftWrite) {
    const result = await createModelPriceDraft(database.db, input, audit());
    if (result.status !== "saved") throw new Error("Synthetic draft setup failed");
    return result.draft;
}
function body(draft: AdminModelPriceDraft, expectedPriceVersion = 0): ModelPricePublishWrite {
    return { modelId: draft.modelId, draftId: draft.id, expectedDraftVersion: draft.version, expectedPriceVersion,
        binding: draft.binding, publicPriceNote: "输入和输出分别按百万 Token 计价；当前只登记价格" };
}
async function publish(input: ModelPricePublishWrite) {
    const result = await publishModelPriceDraft(database.db, input, audit());
    if (result.status !== "published") throw new Error(`Synthetic publication failed: ${result.status}`);
    return result.publication;
}
const prices = () => Promise.all([database.db.select().from(modelPricing), database.db.select().from(modelPricePublication), database.db.select().from(auditEvent)]);
const business = () => Promise.all([database.db.select().from(wallet), database.db.select().from(walletLedger),
    database.db.select().from(walletReservation), database.db.select().from(generationTask)]);

test("text versions share the legacy sequence, retain exact dual rates and never read an unpublished newer draft", async () => {
    const input = await seed(), beforeBusiness = await business();
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: input.modelId, version: 1,
        billingUnit: "output_token", creditsPerUnit: 2, effectiveFrom: new Date(0), enabled: true });
    const firstDraft = await save(input), first = await publish(body(firstDraft, 1));
    expect(first).toMatchObject({ priceVersion: 2, billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: "0.0000000000000000001", outputCreditsPerMillion: "3.125", rules: input.rules });
    const once = await prices();
    expect(await publish(body(firstDraft, 1))).toEqual(first);
    expect(await prices()).toEqual(once);
    expect((await publishModelPriceDraft(database.db, { ...body(firstDraft, 2), publicPriceNote: "changed intent" }, audit())).status).toBe("price_publication_conflict");
    const next = structuredClone(input); next.expectedVersion = 1;
    next.rules.sale.bands[0]!.rates = { input_token: "1.25", output_token: "6.5" };
    const secondDraft = await save(next);
    const preview = await getModelPricePublicationPreview(database.db, input.modelId);
    expect(preview).toMatchObject({ draft: { id: secondDraft.id, version: 2 }, latestPriceVersion: 2, publication: null,
        currentPrice: { version: 2, billingUnit: "text_tokens", creditsPerUnit: null,
            inputCreditsPerMillion: "0.0000000000000000001", outputCreditsPerMillion: "3.125" } });
    expect((await publishModelPriceDraft(database.db, body(firstDraft, 2), audit())).status).toBe("price_draft_conflict");
    expect((await publishModelPriceDraft(database.db, body(secondDraft, 1), audit())).status).toBe("price_publication_conflict");
    const second = await publish(body(secondDraft, 2));
    expect(second).toMatchObject({ priceVersion: 3, draftVersion: 2, inputCreditsPerMillion: "1.25", outputCreditsPerMillion: "6.5" });
    const history = (await listAdminModelPricing(database.db)).filter((row) => row.modelId === input.modelId);
    expect(history.map((row) => ({ version: row.version, enabled: row.enabled }))).toEqual([
        { version: 1, enabled: false }, { version: 2, enabled: false }, { version: 3, enabled: true }]);
    expect(history[1]).toMatchObject({ inputCreditsPerMillion: "0.0000000000000000001", outputCreditsPerMillion: "3.125" });
    expect(await business()).toEqual(beforeBusiness);
});

test("binding changes hide public prices while immutable text history stays readable", async () => {
    const input = await seed(), draft = await save(input), publication = await publish(body(draft));
    expect((await listPublicModelPricing(database.db)).find((row) => row.modelId === input.modelId)).toMatchObject({
        billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: "0.0000000000000000001" });
    await database.db.update(modelCatalog).set({ capability: "image", providerModel: "changed-image" }).where(eq(modelCatalog.id, input.modelId));
    expect((await listPublicModelPricing(database.db)).some((row) => row.modelId === input.modelId)).toBe(false);
    expect((await getModelPricePublicationPreview(database.db, input.modelId))?.publication).toMatchObject({
        id: publication.id, billingUnit: "text_tokens", bindingMatchesCurrent: false });
    expect((await listAdminModelPricing(database.db)).find((row) => row.modelId === input.modelId)).toMatchObject({
        capability: "text", billingUnit: "text_tokens", inputCreditsPerMillion: "0.0000000000000000001" });
    expect((await publishModelPriceDraft(database.db, body(draft, 1), audit())).status).toBe("model_binding_changed");
});

test("text publication cannot fall back to an older active scalar or enter the generation task schema", async () => {
    const input = await seed();
    const legacyId = crypto.randomUUID();
    await database.db.insert(modelPricing).values({ id: legacyId, modelId: input.modelId, version: 1,
        billingUnit: "request", creditsPerUnit: 7, effectiveFrom: new Date(0), enabled: true });
    const draft = await save(input); await publish(body(draft, 1));
    // Even corrupt/manual double-active state must not make the latest text price executable.
    await database.db.update(modelPricing).set({ enabled: true }).where(eq(modelPricing.id, legacyId));
    expect(await resolveActiveGenerationPricing(database.db, { modelId: input.modelId })).toBeNull();
    expect(await resolveActiveGenerationPricing(database.db, { modelId: input.modelId, priceVersion: 2 })).toBeNull();
    expect(await validatePublishedGenerationTask(database.db, { modelId: input.modelId, priceVersion: 2,
        billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7 }, input.binding)).toBe(false);
    const before = await business();
    await expect(database.db.insert(generationTask).values({ id: crypto.randomUUID(), ownerId: actorId, modelId: input.modelId,
        priceVersion: 2, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
        inputSnapshot: { prompt: "synthetic only" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }).execute()).rejects.toThrow();
    expect(await business()).toEqual(before);
});

test("deferred text source linkage rejects orphan prices and immutable publications reject mutation", async () => {
    const input = await seed(), draft = await save(input), before = await prices();
    let statementCompleted = false;
    await expect(database.db.transaction(async (tx) => {
        await tx.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: input.modelId, version: 1,
            billingUnit: "text_tokens", creditsPerUnit: null, effectiveFrom: new Date(), enabled: false });
        statementCompleted = true;
    })).rejects.toThrow();
    expect(statementCompleted).toBe(true);
    expect(await prices()).toEqual(before);
    for (const value of [{ billingUnit: "text_tokens" as const, creditsPerUnit: 1 }, { billingUnit: "request" as const, creditsPerUnit: null }]) {
        await expect(database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: input.modelId, version: 1,
            ...value, effectiveFrom: new Date(), enabled: false }).execute()).rejects.toThrow();
    }
    const published = await publish(body(draft));
    const [price] = await database.db.select().from(modelPricing).where(eq(modelPricing.modelId, input.modelId));
    await expect(database.db.update(modelPricing).set({ billingUnit: "request", creditsPerUnit: 2 }).where(eq(modelPricing.id, price!.id)).execute()).rejects.toThrow();
    await expect(database.db.update(modelPricePublication).set({ publicPriceNote: "rewrite" }).where(eq(modelPricePublication.id, published.id)).execute()).rejects.toThrow();
    await expect(database.db.delete(modelPriceDraft).where(eq(modelPriceDraft.id, draft.id)).execute()).rejects.toThrow();
    await expect(database.db.delete(modelPricePublication).where(eq(modelPricePublication.id, published.id)).execute()).rejects.toThrow();
});

test("SQL publication guards reject malformed, zero and extra text meters without scalar approximation", async () => {
    const input = await seed(), valid = input.rules;
    const legacyRates = [
        { input_token: "0", output_token: "2" }, { input_token: "1e-7", output_token: "2" },
        { input_token: null, output_token: "2" }, { input_token: 1, output_token: "2" },
        { input_token: "0.1", output_token: "2", request: "1" }, { input_token: "0.1" },
        { input_token: "0.1", output_token: "2", cached_input_token: "0.02" },
    ];
    const cachedRates = [
        { input_token: "0.1", output_token: "2" },
        { input_token: "0.1", cached_input_token: "0", output_token: "2" },
        { input_token: "0.1", cached_input_token: null, output_token: "2" },
        { input_token: "0.1", cached_input_token: 1, output_token: "2" },
        { input_token: "0.1", cached_input_token: "1e-7", output_token: "2" },
        { input_token: "0.1", cached_input_token: "0.02", output_token: "2", request: "1" },
    ];
    for (const [template, rates] of [
        ...legacyRates.map(rates => ["text_tokens", rates] as const),
        ...cachedRates.map(rates => ["text_cached_tokens", rates] as const),
    ]) {
        const before = await prices();
        await expect(database.db.transaction(async (tx) => {
            const draftId = crypto.randomUUID(), priceId = crypto.randomUUID();
            const rules = { ...valid, sale: { ...valid.sale, template, bands: [{ parameters: {}, rates }] } };
            await tx.execute(sql`INSERT INTO canvas_saas.model_price_draft
                (id,model_id,version,rules,price_note,provider_id_snapshot,provider_model_snapshot,adapter_snapshot,endpoint_snapshot,capability_snapshot)
                VALUES (${draftId},${input.modelId},1,${JSON.stringify(rules)}::jsonb,'private',${input.binding.providerId},
                ${input.binding.providerModel},'openai-compatible',${input.binding.endpoint},'text')`);
            await tx.insert(modelPricing).values({ id: priceId, modelId: input.modelId, version: 1,
                billingUnit: "text_tokens", creditsPerUnit: null, effectiveFrom: new Date(), enabled: true });
            await tx.insert(modelPricePublication).values({ id: crypto.randomUUID(), draftId, pricingId: priceId, publicPriceNote: "public" });
        })).rejects.toThrow();
        expect(await prices()).toEqual(before);
    }
    expect(await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, input.modelId))).toEqual([]);
});

test("failed publication audit atomically restores the enabled price and leaves no new source", async () => {
    const input = await seed(), firstDraft = await save(input); await publish(body(firstDraft));
    input.expectedVersion = 1; input.rules.sale.bands[0]!.rates.output_token = "4.5";
    const next = await save(input), before = await prices();
    await database.db.execute(sql`CREATE FUNCTION canvas_saas.reject_text_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'model.price.published' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
    await database.db.execute(sql`CREATE TRIGGER reject_text_publication_audit BEFORE INSERT ON canvas_saas.audit_event FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_text_publication_audit()`);
    try {
        await expect(publishModelPriceDraft(database.db, body(next, 1), audit())).rejects.toThrow();
        expect(await prices()).toEqual(before);
    } finally {
        await database.db.execute(sql`DROP TRIGGER reject_text_publication_audit ON canvas_saas.audit_event`);
        await database.db.execute(sql`DROP FUNCTION canvas_saas.reject_text_publication_audit()`);
    }
    expect(await database.db.select().from(modelPricing).where(and(eq(modelPricing.modelId, input.modelId), eq(modelPricing.enabled, true)))).toHaveLength(1);
});
