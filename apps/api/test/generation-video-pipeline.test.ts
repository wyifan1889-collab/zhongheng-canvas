import { afterAll, beforeAll, expect, test } from "bun:test";
import sharp from "sharp";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { generationTask, generationVideoStage, modelCatalog, modelPricing, modelProvider, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import type { GenerationQueueSender } from "../src/generation-dispatch";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
import { quoteReserveAndEnqueueConfirmedVideoTask, type VideoTaskIntent } from "../src/generation-video-dispatch";
import { listExecutableVideoModels, resolveExecutableVideoQuote, type VideoReferenceResources } from "../src/generation-video-policy";
import { inspectGenerationVideoReference } from "../src/generation-video-probe";
import { createGenerationVideoDriver, type GenerationVideoDriverOptions } from "../src/generation-video-stage";
import { parseGenerationVideoRequest } from "../src/generation-video-request";
import { createGenerationWalletSettlement } from "../src/generation-worker";
import { normalizeVideoProviderResponse, type VideoProviderResponse } from "../src/video-provider-response";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE !== "video-generation") {
    throw new Error("Use isolated PGlite or an explicitly isolated video-generation PostgreSQL runner only");
}
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = `video-pipeline-${crypto.randomUUID()}`, otherOwnerId = `video-other-${crypto.randomUUID()}`, authSecret = `synthetic-video-pipeline-${crypto.randomUUID()}`;
const parameters: VideoParameters = { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" };
// Synthetic test policy only. These numbers neither change defaults nor authorize runtime activation.
const policy: VideoRuntimePolicy = { createTimeoutMs: 100, inspectTimeoutMs: 100, downloadTimeoutMs: 100, jsonMaxBytes: 4096,
    pollIntervalMs: 100, claimLeaseMs: 2000, recoveryScanIntervalMs: 100, recoveryScanBatchSize: 10,
    observationWindowMs: 10000, maxInspectAttempts: 10, maxDownloadAttempts: 3,
    maxVideoBytes: 4096, maxPixels: 1000000, maxMediaDurationMs: 15000, referenceMaxBytes: 1024, referenceMaxPixels: 1000000,
    referenceContentTypes: ["image/png"], ffprobePath: "C:/synthetic/ffprobe.exe", ffmpegPath: "C:/synthetic/ffmpeg.exe",
    probeTimeoutMs: 100, probeStdoutMaxBytes: 4096, probeStderrMaxBytes: 4096, probeMemoryMaxBytes: 1000000, probeCpuLimit: 100, probeTempRoot: "C:/synthetic/video" };

beforeAll(async () => {
    database = await createTestDatabase();
    for (const id of [ownerId, otherOwnerId]) await database.db.insert(user).values({ id, name: "Synthetic video pipeline", email: `${id}@example.test`, role: "admin" });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
}, 30_000);
afterAll(async () => { await database?.close(); });

async function seed(chosen: VideoParameters = parameters, reference?: { mediaId: string; resources: VideoReferenceResources }) {
    const modelId = `video-model-${crypto.randomUUID()}`, providerId = `video-channel-${crypto.randomUUID()}`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic video channel", adapter: "openai-compatible", endpoint: "https://synthetic-video.example.test/v1", secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, authSecret, providerId, "synthetic-video-key");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: "administrator-selected-video", displayName: "Synthetic video", capability: "video", enabled: true });
    const binding = { providerId, providerModel: "administrator-selected-video", adapter: "openai-compatible" as const, endpoint: "https://synthetic-video.example.test/v1", capability: "video" as const };
    const saved = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, priceNote: "Synthetic only; procurement cost unknown",
        rules: { schemaVersion: 1, video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY }, cost: null,
            sale: { template: "video_count", currency: "credit", bands: [{ parameters: Object.fromEntries(Object.entries(chosen).map(([key, value]) => [key, String(value)])), rates: { video: "7" } }] } } }, { actorId: ownerId, requestId: crypto.randomUUID() });
    if (saved.status !== "saved") throw new Error(saved.status);
    const published = await publishModelPriceDraft(database.db, { modelId, draftId: saved.draft.id, expectedDraftVersion: 1, expectedPriceVersion: 0, binding, publicPriceNote: "Synthetic seven credits per delivered video" }, { actorId: ownerId, requestId: crypto.randomUUID() });
    if (published.status !== "published") throw new Error(published.status);
    const input: VideoTaskIntent = { ownerId, modelId, inputSnapshot: { prompt: "Synthetic video task", ...(reference ? { referenceMediaId: reference.mediaId } : {}) },
        parameterSnapshot: { ...chosen }, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() };
    const quote = await resolveExecutableVideoQuote(database.db, input, ownerId, policy, false, reference?.resources);
    const jobs: GenerationJobPayload[] = [];
    const queue: GenerationQueueSender = { async send(name, payload, options) {
        expect(name).toBe("generation"); expect(options?.db).toBeDefined();
        jobs.push(structuredClone(payload)); return crypto.randomUUID();
    } };
    const submit = (sender: GenerationQueueSender = queue, intent: VideoTaskIntent = input) => quoteReserveAndEnqueueConfirmedVideoTask(database.db, sender, intent,
        quote.priceVersion, quote.quoteFingerprint, policy, { resources: reference?.resources });
    return { input, quote, queue, jobs, submit };
}
const financialState = () => Promise.all([database.db.select().from(wallet), database.db.select().from(walletLedger), database.db.select().from(walletReservation)]);
const dispatchState = async () => ({ money: await financialState(), tasks: await database.db.select().from(generationTask), stages: await database.db.select().from(generationVideoStage) });
async function snapshot(taskId: string) {
    const task = await createGenerationTaskRepository(database.db).get(ownerId, taskId);
    return { task, stage: await createGenerationVideoStageRepository(database.db).get(ownerId, taskId),
        result: await createGenerationResultRepository(database.db).get(ownerId, taskId),
        reservation: task?.reservationId ? await createWalletRepository(database.db).getReservation(ownerId, task.reservationId) : null,
        ledger: (await createWalletRepository(database.db).listLedger(ownerId)).filter(row => row.referenceId === taskId) };
}
function driver(fixture: Awaited<ReturnType<typeof seed>>, provider: GenerationVideoDriverOptions["provider"], custom: Partial<GenerationVideoDriverOptions> = {}) {
    let clock = new Date();
    const options: GenerationVideoDriverOptions = { database: database.db, queue: fixture.queue, policy, provider, now: () => clock,
        async prepare(task, stage) {
            if (!await validatePublishedGenerationTask(database.db, task, { providerId: stage.providerId, providerModel: stage.providerModel,
                endpoint: stage.endpoint, adapter: "openai-compatible", capability: "video" })) throw new Error("Invalid original video price");
            return { input: parseGenerationVideoRequest(task).input };
        },
        // These state/failure tests never fake a successfully probed or delivered video.
        async deliver() { return { status: "unknown", unknownReason: "synthetic_delivery_unavailable" }; },
        settleBilling: createGenerationWalletSettlement(database.db, { videoNow: () => clock }), ...custom };
    return { options, instance: createGenerationVideoDriver(options), advance(milliseconds: number) { clock = new Date(clock.getTime() + milliseconds); } };
}
function observation(operation: "create" | "inspect", providerTaskId: string, status: string): VideoProviderResponse {
    return operation === "create" ? normalizeVideoProviderResponse({ operation, httpStatus: 200, payload: { object: "video", id: providerTaskId, status } })
        : normalizeVideoProviderResponse({ operation, expectedTaskId: providerTaskId, httpStatus: 200, payload: { object: "video", id: providerTaskId, status } });
}

