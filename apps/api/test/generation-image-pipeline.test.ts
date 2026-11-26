import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generationPng64x48 as pngBase64 } from "./fixtures/generation-png";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { user, wallet } from "@infinite-canvas/database/schema";
import { eq } from "drizzle-orm";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createMemoryObjectStorage, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createGenerationDelivery } from "../src/generation-delivery";
import { quoteReserveAndEnqueueServerGenerationTask } from "../src/generation-dispatch";
import { createGenerationProvider } from "../src/generation-provider";
import { getGenerationTaskForOwner } from "../src/generation-query";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { createProviderGateway, type ProviderCallResult, type ProviderRequest } from "../src/provider-gateway";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";

const png = new Uint8Array(Buffer.from(pngBase64, "base64"));
const maxBytes = { image: png.byteLength, video: png.byteLength, audio: png.byteLength };
const quotaBytes = png.byteLength * 4;
const modelId = "image-pipeline";
const creditsPerRequest = 7;
const origin = "http://localhost:4000";
const authSecret = "synthetic-image-pipeline-" + crypto.randomUUID();
const credential = "synthetic-image-provider-key";
const success: ProviderCallResult = {
    status: "succeeded", upstreamStatus: 200,
    payload: { data: [{ b64_json: pngBase64 }], providerUrl: "https://provider.invalid/private", authorization: credential },
};
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let alice: { id: string; cookie: string };
let bob: { id: string; cookie: string };
let admin: { id: string; cookie: string };
let httpQueueSends = 0;
const httpStorage = createMemoryObjectStorage();
const mails: Array<{ to: string; url: string }> = [];

// Exercise actual Request/Response auth and media handlers without a listener or fetch.
function request(path: string, identity?: { id: string; cookie: string }, body?: object, peer = "198.51.100.81") {
    return app(new Request(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
            origin, "content-type": "application/json", "x-captcha-response": "synthetic-pass",
            ...(identity ? { cookie: identity.cookie, "x-canvas-account-id": identity.id } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), peer);
}

async function register(name: string, peer: string) {
    const email = `${name.toLowerCase().replace(/\s/g, "-")}-${crypto.randomUUID()}@example.test`, password = "synthetic-image-pipeline-password";
    const signup = await request("/api/auth/sign-up/email", undefined, { name, email, password }, peer);
    expect(signup.status).toBe(200);
    const verification = mails.find((mail) => mail.to === email);
    expect(verification).toBeDefined();
    expect((await request(verification!.url, undefined, undefined, peer)).status).toBe(302);
    const login = await request("/api/auth/sign-in/email", undefined, { email, password }, peer);
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const session = await request("/api/v1/session", { id: "", cookie }, undefined, peer);
    expect(session.status).toBe(200);
    return { id: (await session.json()).user.id as string, cookie };
}

beforeAll(async () => {
    if (process.env.SAAS_TEST_DATABASE_URL) throw new Error("Image pipeline tests require in-memory PGlite only");
    database = await createTestDatabase();
    await seedGenerationPricing(database.db, [{ modelId, capability: "image", version: 1, billingUnit: "request", creditsPerUnit: creditsPerRequest }]);
    await saveProviderCredential(database.db, authSecret, "generation-test-provider", credential);
    app = createApp(createAccountApi({
        database: database.db, origin,
        auth: { secret: authSecret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
        rates: createRateStore(database.pool, authSecret),
        verifyHuman: async (input) => input.headers.get("x-captcha-response") === "synthetic-pass",
        media: { storage: httpStorage, quotaBytes, maxBytes },
        generation: { enabled: true, queue: { async send() { httpQueueSends++; throw new Error("Readback must not enqueue a task"); } } },
        onFault: () => {},
    }), "synthetic-site-key", false, true);
    alice = await register("Image Alice", "198.51.100.81");
    bob = await register("Image Bob", "198.51.100.82");
    admin = await register("Image Admin", "198.51.100.83");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
});

afterAll(async () => { await database?.close(); });

async function scenario(options: { response?: ProviderCallResult; httpStatus?: number; storage?: ObjectStorage; quota?: number; ownerId?: string } = {}) {
    const ownerId = options.ownerId ?? crypto.randomUUID();
    if (!options.ownerId) await database.db.insert(user).values({ id: ownerId, name: "Image pipeline", email: `${ownerId}@example.test` });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "20" });
    const dispatched = await quoteReserveAndEnqueueServerGenerationTask(database.db, { async send() { return crypto.randomUUID(); } }, {
        ownerId, modelId, inputSnapshot: { prompt: "synthetic four-colour image" }, parameterSnapshot: {},
        idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(),
    });
    const wallets = createWalletRepository(database.db);
    expect(dispatched.task).toMatchObject({ executionStatus: "queued", billingStatus: "reserved", billingUnitSnapshot: "request", creditsPerUnitSnapshot: creditsPerRequest, quotedUnits: creditsPerRequest });
    expect(dispatched.reservation.requestedUnits).toBe(String(creditsPerRequest));
    expect(await wallets.get(ownerId)).toMatchObject({ availableUnits: String(20 - creditsPerRequest), reservedUnits: String(creditsPerRequest) });
    const observed: ProviderRequest[] = [];
    const gateway = options.httpStatus === undefined ? null : createProviderGateway(
        async () => new Response(null, { status: options.httpStatus }), async () => ["93.184.216.34"]);
    const provider = createGenerationProvider({
        database: database.db, authSecret, imageMaxBytes: maxBytes.image,
        gateway: { async request(input) { observed.push(input); return gateway ? gateway.request(input) : options.response ?? success; } },
    });
    const storage = options.storage ?? createMemoryObjectStorage();
    const limit = options.quota ?? quotaBytes;
    const dependencies = {
        provider,
        deliver: createGenerationDelivery({ database: database.db, storage, quotaBytes: limit, maxBytes }),
        settleBilling: createGenerationWalletSettlement(database.db),
    };
    const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
    const key = objectKey(`accounts/${Buffer.from(ownerId).toString("base64url")}/media/${dispatched.task.id}`);
    return { ownerId, dispatched, payload, key, provider, dependencies, observed, storage, limit, wallets };
}

