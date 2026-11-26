import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createAuth } from "@infinite-canvas/auth";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import * as schema from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage } from "@infinite-canvas/storage";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { createAccountApi } from "../src/accounts";
import { readContentSafetyConfig } from "../src/content-safety-config";
import { composeTextContextTierNote } from "../../../packages/shared/src/model-price-publications";
import { generationRateTextRules } from "./generation-rate-fixtures";
import type { VideoRuntimePolicy } from "../src/generation-video-config";

const origin = "http://localhost:4104", peerIp = "198.51.100.42", secret = `synthetic-launch-api-${crypto.randomUUID()}`;
const capabilities = ["image", "text", "audio", "video"] as const;
type Capability = typeof capabilities[number];
type Identity = { id: string; cookie: string };
let memory: PGlite, db: ReturnType<typeof drizzle<typeof schema>>, auth: ReturnType<typeof createAuth>, admin: Identity, other: Identity;
const mail = { secret, sendVerificationEmail: async () => {}, sendResetPassword: async () => {} };
const videoParameters: VideoParameters = { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" };
// All prices, balances, policy values and rate rules below are isolated fixtures, never production defaults.
const videoPolicy: VideoRuntimePolicy = { createTimeoutMs: 100, inspectTimeoutMs: 100, downloadTimeoutMs: 100, jsonMaxBytes: 4096,
    pollIntervalMs: 100, claimLeaseMs: 2000, recoveryScanIntervalMs: 100, recoveryScanBatchSize: 10,
    observationWindowMs: 10000, maxInspectAttempts: 10, maxDownloadAttempts: 3,
    maxVideoBytes: 4096, maxPixels: 1000000, maxMediaDurationMs: 15000, referenceMaxBytes: 1024, referenceMaxPixels: 1000000,
    referenceContentTypes: ["image/png"], ffprobePath: "C:/synthetic/ffprobe.exe", ffmpegPath: "C:/synthetic/ffmpeg.exe",
    probeTimeoutMs: 100, probeStdoutMaxBytes: 4096, probeStderrMaxBytes: 4096, probeMemoryMaxBytes: 1000000, probeCpuLimit: 100, probeTempRoot: "C:/synthetic/video" };

async function identity(role: "user" | "admin" = "user"): Promise<Identity> {
    const email = `launch-${crypto.randomUUID()}@example.test`, password = "synthetic-launch-password";
    const request = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth/${path}`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await request("sign-up/email", { name: "合成生成接线账号", email, password })).status).toBe(200);
    const [owner] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    await db.update(schema.user).set({ emailVerified: true, role }).where(eq(schema.user.id, owner!.id));
    const response = await request("sign-in/email", { email, password });
    expect(response.status).toBe(200);
    return { id: owner!.id, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}
beforeAll(async () => {
    // Always a fresh in-memory database; no env file, database URL, listener, worker or provider is used.
    memory = new PGlite(); db = drizzle(memory, { schema });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: "canvas_migrations" });
    auth = createAuth({ database: db as never, baseURL: origin, ...mail });
    admin = await identity("admin"); other = await identity();
}, 30_000);
afterAll(async () => { await memory?.close(); });

async function fixture(capability: Capability, denied = false) {
    const owner = await identity(), suffix = crypto.randomUUID(), modelId = `launch-${capability}-${suffix}`, providerId = `launch-provider-${suffix}`;
    const providerModel = capability === "audio" ? "gpt-4o-mini-tts" : `private-launch-${capability}`;
    const endpoint = "https://synthetic-launch-provider.example.test/v1", providerKey = `synthetic-launch-key-${suffix}`;
    await db.insert(schema.wallet).values({ userId: owner.id, availableUnits: "100" });
    await db.insert(schema.modelProvider).values({ id: providerId, displayName: "合成生成渠道", adapter: "openai-compatible", endpoint, secretRef: "synthetic", enabled: true });
    await saveProviderCredential(db as never, secret, providerId, providerKey);
    await db.insert(schema.modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel, displayName: `合成${capability}模型`, capability, enabled: true });
    const binding = { providerId, providerModel, adapter: "openai-compatible" as const, endpoint, capability };
    const rules: ModelPriceDraftWrite["rules"] = capability === "text" ? await generationRateTextRules(db as never, modelId, binding) : {
        schemaVersion: 1, cost: null,
        ...(capability === "video" ? { video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY } } : {}),
        sale: capability === "video" ? { template: "video_count", currency: "credit", bands: [{
            parameters: Object.fromEntries(Object.entries(videoParameters).map(([key, value]) => [key, String(value)])), rates: { video: "7" },
        }] } : { template: capability === "audio" ? "audio_request" : "image_request", currency: "credit", bands: [{
            parameters: capability === "image" ? { size: "1024x1024", quality: "low" } : {}, rates: { request: "7" },
        }] } };
    const draft = await createModelPriceDraft(db as never, { modelId, expectedVersion: 0, binding, priceNote: "private-launch-cost-note",
        rules },
    { actorId: admin.id, requestId: crypto.randomUUID() });
    if (draft.status !== "saved") throw new Error("synthetic_launch_draft_failed");
    const publication = await publishModelPriceDraft(db as never, { modelId, draftId: draft.draft.id, expectedDraftVersion: 1,
        expectedPriceVersion: 0, binding, publicPriceNote: capability === "text"
            ? composeTextContextTierNote(rules, binding, "合成开发价，非正式报价")! : "合成开发价，非正式报价" }, { actorId: admin.id, requestId: crypto.randomUUID() });
    if (publication.status !== "published") throw new Error("synthetic_launch_publication_failed");
    const parameters = capability === "video" ? { ...videoParameters } : capability === "audio" ? { voice: "alloy", format: "mp3" }
        : capability === "image" ? { size: "1024x1024", quality: "low" } : {};
    const intent = { modelId, input: capability === "audio" ? { text: "Synthetic launch speech must not enter safety events" }
        : { prompt: "Synthetic launch prompt must not enter safety events" }, parameters, ...(capability === "text" ? { budgetCredits: "0.01" } : {}) };
    const calls: Array<Array<{ bucket: string; identity: string }>> = [], jobs: unknown[] = [], faults: string[] = [];
    const expectedBatch = [{ bucket: "generation-ip", identity: peerIp }, { bucket: "generation-user", identity: owner.id },
        { bucket: "generation-model", identity: modelId }];
    const state = async () => ({ tasks: await db.select().from(schema.generationTask).where(eq(schema.generationTask.ownerId, owner.id)),
        wallets: await db.select().from(schema.wallet).where(eq(schema.wallet.userId, owner.id)),
        reservations: await db.select().from(schema.walletReservation).where(eq(schema.walletReservation.userId, owner.id)),
        ledger: await db.select().from(schema.walletLedger).where(eq(schema.walletLedger.userId, owner.id)), jobs: jobs.length });
    const events = () => db.select().from(schema.contentSafetyEvent).where(eq(schema.contentSafetyEvent.modelId, modelId));
    const options: Parameters<typeof createAccountApi>[0] = { database: db as never, origin, auth: mail, verifyHuman: async () => true,
        media: { storage: createMemoryObjectStorage(), quotaBytes: 1_000_000, maxBytes: { image: 4096, audio: 4096, video: 4096 } },
        generation: { enabled: true, imageEnabled: true, textEnabled: true, audioEnabled: true, videoEnabled: true, videoPolicy,
            queue: { async send(_name, payload, enqueueOptions) { expect(enqueueOptions?.db).toBeDefined(); jobs.push(structuredClone(payload)); return crypto.randomUUID(); } } },
        contentSafety: readContentSafetyConfig({ SAAS_GENERATION_IP_RATE_POINTS: "1", SAAS_GENERATION_IP_RATE_DURATION_SECONDS: "60",
            SAAS_GENERATION_MODEL_RATES: JSON.stringify([{ modelId, points: 1, duration: 60 }]) }),
        rates: { async consume(bucket) {
            expect(bucket.startsWith("generation-")).toBe(false);
            return { allowed: true };
        }, async consumeMany(entries, transaction) {
            // A decision seam only; native PostgreSQL suites prove counter concurrency.
            expect(transaction).toBeDefined();
            expect(entries).toEqual(expectedBatch.map((entry, index) => ({ ...entry,
                rule: index === 1 ? { points: 50, duration: 86400 } : { points: 1, duration: 60 } })));
            calls.push(entries.map(({ bucket, identity }) => ({ bucket, identity })));
            expect(jobs).toHaveLength(0);
            return denied ? { allowed: false, retryAfter: 17 } : { allowed: true };
        } }, onFault: event => { faults.push(event.code); } };
    const api = createAccountApi(options), base = `/api/v1/generation${capability === "image" ? "" : `/${capability}`}`;
    function request(path: string, body?: unknown, key = crypto.randomUUID(), handler = api, account = owner, extra: Record<string, string> = {}) {
        return handler(new Request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
            origin, cookie: account.cookie, "x-canvas-account-id": account.id, "content-type": "application/json", "idempotency-key": key, ...extra,
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), peerIp);
    }
    const publicOnly = (value: unknown) => {
        const raw = JSON.stringify(value);
        for (const privateValue of [providerId, providerKey, providerModel, endpoint, "private-launch-cost-note", "C:/synthetic/"]) expect(raw).not.toContain(privateValue);
    };
    return { owner, modelId, capability, intent, calls, expectedBatch, jobs, faults, options, api, base, request, state, events, publicOnly };
}

test.each(capabilities)("%s API resolves confirmed intent before transactional admission and does not recount quotes or same-key replay", async capability => {
    const run = await fixture(capability), before = await run.state(), key = crypto.randomUUID();
    const catalog = await run.request(`${run.base}/models`); expect(catalog.status).toBe(200);
    const catalogBody = await catalog.json(); expect(catalogBody.items.find((row: { id: string }) => row.id === run.modelId)).toBeDefined(); run.publicOnly(catalogBody);
    const response = await run.request(`${run.base}/quote`, run.intent); expect(response.status).toBe(200);
    const quoted = await response.json(); expect(quoted.quote.priceVersion).toBe(1); run.publicOnly(quoted);
    expect(run.calls).toHaveLength(0); expect(await run.events()).toHaveLength(0); expect(await run.state()).toEqual(before);
    const version = { ...run.intent, confirmedPriceVersion: quoted.quote.priceVersion };
    const confirmed = capability === "text" ? version : { ...version, confirmedQuoteFingerprint: quoted.quote.quoteFingerprint };
    if (capability !== "text") expect(quoted.quote.quoteFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await run.request(`${run.base}/tasks`, run.intent, key)).status).toBe(400);
    expect((await run.request(`${run.base}/tasks`, { ...confirmed, confirmedPriceVersion: 2 }, key)).status).toBe(409);
    if (capability !== "text") {
        expect((await run.request(`${run.base}/tasks`, version, key)).status).toBe(capability === "image" ? 409 : 400);
        expect((await run.request(`${run.base}/tasks`, { ...confirmed, confirmedQuoteFingerprint: "0".repeat(64) }, key)).status).toBe(409);
    }
    expect(run.calls).toHaveLength(0); expect(await run.events()).toHaveLength(0); expect(await run.state()).toEqual(before);
    const accepted = await run.request(`${run.base}/tasks`, confirmed, key); expect(accepted.status).toBe(201);
    const body = await accepted.json(); expect(body).toMatchObject({ created: true, task: { modelId: run.modelId, billingStatus: "reserved", executionStatus: "queued" } });
    expect(run.calls).toEqual([run.expectedBatch]);
    const recorded = await run.events(); expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ actorId: run.owner.id, modelId: run.modelId, capability, requestId: body.requestId, phase: "pre_generation", mode: "record" });
    expect(JSON.stringify(recorded)).not.toMatch(/Synthetic launch prompt|Synthetic launch speech|198\.51\.100\.42|synthetic-launch-key/);
    run.publicOnly(body);
    for (const field of ["ownerId", "providerTaskId", "reservationId", "idempotencyKey", "inputSnapshot", "parameterSnapshot"]) expect(body.task).not.toHaveProperty(field);
    const committed = await run.state(); expect(committed.tasks).toHaveLength(1); expect(committed.reservations).toHaveLength(1); expect(committed.ledger).toHaveLength(1); expect(run.jobs).toHaveLength(1);
    const replay = await run.request(`${run.base}/tasks`, confirmed, key); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ created: false, task: { id: body.task.id } });
    expect((await run.request(`/api/v1/generation/tasks/${body.task.id}`)).status).toBe(200);
    expect((await run.request(`${run.base}/quote`, run.intent)).status).toBe(200);
    expect(run.calls).toHaveLength(1); expect(await run.events()).toEqual(recorded); expect(await run.state()).toEqual(committed); expect(run.faults).toEqual([]);
    if (capability === "video") {
        expect(body.task.video).toMatchObject({ parameters: videoParameters, phase: "ready", reservedCredits: 7 });
        expect((await run.request(`/api/v1/generation/tasks/${body.task.id}`, undefined, crypto.randomUUID(), run.api, other)).status).toBe(404);
    }
}, 30_000);

test.each(capabilities)("%s actual API 429 leaves no task, reservation, wallet ledger or queue mutation", async capability => {
    const run = await fixture(capability, true), before = await run.state();
    const quote = await run.request(`${run.base}/quote`, run.intent); expect(quote.status).toBe(200);
    const quoted = await quote.json(), version = { ...run.intent, confirmedPriceVersion: quoted.quote.priceVersion };
    const confirmed = capability === "text" ? version : { ...version, confirmedQuoteFingerprint: quoted.quote.quoteFingerprint };
    const response = await run.request(`${run.base}/tasks`, confirmed);
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("17"); expect((await response.json()).error.code).toBe("rate_limited");
    expect(run.calls).toEqual([run.expectedBatch]);
    expect(await run.state()).toEqual(before); expect(run.jobs).toHaveLength(0);
    expect(await run.events()).toHaveLength(1); // record mode is metadata, not a monetary acceptance.
});

test("video API stays closed without its explicit flag, policy or private media seam", async () => {
    const run = await fixture("video"), before = await run.state();
    for (const change of [{ generation: { ...run.options.generation!, videoEnabled: undefined } },
        { generation: { ...run.options.generation!, videoPolicy: undefined } }, { media: undefined }]) {
        const closed = createAccountApi({ ...run.options, ...change });
        expect((await run.request(`${run.base}/models`, undefined, crypto.randomUUID(), closed)).status).toBe(503);
        expect((await run.request(`${run.base}/quote`, run.intent, crypto.randomUUID(), closed)).status).toBe(503);
        expect((await run.request(`${run.base}/tasks`, { ...run.intent, confirmedPriceVersion: 1, confirmedQuoteFingerprint: "0".repeat(64) }, crypto.randomUUID(), closed)).status).toBe(503);
    }
    expect(run.calls).toHaveLength(0); expect(await run.events()).toHaveLength(0); expect(await run.state()).toEqual(before);
});
