import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { modelCatalog, modelProvider, user } from "@infinite-canvas/database/schema";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { createGenerationMediaDelivery } from "../src/generation-delivery";
import { createGenerationVideoMediaVerifier, resolveFetchedVideo } from "../src/generation-video-delivery";
import { runBoundedVideoProcess, type VideoToolchainIdentity } from "../src/generation-video-probe";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
import { createTestDatabase } from "./database";

const root = process.env.VIDEO_TEST_TOOL_ROOT;
const real = root && process.platform === "win32" ? test : test.skip;
real("private video proof binds original published task, stage ID, complete probe, owned object and delivered reference", async () => {
    if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL && process.env.SAAS_POSTGRES_TEST_SUITE !== "video-generation") throw new Error("Only isolated PGlite or the explicitly isolated video-generation PostgreSQL runner is permitted");
    const directory = await mkdtemp(join(tmpdir(), "video-private-test-"));
    const database = await createTestDatabase();
    try {
        const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
        const ffmpegPath = join(root!, "ffmpeg.exe"), ffprobePath = join(root!, "ffprobe.exe");
        const identity: VideoToolchainIdentity = { ffmpegSha256: sha(await readFile(ffmpegPath)), ffprobeSha256: sha(await readFile(ffprobePath)),
            version: "9.0.2-essentials_build-www.gyan.dev", license: "GPL-3.0", sourceUrl: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip" };
        const policy = { ffmpegPath, ffprobePath, probeTempRoot: directory, probeTimeoutMs: 30000, probeStdoutMaxBytes: 65536, probeStderrMaxBytes: 65536,
            probeMemoryMaxBytes: 268435456, probeCpuLimit: 5000, maxVideoBytes: 2097152, maxPixels: 4096, maxMediaDurationMs: 1000 } as VideoRuntimePolicy;
        const path = join(directory, "synthetic.mp4");
        expect((await runBoundedVideoProcess(ffmpegPath, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10", "-t", "0.4", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], directory,
            { timeoutMs: 30000, stdoutMaxBytes: 65536, stderrMaxBytes: 65536, memoryMaxBytes: 268435456, cpuTimeMs: 5000 })).exitCode).toBe(0);
        const body = new Uint8Array(await readFile(path)), fetched = await resolveFetchedVideo(body, policy, identity);
        expect(fetched.status).toBe("resolved"); if (fetched.status !== "resolved") throw new Error(fetched.reason);
        const ownerId = crypto.randomUUID(), providerId = crypto.randomUUID(), modelId = `video-${crypto.randomUUID()}`;
        const parameters: VideoParameters = { mode: "text", resolution: "480p", durationSeconds: 1, aspectRatio: "1:1", generateAudio: false };
        const binding = { protocol: VIDEO_PROTOCOL, providerId, providerModel: "explicit-synthetic-model", endpoint: "https://video.example.test/v1" };
        const priceBinding = { ...binding, capability: "video" as const, adapter: "openai-compatible" as const }; delete (priceBinding as any).protocol;
        await database.db.insert(user).values({ id: ownerId, email: `${ownerId}@example.test`, name: "Synthetic video owner", role: "admin" });
        await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic", endpoint: binding.endpoint, adapter: "openai-compatible", secretRef: "synthetic", enabled: true });
        await saveProviderCredential(database.db, "synthetic-private-video-fixture-only", providerId, "synthetic-provider-credential");
        await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: binding.providerModel, capability: "video", displayName: "Synthetic video", enabled: true });
        const audit = { actorId: ownerId, requestId: crypto.randomUUID() };
        const draft = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding: priceBinding, priceNote: "Synthetic only", rules: {
            schemaVersion: 1, cost: null, video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY }, sale: { template: "video_count", currency: "credit",
                bands: [{ parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), rates: { video: "3" } }] } } }, audit);
        if (draft.status !== "saved") throw new Error(draft.status);
        const publication = await publishModelPriceDraft(database.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: draft.draft.version,
            expectedPriceVersion: 0, binding: priceBinding, publicPriceNote: "Synthetic only" }, audit);
        if (publication.status !== "published") throw new Error(publication.status);
        const tasks = createGenerationTaskRepository(database.db), stages = createGenerationVideoStageRepository(database.db), results = createGenerationResultRepository(database.db);
        const initialized = await database.db.transaction(async tx => {
            const task = (await createGenerationTaskRepository(tx).create({ ownerId, modelId, inputSnapshot: { prompt: "synthetic" }, parameterSnapshot: parameters,
                priceVersion: 1, quotedUnits: 3, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 3, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(),
                videoQuoteSnapshot: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, publicationId: publication.publication.id,
                    priceVersion: 1, selectedBand: { parameters, creditsPerVideo: 3 }, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 3 } })).task;
            return { task, stage: await createGenerationVideoStageRepository(tx).initialize(task, binding) };
        });
        let { task, stage } = initialized;
        stage = await stages.update(stage, { phase: "create_started", createAttemptToken: crypto.randomUUID(), createStartedAt: new Date() });
        await tasks.transitionExecution({ ownerId, taskId: task.id, status: "queued" }); await tasks.claimRunning({ ownerId, taskId: task.id });
        const completed = await database.db.transaction(async tx => {
            await createGenerationVideoStageRepository(tx).update(stage, { phase: "completed", providerTaskId: "original-id", completedAt: new Date(), probeSnapshot: { ...fetched.probe } });
            const updated = await createGenerationTaskRepository(tx).transitionExecution({ ownerId, taskId: task.id, status: "succeeded", providerTaskId: "original-id" });
            const result = (await createGenerationResultRepository(tx).create({ taskId: task.id, ownerId, status: "succeeded", providerTaskId: "original-id", resultSnapshot: {
                kind: "video", protocol: VIDEO_PROTOCOL, billingPolicy: { source: "platform_delivered_video", unit: "video" } } })).result;
            return { task: updated, result };
        });
        task = completed.task; let result = completed.result;
        const storage = createMemoryObjectStorage(), verifier = createGenerationVideoMediaVerifier({ database: database.db, storage, policy, toolchainIdentity: identity });
        expect(await verifier({ task, result })).toBe(false); // Supplier completed is not delivered.
        const delivered = await createGenerationMediaDelivery({ database: database.db, storage, quotaBytes: 2097152,
            maxBytes: { image: 2097152, audio: 2097152, video: 2097152 }, resolveAsset: async () => fetched.asset })({ task, result });
        expect(delivered.status).toBe("visible"); if (!delivered.media) throw new Error("No owned media reference");
        result = await results.attachMedia({ ownerId, taskId: task.id, media: delivered.media, videoDelivered: true });
        await tasks.transitionDelivery({ ownerId, taskId: task.id, status: "saved" }); task = await tasks.transitionDelivery({ ownerId, taskId: task.id, status: "visible" });
        expect(await verifier({ task, result })).toBe(true);
        expect(await verifier({ task, result: { ...result, providerTaskId: "different-id" } })).toBe(false);
        expect(await verifier({ task: { ...task, ownerId: "different-owner" }, result })).toBe(false);
        expect(await verifier({ task, result: { ...result, consumedUnits: null } })).toBe(false);
        await storage.put({ key: objectKey(`accounts/${Buffer.from(ownerId).toString("base64url")}/media/${task.id}`), body: new Uint8Array(body.byteLength), contentType: "video/mp4" });
        expect(await verifier({ task, result })).toBe(false);
    } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
}, 180000);
