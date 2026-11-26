import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { generationResult, modelCatalog, modelProvider, user, wallet } from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createProviderGateway } from "../src/provider-gateway";
import { createGenerationProvider } from "../src/generation-provider";
import { createGenerationDelivery, createGenerationAudioMediaVerifier } from "../src/generation-delivery";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { parseGenerationAudioRequest } from "../src/generation-audio-request";
import { quoteReserveAndEnqueueConfirmedAudioTask } from "../src/generation-audio-dispatch";
import { listExecutableAudioModels, resolveExecutableAudioQuote } from "../src/generation-audio-policy";
import { getGenerationTaskForOwner } from "../src/generation-query";
import { readGenerationApiConfig } from "../src/generation-api-runtime";
import { readGenerationWorkerProcessConfig } from "../src/generation-worker-process";
import { checkGenerationDatabaseReadiness } from "../src/readiness";
import { createTestDatabase } from "./database";

const secret = "synthetic-audio-secret-" + crypto.randomUUID();
const audioRoot = new URL("./fixtures/audio-integrity/", import.meta.url);
const mp3 = new Uint8Array(readFileSync(new URL("silence.mp3", audioRoot)));
const wav = new Uint8Array(readFileSync(new URL("sine-24000-mono-s16.wav", audioRoot)));
const maxBytes = { audio: 4096, image: 4096, video: 4096 }; // Isolated fixture policy only.
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

async function scenario(format: "mp3" | "wav" = "mp3", options: { response?: () => Response; quotaBytes?: number; providerModel?: string } = {}) {
    const id = crypto.randomUUID(), ownerId = `audio-owner-${id}`, providerId = `audio-provider-${id}`, modelId = `audio-${id}`;
    const providerModel = options.providerModel ?? "gpt-4o-mini-tts";
    await database.db.insert(user).values({ id: ownerId, name: "Synthetic audio owner", email: `${id}@example.test` });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic Speech", adapter: "openai-compatible", endpoint: "https://speech.example.test/v1", secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, secret, providerId, "synthetic-speech-test-key");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel, displayName: "Synthetic speech", capability: "audio", enabled: true });
    const audit = { actorId: ownerId, requestId: crypto.randomUUID() };
    const draft = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0,
        binding: { providerId, providerModel, adapter: "openai-compatible", endpoint: "https://speech.example.test/v1", capability: "audio" },
        rules: { schemaVersion: 1, cost: null, sale: { template: "audio_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } }, priceNote: "private test note" }, audit);
    if (draft.status !== "saved") throw new Error("Synthetic audio draft failed");
    const publication = await publishModelPriceDraft(database.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: 1,
        expectedPriceVersion: 0, binding: draft.draft.binding, publicPriceNote: "Synthetic fixed request" }, audit);
    if (publication.status !== "published") throw new Error("Synthetic audio publication failed");
    const parameters: Record<string, unknown> = providerModel === "gemini-3.8-flash-tts" ? { voice: "default", format } : { voice: "alloy", format, style: "温和", language: "中文" };
    const intent = { modelId, inputSnapshot: { text: "  原文中文，keep whitespace.  " }, parameterSnapshot: parameters };
    const quote = await resolveExecutableAudioQuote(database.db, intent, ownerId);
    const jobs: unknown[] = [];
    const queue = { async send(_name: string, payload: unknown) { jobs.push(payload); return crypto.randomUUID(); } };
    const request = { ...intent, ownerId, idempotencyKey: `audio-${id}`, requestId: crypto.randomUUID() };
    const accepted = await quoteReserveAndEnqueueConfirmedAudioTask(database.db, queue, request, quote.priceVersion, quote.quoteFingerprint!);
    const storage = createMemoryObjectStorage(), quotaBytes = options.quotaBytes ?? 16384;
    const observed: Array<{ url: string; body: Record<string, unknown>; redirect: RequestRedirect | undefined }> = [];
    const gateway = createProviderGateway(async (url, init) => {
        observed.push({ url: String(url), body: JSON.parse(String(init?.body)), redirect: init?.redirect });
        if (options.response) return options.response();
        if (providerModel === "gemini-3.8-flash-tts") return Response.json({ model: providerModel,
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: `[media](data:audio/wav;base64,${Buffer.from(wav).toString("base64")})` } }] });
        return new Response(format === "mp3" ? mp3 : wav, { headers: { "content-type": format === "mp3" ? "audio/mpeg" : "audio/wav" } });
    }, () => ["93.184.216.34"]);
    const dependencies = { provider: createGenerationProvider({ database: database.db, authSecret: secret, gateway, audioMaxBytes: maxBytes.audio }),
        deliver: createGenerationDelivery({ database: database.db, storage, quotaBytes, maxBytes }),
        settleBilling: createGenerationWalletSettlement(database.db, { verifyAudioDelivery: createGenerationAudioMediaVerifier({ database: database.db, storage, maxBytes }) }) };
    const payload = { schemaVersion: 1 as const, taskId: accepted.task.id, ownerId, requestId: accepted.task.requestId };
    return { ownerId, providerId, modelId, intent, quote, request, queue, jobs, accepted, storage, observed, dependencies, payload, quotaBytes };
}

