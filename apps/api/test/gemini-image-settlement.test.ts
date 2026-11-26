import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { createJobQueue, type GenerationJobPayload } from "@infinite-canvas/jobs";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { generationResult, generationTask, modelCatalog, modelProvider, storageQuota, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createMemoryObjectStorage, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import { GEMINI_IMAGE_PROTOCOL } from "../../../packages/shared/src/generation-gemini-image";
import { createAccountApi } from "../src/accounts";
import { getAdminGenerationTaskDetail } from "../src/admin-generation-query";
import { readContentSafetyConfig } from "../src/content-safety-config";
import { createGeminiImageDeliveryVerifier, createGenerationDelivery } from "../src/generation-delivery";
import { generationImageMediaId } from "../src/generation-image";
import { createGenerationProvider } from "../src/generation-provider";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { runGenerationWorkerSchemaOperation } from "../src/generation-worker-schema";
import { accountPolicy } from "../src/policy";
import { createProviderGateway } from "../src/provider-gateway";
import { createTestDatabase, postgresTestUrl } from "./database";
import { expectCurrentMigrations } from "./migrations";

const origin = "https://gemini-isolation.example.test", endpoint = "https://provider.example.test/";
const authSecret = `synthetic-gemini-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const draftPath = "/api/v1/admin/model-price-drafts", publishPath = "/api/v1/admin/model-price-publications";
const quotePath = "/api/v1/generation/quote", taskPath = "/api/v1/generation/tasks";
const spec = { aspectRatio: "1:1", imageSize: "512" } as const;
const portrait = { aspectRatio: "16:9", imageSize: "512" } as const;
const maxBytes = { image: 100_000, audio: 100_000, video: 100_000 };
const quotaBytes = maxBytes.image * 10;
const sharedStorage = createMemoryObjectStorage();
const jobs: GenerationJobPayload[] = [];
if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE !== "gemini-image-settlement")
    throw new Error("Gemini settlement tests require their own isolated database");
const nativeUrl = postgresTestUrl();
let nativeQueue: ReturnType<typeof createJobQueue> | undefined;
type Actor = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>, api: ReturnType<typeof createAccountApi>, closedApi: typeof api;
let admin: Actor, buyer: Actor, other: Actor, png: Buffer, png2: Buffer, wrongSize: Buffer;
let rejectQueue = false;

function request(path: string, actor?: Actor, body?: unknown, key?: string, handler = api) {
    return handler(new Request(new URL(path, origin), { method: body === undefined ? "GET" : "POST",
        headers: { origin, "content-type": "application/json", ...(actor ? { cookie: actor.cookie, "x-canvas-account-id": actor.id } : {}),
            ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "198.51.100.112");
}

async function register(name: string) {
    const email = `${name}-${crypto.randomUUID()}@example.test`, password = "synthetic-gemini-isolated-password";
    expect((await request("/api/auth/sign-up/email", undefined, { name, email, password })).status).toBe(200);
    const [row] = await database.db.update(user).set({ emailVerified: true }).where(eq(user.email, email)).returning();
    const login = await request("/api/auth/sign-in/email", undefined, { email, password });
    expect(login.status).toBe(200);
    return { id: row.id, cookie: login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ") };
}

beforeAll(async () => {
    database = await createTestDatabase();
    await expectCurrentMigrations({ query: text => database.db.execute(sql.raw(text)) });
    if (nativeUrl) {
        const installed = await runGenerationWorkerSchemaOperation({ env: { GENERATION_WORKER_ENABLED: "true", GENERATION_WORKER_ENVIRONMENT: "staging",
            GENERATION_WORKER_QUEUE_URL: nativeUrl, SAAS_DATABASE_URL: nativeUrl, SAAS_ORIGIN: origin }, apply: true });
        expect(installed.queue).toMatchObject({ state: "ready", applied: true, settings: { policy: "standard", retryLimit: 0 } });
        nativeQueue = createJobQueue(nativeUrl, () => {});
        await nativeQueue.start();
    }
    const createApi = (geminiImageEnabled: boolean) => createAccountApi({ database: database.db, origin,
        auth: { secret: authSecret, sendVerificationEmail: async () => undefined }, rates: createRateStore(database.pool, authSecret),
        verifyHuman: async () => true, onFault: () => {},
        policy: { ...accountPolicy, save: { ...accountPolicy.save, points: 1000 } },
        contentSafety: readContentSafetyConfig({ SAAS_GENERATION_IP_RATE_POINTS: "1000", SAAS_GENERATION_USER_RATE_POINTS: "1000" }),
        media: { storage: sharedStorage, quotaBytes, maxBytes }, generation: { enabled: true, imageEnabled: true, geminiImageEnabled,
            queue: { async send(name, payload, connection) {
                expect(connection?.db).toBeDefined();
                const id = nativeQueue ? await nativeQueue.send(name, payload, connection) : crypto.randomUUID();
                if (rejectQueue) return null;
                expect(id).toBeTruthy();
                jobs.push(payload);
                return id;
            } } },
    });
    api = createApi(true); closedApi = createApi(false);
    admin = await register("admin"); buyer = await register("buyer"); other = await register("other");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await database.db.insert(wallet).values([{ userId: buyer.id, availableUnits: "1000" }, { userId: other.id, availableUnits: "6" }]);
    const make = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
    [png, png2, wrongSize] = await Promise.all([make(512, 512, "red"), make(512, 512, "blue"), make(64, 64, "green")]);
}, 30_000);
afterAll(async () => { try { await nativeQueue?.stop(); } finally { await database?.close(); } });

async function saveAndPublish(model: ModelPriceDraftWrite, priceVersion = 0) {
    const drafted = await request(draftPath, admin, model);
    expect(drafted.status).toBe(201);
    const { draft } = await drafted.json();
    const publicationInput = { modelId: model.modelId, draftId: draft.id, binding: model.binding,
        expectedDraftVersion: draft.version, expectedPriceVersion: priceVersion, publicPriceNote: "仅隔离用例：按张" };
    expect((await request(publishPath, admin, publicationInput, undefined, closedApi)).status).toBe(409);
    const published = await request(publishPath, admin, publicationInput);
    expect(published.status).toBe(200);
    return (await published.json()).publication;
}

async function fixture(providerModel = "gemini-3.1-flash-image-preview") {
    const id = crypto.randomUUID(), modelId = `img-${id}`, providerId = `gemini-fixture-${id}`;
    const binding = { providerId, providerModel, endpoint, adapter: "openai-compatible" as const, capability: "image" as const };
    const squareSpec = { ...spec, imageSize: providerModel === "gemini-3-pro-image-preview" ? "1K" as const : "512" as const };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Gemini fixture", endpoint,
        adapter: binding.adapter, secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, authSecret, providerId, "synthetic-not-a-key");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, displayName: "Gemini fixture",
        capability: "image", providerModel: binding.providerModel, enabled: true });
    const draft: ModelPriceDraftWrite = { modelId, binding, expectedVersion: 0, priceNote: "private fixture note",
        rules: { schemaVersion: 1, cost: { template: "image_count", currency: "CNY", bands: [{ parameters: squareSpec, rates: { image: null } }] },
            sale: { template: "image_count", currency: "credit", bands: [{ parameters: squareSpec, rates: { image: "7" } },
                { parameters: { ...portrait, imageSize: squareSpec.imageSize }, rates: { image: "7" } }] } } };
    const publication = await saveAndPublish(draft);
    expect(publication).toMatchObject({ billingUnit: "image_specs", protocol: GEMINI_IMAGE_PROTOCOL, usagePolicy: "delivered_images" });
    const intent = { modelId, input: { prompt: "synthetic test image" }, projectId: "gemini-fixture-project", nodeId: "gemini-fixture-node",
        parameters: { protocol: GEMINI_IMAGE_PROTOCOL, ...squareSpec, budgetCredits: 17 } };
    return { intent, draft, publication };
}

async function submit(intent: Awaited<ReturnType<typeof fixture>>["intent"], actor = buyer) {
    const response = await request(quotePath, actor, intent);
    expect(response.status).toBe(200);
    const { quote } = await response.json();
    const key = crypto.randomUUID();
    const body = { ...intent, confirmedPriceVersion: quote.priceVersion, confirmedQuoteFingerprint: quote.quoteFingerprint };
    return { quote, key, body, send: () => request(taskPath, actor, body, key) };
}

const imagePart = (body: Buffer) => ({ inlineData: { mimeType: "image/png", data: body.toString("base64") } });
function response(images: Buffer[], finishReason = "STOP") {
    return { candidates: [{ index: 0, finishReason, content: { role: "model", parts: [{ text: "https://provider.example.test/same-image.png" },
        ...images.map(imagePart)] } }], usageMetadata: { promptTokenCount: 11, totalTokenCount: 19 } };
}

async function run(payload: unknown, { status = 200, storage = sharedStorage, providerModel }: { status?: number; storage?: ObjectStorage; providerModel?: string } = {}) {
    const model = await fixture(providerModel), confirmed = await submit(model.intent);
    const accepted = await confirmed.send();
    expect(accepted.status).toBe(201);
    const { task } = await accepted.json();
    const job = jobs.find(item => item.taskId === task.id)!;
    const resources = { database: database.db, storage, quotaBytes, maxBytes }, calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const gateway = createProviderGateway(async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-not-a-key");
        return Response.json(payload, { status });
    }, async () => ["93.184.216.34"]);
    const dependencies = { provider: createGenerationProvider({ database: database.db, authSecret, imageMaxBytes: maxBytes.image, gateway }),
        deliver: createGenerationDelivery(resources), settleBilling: createGenerationWalletSettlement(database.db, {
            verifyGeminiImageDelivery: createGeminiImageDeliveryVerifier(resources),
        }) };
    return { ...model, task, job, calls, dependencies, confirmed, process: () => processGenerationJob(database.db, job, dependencies) };
}

function assignedMedia(taskId: string, index = 0) {
    return generationImageMediaId(taskId, index);
}
async function assertLedger(taskId: string, charge: number, release: number) {
    const store = createWalletRepository(database.db);
    const reservation = await store.getReservationForTask(buyer.id, taskId);
    expect(reservation).toMatchObject({ requestedUnits: "17", capturedUnits: String(charge), releasedUnits: String(release),
        status: charge ? "captured" : release ? "released" : "pending" });
    const entries = await database.db.select().from(walletLedger).where(eq(walletLedger.referenceId, taskId));
    expect(entries.map(row => [row.kind, Number(row.deltaReservedUnits), Number(row.deltaAvailableUnits)]).sort()).toEqual([
        ["reserve", 17, -17], ...(charge ? [["capture", -charge, 0]] : []), ...(release ? [["release", -release, release]] : []),
    ].sort());
}

/** Optional public receipt export for the offline examples. Only synthetic in-memory fixtures may export. */
async function demoReceipt(scenario: Awaited<ReturnType<typeof run>>, returned: number) {
    if (nativeUrl || process.env.GEMINI_IMAGE_DEMO_EXPORT !== "1") return;
    const detail = await getAdminGenerationTaskDetail(database.db, scenario.task.id);
    const held = detail.reservation.details;
    if (!held || !detail.result) throw new Error("Missing example ledger");
    console.info("GEMINI_RECEIPT " + JSON.stringify({ taskId: detail.task.id, model: scenario.draft.binding.providerModel,
        returned, delivered: detail.result.consumedUnits ?? 0, billing: detail.task.billingStatus, supplierCalls: scenario.calls.length,
        unit: scenario.confirmed.quote.creditsPerUnit, budget: held.requestedUnits, captured: held.capturedUnits,
        released: held.releasedUnits, remaining: held.remainingUnits,
        ledger: detail.ledger.map(entry => ({ kind: entry.kind, available: entry.deltaAvailableUnits, held: entry.deltaReservedUnits })) }));
}

test("IMG-04 rejects unconfirmed/mutated quotes, cross-account confirmations, and failed atomic admission", async () => {
    const model = await fixture(), pending = await submit(model.intent), poor = await submit(model.intent, other);
    expect(pending.quote).toMatchObject({ billingUnit: "image", creditsPerUnit: 7, quotedUnits: 17, priceVersion: 1, usagePolicy: "delivered_images" });
    for (const field of ["pricePublicationId", "binding", "providerId", "endpoint"]) expect(pending.quote).not.toHaveProperty(field);
    const { confirmedQuoteFingerprint: _, ...unconfirmed } = pending.body;
    const state = async () => [await database.db.select().from(generationTask), await database.db.select().from(wallet),
        await database.db.select().from(walletReservation), await database.db.select().from(walletLedger),
        ...(nativeUrl ? [(await database.db.execute(sql`SELECT id::text,data FROM canvas_jobs.job ORDER BY id`)).rows] : [])];
    const before = await state(), jobsBefore = jobs.length;
    for (const [actor, body] of [[buyer, unconfirmed], [other, pending.body],
        [buyer, { ...pending.body, input: { prompt: "changed" } }],
        [buyer, { ...pending.body, parameters: { ...model.intent.parameters, budgetCredits: 18 } }],
        [buyer, { ...pending.body, parameters: { ...model.intent.parameters, ...portrait } }]] as const) {
        expect((await request(taskPath, actor, body, pending.key)).status).toBe(409);
    }
    expect((await request(quotePath, buyer, model.intent, undefined, closedApi)).status).toBe(503);
    expect((await poor.send()).status).toBe(402);
    rejectQueue = true;
    try { expect((await pending.send()).status).toBe(503); } finally { rejectQueue = false; }
    expect(jobs).toHaveLength(jobsBefore);
    expect(await state()).toEqual(before);
});

test("IMG-04 publication rotation invalidates a new submission but preserves an accepted task and its original reservation", async () => {
    const current = await run(response([png, png2]));
    const pending = await submit(current.intent);
    const next = structuredClone(current.draft);
    next.expectedVersion = 1;
    next.rules.sale.bands[0].rates.image = "11";
    expect((await saveAndPublish(next, 1)).priceVersion).toBe(2);
    expect((await pending.send()).status).toBe(409);
    const before = jobs.length, reopened = await current.confirmed.send();
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).task).toMatchObject({ id: current.task.id, priceVersion: 1, quotedUnits: 17, creditsPerUnitSnapshot: 7 });
    expect(jobs).toHaveLength(before);
    if (nativeUrl) expect((await database.db.execute(sql`SELECT count(*)::int AS count FROM canvas_jobs.job WHERE data->>'taskId'=${current.task.id}`)).rows).toEqual([{ count: 1 }]);
    expect((await current.process()).task.billingStatus).toBe("captured");
    await assertLedger(current.task.id, 14, 3);
    expect(current.calls).toHaveLength(1);
});

for (const count of [1, 2]) test(`IMG-04 privately delivers ${count} PNG(s), then charges for that count and releases the rest`, async () => {
    const current = await run(response([png, png2].slice(0, count))), id = current.task.id;
    const finished = await current.process();
    expect(finished.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(finished.result.consumedUnits).toBe(count);
    expect(current.calls).toEqual([{ url: endpoint + "v1beta/models/gemini-3.1-flash-image-preview:generateContent",
        body: { contents: [{ role: "user", parts: [{ text: current.intent.input.prompt }] }],
            generationConfig: { candidateCount: 1, responseModalities: ["IMAGE"], imageConfig: spec } } }]);
    const visible = await request(`${taskPath}/${id}`, buyer);
    expect(visible.status).toBe(200);
    const receipt = await visible.json();
    expect(receipt.task.billing).toMatchObject({ reservedCredits: "17", capturedCredits: String(7 * count), releasedCredits: String(17 - 7 * count) });
    expect(JSON.stringify(receipt)).not.toContain("geminiBatch");
    expect(JSON.stringify(receipt)).not.toContain("same-image.png");
    for (let index = 0; index < count; index++) {
        expect((await request(`/api/v1/media/${assignedMedia(id, index)}`, buyer)).status).toBe(200);
        expect((await request(`/api/v1/media/${assignedMedia(id, index)}`, other)).status).toBe(404);
    }
    expect((await getAdminGenerationTaskDetail(database.db, id)).priceSnapshot.status).toBe("recorded");
    const previousQuota = await createMediaRepository(database.db).getQuota(buyer.id);
    expect((await current.process()).replay).toBe(true);
    expect(await createMediaRepository(database.db).getQuota(buyer.id)).toEqual(previousQuota);
    expect(current.calls).toHaveLength(1);
    await assertLedger(id, count * 7, 17 - count * 7);
    await demoReceipt(current, count);
});

test("IMG-04 holds the entire reservation for over-budget, incomplete, blocked, damaged or wrong-size image results", async () => {
    for (const [payload, reason] of [[response([png, png2, png]), "gemini_image_budget_exceeded"],
        [response([png, png2], "MAX_TOKENS"), "response_incomplete"],
        [{ ...response([png]), promptFeedback: { blockReason: "SAFETY" } }, "response_blocked"],
        [response([png, png2.subarray(0, -8)]), "image_spec_png_invalid"],
        [response([png, wrongSize]), "gemini_image_dimensions_mismatch"]] as const) {
        const current = await run(payload), id = current.task.id;
        const result = await current.process();
        expect(result.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review", unknownReason: reason });
        expect(result.result.consumedUnits).toBeNull();
        expect(result.result.resultSnapshot).not.toHaveProperty("image");
        expect(result.result.resultSnapshot.geminiReview).toBeDefined();
        expect((await request(`/api/v1/media/${id}`, buyer)).status).toBe(404);
        expect((await current.process()).replay).toBe(true);
        expect(current.calls).toHaveLength(1);
        await assertLedger(id, 0, 0);
        if (reason === "gemini_image_budget_exceeded") await demoReceipt(current, 3);
    }
});

test("IMG-04 a confirmed upstream rejection releases the complete reservation", async () => {
    const current = await run({ error: "synthetic rejection" }, { status: 400 });
    const result = await current.process();
    expect(result.task).toMatchObject({ executionStatus: "failed", billingStatus: "released" });
    await assertLedger(current.task.id, 0, 17);
});

test("IMG-04 rolls back every gallery row and quota charge if a storage write fails, then recovers the original objects", async () => {
    let attempts = 0;
    const storage: ObjectStorage = { ...sharedStorage, async put(input) {
        if (++attempts === 2) throw new Error("simulated second PNG write interruption");
        return sharedStorage.put(input);
    } };
    const current = await run(response([png, png2]), { storage }), id = current.task.id;
    const media = createMediaRepository(database.db), before = await media.getQuota(buyer.id, quotaBytes);
    const first = await current.process();
    expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(first.result.consumedUnits).toBeNull();
    expect(await media.get(buyer.id, id)).toBeNull();
    expect(await media.get(buyer.id, assignedMedia(id, 1))).toBeNull();
    expect(await media.getQuota(buyer.id, quotaBytes)).toEqual(before);
    await assertLedger(id, 0, 0);
    expect((await current.process()).task.billingStatus).toBe("captured");
    expect((await media.getQuota(buyer.id, quotaBytes)).usedBytes - before.usedBytes).toBe(png.length + png2.length);
    expect(current.calls).toHaveLength(1);
    expect(attempts).toBe(3);
    await assertLedger(id, 14, 3);
});

test("IMG-04 rejects a quota shortfall before saving either image or recording delivered units", async () => {
    const media = createMediaRepository(database.db), original = await media.getQuota(buyer.id, quotaBytes);
    let writes = 0;
    const current = await run(response([png, png2]), { storage: { ...sharedStorage, async put(input) { writes++; return sharedStorage.put(input); } } });
    await database.db.update(storageQuota).set({ quotaBytes: original.usedBytes + png.length }).where(eq(storageQuota.userId, buyer.id));
    try {
        const result = await current.process();
        expect(result.delivery).toEqual({ status: "unknown", unknownReason: "gemini_delivery_quota_exceeded" });
        expect(result.result.consumedUnits).toBeNull();
        expect(await media.get(buyer.id, current.task.id)).toBeNull();
        expect(writes).toBe(0);
        await assertLedger(current.task.id, 0, 0);
    } finally {
        await database.db.update(storageQuota).set({ quotaBytes: original.quotaBytes }).where(eq(storageQuota.userId, buyer.id));
    }
});

test("IMG-04 serializes concurrent recovery of the same delivered batch and never duplicates the supplier or ledger", async () => {
    const current = await run(response([png, png2])), id = current.task.id;
    const media = createMediaRepository(database.db), before = await media.getQuota(buyer.id, quotaBytes);
    const stopped = await processGenerationJob(database.db, current.job, { ...current.dependencies, deliver: undefined, settleBilling: undefined });
    expect(stopped.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "unknown", billingStatus: "pending_review" });
    const reopened = nativeUrl ? await Promise.all([current.process(), current.process()]) : [await current.process(), await current.process()];
    expect(reopened.every(receipt => receipt.task.deliveryStatus === "visible" && receipt.task.billingStatus === "captured")).toBe(true);
    expect((await media.getQuota(buyer.id, quotaBytes)).usedBytes - before.usedBytes).toBe(png.length + png2.length);
    expect(current.calls).toHaveLength(1);
    await assertLedger(id, 14, 3);
});

test("0041 refuses forged price, budget, transport fields and changes to accepted Gemini task intent", async () => {
    const fixtureModel = await fixture();
    const exact = { ownerId: buyer.id, modelId: fixtureModel.intent.modelId, inputSnapshot: fixtureModel.intent.input,
        parameterSnapshot: fixtureModel.intent.parameters, priceVersion: 1, quotedUnits: 17, billingUnitSnapshot: "image" as const, creditsPerUnitSnapshot: 7 };
    // Isolate expected SQL failures with savepoints on one connection.
    await database.db.transaction(async tx => {
        for (const change of [{ creditsPerUnitSnapshot: 4 }, { priceVersion: 2 }, { quotedUnits: 8 },
            { quotedUnits: 6, parameterSnapshot: { ...exact.parameterSnapshot, budgetCredits: 6 } },
            { parameterSnapshot: { ...exact.parameterSnapshot, n: 1 } }, { billingUnitSnapshot: "request" as const }]) {
            await expect(tx.transaction(async savepoint => {
                await savepoint.insert(generationTask).values({ ...exact, ...change, id: crypto.randomUUID(),
                    requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
            })).rejects.toMatchObject({ cause: { code: "P0001", message: "Gemini task requires its original published per-image price and budget" } });
        }
    });
    const confirmed = await submit(fixtureModel.intent);
    const receipt = await confirmed.send();
    expect(receipt.status).toBe(201);
    const id = (await receipt.json()).task.id;
    await expect(database.db.transaction(async tx => {
        await tx.update(generationTask).set({ quotedUnits: 18 }).where(eq(generationTask.id, id));
    })).rejects.toMatchObject({ cause: { code: "P0001", message: "Generation task identity, intent, price snapshot and publication source are immutable" } });
    await assertLedger(id, 0, 0);
});

for (const alreadyReleased of [false, true]) test(`IMG-04 reconciles existing ledger entries after interruption (${alreadyReleased ? "capture and release" : "capture only"})`, async () => {
    const current = await run(response([png, png2])), id = current.task.id;
    // Stop just before the regular settlement callback. Simulate a durable partial commit using actual wallet writes.
    const opened = await processGenerationJob(database.db, current.job, { ...current.dependencies, async settleBilling() { throw new Error("simulated worker stop"); } }).catch(error => error);
    expect(opened.message).toBe("simulated worker stop");
    const task = await createGenerationTaskRepository(database.db).get(buyer.id, id);
    expect(task).toMatchObject({ deliveryStatus: "visible", billingStatus: "reserved" });
    const reference = { userId: buyer.id, reservationId: task!.reservationId!, referenceType: "generation", referenceId: id };
    const store = createWalletRepository(database.db);
    await store.capture({ ...reference, capturedUnits: 14, idempotencyKey: `generation:${id}:capture` });
    if (alreadyReleased) await store.release({ ...reference, releasedUnits: 3, idempotencyKey: `generation:${id}:release` });
    expect((await current.process()).task.billingStatus).toBe("captured");
    expect(current.calls).toHaveLength(1);
    await assertLedger(id, 14, 3);
});

test("IMG-04 refuses to capture after a stored image is missing or the persisted count is contradictory", async () => {
    const current = await run(response([png, png2])), id = current.task.id;
    await expect(processGenerationJob(database.db, current.job, { ...current.dependencies, async settleBilling() { throw new Error("simulated worker stop"); } })).rejects.toThrow("simulated worker stop");
    const task = await createGenerationTaskRepository(database.db).get(buyer.id, id);
    const key = objectKey(`accounts/${Buffer.from(buyer.id).toString("base64url")}/media/${assignedMedia(id, 1)}`);
    const object = await sharedStorage.get(key);
    await sharedStorage.delete(key);
    expect((await current.process()).task.billingStatus).toBe("pending_review");
    await sharedStorage.put({ key, body: object!.body, contentType: "image/png" });
    await database.db.update(generationResult).set({ consumedUnits: 1 }).where(eq(generationResult.taskId, id));
    expect((await current.process()).task.billingStatus).toBe("pending_review");
    expect(task?.reservationId).not.toBeNull();
    expect(current.calls).toHaveLength(1);
    await assertLedger(id, 0, 0);
});

test("IMG-04 keeps Pro's native 1K price and rejects Flash's 512 tier on the same Pro binding", async () => {
    const proPng = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "green" } }).png().toBuffer();
    const current = await run(response([proPng]), { providerModel: "gemini-3-pro-image-preview" });
    expect((await request(quotePath, buyer, { ...current.intent, parameters: { ...current.intent.parameters, imageSize: "512" } })).status).toBe(400);
    expect((await current.process()).task.billingStatus).toBe("captured");
    expect(current.calls[0].url).toBe(endpoint + "v1beta/models/gemini-3-pro-image-preview:generateContent");
    await assertLedger(current.task.id, 7, 10);
});

test("IMG-04 a matching-size image and its metadata from another response cannot enter the original batch", async () => {
    const runA = await run(response([png, png2])), runB = await run(response([png2, png]));
    const pending = async (run: typeof runA) => (await processGenerationJob(database.db, run.job,
        { ...run.dependencies, deliver: undefined, settleBilling: undefined })).result.resultSnapshot;
    const first = await pending(runA), second = await pending(runB);
    const members = (s: typeof first) => s.images as Record<string, unknown>[];
    const manifest = (s: typeof first) => s.geminiBatch as { images: Record<string, unknown>[] };
    const mixed = { ...first, images: [members(first)[0], members(second)[1]],
        geminiBatch: { ...manifest(first), images: [manifest(first).images[0], manifest(second).images[1]] } };
    await database.db.update(generationResult).set({ resultSnapshot: mixed }).where(eq(generationResult.taskId, runA.task.id));
    const retry = await runA.process();
    expect(retry.task.billingStatus).toBe("pending_review");
    expect(await createMediaRepository(database.db).get(buyer.id, runA.task.id)).toBeNull();
    expect(runA.calls).toHaveLength(1);
    await assertLedger(runA.task.id, 0, 0);
});
