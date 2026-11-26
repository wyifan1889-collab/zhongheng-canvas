import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { type ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters, type VideoQuoteSnapshot } from "../../../packages/shared/src/generation-video";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { getModelPricePublicationPreview, getVideoSpecTaskSnapshot, publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { listPublicModelPricing, listAdminModelPricing, resolveActiveGenerationPricing } from "@infinite-canvas/database/pricing";
import { auditEvent, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, user, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createTestDatabase, postgresTestUrl } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE !== "video-generation") {
    throw new Error("Use isolated PGlite or an explicitly isolated video-generation PostgreSQL runner only");
}
// Validate the native opt-in before any fixture work; the shared helper also
// enforces the loopback host, dedicated canvas_test_app role and canvas_saas_test database.
postgresTestUrl();
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const actorId = `synthetic-video-price-admin-${crypto.randomUUID()}`, secret = `synthetic-video-price-${crypto.randomUUID()}`;
const audit = () => ({ actorId, requestId: crypto.randomUUID() });
const parameters: VideoParameters = { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" };
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: actorId, name: "Synthetic video price", email: `${actorId}@example.test`, role: "admin" });
}, 30_000);
afterAll(async () => { await database?.close(); });
async function seed(): Promise<ModelPriceDraftWrite> {
    const modelId = `video-price-${crypto.randomUUID()}`, providerId = `video-channel-${crypto.randomUUID()}`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic video channel", adapter: "openai-compatible", endpoint: "https://video.example.test/v1", secretRef: "synthetic-only", enabled: true });
    await saveProviderCredential(database.db, secret, providerId, "synthetic-video-credential");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: "administrator-selected-video", displayName: "Synthetic video", capability: "video", enabled: true });
    return { modelId, expectedVersion: 0, binding: { providerId, providerModel: "administrator-selected-video", adapter: "openai-compatible", endpoint: "https://video.example.test/v1", capability: "video" },
        rules: { schemaVersion: 1, video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY }, cost: null,
            sale: { template: "video_count", currency: "credit", bands: [{ parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), rates: { video: "7" } }] } }, priceNote: "Private synthetic cost is unknown" };
}
async function save(input: ModelPriceDraftWrite) {
    const result = await createModelPriceDraft(database.db, input, audit());
    if (result.status !== "saved") throw new Error(result.status);
    return result.draft;
}
async function publish(input: ModelPriceDraftWrite, expectedPriceVersion = 0) {
    const draft = await save(input), body = { modelId: input.modelId, draftId: draft.id, expectedDraftVersion: draft.version,
        expectedPriceVersion, binding: input.binding, publicPriceNote: "Synthetic per-delivered-video price" };
    const result = await publishModelPriceDraft(database.db, body, audit());
    if (result.status !== "published") throw new Error(result.status);
    return { publication: result.publication, body };
}
function task(input: ModelPriceDraftWrite, publicationId: string) {
    const videoQuoteSnapshot: VideoQuoteSnapshot = { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, publicationId, priceVersion: 1,
        selectedBand: { parameters, creditsPerVideo: 7 }, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 7 };
    return { modelId: input.modelId, priceVersion: 1, pricePublicationId: publicationId, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
        quotedUnits: 7, inputSnapshot: { prompt: "synthetic video" }, parameterSnapshot: parameters, textQuoteSnapshot: null, videoQuoteSnapshot };
}

test("video publication keeps the complete protocol and bands and replays once without wallet mutations", async () => {
    const input = await seed(), before = { ledger: await database.db.select().from(walletLedger), reservations: await database.db.select().from(walletReservation) };
    const { publication, body } = await publish(input);
    expect(publication).toMatchObject({ billingUnit: "video_specs", creditsPerUnit: null, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY,
        videoSpecs: [{ parameters, creditsPerVideo: 7 }], rules: { cost: null, video: input.rules.video } });
    expect((await listPublicModelPricing(database.db)).find(row => row.modelId === input.modelId)).toMatchObject({ capability: "video", billingUnit: "video_specs",
        creditsPerUnit: null, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, videoSpecs: [{ parameters, creditsPerVideo: 7 }] });
    expect((await listAdminModelPricing(database.db)).find(row => row.modelId === input.modelId)).toMatchObject({ billingUnit: "video_specs", creditsPerUnit: null });
    expect(await resolveActiveGenerationPricing(database.db, { modelId: input.modelId })).toBeNull();
    const once = await Promise.all([database.db.select().from(modelPricing), database.db.select().from(modelPricePublication), database.db.select().from(auditEvent)]);
    expect(await publishModelPriceDraft(database.db, body, audit())).toEqual({ status: "published", publication });
    expect(await Promise.all([database.db.select().from(modelPricing), database.db.select().from(modelPricePublication), database.db.select().from(auditEvent)])).toEqual(once);
    expect(await getModelPricePublicationPreview(database.db, input.modelId)).toMatchObject({ unavailableReason: null,
        currentPrice: { billingUnit: "video_specs", protocol: VIDEO_PROTOCOL, videoSpecs: publication.billingUnit === "video_specs" ? publication.videoSpecs : [] } });
    expect({ ledger: await database.db.select().from(walletLedger), reservations: await database.db.select().from(walletReservation) }).toEqual(before);
    await expect(database.db.update(modelPriceDraft).set({ rules: { ...input.rules, video: undefined } }).where(eq(modelPriceDraft.id, body.draftId)).execute()).rejects.toThrow();
});