test.each(["mp3", "wav"] as const)("published %s Speech reaches private owned media and one fixed platform charge", async format => {
    const run = await scenario(format), wallets = createWalletRepository(database.db);
    expect((await listExecutableAudioModels(database.db)).find(model => model.id === run.modelId)).toMatchObject({ capability: "audio", audio: { formats: ["mp3", "wav"], instructions: true }, audioPricing: { priceVersion: 1, creditsPerUnit: 7 } });
    const first = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(first.result.consumedUnits).toBe(1);
    expect(run.observed).toEqual([{ url: "https://speech.example.test/v1/audio/speech", redirect: "error", body: {
        model: "gpt-4o-mini-tts", input: run.intent.inputSnapshot.text, voice: "alloy", response_format: format, stream_format: "audio", instructions: "语言：中文\n朗读风格：温和" } }]);
    const media = createMediaRepository(database.db), row = await media.get(run.ownerId, run.payload.taskId);
    expect(row).toMatchObject({ kind: "audio", contentType: format === "mp3" ? "audio/mpeg" : "audio/wav" });
    expect(await media.get("another-owner", run.payload.taskId)).toBeNull();
    const stored = await run.storage.get(objectKey(row!.objectKey));
    expect(stored?.body).toEqual(format === "mp3" ? mp3 : wav);
    const view = await getGenerationTaskForOwner(database.db, { ownerId: run.ownerId, taskId: run.payload.taskId });
    expect(view.task.audioSnapshot).toEqual({ status: "recorded", input: run.intent.inputSnapshot, parameters: run.intent.parameterSnapshot });
    expect(view.result?.resultSnapshot).toMatchObject({ kind: "audio", media: { mediaId: row!.id, kind: "audio" }, usageEvidence: { status: "missing", source: "audio_speech_binary" }, billingPolicy: { source: "platform_successful_request", unit: "request" } });
    for (const hidden of ["base64", "synthetic-speech-test-key", "speech.example.test", "private test note", "objectKey"]) expect(JSON.stringify(view)).not.toContain(hidden);
    await expect(getGenerationTaskForOwner(database.db, { ownerId: "another-owner", taskId: run.payload.taskId })).rejects.toMatchObject({ code: "not_found" });
    expect(await wallets.get(run.ownerId)).toMatchObject({ availableUnits: "93", reservedUnits: "0" });
    const ledger = await wallets.listLedger(run.ownerId), quota = await media.getQuota(run.ownerId, run.quotaBytes);
    const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(replay.replay).toBe(true); expect(run.observed).toHaveLength(1);
    expect(await wallets.listLedger(run.ownerId)).toEqual(ledger); expect(await media.getQuota(run.ownerId, run.quotaBytes)).toEqual(quota);
    expect(ledger.filter(item => item.kind === "capture")).toHaveLength(1);
    expect((await quoteReserveAndEnqueueConfirmedAudioTask(database.db, run.queue, { ...run.request, requestId: crypto.randomUUID() }, 1, run.quote.quoteFingerprint!)).created).toBe(false);
    expect(run.jobs).toHaveLength(1);
});

