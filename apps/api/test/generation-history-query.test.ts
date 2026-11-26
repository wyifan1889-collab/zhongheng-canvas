import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "@infinite-canvas/database";
import { generationResult, generationTask, mediaObject, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider,
    user, wallet, walletLedger, walletReservation, type GenerationExecutionStatus } from "@infinite-canvas/database/schema";
import { eq, sql } from "drizzle-orm";
import { getGenerationHistoryForOwner, type GenerationHistoryInput, type GenerationHistoryType } from "../src/generation-history";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Generation history tests require isolated in-memory PGlite");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const marker = "synthetic-private-history-prompt-key-provider-url", date = new Date("2026-10-26T01:02:03.456Z");
const fields = ["taskId", "type", "displayModel", "executionStatus", "deliveryStatus", "billingStatus", "credits", "createdAt", "updatedAt", "result"].sort();
beforeAll(async () => { database = await createTestDatabase(); }, 30_000);
afterAll(async () => { await database?.close(); });

async function owner() {
    const id = crypto.randomUUID();
    await database.db.insert(user).values({ id, name: "Synthetic history owner", email: `${id}@example.test` });
    return id;
}
async function task(ownerId: string, extra: Partial<typeof generationTask.$inferInsert> = {}) {
    const id = extra.id ?? crypto.randomUUID();
    await database.db.insert(generationTask).values({ id, ownerId, modelId: "accepted-public-model", inputSnapshot: { prompt: marker },
        parameterSnapshot: { private: marker }, idempotencyKey: id, requestId: id, providerTaskId: marker, createdAt: date, updatedAt: date, ...extra });
    return id;
}
async function history(ownerId: string, extra: Partial<GenerationHistoryInput> = {}) {
    return getGenerationHistoryForOwner(database.db, { ownerId, pageNumber: 1, pageSize: 50, ...extra });
}
async function published(ownerId: string, type: Exclude<GenerationHistoryType, "video">, extra: Partial<typeof generationTask.$inferInsert> = {}) {
    const suffix = crypto.randomUUID(), providerId = `history-provider-${suffix}`, modelId = `internal-${suffix}`, publicId = `public-${suffix}`;
    const draftId = crypto.randomUUID(), priceId = crypto.randomUUID(), publicationId = crypto.randomUUID();
    const rules = { schemaVersion: 1 as const, cost: null, sale: { template: type === "text" ? "text_tokens" : type === "audio" ? "audio_request" : "image_request",
        currency: "credit" as const, bands: [{ parameters: {}, rates: type === "text" ? { input_token: "2", output_token: "4" } : { request: "7" } }] } };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: marker, adapter: "openai-compatible", endpoint: "https://synthetic.invalid/v1", secretRef: marker, enabled: true });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId, providerId, providerModel: marker, displayName: marker, capability: type, enabled: true });
    await database.db.insert(modelPriceDraft).values({ id: draftId, modelId, version: 1, rules: rules as typeof modelPriceDraft.$inferInsert.rules,
        priceNote: marker, providerIdSnapshot: providerId, providerModelSnapshot: marker, adapterSnapshot: "openai-compatible", endpointSnapshot: "https://synthetic.invalid/v1", capabilitySnapshot: type });
    await database.db.transaction(async tx => {
        await tx.insert(modelPricing).values({ id: priceId, modelId, version: 1, billingUnit: type === "text" ? "text_tokens" : "request",
            creditsPerUnit: type === "text" ? null : 7, effectiveFrom: date, enabled: true });
        await tx.insert(modelPricePublication).values({ id: publicationId, pricingId: priceId, draftId, publicPriceNote: "Synthetic public accepted price" });
    });
    const id = await task(ownerId, { modelId: publicId, priceVersion: 1,
        inputSnapshot: type === "audio" ? { text: marker } : { prompt: marker },
        parameterSnapshot: type === "audio" ? { voice: "alloy", format: "mp3" } : type === "image" ? { n: 1 } : {},
        ...(type === "text" ? { textQuoteSnapshot: { schemaVersion: 1, budgetCredits: "0.1", inputCreditsPerMillion: "2", outputCreditsPerMillion: "4", usageSource: "chat_completions" } }
            : { quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7 }), ...extra });
    return { id, publicId, modelId, priceId, providerId, publicationId, draftId };
}
async function savedMedia(ownerId: string, taskId: string, kind: "image" | "audio" = "image") {
    const media = { mediaId: taskId, kind, contentType: kind === "image" ? "image/png" : "audio/mpeg", sizeBytes: 3, etag: "synthetic-history-etag" };
    await database.db.insert(mediaObject).values({ id: taskId, ownerId, objectKey: `synthetic-private/${taskId}`, kind, contentType: media.contentType, sizeBytes: media.sizeBytes, etag: media.etag });
    await database.db.insert(generationResult).values({ id: crypto.randomUUID(), ownerId, taskId, status: "succeeded", consumedUnits: 999,
        providerTaskId: marker, resultSnapshot: { kind, media, text: marker.repeat(10_000), providerUrl: marker, credential: marker } });
    return media;
}