test("video historical validation uses the original full specification and rejects missing or tampered snapshots", async () => {
    const input = await seed(), { publication } = await publish(input), accepted = task(input, publication.id);
    expect(await getVideoSpecTaskSnapshot(database.db, accepted)).toEqual({ status: "recorded", parameters, creditsPerVideo: 7, publicationId: publication.id });
    expect(await validatePublishedGenerationTask(database.db, accepted, input.binding)).toBe(true);
    expect(await getVideoSpecTaskSnapshot(database.db, { ...accepted, inputSnapshot: { prompt: "synthetic", referenceMediaId: crypto.randomUUID() } })).toEqual({ status: "invalid" });
    for (const patch of [{ inputSnapshot: undefined }, { videoQuoteSnapshot: null }, { pricePublicationId: null }, { priceVersion: 2 }, { quotedUnits: 1 },
        { creditsPerUnitSnapshot: 8 }, { billingUnitSnapshot: "second" }, { parameterSnapshot: { ...parameters, generateAudio: true } },
        { videoQuoteSnapshot: { ...accepted.videoQuoteSnapshot, reservedCredits: 8 } },
        { videoQuoteSnapshot: { ...accepted.videoQuoteSnapshot, selectedBand: { parameters: { ...parameters, aspectRatio: "9:16" }, creditsPerVideo: 7 } } },
        { textQuoteSnapshot: {} }]) expect(await validatePublishedGenerationTask(database.db, { ...accepted, ...patch }, input.binding)).toBe(false);
    const next = structuredClone(input); next.expectedVersion = 1; next.rules.sale.bands[0].rates.video = "9";
    await publish(next, 1);
    expect(await validatePublishedGenerationTask(database.db, accepted, input.binding)).toBe(true);
    const changed = { ...input.binding, endpoint: "https://changed.example.test/v1" };
    await database.db.update(modelProvider).set({ endpoint: changed.endpoint }).where(eq(modelProvider.id, input.binding.providerId));
    expect(await validatePublishedGenerationTask(database.db, accepted, changed)).toBe(false);
    expect(await getVideoSpecTaskSnapshot(database.db, accepted)).toMatchObject({ status: "recorded" });
});

test("legacy scalar video and unconfirmed rules never acquire executable publication authority", async () => {
    for (const change of [
        (v: ModelPriceDraftWrite) => { delete v.rules.video; },
        (v: ModelPriceDraftWrite) => { v.rules.sale.bands[0].rates.video = "7.5"; },
        (v: ModelPriceDraftWrite) => { v.rules.sale.template = "video_second"; v.rules.sale.bands[0].rates = { second: "7" }; },
        (v: ModelPriceDraftWrite) => { delete v.rules.sale.bands[0].parameters.generateAudio; },
    ]) {
        const input = await seed(); change(input); const draft = await save(input);
        expect((await getModelPricePublicationPreview(database.db, input.modelId))?.unavailableReason).toBe("unsupported_price_rule");
        expect(await publishModelPriceDraft(database.db, { modelId: input.modelId, draftId: draft.id, expectedDraftVersion: draft.version,
            expectedPriceVersion: 0, binding: input.binding, publicPriceNote: "" }, audit())).toEqual({ status: "unsupported_price_rule" });
    }
    const input = await seed();
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: input.modelId, version: 1, billingUnit: "request", creditsPerUnit: 7, enabled: true, effectiveFrom: new Date() });
    expect(await validatePublishedGenerationTask(database.db, { modelId: input.modelId, priceVersion: 1, pricePublicationId: null, quotedUnits: 7,
        billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7 }, input.binding)).toBe(false);
});

test("first-frame historical selection cannot replace or lose the quoted private reference identity", async () => {
    const input = await seed(); input.rules.sale.bands[0].parameters.mode = "first_frame"; delete input.rules.sale.bands[0].parameters.aspectRatio;
    const { publication } = await publish(input), mediaId = crypto.randomUUID(), accepted = task(input, publication.id);
    const frame = { ...parameters, mode: "first_frame" as const }; delete frame.aspectRatio;
    const quoted = { ...accepted, inputSnapshot: { prompt: "synthetic first frame", referenceMediaId: mediaId }, parameterSnapshot: frame,
        videoQuoteSnapshot: { ...accepted.videoQuoteSnapshot, selectedBand: { parameters: frame, creditsPerVideo: 7 },
            referenceSnapshot: { mediaId, etag: "a".repeat(64), contentType: "image/png", sizeBytes: 123 } } };
    expect(await getVideoSpecTaskSnapshot(database.db, quoted)).toMatchObject({ status: "recorded", parameters: frame });
    expect(await getVideoSpecTaskSnapshot(database.db, { ...quoted, inputSnapshot: undefined })).toEqual({ status: "invalid" });
    expect(await getVideoSpecTaskSnapshot(database.db, { ...quoted, inputSnapshot: { prompt: "synthetic", referenceMediaId: crypto.randomUUID() } })).toEqual({ status: "invalid" });
    expect(await getVideoSpecTaskSnapshot(database.db, { ...quoted, videoQuoteSnapshot: { ...quoted.videoQuoteSnapshot, referenceSnapshot: undefined } })).toEqual({ status: "invalid" });
});
