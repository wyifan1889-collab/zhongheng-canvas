import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { auditEvent, generationResult, generationTask, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { getAdminGenerationTaskDetail } from "../src/admin-generation-query";
import { normalizeChatUsage, normalizeResponsesUsage, parseTaskPriceSnapshot, type ModelPriceRules, type TextQuoteSnapshot } from "@infinite-canvas/shared";
import { createTestDatabase } from "./database";

if (process.env.SAAS_TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error("Only in-memory PGlite is permitted");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const marker = "synthetic-private-prompt-key-url";

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([ownerId, otherId].map((id) => ({ id, name: "Query fixture", email: `${id}@example.test` })));
});
afterAll(async () => { await database?.close(); });

async function task() {
    const id = crypto.randomUUID();
    await database.db.insert(generationTask).values({
        id, ownerId, projectId: "synthetic-project", nodeId: "synthetic-node", modelId: "synthetic-image", priceVersion: 2,
        quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
        inputSnapshot: { prompt: marker }, parameterSnapshot: { private: marker }, idempotencyKey: `${marker}-${id}`,
        requestId: marker, providerTaskId: marker, executionStatus: "unknown", deliveryStatus: "unknown",
        billingStatus: "pending_review", unknownReason: "provider_response_unknown",
    });
    return id;
}

async function businessSnapshot() {
    return Promise.all([
        database.db.select().from(generationTask), database.db.select().from(generationResult),
        database.db.select().from(wallet), database.db.select().from(walletReservation),
        database.db.select().from(walletLedger), database.db.select().from(auditEvent),
        database.db.select().from(modelProvider), database.db.select().from(modelCatalog),
        database.db.select().from(modelPriceDraft), database.db.select().from(modelPricePublication), database.db.select().from(modelPricing),
    ]);
}

