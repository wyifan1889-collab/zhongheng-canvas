import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryObjectStorage, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { modelCatalog, modelProvider, user, wallet } from "@infinite-canvas/database/schema";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { resolveExecutableVideoQuote } from "../src/generation-video-policy";
import { quoteReserveAndEnqueueConfirmedVideoTask } from "../src/generation-video-dispatch";
import { createGenerationVideoExecution } from "../src/generation-video-runtime";
import type { GenerationQueueSender } from "../src/generation-dispatch";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
import { createTestDatabase } from "./database";

const toolRoot = process.env.VIDEO_TEST_TOOL_ROOT, mediaPath = process.env.VIDEO_TEST_MEDIA_PATH;
const real = process.platform === "win32" && toolRoot && mediaPath ? test : test.skip;
const realAck = process.platform === "win32" && toolRoot && mediaPath && process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE === "video-generation" ? test : test.skip;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(kind: "normal" | "late-put" | "expired-settlement" | "capture-ack" | "release-ack") {
    if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE !== "video-generation") throw new Error("Only isolated PGlite or the explicitly isolated video-generation PostgreSQL runner is permitted");
    const database = await createTestDatabase(), ownerId = crypto.randomUUID(), providerId = crypto.randomUUID(), modelId = `video-${crypto.randomUUID()}`;
    const authSecret = "synthetic-native-video-only-auth-secret", body = new Uint8Array(await readFile(mediaPath!));
    const parameters: VideoParameters = { mode: "text", resolution: "480p", durationSeconds: 1, aspectRatio: "16:9", generateAudio: false };
    const policy: VideoRuntimePolicy = { createTimeoutMs: 1000, inspectTimeoutMs: 1000, downloadTimeoutMs: 1000, jsonMaxBytes: 4096,
        pollIntervalMs: 100, claimLeaseMs: 120000, recoveryScanIntervalMs: 100, recoveryScanBatchSize: 10, observationWindowMs: 600000,
        maxInspectAttempts: 10, maxDownloadAttempts: 3, maxVideoBytes: 1048576, maxPixels: 1000000, maxMediaDurationMs: 15000,
        referenceMaxBytes: 4096, referenceMaxPixels: 1000000, referenceContentTypes: ["image/png"],
        ffmpegPath: join(toolRoot!, "ffmpeg.exe"), ffprobePath: join(toolRoot!, "ffprobe.exe"), probeTempRoot: tmpdir(),
        probeTimeoutMs: 30000, probeStdoutMaxBytes: 65536, probeStderrMaxBytes: 65536, probeMemoryMaxBytes: 268435456, probeCpuLimit: 5000 };
    const toolchainIdentity = { ffprobeSha256: sha(await readFile(policy.ffprobePath)), ffmpegSha256: sha(await readFile(policy.ffmpegPath)),
        version: "9.0.2-essentials_build-www.gyan.dev", license: "GPL-3.0", sourceUrl: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip" };
    const binding = { providerId, providerModel: "explicit-synthetic-model", endpoint: "https://synthetic-video.example.test/v1", adapter: "openai-compatible" as const, capability: "video" as const };
    await database.db.insert(user).values({ id: ownerId, name: "Synthetic native video", email: `${ownerId}@example.test`, role: "admin" });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic", endpoint: binding.endpoint, adapter: binding.adapter, enabled: true, secretRef: "synthetic" });
    await saveProviderCredential(database.db, authSecret, providerId, "synthetic-only-credential");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, displayName: "Synthetic video", providerId, providerModel: binding.providerModel, capability: "video", enabled: true });
    const audit = { actorId: ownerId, requestId: crypto.randomUUID() };
    const draft = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, priceNote: "Synthetic only", rules: { schemaVersion: 1, cost: null,
        video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY }, sale: { template: "video_count", currency: "credit",
            bands: [{ parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), rates: { video: "3" } }] } } }, audit);
    if (draft.status !== "saved") throw new Error(draft.status);
    const publication = await publishModelPriceDraft(database.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: draft.draft.version,
        expectedPriceVersion: 0, binding, publicPriceNote: "Synthetic only" }, audit);
    if (publication.status !== "published") throw new Error(publication.status);
    const input = { ownerId, modelId, inputSnapshot: { prompt: "Synthetic video fixture" }, parameterSnapshot: parameters, requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const queue: GenerationQueueSender = { async send(_name, _payload, options) { expect(options?.db).toBeDefined(); return crypto.randomUUID(); } };
    const quote = await resolveExecutableVideoQuote(database.db, input, ownerId, policy);
    const accepted = await quoteReserveAndEnqueueConfirmedVideoTask(database.db, queue, input, quote.priceVersion, quote.quoteFingerprint, policy);
    const claimBackends = new Set<number>(), wrapped = new WeakSet<object>(); let commitAckLosses = 0;
    if (process.env.SAAS_TEST_DATABASE_URL) (database.pool as any).on("acquire", (client: any) => {
        if (wrapped.has(client)) return; wrapped.add(client);
        const query = client.query.bind(client);
        let matchingLedgerWrite = false;
        client.query = (...args: any[]) => {
            const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
            if (typeof text === "string" && text.includes("generation_video_stage") && /for update/i.test(text)) claimBackends.add(client.processID);
            const values = args[0]?.values ?? args[1];
            if (typeof text === "string" && /^begin\b|^rollback\b/i.test(text.trim())) matchingLedgerWrite = false;
            const targetKind = kind === "capture-ack" ? "capture" : kind === "release-ack" ? "release" : null;
            if (targetKind && typeof text === "string" && /insert into.*wallet_ledger/i.test(text) && Array.isArray(values) && values.includes(ownerId) && values.includes(targetKind)) matchingLedgerWrite = true;
            const dropCommitAck = !!targetKind && matchingLedgerWrite && typeof text === "string" && /^commit$/i.test(text.trim()) && commitAckLosses === 0;
            const result = query(...args);
            if (!dropCommitAck) return result;
            // This is an application ACK fault after the real PostgreSQL outer
            // COMMIT succeeds. A subsequent ROLLBACK cannot undo the committed ledger.
            return result.then(() => { commitAckLosses++; matchingLedgerWrite = false; throw new Error("synthetic_ack_lost_after_real_settlement_commit"); });
        };
    });
    const job = { schemaVersion: 1 as const, taskId: accepted.task.id, ownerId, requestId: input.requestId };
    let clock = new Date(), creates = 0, downloads = 0, puts = 0, expireSettlement = kind === "expired-settlement";
    let putStarted!: () => void, releasePut!: () => void;
    const putReady = new Promise<void>(resolve => { putStarted = resolve; }), putReleased = new Promise<void>(resolve => { releasePut = resolve; });
    const memory = createMemoryObjectStorage();
    const storage: ObjectStorage = {
        async get(key) {
            const value = await memory.get(key);
            // The first existing video object is read by the real settlement verifier,
            // after the delivery row/reference commits. Expire its claim during that proof.
            if (value && expireSettlement) { expireSettlement = false; clock = new Date(clock.getTime() + policy.claimLeaseMs + 1); }
            return value;
        },
        async put(value) { puts++; if (kind === "late-put") { putStarted(); await putReleased; } return memory.put(value); },
        delete: key => memory.delete(key),
    };
    const execution = await createGenerationVideoExecution({ database: database.db, storage, queue, policy, authSecret, quotaBytes: 1048576,
        maxBytes: { image: 1048576, video: 1048576, audio: 1048576 }, toolchainIdentity, now: () => clock,
        gateway: { async requestVideoJson(request) {
            expect(request.method).toBe("POST"); creates++;
            return { status: "observed", httpStatus: 200, payload: { object: "video", id: "original-synthetic-id", status: kind === "release-ack" ? "failed" : "completed" } };
        }, async requestVideoContent(request) {
            expect(request.path).toBe("videos/original-synthetic-id/content"); expect(request.method).toBe("GET"); downloads++;
            return { status: "resolved", httpStatus: 200, contentType: "video/mp4", body: new Uint8Array(body) };
        } },
    });
    const snapshot = async () => ({ task: await createGenerationTaskRepository(database.db).get(ownerId, accepted.task.id),
        stage: await createGenerationVideoStageRepository(database.db).get(ownerId, accepted.task.id),
        result: await createGenerationResultRepository(database.db).get(ownerId, accepted.task.id),
        media: await createMediaRepository(database.db).get(ownerId, accepted.task.id),
        reservation: await createWalletRepository(database.db).getReservation(ownerId, accepted.task.reservationId!),
        ledger: (await createWalletRepository(database.db).listLedger(ownerId)).filter(row => row.referenceId === accepted.task.id) });
    return { database, execution, job, snapshot, memory, body, ownerId, taskId: accepted.task.id, policy, claimBackends, ackLosses: () => commitAckLosses,
        counters: () => ({ creates, downloads, puts }), advance: () => { clock = new Date(clock.getTime() + policy.claimLeaseMs + 1); }, putReady, releasePut };
}

