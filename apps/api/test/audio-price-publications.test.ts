import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executableAudioDraftCredits, parseModelPriceDraftWrite, publishedDraftPrice, type ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { createModelPriceDraft, listModelPriceDrafts } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { listPublicModelPricing } from "@infinite-canvas/database/pricing";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, user, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE !== "audio-generation") {
    throw new Error("Use isolated PGlite or test:postgres --audio-generation only");
}
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const actorId = `audio-pricing-admin-${crypto.randomUUID()}`, authSecret = `audio-pricing-synthetic-${crypto.randomUUID()}`;
const audit = () => ({ actorId, requestId: crypto.randomUUID() });
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: actorId, name: "Synthetic audio pricing", email: `${actorId}@example.test`, role: "admin" });
}, 30_000);
afterAll(async () => { await database?.close(); });

async function seed(): Promise<ModelPriceDraftWrite> {
    const modelId = `audio-price-${crypto.randomUUID()}`, providerId = `audio-channel-${crypto.randomUUID()}`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic Speech channel", adapter: "openai-compatible", endpoint: "https://speech.example.test/v1", secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, authSecret, providerId, "synthetic-audio-test-key");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: "gpt-4o-mini-tts", displayName: "Synthetic Speech", capability: "audio", enabled: true });
    return { modelId, expectedVersion: 0, binding: { providerId, providerModel: "gpt-4o-mini-tts", adapter: "openai-compatible", endpoint: "https://speech.example.test/v1", capability: "audio" },
        rules: { schemaVersion: 1, cost: null, sale: { template: "audio_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } }, priceNote: "Private cost remains unknown" };
}
async function saveAndPublish(input: ModelPriceDraftWrite) {
    const saved = await createModelPriceDraft(database.db, input, audit());
    if (saved.status !== "saved") throw new Error(saved.status);
    const publicationInput = { modelId: input.modelId, draftId: saved.draft.id, expectedDraftVersion: saved.draft.version, expectedPriceVersion: 0,
        binding: input.binding, publicPriceNote: "Fixed platform price per successful delivered speech" };
    const published = await publishModelPriceDraft(database.db, publicationInput, audit());
    if (published.status !== "published") throw new Error(published.status);
    return { saved: saved.draft, published: published.publication, publicationInput };
}

test("audio sale uses an explicit positive integer request price and never invents provider cost", () => {
    const input: ModelPriceDraftWrite = { modelId: "synthetic-speech", expectedVersion: 0,
        binding: { providerId: "synthetic-provider", providerModel: "gpt-4o-mini-tts", adapter: "openai-compatible", endpoint: "https://speech.example.test/v1", capability: "audio" },
        rules: { schemaVersion: 1, cost: null, sale: { template: "audio_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } }, priceNote: "" };
    expect(parseModelPriceDraftWrite(input)).toEqual(input);
    expect(executableAudioDraftCredits(input.binding, input.rules)).toBe(7);
    expect(publishedDraftPrice(input.binding, input.rules)).toEqual({ billingUnit: "request", creditsPerUnit: 7 });
    for (const amount of ["0", "0.1", "9007199254740992"]) {
        const invalid = structuredClone(input); invalid.rules.sale.bands[0].rates.request = amount;
        expect(publishedDraftPrice(invalid.binding, invalid.rules)).toBeNull();
    }
    expect(publishedDraftPrice({ ...input.binding, adapter: "sub2api" }, input.rules)).toBeNull();
    const music = structuredClone(input); music.rules.sale.bands[0].parameters = { durationSeconds: "5" };
    expect(parseModelPriceDraftWrite(music)).toBeNull();
    const wrongTemplate = structuredClone(input); wrongTemplate.rules.sale.template = "image_request";
    expect(parseModelPriceDraftWrite(wrongTemplate)).toBeNull();
});

test("audio drafts appear in the shared catalog and immutable publication is idempotent without wallet writes", async () => {
    const input = await seed(), before = { ledger: await database.db.select().from(walletLedger), reservations: await database.db.select().from(walletReservation) };
    const { saved, published, publicationInput } = await saveAndPublish(input);
    expect(saved.bindingMatchesCurrent).toBe(true);
    expect(saved.rules.cost).toBeNull();
    expect((await listModelPriceDrafts(database.db)).models.find(row => row.modelId === input.modelId)?.binding.capability).toBe("audio");
    expect(published).toMatchObject({ binding: input.binding, billingUnit: "request", creditsPerUnit: 7, priceVersion: 1 });
    expect(await publishModelPriceDraft(database.db, publicationInput, audit())).toMatchObject({ status: "published", publication: { id: published.id } });
    expect((await listPublicModelPricing(database.db)).find(row => row.modelId === input.modelId)).toMatchObject({ capability: "audio", billingUnit: "request", creditsPerUnit: 7 });
    expect({ ledger: await database.db.select().from(walletLedger), reservations: await database.db.select().from(walletReservation) }).toEqual(before);
    await expect(database.db.update(modelPriceDraft).set({ priceNote: "overwrite" }).where(eq(modelPriceDraft.id, saved.id)).execute()).rejects.toThrow();
});

test("audio task is bound to its immutable request publication and changed provider binding is rejected", async () => {
    const input = await seed(), { published } = await saveAndPublish(input);
    const task = (await createGenerationTaskRepository(database.db).create({ ownerId: actorId, modelId: input.modelId,
        inputSnapshot: { text: "  Synthetic speech text  " }, parameterSnapshot: { voice: "alloy", format: "mp3", style: "calm", language: "中文" },
        idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(), priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7 })).task;
    expect(task.pricePublicationId).toBe(published.id);
    expect(await validatePublishedGenerationTask(database.db, task, input.binding)).toBe(true);
    expect(await validatePublishedGenerationTask(database.db, { ...task, pricePublicationId: null }, input.binding)).toBe(false);
    expect(await validatePublishedGenerationTask(database.db, { ...task, quotedUnits: 1 }, input.binding)).toBe(false);
    await database.db.update(modelProvider).set({ endpoint: "https://changed.example.test/v1" }).where(eq(modelProvider.id, input.binding.providerId));
    const changed = { ...input.binding, endpoint: "https://changed.example.test/v1" };
    expect(await validatePublishedGenerationTask(database.db, task, changed)).toBe(false);
    expect((await listPublicModelPricing(database.db)).some(row => row.modelId === input.modelId)).toBe(false);
});

test("audio legacy prices cannot bypass the published fixed-price contract", async () => {
    const input = await seed();
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: input.modelId, version: 1, billingUnit: "request", creditsPerUnit: 7, enabled: true, effectiveFrom: new Date() });
    expect((await listPublicModelPricing(database.db)).some(row => row.modelId === input.modelId)).toBe(false);
    expect(await validatePublishedGenerationTask(database.db, { modelId: input.modelId, priceVersion: 1, pricePublicationId: null,
        billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7, quotedUnits: 7 }, input.binding)).toBe(false);
});

test("database publication guard rejects forged audio units, extra meters and malformed source rates", async () => {
    for (const change of [
        (input: ModelPriceDraftWrite) => { input.rules.sale.bands[0].rates.request = "7.5"; },
        (input: ModelPriceDraftWrite) => { input.rules.sale.bands[0].rates.second = "7"; },
        (input: ModelPriceDraftWrite) => { (input.rules.sale.bands[0].rates as Record<string, unknown>).request = 7; },
        (input: ModelPriceDraftWrite) => { input.rules.sale.template = "video_count"; },
    ]) {
        const input = await seed(); change(input);
        await expect(database.db.transaction(async tx => {
            const draftId = crypto.randomUUID(), pricingId = crypto.randomUUID();
            await tx.insert(modelPriceDraft).values({ id: draftId, modelId: input.modelId, version: 1, rules: input.rules, priceNote: "",
                providerIdSnapshot: input.binding.providerId, providerModelSnapshot: input.binding.providerModel, adapterSnapshot: input.binding.adapter, endpointSnapshot: input.binding.endpoint, capabilitySnapshot: "audio" });
            await tx.insert(modelPricing).values({ id: pricingId, modelId: input.modelId, version: 1, billingUnit: "request", creditsPerUnit: 7, enabled: true, effectiveFrom: new Date() });
            await tx.insert(modelPricePublication).values({ id: crypto.randomUUID(), pricingId, draftId, publicPriceNote: "" });
        })).rejects.toThrow();
    }
});