test("all owner history keeps eight original execution states and stable fifty-row pagination", async () => {
    const ownerId = await owner(), foreign = await owner();
    const states: GenerationExecutionStatus[] = ["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"];
    const ids = Array.from({ length: 57 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`);
    await database.db.insert(generationTask).values(ids.map((id, index) => ({ id, ownerId, modelId: "historical-original-model",
        inputSnapshot: { prompt: marker }, parameterSnapshot: { private: marker }, idempotencyKey: id, requestId: id,
        executionStatus: states[index % states.length], unknownReason: marker, createdAt: date, updatedAt: date })));
    await task(foreign, { executionStatus: "succeeded" });
    const first = await history(ownerId), second = await history(ownerId, { pageNumber: 2 }), absent = await history(ownerId, { pageNumber: 3 });
    expect(first.total).toBe(57); expect(first.pageNumber).toBe(1); expect(first.pageSize).toBe(50);
    expect(first.items.map(row => row.taskId)).toEqual([...ids].reverse().slice(0, 50));
    expect(second.items.map(row => row.taskId)).toEqual([...ids].reverse().slice(50));
    expect(absent).toEqual({ items: [], total: 57, pageNumber: 3, pageSize: 50 });
    expect(new Set(first.items.map(row => row.executionStatus))).toEqual(new Set(states));
    for (const item of [...first.items, ...second.items]) {
        expect(Object.keys(item).sort()).toEqual(fields);
        expect(item).toMatchObject({ type: null, displayModel: "historical-original-model", credits: null, result: null, createdAt: date.toISOString(), updatedAt: date.toISOString() });
    }
    for (const status of ["succeeded", "failed", "running", "queued", "pending"] as const) {
        const filtered = await history(ownerId, { status, pageSize: 2 });
        const expected = ids.filter((_, index) => states[index % states.length] === status).reverse();
        expect(filtered.total).toBe(expected.length); expect(filtered.items.map(item => item.taskId)).toEqual(expected.slice(0, 2));
        expect(filtered.items.every(item => item.executionStatus === status)).toBe(true);
    }
    expect(JSON.stringify(first)).not.toContain(marker);
});

test("type comes from original publication identity rather than mutable catalog labels or provider bindings", async () => {
    const ownerId = await owner();
    const image = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "pending" });
    const text = await published(ownerId, "text"), audio = await published(ownerId, "audio");
    const legacy = await task(ownerId, { modelId: image.publicId }), wrongVersion = await task(ownerId, { modelId: image.publicId, priceVersion: 99 });
    await database.db.update(modelCatalog).set({ displayName: "Changed current label", capability: "video", providerModel: "different-current-model", enabled: false }).where(eq(modelCatalog.id, image.modelId));
    await database.db.update(modelProvider).set({ endpoint: "https://changed.invalid/v1", enabled: false }).where(eq(modelProvider.id, image.providerId));
    await database.db.update(modelPricing).set({ enabled: false }).where(eq(modelPricing.id, image.priceId));
    const all = await history(ownerId), byId = new Map(all.items.map(item => [item.taskId, item]));
    expect(all.total).toBe(5); expect(byId.get(image.id)).toMatchObject({ type: "image", displayModel: image.publicId, executionStatus: "succeeded", deliveryStatus: "pending" });
    expect(byId.get(text.id)?.type).toBe("text"); expect(byId.get(audio.id)?.type).toBe("audio");
    expect(byId.get(legacy)?.type).toBeNull(); expect(byId.get(wrongVersion)?.type).toBeNull();
    for (const [type, id] of [["image", image.id], ["text", text.id], ["audio", audio.id]] as const) {
        const filtered = await history(ownerId, { type }); expect(filtered.total).toBe(1); expect(filtered.items.map(row => row.taskId)).toEqual([id]);
    }
    expect(await history(ownerId, { type: "video" })).toEqual({ items: [], total: 0, pageNumber: 1, pageSize: 50 });
    expect((await history(ownerId, { type: "image", status: "failed" })).total).toBe(0);
    const mismatch = await published(ownerId, "image");
    await database.db.update(modelCatalog).set({ publicId: `renamed-${mismatch.publicId}` }).where(eq(modelCatalog.id, mismatch.modelId));
    expect((await history(ownerId)).items.find(item => item.taskId === mismatch.id)?.type).toBeNull();
    expect((await history(ownerId, { type: "image" })).total).toBe(1);
    expect(JSON.stringify(all)).not.toMatch(/Changed current label|different-current-model|synthetic-private/);
});

test("credits are exact captured decimals and require reciprocal reservation links plus consistent states", async () => {
    const ownerId = await owner(), foreign = await owner();
    const cases: Array<{ requested?: string; captured?: string; released?: string; status?: "pending" | "captured" | "released" | "expired";
        billing?: "reserved" | "captured" | "released" | "pending_review" | "unbilled"; expected: string | null; foreign?: boolean; wrongTask?: boolean; unlinked?: boolean }> = [
        { expected: "0" },
        { captured: "2.345678901234567890", released: "7.654321098765432110", status: "captured", billing: "captured", expected: "2.34567890123456789" },
        { released: "10", status: "released", billing: "released", expected: "0" },
        { captured: "1.25", released: "2.25", billing: "pending_review", expected: "1.25" },
        { requested: "9007199254740994", captured: "9007199254740993.0000000000000001", billing: "pending_review", expected: "9007199254740993.0000000000000001" },
        { captured: "10", status: "pending", billing: "pending_review", expected: null },
        { released: "10", status: "captured", billing: "captured", expected: null },
        { released: "1", status: "released", billing: "released", expected: null },
        { status: "expired", billing: "pending_review", expected: null },
        { billing: "unbilled", expected: null },
        { captured: "10", status: "captured", billing: "reserved", expected: null },
        { captured: "1", billing: "captured", expected: null },
        { foreign: true, expected: null }, { wrongTask: true, expected: null }, { unlinked: true, expected: null },
    ];
    const expected = new Map<string, string | null>();
    for (const example of cases) {
        const id = crypto.randomUUID(), reservationId = crypto.randomUUID();
        await database.db.insert(walletReservation).values({ id: reservationId, userId: example.foreign ? foreign : ownerId,
            taskId: example.wrongTask ? crypto.randomUUID() : id, requestedUnits: example.requested ?? "10", capturedUnits: example.captured ?? "0", releasedUnits: example.released ?? "0",
            status: example.status ?? "pending", idempotencyKey: reservationId });
        await task(ownerId, { id, reservationId: example.unlinked ? undefined : reservationId, billingStatus: example.billing ?? "reserved",
            quotedUnits: 999, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 999 });
        expected.set(id, example.expected);
    }
    const noEvidence = await task(ownerId, { billingStatus: "captured", quotedUnits: 777 }); expected.set(noEvidence, null);
    const before = await Promise.all([database.db.select().from(wallet), database.db.select().from(walletLedger), database.db.select().from(walletReservation)]);
    const response = await history(ownerId);
    for (const item of response.items) expect(item.credits).toBe(expected.get(item.taskId));
    expect(response.total).toBe(cases.length + 1);
    expect(await Promise.all([database.db.select().from(wallet), database.db.select().from(walletLedger), database.db.select().from(walletReservation)])).toEqual(before);
});

test("saved image and audio expose only matching private relative media URLs while text has no preview", async () => {
    const ownerId = await owner();
    const image = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "saved" });
    const audio = await published(ownerId, "audio", { executionStatus: "succeeded", deliveryStatus: "visible" });
    const text = await published(ownerId, "text", { executionStatus: "succeeded", deliveryStatus: "saved" });
    const legacy = await task(ownerId, { executionStatus: "succeeded", deliveryStatus: "saved" });
    await savedMedia(ownerId, image.id); await savedMedia(ownerId, audio.id, "audio"); await savedMedia(ownerId, text.id); await savedMedia(ownerId, legacy);
    const response = await history(ownerId), items = new Map(response.items.map(item => [item.taskId, item]));
    expect(items.get(image.id)?.result).toEqual({ url: `/api/v1/media/${image.id}` });
    expect(items.get(audio.id)?.result).toEqual({ url: `/api/v1/media/${audio.id}` });
    expect(items.get(text.id)?.result).toBeNull();
    expect(items.get(legacy)).toMatchObject({ type: "image", result: { url: `/api/v1/media/${legacy}` } });
    expect(JSON.stringify(response)).not.toMatch(/synthetic-private|credential|objectKey|providerTaskId|consumedUnits|resultSnapshot|thumbnailUrl/);
    for (const item of response.items) expect(Object.keys(item).sort()).toEqual(fields);
});

test("legacy image proof is shared by count/filter/page and never bypasses a conflicting publication", async () => {
    const ownerId = await owner(), foreign = await owner();
    const id = await task(ownerId, { executionStatus: "succeeded", deliveryStatus: "visible", modelId: "unlisted-legacy-model" });
    const media = await savedMedia(ownerId, id);
    const accepted = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "saved" });
    await savedMedia(ownerId, accepted.id);
    await database.db.update(modelCatalog).set({ publicId: `renamed-${accepted.publicId}` }).where(eq(modelCatalog.id, accepted.modelId));
    const verify = async (allowed: boolean) => {
        const all = await history(ownerId), item = all.items.find(item => item.taskId === id);
        expect(item?.type).toBe(allowed ? "image" : null);
        expect(item?.result).toEqual(allowed ? { url: `/api/v1/media/${id}` } : null);
        const filtered = await history(ownerId, { type: "image", pageSize: 1 });
        expect(filtered.total).toBe(allowed ? 1 : 0); expect(filtered.items.map(item => item.taskId)).toEqual(allowed ? [id] : []);
        expect(all.items.find(item => item.taskId === accepted.id)).toMatchObject({ type: null, result: null });
        expect((await history(foreign)).total).toBe(0);
    };
    await verify(true);
    for (const patch of [{ mediaId: crypto.randomUUID() }, { mediaId: id.toUpperCase() }, { kind: "audio" }, { contentType: "image/jpeg" },
        { sizeBytes: "3" }, { sizeBytes: 4 }, { sizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { etag: "wrong" }, { etag: "bad\netag" }]) {
        await database.db.update(generationResult).set({ resultSnapshot: { kind: "image", media: { ...media, ...patch } } }).where(eq(generationResult.taskId, id));
        await verify(false);
    }
    await database.db.update(generationResult).set({ resultSnapshot: { kind: "image", media } }).where(eq(generationResult.taskId, id));
    await database.db.update(generationResult).set({ resultSnapshot: sql`jsonb_set(${generationResult.resultSnapshot}, '{media,sizeBytes}', '3.00000000000000000001'::jsonb)` }).where(eq(generationResult.taskId, id));
    await verify(false);
    await database.db.update(generationResult).set({ resultSnapshot: { kind: "image", media }, ownerId: foreign }).where(eq(generationResult.taskId, id)); await verify(false);
    await database.db.update(generationResult).set({ ownerId, status: "unknown", unknownReason: marker }).where(eq(generationResult.taskId, id)); await verify(false);
    await database.db.update(generationResult).set({ status: "succeeded", unknownReason: null }).where(eq(generationResult.taskId, id));
    await database.db.update(mediaObject).set({ ownerId: foreign }).where(eq(mediaObject.id, id)); await verify(false);
    await database.db.update(mediaObject).set({ ownerId }).where(eq(mediaObject.id, id));
    await database.db.update(generationTask).set({ deliveryStatus: "unknown" }).where(eq(generationTask.id, id)); await verify(false);
    await database.db.update(generationTask).set({ deliveryStatus: "saved", executionStatus: "running" }).where(eq(generationTask.id, id)); await verify(false);
    await database.db.update(generationTask).set({ executionStatus: "succeeded" }).where(eq(generationTask.id, id)); await verify(true);
});

test("malformed media scalars never throw, leak bytes or produce a URL, and keep the history row", async () => {
    const ownerId = await owner(), image = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "saved" });
    const media = await savedMedia(ownerId, image.id);
    const invalid: unknown[] = [null, [], {}, { ...media, mediaId: image.id.toUpperCase() }, { ...media, mediaId: `https://foreign.invalid/${image.id}` },
        { ...media, mediaId: { private: marker.repeat(10_000) } }, { ...media, mediaId: "x".repeat(200_000) },
        { ...media, kind: "audio" }, { ...media, kind: ["image"] }, { ...media, contentType: "image/jpeg" }, { ...media, contentType: ["image/png"] },
        { ...media, sizeBytes: "3" }, { ...media, sizeBytes: 0 }, { ...media, sizeBytes: 4 }, { ...media, sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
        { ...media, etag: "different" }, { ...media, etag: [media.etag] }, { ...media, etag: "x".repeat(201) },
        { ...media, contentType: { private: marker.repeat(10_000) } }, { ...media, sizeBytes: { private: marker.repeat(10_000) } }];
    for (const invalidMedia of invalid) {
        await database.db.update(generationResult).set({ resultSnapshot: { kind: "image", media: invalidMedia, private: marker } }).where(eq(generationResult.taskId, image.id));
        const response = await history(ownerId); expect(response.total).toBe(1); expect(response.items[0].taskId).toBe(image.id); expect(response.items[0].result).toBeNull();
    }
    for (const kind of ["text", ["image"], { private: marker.repeat(10_000) }, "x".repeat(200_000), null]) {
        await database.db.update(generationResult).set({ resultSnapshot: { kind, media } }).where(eq(generationResult.taskId, image.id));
        expect((await history(ownerId)).items[0].result).toBeNull();
    }
    await database.db.update(generationResult).set({ resultSnapshot: { kind: "image", media } }).where(eq(generationResult.taskId, image.id));
    expect((await history(ownerId)).items[0].result).toEqual({ url: `/api/v1/media/${image.id}` });
});

test("a fractional JSON media size cannot round into the actual integer byte count", async () => {
    const ownerId = await owner(), image = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "saved" });
    await savedMedia(ownerId, image.id);
    for (const exactSize of ["3.00000000000000000001", "2.99999999999999999999"]) {
        await database.db.update(generationResult).set({ resultSnapshot: sql`jsonb_set(${generationResult.resultSnapshot}, '{media,sizeBytes}', ${exactSize}::jsonb)` })
            .where(eq(generationResult.taskId, image.id));
        const response = await history(ownerId); expect(response.total).toBe(1); expect(response.items[0].result).toBeNull();
    }
    await database.db.update(generationResult).set({ resultSnapshot: sql`jsonb_set(${generationResult.resultSnapshot}, '{media,sizeBytes}', '3.000'::jsonb)` })
        .where(eq(generationResult.taskId, image.id));
    expect((await history(ownerId)).items[0].result).toEqual({ url: `/api/v1/media/${image.id}` });
});

