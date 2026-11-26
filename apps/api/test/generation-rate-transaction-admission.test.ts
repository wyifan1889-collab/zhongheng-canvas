import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "@infinite-canvas/database";
import { createJobQueue, GENERATION_QUEUE_NAME, isGenerationQueueReady, type GenerationJobPayload } from "@infinite-canvas/jobs";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { createRateStore, type RateStore, type RateTransactionRunner } from "@infinite-canvas/database/rate-limit";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { contentSafetyEvent, generationTask, generationVideoStage, modelCatalog, modelProvider,
    rateLimit, session, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { composeTextContextTierNote } from "../../../packages/shared/src/model-price-publications";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { readContentSafetyConfig } from "../src/content-safety-config";
import type { GenerationSubmissionSafety } from "../src/generation-admission";
import { quoteReserveAndEnqueueConfirmedImageTask, type GenerationQueueSender } from "../src/generation-dispatch";
import { quoteReserveAndEnqueueConfirmedAudioTask } from "../src/generation-audio-dispatch";
import { quoteReserveAndEnqueueConfirmedTextTask } from "../src/generation-text-dispatch";
import { quoteReserveAndEnqueueConfirmedVideoTask } from "../src/generation-video-dispatch";
import { resolveExecutableImageQuote } from "../src/generation-image-policy";
import { resolveExecutableAudioQuote } from "../src/generation-audio-policy";
import { resolveExecutableTextQuote } from "../src/generation-text-policy";
import { resolveExecutableVideoQuote } from "../src/generation-video-policy";
import { getGenerationTaskForOwner } from "../src/generation-query";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
import { videoQueueTransaction } from "../src/generation-video-queue";
import { createTestDatabase, postgresTestUrl } from "./database";
import { generationRateTextRules } from "./generation-rate-fixtures";
import type { GenerationIntent } from "../src/generation-contract";

// The owning runner creates a fresh loopback PG16 cluster and installs pg-boss.
// No worker consumer, provider, probe or object-storage adapter is started here.
const enabled = process.env.Q1_D04_POSTGRES === "1", native = enabled ? test : test.skip;
if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || (process.env.SAAS_TEST_DATABASE_URL && !enabled)) {
    throw new Error("D04 transaction admission only accepts its explicit isolated native runner");
}
const url = enabled ? postgresTestUrl() : null;
if (enabled && !url) throw new Error("D04 native runner must supply its fresh loopback database");
let database: Awaited<ReturnType<typeof createTestDatabase>>, boss: ReturnType<typeof createJobQueue>;
const capabilities = ["image", "text", "audio", "video"] as const;
type Capability = typeof capabilities[number];
const parameters: VideoParameters = { mode: "text", resolution: "480p", durationSeconds: 1, aspectRatio: "16:9", generateAudio: false };
const runtime: VideoRuntimePolicy = { createTimeoutMs: 100, inspectTimeoutMs: 100, downloadTimeoutMs: 100, jsonMaxBytes: 4096,
    pollIntervalMs: 100, claimLeaseMs: 2000, recoveryScanIntervalMs: 100, recoveryScanBatchSize: 10, observationWindowMs: 10000,
    maxInspectAttempts: 10, maxDownloadAttempts: 3, maxVideoBytes: 4096, maxPixels: 1000000, maxMediaDurationMs: 15000,
    referenceMaxBytes: 1024, referenceMaxPixels: 1000000, referenceContentTypes: ["image/png"], ffprobePath: "synthetic-not-executed", ffmpegPath: "synthetic-not-executed",
    probeTimeoutMs: 100, probeStdoutMaxBytes: 4096, probeStderrMaxBytes: 4096, probeMemoryMaxBytes: 1000000, probeCpuLimit: 100, probeTempRoot: "synthetic-not-created" };

beforeAll(async () => {
    if (!enabled) return;
    database = await createTestDatabase();
    const settings = await database.db.execute(sql`SELECT revision, active_version_id FROM canvas_saas.generation_rate_settings WHERE id='generation'`);
    expect((settings as unknown as { rows: unknown[] }).rows).toEqual([{ revision: 0, active_version_id: null }]);
    boss = createJobQueue(url!, error => { throw error; }); await boss.start();
    expect(isGenerationQueueReady(await boss.getQueue(GENERATION_QUEUE_NAME))).toBe(true);
}, 30_000);
afterAll(async () => { try { await boss?.stop(); } finally { await database?.close(); } });