describe("isolated image provider, delivery and wallet pipeline", () => {
    test("delivers owned PNG bytes, exposes only a media reference, and replays without another charge or provider call", async () => {
        const run = await scenario({ ownerId: alice.id, storage: httpStorage });
        const first = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
        expect(run.observed).toHaveLength(1);
        expect(run.observed[0]).toMatchObject({ path: "images/generations", target: { providerModel: `provider-${modelId}`, credential }, body: { model: `provider-${modelId}`, n: 1 } });
        const media = createMediaRepository(database.db);
        const row = await media.get(alice.id, run.payload.taskId);
        expect(row).toMatchObject({ ownerId: alice.id, objectKey: run.key, kind: "image", contentType: "image/png", sizeBytes: png.byteLength });
        expect((await run.storage.get(run.key))?.body).toEqual(png);
        expect(await media.get(bob.id, run.payload.taskId)).toBeNull();
        const view = await getGenerationTaskForOwner(database.db, { ownerId: alice.id, taskId: run.payload.taskId });
        expect(view.result?.resultSnapshot).toEqual({ kind: "image", media: {
            mediaId: row!.id, kind: "image", contentType: "image/png", sizeBytes: png.byteLength, etag: row!.etag,
        } });
        for (const hidden of [pngBase64, credential, "provider.invalid", "base64", "objectKey"]) expect(JSON.stringify(view)).not.toContain(hidden);
        await expect(getGenerationTaskForOwner(database.db, { ownerId: bob.id, taskId: run.payload.taskId })).rejects.toMatchObject({ code: "not_found" });
        const ownRead = await request(`/api/v1/media/${row!.id}`, alice);
        expect(ownRead.status).toBe(200);
        expect(ownRead.headers.get("content-type")).toBe("image/png");
        expect(ownRead.headers.get("cache-control")).toBe("private, no-store");
        expect(new Uint8Array(await ownRead.arrayBuffer())).toEqual(png);
        expect((await request(`/api/v1/media/${row!.id}`, bob)).status).toBe(404);

        const beforeReplay = { wallet: await run.wallets.get(alice.id), quota: await media.getQuota(alice.id, quotaBytes), ledger: await run.wallets.listLedger(alice.id) };
        const logs = "/api/v1/generation/logs?type=image";
        const history = await request(logs, alice);
        expect(history.status).toBe(200);
        expect((await history.json()).items).toContainEqual(expect.objectContaining({ taskId: run.payload.taskId,
            executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured", credits: String(creditsPerRequest),
            result: { url: `/api/v1/media/${row!.id}` },
        }));
        const otherHistory = await request(logs, bob);
        expect(otherHistory.status).toBe(200);
        expect((await otherHistory.json()).items).toEqual([]);
        const readbackPath = `/api/v1/admin/generation/tasks/${run.payload.taskId}`;
        expect((await request(readbackPath, alice)).status).toBe(403);
        const review = await request(readbackPath, admin, undefined, "198.51.100.83");
        expect(review.status).toBe(200);
        const { detail } = await review.json();
        expect(detail).toMatchObject({
            task: { id: run.payload.taskId, ownerId: alice.id, quotedUnits: creditsPerRequest,
                executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" },
            result: { status: "succeeded", consumedUnits: 1 },
            reservation: { linkStatus: "linked", details: { capturedUnits: String(creditsPerRequest), remainingUnits: "0", releasedUnits: "0" } },
        });
        expect(detail.ledger.filter((entry: { kind: string }) => entry.kind === "capture")).toMatchObject([
            { deltaAvailableUnits: "0", deltaReservedUnits: String(-creditsPerRequest) },
        ]);
        for (const privateValue of [pngBase64, credential, "provider.invalid", run.key, "synthetic four-colour image"]) {
            expect(JSON.stringify(detail)).not.toContain(privateValue);
        }
        expect(httpQueueSends).toBe(0);
        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { deliveryStatus: "visible", billingStatus: "captured" } });
        expect(run.observed).toHaveLength(1);
        expect(await run.wallets.get(alice.id)).toEqual(beforeReplay.wallet);
        expect(await media.getQuota(alice.id, quotaBytes)).toEqual(beforeReplay.quota);
        expect(await run.wallets.listLedger(alice.id)).toEqual(beforeReplay.ledger);
        expect(beforeReplay.wallet).toMatchObject({ availableUnits: String(20 - creditsPerRequest), reservedUnits: "0" });
        expect(await run.wallets.getReservation(alice.id, run.dispatched.reservation.id)).toMatchObject({ status: "captured", capturedUnits: String(creditsPerRequest), releasedUnits: "0" });
        expect(beforeReplay.quota.usedBytes).toBe(png.byteLength);
        expect(beforeReplay.ledger.filter((item) => item.kind === "capture")).toHaveLength(1);
        expect(await media.list(alice.id)).toHaveLength(1);
    });

    test("recovers a committed normalized image after interruption before delivery without calling the provider again", async () => {
        const run = await scenario();
        const running = await createGenerationTaskRepository(database.db).claimRunning({ ownerId: run.ownerId, taskId: run.payload.taskId });
        expect(running).not.toBeNull();
        const normalized = await run.provider(running!);
        if (normalized.status !== "succeeded") throw new Error("Synthetic PNG did not normalize");
        await createGenerationResultRepository(database.db).create({ taskId: run.payload.taskId, ownerId: run.ownerId, ...normalized });
        expect(await run.storage.get(run.key)).toBeNull();
        // Stop at the actual durable boundary: the task is still running, with
        // a saved provider result and no delivery or wallet settlement yet.
        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" } });
        expect(run.observed).toHaveLength(1);
        expect((await run.storage.get(run.key))?.body).toEqual(png);
        expect(await run.wallets.getReservation(run.ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "captured", capturedUnits: String(creditsPerRequest), releasedUnits: "0" });
        expect(await createMediaRepository(database.db).getQuota(run.ownerId, quotaBytes)).toMatchObject({ usedBytes: png.byteLength });
    });

    test("does not charge for corrupted stored bytes when replay resumes after the media row committed", async () => {
        const run = await scenario();
        const running = await createGenerationTaskRepository(database.db).claimRunning({ ownerId: run.ownerId, taskId: run.payload.taskId });
        expect(running).not.toBeNull();
        const normalized = await run.provider(running!);
        if (normalized.status !== "succeeded") throw new Error("Synthetic PNG did not normalize");
        const stored = await createGenerationResultRepository(database.db).create({ taskId: run.payload.taskId, ownerId: run.ownerId, ...normalized });
        expect(await run.dependencies.deliver({ task: running!, result: stored.result })).toMatchObject({ status: "visible" });
        const media = createMediaRepository(database.db);
        const row = await media.get(run.ownerId, run.payload.taskId);
        expect(row).not.toBeNull();
        // The media bytes and row committed, but task delivery and billing did
        // not. Simulate same-length corruption with the old metadata intact.
        const originalGet = run.storage.get;
        run.storage.get = async (key) => {
            const object = await originalGet(key);
            if (object && key === run.key) object.body[0] ^= 1;
            return object;
        };
        const corrupted = await run.storage.get(run.key);
        expect(corrupted?.body.byteLength).toBe(png.byteLength);
        expect(corrupted?.metadata).toMatchObject({ sizeBytes: row!.sizeBytes, etag: row!.etag, contentType: row!.contentType });
        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { executionStatus: "succeeded", deliveryStatus: "unknown", billingStatus: "pending_review" } });
        expect(replay.delivery).toMatchObject({ status: "unknown", unknownReason: "delivery_media_integrity_unknown" });
        expect(run.observed).toHaveLength(1);
        expect(await run.wallets.getReservation(run.ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
        expect(await run.wallets.get(run.ownerId)).toMatchObject({ availableUnits: String(20 - creditsPerRequest), reservedUnits: String(creditsPerRequest) });
        expect((await run.wallets.listLedger(run.ownerId)).filter((entry) => entry.kind === "capture")).toHaveLength(0);
        expect(await media.get(run.ownerId, run.payload.taskId)).toEqual(row);
        expect(await media.getQuota(run.ownerId, quotaBytes)).toMatchObject({ usedBytes: png.byteLength });
        expect((await getGenerationTaskForOwner(database.db, { ownerId: run.ownerId, taskId: run.payload.taskId })).result?.resultSnapshot).not.toHaveProperty("media");
    });

    test("releases the reservation on explicit provider rejection and never creates media", async () => {
        const run = await scenario({ response: { status: "failed", code: "provider_rejected" } });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released" });
        expect(await run.wallets.getReservation(run.ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "released", capturedUnits: "0", releasedUnits: String(creditsPerRequest) });
        expect(await run.wallets.get(run.ownerId)).toMatchObject({ availableUnits: "20", reservedUnits: "0" });
        expect(await createMediaRepository(database.db).get(run.ownerId, run.payload.taskId)).toBeNull();
        expect(await run.storage.get(run.key)).toBeNull();
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(run.observed).toHaveLength(1);
    });

    test("a previously visible legacy PNG header cannot capture an unsettled reservation on replay", async () => {
        const run = await scenario();
        const tasks = createGenerationTaskRepository(database.db), results = createGenerationResultRepository(database.db);
        const media = createMediaRepository(database.db), { ownerId, taskId } = run.payload;
        const body = png.subarray(0, 8);
        const stored = await run.storage.put({ key: run.key, body, contentType: "image/png" });
        await media.add(ownerId, { id: taskId, kind: "image", objectKey: stored.key, contentType: stored.contentType,
            sizeBytes: stored.sizeBytes, etag: stored.etag });
        await tasks.claimRunning({ ownerId, taskId });
        await results.create({ ownerId, taskId, status: "succeeded", consumedUnits: 1,
            resultSnapshot: { kind: "image", image: { contentType: "image/png", base64: Buffer.from(body).toString("base64") } } });
        await results.attachMedia({ ownerId, taskId, media: { mediaId: taskId, kind: "image", contentType: stored.contentType,
            sizeBytes: stored.sizeBytes, etag: stored.etag } });
        await tasks.transitionExecution({ ownerId, taskId, status: "succeeded" });
        await tasks.transitionDelivery({ ownerId, taskId, status: "saved" });
        await tasks.transitionDelivery({ ownerId, taskId, status: "visible" });

        const replay = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(replay).toMatchObject({ replay: true, task: { deliveryStatus: "visible", billingStatus: "pending_review" },
            delivery: { status: "unknown", unknownReason: "provider_image_invalid_response" } });
        expect(await run.wallets.getReservation(ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
        expect((await run.wallets.listLedger(ownerId)).map(row => row.kind)).toEqual(["reserve"]);
        expect(run.observed).toHaveLength(0);
    });

    test.each([408, 409])("keeps the legacy reservation after upstream HTTP %i and does not resend", async httpStatus => {
        const run = await scenario({ httpStatus });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
        expect(result.result.unknownReason).toBe("provider_response_unknown");
        expect(await run.wallets.getReservation(run.ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
        expect((await run.wallets.listLedger(run.ownerId)).filter(entry => entry.referenceId === run.payload.taskId).map(entry => entry.kind)).toEqual(["reserve"]);
        expect(await createMediaRepository(database.db).get(run.ownerId, run.payload.taskId)).toBeNull();
        await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(run.observed).toHaveLength(1);
    });

    test("keeps timeout and invalid successful image responses unknown without retrying or releasing credits", async () => {
        const corrupt = Buffer.from(png);
        corrupt[corrupt.length - 1] ^= 1;
        const responses: ProviderCallResult[] = [
            { status: "unknown", code: "provider_timeout", retryable: false },
            { status: "succeeded", upstreamStatus: 200, payload: { data: [{ b64_json: "bm90IGFuIGltYWdl" }] } },
            ...[png.subarray(0, 8), corrupt].map(body => ({ status: "succeeded" as const, upstreamStatus: 200,
                payload: { data: [{ b64_json: Buffer.from(body).toString("base64") }] } })),
        ];
        for (const response of responses) {
            const run = await scenario({ response });
            const result = await processGenerationJob(database.db, run.payload, run.dependencies);
            expect(result.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
            expect(await run.wallets.getReservation(run.ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
            expect(await run.wallets.get(run.ownerId)).toMatchObject({ availableUnits: String(20 - creditsPerRequest), reservedUnits: String(creditsPerRequest) });
            expect(await createMediaRepository(database.db).get(run.ownerId, run.payload.taskId)).toBeNull();
            expect(await run.storage.get(run.key)).toBeNull();
            await processGenerationJob(database.db, run.payload, run.dependencies);
            expect(run.observed).toHaveLength(1);
        }
    });

    test("keeps a successful provider result pending review when private storage fails", async () => {
        const storage = createMemoryObjectStorage();
        const run = await scenario({ storage: { ...storage, async put() { throw new Error("synthetic storage failure"); } } });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "unknown", billingStatus: "pending_review" });
        expect(result.delivery).toMatchObject({ status: "unknown", unknownReason: "delivery_persistence_unknown" });
        expect(await run.wallets.getReservation(run.ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
        expect(await createMediaRepository(database.db).get(run.ownerId, run.payload.taskId)).toBeNull();
        expect(await createMediaRepository(database.db).getQuota(run.ownerId, quotaBytes)).toMatchObject({ usedBytes: 0 });
        expect(await storage.get(run.key)).toBeNull();
        expect(run.observed).toHaveLength(1);
    });

    test("cleans up an over-quota image without marking it visible or capturing its reservation", async () => {
        const run = await scenario({ quota: png.byteLength - 1 });
        const result = await processGenerationJob(database.db, run.payload, run.dependencies);
        expect(result.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "failed", billingStatus: "pending_review" });
        expect(result.delivery).toMatchObject({ status: "failed", errorCode: "delivery_quota_exceeded" });
        expect(await run.wallets.getReservation(run.ownerId, run.dispatched.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
        expect(await createMediaRepository(database.db).get(run.ownerId, run.payload.taskId)).toBeNull();
        expect(await createMediaRepository(database.db).getQuota(run.ownerId, run.limit)).toMatchObject({ usedBytes: 0, availableBytes: run.limit });
        expect(await run.storage.get(run.key)).toBeNull();
        expect(run.observed).toHaveLength(1);
    });
});