test("private media requires successful task/result, saved delivery and the original task-owned media identity", async () => {
    const ownerId = await owner(), foreign = await owner(), image = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "saved" });
    const media = await savedMedia(ownerId, image.id);
    for (const patch of [{ executionStatus: "running" as const }, { executionStatus: "succeeded" as const, deliveryStatus: "pending" as const },
        { deliveryStatus: "unknown" as const }, { deliveryStatus: "failed" as const }]) {
        await database.db.update(generationTask).set(patch).where(eq(generationTask.id, image.id)); expect((await history(ownerId)).items[0].result).toBeNull();
    }
    await database.db.update(generationTask).set({ executionStatus: "succeeded", deliveryStatus: "saved" }).where(eq(generationTask.id, image.id));
    await database.db.update(generationResult).set({ status: "unknown", unknownReason: marker }).where(eq(generationResult.taskId, image.id));
    expect((await history(ownerId)).items[0].result).toBeNull();
    await database.db.update(generationResult).set({ status: "succeeded", ownerId: foreign }).where(eq(generationResult.taskId, image.id));
    expect((await history(ownerId)).items[0].result).toBeNull();
    await database.db.update(generationResult).set({ ownerId }).where(eq(generationResult.taskId, image.id));
    await database.db.update(mediaObject).set({ ownerId: foreign }).where(eq(mediaObject.id, image.id));
    expect((await history(ownerId)).items[0].result).toBeNull();
    await database.db.update(mediaObject).set({ ownerId }).where(eq(mediaObject.id, image.id));
    const other = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "saved" }), otherMedia = await savedMedia(ownerId, other.id);
    await database.db.update(generationResult).set({ resultSnapshot: { kind: "image", media: otherMedia } }).where(eq(generationResult.taskId, image.id));
    expect((await history(ownerId)).items.find(item => item.taskId === image.id)?.result).toBeNull();
    await database.db.update(generationResult).set({ resultSnapshot: { kind: "image", media } }).where(eq(generationResult.taskId, image.id));
    await database.db.update(mediaObject).set({ etag: "changed-actual-etag" }).where(eq(mediaObject.id, image.id));
    expect((await history(ownerId)).items.find(item => item.taskId === image.id)?.result).toBeNull();
    await database.db.update(mediaObject).set({ etag: media.etag }).where(eq(mediaObject.id, image.id));
    await database.db.delete(mediaObject).where(eq(mediaObject.id, image.id));
    const response = await history(ownerId); expect(response.total).toBe(2); expect(response.items.find(item => item.taskId === image.id)?.result).toBeNull();
});

