import { afterAll, beforeAll, expect, test } from "bun:test";
import { generationPng64x48 as pngBase64 } from "./fixtures/generation-png";
import { Buffer } from "node:buffer";
import { and, eq } from "drizzle-orm";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import type { ImageGenerationParameters, ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createGenerationImageRequestRepository } from "../../../packages/database/src/generation-image-requests";
import { getImageSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { verifyGenerationImageSpecification } from "../src/generation-image-specification";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { generationImageRequest, generationResult, generationTask, mediaObject, modelCatalog, modelPricing, modelProvider, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createMemoryObjectStorage, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import { createAccountApi } from "../src/accounts";
import { readContentSafetyConfig } from "../src/content-safety-config";
import { accountPolicy } from "../src/policy";
import { createGenerationDelivery, createGenerationImageSpecMediaVerifier } from "../src/generation-delivery";
import { createGenerationProvider } from "../src/generation-provider";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { createProviderGateway, type ProviderCallResult, type ProviderRequest } from "../src/provider-gateway";
import { generationImageMediaId } from "../src/generation-image";
import { createTestDatabase, postgresTestUrl } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE !== "image-spec-settlement")
    throw new Error("Image specification execution tests require their own isolated database");
const nativeUrl = postgresTestUrl();

const png = new Uint8Array(Buffer.from(pngBase64, "base64"));
const low = { size: "64x48", quality: "low" } as const;
const high = { size: "64x48", quality: "high" } as const;
const maxBytes = { image: png.byteLength, video: png.byteLength, audio: png.byteLength };
const quotaBytes = png.byteLength * 100;
const origin = "https://image-spec-execution.example.test";
const authSecret = "synthetic-image-spec-execution-" + crypto.randomUUID() + crypto.randomUUID();
const credential = "synthetic-image-spec-execution-key";
const sharedStorage = createMemoryObjectStorage();
const mails: Array<{ to: string; url: string }> = [];
const jobs: GenerationJobPayload[] = [];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let api: ReturnType<typeof createAccountApi>;
type Actor = { id: string; cookie: string };
let alice: Actor, bob: Actor;

function request(path: string, actor?: Actor, body?: unknown, key?: string, method = body === undefined ? "GET" : "POST") {
    return api(new Request(new URL(path, origin), { method,
        headers: { origin, "content-type": "application/json", ...(actor ? { cookie: actor.cookie, "x-canvas-account-id": actor.id } : {}),
            ...(key ? { "idempotency-key": key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.96");
}

async function register(name: string): Promise<Actor> {
    const email = `${name}-${crypto.randomUUID()}@example.test`, password = "synthetic-image-spec-execution-password";
    expect((await request("/api/auth/sign-up/email", undefined, { name, email, password })).status).toBe(200);
    expect((await request(mails.find((mail) => mail.to === email)!.url)).status).toBe(302);
    const login = await request("/api/auth/sign-in/email", undefined, { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const session = await request("/api/v1/session", { id: "", cookie });
    expect(session.status).toBe(200);
    return { id: (await session.json()).user.id, cookie };
}

beforeAll(async () => {
    database = await createTestDatabase();
    api = createAccountApi({ database: database.db, origin,
        auth: { secret: authSecret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
        rates: createRateStore(database.pool, authSecret), verifyHuman: async () => true, onFault: () => {},
        // This file exercises many delivery failures under one synthetic account and IP.
        policy: { ...accountPolicy, read: { ...accountPolicy.read, points: 1000 }, save: { ...accountPolicy.save, points: 1000 } },
        contentSafety: readContentSafetyConfig({ SAAS_GENERATION_IP_RATE_POINTS: "1000", SAAS_GENERATION_USER_RATE_POINTS: "1000" }),
        media: { storage: sharedStorage, quotaBytes, maxBytes },
        generation: { enabled: true, imageEnabled: true, queue: { async send(_name, payload, options) {
            expect(options?.db).toBeDefined(); jobs.push(structuredClone(payload)); return `synthetic-image-spec-job-${jobs.length}`;
        } } },
    });
    alice = await register("execution-alice"); bob = await register("execution-bob");
    await database.db.insert(wallet).values([{ userId: alice.id, availableUnits: "10000" }, { userId: bob.id, availableUnits: "1000" }]);
}, 30_000);
afterAll(async () => { await database?.close(); });

async function publish(draft: ModelPriceDraftWrite, expectedPriceVersion = 0) {
    const audit = { actorId: alice.id, requestId: crypto.randomUUID() };
    const saved = await createModelPriceDraft(database.db, draft, audit);
    if (saved.status !== "saved") throw new Error("Synthetic image specification draft failed");
    const result = await publishModelPriceDraft(database.db, { modelId: draft.modelId, draftId: saved.draft.id,
        expectedDraftVersion: saved.draft.version, expectedPriceVersion, binding: draft.binding, publicPriceNote: "Synthetic specification execution price" }, audit);
    if (result.status !== "published") throw new Error("Synthetic image specification publication failed");
    return result.publication;
}

async function model(legacy = false, providerModel?: string, maxImagesPerRequest?: number, responseFormat?: "b64_json") {
    const id = crypto.randomUUID(), modelId = `image-spec-exec-${id}`, providerId = `image-spec-exec-provider-${id}`;
    const binding = { providerId, providerModel: providerModel ?? `synthetic-image-${id}`, adapter: "openai-compatible" as const,
        endpoint: "https://provider.invalid/v1", capability: "image" as const };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic execution provider", adapter: binding.adapter,
        endpoint: binding.endpoint, secretRef: "synthetic-image-spec-execution", enabled: true });
    await saveProviderCredential(database.db, authSecret, providerId, credential);
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: binding.providerModel,
        displayName: "Synthetic specification execution model", capability: "image", enabled: true });
    const draft: ModelPriceDraftWrite = { modelId, expectedVersion: 0, binding, priceNote: "Synthetic private cost note",
        rules: { schemaVersion: 1, cost: null, ...(maxImagesPerRequest === undefined && responseFormat === undefined ? {} : { image: { schemaVersion: 1, protocol: "openai-image-v1",
            ...(maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest }), ...(responseFormat === undefined ? {} : { responseFormat }) } }), sale: { template: "image_request", currency: "credit", bands: legacy
            ? [{ parameters: {}, rates: { request: "7" } }]
            : [{ parameters: { ...low }, rates: { request: "7" } }, { parameters: { ...high }, rates: { request: "11" } }] } } };
    return { modelId, providerId, binding, draft, publication: await publish(draft) };
}

const intent = (modelId: string, parameters: ImageGenerationParameters) => ({ modelId, input: { prompt: "Synthetic single PNG with explicit specification" },
    parameters, projectId: "synthetic-execution-project", nodeId: "synthetic-execution-node" });

async function accept(fixture: Awaited<ReturnType<typeof model>>, parameters: ImageGenerationParameters = low) {
    const priceResponse = await request("/api/v1/generation/quote", alice, intent(fixture.modelId, parameters));
    expect(priceResponse.status).toBe(200);
    const price = (await priceResponse.json()).quote;
    const key = crypto.randomUUID(), submission = { ...intent(fixture.modelId, parameters), confirmedPriceVersion: price.priceVersion,
        confirmedQuoteFingerprint: price.quoteFingerprint };
    const response = await request("/api/v1/generation/tasks", alice, submission, key);
    expect(response.status).toBe(201);
    const accepted = await response.json(), task = await createGenerationTaskRepository(database.db).get(alice.id, accepted.task.id);
    if (!task?.reservationId) throw new Error("Synthetic specification task was not reserved");
    const payload = jobs.find((job) => job.taskId === task.id);
    if (!payload) throw new Error("Synthetic specification job did not enqueue");
    expect(task).toMatchObject({ pricePublicationId: fixture.publication.id, parameterSnapshot: { ...parameters, n: parameters.n ?? 1, output_format: "png" },
        quotedUnits: (parameters.quality === "high" ? 11 : 7) * (parameters.n ?? 1), executionStatus: "queued", billingStatus: "reserved" });
    return { task, payload, price, submission, key };
}

function successfulPayload(quality: "low" | "high" = "low") {
    return { quality, size: "64x48", output_format: "png", data: [{ b64_json: pngBase64 }],
        providerUrl: "https://provider.invalid/private", authorization: credential };
}

async function scenario(options: { fixture?: Awaited<ReturnType<typeof model>>; parameters?: ImageGenerationParameters;
    response?: ProviderCallResult | ((input: ProviderRequest, index: number) => Promise<ProviderCallResult>) } = {}) {
    const fixture = options.fixture ?? await model(), parameters = options.parameters ?? low;
    const accepted = await accept(fixture, parameters), observed: ProviderRequest[] = [];
    const operations = { put: 0, delete: 0 };
    const storage: ObjectStorage = { ...sharedStorage,
        async put(input) { operations.put++; return sharedStorage.put(input); },
        async delete(key) { operations.delete++; return sharedStorage.delete(key); },
    };
    const provider = createGenerationProvider({ database: database.db, authSecret, imageMaxBytes: maxBytes.image,
        gateway: { async request(input) { expect(input.body).not.toHaveProperty("protocol"); observed.push(input); return (typeof options.response === "function" ? options.response(input, observed.length - 1) : options.response) ?? {
            status: "succeeded", upstreamStatus: 200, payload: successfulPayload(parameters.quality === "high" ? "high" : "low"),
        }; } } });
    const dependencies = {
        provider,
        deliver: createGenerationDelivery({ database: database.db, storage, quotaBytes, maxBytes }),
        settleBilling: createGenerationWalletSettlement(database.db, {
            verifyImageSpecDelivery: createGenerationImageSpecMediaVerifier({ storage, maxBytes }),
        }),
    };
    const key = objectKey(`accounts/${Buffer.from(alice.id).toString("base64url")}/media/${accepted.task.id}`);
    return { fixture, parameters, ...accepted, storage, mediaKey: key, operations, observed, provider, dependencies,
        wallets: createWalletRepository(database.db), media: createMediaRepository(database.db) };
}

async function records(taskId: string) {
    return { tasks: await database.db.select().from(generationTask).where(eq(generationTask.id, taskId)),
        results: await database.db.select().from(generationResult).where(eq(generationResult.taskId, taskId)),
        reservations: await database.db.select().from(walletReservation).where(eq(walletReservation.taskId, taskId)),
        ledger: await database.db.select().from(walletLedger).where(eq(walletLedger.referenceId, taskId)),
        media: await database.db.select().from(mediaObject).where(eq(mediaObject.id, taskId)),
        jobs: jobs.filter((job) => job.taskId === taskId) };
}

const chunkResponse = (input: ProviderRequest): ProviderCallResult => ({ status: "succeeded", upstreamStatus: 200,
    payload: { ...successfulPayload(), data: Array.from({ length: Number(input.body.n) }, () => ({ b64_json: pngBase64 })) } });

async function expectNativeLock(table: "generation_task" | "media_object", clause: "for update" | "for key share") {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const { rows } = await database.pool.query({ text: `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
            WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock' AND query LIKE $1 AND query LIKE $2`,
            values: [`%"${table}"%`, `%${clause}%`] });
        if (rows[0]?.blockers.length) {
            console.log(JSON.stringify({ scenario: "image-settlement-lock", table, clause, ...rows[0] }));
            return;
        }
        await Bun.sleep(20);
    }
    throw new Error(`PostgreSQL did not observe a waiting ${table} ${clause} lock`);
}

test("IMG-03 a configured Grok channel freezes Base64, calls n=1 chunks and captures the full private delivery once", async () => {
    const run = await scenario({ fixture: await model(false, "grok-imagine-image-2.0", 1, "b64_json"), parameters: { ...low, n: 3 } });
    expect(run.task.parameterSnapshot).toHaveProperty("response_format", "b64_json");
    expect(run.price.imageSpec).not.toHaveProperty("responseFormat");
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(run.observed.map(item => [item.body.n, item.body.response_format])).toEqual([[1, "b64_json"], [1, "b64_json"], [1, "b64_json"]]);
    const rows = await createGenerationImageRequestRepository(database.db).list(alice.id, run.task.id);
    expect(rows.map(row => row.parametersSnapshot.response_format)).toEqual(Array(3).fill("b64_json"));
    expect(run.operations.put).toBe(3);
    expect(result.result.resultSnapshot.imageMedia).toHaveLength(3);
    expect((await request(`/api/v1/media/${run.task.id}`, bob)).status).toBe(404);
    const replay = await request("/api/v1/generation/tasks", alice, run.submission, run.key);
    expect(replay.status).toBe(200);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(3); expect(run.operations.put).toBe(3);
    expect((await records(run.task.id)).ledger.filter(item => item.kind === "capture")).toHaveLength(1);
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ requestedUnits: "21", capturedUnits: "21", releasedUnits: "0" });
});

test("IMG-03 URL-only or missing-quality Grok output remains pending without download, capture or resend", async () => {
    for (const payload of [{ quality: "low", data: [{ url: "https://provider.invalid/temporary.png" }] }, { data: [{ b64_json: pngBase64 }] }]) {
        const run = await scenario({ fixture: await model(false, "grok-imagine-image-quality", undefined, "b64_json"),
            response: { status: "succeeded", upstreamStatus: 200, payload } });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
        expect(run.observed[0]?.body.response_format).toBe("b64_json");
        await expectPendingReview(run);
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
    }
});

test("IMG-03 changing the active return policy cannot rewrite an accepted old task or accept client transport overrides", async () => {
    const fixture = await model(), run = await scenario({ fixture });
    const originalParameters = structuredClone(run.task.parameterSnapshot);
    const next = structuredClone(fixture.draft); next.expectedVersion = 1;
    next.rules.image = { schemaVersion: 1, protocol: "openai-image-v1", responseFormat: "b64_json" };
    const publication = await publish(next, 1);
    expect((await request("/api/v1/generation/tasks", alice, run.submission, run.key)).status).toBe(200);
    expect((await createGenerationTaskRepository(database.db).get(alice.id, run.task.id))?.parameterSnapshot).toEqual(originalParameters);
    expect(originalParameters).not.toHaveProperty("response_format");
    const newTask = await accept({ ...fixture, publication });
    expect(newTask.task.parameterSnapshot).toHaveProperty("response_format", "b64_json");
    expect((await request("/api/v1/generation/quote", alice, { ...intent(fixture.modelId, low), parameters: { ...low, response_format: "b64_json" } })).status).toBe(400);
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task.billingStatus).toBe("captured");
    expect(run.observed[0]?.body).not.toHaveProperty("response_format");
});

test("IMG-03 interrupted inline batches keep their format and verified earlier request without a second attempt", async () => {
    const run = await scenario({ fixture: await model(false, "grok-imagine-image-2.0", 1, "b64_json"), parameters: { ...low, n: 3 },
        response: async (input, index) => index === 1 ? { status: "unknown", code: "provider_timeout", retryable: false } : chunkResponse(input) });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
    const repository = createGenerationImageRequestRepository(database.db);
    const rows = await repository.list(alice.id, run.task.id);
    expect(rows.map(row => row.phase)).toEqual(["succeeded", "unknown", "ready"]);
    expect(rows.every(row => row.parametersSnapshot.response_format === "b64_json")).toBe(true);
    expect(rows[0]!.resultSnapshot).toHaveProperty("imageSpecEvidence");
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(2); expect(run.operations.put).toBe(0); await expectPendingReview(run);
});

test("IMG-03 saved request recovery reuses exact parameters and rejects an added or dropped return format", async () => {
    for (const responseFormat of ["b64_json", undefined] as const) {
        const run = await scenario({ fixture: await model(false, "grok-imagine-image-2.0", 1, responseFormat), parameters: { ...low, n: 2 } });
        const task = await createGenerationTaskRepository(database.db).claimRunning({ ownerId: alice.id, taskId: run.task.id });
        if (!task) throw new Error("Synthetic inline task did not claim");
        const first = await run.provider(task), repository = createGenerationImageRequestRepository(database.db);
        expect(first.status).toBe("succeeded");
        const original = await repository.list(alice.id, task.id);
        expect(await run.provider(task)).toEqual(first);
        expect(await repository.list(alice.id, task.id)).toEqual(original);
        expect(run.observed).toHaveLength(2);
        const { response_format: _format, ...parameters } = original[0]!.parametersSnapshot;
        await database.db.update(generationImageRequest).set({ parametersSnapshot: responseFormat ? parameters : { ...parameters, response_format: "b64_json" } })
            .where(and(eq(generationImageRequest.taskId, task.id), eq(generationImageRequest.requestIndex, 0)));
        await expect(run.provider(task)).rejects.toThrow("Image request immutable plan conflict");
        expect(run.observed).toHaveLength(2); expect(run.operations.put).toBe(0);
    }
});

test("a published four-image channel splits ten into 4+4+2, delivers ten private assets and captures once", async () => {
    const run = await scenario({ fixture: await model(false, "gpt-image-2.5-flare-1k", 4), parameters: { ...low, n: 10 }, response: async input => chunkResponse(input) });
    expect(run.price).toMatchObject({ quotedUnits: 70, imageSpec: { parameters: { ...low, n: 10 }, maxImagesPerRequest: 4 } });
    const catalog = await (await request("/api/v1/generation/models", alice)).json();
    expect(catalog.items.find((item: any) => item.id === run.fixture.modelId)).toMatchObject({ maxImages: 10, maxImagesPerRequest: 4 });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(run.observed.map(item => item.body.n)).toEqual([4, 4, 2]);
    expect(result.result.resultSnapshot.imageRequestPlan).toEqual([4, 4, 2]);
    expect(result.result.resultSnapshot.imageMedia).toHaveLength(10); expect(run.operations.put).toBe(10);
    const requests = createGenerationImageRequestRepository(database.db), rows = await requests.list(alice.id, run.task.id);
    expect(rows.map(row => [row.imageCount, row.phase])).toEqual([[4, "succeeded"], [4, "succeeded"], [2, "succeeded"]]);
    expect(await requests.list(bob.id, run.task.id)).toEqual([]);
    for (const hidden of [credential, "authorization"]) expect(JSON.stringify(rows)).not.toContain(hidden);
    const history = await (await request(`/api/v1/generation/tasks/${run.task.id}`, alice)).json();
    expect(history.task.imageSpecSnapshot).toEqual({ status: "recorded", protocol: "openai-image-v1", parameters: { ...low, n: 10 }, maxImagesPerRequest: 4 });
    for (const hidden of [pngBase64, credential, "provider.invalid", "imageSpecEvidence", "bindingSnapshot"]) expect(JSON.stringify(history)).not.toContain(hidden);
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ requestedUnits: "70", capturedUnits: "70", releasedUnits: "0" });
    const specification = await getImageSpecTaskSnapshot(database.db, run.task);
    if (specification.status !== "recorded") throw new Error("Missing original specification");
    for (const plan of [undefined, [4, 3, 3], [10]]) {
        const checked = await verifyGenerationImageSpecification(run.task, { ...result.result.resultSnapshot, imageRequestPlan: plan }, specification, maxBytes.image);
        expect(checked.status).toBe("unknown");
    }
    const swapped = structuredClone(result.result.resultSnapshot);
    const members = swapped.images as unknown[]; [members[0], members[9]] = [members[9], members[0]];
    expect((await verifyGenerationImageSpecification(run.task, swapped, specification, maxBytes.image)).status).toBe("unknown");
    const repeatedChunk = structuredClone(result.result.resultSnapshot);
    const repeatedImages = repeatedChunk.images as unknown[];
    repeatedImages.splice(4, 4, ...structuredClone(repeatedImages.slice(0, 4)));
    expect((await verifyGenerationImageSpecification(run.task, repeatedChunk, specification, maxBytes.image)).status).toBe("unknown");
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(3); expect(run.operations.put).toBe(10);
    expect((await records(run.task.id)).ledger.filter(item => item.kind === "capture")).toHaveLength(1);
});