const rows = (result: unknown): Array<Record<string, unknown>> => Array.isArray(result) ? result
    : (result as { rows: Array<Record<string, unknown>> }).rows;

async function fixture(capability: Capability) {
    const id = crypto.randomUUID(), ownerId = `d04-transaction-${id}`, modelId = `d04-${capability}-${id}`, providerId = crypto.randomUUID();
    const rateSecret = `synthetic-d04-rate-${crypto.randomUUID()}`, peerIp = "198.51.100.42";
    await database.db.insert(user).values({ id: ownerId, name: "Synthetic D04 transaction", email: `${id}@example.test`, role: "admin", emailVerified: true });
    const sessionId = crypto.randomUUID(), sessionExpiresAt = new Date(Date.now() + 3600000);
    await database.db.insert(session).values({ id: sessionId, userId: ownerId, token: crypto.randomUUID(), expiresAt: sessionExpiresAt });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    const binding = { providerId, providerModel: capability === "audio" ? "gpt-4o-mini-tts" : `synthetic-${capability}`,
        adapter: "openai-compatible" as const, endpoint: "https://synthetic-d04.invalid/v1", capability };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic D04 provider", adapter: binding.adapter, endpoint: binding.endpoint, secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, "synthetic-d04-admission-auth-secret", providerId, "synthetic-provider-key");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: binding.providerModel, displayName: "Synthetic D04 model", capability, enabled: true });
    let rules: ModelPriceDraftWrite["rules"], publicPriceNote = "Synthetic D04 price";
    if (capability === "text") {
        rules = await generationRateTextRules(database.db, modelId, binding);
        publicPriceNote = composeTextContextTierNote(rules, binding, "Synthetic D04 text")!;
    } else rules = { schemaVersion: 1, cost: null,
        ...(capability === "video" ? { video: { schemaVersion: 1 as const, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY } } : {}),
        sale: capability === "video" ? { template: "video_count", currency: "credit", bands: [{
            parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), rates: { video: "7" } }] }
            : { template: capability === "audio" ? "audio_request" : "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } };
    const audit = { actorId: ownerId, requestId: crypto.randomUUID() };
    const draft = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, priceNote: "Synthetic D04 fixture", rules }, audit);
    if (draft.status !== "saved") throw new Error(`D04 fixture draft: ${draft.status}`);
    const publication = await publishModelPriceDraft(database.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: draft.draft.version,
        expectedPriceVersion: 0, binding, publicPriceNote }, audit);
    if (publication.status !== "published") throw new Error(`D04 fixture publication: ${publication.status}`);
    const input: GenerationIntent & { ownerId: string; idempotencyKey: string; requestId: string; budgetCredits: string } = { ownerId, modelId, inputSnapshot: capability === "audio" ? { text: "Synthetic speech" } : { prompt: "Synthetic prompt never stored in metadata" },
        parameterSnapshot: capability === "video" ? parameters : capability === "audio" ? { voice: "alloy", format: "mp3" } : {},
        idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(), budgetCredits: "7" };
    const quote = () => capability === "video" ? resolveExecutableVideoQuote(database.db, input, ownerId, runtime)
        : capability === "image" ? resolveExecutableImageQuote(database.db, input, false, ownerId)
        : capability === "audio" ? resolveExecutableAudioQuote(database.db, input, ownerId) : resolveExecutableTextQuote(database.db, input);
    const config = readContentSafetyConfig({ SAAS_CONTENT_SAFETY_MODE: "record",
        SAAS_GENERATION_IP_RATE_ENABLED: "true", SAAS_GENERATION_IP_RATE_POINTS: "3", SAAS_GENERATION_IP_RATE_DURATION_SECONDS: "3600",
        SAAS_GENERATION_USER_RATE_ENABLED: "true", SAAS_GENERATION_USER_RATE_POINTS: "3", SAAS_GENERATION_USER_RATE_DURATION_SECONDS: "86400",
        SAAS_GENERATION_MODEL_RATES: JSON.stringify([{ modelId, points: 3, duration: 3600 }]) });
    const rates = createRateStore(database.pool, rateSecret), rulesByBucket = [
        { bucket: "generation-ip", identity: peerIp, rule: config.generationRates.ip! },
        { bucket: "generation-user", identity: ownerId, rule: config.generationRates.user! },
        { bucket: "generation-model", identity: modelId, rule: config.generationRates.models[0]! },
    ];
    const keys = rulesByBucket.map(entry => `${entry.bucket}:${entry.rule.duration}:${createHmac("sha256", rateSecret).update(`canvas-rate\0${entry.identity}`).digest("hex")}`);
    const ratePids: number[] = [], queuePids: number[] = [], candidates: string[] = [];
    const trace = (store: RateStore): RateStore => ({ ...store, consumeMany: async (entries, transaction) => {
        if (!store.consumeMany) throw new Error("Native compound limiter required");
        return store.consumeMany(entries, work => transaction(async client => {
            const result = rows(await client.query({ text: `SELECT pg_backend_pid() AS pid,
                (SELECT count(*)::int FROM canvas_saas.generation_task WHERE owner_id=$1) AS tasks,
                (SELECT count(*)::int FROM canvas_saas.wallet_reservation WHERE user_id=$1) AS reservations,
                (SELECT count(*)::int FROM canvas_saas.wallet_ledger WHERE user_id=$1) AS ledger`, values: [ownerId] }))[0]!;
            expect(result.tasks).toBe(1); expect(result.reservations).toBe(0); expect(result.ledger).toBe(0);
            ratePids.push(result.pid as number); return work(client);
        }));
    } });
    const context = (store = rates, onRecordUnavailable = () => undefined): GenerationSubmissionSafety => ({ actorId: ownerId, sessionId, sessionExpiresAt,
        requestId: input.requestId, peerIp, config, rates: trace(store), onRecordUnavailable });
    const sender: GenerationQueueSender = { async send(name, payload, options) {
        expect(options?.db).toBeDefined();
        const pid = rows(await options!.db!.executeSql("SELECT pg_backend_pid() AS pid"))[0]!.pid as number;
        const admittedPid = ratePids.at(-1);
        if (admittedPid === undefined) throw new Error("No admission transaction PID was observed");
        queuePids.push(pid); expect(pid).toBe(admittedPid);
        const jobId = await boss.send(name, payload, options); if (jobId) candidates.push(jobId); return jobId;
    } };
    const get = (jobId: string) => boss.getJobById<GenerationJobPayload>(GENERATION_QUEUE_NAME, jobId);
    const state = async () => ({
        counters: await database.db.select().from(rateLimit).where(inArray(rateLimit.key, keys)).orderBy(rateLimit.key),
        tasks: await database.db.select().from(generationTask).where(eq(generationTask.ownerId, ownerId)).orderBy(generationTask.id),
        stages: await database.db.select().from(generationVideoStage).where(eq(generationVideoStage.ownerId, ownerId)).orderBy(generationVideoStage.taskId),
        balances: await database.db.select().from(wallet).where(eq(wallet.userId, ownerId)),
        reservations: await database.db.select().from(walletReservation).where(eq(walletReservation.userId, ownerId)).orderBy(walletReservation.id),
        ledger: await database.db.select().from(walletLedger).where(eq(walletLedger.userId, ownerId)).orderBy(walletLedger.id),
        jobs: (await Promise.all(candidates.map(get))).filter(job => job !== null).map(job => ({ id: job!.id, data: job!.data, state: job!.state })).sort((a, b) => a.id.localeCompare(b.id)),
    });
    const transaction: RateTransactionRunner = work => database.db.transaction(tx => work({ query: query => videoQueueTransaction(tx).executeSql(query.text, query.values) }));
    const fill = async (selected = rulesByBucket, times = 1) => {
        for (let i = 0; i < times; i++) expect(await rates.consumeMany!(selected, transaction)).toEqual({ allowed: true });
    };
    const submit = async (admission = context(), queue = sender, db = database.db) => {
        if (capability === "video") {
            const priced = await resolveExecutableVideoQuote(db, input, ownerId, runtime);
            return quoteReserveAndEnqueueConfirmedVideoTask(db, queue, input, priced.priceVersion, priced.quoteFingerprint, runtime, { admission });
        }
        if (capability === "text") return quoteReserveAndEnqueueConfirmedTextTask(db, queue, input, 1, { admission });
        const priced = capability === "audio" ? await resolveExecutableAudioQuote(db, input, ownerId) : await resolveExecutableImageQuote(db, input, false, ownerId);
        return capability === "audio" ? quoteReserveAndEnqueueConfirmedAudioTask(db, queue, input, 1, priced.quoteFingerprint!, { admission })
            : quoteReserveAndEnqueueConfirmedImageTask(db, queue, input, 1, priced.quoteFingerprint!, { admission });
    };
    const events = () => database.db.select().from(contentSafetyEvent).where(eq(contentSafetyEvent.modelId, modelId)).orderBy(contentSafetyEvent.id);
    const close = async () => { for (const jobId of candidates) if (await get(jobId)) await boss.cancel(GENERATION_QUEUE_NAME, jobId); };
    return { input, quote, rates, rateSecret, context, sender, candidates, rulesByBucket, keys, ratePids, queuePids, get, state, fill, submit, events, close };
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
async function waitForLock(application: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const blocked = await database.pool.query({ text: "SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", values: [application] });
        if (blocked.rows.length) return blocked.rows[0];
        await Bun.sleep(10);
    }
    throw new Error("Expected the real PostgreSQL lock wait");
}