test("page/count use two minimal owner-filtered selects in one read-only repeatable snapshot", async () => {
    const ownerId = await owner(), image = await published(ownerId, "image", { executionStatus: "succeeded", deliveryStatus: "saved" });
    await savedMedia(ownerId, image.id);
    const observed = observeReads(database.db);
    const response = await getGenerationHistoryForOwner(observed.db, { ownerId, type: "image", status: "succeeded", pageNumber: 1, pageSize: 50 });
    expect(response.total).toBe(1); expect(observed.configs).toEqual([{ isolationLevel: "repeatable read", accessMode: "read only" }]);
    expect(observed.selections).toHaveLength(2); expect(observed.statements).toHaveLength(2);
    expect(Object.keys(observed.selections[0] as object)).toEqual(["total"]);
    expect(Object.keys(observed.selections[1] as object).sort()).toEqual(["taskId", "type", "modelId", "title", "executionStatus", "deliveryStatus", "billingStatus", "createdAt", "updatedAt",
        "reservationStatus", "requested", "captured", "released", "resultStatus", "resultKind", "referenceId", "referenceKind", "referenceContentType", "referenceSize", "referenceEtag",
        "mediaId", "mediaKind", "mediaContentType", "mediaSize", "mediaEtag"].sort());
    for (const statement of observed.statements) {
        expect(statement.sql).not.toMatch(/input_snapshot|parameter_snapshot|provider_model|display_name|object_key|unknown_reason|consumed_units|quoted_units|text_quote_snapshot|wallet_ledger/i);
        expect(statement.sql).not.toMatch(/"result_snapshot"\s*(?:,|\bas\b|\bfrom\b)/i);
        expect(statement.sql).toContain('"owner_id" ='); expect(statement.sql).toContain('"version" = "canvas_saas"."generation_task"."price_version"');
        expect(statement.sql).toContain('"public_id" = "canvas_saas"."generation_task"."model_id"');
        expect(statement.sql).not.toMatch(/\binner join\b/i); expect(statement.params.slice(0, 3)).toEqual([ownerId, "image", "succeeded"]);
    }
    const where = (text: string) => text.split(" where ")[1].split(" order by ")[0];
    expect(where(observed.statements[0].sql)).toBe(where(observed.statements[1].sql));
    expect(observed.statements[1].sql).toContain("->'media'->'sizeBytes'");
    expect(observed.statements[1].sql).toContain("jsonb_typeof("); expect(observed.statements[1].sql).toContain("BETWEEN 1 AND 200");
    expect(observed.statements[1].sql).toContain('= to_jsonb("canvas_saas"."media_object"."size_bytes")');
    expect(observed.statements[1].sql).toContain('"created_at" desc, "canvas_saas"."generation_task"."id" desc');
});

