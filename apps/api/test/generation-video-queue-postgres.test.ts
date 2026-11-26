import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase } from "@infinite-canvas/database";
import { createJobQueue, GENERATION_QUEUE_NAME, isGenerationQueueReady, type GenerationJobPayload } from "@infinite-canvas/jobs";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { modelCatalog, modelProvider, user, wallet } from "@infinite-canvas/database/schema";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { quoteReserveAndEnqueueConfirmedVideoTask } from "../src/generation-video-dispatch";
import { resolveExecutableVideoQuote } from "../src/generation-video-policy";
import { createGenerationVideoDriver, type GenerationVideoDriverOptions } from "../src/generation-video-stage";
import type { GenerationQueueSender } from "../src/generation-dispatch";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
import { createGenerationWalletSettlement } from "../src/generation-worker";
import { normalizeVideoProviderResponse } from "../src/video-provider-response";
import { createTestDatabase, postgresTestUrl } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL) throw new Error("Real video queue tests refuse external runtime targets");
const url = process.env.SAAS_POSTGRES_TEST_SUITE === "video-generation" ? postgresTestUrl() : null;
const native = url ? test : test.skip;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { if (url) database = await createTestDatabase(); }, 30000);
afterAll(async () => { await database?.close(); });
const parameters: VideoParameters = { mode: "text", resolution: "480p", durationSeconds: 1, aspectRatio: "16:9", generateAudio: false };
// These queue/state tests do not claim successful media delivery or invent probe evidence.
const policy = { createTimeoutMs: 100, inspectTimeoutMs: 100, downloadTimeoutMs: 100, jsonMaxBytes: 4096, pollIntervalMs: 100,
    claimLeaseMs: 2000, recoveryScanIntervalMs: 100, recoveryScanBatchSize: 1000, observationWindowMs: 30000, maxInspectAttempts: 10,
    maxDownloadAttempts: 3, maxVideoBytes: 4096, maxPixels: 1000000, maxMediaDurationMs: 15000, referenceMaxBytes: 1024,
    referenceMaxPixels: 1000000, referenceContentTypes: ["image/png"], probeTimeoutMs: 100 } as VideoRuntimePolicy;
async function fixture() {
    const ownerId = crypto.randomUUID(), modelId = `video-queue-${crypto.randomUUID()}`, providerId = crypto.randomUUID();
    const secret = "synthetic-video-queue-only-auth-secret";
    await database.db.insert(user).values({ id: ownerId, email: `${ownerId}@example.test`, name: "Synthetic queue owner", role: "admin" });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    const binding = { providerId, providerModel: "explicit-synthetic-model", endpoint: "https://synthetic-video.example.test/v1", adapter: "openai-compatible" as const, capability: "video" as const };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic queue provider", endpoint: binding.endpoint, adapter: binding.adapter, enabled: true, secretRef: "synthetic" });
    await saveProviderCredential(database.db, secret, providerId, "synthetic-video-queue-credential");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: binding.providerModel, displayName: "Synthetic queue video", capability: "video", enabled: true });
    const audit = { actorId: ownerId, requestId: crypto.randomUUID() };
    const draft = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, priceNote: "Synthetic only", rules: { schemaVersion: 1, cost: null,
        video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY }, sale: { template: "video_count", currency: "credit", bands: [{
            parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), rates: { video: "3" } }] } } }, audit);
    if (draft.status !== "saved") throw new Error(draft.status);
    const published = await publishModelPriceDraft(database.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: draft.draft.version,
        expectedPriceVersion: 0, binding, publicPriceNote: "Synthetic queue only" }, audit);
    if (published.status !== "published") throw new Error(published.status);
    let boss = createJobQueue(url!, () => undefined); await boss.start(); expect(isGenerationQueueReady(await boss.getQueue(GENERATION_QUEUE_NAME))).toBe(true);
    const priority = 100000 + Math.floor(Math.random() * 1000000000); // Test-owned fetch lane; no product policy changes.
    const sent: { id: string; taskId: string; ownerId: string }[] = [];
    const sender: GenerationQueueSender = { async send(name, payload, options) {
        const id = await boss.send(name, payload, { ...(options as any), priority: payload.ownerId === ownerId ? priority : 0 });
        if (id) sent.push({ id, taskId: payload.taskId, ownerId: payload.ownerId }); return id;
    } };
    const input = { ownerId, modelId, inputSnapshot: { prompt: "Synthetic durable queue" }, parameterSnapshot: parameters, requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const quote = await resolveExecutableVideoQuote(database.db, input, ownerId, policy);
    const accepted = await quoteReserveAndEnqueueConfirmedVideoTask(database.db, sender, input, quote.priceVersion, quote.quoteFingerprint, policy);
    const initialId = sent[0].id, payload: GenerationJobPayload = { schemaVersion: 1, ownerId, taskId: accepted.task.id, requestId: input.requestId };
    let clock = new Date();
    const driver = (provider: GenerationVideoDriverOptions["provider"], queue = sender, db = database.db) => createGenerationVideoDriver({ database: db, queue, policy,
        provider, now: () => clock, async prepare(task, stage) {
            if (!await validatePublishedGenerationTask(db, task, { providerId: stage.providerId, providerModel: stage.providerModel, endpoint: stage.endpoint, adapter: "openai-compatible", capability: "video" })) throw new Error("Original source invalid");
            return { input: { prompt: String(task.inputSnapshot.prompt) } };
        }, async deliver() { return { status: "unknown", unknownReason: "queue_test_has_no_media_delivery" }; }, settleBilling: createGenerationWalletSettlement(db) });
    const snapshot = async () => ({ task: await createGenerationTaskRepository(database.db).get(ownerId, accepted.task.id),
        stage: await createGenerationVideoStageRepository(database.db).get(ownerId, accepted.task.id), result: await createGenerationResultRepository(database.db).get(ownerId, accepted.task.id),
        reservation: await createWalletRepository(database.db).getReservation(ownerId, accepted.task.reservationId!) });
    return { ownerId, taskId: accepted.task.id, payload, initialId, sent, sender, driver, snapshot,
        fetch: () => boss.fetch<GenerationJobPayload>(GENERATION_QUEUE_NAME, { minPriority: priority, maxPriority: priority, batchSize: 20, includeMetadata: true, ignoreStartAfter: true }),
        get: (id: string) => boss.getJobById<GenerationJobPayload>(GENERATION_QUEUE_NAME, id),
        restartQueue: async () => { await boss.stop(); boss = createJobQueue(url!, () => undefined); await boss.start(); },
        advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); }, stop: () => boss.stop() };
}
function response(operation: "create" | "inspect", id: string, status: string) {
    return operation === "create" ? normalizeVideoProviderResponse({ operation, httpStatus: 200, payload: { object: "video", id, status } })
        : normalizeVideoProviderResponse({ operation, expectedTaskId: id, httpStatus: 200, payload: { object: "video", id, status } });
}