native.each(capabilities.map(value => [value] as const))("%s admission waiting on its user row rejects a revoked original session without monetary writes", async capability => {
    const f = await fixture(capability), application = `identity-wait-${crypto.randomUUID()}`;
    const target = new URL(url!); target.searchParams.set("application_name", application);
    const waiting = createDatabase(target.toString()), blocker = await database.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
        const before = await f.state();
        await blocker.query("BEGIN");
        await blocker.query('SELECT id FROM canvas_saas."user" WHERE id=$1 FOR UPDATE', [f.input.ownerId]);
        pending = f.submit(f.context(), f.sender, waiting.db).then(value => ({ accepted: value.created }), error => ({ status: error.status, code: error.code }));
        const blocked = await waitForLock(application);
        await database.db.delete(session).where(eq(session.id, f.context().sessionId));
        await blocker.query("ROLLBACK");
        expect(await pending).toEqual({ status: 409, code: "account_changed" });
        expect(await f.state()).toEqual(before); expect(f.candidates).toHaveLength(0);
        console.log(JSON.stringify({ scenario: "generation-identity-lock-wait", capability, blocked, outcome: "rejected-no-money-or-job" }));
    } finally {
        await blocker.query("ROLLBACK"); blocker.release(); await pending; await waiting.close(); await f.close();
    }
}, 30_000);

