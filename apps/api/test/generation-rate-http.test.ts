import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createAuth } from "@infinite-canvas/auth";
import { createJobQueue, GENERATION_QUEUE_NAME, isGenerationQueueReady, type GenerationJobPayload } from "@infinite-canvas/jobs";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { generationTask, generationVideoStage, modelCatalog, modelProvider, rateLimit, session, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { composeTextContextTierNote } from "../../../packages/shared/src/model-price-publications";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { createAccountApi } from "../src/accounts";
import { readContentSafetyConfig } from "../src/content-safety-config";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
import type { GenerationQueueSender } from "../src/generation-dispatch";
import { createTestDatabase, postgresTestUrl } from "./database";
import { generationRateTextRules } from "./generation-rate-fixtures";

const enabled = process.env.Q1_D04_POSTGRES === "1", native = enabled ? test : test.skip;
if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || (process.env.SAAS_TEST_DATABASE_URL && !enabled)) {
    throw new Error("D04 HTTP admission only accepts its explicit fresh native runner");
}
const url = enabled ? postgresTestUrl() : null;
if (enabled && !url) throw new Error("Fresh local PG16 target required");
const capabilities = ["image", "text", "audio", "video"] as const;
type Capability = typeof capabilities[number];
const origin = "http://localhost:4087", password = "synthetic-native-d04-http-password", secret = crypto.randomUUID() + crypto.randomUUID();
const mail = { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined };
let database: Awaited<ReturnType<typeof createTestDatabase>>, auth: ReturnType<typeof createAuth>, boss: ReturnType<typeof createJobQueue>;
let ipSequence = 0;
const parameters: VideoParameters = { mode: "text", resolution: "480p", durationSeconds: 1, aspectRatio: "16:9", generateAudio: false };
// Explicit test-only resources; no consumer, provider or tool is executed.
const videoPolicy: VideoRuntimePolicy = { createTimeoutMs: 100, inspectTimeoutMs: 100, downloadTimeoutMs: 100, jsonMaxBytes: 4096,
    pollIntervalMs: 100, claimLeaseMs: 2000, recoveryScanIntervalMs: 100, recoveryScanBatchSize: 10, observationWindowMs: 10000,
    maxInspectAttempts: 10, maxDownloadAttempts: 3, maxVideoBytes: 4096, maxPixels: 1000000, maxMediaDurationMs: 15000,
    referenceMaxBytes: 1024, referenceMaxPixels: 1000000, referenceContentTypes: ["image/png"], ffprobePath: "synthetic-not-executed", ffmpegPath: "synthetic-not-executed",
    probeTimeoutMs: 100, probeStdoutMaxBytes: 4096, probeStderrMaxBytes: 4096, probeMemoryMaxBytes: 1000000, probeCpuLimit: 100, probeTempRoot: "synthetic-not-created" };
beforeAll(async () => {
    if (!enabled) return;
    database = await createTestDatabase();
    const settings = await database.db.execute(sql`SELECT revision, active_version_id FROM canvas_saas.generation_rate_settings WHERE id='generation'`);
    expect((settings as unknown as { rows: unknown[] }).rows).toEqual([{ revision: 0, active_version_id: null }]);
    auth = createAuth({ ...mail, database: database.db, baseURL: origin });
    boss = createJobQueue(url!, error => { throw error; }); await boss.start();
    expect(isGenerationQueueReady(await boss.getQueue(GENERATION_QUEUE_NAME))).toBe(true);
}, 30_000);
afterAll(async () => { try { await boss?.stop(); } finally { await database?.close(); } });

