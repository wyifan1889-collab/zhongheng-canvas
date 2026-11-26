import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { emptyMappingDraft, mappingSourceKey, mappingSpecKey } from "@infinite-canvas/shared";
import { prepareProviderDiscovery, recordProviderDiscovery, saveDiscoveredProvider, type ProviderWrite } from "@infinite-canvas/database/provider-discovery";
import { deleteCatalogProvider } from "@infinite-canvas/database/catalog-deletion";
import { saveNodeModel } from "@infinite-canvas/database/node-model-groups";
import { readModelMappingDraft, saveModelMappingDraft } from "@infinite-canvas/database/model-mapping-drafts";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { listAdminModels } from "@infinite-canvas/database/models";
import { generationTask, modelCatalog, modelMappingDraft, modelPricing, modelProvider, providerDiscoveredModel, providerDiscoveryReceipt, user, session } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const secret = "isolated-catalog-sync-" + crypto.randomUUID(), actor = { actorId: "sync-admin", sessionId: "sync-session", sessionExpiresAt: new Date(Date.now() + 3_600_000), requestId: "sync-test" };
const input = (revision: number): ProviderWrite => ({ displayName: "同步测试渠道", adapter: "openai-compatible", endpoint: "https://example.test/v1", enabled: true, apiKey: "synthetic-only", revision });
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: actor.actorId, name: "Sync", email: "sync@example.test", emailVerified: true, role: "admin" });
    await database.db.insert(session).values({ id: actor.sessionId, userId: actor.actorId, token: crypto.randomUUID(), expiresAt: actor.sessionExpiresAt });
}, 30_000);
afterAll(async () => { await database?.close(); });
async function discover(id: string, revision: number, models: string[]) {
    const body = input(revision), target = await prepareProviderDiscovery(database.db, secret, id, body, actor);
    const read = await recordProviderDiscovery(database.db, secret, target, revision, models, actor);
    return { ...body, discoveryReceiptId: read.receiptId };
}
async function seed(id: string) {
    await saveDiscoveredProvider(database.db, secret, id, await discover(id, 0, ["keep", "remove"]), actor);
    const publicId = `${id}-node`;
    await saveNodeModel(database.db, publicId, { providerId: id, providerModel: "remove", capability: "image", displayName: "待同步图片", enabled: true, groupId: null, revision: 0 }, actor);
    const [row] = await database.db.select().from(modelCatalog).where(eq(modelCatalog.publicId, publicId));
    await database.db.insert(modelPricing).values({ id: `${id}-price`, modelId: row.id, version: 1, billingUnit: "request", creditsPerUnit: 4, effectiveFrom: new Date(), enabled: true });
    return { publicId, row };
}
test("complete snapshot removes inventory and node bindings atomically while preserving other channels and history", async () => {
    const a = await seed("sync-a"), b = await seed("sync-b");
    const task = await createGenerationTaskRepository(database.db).create({ ownerId: actor.actorId, modelId: a.publicId, inputSnapshot: { prompt: "test" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: "sync" });
    await database.db.update(generationTask).set({ executionStatus: "cancelled", billingStatus: "released", deliveryStatus: "failed", finishedAt: new Date() }).where(eq(generationTask.id, task.task.id));
    const beforeTasks = await database.db.select().from(generationTask).where(eq(generationTask.id, task.task.id));
    const beforePrices = await database.db.select().from(modelPricing);
    const draft = emptyMappingDraft(); draft.models = [{ id: "combined-image", displayName: "统一图片", capability: "image", group: "图片" }];
    draft.modelSpecifications["combined-image"] = ["1K", "2K", "4K"];
    draft.bindings = ["sync-a", "sync-b"].map(providerId => ({ providerId, providerModel: "remove", modelId: "combined-image", specification: "4K" }));
    const spec = mappingSpecKey("combined-image", "4K"); draft.preferred[spec] = mappingSourceKey(draft.bindings[0]); draft.prices[spec] = "12";
    await saveModelMappingDraft(database.db, { expectedVersion: 0, draft, providers: [{ providerId: "sync-a", revision: 1 }, { providerId: "sync-b", revision: 1 }] }, actor);
    const result = await saveDiscoveredProvider(database.db, secret, "sync-a", await discover("sync-a", 1, ["keep", "new"]), actor);
    expect(result.removedModelIds).toEqual([a.publicId]);
    expect((await database.db.select().from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, "sync-a"))).map(row => row.providerModel).sort()).toEqual(["keep", "new"]);
    const models = await listAdminModels(database.db); expect(models.some(row => row.id === a.publicId)).toBe(false); expect(models.some(row => row.id === b.publicId)).toBe(true);
    expect(await database.db.select().from(modelPricing)).toEqual(beforePrices);
    expect(await database.db.select().from(generationTask).where(eq(generationTask.id, task.task.id))).toEqual(beforeTasks);
    const next = await readModelMappingDraft(database.db, actor); expect(next.version).toBe(2); expect(next.draft.bindings.map(row => row.providerId)).toEqual(["sync-b"]);
    expect(next.draft.preferred[spec]).toBeNull(); expect(next.draft.modelSpecifications["combined-image"]).toContain("2K");
    await expect(saveModelMappingDraft(database.db, { expectedVersion: 1, draft, providers: [{ providerId: "sync-a", revision: 1 }, { providerId: "sync-b", revision: 1 }] }, actor)).rejects.toMatchObject({ code: "mapping_conflict" });
});
test("missing sources cannot be recreated by stale node forms and reappearing inventory never revives removed nodes", async () => {
    const body = { providerId: "sync-a", providerModel: "remove", capability: "image" as const, displayName: "旧表单", enabled: true, groupId: null, revision: 0 };
    await expect(saveNodeModel(database.db, "phantom-node", body, actor)).rejects.toMatchObject({ code: "model_revision_conflict" });
    await saveDiscoveredProvider(database.db, secret, "sync-a", await discover("sync-a", 2, ["keep", "remove"]), actor);
    expect((await listAdminModels(database.db)).some(row => row.id === "sync-a-node")).toBe(false);
    await expect(saveNodeModel(database.db, "sync-a-node", { ...body, revision: 2 }, actor)).rejects.toMatchObject({ code: "model_revision_conflict" });
});
test("unfinished or pending-review tasks block the entire channel update and preserve its receipt and draft", async () => {
    const { publicId } = await seed("sync-busy"), write = await discover("sync-busy", 1, []);
    const task = await createGenerationTaskRepository(database.db).create({ ownerId: actor.actorId, modelId: publicId, inputSnapshot: { prompt: "busy" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: "sync" });
    const before = await database.db.select().from(modelMappingDraft);
    await expect(saveDiscoveredProvider(database.db, secret, "sync-busy", write, actor)).rejects.toMatchObject({ code: "catalog_in_use" });
    expect((await database.db.select().from(modelProvider).where(eq(modelProvider.id, "sync-busy")))[0].revision).toBe(1);
    expect(await database.db.select().from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, "sync-busy"))).toHaveLength(2);
    expect(await database.db.select().from(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.id, write.discoveryReceiptId!))).toHaveLength(1);
    expect(await database.db.select().from(modelMappingDraft)).toEqual(before);
    await database.db.update(generationTask).set({ executionStatus: "failed", billingStatus: "pending_review", deliveryStatus: "failed", finishedAt: new Date() }).where(eq(generationTask.id, task.task.id));
    await expect(saveDiscoveredProvider(database.db, secret, "sync-busy", write, actor)).rejects.toMatchObject({ code: "catalog_in_use" });
});
test("channel deletion prunes only its sources and last-source models, keeping display specification catalog", async () => {
    await deleteCatalogProvider(database.db, "sync-b", 1, actor);
    const current = await readModelMappingDraft(database.db, actor);
    expect(current.draft.models).toEqual([]); expect(current.draft.bindings).toEqual([]); expect(current.draft.prices).toEqual({});
    expect(current.draft.specificationOptions.image).toEqual(["1K", "2K", "4K"]);
    expect(await database.db.select().from(modelPricing).where(eq(modelPricing.id, "sync-b-price"))).toHaveLength(1);
});
test("even metadata-only saves need an authenticated complete snapshot and stale revision cannot overwrite", async () => {
    await expect(saveDiscoveredProvider(database.db, secret, "sync-a", { ...input(3), displayName: "改名也需目录", apiKey: undefined, enabled: false }, actor)).rejects.toMatchObject({ code: "provider_discovery_required" });
    const first = await discover("sync-a", 3, ["keep"]), second = await discover("sync-a", 3, ["remove"]);
    await saveDiscoveredProvider(database.db, secret, "sync-a", first, actor);
    await expect(saveDiscoveredProvider(database.db, secret, "sync-a", second, actor)).rejects.toMatchObject({ code: "provider_revision_conflict" });
});