test("initial video dispatch shares task, reservation and immutable stage transaction and same-key replay sends no second job", async () => {
    const fixture = await seed(), accepted = await fixture.submit();
    expect(accepted.created).toBe(true); expect(fixture.jobs).toHaveLength(1);
    expect(accepted.task).toMatchObject({ executionStatus: "queued", billingStatus: "reserved", quotedUnits: 7, creditsPerUnitSnapshot: 7 });
    const stages = createGenerationVideoStageRepository(database.db), stage = await stages.get(ownerId, accepted.task.id);
    expect(stage).toMatchObject({ ownerId, taskId: accepted.task.id, protocol: VIDEO_PROTOCOL, phase: "ready", providerTaskId: null,
        createAttemptToken: null, parametersSnapshot: parameters, pricePublicationId: fixture.quote.videoQuoteSnapshot.publicationId });
    expect(await stages.get(otherOwnerId, accepted.task.id)).toBeNull();
    const state = await financialState();
    expect(await fixture.submit()).toMatchObject({ created: false, jobId: null, task: { id: accepted.task.id } });
    expect(await financialState()).toEqual(state); expect(fixture.jobs).toHaveLength(1);
    const reservations = await createWalletRepository(database.db).getReservation(ownerId, accepted.task.reservationId!);
    expect(reservations).toMatchObject({ taskId: accepted.task.id, requestedUnits: "7", capturedUnits: "0", releasedUnits: "0" });
});

