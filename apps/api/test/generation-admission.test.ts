import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { contentSafetyEvent, generationTask, modelCatalog, modelProvider, rateLimit, session, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import type { RateBatchEntry, RateClient, RateStore } from "@infinite-canvas/database/rate-limit";
import { quoteReserveAndEnqueueConfirmedImageTask, type GenerationQueueSender } from "../src/generation-dispatch";
import { quoteReserveAndEnqueueConfirmedAudioTask } from "../src/generation-audio-dispatch";
import { quoteReserveAndEnqueueConfirmedTextTask } from "../src/generation-text-dispatch";
import { quoteReserveAndEnqueueConfirmedVideoTask } from "../src/generation-video-dispatch";
import { resolveExecutableImageQuote } from "../src/generation-image-policy";
import { resolveExecutableAudioQuote } from "../src/generation-audio-policy";
import { resolveExecutableTextQuote } from "../src/generation-text-policy";
import { resolveExecutableVideoQuote } from "../src/generation-video-policy";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { getGenerationTaskForOwner } from "../src/generation-query";
import type { GenerationSubmissionSafety } from "../src/generation-admission";
import type { GenerationIntent } from "../src/generation-contract";
import { createTestDatabase } from "./database";
import { generationRateTextRules } from "./generation-rate-fixtures";
import { composeTextContextTierNote } from "../../../packages/shared/src/model-price-publications";

if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Only an independent in-memory PGlite database is permitted");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const secret = `synthetic-admission-${crypto.randomUUID()}`;
const capabilities = ["image", "text", "audio", "video"] as const;
// Explicit synthetic limits exercise admission only; no tool or provider is run.
const videoPolicy: VideoRuntimePolicy = {
    createTimeoutMs: 1000, inspectTimeoutMs: 1000, downloadTimeoutMs: 1000, jsonMaxBytes: 4096,
    pollIntervalMs: 100, claimLeaseMs: 120000, recoveryScanIntervalMs: 100, recoveryScanBatchSize: 10,
    observationWindowMs: 600000, maxInspectAttempts: 10, maxDownloadAttempts: 3,
    maxVideoBytes: 1048576, maxPixels: 1000000, maxMediaDurationMs: 15000,
    referenceMaxBytes: 4096, referenceMaxPixels: 1000000, referenceContentTypes: ["image/png"],
    ffmpegPath: "synthetic-not-executed-ffmpeg", ffprobePath: "synthetic-not-executed-ffprobe", probeTempRoot: "synthetic-not-created",
    probeTimeoutMs: 30000, probeStdoutMaxBytes: 65536, probeStderrMaxBytes: 65536, probeMemoryMaxBytes: 268435456, probeCpuLimit: 5000,
};
const videoParameters: VideoParameters = { mode: "text", resolution: "480p", durationSeconds: 1, aspectRatio: "16:9", generateAudio: false };
beforeAll(async () => { database = await createTestDatabase(); }, 30_000);
afterAll(async () => { await database?.close(); });

async function fixture(capability: typeof capabilities[number]) {
    const id = crypto.randomUUID(), ownerId = `admission-owner-${id}`, modelId = `admission-model-${id}`, providerId = `admission-provider-${id}`;
    const providerModel = capability === "audio" ? "gpt-4o-mini-tts" : `synthetic-${capability}`;
    const endpoint = "https://synthetic-admission.example.test/v1";
    await database.db.insert(user).values({ id: ownerId, name: "Synthetic admission owner", email: `${id}@example.test`, role: "admin", emailVerified: true });
    const sessionId = crypto.randomUUID(), sessionExpiresAt = new Date(Date.now() + 3600000);
    await database.db.insert(session).values({ id: sessionId, token: crypto.randomUUID(), userId: ownerId, expiresAt: sessionExpiresAt });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic admission channel", adapter: "openai-compatible", endpoint, secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, secret, providerId, "synthetic-admission-key");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel, displayName: "Synthetic admission model", capability, enabled: true });
    const write: ModelPriceDraftWrite = { modelId, expectedVersion: 0, binding: { providerId, providerModel, adapter: "openai-compatible", endpoint, capability }, priceNote: "Synthetic only",
        rules: { schemaVersion: 1, cost: null, ...(capability === "video" ? { video: { schemaVersion: 1 as const, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY } } : {}),
            sale: capability === "video" ? { template: "video_count", currency: "credit", bands: [{ parameters: Object.fromEntries(Object.entries(videoParameters).map(([key, value]) => [key, String(value)])), rates: { video: "7" } }] }
            : capability === "text" ? { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] }
            : { template: capability === "audio" ? "audio_request" : "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } } };
    if (capability === "text") write.rules = await generationRateTextRules(database.db, modelId, write.binding);
    const audit = { actorId: ownerId, requestId: crypto.randomUUID() }, draft = await createModelPriceDraft(database.db, write, audit);
    if (draft.status !== "saved") throw new Error(draft.status);
    const publication = await publishModelPriceDraft(database.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: 1, expectedPriceVersion: 0, binding: write.binding,
        publicPriceNote: capability === "text" ? composeTextContextTierNote(write.rules, write.binding, "Synthetic only")! : "Synthetic only" }, audit);
    if (publication.status !== "published") throw new Error(publication.status);
    const intent: GenerationIntent = { modelId,
        inputSnapshot: capability === "audio" ? { text: "Synthetic speech" } : { prompt: "Synthetic prompt; must not enter safety event" },
        parameterSnapshot: capability === "video" ? videoParameters : capability === "audio" ? { voice: "alloy", format: "mp3" } : {} };
    const input = { ...intent, ownerId, requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), budgetCredits: "7" };
    const rateMarker = `synthetic-admission-rate-${id}`, queueMarker = `synthetic-admission-queue-${id}`;
    let queued = 0, queueFailure = false;
    // A transactional SQL marker is only a queue fixture, not a replacement pg-boss implementation.
    const queue: GenerationQueueSender = { async send(_name, _payload, options) {
        queued++; expect(options?.db).toBeDefined();
        await options!.db!.executeSql('INSERT INTO canvas_saas.rate_limit (key,points,expire) VALUES ($1,1,NULL)', [queueMarker]);
        if (queueFailure) throw new Error("synthetic transactional enqueue failed");
        return crypto.randomUUID();
    } };
    const quote = () => capability === "video" ? resolveExecutableVideoQuote(database.db, input, ownerId, videoPolicy)
        : capability === "image" ? resolveExecutableImageQuote(database.db, input, false, ownerId)
        : capability === "audio" ? resolveExecutableAudioQuote(database.db, input, ownerId) : resolveExecutableTextQuote(database.db, input);
    const submit = async (admission: GenerationSubmissionSafety) => {
        if (capability === "video") {
            const priced = await resolveExecutableVideoQuote(database.db, input, ownerId, videoPolicy);
            return quoteReserveAndEnqueueConfirmedVideoTask(database.db, queue, input, priced.priceVersion, priced.quoteFingerprint, videoPolicy, { admission });
        }
        if (capability === "text") return quoteReserveAndEnqueueConfirmedTextTask(database.db, queue, input, 1, { admission });
        const priced = capability === "audio" ? await resolveExecutableAudioQuote(database.db, input, ownerId) : await resolveExecutableImageQuote(database.db, input, false, ownerId);
        return capability === "audio" ? quoteReserveAndEnqueueConfirmedAudioTask(database.db, queue, input, 1, priced.quoteFingerprint!, { admission })
            : quoteReserveAndEnqueueConfirmedImageTask(database.db, queue, input, 1, priced.quoteFingerprint, { admission });
    };
    const money = async () => ({ tasks: await database.db.select().from(generationTask).where(eq(generationTask.ownerId, ownerId)),
        wallet: await database.db.select().from(wallet).where(eq(wallet.userId, ownerId)),
        reservations: await database.db.select().from(walletReservation).where(eq(walletReservation.userId, ownerId)),
        ledger: await database.db.select().from(walletLedger).where(eq(walletLedger.userId, ownerId)),
        queued: (await database.db.select().from(rateLimit).where(eq(rateLimit.key, queueMarker))).length });
    const events = () => database.db.select().from(contentSafetyEvent).where(eq(contentSafetyEvent.modelId, modelId));
    const markers = () => database.db.select().from(rateLimit).where(eq(rateLimit.key, rateMarker));
    return { capability, input, sessionId, sessionExpiresAt, submit, quote, money, events, markers, rateMarker, queued: () => queued,
        failQueue: () => { queueFailure = true; }, resumeQueue: () => { queueFailure = false; } };
}
function context(run: Awaited<ReturnType<typeof fixture>>, consumeMany: NonNullable<RateStore["consumeMany"]>, checkpointMode: "off" | "record" = "off"): GenerationSubmissionSafety {
    return { actorId: run.input.ownerId, sessionId: run.sessionId, sessionExpiresAt: run.sessionExpiresAt, requestId: run.input.requestId, peerIp: "198.51.100.42",
        rates: { consume: async () => { throw new Error("single-bucket generation consume is forbidden"); }, consumeMany },
        config: { checkpointMode, generationRates: { ip: null, user: null, models: [] }, generationPolicyDefaults: {
            ip: { enabled: false, points: 2, duration: 60 }, user: { enabled: false, points: 5, duration: 120 },
        } }, onRecordUnavailable: () => undefined };
}
function configure(admission: GenerationSubmissionSafety, modelId: string) {
    // Explicit synthetic rules, never platform defaults or a test of Q1's window/counting algorithm.
    admission.config.generationPolicyDefaults.ip.enabled = true;
    admission.config.generationPolicyDefaults.user.enabled = true;
    admission.config.generationRates.models = [{ modelId, points: 3, duration: 180 }];
}
async function beforeReserve(client: RateClient, ownerId: string) {
    const result = await client.query({ text: `SELECT
        (SELECT count(*)::int FROM canvas_saas.generation_task WHERE owner_id=$1) AS tasks,
        (SELECT count(*)::int FROM canvas_saas.wallet_reservation WHERE user_id=$1) AS reservations,
        (SELECT count(*)::int FROM canvas_saas.wallet_ledger WHERE user_id=$1) AS ledger,
        (SELECT reserved_units::text FROM canvas_saas.wallet WHERE user_id=$1) AS reserved`, values: [ownerId] });
    expect((result as { rows: unknown[] }).rows[0]).toEqual({ tasks: 1, reservations: 0, ledger: 0, reserved: "0" });
}
const writeRateMarker = (client: RateClient, marker: string) => client.query({ text: "INSERT INTO canvas_saas.rate_limit (key,points,expire) VALUES ($1,1,NULL)", values: [marker] });

test.each(capabilities)("%s confirmed submit without configured rules consumes no rate budget; quote and owner GET stay read-only", async capability => {
    const run = await fixture(capability); let consumed = 0;
    const admission = context(run, async () => { consumed++; throw new Error("No rule may consume"); });
    const before = await run.money(); await run.quote(); expect(await run.money()).toEqual(before);
    const accepted = await run.submit(admission);
    expect(accepted.created).toBe(true); expect(accepted.task.billingStatus).toBe("reserved");
    await getGenerationTaskForOwner(database.db, { ownerId: run.input.ownerId, taskId: accepted.task.id });
    const state = await run.money(); await run.quote();
    expect((await run.submit(admission)).created).toBe(false);
    expect(await run.money()).toEqual(state); expect(consumed).toBe(0); expect(await run.events()).toHaveLength(0); expect(run.queued()).toBe(1);
});

test.each(capabilities)("%s admission uses the resolved model and trusted actor/request and never records the prompt", async capability => {
    const run = await fixture(capability), calls: RateBatchEntry[][] = [];
    const admission = context(run, async (entries, transaction) => {
        calls.push(structuredClone([...entries])); expect(run.queued()).toBe(0);
        return transaction(async client => { await beforeReserve(client, run.input.ownerId); await writeRateMarker(client, run.rateMarker); return { allowed: true as const }; });
    }, "record");
    configure(admission, run.input.modelId);
    const accepted = await run.submit(admission);
    expect(calls).toEqual([[{ bucket: "generation-ip", identity: "198.51.100.42", rule: { points: 2, duration: 60 } },
        { bucket: "generation-user", identity: run.input.ownerId, rule: { points: 5, duration: 120 } },
        { bucket: "generation-model", identity: run.input.modelId, rule: { points: 3, duration: 180 } }]]);
    expect(await run.markers()).toHaveLength(1);
    const recorded = await run.events(); expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ actorId: run.input.ownerId, requestId: run.input.requestId, modelId: run.input.modelId, capability, phase: "pre_generation", mode: "record" });
    expect(JSON.stringify(recorded)).not.toMatch(/Synthetic prompt|Synthetic speech|198\.51\.100\.42|synthetic-admission-key/);
    const state = await run.money(); await run.submit(admission);
    await getGenerationTaskForOwner(database.db, { ownerId: run.input.ownerId, taskId: accepted.task.id }); await run.quote();
    expect(await run.money()).toEqual(state); expect(calls).toHaveLength(1); expect(await run.markers()).toHaveLength(1); expect(await run.events()).toEqual(recorded);
});

