import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { emptyMappingDraft, mappingCombinationKey } from "@infinite-canvas/shared";
import { readModelMappingDraft, saveModelMappingDraft } from "@infinite-canvas/database/model-mapping-drafts";
import { previewMappingPublication, publishMappingConfiguration, readPublishedMappingCatalog } from "@infinite-canvas/database/model-mapping-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { modelProvider, providerDiscoveredModel, user, session, walletLedger, generationTask, modelMappingPublication } from "@infinite-canvas/database/schema";
import { GEMINI_IMAGE_PROTOCOL as protocol } from "../../../packages/shared/src/generation-gemini-image";
import { executableMappingCatalog } from "../src/model-mapping-catalog";
import { listExecutableImageModels, resolveExecutableImageQuote } from "../src/generation-image-policy";
import { createTestDatabase } from "./database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const actor = { actorId: "gemini-mapping-admin", sessionId: "gemini-mapping-session", sessionExpiresAt: new Date(Date.now() + 3_600_000), requestId: "gemini-mapping-test" };
const providerId = "native-mapping", providerModel = "gemini-3.1-flash-image-preview";
const input = (p: Awaited<ReturnType<typeof previewMappingPublication>>) => ({ expectedDraftVersion: p.draftVersion, expectedPublicationVersion: p.publicationVersion, fingerprint: p.fingerprint });
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: actor.actorId, email: "native-mapping@example.test", name: "Synthetic", emailVerified: true, role: "admin" });
    await database.db.insert(session).values({ id: actor.sessionId, userId: actor.actorId, token: crypto.randomUUID(), expiresAt: actor.sessionExpiresAt });
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic native", adapter: "openai-compatible", endpoint: "https://native.example.test/", secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, "synthetic-gemini-mapping-secret-not-real", providerId, "not-a-real-key");
    await database.db.insert(providerDiscoveredModel).values({ providerId, providerModel });
    const draft = emptyMappingDraft(); draft.specificationOptions.image.push("512");
    draft.models = [{ id: "native-gemini", displayName: "Gemini Flash", capability: "image", group: "Google" }];
    draft.modelSpecifications = { "native-gemini": ["512", "1K"] };
    draft.bindings = ["1:1", "21:9"].map(aspectRatio => ({ providerId, providerModel, modelId: "native-gemini", specification: "512",
        execution: { protocol, parameters: { aspectRatio: aspectRatio as "1:1" | "21:9", imageSize: "512" } } }));
    draft.bindings.forEach(binding => { draft.prices[mappingCombinationKey(binding)] = "7"; });
    const original = await readModelMappingDraft(database.db, actor);
    await saveModelMappingDraft(database.db, { expectedVersion: original.version, draft, providers: [{ providerId, revision: 1 }] }, actor);
}, 30_000);
afterAll(async () => { await database?.close(); });

test("native draft publication obeys the existing feature gate and commits no billing", async () => {
    const closed = await previewMappingPublication(database.db, actor);
    expect(closed.issues.some(issue => issue.message.includes("尚未开放"))).toBe(true);
    await expect(publishMappingConfiguration(database.db, input(closed), actor)).rejects.toMatchObject({ code: "mapping_publication_invalid" });
    expect(await database.db.select().from(modelMappingPublication)).toHaveLength(0);
    const opened = await previewMappingPublication(database.db, actor, true); expect(opened.issues).toEqual([]);
    await expect(publishMappingConfiguration(database.db, input(opened), actor)).rejects.toMatchObject({ code: "mapping_publication_conflict" });
    await publishMappingConfiguration(database.db, input(opened), actor, true);
    expect(await database.db.select().from(modelMappingPublication)).toHaveLength(1);
    expect(await database.db.select().from(walletLedger)).toHaveLength(0); expect(await database.db.select().from(generationTask)).toHaveLength(0);
});
test("public and executable catalogs agree on native price; unverified dimensions and closed execution stay unavailable", async () => {
    expect(await listExecutableImageModels(database.db)).toHaveLength(0);
    const models = await listExecutableImageModels(database.db, true); expect(models).toHaveLength(1);
    expect(models[0].imagePricing).toMatchObject({ protocol, usagePolicy: "delivered_images", imageSpecs: [{ parameters: { aspectRatio: "1:1", imageSize: "512" }, creditsPerImage: 7 }] });
    expect(models[0].maxImages).toBeUndefined();
    const published = await readPublishedMappingCatalog(database.db);
    const runtime = { enabled: true, imageEnabled: true, videoEnabled: false, geminiImageEnabled: true };
    expect(executableMappingCatalog(published, runtime).models[0].combinations.map(item => item.available)).toEqual([true, false]);
    expect(executableMappingCatalog(published, { ...runtime, geminiImageEnabled: false }).models[0].combinations.every(item => !item.available)).toBe(true);
    const quote = await resolveExecutableImageQuote(database.db, { modelId: models[0].id, inputSnapshot: { prompt: "synthetic" },
        parameterSnapshot: { protocol, aspectRatio: "1:1", imageSize: "512", budgetCredits: 17 } }, false, actor.actorId);
    expect(quote).toMatchObject({ billingUnit: "image", quotedUnits: 17, creditsPerUnit: 7, gemini: { status: "gemini" } });
    expect(JSON.stringify(published)).not.toContain("native.example.test");
});
test("changing the provider binding invalidates the native executable catalog without fallback", async () => {
    await database.db.update(modelProvider).set({ endpoint: "https://native.example.test/v1" }).where(eq(modelProvider.id, providerId));
    expect(await listExecutableImageModels(database.db, true)).toHaveLength(0);
    expect((await readPublishedMappingCatalog(database.db)).models[0].combinations.every(item => !item.available)).toBe(true);
});