test.each([408, 409])("a first-batch HTTP %i remains unknown and retains the full ten-image reservation", async status => {
    const gateway = createProviderGateway(async () => new Response(null, { status }), async () => ["93.184.216.34"]);
    const run = await scenario({ fixture: await model(false, "gpt-image-2.5-flare-1k", 4), parameters: { ...low, n: 10 },
        response: input => gateway.request(input) });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(result.result.unknownReason).toBe("provider_response_unknown");
    expect((await createGenerationImageRequestRepository(database.db).list(alice.id, run.task.id)).map(row => row.phase))
        .toEqual(["unknown", "ready", "ready"]);
    expect(run.operations.put).toBe(0);
    await expectPendingReview(run);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed.map(item => (item.body as { n: number }).n)).toEqual([4]);
});

test("a third-request timeout preserves eight verified PNGs without resending or settling the partial batch", async () => {
    const run = await scenario({ fixture: await model(false, "gpt-image-2.5-sunburst", 4), parameters: { ...low, n: 10 },
        response: async (input, index) => index === 2 ? { status: "unknown", code: "provider_timeout", retryable: false } : chunkResponse(input) });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
    expect(result.result.resultSnapshot.imageRequestProgress).toMatchObject({ counts: [4, 4, 2], completedImages: 8, phases: ["succeeded", "succeeded", "unknown"] });
    const rows = await createGenerationImageRequestRepository(database.db).list(alice.id, run.task.id);
    expect(rows.slice(0, 2).map(row => (row.resultSnapshot.images as unknown[]).length)).toEqual([4, 4]);
    expect(run.operations.put).toBe(0); await expectPendingReview(run);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed.map(item => item.body.n)).toEqual([4, 4, 2]);
    await expectPendingReview(run);
});