test("projects one read-only snapshot with raw units, owned links and generation ledger only", async () => {
    const id = await task();
    const reservationId = crypto.randomUUID();
    await database.db.insert(walletReservation).values({
        id: reservationId, userId: ownerId, taskId: id, requestedUnits: "7", capturedUnits: "2", releasedUnits: "1",
        idempotencyKey: marker, providerRequestId: marker,
    });
    await database.db.update(generationTask).set({ reservationId }).where(eq(generationTask.id, id));
    await database.db.insert(generationResult).values({
        id: crypto.randomUUID(), ownerId, taskId: id, status: "unknown", consumedUnits: 1,
        unknownReason: "provider_response_unknown", errorCode: "provider_timeout", providerTaskId: marker,
        providerStatus: 504, resultSnapshot: { text: marker, image: { base64: marker }, url: marker },
    });
    const reserveId = crypto.randomUUID();
    await database.db.insert(walletLedger).values([
        { id: reserveId, userId: ownerId, referenceType: "generation", referenceId: id, kind: "reserve" as const, deltaAvailableUnits: "-7", deltaReservedUnits: "7" },
        { id: crypto.randomUUID(), userId: otherId, referenceType: "generation", referenceId: id, kind: "reserve" as const, deltaAvailableUnits: "-99", deltaReservedUnits: "99" },
        { id: crypto.randomUUID(), userId: ownerId, referenceType: "adjustment", referenceId: id, kind: "adjustment" as const, deltaAvailableUnits: "99", deltaReservedUnits: "0" },
        { id: crypto.randomUUID(), userId: ownerId, referenceType: "generation", referenceId: crypto.randomUUID(), kind: "reserve" as const, deltaAvailableUnits: "-99", deltaReservedUnits: "99" },
    ].map((entry) => ({ ...entry, availableUnitsAfter: "0", reservedUnitsAfter: "7", idempotencyKey: entry.id, metadata: { private: marker } })));
    const before = await businessSnapshot();
    const transaction = spyOn(database.db, "transaction");
    try {
        const detail = await getAdminGenerationTaskDetail(database.db, id.toUpperCase());
        expect(transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
        expect(Number.isFinite(Date.parse(detail.observedAt))).toBe(true);
        expect(detail.task).toMatchObject({ id, ownerId, quotedUnits: 7, creditsPerUnitSnapshot: 7, unknownReason: "provider_response_unknown" });
        expect(detail.priceSnapshot).toEqual({ status: "not_recorded" });
        expect(detail.result).toMatchObject({ consumedUnits: 1, errorCode: "provider_timeout" });
        expect(detail.reservation).toMatchObject({ linkStatus: "linked", details: { id: reservationId, requestedUnits: "7", capturedUnits: "2", releasedUnits: "1", remainingUnits: "4" } });
        expect(detail.ledger).toHaveLength(1);
        expect(detail.ledger[0]).toMatchObject({ id: reserveId, kind: "reserve", deltaAvailableUnits: "-7", deltaReservedUnits: "7" });
        expect(Object.keys(detail.task).sort()).toEqual(["id", "ownerId", "projectId", "nodeId", "modelId", "priceVersion", "quotedUnits", "billingUnitSnapshot", "creditsPerUnitSnapshot", "executionStatus", "deliveryStatus", "billingStatus", "unknownReason", "createdAt", "updatedAt", "finishedAt"].sort());
        expect(Object.keys(detail.result!).sort()).toEqual(["status", "consumedUnits", "textUsage", "errorCode", "unknownReason", "createdAt", "updatedAt"].sort());
        expect(Object.keys(detail.ledger[0]!).sort()).toEqual(["id", "kind", "deltaAvailableUnits", "deltaReservedUnits", "createdAt"].sort());
        expect(JSON.stringify(detail)).not.toContain(marker);
        expect(await businessSnapshot()).toEqual(before);
    } finally { transaction.mockRestore(); }
});

test("text usage projection exposes only validated evidence without upgrading old partial usage or changing records", async () => {
    const id = await task();
    const evidence = normalizeChatUsage({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } });
    await database.db.insert(generationResult).values({ id: crypto.randomUUID(), ownerId, taskId: id, status: "succeeded",
        resultSnapshot: { kind: "text", text: marker, usageEvidence: evidence, private: marker } });
    const before = await businessSnapshot();
    const detail = await getAdminGenerationTaskDetail(database.db, id);
    expect(detail.result?.textUsage).toEqual(evidence);
    expect(JSON.stringify(detail)).not.toContain(marker);
    expect(await businessSnapshot()).toEqual(before);
    for (const snapshot of [
        { kind: "text", usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
        { kind: "text", usageEvidence: { ...evidence, private: marker } },
        { kind: "text", usageEvidence: { ...evidence, totalTokens: 99 } },
        { kind: "image", usageEvidence: evidence },
    ]) {
        await database.db.update(generationResult).set({ resultSnapshot: snapshot }).where(eq(generationResult.taskId, id));
        const response = await getAdminGenerationTaskDetail(database.db, id);
        expect(response.result?.textUsage).toBeNull();
        expect(JSON.stringify(response)).not.toContain(marker);
    }
    const invalid = normalizeChatUsage({ prompt_tokens: -1, completion_tokens: 2 });
    await database.db.update(generationResult).set({ resultSnapshot: { kind: "text", usageEvidence: invalid } }).where(eq(generationResult.taskId, id));
    expect((await getAdminGenerationTaskDetail(database.db, id)).result?.textUsage).toEqual(invalid);
});

test("absence is null rather than invented zero and reading never ensures a wallet", async () => {
    const id = await task();
    const before = await businessSnapshot();
    const detail = await getAdminGenerationTaskDetail(database.db, id);
    expect(detail.result).toBeNull();
    expect(detail.reservation).toEqual({ linkStatus: "none", details: null });
    expect(detail.ledger).toEqual([]);
    expect(await database.db.select().from(wallet)).toEqual([]);
    expect(await businessSnapshot()).toEqual(before);
});

test("Responses usage survives the administrative projection with its source and no billing writes", async () => {
    const id = await task();
    await database.db.insert(generationResult).values({ id: crypto.randomUUID(), ownerId, taskId: id, status: "succeeded", resultSnapshot: {} });
    for (const evidence of [
        normalizeResponsesUsage({ input_tokens: 11, output_tokens: 7, total_tokens: 18,
            input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 7 } }),
        normalizeResponsesUsage(null),
        normalizeResponsesUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 4 }),
    ]) {
        await database.db.update(generationResult).set({ resultSnapshot: { kind: "text", text: marker, usageEvidence: evidence, private: marker } })
            .where(eq(generationResult.taskId, id));
        const before = await businessSnapshot();
        const detail = await getAdminGenerationTaskDetail(database.db, id);
        expect(detail.result?.textUsage).toEqual(evidence);
        expect(detail.result?.consumedUnits).toBeNull();
        expect(JSON.stringify(detail)).not.toContain(marker);
        expect(await businessSnapshot()).toEqual(before);
    }
});