test("published exact Chat TTS contract delivers owned WAV and captures the configured request price once", async () => {
    const run = await scenario("wav", { providerModel: "gemini-3.8-flash-tts" });
    expect((await listExecutableAudioModels(database.db)).find(model => model.id === run.modelId)).toMatchObject({
        audio: { formats: ["wav"], voices: ["default"], instructions: false }, audioPricing: { creditsPerUnit: 7 } });
    const first = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(first.result.consumedUnits).toBe(1);
    expect(run.observed).toEqual([{ url: "https://speech.example.test/v1/chat/completions", redirect: "error", body: {
        model: "gemini-3.8-flash-tts", messages: [{ role: "user", content: `请用中文清晰读出：${run.intent.inputSnapshot.text}` }], stream: false } }]);
    const media = await createMediaRepository(database.db).get(run.ownerId, run.payload.taskId);
    expect(media).toMatchObject({ kind: "audio", contentType: "audio/wav", sizeBytes: wav.byteLength });
    expect((await run.storage.get(objectKey(media!.objectKey)))?.body).toEqual(wav);
    expect(await createMediaRepository(database.db).get("another-owner", run.payload.taskId)).toBeNull();
    const view = await getGenerationTaskForOwner(database.db, { ownerId: run.ownerId, taskId: run.payload.taskId });
    expect(view.task.audioSnapshot).toEqual({ status: "recorded", input: run.intent.inputSnapshot, parameters: { voice: "default", format: "wav" } });
    expect(view.result?.resultSnapshot).toMatchObject({ kind: "audio", usageEvidence: { status: "missing", source: "audio_chat_data_uri" },
        billingPolicy: { source: "platform_successful_request", unit: "request" } });
    for (const hidden of ["base64", "synthetic-speech-test-key", "speech.example.test", "objectKey"]) expect(JSON.stringify(view)).not.toContain(hidden);
    const wallets = createWalletRepository(database.db), ledger = await wallets.listLedger(run.ownerId);
    expect(await wallets.get(run.ownerId)).toMatchObject({ availableUnits: "93", reservedUnits: "0" });
    expect((await processGenerationJob(database.db, run.payload, run.dependencies)).replay).toBe(true);
    expect(run.observed).toHaveLength(1); expect(await wallets.listLedger(run.ownerId)).toEqual(ledger);
    expect(ledger.filter(item => item.kind === "capture")).toHaveLength(1);
    expect((await quoteReserveAndEnqueueConfirmedAudioTask(database.db, run.queue, { ...run.request, requestId: crypto.randomUUID() }, 1, run.quote.quoteFingerprint!)).created).toBe(false);
    expect(run.jobs).toHaveLength(1);
});

test("Chat TTS rejects unverified voice, MP3 and instructions before reserving another request", async () => {
    const run = await scenario("wav", { providerModel: "gemini-3.8-flash-tts" });
    const wallets = createWalletRepository(database.db), before = await wallets.get(run.ownerId);
    for (const change of [{ voice: "alloy" }, { format: "mp3" }, { style: "温和" }, { language: "中文" }]) {
        await expect(resolveExecutableAudioQuote(database.db, { ...run.intent, parameterSnapshot: { ...run.intent.parameterSnapshot, ...change } }, run.ownerId))
            .rejects.toMatchObject({ code: "unsupported_generation" });
    }
    let fallbackCalls = 0;
    const missingChatTransport = createGenerationProvider({ database: database.db, authSecret: secret, audioMaxBytes: maxBytes.audio,
        gateway: { async request() { fallbackCalls++; throw new Error("unexpected JSON fallback"); },
            async requestAudio() { fallbackCalls++; throw new Error("unexpected Speech fallback"); } } });
    expect(await missingChatTransport(run.accepted.task)).toEqual({ status: "failed", errorCode: "audio_delivery_unavailable" });
    expect(fallbackCalls).toBe(0);
    expect(await wallets.get(run.ownerId)).toEqual(before); expect(run.observed).toHaveLength(0); expect(run.jobs).toHaveLength(1);
});