test("same-key replay rejects every changed legal video dimension before new quotes, reserve or enqueue", async () => {
    const fixture = await seed(), accepted = await fixture.submit(), before = await dispatchState(), original = await snapshot(accepted.task.id);
    const changed: VideoTaskIntent[] = [
        { ...fixture.input, parameterSnapshot: { ...parameters, resolution: "1080p" } },
        { ...fixture.input, parameterSnapshot: { ...parameters, durationSeconds: 6 } },
        { ...fixture.input, parameterSnapshot: { ...parameters, generateAudio: true } },
        { ...fixture.input, parameterSnapshot: { ...parameters, aspectRatio: "9:16" } },
        { ...fixture.input, inputSnapshot: { ...fixture.input.inputSnapshot, referenceMediaId: crypto.randomUUID() },
            parameterSnapshot: { mode: "first_frame", resolution: parameters.resolution, durationSeconds: parameters.durationSeconds, generateAudio: parameters.generateAudio } },
    ];
    // Only the original band is published. Replays must compare the original
    // contract before looking for a new band or reading a replacement reference.
    for (const intent of changed) {
        expect(parseGenerationVideoRequest(intent).parameters).toEqual(intent.parameterSnapshot);
        await expect(fixture.submit(fixture.queue, intent)).rejects.toMatchObject({ code: "idempotency_conflict" });
        expect(await dispatchState()).toEqual(before); expect(await snapshot(accepted.task.id)).toEqual(original);
        expect(fixture.jobs).toHaveLength(1);
    }
    expect(await fixture.submit()).toMatchObject({ created: false, jobId: null, task: { id: accepted.task.id } });
    expect(await dispatchState()).toEqual(before); expect(fixture.jobs).toHaveLength(1);
});

test("same-key first-frame replay cannot replace its private reference and still replays the original contract", async () => {
    const storage = createMemoryObjectStorage(), mediaId = crypto.randomUUID();
    const body = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer());
    const key = objectKey(`accounts/${Buffer.from(ownerId).toString("base64url")}/media/${mediaId}`);
    const stored = await storage.put({ key, body, contentType: "image/png" }), media = createMediaRepository(database.db);
    expect(await media.reserve(ownerId, body.byteLength)).toBe(true);
    await media.add(ownerId, { id: mediaId, objectKey: key, kind: "image", contentType: stored.contentType, sizeBytes: stored.sizeBytes, etag: stored.etag });
    const frame: VideoParameters = { mode: "first_frame", resolution: parameters.resolution, durationSeconds: parameters.durationSeconds, generateAudio: parameters.generateAudio };
    const fixture = await seed(frame, { mediaId, resources: { storage, verifyReference: inspectGenerationVideoReference } }), accepted = await fixture.submit();
    const before = await dispatchState(), original = await snapshot(accepted.task.id);
    expect(original.task?.videoQuoteSnapshot).toMatchObject({ referenceSnapshot: { mediaId, etag: stored.etag } });
    await expect(fixture.submit(fixture.queue, { ...fixture.input, inputSnapshot: { ...fixture.input.inputSnapshot, referenceMediaId: crypto.randomUUID() } }))
        .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await dispatchState()).toEqual(before); expect(await snapshot(accepted.task.id)).toEqual(original); expect(fixture.jobs).toHaveLength(1);
    expect(await fixture.submit()).toMatchObject({ created: false, jobId: null, task: { id: accepted.task.id } });
    expect(await dispatchState()).toEqual(before); expect(fixture.jobs).toHaveLength(1);
});