test("wrong reservation owner or task and wrong result owner expose no linked details", async () => {
    const id = await task();
    const reservationId = crypto.randomUUID();
    await database.db.insert(walletReservation).values({ id: reservationId, userId: otherId, taskId: id, requestedUnits: "99", idempotencyKey: reservationId });
    await database.db.update(generationTask).set({ reservationId }).where(eq(generationTask.id, id));
    await database.db.insert(generationResult).values({ id: crypto.randomUUID(), ownerId: otherId, taskId: id, status: "succeeded", consumedUnits: 99, resultSnapshot: { private: marker } });
    const before = await businessSnapshot();
    const detail = await getAdminGenerationTaskDetail(database.db, id);
    expect(detail.reservation).toEqual({ linkStatus: "mismatch", details: null });
    expect(detail.result).toBeNull();
    expect(await businessSnapshot()).toEqual(before);
    await database.db.update(walletReservation).set({ userId: ownerId, taskId: crypto.randomUUID() }).where(eq(walletReservation.id, reservationId));
    expect((await getAdminGenerationTaskDetail(database.db, id)).reservation).toEqual({ linkStatus: "mismatch", details: null });
});

test("a dangling reservation link is reported without treating it as an empty balance", async () => {
    const id = await task();
    // Isolated corrupt-storage fixture only: production retains its foreign key.
    await database.db.execute(sql`ALTER TABLE canvas_saas.generation_task DROP CONSTRAINT generation_task_reservation_id_wallet_reservation_id_fk`);
    try {
        await database.db.update(generationTask).set({ reservationId: crypto.randomUUID() }).where(eq(generationTask.id, id));
        const before = await businessSnapshot();
        expect((await getAdminGenerationTaskDetail(database.db, id)).reservation).toEqual({ linkStatus: "missing", details: null });
        expect(await businessSnapshot()).toEqual(before);
    } finally {
        // The bound reservation is immutable; remove only this corrupt fixture before restoring the FK.
        await database.db.delete(generationTask).where(eq(generationTask.id, id));
        await database.db.execute(sql`ALTER TABLE canvas_saas.generation_task ADD CONSTRAINT generation_task_reservation_id_wallet_reservation_id_fk FOREIGN KEY (reservation_id) REFERENCES canvas_saas.wallet_reservation(id) ON DELETE SET NULL`);
    }
});

test("free-text and fake credentials in reason fields are never returned", async () => {
    const id = await task();
    await database.db.update(generationTask).set({ unknownReason: "Bearer synthetic-private-token" }).where(eq(generationTask.id, id));
    await database.db.insert(generationResult).values({ id: crypto.randomUUID(), ownerId, taskId: id, status: "unknown",
        errorCode: "sk-synthetic-private-key", unknownReason: "upstream body with prompt and https://private.invalid", resultSnapshot: {} });
    const detail = await getAdminGenerationTaskDetail(database.db, id);
    expect(detail.task.unknownReason).toBe("unrecognized_reason");
    expect(detail.result).toMatchObject({ errorCode: "unrecognized_reason", unknownReason: "unrecognized_reason" });
    expect(JSON.stringify(detail)).not.toContain("private");
});