native("a genuinely active pg-boss job may remain stuck while a new driver recovers and queries only its durable original ID", async () => {
    const f = await fixture(); let creates = 0; const queries: string[] = [];
    const provider = { async create() { creates++; return response("create", "original-active-id", "queued"); },
        async inspect(_binding: unknown, id: string) { queries.push(id); return response("inspect", id, "in_progress"); } };
    try {
        const first = (await f.fetch()).find(job => job.id === f.initialId); expect(first?.state).toBe("active");
        await f.driver(provider).process(first!.data);
        expect((await f.get(f.initialId))?.state).toBe("active");
        await f.restartQueue(); f.advance(policy.claimLeaseMs + policy.pollIntervalMs + 1);
        const before = f.sent.filter(row => row.taskId === f.taskId).length, restarted = f.driver(provider);
        await restarted.recover();
        const owned = f.sent.filter(row => row.taskId === f.taskId); expect(owned.length).toBe(before + 1);
        const recoveryId = owned.at(-1)!.id;
        expect((await f.get(recoveryId))?.data).toEqual(f.payload);
        const recovered = (await f.fetch()).find(job => job.id === recoveryId); expect(recovered?.state).toBe("active");
        await restarted.process(recovered!.data);
        expect(creates).toBe(1); expect(queries).toEqual(["original-active-id"]);
        expect((await f.get(f.initialId))?.state).toBe("active");
        expect((await f.snapshot()).reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
        // End this synthetic observation by its explicit window, preserving its freeze.
        f.advance(policy.observationWindowMs + 1); await restarted.process(f.payload);
        expect((await f.snapshot()).stage?.nextActionAt).toBeNull();
    } finally { await f.stop(); }
}, 30000);

native("a real queue.send candidate ID rolls back with accepted state when the same transaction throws after send", async () => {
    const f = await fixture(); let acceptedAck = false, candidateId: string | null | undefined, creates = 0;
    const fault: GenerationQueueSender = { async send(name, payload, options) {
        const id = await f.sender.send(name, payload, options); if (acceptedAck) { candidateId = id; throw new Error("synthetic_after_real_queue_send"); } return id;
    } };
    try {
        const provider = { async create() { creates++; acceptedAck = true; return response("create", "ack-before-queue-rollback", "queued"); }, async inspect() { throw new Error("No durable ID"); } };
        await expect(f.driver(provider, fault).process(f.payload)).rejects.toThrow("synthetic_after_real_queue_send");
        expect(candidateId).toBeTruthy(); expect(await f.get(candidateId!)).toBeNull();
        const state = await f.snapshot();
        expect(state.stage).toMatchObject({ phase: "create_started", providerTaskId: null }); expect(state.task?.providerTaskId).toBeNull(); expect(state.result).toBeNull();
        f.advance(policy.claimLeaseMs + 1); await f.driver(provider).process(f.payload);
        expect(creates).toBe(1); expect((await f.snapshot()).task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
        expect((await f.snapshot()).reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
    } finally { await f.stop(); }
}, 30000);

native("two independent real PostgreSQL pools competing for one queued video authorize only one supplier POST", async () => {
    const f = await fixture(), second = createDatabase(url!); let creates = 0, started!: () => void, acknowledge!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { acknowledge = resolve; });
    const provider = { async create() { creates++; started(); await gate; return response("create", "one-post-two-backends", "queued"); }, async inspect() { throw new Error("Not due"); } };
    try {
        const firstBackend = await database.pool.query({ text: "SELECT pg_backend_pid() AS pid", values: [] }), secondBackend = await second.pool.query("SELECT pg_backend_pid() AS pid");
        expect(firstBackend.rows[0].pid).not.toBe(secondBackend.rows[0].pid);
        const a = f.driver(provider).process(f.payload), b = f.driver(provider, f.sender, second.db).process(f.payload);
        await begun; acknowledge(); await Promise.all([a, b]);
        expect(creates).toBe(1);
        const state = await f.snapshot(); expect(state.stage).toMatchObject({ phase: "accepted", providerTaskId: "one-post-two-backends" });
        expect(state.stage?.createAttemptToken).toBeTruthy(); expect(state.result).toBeNull();
        expect(state.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
        f.advance(policy.observationWindowMs + 1); await f.driver(provider).process(f.payload);
    } finally { acknowledge?.(); await second.close(); await f.stop(); }
}, 30000);