test("old batch plan parameters remain unchanged on resume and an unknown stored protocol cannot be adopted", async () => {
    const fixture = await model(false, "gpt-image-2.5-flare", 4), accepted = await accept(fixture, { ...low, n: 6 });
    const tasks = createGenerationTaskRepository(database.db);
    const task = await tasks.transitionExecution({ ownerId: alice.id, taskId: accepted.task.id, status: "running" });
    const specification = await getImageSpecTaskSnapshot(database.db, task);
    if (specification.status !== "recorded" || specification.maxImagesPerRequest === undefined) throw new Error("Missing image batch plan");
    const repository = createGenerationImageRequestRepository(database.db), source = { ...specification, maxImagesPerRequest: specification.maxImagesPerRequest };
    const original = await repository.initialize(task, source, fixture.binding);
    for (const row of original) {
        const { protocol: _protocol, ...parametersSnapshot } = row.parametersSnapshot;
        await database.db.update(generationImageRequest).set({ parametersSnapshot }).where(and(eq(generationImageRequest.taskId, row.taskId), eq(generationImageRequest.requestIndex, row.requestIndex)));
    }
    const historical = await repository.list(alice.id, task.id);
    expect(await repository.initialize(task, source, fixture.binding)).toEqual(historical);
    expect(historical.every(row => !Object.hasOwn(row.parametersSnapshot, "protocol"))).toBe(true);
    await database.db.update(generationImageRequest).set({ parametersSnapshot: { ...historical[0]!.parametersSnapshot, protocol: "gemini" } })
        .where(and(eq(generationImageRequest.taskId, task.id), eq(generationImageRequest.requestIndex, 0)));
    await expect(repository.initialize(task, source, fixture.binding)).rejects.toThrow("Image request immutable plan conflict");
});

test("a later malformed response or disabled binding leaves the earlier chunk pending review", async () => {
    for (const failure of ["missing", "corrupt", "disabled"] as const) {
        const fixture = await model(false, "gpt-image-2.5-flare", 4);
        const run = await scenario({ fixture, parameters: { ...low, n: 6 }, response: async (input, index) => {
            if (!index && failure === "disabled") await database.db.update(modelProvider).set({ enabled: false }).where(eq(modelProvider.id, fixture.providerId));
            if (!index || failure === "disabled") return chunkResponse(input);
            return { status: "succeeded", upstreamStatus: 200, payload: { ...successfulPayload(), data: failure === "missing"
                ? [{ b64_json: pngBase64 }] : [{ b64_json: pngBase64 }, { b64_json: "corrupt" }] } };
        } });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
        const rows = await createGenerationImageRequestRepository(database.db).list(alice.id, run.task.id);
        expect(rows[0]!.phase).toBe("succeeded"); expect(rows[0]!.resultSnapshot.images).toHaveLength(4);
        expect(rows[1]!.phase).toBe(failure === "disabled" ? "ready" : "unknown");
        await expectPendingReview(run); await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(run.observed).toHaveLength(failure === "disabled" ? 1 : 2); expect(run.operations.put).toBe(0);
    }
});