test("a latest enabled price without publication cannot fall back to an older published video price", async () => {
    const fixture = await seed();
    expect((await listExecutableVideoModels(database.db, policy)).some(model => model.id === fixture.input.modelId)).toBe(true);
    // Leave the older published row enabled: an inner source join would hide
    // this newer scalar row and accidentally authorize the old publication.
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: fixture.input.modelId, version: fixture.quote.priceVersion + 1,
        billingUnit: "request", creditsPerUnit: 9, effectiveFrom: new Date(Date.now() - 1000), enabled: true });
    const before = await dispatchState();
    expect((await listExecutableVideoModels(database.db, policy)).some(model => model.id === fixture.input.modelId)).toBe(false);
    await expect(resolveExecutableVideoQuote(database.db, fixture.input, ownerId, policy)).rejects.toMatchObject({ code: "unsupported_generation" });
    await expect(fixture.submit()).rejects.toMatchObject({ code: "unsupported_generation" });
    expect(await dispatchState()).toEqual(before); expect(fixture.jobs).toHaveLength(0);
});

test("an initial enqueue failure rolls back task, stage, reserve and ledger rather than leaving an orphaned freeze", async () => {
    const fixture = await seed(), before = { money: await financialState(), tasks: await database.db.select().from(generationTask), stages: await database.db.select().from(generationVideoStage) };
    let calls = 0;
    await expect(fixture.submit({ async send() { calls++; throw new Error("Synthetic enqueue failure"); } })).rejects.toThrow("Synthetic enqueue failure");
    expect(calls).toBe(1);
    expect({ money: await financialState(), tasks: await database.db.select().from(generationTask), stages: await database.db.select().from(generationVideoStage) }).toEqual(before);
    expect(fixture.jobs).toHaveLength(0);
    expect((await fixture.submit()).created).toBe(true);
    expect(fixture.jobs).toHaveLength(1);
});