test.each(capabilities)("%s configured denial, unavailable rate store and missing trusted IP reject before reserve or enqueue", async capability => {
    for (const mode of ["denied", "unavailable", "missing_ip", "missing_atomic"] as const) {
        const run = await fixture(capability); let calls = 0;
        const admission = context(run, async (entries, transaction) => {
            calls++; expect(entries.map(entry => entry.bucket)).toEqual(["generation-ip", "generation-user", "generation-model"]);
            return transaction(async client => {
                await beforeReserve(client, run.input.ownerId); await writeRateMarker(client, run.rateMarker);
                if (mode === "unavailable") await client.query({ text: "SELECT 1 / 0 AS synthetic_rate_storage_failure" });
                return { allowed: false as const, retryAfter: 17 };
            });
        });
        configure(admission, run.input.modelId);
        if (mode === "missing_ip") admission.peerIp = undefined;
        if (mode === "missing_atomic") delete admission.rates.consumeMany;
        const before = await run.money();
        await expect(run.submit(admission)).rejects.toMatchObject(mode === "denied" ? { status: 429, code: "rate_limited", retryAfter: 17 } : { status: 503, code: "service_unavailable" });
        expect(await run.money()).toEqual(before); expect(await run.markers()).toHaveLength(0);
        expect(calls).toBe(mode === "missing_ip" || mode === "missing_atomic" ? 0 : 1);
    }
});