test("a corrupt middle member preserves the other images in its request without delivery, capture or resend", async () => {
    const run = await scenario({ fixture: await model(false, "gpt-image-2.5-flare-1k", 4), parameters: { ...low, n: 8 },
        response: async (input, index) => !index ? chunkResponse(input) : { status: "succeeded", upstreamStatus: 200, payload: {
            ...successfulPayload(), data: [{ b64_json: pngBase64 }, { b64_json: "broken" }, { b64_json: pngBase64 }, { b64_json: pngBase64 }],
        } } });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
    const rows = await createGenerationImageRequestRepository(database.db).list(alice.id, run.task.id);
    expect(rows.map(row => row.phase)).toEqual(["succeeded", "unknown"]);
    expect(rows[1]!.resultSnapshot).toMatchObject({ imageResponseReview: { expectedImages: 4, receivedImages: 4,
        items: [{ index: 0, status: "verified" }, { index: 1, status: "unknown" }, { index: 2, status: "verified" }, { index: 3, status: "verified" }] } });
    expect(run.operations.put).toBe(0); await expectPendingReview(run);
    const history = await (await request(`/api/v1/generation/tasks/${run.task.id}`, alice)).json();
    for (const hidden of [pngBase64, credential, "imageResponseReview", "imageSpecEvidence"]) expect(JSON.stringify(history)).not.toContain(hidden);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(2); expect(run.operations.put).toBe(0); await expectPendingReview(run);
});

test("durable request claims reject wrong owners, out-of-order requests, duplicates and changed plans", async () => {
    const fixture = await model(false, "gpt-image-2.5-flare", 4), accepted = await accept(fixture, { ...low, n: 10 });
    const task = await createGenerationTaskRepository(database.db).claimRunning({ ownerId: alice.id, taskId: accepted.task.id });
    if (!task) throw new Error("Missing task claim");
    const repository = createGenerationImageRequestRepository(database.db);
    const specification = { protocol: "openai-image-v1" as const, publicationId: fixture.publication.id, parameters: { ...low, n: 10 }, maxImagesPerRequest: 4 };
    await expect(repository.initialize({ ...task, ownerId: bob.id }, specification, fixture.binding)).rejects.toThrow();
    const rows = await repository.initialize(task, specification, fixture.binding);
    expect(await repository.claim(rows[1]!)).toBeNull();
    const claimed = await repository.claim(rows[0]!); expect(claimed?.phase).toBe("started");
    expect(await repository.claim(rows[0]!)).toBeNull();
    await expect(repository.initialize(task, { ...specification, maxImagesPerRequest: 5 }, fixture.binding)).rejects.toThrow();
    await repository.complete(claimed!, { phase: "unknown", reason: "synthetic_interruption" });
    await expect(repository.complete(claimed!, { phase: "succeeded" })).rejects.toThrow();
    expect(await repository.claim(rows[1]!)).toBeNull();
});

test("four images use one confirmed total, four private assets and one idempotent capture", async () => {
    const fixture = await model(false, "gpt-image-2"), parameters = { ...low, n: 4 };
    const payload = { ...successfulPayload(), data: Array.from({ length: 4 }, () => ({ b64_json: pngBase64 })) };
    const run = await scenario({ fixture, parameters, response: { status: "succeeded", upstreamStatus: 200, payload } });
    expect(run.price).toMatchObject({ quotedUnits: 28, creditsPerUnit: 7, imageSpec: { parameters } });
    const first = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(first.delivery).toMatchObject({ status: "visible" });
    expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(run.observed).toHaveLength(1); expect(run.observed[0]!.body.n).toBe(4);
    expect(run.operations.put).toBe(4);
    const publicTask = await (await request(`/api/v1/generation/tasks/${run.task.id}`, alice)).json();
    const images = publicTask.result.resultSnapshot.imageMedia;
    expect(images).toHaveLength(4); expect(new Set(images.map((item: any) => item.mediaId)).size).toBe(4);
    for (const image of images) {
        expect((await request(`/api/v1/media/${image.mediaId}`, alice)).status).toBe(200);
        expect((await request(`/api/v1/media/${image.mediaId}`, bob)).status).toBe(404);
    }
    for (const hidden of [pngBase64, credential, "provider.invalid", "imageSpecEvidence"]) expect(JSON.stringify(publicTask)).not.toContain(hidden);
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ requestedUnits: "28", capturedUnits: "28", releasedUnits: "0" });
    expect((await records(run.task.id)).ledger.filter(item => item.kind === "capture")).toHaveLength(1);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(4);
    expect((await records(run.task.id)).ledger.filter(item => item.kind === "capture")).toHaveLength(1);
    const changedCount = await request("/api/v1/generation/tasks", alice, { ...run.submission, parameters: { ...low, n: 3 } }, run.key);
    expect(changedCount.status).toBe(409);
});

test("missing or corrupt members of a four-image response never deliver or capture", async () => {
    for (const data of [Array.from({ length: 3 }, () => ({ b64_json: pngBase64 })),
        [{ b64_json: pngBase64 }, { b64_json: pngBase64 }, { b64_json: "invalid" }, { b64_json: pngBase64 }]]) {
        const run = await scenario({ fixture: await model(false, "gpt-image-2"), parameters: { ...low, n: 4 },
            response: { status: "succeeded", upstreamStatus: 200, payload: { ...successfulPayload(), data } } });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
        expect(run.operations.put).toBe(0);
        await expectPendingReview(run);
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(run.observed).toHaveLength(1);
    }
});

test("ten images retain the boundary count and charge their complete published total once", async () => {
    const run = await scenario({ fixture: await model(false, "gpt-image-2"), parameters: { ...low, n: 10 },
        response: { status: "succeeded", upstreamStatus: 200, payload: { ...successfulPayload(), data: Array.from({ length: 10 }, () => ({ b64_json: pngBase64 })) } } });
    expect(run.price.quotedUnits).toBe(70);
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task.billingStatus).toBe("captured");
    expect(run.observed[0]!.body.n).toBe(10);
    expect(result.result.resultSnapshot.imageMedia).toHaveLength(10);
    expect(run.operations.put).toBe(10);
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ capturedUnits: "70", releasedUnits: "0" });
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(10);
    expect((await records(run.task.id)).ledger.filter(item => item.kind === "capture")).toHaveLength(1);
});

test("interrupted batch delivery stays outside the gallery and resumes without repeating the supplier or quota", async () => {
    const run = await scenario({ fixture: await model(false, "gpt-image-2.5-flare-1k", 4), parameters: { ...low, n: 10 },
        response: async input => chunkResponse(input) });
    const originalPut = run.storage.put, beforeQuota = await run.media.getQuota(alice.id, quotaBytes);
    let attempts = 0;
    run.storage.put = async input => { if (++attempts === 2) throw new Error("synthetic second object interruption"); return originalPut(input); };
    const interrupted = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(interrupted.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(interrupted.result.resultSnapshot).not.toHaveProperty("media");
    expect(run.operations.put).toBe(1);
    const mediaIds = Array.from({ length: 10 }, (_, index) => generationImageMediaId(run.task.id, index));
    expect(await run.media.resolve(alice.id, mediaIds)).toEqual([]);
    expect((await request(`/api/v1/media/${run.task.id}`, alice)).status).toBe(404);
    expect(await run.media.getQuota(alice.id, quotaBytes)).toEqual(beforeQuota);
    expect((await run.storage.get(run.mediaKey))?.body).toEqual(png);
    await expectPendingReview(run);
    let resumed: Awaited<ReturnType<typeof processGenerationJob>>;
    if (nativeUrl) {
        const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
        run.storage.put = async input => { entered.resolve(); await proceed.promise; return originalPut(input); };
        const recover = () => processGenerationJob(database.db, run.payload, run.dependencies);
        const first = recover();
        let second: ReturnType<typeof recover> | undefined;
        try {
            await Promise.race([entered.promise, first.then(() => { throw new Error("First worker did not acquire delivery"); })]);
            second = recover();
            await Promise.race([expectNativeLock("generation_task", "for update"), second.then(() => { throw new Error("Second worker did not wait"); })]);
            proceed.resolve();
            [resumed] = await Promise.all([first, second]);
            expect((await second).task).toMatchObject({ deliveryStatus: "visible", billingStatus: "captured" });
        } finally {
            proceed.resolve();
            await Promise.allSettled([first, second]);
        }
    } else resumed = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(resumed.task).toMatchObject({ deliveryStatus: "visible", billingStatus: "captured" });
    expect(resumed.result.resultSnapshot.imageMedia).toHaveLength(10);
    expect(await run.media.resolve(alice.id, mediaIds)).toHaveLength(10);
    expect(await run.media.resolve(bob.id, mediaIds)).toEqual([]);
    expect(run.observed.map(item => (item.body as { n: number }).n)).toEqual([4, 4, 2]);
    expect(run.operations.put).toBe(10);
    const afterQuota = await run.media.getQuota(alice.id, quotaBytes);
    expect(afterQuota.usedBytes - beforeQuota.usedBytes).toBe(png.byteLength * 10);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(await run.media.getQuota(alice.id, quotaBytes)).toEqual(afterQuota);
    expect(run.operations.put).toBe(10); expect(run.observed).toHaveLength(3);
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ capturedUnits: "70", releasedUnits: "0" });
    expect((await records(run.task.id)).ledger.filter(item => item.kind === "capture")).toHaveLength(1);
});