test.each(["rejected", "unknown", "invalid-json", "wrong-model", "broken-wav"])("Chat TTS %s preserves failure/unknown billing without repeating the upstream request", async mode => {
    const run = await scenario("wav", { providerModel: "gemini-3.8-flash-tts", response: () => {
        if (mode === "rejected" || mode === "unknown") return new Response("private upstream error", { status: mode === "rejected" ? 400 : 500 });
        if (mode === "invalid-json") return new Response("private malformed JSON", { headers: { "content-type": "application/json" } });
        return Response.json({ model: mode === "wrong-model" ? "other-model" : "gemini-3.8-flash-tts", choices: [{ finish_reason: "stop",
            message: { role: "assistant", content: `[media](data:audio/wav;base64,${Buffer.from(mode === "broken-wav" ? wav.slice(0, -1) : wav).toString("base64")})` } }] });
    } });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies), failed = mode === "rejected";
    expect(result.task).toMatchObject({ executionStatus: failed ? "failed" : "unknown", billingStatus: failed ? "released" : "pending_review" });
    expect(result.result.consumedUnits).toBeNull(); expect(await createMediaRepository(database.db).list(run.ownerId)).toHaveLength(0);
    expect(await createWalletRepository(database.db).get(run.ownerId)).toMatchObject({ availableUnits: failed ? "100" : "93", reservedUnits: failed ? "0" : "7" });
    expect(JSON.stringify(result)).not.toContain("private upstream"); expect(JSON.stringify(result)).not.toContain("private malformed");
    await processGenerationJob(database.db, run.payload, run.dependencies); expect(run.observed).toHaveLength(1);
});