native.each(capabilities.map(value => [value] as const))("%s session revocation waits for the accepted monetary transaction and later replay is rejected", async capability => {
    const f = await fixture(capability), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const application = `identity-revoke-${crypto.randomUUID()}`, target = new URL(url!); target.searchParams.set("application_name", application);
    const revoker = createDatabase(target.toString());
    let submitted: ReturnType<typeof f.submit> | undefined, revoked: Promise<unknown> | undefined;
    try {
        const queue: GenerationQueueSender = { async send(name, payload, options) {
            const id = await f.sender.send(name, payload, options); entered.resolve(); await release.promise; return id;
        } };
        submitted = f.submit(f.context(), queue);
        await Promise.race([entered.promise, submitted.then(() => { throw new Error("Expected accepted transaction to pause at enqueue"); })]);
        revoked = revoker.pool.query({ text: "DELETE FROM canvas_saas.session WHERE id=$1 RETURNING id", values: [f.context().sessionId] });
        const blocked = await waitForLock(application);
        release.resolve();
        expect((await submitted).created).toBe(true);
        expect((await revoked as { rows: unknown[] }).rows).toHaveLength(1);
        const accepted = await f.state();
        expect(accepted.tasks).toHaveLength(1); expect(accepted.reservations).toHaveLength(1); expect(accepted.ledger).toHaveLength(1); expect(accepted.jobs).toHaveLength(1);
        expect(accepted.counters.map(row => row.points)).toEqual([1, 1, 1]);
        await expect(f.submit()).rejects.toMatchObject({ status: 409, code: "account_changed" });
        expect(await f.state()).toEqual(accepted); expect(f.candidates).toHaveLength(1);
        console.log(JSON.stringify({ scenario: "generation-identity-lock-held-through-commit", capability, blocked, outcome: "one-acceptance-then-replay-rejected" }));
    } finally { release.resolve(); await submitted; await revoked; await revoker.close(); await f.close(); }
}, 30_000);