real("real controlled Windows video delivery captures once and duplicate/restarted jobs reuse the private asset", async () => {
    const f = await fixture("normal");
    try {
        await Promise.all([f.execution.driver.process(f.job), f.execution.driver.process(f.job)]); await f.execution.driver.process(f.job);
        const saved = await f.snapshot();
        expect(saved.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
        expect(saved.stage?.probeSnapshot).toMatchObject({ source: "ffmpeg_full_decode", contentSha256: sha(f.body) });
        expect(saved.reservation).toMatchObject({ requestedUnits: "3", capturedUnits: "3", releasedUnits: "0" });
        expect(saved.result?.consumedUnits).toBe(1); expect(saved.media?.etag).toBe(sha(f.body));
        expect(saved.ledger.filter(row => row.kind === "capture")).toHaveLength(1);
        await f.execution.driver.recover(); await f.execution.driver.process(f.job);
        expect(await f.snapshot()).toEqual(saved); expect(f.counters()).toEqual({ creates: 1, downloads: 1, puts: 1 });
        if (process.env.SAAS_TEST_DATABASE_URL) expect(f.claimBackends.size).toBeGreaterThanOrEqual(2);
    } finally { await f.database.close(); }
}, 180000);

real("a storage PUT completing beyond its lease cannot attach/capture and a new claimant cannot overwrite it", async () => {
    const f = await fixture("late-put");
    try {
        await f.execution.driver.process(f.job);
        const delivering = f.execution.driver.process(f.job); await f.putReady;
        f.advance(); const competing = f.execution.driver.process(f.job); f.releasePut();
        await Promise.all([delivering, competing]);
        const saved = await f.snapshot();
        expect(saved.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
        expect(saved.media).toBeNull(); expect(saved.result?.consumedUnits).toBeNull();
        expect(saved.ledger.some(row => row.kind === "capture" || row.kind === "release")).toBe(false);
        expect(saved.stage?.nextActionAt).toBeNull();
        await f.execution.driver.recover(); await f.execution.driver.process(f.job);
        expect(f.counters()).toEqual({ creates: 1, downloads: 1, puts: 1 });
        const privateObject = await f.memory.get(objectKey(`accounts/${Buffer.from(f.ownerId).toString("base64url")}/media/${f.taskId}`));
        expect(privateObject && sha(privateObject.body)).toBe(sha(f.body));
    } finally { f.releasePut(); await f.database.close(); }
}, 180000);

real("a real settlement proof finishing beyond its claim cannot capture; a fresh claim later settles only once", async () => {
    const f = await fixture("expired-settlement");
    try {
        await f.execution.driver.process(f.job); await f.execution.driver.process(f.job);
        const expired = await f.snapshot();
        expect(expired.task).toMatchObject({ deliveryStatus: "visible", billingStatus: "reserved" });
        expect(expired.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "0" });
        expect(expired.ledger.some(row => row.kind === "capture" || row.kind === "release")).toBe(false);
        f.advance(); await f.execution.driver.process(f.job);
        const recovered = await f.snapshot();
        expect(recovered.reservation).toMatchObject({ capturedUnits: "3", releasedUnits: "0" });
        expect(recovered.ledger.filter(row => row.kind === "capture")).toHaveLength(1);
        expect(f.counters()).toEqual({ creates: 1, downloads: 1, puts: 1 });
    } finally { await f.database.close(); }
}, 180000);

realAck("a capture COMMIT acknowledgement lost after the real ledger write resumes with its fixed key and never captures twice", async () => {
    const f = await fixture("capture-ack");
    try {
        await f.execution.driver.process(f.job); await f.execution.driver.process(f.job);
        const uncertain = await f.snapshot();
        expect(f.ackLosses()).toBe(1);
        expect(uncertain.reservation).toMatchObject({ capturedUnits: "3", releasedUnits: "0" });
        expect(uncertain.task?.billingStatus).not.toBe("captured");
        expect(uncertain.ledger.filter(row => row.kind === "capture")).toHaveLength(1);
        f.advance(); await f.execution.driver.process(f.job);
        const recovered = await f.snapshot();
        expect(recovered.task?.billingStatus).toBe("captured");
        expect(recovered.ledger.filter(row => row.kind === "capture")).toHaveLength(1);
        expect(recovered.ledger.filter(row => row.kind === "release")).toHaveLength(0);
        expect(f.counters()).toEqual({ creates: 1, downloads: 1, puts: 1 });
    } finally { await f.database.close(); }
}, 180000);

realAck("a release COMMIT acknowledgement lost after a protocol failure never creates or releases twice", async () => {
    const f = await fixture("release-ack");
    try {
        await f.execution.driver.process(f.job); await f.execution.driver.process(f.job);
        const uncertain = await f.snapshot();
        expect(f.ackLosses()).toBe(1);
        expect(uncertain.reservation).toMatchObject({ capturedUnits: "0", releasedUnits: "3" });
        expect(uncertain.task?.billingStatus).not.toBe("released");
        expect(uncertain.ledger.filter(row => row.kind === "release")).toHaveLength(1);
        f.advance(); await f.execution.driver.process(f.job);
        const recovered = await f.snapshot();
        expect(recovered.task?.billingStatus).toBe("released");
        expect(recovered.ledger.filter(row => row.kind === "release")).toHaveLength(1);
        expect(recovered.ledger.filter(row => row.kind === "capture")).toHaveLength(0);
        expect(f.counters()).toEqual({ creates: 1, downloads: 0, puts: 0 });
    } finally { await f.database.close(); }
}, 180000);