if (nativeUrl) for (const deleteFirst of [false, true]) {
    test(`REL-01 PG16 multi-image settlement and media deletion (${deleteFirst ? "delete first" : "capture first"})`, async () => {
        const run = await scenario({ fixture: await model(false, "gpt-image-2"), parameters: { ...low, n: 2 },
            response: async input => chunkResponse(input) });
        const receipt = await processGenerationJob(database.db, run.payload, { ...run.dependencies, settleBilling: undefined });
        expect(receipt.task).toMatchObject({ deliveryStatus: "visible", billingStatus: "pending_review" });
        await expectPendingReview(run);
        const mediaId = generationImageMediaId(run.task.id, 1), row = await run.media.get(alice.id, mediaId);
        if (!row) throw new Error("Missing second image before race");
        const quota = await run.media.getQuota(alice.id, quotaBytes);
        const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
        const realDelete = sharedStorage.delete, verify = createGenerationImageSpecMediaVerifier({ storage: run.storage, maxBytes });
        sharedStorage.delete = async key => {
            if (key === row.objectKey) {
                if (deleteFirst) { entered.resolve(); await proceed.promise; }
                else expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ status: "captured", capturedUnits: "14" });
            }
            return realDelete(key);
        };
        const settle = createGenerationWalletSettlement(database.db, {
            async verifyImageSpecDelivery(tx, input) {
                const verified = await verify(tx, input);
                if (!deleteFirst && verified) { entered.resolve(); await proceed.promise; }
                return verified;
            },
        });
        const settleOriginal = () => settle(receipt);
        const removeImage = () => request(`/api/v1/media/${mediaId}`, alice, undefined, undefined, "DELETE");
        const first = deleteFirst ? removeImage() : settleOriginal();
        let second: ReturnType<typeof removeImage> | ReturnType<typeof settleOriginal> | undefined;
        try {
            await Promise.race([entered.promise, first.then(() => { throw new Error("First transaction did not reach the expected lock"); })]);
            second = deleteFirst ? settleOriginal() : removeImage();
            await Promise.race([expectNativeLock("media_object", deleteFirst ? "for key share" : "for update"),
                second.then(() => { throw new Error("Second transaction did not wait for the media row"); })]);
            await expectPendingReview(run);
            proceed.resolve();
            const [a, b] = await Promise.all([first, second]);
            const [deleted, settled] = deleteFirst ? [a, b] : [b, a];
            expect(deleted).toBeInstanceOf(Response);
            expect((deleted as Response).status).toBe(200);
            expect(settled).toBe(deleteFirst ? "pending_review" : "captured");
            expect(await run.media.get(alice.id, mediaId)).toBeNull();
            expect(await run.storage.get(objectKey(row.objectKey))).toBeNull();
            expect((await run.media.getQuota(alice.id, quotaBytes)).usedBytes).toBe(quota.usedBytes - row.sizeBytes);
            await processGenerationJob(database.db, run.payload, run.dependencies);
            const after = await records(run.task.id);
            expect(after.tasks[0]!.billingStatus).toBe(deleteFirst ? "pending_review" : "captured");
            expect(after.reservations[0]).toMatchObject({ capturedUnits: deleteFirst ? "0" : "14", releasedUnits: "0" });
            expect(after.ledger.map(entry => entry.kind).sort()).toEqual(deleteFirst ? ["reserve"] : ["capture", "reserve"]);
            expect(run.observed).toHaveLength(1);
            expect(run.operations.put).toBe(2);
        } finally {
            proceed.resolve();
            await Promise.allSettled([first, second]);
            sharedStorage.delete = realDelete;
        }
    }, 20_000);
}

test("a batch with a member indexed by the old delivery path only reserves the remaining quota", async () => {
    const run = await scenario({ fixture: await model(false, "gpt-image-2"), parameters: { ...low, n: 2 },
        response: async input => chunkResponse(input) });
    const stored = await run.storage.put({ key: run.mediaKey, body: png, contentType: "image/png" });
    await database.db.transaction(async tx => {
        const media = createMediaRepository(tx);
        await media.add(alice.id, { id: run.task.id, kind: "image", objectKey: stored.key, contentType: stored.contentType,
            sizeBytes: stored.sizeBytes, etag: stored.etag });
        expect(await media.reserve(alice.id, stored.sizeBytes, quotaBytes)).toBe(true);
    });
    const before = await run.media.getQuota(alice.id, quotaBytes);
    const restored = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(restored.task).toMatchObject({ deliveryStatus: "visible", billingStatus: "captured" });
    expect(restored.result.resultSnapshot.imageMedia).toHaveLength(2);
    expect((await run.media.getQuota(alice.id, quotaBytes)).usedBytes - before.usedBytes).toBe(png.byteLength);
    expect(run.operations.put).toBe(2);
    expect((await records(run.task.id)).ledger.filter(row => row.kind === "capture")).toHaveLength(1);
});

test("unverified model aliases and counts outside 1-10 reject before reservation", async () => {
    const fixture = await model();
    for (const n of [2, 0, 11, 1.5, "4"]) {
        expect((await request("/api/v1/generation/quote", alice, intent(fixture.modelId, { ...low, n: n as number }))).status).toBe(400);
    }
});

async function expectPendingReview(run: Awaited<ReturnType<typeof scenario>>) {
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ status: "pending",
        requestedUnits: String(run.task.quotedUnits), capturedUnits: "0", releasedUnits: "0" });
    const saved = await records(run.task.id);
    expect(saved.tasks).toHaveLength(1); expect(saved.results).toHaveLength(1); expect(saved.reservations).toHaveLength(1);
    expect(saved.jobs).toHaveLength(1);
    expect(saved.ledger.filter((entry) => entry.kind === "reserve")).toHaveLength(1);
    expect(saved.ledger.filter((entry) => entry.kind === "capture" || entry.kind === "release")).toHaveLength(0);
}