test("fingerprint binds owner, exact text, voice, format, style and language before reserve", async () => {
    const run = await scenario();
    for (const change of [ { inputSnapshot: { text: "changed" } }, { parameterSnapshot: { ...run.intent.parameterSnapshot, voice: "echo" } },
        { parameterSnapshot: { ...run.intent.parameterSnapshot, format: "wav" } }, { parameterSnapshot: { ...run.intent.parameterSnapshot, style: "快" } },
        { parameterSnapshot: { ...run.intent.parameterSnapshot, language: "English" } } ]) {
        await expect(quoteReserveAndEnqueueConfirmedAudioTask(database.db, run.queue, { ...run.request, ...change, idempotencyKey: crypto.randomUUID() }, 1, run.quote.quoteFingerprint!)).rejects.toMatchObject({ code: "price_changed" });
        await expect(quoteReserveAndEnqueueConfirmedAudioTask(database.db, run.queue, { ...run.request, ...change }, 1, run.quote.quoteFingerprint!)).rejects.toMatchObject({ code: "idempotency_conflict" });
    }
    await expect(quoteReserveAndEnqueueConfirmedAudioTask(database.db, run.queue, { ...run.request, idempotencyKey: crypto.randomUUID() }, 1, "")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(quoteReserveAndEnqueueConfirmedAudioTask(database.db, run.queue, { ...run.request, ownerId: "another-owner", idempotencyKey: crypto.randomUUID() }, 1, run.quote.quoteFingerprint!)).rejects.toMatchObject({ code: "price_changed" });
    await expect(quoteReserveAndEnqueueConfirmedAudioTask(database.db, run.queue, { ...run.request, idempotencyKey: crypto.randomUUID() }, 2, run.quote.quoteFingerprint!)).rejects.toMatchObject({ code: "price_changed" });
    expect(run.jobs).toHaveLength(1);
});

test.each([400, 429, 408, 499, 500, 202])("Speech HTTP %p preserves failed versus unknown wallet policy", async status => {
    const run = await scenario("mp3", { response: () => new Response("synthetic rejection", { status }) });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    const failed = status === 400 || status === 429;
    expect(result.task).toMatchObject({ executionStatus: failed ? "failed" : "unknown", billingStatus: failed ? "released" : "pending_review" });
    expect(result.result.consumedUnits).toBeNull();
    expect(await createWalletRepository(database.db).get(run.ownerId)).toMatchObject({ availableUnits: failed ? "100" : "93", reservedUnits: failed ? "0" : "7" });
    expect(await createMediaRepository(database.db).list(run.ownerId)).toHaveLength(0);
    await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(run.observed).toHaveLength(1);
});

test.each(["truncated", "json", "wrong-format", "overflow", "network"])("unusable binary %s never releases unknown paid work or fabricates request usage", async mode => {
    const run = await scenario("mp3", { response: () => {
        if (mode === "network") throw new Error("synthetic interruption");
        return new Response(mode === "truncated" ? mp3.slice(0, -15) : mode === "json" ? new TextEncoder().encode('{"error":"synthetic"}') : mode === "overflow" ? new Uint8Array(4097) : wav,
            { headers: { "content-type": "audio/mpeg" } });
    } });
    const result = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(result.task).toMatchObject({ executionStatus: "unknown", billingStatus: "pending_review" });
    expect(result.result.consumedUnits).toBeNull(); expect(await createMediaRepository(database.db).list(run.ownerId)).toHaveLength(0);
});

test("quota failure counts no delivered request; durable normalized crash recovery calls Speech only once", async () => {
    const quota = await scenario("wav", { quotaBytes: 1 });
    const failed = await processGenerationJob(database.db, quota.payload, quota.dependencies);
    expect(failed.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "failed", billingStatus: "pending_review" });
    expect(failed.result.consumedUnits).toBeNull();
    const run = await scenario("wav");
    const running = await createGenerationTaskRepository(database.db).claimRunning({ ownerId: run.ownerId, taskId: run.payload.taskId });
    const normalized = await run.dependencies.provider(running!);
    expect(normalized.status).toBe("succeeded"); expect(normalized).not.toHaveProperty("consumedUnits");
    await createGenerationResultRepository(database.db).create({ ownerId: run.ownerId, taskId: run.payload.taskId, ...normalized } as any);
    const recovered = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(recovered).toMatchObject({ replay: true, task: { deliveryStatus: "visible", billingStatus: "captured" }, result: { consumedUnits: 1 } });
    expect(run.observed).toHaveLength(1);
});

test("TTS parameters reject music, unknown models, unknown voices and legacy instructions without mutation", () => {
    const input = { text: " text " }, parameters = { voice: "alloy", format: "mp3" };
    for (const extra of [{ seconds: 1 }, { loop: true }, { instrumental: true }]) expect(parseGenerationAudioRequest(input, { ...parameters, ...extra })).toHaveProperty("errorCode");
    expect(parseGenerationAudioRequest(input, { ...parameters, voice: "invented" })).toHaveProperty("errorCode");
    expect(parseGenerationAudioRequest(input, parameters, "opaque-unverified-tts")).toHaveProperty("errorCode", "audio_model_unsupported");
    expect(parseGenerationAudioRequest(input, { ...parameters, language: "中文" }, "tts-1")).toHaveProperty("errorCode", "audio_instructions_unsupported");
    expect(parseGenerationAudioRequest(input, parameters, "tts-1")).toMatchObject({ body: { input: " text " } });
    expect(parseGenerationAudioRequest(input, { voice: "default", format: "wav" })).not.toHaveProperty("errorCode");
    expect(parseGenerationAudioRequest(input, { voice: "default", format: "wav" }, "gemini-3.8-flash-tts")).toEqual({ protocol: "chat-audio",
        body: { messages: [{ role: "user", content: "请用中文清晰读出： text " }], stream: false } });
    expect(parseGenerationAudioRequest(input, { voice: "default", format: "wav" }, "gpt-4o-mini-tts")).toHaveProperty("errorCode", "audio_voice_unsupported");
    for (const unverified of ["gemini-3.8-flash-tts-preview", "grok-voice-latest"]) expect(parseGenerationAudioRequest(input, { voice: "default", format: "wav" }, unverified)).toHaveProperty("errorCode", "audio_model_unsupported");
});