async function fixture(capability: Capability) {
    const id = crypto.randomUUID(), modelId = `d04-http-${capability}-${id}`, providerId = crypto.randomUUID(), email = `d04-http-${id}@example.test`;
    const peerIp = `198.18.1.${++ipSequence}`;
    const loginRequest = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth/${path}`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await loginRequest("sign-up/email", { name: "Synthetic D04 HTTP", email, password })).status).toBe(200);
    const [owner] = await database.db.select().from(user).where(eq(user.email, email));
    const ownerId = owner!.id;
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, ownerId));
    const signedIn = await loginRequest("sign-in/email", { email, password }); expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    const binding = { providerId, providerModel: capability === "audio" ? "gpt-4o-mini-tts" : `synthetic-${capability}`,
        adapter: "openai-compatible" as const, endpoint: "https://synthetic-d04-http.invalid/v1", capability };
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic D04 HTTP", adapter: binding.adapter, endpoint: binding.endpoint, secretRef: "synthetic", enabled: true });
    await saveProviderCredential(database.db, secret, providerId, "synthetic-http-key");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: binding.providerModel, displayName: "Synthetic HTTP model", capability, enabled: true });
    const rules: ModelPriceDraftWrite["rules"] = capability === "text" ? await generationRateTextRules(database.db, modelId, binding) : {
        schemaVersion: 1, cost: null,
        ...(capability === "video" ? { video: { schemaVersion: 1 as const, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY } } : {}),
        sale: capability === "video" ? { template: "video_count", currency: "credit", bands: [{
            parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), rates: { video: "7" } }] }
            : { template: capability === "audio" ? "audio_request" : "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } };
    const audit = { actorId: ownerId, requestId: crypto.randomUUID() };
    const draft = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, rules, priceNote: "Synthetic D04 HTTP" }, audit);
    if (draft.status !== "saved") throw new Error(`Synthetic HTTP draft: ${draft.status}`);
    const publication = await publishModelPriceDraft(database.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: draft.draft.version,
        expectedPriceVersion: 0, binding, publicPriceNote: capability === "text" ? composeTextContextTierNote(rules, binding, "Synthetic HTTP")! : "Synthetic D04 HTTP" }, audit);
    if (publication.status !== "published") throw new Error(`Synthetic HTTP publication: ${publication.status}`);
    const candidates: string[] = [];
    const queue: GenerationQueueSender = { async send(name, payload, options) {
        expect(options?.db).toBeDefined(); const jobId = await boss.send(name, payload, options); if (jobId) candidates.push(jobId); return jobId;
    } };
    // IP=1 is an explicit synthetic override; the actual product default stays10.
    // User=50 and the fixed hour/24h periods retain their approved defaults.
    const contentSafety = readContentSafetyConfig({ SAAS_GENERATION_IP_RATE_POINTS: "1" });
    const rates = createRateStore(database.pool, secret);
    let pauseWrite: (() => Promise<void>) | undefined;
    const api = createAccountApi({ database: database.db, origin, auth: mail, rates: { ...rates, async consume(bucket, identity, rule) {
        const decision = await rates.consume(bucket, identity, rule);
        if (bucket === "canvas-save" && pauseWrite) { const pause = pauseWrite; pauseWrite = undefined; await pause(); }
        return decision;
    } }, contentSafety,
        verifyHuman: async () => true, onFault: () => undefined,
        media: { quotaBytes: 4096, maxBytes: { image: 4096, audio: 4096, video: 4096 }, storage: {
            async put() { throw new Error("No upload is expected in admission-only HTTP fixture"); },
            async get() { throw new Error("No reference read is expected in admission-only HTTP fixture"); },
            async delete() { throw new Error("No delete is expected in admission-only HTTP fixture"); },
        } }, generation: { enabled: true, imageEnabled: true, textEnabled: true, audioEnabled: true, videoEnabled: true, videoPolicy, queue } });
    const prefix = `/api/v1/generation${capability === "image" ? "" : `/${capability}`}`;
    const body = { modelId, input: capability === "audio" ? { text: "Synthetic speech" } : { prompt: "Synthetic HTTP prompt" },
        parameters: capability === "video" ? parameters : capability === "audio" ? { voice: "alloy", format: "mp3" } : {},
        ...(capability === "text" ? { budgetCredits: "7" } : {}) };
    function request(path: string, payload: unknown = body, key = crypto.randomUUID(), extra: Record<string, string> = {}, method = "POST") {
        return new Request(`${origin}${path}`, { method, headers: { origin, "content-type": "application/json", cookie,
            "x-canvas-account-id": ownerId, "idempotency-key": key, ...extra }, ...(method === "GET" ? {} : { body: JSON.stringify(payload) }) });
    }
    const quote = () => api(request(`${prefix}/quote`), peerIp);
    const get = (jobId: string) => boss.getJobById<GenerationJobPayload>(GENERATION_QUEUE_NAME, jobId);
    const keys = [`generation-ip:3600:${createHmac("sha256", secret).update(`canvas-rate\0${peerIp}`).digest("hex")}`,
        `generation-user:86400:${createHmac("sha256", secret).update(`canvas-rate\0${ownerId}`).digest("hex")}`];
    const state = async () => ({ counters: await database.db.select().from(rateLimit).where(inArray(rateLimit.key, keys)).orderBy(rateLimit.key),
        tasks: await database.db.select().from(generationTask).where(eq(generationTask.ownerId, ownerId)).orderBy(generationTask.id),
        stages: await database.db.select().from(generationVideoStage).where(eq(generationVideoStage.ownerId, ownerId)).orderBy(generationVideoStage.taskId),
        wallets: await database.db.select().from(wallet).where(eq(wallet.userId, ownerId)),
        reservations: await database.db.select().from(walletReservation).where(eq(walletReservation.userId, ownerId)).orderBy(walletReservation.id),
        ledger: await database.db.select().from(walletLedger).where(eq(walletLedger.userId, ownerId)).orderBy(walletLedger.id),
        jobs: (await Promise.all(candidates.map(get))).filter(job => job !== null).map(job => ({ id: job!.id, data: job!.data, state: job!.state })).sort((a, b) => a.id.localeCompare(b.id)) });
    const confirmed = async () => {
        const response = await quote(); expect(response.status).toBe(200); const priced = (await response.json()).quote;
        return { ...body, confirmedPriceVersion: priced.priceVersion,
            ...(capability === "text" ? {} : { confirmedQuoteFingerprint: priced.quoteFingerprint }) };
    };
    const close = async () => { for (const jobId of candidates) if (await get(jobId)) await boss.cancel(GENERATION_QUEUE_NAME, jobId); };
    return { ownerId, api, peerIp, prefix, request, quote, confirmed, state, candidates, close,
        pauseNextWrite: (pause: () => Promise<void>) => { pauseWrite = pause; } };
}

native.each(capabilities.map(value => [value] as const))("%s public quote/read/replay stay free and the next accepted key receives429 without money/queue changes", async capability => {
    const f = await fixture(capability);
    try {
        const initial = await f.state(), body = await f.confirmed(); expect(await f.state()).toEqual(initial);
        const key = crypto.randomUUID(), response = await f.api(f.request(`${f.prefix}/tasks`, body, key), f.peerIp);
        expect(response.status).toBe(201); const acceptedBody = await response.json(); expect(acceptedBody.created).toBe(true);
        expect(response.headers.get("x-canvas-account-id")).toBe(f.ownerId); expect(response.headers.get("cache-control")).toBe("private, no-store");
        const accepted = await f.state(); expect(accepted.counters.map(row => row.points)).toEqual([1, 1]);
        expect(accepted.reservations).toHaveLength(1); expect(accepted.ledger).toHaveLength(1); expect(accepted.jobs).toHaveLength(1);
        expect((await f.quote()).status).toBe(200);
        expect((await f.api(f.request(`/api/v1/generation/tasks/${acceptedBody.task.id}`, undefined, crypto.randomUUID(), {}, "GET"), f.peerIp)).status).toBe(200);
        const replay = await f.api(f.request(`${f.prefix}/tasks`, body, key), f.peerIp);
        expect(replay.status).toBe(200); expect((await replay.json()).created).toBe(false); expect(await f.state()).toEqual(accepted);
        const denied = await f.api(f.request(`${f.prefix}/tasks`, body), f.peerIp);
        expect(denied.status).toBe(429); expect((await denied.json()).error.code).toBe("rate_limited");
        expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0); expect(await f.state()).toEqual(accepted); expect(f.candidates).toHaveLength(1);
    } finally { await f.close(); }
}, 30_000);

native.each(capabilities.flatMap(capability => ["revoked", "expired", "disabled", "unverified", "moderation-version"].map(change => [capability, change] as const)))(
    "%s pending generation rejects %s identity changes before reserving or enqueueing", async (capability, change) => {
        const f = await fixture(capability), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        let pending: Promise<Response> | undefined;
        try {
            const body = await f.confirmed(), before = await f.state();
            f.pauseNextWrite(async () => { entered.resolve(); await release.promise; });
            pending = f.api(f.request(`${f.prefix}/tasks`, body), f.peerIp);
            await Promise.race([entered.promise, pending.then(() => { throw new Error("Expected the authenticated request to pause before dispatch"); })]);
            if (change === "revoked") await database.db.delete(session).where(eq(session.userId, f.ownerId));
            else if (change === "expired") await database.db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.userId, f.ownerId));
            else await database.db.update(user).set(change === "disabled" ? { disabled: true } : change === "unverified" ? { emailVerified: false } : { moderationVersion: 1 }).where(eq(user.id, f.ownerId));
            release.resolve();
            const response = await pending;
            const after = await f.state();
            console.log(JSON.stringify({ scenario: "pending-generation-identity-change", capability, change, status: response.status,
                tasksBefore: before.tasks.length, tasksAfter: after.tasks.length, reservationsAfter: after.reservations.length,
                ledgerAfter: after.ledger.length, queued: after.jobs.length, balances: after.wallets.map(row => ({ available: row.availableUnits, reserved: row.reservedUnits })) }));
            expect(response.status).toBe(409);
            expect((await response.json()).error.code).toBe("account_changed");
            expect(after).toEqual(before); expect(f.candidates).toHaveLength(0);
        } finally { release.resolve(); await pending; await f.close(); }
    }, 30_000);

native.each(capabilities.map(value => [value] as const))("%s public generation retains login/origin/account-context and trusted transport IP checks", async capability => {
    const f = await fixture(capability);
    try {
        const body = await f.confirmed(), before = await f.state(), path = `${f.prefix}/tasks`;
        expect((await f.api(f.request(path, body, crypto.randomUUID(), { cookie: "" }), f.peerIp)).status).toBe(401);
        expect((await f.api(f.request(path, body, crypto.randomUUID(), { origin: "https://outside.invalid" }), f.peerIp)).status).toBe(403);
        expect((await f.api(f.request(path, body, crypto.randomUUID(), { "x-canvas-account-id": "" }), f.peerIp)).status).toBe(400);
        expect((await f.api(f.request(path, body, crypto.randomUUID(), { "x-canvas-account-id": crypto.randomUUID() }), f.peerIp)).status).toBe(409);
        const missingIp = await f.api(f.request(path, body, crypto.randomUUID(), { "x-forwarded-for": f.peerIp }));
        expect(missingIp.status).toBe(503); expect((await missingIp.json()).error.code).toBe("service_unavailable");
        expect((await f.api(f.request("/api/v1/admin/content-safety/settings", undefined, crypto.randomUUID(), {}, "GET"), f.peerIp)).status).toBe(403);
        expect(await f.state()).toEqual(before); expect(f.candidates).toHaveLength(0);
    } finally { await f.close(); }
}, 30_000);

native.each(capabilities.map(value => [value] as const))("%s missing formal policy fails closed503 after a free quote and leaves no task, counter or job", async capability => {
    const f = await fixture(capability); let renamed = false;
    try {
        const body = await f.confirmed(), before = await f.state();
        await database.db.execute(sql`ALTER TABLE canvas_saas.generation_rate_settings RENAME TO synthetic_d04_http_missing_policy`); renamed = true;
        const response = await f.api(f.request(`${f.prefix}/tasks`, body), f.peerIp);
        expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("generation_admission_unavailable");
        expect(await f.state()).toEqual(before); expect(f.candidates).toHaveLength(0);
    } finally {
        try { if (renamed) await database.db.execute(sql`ALTER TABLE canvas_saas.synthetic_d04_http_missing_policy RENAME TO generation_rate_settings`); }
        finally { await f.close(); }
    }
}, 30_000);