test("two identical PNG sizes settle their explicit quality prices against the original source exactly once", async () => {
    const fixture = await model();
    const lowRun = await scenario({ fixture, parameters: low }), highRun = await scenario({ fixture, parameters: high });
    expect(lowRun.price.quotedUnits).toBe(7); expect(highRun.price.quotedUnits).toBe(11);
    const next = structuredClone(fixture.draft); next.expectedVersion = 1;
    next.rules.sale.bands[0]!.rates.request = "19"; next.rules.sale.bands[1]!.rates.request = "23";
    await publish(next, 1);

    for (const run of [lowRun, highRun]) {
        const replayAcceptance = await request("/api/v1/generation/tasks", alice, run.submission, run.key);
        expect(replayAcceptance.status).toBe(200);
        expect(await replayAcceptance.json()).toMatchObject({ created: false, task: { id: run.task.id, priceVersion: 1, quotedUnits: run.task.quotedUnits } });
        expect(await database.db.select().from(generationTask).where(and(eq(generationTask.ownerId, alice.id), eq(generationTask.idempotencyKey, run.key)))).toHaveLength(1);
        const first = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured",
            priceVersion: 1, pricePublicationId: fixture.publication.id, creditsPerUnitSnapshot: run.task.quotedUnits });
        expect(first.result).toMatchObject({ status: "succeeded", consumedUnits: 1 });
        expect(first.result.resultSnapshot).toHaveProperty("imageSpecEvidence");
        expect(run.observed).toHaveLength(1);
        expect(run.observed[0]).toMatchObject({ path: "images/generations", target: { providerId: fixture.providerId,
            providerModel: fixture.binding.providerModel, adapter: fixture.binding.adapter, endpoint: fixture.binding.endpoint, credential },
            body: { model: fixture.binding.providerModel, prompt: run.task.inputSnapshot.prompt, ...run.parameters, n: 1, output_format: "png" } });
        const row = await run.media.get(alice.id, run.task.id);
        expect(row).toMatchObject({ id: run.task.id, ownerId: alice.id, objectKey: run.mediaKey, kind: "image", contentType: "image/png", sizeBytes: png.byteLength });
        expect((await run.storage.get(run.mediaKey))?.body).toEqual(png);
        const own = await request(`/api/v1/media/${run.task.id}`, alice);
        expect(own.status).toBe(200); expect(own.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await own.arrayBuffer())).toEqual(png);
        expect((await request(`/api/v1/media/${run.task.id}`, bob)).status).toBe(404);
        expect((await request(`/api/v1/generation/tasks/${run.task.id}`, bob)).status).toBe(404);
        const publicTask = await (await request(`/api/v1/generation/tasks/${run.task.id}`, alice)).json();
        for (const hidden of [pngBase64, credential, "provider.invalid", "imageSpecEvidence", "pricePublicationId", "objectKey"]) expect(JSON.stringify(publicTask)).not.toContain(hidden);
        expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ requestedUnits: String(run.task.quotedUnits),
            capturedUnits: String(run.task.quotedUnits), releasedUnits: "0", status: "captured" });
        const before = await records(run.task.id), beforeWallet = await run.wallets.get(alice.id), beforeQuota = await run.media.getQuota(alice.id, quotaBytes);
        expect(before.results).toHaveLength(1); expect(before.media).toHaveLength(1); expect(before.reservations).toHaveLength(1); expect(before.jobs).toHaveLength(1);
        expect(before.ledger.filter((entry) => entry.kind === "reserve")).toHaveLength(1);
        expect(before.ledger.filter((entry) => entry.kind === "capture")).toMatchObject([{ deltaReservedUnits: `-${run.task.quotedUnits}` }]);
        expect(before.ledger.filter((entry) => entry.kind === "release")).toHaveLength(0);
        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { billingStatus: "captured", deliveryStatus: "visible" } });
        expect(await records(run.task.id)).toEqual(before);
        expect(await run.wallets.get(alice.id)).toEqual(beforeWallet); expect(await run.media.getQuota(alice.id, quotaBytes)).toEqual(beforeQuota);
        expect(run.observed).toHaveLength(1); expect(run.operations).toEqual({ put: 1, delete: 0 });
    }
});

test("pixel evidence suffices without optional size/format echoes and never substitutes for a missing top-level quality", async () => {
    const withoutOptionalEchoes = await scenario({ response: { status: "succeeded", upstreamStatus: 200,
        payload: { quality: "low", data: [{ b64_json: pngBase64 }] } } });
    expect((await processGenerationJob(database.db, withoutOptionalEchoes.payload, withoutOptionalEchoes.dependencies)).task.billingStatus).toBe("captured");
    expect((await records(withoutOptionalEchoes.task.id)).ledger.filter((entry) => entry.kind === "capture")).toHaveLength(1);
    const { quality: _quality, ...withoutQuality } = successfulPayload();
    const responses = [withoutQuality, { ...withoutQuality, data: [{ b64_json: pngBase64, quality: "low" }] },
        { ...successfulPayload(), quality: "high" }, { ...successfulPayload(), quality: "auto" },
        { ...successfulPayload(), size: "128x48" }, { ...successfulPayload(), output_format: "jpeg" }];
    for (const payload of responses) {
        const run = await scenario({ response: { status: "succeeded", upstreamStatus: 200, payload } });
        const first = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(first.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
        expect(first.result.status).toBe("unknown");
        await expectPendingReview(run);
        expect(await run.media.get(alice.id, run.task.id)).toBeNull(); expect(await run.storage.get(run.mediaKey)).toBeNull();
        const before = await records(run.task.id);
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(await records(run.task.id)).toEqual(before); expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
    }
});

test("an explicit provider failure releases only the original reservation and replay never retries", async () => {
    const run = await scenario({ parameters: high, response: { status: "failed", code: "provider_rejected" } });
    const first = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(first.task).toMatchObject({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released" });
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ requestedUnits: "11", capturedUnits: "0", releasedUnits: "11", status: "released" });
    const before = await records(run.task.id);
    expect(before.ledger.filter((entry) => entry.kind === "capture")).toHaveLength(0);
    expect(before.ledger.filter((entry) => entry.kind === "release")).toMatchObject([{ deltaAvailableUnits: "11", deltaReservedUnits: "-11" }]);
    expect(before.media).toHaveLength(0);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(await records(run.task.id)).toEqual(before); expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
});

test("truncated or corrupt PNGs remain unknown even with matching provider echoes", async () => {
    const badCrc = new Uint8Array(png); badCrc[40] ^= 1;
    for (const body of [png.slice(0, 8), png.slice(0, 24), png.slice(0, -12), badCrc]) {
        const run = await scenario({ response: { status: "succeeded", upstreamStatus: 200,
            payload: { ...successfulPayload(), data: [{ b64_json: Buffer.from(body).toString("base64") }] } } });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
        await expectPendingReview(run);
        expect(await run.media.get(alice.id, run.task.id)).toBeNull(); expect(await run.storage.get(run.mediaKey)).toBeNull();
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
    }
});

test("a changed binding fails before any supplier request and cannot select the replacement model", async () => {
    const run = await scenario();
    await database.db.update(modelCatalog).set({ providerModel: "synthetic-replacement-model" }).where(eq(modelCatalog.id, run.fixture.modelId));
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "failed", billingStatus: "released", pricePublicationId: run.fixture.publication.id });
    expect(run.observed).toHaveLength(0); expect(run.operations.put).toBe(0);
    expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ capturedUnits: "0", releasedUnits: "7", status: "released" });
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(0);
});

test("durable result, saved media and committed capture each recover with one original result and charge", async () => {
    for (const interruption of ["result", "saved", "capture"] as const) {
        const run = await scenario({ parameters: high }), tasks = createGenerationTaskRepository(database.db), results = createGenerationResultRepository(database.db);
        let task = await tasks.claimRunning({ ownerId: alice.id, taskId: run.task.id });
        if (!task) throw new Error("Synthetic task did not claim");
        const normalized = await run.provider(task);
        if (normalized.status !== "succeeded") throw new Error("Synthetic matching specification did not normalize");
        let result = (await results.create({ ownerId: alice.id, taskId: task.id, ...normalized })).result;
        expect(JSON.parse(JSON.stringify(result.resultSnapshot))).toHaveProperty("imageSpecEvidence");
        if (interruption !== "result") {
            const delivery = await run.dependencies.deliver({ task, result });
            expect(delivery.status).toBe("visible");
            if (!delivery.media) throw new Error("Synthetic specification did not save media");
            result = await results.attachMedia({ ownerId: alice.id, taskId: task.id, media: delivery.media });
            task = await tasks.transitionExecution({ ownerId: alice.id, taskId: task.id, status: "succeeded" });
            task = await tasks.transitionDelivery({ ownerId: alice.id, taskId: task.id, status: "saved" });
            expect(await createGenerationWalletSettlement(database.db)({ task, result, delivery })).toBe("pending_review");
        }
        if (interruption === "capture") await run.wallets.capture({ userId: alice.id, reservationId: task.reservationId!, capturedUnits: 11,
            idempotencyKey: `generation:${task.id}:capture`, referenceType: "generation", referenceId: task.id });
        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { executionStatus: "succeeded", billingStatus: "captured" } });
        expect(await run.wallets.getReservation(alice.id, task.reservationId!)).toMatchObject({ capturedUnits: "11", releasedUnits: "0", status: "captured" });
        const saved = await records(task.id);
        expect(saved.results).toHaveLength(1); expect(saved.media).toHaveLength(1); expect(saved.reservations).toHaveLength(1);
        expect(saved.ledger.filter((entry) => entry.kind === "capture")).toMatchObject([{ deltaReservedUnits: "-11" }]);
        expect(saved.ledger.filter((entry) => entry.kind === "release")).toHaveLength(0);
        expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(1);
        const beforeWallet = await run.wallets.get(alice.id), beforeQuota = await run.media.getQuota(alice.id, quotaBytes);
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(await records(task.id)).toEqual(saved); expect(await run.wallets.get(alice.id)).toEqual(beforeWallet);
        expect(await run.media.getQuota(alice.id, quotaBytes)).toEqual(beforeQuota); expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(1);
    }
});