test.each(["snapshot", "media"])("audio %s corruption at the saved boundary blocks later capture and provider replay", async mode => {
    const run = await scenario("wav");
    const delivered = await processGenerationJob(database.db, run.payload, { ...run.dependencies, settleBilling: undefined });
    expect(delivered.task).toMatchObject({ deliveryStatus: "visible", billingStatus: "pending_review" });
    if (mode === "snapshot") {
        const snapshot = structuredClone(delivered.result.resultSnapshot);
        (snapshot.audio as Record<string, unknown>).base64 = Buffer.from(mp3).toString("base64");
        await database.db.update(generationResult).set({ resultSnapshot: snapshot }).where(eq(generationResult.taskId, run.payload.taskId));
    } else {
        const row = await createMediaRepository(database.db).get(run.ownerId, run.payload.taskId);
        const changed = new Uint8Array(wav); changed[changed.length - 1] ^= 1;
        await run.storage.put({ key: objectKey(row!.objectKey), body: changed, contentType: "audio/wav" });
    }
    const recovered = await processGenerationJob(database.db, run.payload, run.dependencies);
    expect(recovered.task.billingStatus).toBe("pending_review"); expect(run.observed).toHaveLength(1);
    expect((await createWalletRepository(database.db).listLedger(run.ownerId)).filter(row => row.kind === "capture")).toHaveLength(0);
});

test("audio settlement binds owner/task/reservation/amount and authenticates the original capture key", async () => {
    const run = await scenario("wav");
    const delivered = await processGenerationJob(database.db, run.payload, { ...run.dependencies, settleBilling: undefined });
    const settle = run.dependencies.settleBilling;
    for (const mutation of [{ ownerId: "other-owner" }, { taskId: crypto.randomUUID() }]) {
        expect(await settle({ task: delivered.task, result: { ...delivered.result, ...mutation }, delivery: delivered.delivery })).toBe("pending_review");
    }
    const wallets = createWalletRepository(database.db);
    const another = await wallets.reserve({ userId: run.ownerId, requestedUnits: 8, idempotencyKey: crypto.randomUUID(), taskId: crypto.randomUUID() });
    expect(await settle({ task: { ...delivered.task, reservationId: another.id }, result: delivered.result, delivery: delivered.delivery })).toBe("pending_review");
    expect(await settle({ task: { ...delivered.task, quotedUnits: 8 }, result: delivered.result, delivery: delivered.delivery })).toBe("pending_review");
    await wallets.capture({ userId: run.ownerId, reservationId: run.accepted.reservation.id, capturedUnits: 7,
        idempotencyKey: "synthetic-wrong-capture-key", referenceType: "generation", referenceId: run.payload.taskId });
    expect(await settle({ task: delivered.task, result: delivered.result, delivery: delivered.delivery })).toBe("pending_review");
    const proper = await scenario("wav");
    const saved = await processGenerationJob(database.db, proper.payload, { ...proper.dependencies, settleBilling: undefined });
    await wallets.capture({ userId: proper.ownerId, reservationId: proper.accepted.reservation.id, capturedUnits: 7,
        idempotencyKey: `generation:${proper.payload.taskId}:capture`, referenceType: "generation", referenceId: proper.payload.taskId });
    const ledger = await wallets.listLedger(proper.ownerId);
    expect((await processGenerationJob(database.db, proper.payload, proper.dependencies)).task.billingStatus).toBe("captured");
    expect(await wallets.listLedger(proper.ownerId)).toEqual(ledger); expect(saved.result.consumedUnits).toBe(1);
});