test("invalid input rejects before any read and database faults never become an empty history", async () => {
    let transactions = 0;
    const failure = new Error("Synthetic history database unavailable");
    const unavailable = { transaction() { transactions++; throw failure; } } as unknown as Database;
    const good = { ownerId: "synthetic-owner", pageNumber: 1, pageSize: 50 };
    const invalid: unknown[] = [{ ownerId: "" }, { ownerId: null }, { ownerId: "x".repeat(201) }, { pageNumber: 0 }, { pageNumber: 1.5 },
        { pageNumber: "1" }, { pageNumber: Number.MAX_SAFE_INTEGER, pageSize: 50 }, { pageSize: 0 }, { pageSize: 51 }, { pageSize: NaN },
        { type: "all" }, { type: "" }, { type: null }, { status: "unknown" }, { status: "cancelled" }, { status: "timeout" }, { status: null }];
    for (const patch of invalid) await expect(getGenerationHistoryForOwner(unavailable, { ...good, ...(patch as object) } as GenerationHistoryInput)).rejects.toMatchObject({ code: "invalid_input" });
    expect(transactions).toBe(0);
    await expect(getGenerationHistoryForOwner(unavailable, good)).rejects.toBe(failure); expect(transactions).toBe(1);
    const ownerId = await owner();
    for (const at of [1, 2]) {
        const fault = observeReads(database.db, { at, error: failure });
        await expect(getGenerationHistoryForOwner(fault.db, { ownerId, pageNumber: 1, pageSize: 50 })).rejects.toBe(failure);
        expect(fault.statements).toHaveLength(at);
    }
    const bounded = await history(ownerId, { pageNumber: Number.MAX_SAFE_INTEGER, pageSize: 1 });
    expect(bounded).toEqual({ items: [], total: 0, pageNumber: Number.MAX_SAFE_INTEGER, pageSize: 1 });
});