test("create timeout remains unknown and a fresh driver or duplicate job cannot send create again", async () => {
    const fixture = await seed(), accepted = await fixture.submit(); let creates = 0, inspections = 0;
    const worker = driver(fixture, { async create() { creates++; throw new Error("Synthetic response lost after create"); },
        async inspect() { inspections++; throw new Error("No original ID exists"); } });
    expect(await worker.instance.process(fixture.jobs[0])).toBeNull();
    const first = await snapshot(accepted.task.id);
    expect(first.stage).toMatchObject({ phase: "unknown", providerTaskId: null, nextActionAt: null });
    expect(first.stage?.createAttemptToken).toBeTruthy(); expect(first.result).toBeNull();
    expect(first.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(first.reservation).toMatchObject({ requestedUnits: "7", capturedUnits: "0", releasedUnits: "0" });
    worker.advance(policy.claimLeaseMs * 3);
    const restarted = createGenerationVideoDriver(worker.options);
    await restarted.recover(); await restarted.process(fixture.jobs[0]); await restarted.process(fixture.jobs[0]);
    expect(creates).toBe(1); expect(inspections).toBe(0); expect(await snapshot(accepted.task.id)).toEqual(first);
    expect(first.ledger.filter(row => row.kind === "reserve")).toHaveLength(1);
    expect(first.ledger.some(row => row.kind === "capture" || row.kind === "release")).toBe(false);
});

test("accepted and pending observations keep one original provider ID, no result and no settlement after restart", async () => {
    const fixture = await seed(), accepted = await fixture.submit(), providerId = "synthetic-original-id"; let creates = 0;
    const queries: string[] = [], worker = driver(fixture, {
        async create() { creates++; return observation("create", providerId, "queued"); },
        async inspect(_binding, id) { queries.push(id); return observation("inspect", id, "in_progress"); },
    });
    await worker.instance.process(fixture.jobs[0]);
    const received = await snapshot(accepted.task.id);
    expect(received.stage).toMatchObject({ phase: "accepted", providerTaskId: providerId });
    expect(received.task).toMatchObject({ executionStatus: "running", providerTaskId: providerId, billingStatus: "reserved" });
    expect(received.result).toBeNull();
    worker.advance(policy.pollIntervalMs + 1);
    await createGenerationVideoDriver(worker.options).process(fixture.jobs[0]);
    const pending = await snapshot(accepted.task.id);
    expect(pending.stage).toMatchObject({ phase: "polling", providerTaskId: providerId, inspectAttempts: 1 });
    expect(pending.result).toBeNull(); expect(pending.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
    expect(creates).toBe(1); expect(queries).toEqual([providerId]);
    // Replaying before the persisted nextActionAt cannot accelerate provider queries.
    await worker.instance.process(fixture.jobs[0]); expect(queries).toEqual([providerId]);
});

test("an inspect response arriving after its lease expires cannot write state, result, money or a continuation", async () => {
    const fixture = await seed(), accepted = await fixture.submit(), providerId = "synthetic-expired-inspect";
    let creates = 0, inspections = 0, acknowledge!: (response: VideoProviderResponse) => void, started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const worker = driver(fixture, { async create() { creates++; return observation("create", providerId, "queued"); },
        inspect(_binding, id) { inspections++; expect(id).toBe(providerId); started(); return new Promise(resolve => { acknowledge = resolve; }); } });
    await worker.instance.process(fixture.jobs[0]); worker.advance(policy.pollIntervalMs + 1);
    const inFlight = worker.instance.process(fixture.jobs[0]); await sent;
    const claimed = await snapshot(accepted.task.id);
    expect(claimed.stage).toMatchObject({ phase: "accepted", providerTaskId: providerId, inspectAttempts: 1 });
    expect(claimed.stage?.claimToken).toBeTruthy(); expect(claimed.stage?.leaseUntil).toBeTruthy();
    worker.advance(policy.claimLeaseMs + 1);
    const before = await dispatchState(), queued = structuredClone(fixture.jobs);
    // A completed receipt would create a result and schedule delivery without
    // the lease fence. The expired claimant must leave all durable rows alone.
    acknowledge(observation("inspect", providerId, "completed")); expect(await inFlight).toBeNull();
    expect(await snapshot(accepted.task.id)).toEqual(claimed); expect(await dispatchState()).toEqual(before); expect(fixture.jobs).toEqual(queued);
    expect(claimed.task).toMatchObject({ executionStatus: "running", billingStatus: "reserved" }); expect(claimed.result).toBeNull();
    expect(claimed.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" }); expect(creates).toBe(1); expect(inspections).toBe(1);
});

test("expired create claim becomes unknown while the late original ACK may bind its ID without another create", async () => {
    const fixture = await seed(), accepted = await fixture.submit(), providerId = "synthetic-late-id";
    let creates = 0, acknowledge!: (response: VideoProviderResponse) => void, started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const worker = driver(fixture, { create() { creates++; started(); return new Promise(resolve => { acknowledge = resolve; }); },
        async inspect(_binding, id) { return observation("inspect", id, "in_progress"); } });
    const inFlight = worker.instance.process(fixture.jobs[0]); await sent;
    const original = await snapshot(accepted.task.id); expect(original.stage?.phase).toBe("create_started");
    await createGenerationVideoDriver(worker.options).process(fixture.jobs[0]); expect(creates).toBe(1);
    worker.advance(policy.claimLeaseMs * 2 + 1);
    const restarted = createGenerationVideoDriver(worker.options), taskWakes = () => fixture.jobs.filter(job => job.taskId === accepted.task.id).length;
    const beforeWakes = taskWakes();
    // Recovery scans all due rows in the shared fixture database. Only this
    // task's additional wake is constrained here; other due tasks remain valid.
    await restarted.recover(); expect(taskWakes()).toBe(beforeWakes + 1);
    await restarted.recover(); expect(taskWakes()).toBe(beforeWakes + 1);
    await restarted.process(fixture.jobs[0]);
    expect((await snapshot(accepted.task.id)).task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
    acknowledge(observation("create", providerId, "queued")); await inFlight;
    const recovered = await snapshot(accepted.task.id);
    expect(recovered.stage).toMatchObject({ phase: "accepted", providerTaskId: providerId, createAttemptToken: original.stage?.createAttemptToken });
    expect(recovered.task).toMatchObject({ executionStatus: "unknown", providerTaskId: providerId, billingStatus: "pending_review" });
    expect(recovered.result).toBeNull(); expect(creates).toBe(1);
    expect(recovered.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
});

test("accepted ACK persistence and continuation enqueue fail together, preserving started-create uncertainty", async () => {
    const fixture = await seed(), accepted = await fixture.submit(); let creates = 0, failedContinuations = 0;
    const worker = driver(fixture, { async create() { creates++; return observation("create", "synthetic-ack-before-db-failure", "queued"); },
        async inspect() { throw new Error("No ID was durably committed"); } }, {
        queue: { async send(name, payload, options) {
            if (!options?.db) throw new Error("A continuation must share the stage transaction");
            const { rows: [stage] } = await options.db.executeSql('SELECT phase, provider_task_id, next_action_at FROM canvas_saas.generation_video_stage WHERE task_id = $1', [payload.taskId]);
            // Preparation and create_started each persist a watchdog. Target
            // the accepted ACK transaction by durable state, never call order.
            if (stage?.phase === "accepted" && stage.provider_task_id === "synthetic-ack-before-db-failure" && stage.next_action_at != null) {
                failedContinuations++; throw new Error("Synthetic continuation enqueue failure");
            }
            return fixture.queue.send(name, payload, options);
        } },
    });
    await expect(worker.instance.process(fixture.jobs[0])).rejects.toThrow("Synthetic continuation enqueue failure");
    expect(failedContinuations).toBe(1);
    const uncertain = await snapshot(accepted.task.id);
    expect(uncertain.stage).toMatchObject({ phase: "create_started", providerTaskId: null });
    expect(uncertain.task?.providerTaskId).toBeNull(); expect(uncertain.result).toBeNull();
    worker.advance(policy.claimLeaseMs + 1);
    await createGenerationVideoDriver(worker.options).process(fixture.jobs[0]);
    expect((await snapshot(accepted.task.id)).task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
    expect(creates).toBe(1); expect(uncertain.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
});

test("a protocol-confirmed failure releases once, while duplicate jobs cannot create or release again", async () => {
    const fixture = await seed(), accepted = await fixture.submit(); let creates = 0, inspections = 0;
    const worker = driver(fixture, { async create() { creates++; return observation("create", "synthetic-failed-id", "failed"); },
        async inspect() { inspections++; throw new Error("No query is needed after a confirmed failure"); } });
    await worker.instance.process(fixture.jobs[0]);
    const executed = await snapshot(accepted.task.id);
    expect(executed.stage).toMatchObject({ phase: "failed", providerTaskId: "synthetic-failed-id" });
    expect(executed.result).toMatchObject({ status: "failed", providerTaskId: "synthetic-failed-id" });
    await worker.instance.process(fixture.jobs[0]);
    const released = await snapshot(accepted.task.id);
    expect(released.task).toMatchObject({ executionStatus: "failed", billingStatus: "released" });
    expect(released.reservation).toMatchObject({ requestedUnits: "7", capturedUnits: "0", releasedUnits: "7" });
    expect(released.ledger.filter(row => row.kind === "reserve")).toHaveLength(1);
    expect(released.ledger.filter(row => row.kind === "release")).toHaveLength(1);
    expect(released.ledger.filter(row => row.kind === "capture")).toHaveLength(0);
    await createGenerationVideoDriver(worker.options).process(fixture.jobs[0]);
    expect(await snapshot(accepted.task.id)).toEqual(released); expect(creates).toBe(1); expect(inspections).toBe(0);
});

test("completed provider execution with unavailable private delivery keeps the reservation and never bills requested seconds", async () => {
    const fixture = await seed(), accepted = await fixture.submit(); let creates = 0, deliveries = 0;
    const worker = driver(fixture, { async create() { creates++; return observation("create", "synthetic-completed-id", "completed"); },
        async inspect() { throw new Error("Completion is already durable"); } }, {
        async deliver() { deliveries++; return { status: "unknown", unknownReason: "synthetic_private_content_unavailable" }; },
    });
    await worker.instance.process(fixture.jobs[0]);
    const completed = await snapshot(accepted.task.id);
    expect(completed.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "pending", billingStatus: "reserved" });
    expect(completed.stage).toMatchObject({ phase: "completed", durationEvidence: { status: "missing" } });
    expect(completed.result).toMatchObject({ status: "succeeded", consumedUnits: null });
    expect(completed.result?.resultSnapshot).not.toHaveProperty("media");
    await worker.instance.process(fixture.jobs[0]);
    const unknown = await snapshot(accepted.task.id);
    expect(unknown.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(unknown.result?.consumedUnits).toBeNull();
    expect(unknown.reservation).toMatchObject({ requestedUnits: "7", capturedUnits: "0", releasedUnits: "0" });
    expect(unknown.ledger.some(row => row.kind === "capture" || row.kind === "release")).toBe(false);
    expect(creates).toBe(1); expect(deliveries).toBe(1);
});

test("inspect HTTP failure is an observation gap and configured exhaustion keeps the original freeze", async () => {
    const fixture = await seed(), accepted = await fixture.submit(), providerId = "synthetic-inspect-gap"; let creates = 0, inspections = 0;
    const worker = driver(fixture, { async create() { creates++; return observation("create", providerId, "queued"); },
        async inspect(_binding, id) { inspections++; expect(id).toBe(providerId); return normalizeVideoProviderResponse({ operation: "inspect", expectedTaskId: id, httpStatus: 404, payload: null }); } },
        { policy: { ...policy, maxInspectAttempts: 2 } });
    await worker.instance.process(fixture.jobs[0]); worker.advance(policy.pollIntervalMs + 1);
    await worker.instance.process(fixture.jobs[0]);
    const pending = await snapshot(accepted.task.id);
    expect(pending.stage).toMatchObject({ phase: "polling", providerTaskId: providerId, inspectAttempts: 1 });
    expect(pending.task).toMatchObject({ executionStatus: "running", billingStatus: "reserved" }); expect(pending.result).toBeNull();
    worker.advance(policy.pollIntervalMs + 1); await worker.instance.process(fixture.jobs[0]);
    const unknown = await snapshot(accepted.task.id);
    expect(unknown.stage).toMatchObject({ phase: "unknown", providerTaskId: providerId, inspectAttempts: 2, nextActionAt: null });
    expect(unknown.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(unknown.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" }); expect(unknown.result).toBeNull();
    expect(creates).toBe(1); expect(inspections).toBe(2);
    expect(unknown.ledger.some(row => row.kind === "release" || row.kind === "capture")).toBe(false);
});