test("audio failed release recovery authenticates its fixed amount and release key", async () => {
    for (const correct of [false, true]) {
        const run = await scenario("wav", { response: () => new Response("synthetic rejection", { status: 400 }) });
        await processGenerationJob(database.db, run.payload, { ...run.dependencies, settleBilling: undefined });
        const wallets = createWalletRepository(database.db);
        await wallets.release({ userId: run.ownerId, reservationId: run.accepted.reservation.id, releasedUnits: 7,
            idempotencyKey: correct ? `generation:${run.payload.taskId}:release` : "synthetic-wrong-release-key", referenceType: "generation", referenceId: run.payload.taskId });
        const ledger = await wallets.listLedger(run.ownerId);
        expect((await processGenerationJob(database.db, run.payload, run.dependencies)).task.billingStatus).toBe(correct ? "released" : "pending_review");
        expect(await wallets.listLedger(run.ownerId)).toEqual(ledger); expect(run.observed).toHaveLength(1);
    }
});

test("audio API and worker opt in independently with private storage; migrated audio readiness is real", async () => {
    const env = { SAAS_GENERATION_AUDIO_ENABLED: "true", GENERATION_WORKER_QUEUE_URL: "postgres://db.example.test/canvas" };
    expect(() => readGenerationApiConfig(env, null)).toThrow("音频生成 API");
    expect(readGenerationApiConfig(env, { SAAS_DATABASE_URL: env.GENERATION_WORKER_QUEUE_URL, cloudMedia: true,
        storage: { provider: "server-disk", rootDirectory: "synthetic", quotaBytes: 16384, maxBytes } })).toMatchObject({ audioEnabled: true, imageEnabled: false, textEnabled: false });
    expect(() => readGenerationWorkerProcessConfig({ GENERATION_WORKER_ENABLED: "true", GENERATION_WORKER_ENVIRONMENT: "staging", GENERATION_WORKER_QUEUE_URL: env.GENERATION_WORKER_QUEUE_URL,
        SAAS_DATABASE_URL: env.GENERATION_WORKER_QUEUE_URL, SAAS_AUTH_SECRET: secret, GENERATION_WORKER_AUDIO_ENABLED: "true" })).toThrow("音频生成 worker");
    // PGlite exposes a node-postgres-shaped parameter adapter here, without opening a service.
    const pool = { query: (text: string, values?: readonly unknown[]) => process.env.SAAS_TEST_DATABASE_URL
        ? (database.pool as any).query(text, values) : (database.pool as any).query({ text, values }) };
    expect(await checkGenerationDatabaseReadiness(pool, true)).toBe(true);
});

test("binary gateway checks declared lengths, redirects and private destinations without real network", async () => {
    const target = { providerId: "synthetic", adapter: "openai-compatible" as const, endpoint: "https://speech.example.test/v1", credential: "synthetic" };
    for (const declaration of ["invalid", "-1", "9007199254740992", "1", String(mp3.byteLength + 1)]) {
        const gateway = createProviderGateway(async () => new Response(mp3, { headers: { "content-length": declaration } }), () => ["93.184.216.34"]);
        expect(await gateway.requestAudio({ target, path: "audio/speech", body: {}, maxBytes: 4096 })).toMatchObject({ status: "unknown", retryable: false });
    }
    const exact = createProviderGateway(async () => new Response(mp3, { headers: { "content-length": String(mp3.byteLength) } }), () => ["93.184.216.34"]);
    expect(await exact.requestAudio({ target, path: "audio/speech", body: {}, maxBytes: 4096 })).toMatchObject({ status: "succeeded", body: mp3 });
    let calls = 0;
    const privateGateway = createProviderGateway(async () => { calls++; return new Response(mp3); }, () => ["127.0.0.1"]);
    expect(await privateGateway.requestAudio({ target, path: "audio/speech", body: {}, maxBytes: 4096 })).toMatchObject({ status: "failed", requestSent: false });
    expect(calls).toBe(0);
});