function observeReads(db: Database, fault?: { at: number; error: Error }) {
    const configs: unknown[] = [], selections: unknown[] = [], statements: Array<{ sql: string; params: unknown[] }> = [];
    const queryProxy = (target: any): any => new Proxy(target, { get(query, property) {
        const value = Reflect.get(query, property, query);
        if (property === "then") return (...args: unknown[]) => {
            statements.push(query.toSQL());
            if (fault?.at === statements.length) { const rejected = Promise.reject(fault.error); return Reflect.apply(rejected.then, rejected, args); }
            return Reflect.apply(value, query, args);
        };
        return typeof value === "function" ? (...args: unknown[]) => {
            const next = Reflect.apply(value, query, args); return next && typeof next.toSQL === "function" ? queryProxy(next) : next;
        } : value;
    } });
    const observed = new Proxy(db, { get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: Database) => Promise<unknown>, config: unknown) => {
            configs.push(config);
            return target.transaction(tx => callback(new Proxy(tx, { get(transaction, key, transactionReceiver) {
                if (key !== "select") return Reflect.get(transaction, key, transactionReceiver);
                return (...args: unknown[]) => { selections.push(args[0]); return queryProxy(Reflect.apply(transaction.select, transaction, args)); };
            } }) as Database), config as never);
        };
    } });
    return { db: observed as Database, configs, selections, statements };
}