test.each(capabilities)("%s rejects a forged actor or request identity before checkpoint, rate or money", async capability => {
    for (const field of ["actorId", "requestId"] as const) {
        const run = await fixture(capability); let calls = 0;
        const admission = context(run, async () => { calls++; return { allowed: true }; }, "record");
        admission[field] = "untrusted-forged-value";
        const before = await run.money(); await expect(run.submit(admission)).rejects.toMatchObject({ code: "invalid_input" });
        expect(await run.money()).toEqual(before); expect(calls).toBe(0); expect(await run.events()).toHaveLength(0);
    }
});

test.each(capabilities)("%s record failure reports a fault outside the funds transaction and does not block submission", async capability => {
    const run = await fixture(capability); let faults = 0, consumed = 0;
    const admission = context(run, async (_entries, transaction) => {
        consumed++; return transaction(async client => { await beforeReserve(client, run.input.ownerId); await writeRateMarker(client, run.rateMarker); return { allowed: true as const }; });
    }, "record");
    configure(admission, run.input.modelId);
    admission.onRecordUnavailable = () => { faults++; throw new Error("Synthetic fault sink unavailable"); };
    await database.db.execute(sql`CREATE FUNCTION canvas_saas.synthetic_reject_content_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic record unavailable'; END; $$`);
    await database.db.execute(sql`CREATE TRIGGER synthetic_reject_content_event BEFORE INSERT ON canvas_saas.content_safety_event FOR EACH ROW EXECUTE FUNCTION canvas_saas.synthetic_reject_content_event()`);
    try {
        const accepted = await run.submit(admission);
        expect(accepted.task.billingStatus).toBe("reserved"); expect(accepted.created).toBe(true); expect(faults).toBe(1); expect(consumed).toBe(1);
        expect(await run.events()).toHaveLength(0); expect((await run.money()).reservations).toHaveLength(1); expect(run.queued()).toBe(1);
        expect(await run.markers()).toHaveLength(1);
        await run.submit(admission); expect(faults).toBe(1); expect(consumed).toBe(1); expect(run.queued()).toBe(1);
    } finally {
        await database.db.execute(sql`DROP TRIGGER synthetic_reject_content_event ON canvas_saas.content_safety_event`);
        await database.db.execute(sql`DROP FUNCTION canvas_saas.synthetic_reject_content_event()`);
    }
});