test("invalid UUID and missing task remain distinct failures", async () => {
    await expect(getAdminGenerationTaskDetail(database.db, "not-a-uuid")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(getAdminGenerationTaskDetail(database.db, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
});

async function publishedTask(cost: unknown = { template: "image_request", currency: "USD", bands: [{ parameters: {}, rates: { request: "0.123456789" } }] }) {
    const id = crypto.randomUUID(), providerId = `price-provider-${id}`, modelId = `price-model-${id}`;
    const draftId = crypto.randomUUID(), pricingId = crypto.randomUUID(), publicationId = crypto.randomUUID();
    const binding = { providerId, providerModel: "accepted-image", adapter: "openai-compatible" as const, endpoint: "https://accepted.invalid/v1", capability: "image" as const };
    const rules = { schemaVersion: 1 as const, cost, sale: { template: "image_request" as const, currency: "credit" as const, bands: [{ parameters: {}, rates: { request: "7" } }] } };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Snapshot provider", adapter: binding.adapter, endpoint: binding.endpoint, secretRef: marker, enabled: true });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: binding.providerModel, displayName: "Snapshot model", capability: "image", enabled: true });
    await database.db.insert(modelPriceDraft).values({ id: draftId, modelId, version: 1, rules: rules as typeof modelPriceDraft.$inferInsert.rules,
        priceNote: marker, providerIdSnapshot: providerId, providerModelSnapshot: binding.providerModel, adapterSnapshot: binding.adapter, endpointSnapshot: binding.endpoint, capabilitySnapshot: binding.capability });
    await database.db.insert(modelPricing).values({ id: pricingId, modelId, version: 1, billingUnit: "request", creditsPerUnit: 7, effectiveFrom: new Date(), enabled: true });
    await database.db.insert(modelPricePublication).values({ id: publicationId, pricingId, draftId, publicPriceNote: "单张图片价格说明" });
    await database.db.insert(generationTask).values({ id, ownerId, modelId, priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
        inputSnapshot: { prompt: marker }, parameterSnapshot: { n: 1 }, idempotencyKey: id, requestId: id });
    return { id, providerId, modelId, draftId, pricingId, publicationId, binding, rules };
}

test("admin reads the linked accepted price after new drafts, price rotation and provider changes without private notes or writes", async () => {
    const fixture = await publishedTask();
    const first = await getAdminGenerationTaskDetail(database.db, fixture.id);
    expect(first.priceSnapshot).toMatchObject({ status: "recorded", publicationId: fixture.publicationId, draftId: fixture.draftId,
        draftVersion: 1, priceVersion: 1, publicPriceNote: "单张图片价格说明", binding: fixture.binding, rules: fixture.rules });
    const [oldDraft] = await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.id, fixture.draftId));
    await database.db.insert(modelPriceDraft).values({ ...oldDraft!, id: crypto.randomUUID(), version: 2,
        rules: { ...oldDraft!.rules, cost: null, sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "99" } }] } } });
    await database.db.update(modelPricing).set({ enabled: false }).where(eq(modelPricing.id, fixture.pricingId));
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: fixture.modelId, version: 2, billingUnit: "request", creditsPerUnit: 99, effectiveFrom: new Date(), enabled: true });
    await database.db.update(modelProvider).set({ enabled: false, endpoint: "https://changed.invalid/v1" }).where(eq(modelProvider.id, fixture.providerId));
    await database.db.update(modelCatalog).set({ enabled: false, providerModel: "different-model" }).where(eq(modelCatalog.id, fixture.modelId));
    const before = await businessSnapshot();
    const after = await getAdminGenerationTaskDetail(database.db, fixture.id);
    expect(after.priceSnapshot).toEqual(first.priceSnapshot);
    expect(after.task.creditsPerUnitSnapshot).toBe(7);
    expect(JSON.stringify(after)).not.toContain(marker);
    expect(Object.hasOwn(after.task, "pricePublicationId")).toBe(false);
    expect(await businessSnapshot()).toEqual(before);
});

test("unknown cost stays unknown and malformed stored source is blocked rather than returned", async () => {
    const absent = await publishedTask(null);
    expect((await getAdminGenerationTaskDetail(database.db, absent.id)).priceSnapshot).toMatchObject({ status: "recorded", rules: { cost: null } });
    const corrupt = await publishedTask({ template: "image_request", currency: "USD", private: marker, bands: [{ parameters: {}, rates: { request: "0.2" } }] });
    const before = await businessSnapshot();
    const response = await getAdminGenerationTaskDetail(database.db, corrupt.id);
    expect(response.priceSnapshot).toEqual({ status: "invalid" });
    expect(JSON.stringify(response)).not.toContain(marker);
    expect(await businessSnapshot()).toEqual(before);
});

const taskFields = ["id", "ownerId", "projectId", "nodeId", "modelId", "priceVersion", "quotedUnits", "billingUnitSnapshot", "creditsPerUnitSnapshot", "executionStatus", "deliveryStatus", "billingStatus", "unknownReason", "createdAt", "updatedAt", "finishedAt"].sort();