test("persisted image evidence cannot be omitted or replaced by a verified marker during replay", async () => {
    for (const evidence of [undefined, { status: "verified" }]) {
        const run = await scenario(), tasks = createGenerationTaskRepository(database.db);
        const task = await tasks.claimRunning({ ownerId: alice.id, taskId: run.task.id });
        if (!task) throw new Error("Synthetic task did not claim");
        const normalized = await run.provider(task);
        if (normalized.status !== "succeeded") throw new Error("Synthetic specification did not normalize");
        const snapshot = structuredClone(normalized.resultSnapshot);
        if (evidence === undefined) delete snapshot.imageSpecEvidence;
        else snapshot.imageSpecEvidence = evidence;
        await createGenerationResultRepository(database.db).create({ ownerId: alice.id, taskId: task.id, ...normalized, resultSnapshot: snapshot });
        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { billingStatus: "pending_review" }, delivery: { status: "unknown" } });
        await expectPendingReview(run);
        expect(await run.media.get(alice.id, task.id)).toBeNull(); expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
    }
});

test("saved and visible media are reverified before a recovering reservation can be captured", async () => {
    for (const deliveryStatus of ["saved", "visible"] as const) {
        const run = await scenario(), tasks = createGenerationTaskRepository(database.db), results = createGenerationResultRepository(database.db);
        let task = await tasks.claimRunning({ ownerId: alice.id, taskId: run.task.id });
        if (!task) throw new Error("Synthetic task did not claim");
        const normalized = await run.provider(task);
        if (normalized.status !== "succeeded") throw new Error("Synthetic specification did not normalize");
        const stored = await results.create({ ownerId: alice.id, taskId: task.id, ...normalized });
        const delivery = await run.dependencies.deliver({ task, result: stored.result });
        if ((delivery.status !== "saved" && delivery.status !== "visible") || !delivery.media) throw new Error("Synthetic delivery did not persist");
        await results.attachMedia({ ownerId: alice.id, taskId: task.id, media: delivery.media });
        task = await tasks.transitionExecution({ ownerId: alice.id, taskId: task.id, status: "succeeded" });
        task = await tasks.transitionDelivery({ ownerId: alice.id, taskId: task.id, status: "saved" });
        if (deliveryStatus === "visible") task = await tasks.transitionDelivery({ ownerId: alice.id, taskId: task.id, status: "visible" });
        const beforeRow = await run.media.get(alice.id, task.id), beforeQuota = await run.media.getQuota(alice.id, quotaBytes);
        const originalGet = run.storage.get;
        run.storage.get = async (key) => {
            const storedObject = await originalGet(key);
            if (storedObject && key === run.mediaKey) storedObject.body[0] ^= 1;
            return storedObject;
        };
        const corrupted = await run.storage.get(run.mediaKey);
        expect(corrupted?.metadata).toMatchObject({ etag: beforeRow!.etag, sizeBytes: beforeRow!.sizeBytes, contentType: beforeRow!.contentType });
        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { billingStatus: "pending_review" }, delivery: { status: "unknown" } });
        await expectPendingReview(run);
        expect(await run.media.get(alice.id, task.id)).toEqual(beforeRow); expect(await run.media.getQuota(alice.id, quotaBytes)).toEqual(beforeQuota);
        expect((await records(task.id)).media).toHaveLength(1); expect(run.observed).toHaveLength(1); expect(run.operations).toEqual({ put: 1, delete: 0 });
        await processGenerationJob(database.db, run.payload, run.dependencies);
        await expectPendingReview(run); expect(run.observed).toHaveLength(1); expect(run.operations).toEqual({ put: 1, delete: 0 });
    }
});

test("the executable catalog lists supported specification models alongside the existing scalar image control", async () => {
    const specification = await model(), scalar = await model(true);
    const response = await request("/api/v1/generation/models", alice);
    expect(response.status).toBe(200);
    const catalog = (await response.json()).items as Array<{ id: string }>;
    expect(catalog.some((item) => item.id === specification.modelId)).toBe(true);
    expect(catalog.some((item) => item.id === scalar.modelId)).toBe(true);
});

test("the executable image pricing projects every combination from the same published version as public pricing", async () => {
    const fixture = await model(), audit = { actorId: alice.id, requestId: crypto.randomUUID() };
    async function catalogPrice() {
        const catalog = await request("/api/v1/generation/models", alice);
        expect(catalog.status).toBe(200);
        const item = (await catalog.json()).items.find((row: { id: string }) => row.id === fixture.modelId);
        const pricing = await request("/api/v1/model-pricing", alice);
        const publicPrice = (await pricing.json()).items.find((row: { modelId: string }) => row.modelId === fixture.modelId);
        expect(item.imagePricing).toEqual({ protocol: "openai-image-v1", priceVersion: publicPrice.version, billingUnit: "image_specs", creditsPerUnit: null,
            imageSpecs: publicPrice.imageSpecs, priceNote: publicPrice.priceNote });
        for (const hidden of [fixture.publication.id, fixture.binding.providerId, fixture.binding.providerModel,
            fixture.binding.endpoint, credential, "rules", "sourceDraft", "cost", "binding"]) expect(JSON.stringify(item)).not.toContain(hidden);
        return item.imagePricing;
    }
    const original = await catalogPrice();
    expect(original).toMatchObject({ priceVersion: 1, imageSpecs: [
        { parameters: low, creditsPerRequest: 7 }, { parameters: high, creditsPerRequest: 11 },
    ] });
    const next = structuredClone(fixture.draft); next.expectedVersion = 1;
    next.rules.sale.bands[0]!.rates.request = "19"; next.rules.sale.bands[1]!.rates.request = "23";
    const saved = await createModelPriceDraft(database.db, next, audit);
    if (saved.status !== "saved") throw new Error("Synthetic pending catalog draft did not save");
    expect(await catalogPrice()).toEqual(original); // A newer private draft is not the executable publication.
    expect((await publishModelPriceDraft(database.db, { modelId: fixture.modelId, draftId: saved.draft.id,
        expectedDraftVersion: saved.draft.version, expectedPriceVersion: 1, binding: fixture.binding,
        publicPriceNote: "Synthetic published catalog rotation" }, audit)).status).toBe("published");
    expect(await catalogPrice()).toMatchObject({ priceVersion: 2, imageSpecs: [
        { parameters: low, creditsPerRequest: 19 }, { parameters: high, creditsPerRequest: 23 },
    ] });
});

test("specification tasks cannot deliver a text success from a provider seam or a persisted result", async () => {
    for (const persisted of [false, true]) {
        const run = await scenario(), textSnapshot = { kind: "text", text: "Synthetic text is not an image result" };
        if (persisted) {
            expect(await createGenerationTaskRepository(database.db).claimRunning({ ownerId: alice.id, taskId: run.task.id })).not.toBeNull();
            await createGenerationResultRepository(database.db).create({ ownerId: alice.id, taskId: run.task.id,
                status: "succeeded", consumedUnits: 1, resultSnapshot: textSnapshot });
        }
        let providerCalls = 0, deliveryCalls = 0;
        const textProfileDelivery = createGenerationDelivery();
        const dependencies = { ...run.dependencies,
            async provider() { providerCalls++; return { status: "succeeded" as const, consumedUnits: 1, resultSnapshot: textSnapshot }; },
            async deliver(input: Parameters<typeof textProfileDelivery>[0]) { deliveryCalls++; return textProfileDelivery(input); },
        };
        const first = await processGenerationJob(database.db, run.payload, dependencies);
        expect(first.task).toMatchObject({ deliveryStatus: "unknown", billingStatus: "pending_review" });
        expect(first.delivery).toMatchObject({ status: "unknown", unknownReason: "image_spec_evidence_conflicting" });
        expect(first.result.status).toBe(persisted ? "succeeded" : "unknown");
        if (!persisted) expect(first.result.consumedUnits).toBeNull();
        await expectPendingReview(run);
        expect(await run.media.get(alice.id, run.task.id)).toBeNull(); expect(await run.storage.get(run.mediaKey)).toBeNull();
        expect(deliveryCalls).toBe(0); expect(providerCalls).toBe(persisted ? 0 : 1); expect(run.observed).toHaveLength(0);
        await processGenerationJob(database.db, run.payload, dependencies);
        await expectPendingReview(run);
        expect(deliveryCalls).toBe(0); expect(providerCalls).toBe(persisted ? 0 : 1); expect(run.operations.put).toBe(0);
    }
});