async function fault(table: "content_safety_event" | "rate_limit", operation: "INSERT" | "UPDATE", key: string) {
    const name = `synthetic_d04_${crypto.randomUUID().replaceAll("-", "")}`;
    await database.db.execute(sql.raw(`CREATE FUNCTION canvas_saas.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic D04 admission fault'; END; $$`));
    try { await database.db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE ${operation} ON canvas_saas.${table} FOR EACH ROW WHEN (NEW.${table === "rate_limit" ? '"key"' : "model_id"} = ${literal(key)}) EXECUTE FUNCTION canvas_saas.${name}()`)); }
    catch (error) { await database.db.execute(sql.raw(`DROP FUNCTION canvas_saas.${name}()`)); throw error; }
    return async () => { await database.db.execute(sql.raw(`DROP TRIGGER ${name} ON canvas_saas.${table}`)); await database.db.execute(sql.raw(`DROP FUNCTION canvas_saas.${name}()`)); };
}

native.each(capabilities.map(value => [value] as const))("%s independent pools consume one original key once on the same backend as the real pg-boss enqueue", async capability => {
    const f = await fixture(capability), second = createDatabase(url!);
    try {
        const [firstPid, secondPid] = await Promise.all([database.pool.query({ text: "SELECT pg_backend_pid() AS pid" }), second.pool.query({ text: "SELECT pg_backend_pid() AS pid" })]);
        expect(firstPid.rows[0].pid).not.toBe(secondPid.rows[0].pid);
        const before = await f.state(); await f.quote(); expect(await f.state()).toEqual(before);
        const results = await Promise.all([f.submit(), f.submit(f.context(createRateStore(second.pool, f.rateSecret)), f.sender, second.db)]);
        expect(results.filter(result => result.created)).toHaveLength(1); expect(new Set(results.map(result => result.task.id)).size).toBe(1);
        const accepted = await f.state();
        expect(accepted.tasks).toHaveLength(1); expect(accepted.stages).toHaveLength(capability === "video" ? 1 : 0);
        expect(accepted.reservations).toHaveLength(1); expect(accepted.jobs).toHaveLength(1); expect(f.candidates).toHaveLength(1);
        expect(accepted.reservations[0]).toMatchObject({ requestedUnits: "7", capturedUnits: "0", releasedUnits: "0" });
        expect(accepted.ledger.map(row => row.kind)).toEqual(["reserve"]);
        expect(accepted.counters.map(row => row.points)).toEqual([1, 1, 1]); expect(f.ratePids).toHaveLength(1); expect(f.queuePids).toEqual(f.ratePids);
        await getGenerationTaskForOwner(database.db, { ownerId: f.input.ownerId, taskId: results[0]!.task.id }); await f.quote();
        expect((await f.submit()).created).toBe(false); expect(await f.state()).toEqual(accepted); expect(f.ratePids).toHaveLength(1);
        const metadata = await f.events(); expect([1, 2]).toContain(metadata.length);
        expect(JSON.stringify(metadata)).not.toMatch(/Synthetic prompt|Synthetic speech|198\.51\.100\.42|synthetic-provider-key/);
        f.input.inputSnapshot = capability === "audio" ? { text: "Different original intent" } : { prompt: "Different original intent" };
        await expect(f.submit()).rejects.toMatchObject({ code: "idempotency_conflict" }); expect(await f.state()).toEqual(accepted);
    } finally { await second.close(); await f.close(); }
}, 30_000);

native.each(capabilities.map(value => [value] as const))("%s full IP/user/model bucket rolls back every counter, task, funds and real job", async capability => {
    for (const dimension of ["generation-ip", "generation-user", "generation-model"]) {
        const f = await fixture(capability);
        try {
            await f.fill(f.rulesByBucket.filter(rule => rule.bucket === dimension), 3); const before = await f.state();
            await expect(f.submit()).rejects.toMatchObject({ status: 429, code: "rate_limited" });
            expect(await f.state()).toEqual(before); expect(f.candidates).toHaveLength(0);
        } finally { await f.close(); }
    }
}, 30_000);

native.each(capabilities.map(value => [value] as const))("%s record INSERT failure stays outside money and replay does not recount", async capability => {
    const f = await fixture(capability); let observed = 0, drop: (() => Promise<void>) | undefined;
    try {
        drop = await fault("content_safety_event", "INSERT", f.input.modelId);
        const admission = f.context(f.rates, () => { observed++; throw new Error("synthetic unavailable metadata sink"); });
        expect((await f.submit(admission)).created).toBe(true);
        const accepted = await f.state(); expect(accepted.counters.map(row => row.points)).toEqual([1, 1, 1]);
        expect(accepted.reservations).toHaveLength(1); expect(accepted.jobs).toHaveLength(1); expect(await f.events()).toHaveLength(0); expect(observed).toBe(1);
        expect((await f.submit(admission)).created).toBe(false); expect(await f.state()).toEqual(accepted); expect(observed).toBe(1);
    } finally { try { await drop?.(); } finally { await f.close(); } }
}, 30_000);

native.each(capabilities.map(value => [value] as const))("%s reserve, real enqueue ACK and final-bucket INSERT/UPDATE failures roll back the complete transaction", async capability => {
    for (const mode of ["reserve", "enqueue", "rate_insert", "rate_update"] as const) {
        const f = await fixture(capability); let drop: (() => Promise<void>) | undefined;
        try {
            if (mode === "reserve") await database.db.update(wallet).set({ availableUnits: "1" }).where(eq(wallet.userId, f.input.ownerId));
            if (mode === "rate_update") await f.fill();
            if (mode === "rate_insert" || mode === "rate_update") drop = await fault("rate_limit", mode === "rate_insert" ? "INSERT" : "UPDATE", f.keys[1]!);
            const before = await f.state();
            const ackFault: GenerationQueueSender = { async send(name, payload, options) {
                expect(await f.sender.send(name, payload, options)).toBeTruthy(); throw new Error("synthetic_after_real_boss_send");
            } };
            if (mode === "enqueue") await expect(f.submit(f.context(), ackFault)).rejects.toThrow("synthetic_after_real_boss_send");
            else await expect(f.submit()).rejects.toMatchObject(mode === "reserve" ? { code: "insufficient_balance" } : { status: 503, code: "service_unavailable" });
            expect(await f.state()).toEqual(before); expect(f.candidates).toHaveLength(mode === "enqueue" ? 1 : 0);
            for (const jobId of f.candidates) expect(await f.get(jobId)).toBeNull();
        } finally { try { await drop?.(); } finally { await f.close(); } }
    }
}, 30_000);

native.each(capabilities.map(value => [value] as const))("%s forged actor/request or missing trusted IP never enters funds or queue", async capability => {
    for (const mode of ["actorId", "requestId", "peerIp"] as const) {
        const f = await fixture(capability);
        try {
            const admission = f.context();
            if (mode === "peerIp") admission.peerIp = undefined; else admission[mode] = `forged-${crypto.randomUUID()}`;
            const before = await f.state();
            await expect(f.submit(admission)).rejects.toMatchObject(mode === "peerIp" ? { status: 503, code: "service_unavailable" } : { code: "invalid_input" });
            expect(await f.state()).toEqual(before); expect(f.ratePids).toHaveLength(0); expect(f.candidates).toHaveLength(0);
        } finally { await f.close(); }
    }
}, 30_000);