async function publishedTextTask(cached: boolean, adapter: "openai-compatible" | "sub2api" = "sub2api") {
    const id = crypto.randomUUID(), providerId = `text-provider-${id}`, modelId = `text-model-${id}`, publicId = `public-text-${id}`;
    const draftId = crypto.randomUUID(), pricingId = crypto.randomUUID(), publicationId = crypto.randomUUID();
    const binding = { providerId, providerModel: "accepted-text", adapter, endpoint: "https://accepted.invalid/v1", capability: "text" as const };
    const rules: ModelPriceRules = { schemaVersion: 1, cost: null, sale: {
        template: cached ? "text_cached_tokens" : "text_tokens", currency: "credit",
        bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4", ...(cached ? { cached_input_token: "0.2" } : {}) } }],
    } };
    const quote: TextQuoteSnapshot = { schemaVersion: 1, budgetCredits: "0.01", inputCreditsPerMillion: "2", outputCreditsPerMillion: "4",
        ...(cached ? { cachedInputCreditsPerMillion: "0.2" } : {}), usageSource: adapter === "sub2api" ? "responses" : "chat_completions" };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Historical text provider", adapter, endpoint: binding.endpoint, secretRef: marker, enabled: true });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId, providerId, providerModel: binding.providerModel, displayName: "Historical text model", capability: "text", enabled: true });
    await database.db.insert(modelPriceDraft).values({ id: draftId, modelId, version: 1, rules, priceNote: marker,
        providerIdSnapshot: providerId, providerModelSnapshot: binding.providerModel, adapterSnapshot: adapter, endpointSnapshot: binding.endpoint, capabilitySnapshot: "text" });
    await database.db.transaction(async (tx) => {
        await tx.insert(modelPricing).values({ id: pricingId, modelId, version: 1, billingUnit: "text_tokens", creditsPerUnit: null, effectiveFrom: new Date(), enabled: true });
        await tx.insert(modelPricePublication).values({ id: publicationId, pricingId, draftId, publicPriceNote: "历史文本分项价格说明" });
    });
    await database.db.insert(generationTask).values({ id, ownerId, modelId: publicId, priceVersion: 1, textQuoteSnapshot: quote,
        inputSnapshot: { prompt: marker }, parameterSnapshot: {}, idempotencyKey: id, requestId: id });
    return { id, providerId, modelId, publicId, draftId, pricingId, publicationId, binding, rules, quote };
}

for (const cached of [false, true]) test(`admin records historical ${cached ? "three-rate cached" : "dual-rate"} text prices without extending task DTO`, async () => {
    for (const adapter of ["openai-compatible", "sub2api"] as const) {
        const fixture = await publishedTextTask(cached, adapter), before = await businessSnapshot();
        const detail = await getAdminGenerationTaskDetail(database.db, fixture.id);
        expect(detail.priceSnapshot).toMatchObject({ status: "recorded", publicationId: fixture.publicationId, draftId: fixture.draftId,
            draftVersion: 1, priceVersion: 1, publicPriceNote: "历史文本分项价格说明", binding: fixture.binding, rules: fixture.rules });
        expect(parseTaskPriceSnapshot(detail.priceSnapshot)).toEqual(detail.priceSnapshot);
        expect(Object.keys(detail.task).sort()).toEqual(taskFields);
        expect(detail.task).toMatchObject({ modelId: fixture.publicId, priceVersion: 1, quotedUnits: null, billingUnitSnapshot: null, creditsPerUnitSnapshot: null });
        expect(JSON.stringify(detail)).not.toContain(marker);
        expect(await businessSnapshot()).toEqual(before);
    }
});

for (const cached of [false, true]) test(`historical ${cached ? "cache" : "dual"} publication stays fixed after a new published price and channel changes`, async () => {
    const fixture = await publishedTextTask(cached), first = await getAdminGenerationTaskDetail(database.db, fixture.id);
    const [oldDraft] = await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.id, fixture.draftId));
    const nextDraftId = crypto.randomUUID(), nextPricingId = crypto.randomUUID(), nextPublicationId = crypto.randomUUID();
    const newRules: ModelPriceRules = { ...fixture.rules, sale: { ...fixture.rules.sale,
        bands: [{ parameters: {}, rates: { input_token: "20", output_token: "40", ...(cached ? { cached_input_token: "2" } : {}) } }] } };
    await database.db.insert(modelPriceDraft).values({ ...oldDraft!, id: nextDraftId, version: 2, rules: newRules });
    await database.db.update(modelPricing).set({ enabled: false }).where(eq(modelPricing.id, fixture.pricingId));
    await database.db.transaction(async (tx) => {
        await tx.insert(modelPricing).values({ id: nextPricingId, modelId: fixture.modelId, version: 2, billingUnit: "text_tokens", creditsPerUnit: null, effectiveFrom: new Date(), enabled: true });
        await tx.insert(modelPricePublication).values({ id: nextPublicationId, pricingId: nextPricingId, draftId: nextDraftId, publicPriceNote: "新版本说明" });
    });
    await database.db.update(modelProvider).set({ enabled: false, adapter: "openai-compatible", endpoint: "https://changed.invalid/v1" }).where(eq(modelProvider.id, fixture.providerId));
    await database.db.update(modelCatalog).set({ enabled: false, providerModel: "changed-text" }).where(eq(modelCatalog.id, fixture.modelId));
    const before = await businessSnapshot(), after = await getAdminGenerationTaskDetail(database.db, fixture.id);
    expect(after.priceSnapshot).toEqual(first.priceSnapshot);
    expect(after.priceSnapshot).toMatchObject({ status: "recorded", publicationId: fixture.publicationId, priceVersion: 1, rules: fixture.rules, binding: fixture.binding });
    expect(Object.keys(after.task).sort()).toEqual(taskFields);
    expect(JSON.stringify(after)).not.toContain(marker);
    expect(await businessSnapshot()).toEqual(before);
});