test("authenticated audio HTTP quote/confirm/recover and private media use the platform owner contract", async () => {
    const run = await scenario("wav"), origin = "http://localhost:4000", mails: Array<{ to: string; url: string }> = [], jobs: unknown[] = [];
    const options: Parameters<typeof createAccountApi>[0] = { database: database.db, origin,
        auth: { secret, sendVerificationEmail: async mail => { mails.push(mail); } }, rates: createRateStore(database.pool, secret), verifyHuman: async () => true,
        media: { storage: run.storage, quotaBytes: run.quotaBytes, maxBytes },
        generation: { enabled: true, imageEnabled: false, textEnabled: false, audioEnabled: true,
            queue: { async send(_name, payload) { jobs.push(payload); return crypto.randomUUID(); } } }, onFault: () => undefined };
    const app = createApp(createAccountApi(options), "synthetic-public-site-key", false, true, undefined, { audio: true });
    let cookie = "", accountId = "";
    const http = (path: string, body?: unknown, headers: Record<string, string> = {}, handler = app) => handler(new Request(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST", headers: { origin, cookie, "content-type": "application/json",
            ...(accountId ? { "x-canvas-account-id": accountId } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.89");
    const email = `audio-http-${crypto.randomUUID()}@example.test`, password = "synthetic-audio-http-password";
    expect((await http("/api/v1/generation/audio/models")).status).toBe(401);
    expect((await http("/api/auth/sign-up/email", { name: "Synthetic Audio HTTP", email, password })).status).toBe(200);
    expect((await http(mails.find(mail => mail.to === email)!.url)).status).toBe(302);
    const signedIn = await http("/api/auth/sign-in/email", { email, password });
    expect(signedIn.status).toBe(200);
    cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    accountId = (await (await http("/api/v1/session")).json()).user.id;
    await database.db.insert(wallet).values({ userId: accountId, availableUnits: "100" });
    expect((await (await http("/api/v1/site")).json()).features.generation.audio).toBe(true);
    const catalog = await (await http("/api/v1/generation/audio/models")).json();
    expect(catalog.items.find((item: any) => item.id === run.modelId)).toHaveProperty("audio.instructions", true);
    const body = { modelId: run.modelId, input: run.intent.inputSnapshot, parameters: run.intent.parameterSnapshot };
    const quoteResponse = await http("/api/v1/generation/audio/quote", body);
    expect(quoteResponse.status).toBe(200);
    const { quote } = await quoteResponse.json(), key = `http-audio-${crypto.randomUUID()}`;
    expect(quote.quoteFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await http("/api/v1/generation/audio/tasks", { ...body, confirmedPriceVersion: 1 }, { "idempotency-key": key })).status).toBe(400);
    const submission = { ...body, confirmedPriceVersion: quote.priceVersion, confirmedQuoteFingerprint: quote.quoteFingerprint };
    const first = await http("/api/v1/generation/audio/tasks", submission, { "idempotency-key": key });
    expect(first.status).toBe(201);
    const accepted = await first.json();
    expect(accepted.task).toMatchObject({ projectId: null, nodeId: null, audioSnapshot: { status: "recorded" }, billingStatus: "reserved" });
    expect((await http("/api/v1/generation/audio/tasks", submission, { "idempotency-key": key })).status).toBe(200);
    expect(jobs).toHaveLength(1);
    expect((await (await http(`/api/v1/generation/tasks/by-key/${key}`)).json()).task.id).toBe(accepted.task.id);
    const payload = jobs[0] as Parameters<typeof processGenerationJob>[1];
    expect((await processGenerationJob(database.db, payload, run.dependencies)).task.billingStatus).toBe("captured");
    const view = await (await http(`/api/v1/generation/tasks/${accepted.task.id}`)).json();
    const mediaId = view.result.resultSnapshot.media.mediaId;
    const media = await http(`/api/v1/media/${mediaId}`);
    expect(media.status).toBe(200); expect(media.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(wav);
    expect((await http(`/api/v1/generation/tasks/${accepted.task.id}`, undefined, { "x-canvas-account-id": "different-owner" })).status).toBe(409);
    const closed = createApp(createAccountApi({ ...options, generation: { ...options.generation!, audioEnabled: false } }), "synthetic-site-key");
    expect((await http("/api/v1/generation/audio/models", undefined, {}, closed)).status).toBe(503);
});