test("missing, zero or multiple request units become unknown before delivery or capture", async () => {
    for (const consumedUnits of [undefined, 0, 2]) {
        const run = await scenario();
        let deliveryCalls = 0;
        const dependencies = { ...run.dependencies,
            async provider(task: Parameters<typeof run.provider>[0]) {
                const normalized = await run.provider(task);
                if (normalized.status !== "succeeded") throw new Error("Synthetic image evidence did not normalize");
                return { ...normalized, consumedUnits };
            },
            async deliver(input: Parameters<typeof run.dependencies.deliver>[0]) { deliveryCalls++; return run.dependencies.deliver(input); },
        };
        const first = await processGenerationJob(database.db, run.payload, dependencies);
        expect(first.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
        expect(first.result).toMatchObject({ status: "unknown", consumedUnits: null, unknownReason: "image_spec_evidence_conflicting" });
        await expectPendingReview(run);
        expect(deliveryCalls).toBe(0); expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
        expect(await run.media.get(alice.id, run.task.id)).toBeNull(); expect(await run.storage.get(run.mediaKey)).toBeNull();
        const before = await records(run.task.id);
        await processGenerationJob(database.db, run.payload, dependencies);
        expect(await records(run.task.id)).toEqual(before); expect(run.observed).toHaveLength(1); expect(deliveryCalls).toBe(0);
    }
});

test("disabling an accepted provider or model prevents its first supplier request and releases the original reservation", async () => {
    for (const disabled of ["provider", "model"] as const) {
        const run = await scenario({ parameters: high });
        if (disabled === "provider") await database.db.update(modelProvider).set({ enabled: false }).where(eq(modelProvider.id, run.fixture.providerId));
        else await database.db.update(modelCatalog).set({ enabled: false }).where(eq(modelCatalog.id, run.fixture.modelId));
        const first = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(first.task).toMatchObject({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released",
            priceVersion: 1, pricePublicationId: run.fixture.publication.id, quotedUnits: 11 });
        expect(await run.wallets.getReservation(alice.id, run.task.reservationId!)).toMatchObject({ requestedUnits: "11", capturedUnits: "0", releasedUnits: "11", status: "released" });
        const before = await records(run.task.id);
        expect(before.ledger.filter((entry) => entry.kind === "capture")).toHaveLength(0);
        expect(before.ledger.filter((entry) => entry.kind === "release")).toMatchObject([{ deltaAvailableUnits: "11", deltaReservedUnits: "-11" }]);
        expect(before.media).toHaveLength(0); expect(run.observed).toHaveLength(0); expect(run.operations.put).toBe(0);
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(await records(run.task.id)).toEqual(before); expect(run.observed).toHaveLength(0);
    }
});

test("a durable result and media settle at their historical price after current price, provider and model are disabled", async () => {
    const run = await scenario({ parameters: high }), tasks = createGenerationTaskRepository(database.db), results = createGenerationResultRepository(database.db);
    let task = await tasks.claimRunning({ ownerId: alice.id, taskId: run.task.id });
    if (!task) throw new Error("Synthetic task did not claim");
    const normalized = await run.provider(task);
    if (normalized.status !== "succeeded") throw new Error("Synthetic matching specification did not normalize");
    const stored = await results.create({ ownerId: alice.id, taskId: task.id, ...normalized });
    const delivery = await run.dependencies.deliver({ task, result: stored.result });
    if ((delivery.status !== "saved" && delivery.status !== "visible") || !delivery.media) throw new Error("Synthetic delivery did not persist");
    await results.attachMedia({ ownerId: alice.id, taskId: task.id, media: delivery.media });
    task = await tasks.transitionExecution({ ownerId: alice.id, taskId: task.id, status: "succeeded" });
    await tasks.transitionDelivery({ ownerId: alice.id, taskId: task.id, status: "saved" });
    const next = structuredClone(run.fixture.draft); next.expectedVersion = 1;
    next.rules.sale.bands[0]!.rates.request = "19"; next.rules.sale.bands[1]!.rates.request = "23";
    await publish(next, 1);
    await database.db.update(modelPricing).set({ enabled: false }).where(eq(modelPricing.modelId, run.fixture.modelId));
    await database.db.update(modelProvider).set({ enabled: false }).where(eq(modelProvider.id, run.fixture.providerId));
    await database.db.update(modelCatalog).set({ enabled: false }).where(eq(modelCatalog.id, run.fixture.modelId));
    const row = await run.media.get(alice.id, task.id), quota = await run.media.getQuota(alice.id, quotaBytes);
    const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(replay).toMatchObject({ replay: true, task: { executionStatus: "succeeded", billingStatus: "captured", priceVersion: 1,
        pricePublicationId: run.fixture.publication.id, quotedUnits: 11, creditsPerUnitSnapshot: 11 } });
    expect(await run.wallets.getReservation(alice.id, task.reservationId!)).toMatchObject({ requestedUnits: "11", capturedUnits: "11", releasedUnits: "0", status: "captured" });
    const saved = await records(task.id);
    expect(saved.results).toHaveLength(1); expect(saved.media).toHaveLength(1); expect(saved.reservations).toHaveLength(1); expect(saved.jobs).toHaveLength(1);
    expect(saved.ledger.filter((entry) => entry.kind === "capture")).toMatchObject([{ deltaReservedUnits: "-11" }]);
    expect(saved.ledger.filter((entry) => entry.kind === "release")).toHaveLength(0);
    expect(await run.media.get(alice.id, task.id)).toEqual(row); expect(await run.media.getQuota(alice.id, quotaBytes)).toEqual(quota);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(await records(task.id)).toEqual(saved); expect(run.observed).toHaveLength(1); expect(run.operations).toEqual({ put: 1, delete: 0 });
});

test("a running task without a durable result recovers unknown without a second supplier request", async () => {
    const run = await scenario(), tasks = createGenerationTaskRepository(database.db);
    const task = await tasks.claimRunning({ ownerId: alice.id, taskId: run.task.id });
    if (!task) throw new Error("Synthetic task did not claim");
    // The supplier may already have completed, but the worker exited before persisting its response.
    await run.provider(task);
    expect(run.observed).toHaveLength(1);
    expect(await createGenerationResultRepository(database.db).get(alice.id, task.id)).toBeNull();
    const dependencies = { ...run.dependencies, runningLeaseMs: 0 };
    const recovered = await processGenerationJob(database.db, run.payload, dependencies);
    expect(recovered).toMatchObject({ replay: true, task: { executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" },
        result: { status: "unknown", unknownReason: "worker_replayed_after_running", consumedUnits: null } });
    await expectPendingReview(run);
    expect(await run.media.get(alice.id, task.id)).toBeNull(); expect(await run.storage.get(run.mediaKey)).toBeNull();
    const before = await records(task.id);
    await processGenerationJob(database.db, run.payload, dependencies);
    expect(await records(task.id)).toEqual(before); expect(run.observed).toHaveLength(1); expect(run.operations.put).toBe(0);
});

test("an over-budget selected specification is rejected before quote acceptance or any new reservation", async () => {
    const fixture = await model(), oversized = { size: "4097x4096", quality: "low" } as const;
    const next = structuredClone(fixture.draft); next.expectedVersion = 1;
    next.rules.sale.bands = [{ parameters: { ...oversized }, rates: { request: "7" } }];
    await publish(next, 1);
    const accountState = async () => ({ wallet: await createWalletRepository(database.db).get(alice.id),
        tasks: await database.db.select().from(generationTask).where(eq(generationTask.ownerId, alice.id)),
        reservations: await database.db.select().from(walletReservation).where(eq(walletReservation.userId, alice.id)),
        ledger: await database.db.select().from(walletLedger).where(eq(walletLedger.userId, alice.id)), jobs: [...jobs] });
    const before = await accountState();
    const quote = await request("/api/v1/generation/quote", alice, intent(fixture.modelId, oversized));
    expect(quote.status).toBe(400); expect((await quote.json()).error.code).toBe("unsupported_generation");
    const acceptance = await request("/api/v1/generation/tasks", alice, { ...intent(fixture.modelId, oversized),
        confirmedPriceVersion: 2, confirmedQuoteFingerprint: "0".repeat(64) }, crypto.randomUUID());
    expect(acceptance.status).toBe(400); expect((await acceptance.json()).error.code).toBe("unsupported_generation");
    expect(await accountState()).toEqual(before);
    const catalog = await request("/api/v1/generation/models", alice);
    expect((await catalog.json()).items.some((item: { id: string }) => item.id === fixture.modelId)).toBe(false);
});