test("corrupt accepted text quotes stay invalid and private raw fields cannot escape the read-only projection", async () => {
    const fixture = await publishedTextTask(true), otherModel = await publishedTextTask(true);
    const { cachedInputCreditsPerMillion: _cache, ...withoutCache } = fixture.quote;
    // Corrupt-storage fixture only. Production retains the immutable update trigger.
    await database.db.execute(sql`ALTER TABLE canvas_saas.generation_task DISABLE TRIGGER generation_task_price_source_immutable`);
    try {
        const variants = [
            { textQuoteSnapshot: null },
            { textQuoteSnapshot: withoutCache },
            { textQuoteSnapshot: { ...fixture.quote, cachedInputCreditsPerMillion: "0.3" } },
            { textQuoteSnapshot: { ...fixture.quote, inputCreditsPerMillion: "9" } },
            { textQuoteSnapshot: { ...fixture.quote, outputCreditsPerMillion: "9" } },
            { textQuoteSnapshot: { ...fixture.quote, budgetCredits: "0" } },
            { textQuoteSnapshot: { ...fixture.quote, usageSource: "chat_completions" as const } },
            { textQuoteSnapshot: { ...fixture.quote, private: marker } },
            { priceVersion: 2 },
            { pricePublicationId: null },
            { pricePublicationId: otherModel.publicationId },
        ];
        for (const changed of variants) {
            await database.db.update(generationTask).set({ textQuoteSnapshot: fixture.quote, priceVersion: 1,
                pricePublicationId: fixture.publicationId, ...changed }).where(eq(generationTask.id, fixture.id));
            const before = await businessSnapshot(), detail = await getAdminGenerationTaskDetail(database.db, fixture.id);
            expect(detail.priceSnapshot).toEqual({ status: "invalid" });
            expect(Object.keys(detail.task).sort()).toEqual(taskFields);
            expect(JSON.stringify(detail)).not.toContain(marker);
            expect(await businessSnapshot()).toEqual(before);
        }
    } finally {
        await database.db.update(generationTask).set({ textQuoteSnapshot: fixture.quote, priceVersion: 1, pricePublicationId: fixture.publicationId }).where(eq(generationTask.id, fixture.id));
        await database.db.execute(sql`ALTER TABLE canvas_saas.generation_task ENABLE TRIGGER generation_task_price_source_immutable`);
    }
});

test("a dual-rate publication cannot record an injected cache fee", async () => {
    const fixture = await publishedTextTask(false);
    await database.db.execute(sql`ALTER TABLE canvas_saas.generation_task DISABLE TRIGGER generation_task_price_source_immutable`);
    try {
        await database.db.update(generationTask).set({ textQuoteSnapshot: { ...fixture.quote, cachedInputCreditsPerMillion: "0.2" } }).where(eq(generationTask.id, fixture.id));
        const before = await businessSnapshot(), detail = await getAdminGenerationTaskDetail(database.db, fixture.id);
        expect(detail.priceSnapshot).toEqual({ status: "invalid" });
        expect(Object.keys(detail.task).sort()).toEqual(taskFields);
        expect(await businessSnapshot()).toEqual(before);
    } finally {
        await database.db.update(generationTask).set({ textQuoteSnapshot: fixture.quote }).where(eq(generationTask.id, fixture.id));
        await database.db.execute(sql`ALTER TABLE canvas_saas.generation_task ENABLE TRIGGER generation_task_price_source_immutable`);
    }
});