test.each(capabilities)("%s admission commits with funds and transactional queue, never ahead of a later failure", async capability => {
    for (const mode of ["wallet", "queue"] as const) {
        const run = await fixture(capability); let consumed = 0;
        const admission = context(run, async (_entries, transaction) => {
            consumed++; return transaction(async client => { await beforeReserve(client, run.input.ownerId); await writeRateMarker(client, run.rateMarker); return { allowed: true as const }; });
        });
        configure(admission, run.input.modelId);
        if (mode === "wallet") await database.db.update(wallet).set({ availableUnits: "1" }).where(eq(wallet.userId, run.input.ownerId));
        else run.failQueue();
        const before = await run.money();
        if (mode === "wallet") await expect(run.submit(admission)).rejects.toMatchObject({ code: "insufficient_balance" });
        else await expect(run.submit(admission)).rejects.toThrow("synthetic transactional enqueue failed");
        expect(await run.money()).toEqual(before); expect(await run.markers()).toHaveLength(0);
        expect(consumed).toBe(1); expect(run.queued()).toBe(mode === "wallet" ? 0 : 1);
        // The failed transaction did not consume the task key or retain a committed rate/queue marker.
        await database.db.update(wallet).set({ availableUnits: "100" }).where(eq(wallet.userId, run.input.ownerId)); run.resumeQueue();
        expect((await run.submit(admission)).created).toBe(true);
        const committed = await run.money(); expect(committed.tasks).toHaveLength(1); expect(committed.reservations).toHaveLength(1);
        expect(committed.ledger).toHaveLength(1); expect(committed.queued).toBe(1); expect(await run.markers()).toHaveLength(1);
        expect((await run.submit(admission)).created).toBe(false); expect(consumed).toBe(2); expect(await run.money()).toEqual(committed);
    }
});

test("an original task replay skips policy resolution but a new key fails closed when the policy relation is unavailable", async () => {
    const run = await fixture("image"); let consumed = 0;
    const admission = context(run, async (_entries, transaction) => {
        consumed++; return transaction(async client => { await beforeReserve(client, run.input.ownerId); return { allowed: true as const }; });
    });
    configure(admission, run.input.modelId);
    const accepted = await run.submit(admission), committed = await run.money();
    await database.db.execute(sql`ALTER TABLE canvas_saas.generation_rate_settings RENAME TO synthetic_unavailable_generation_rate_settings`);
    try {
        expect((await run.submit(admission)).task.id).toBe(accepted.task.id); expect(consumed).toBe(1);
        run.input.idempotencyKey = crypto.randomUUID();
        await expect(run.submit(admission)).rejects.toMatchObject({ status: 503, code: "generation_admission_unavailable" });
        expect(await run.money()).toEqual(committed); expect(consumed).toBe(1);
    } finally {
        await database.db.execute(sql`ALTER TABLE canvas_saas.synthetic_unavailable_generation_rate_settings RENAME TO generation_rate_settings`);
    }
});
