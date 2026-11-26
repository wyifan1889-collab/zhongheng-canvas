import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { generationTask, modelCatalog, modelNodeGroups, modelPricing, modelProvider, modelProviderCredential, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";

const origin = "http://localhost:4000";
const password = "generation-http-test-password";
const secret = "generation-api-test-" + crypto.randomUUID() + crypto.randomUUID();
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let disabledApp: ReturnType<typeof createApp>;
let aliceCookie = "";
let aliceId = "";
let bobCookie = "";
let bobId = "";
let queueSends = 0;
const mails: Array<{ to: string; url: string }> = [];
const imageGroup = { id: "11111111-1111-4111-8111-111111111111", name: "Synthetic images" };

function cookies(response: Response) {
    return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function request(path: string, body: unknown | undefined, cookie: string, accountId: string, headers: Record<string, string> = {}) {
    return app(new Request(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            origin,
            cookie,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(accountId ? { "x-canvas-account-id": accountId } : {}),
            ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.20");
}

async function registerAndLogin(name: string, email: string) {
    const signup = await request("/api/auth/sign-up/email", { name, email, password }, "", "", { "x-captcha-response": "test-pass" });
    expect(signup.status).toBe(200);
    const mail = mails.find((item) => item.to === email);
    expect(mail?.url).toBeTruthy();
    const verified = await app(new Request(mail!.url), "198.51.100.20");
    expect(verified.status).toBe(302);
    const login = await request("/api/auth/sign-in/email", { email, password }, "", "", { "x-captcha-response": "test-pass" });
    expect(login.status).toBe(200);
    return cookies(login);
}

beforeAll(async () => {
    database = await createTestDatabase();
    await seedGenerationPricing(database.db, [
        { modelId: "image-demo", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 7 },
        { modelId: "text-demo", capability: "text", version: 1, billingUnit: "request", creditsPerUnit: 2 },
        { modelId: "image-token", capability: "image", version: 1, billingUnit: "output_token", creditsPerUnit: 2 },
        { modelId: "image-sub2api", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 2 },
        { modelId: "image-disabled", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 2 },
    ]);
    await database.db.insert(modelProvider).values({ id: "unsupported-provider", displayName: "Unsupported", adapter: "sub2api", endpoint: "https://provider.invalid/v1", secretRef: "test-only", enabled: true });
    await database.db.insert(modelProviderCredential).values({ providerId: "unsupported-provider", ciphertext: "unused", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.update(modelCatalog).set({ providerId: "unsupported-provider" }).where(eq(modelCatalog.publicId, "image-sub2api"));
    await database.db.update(modelCatalog).set({ enabled: false }).where(eq(modelCatalog.publicId, "image-disabled"));
    await database.db.update(modelNodeGroups).set({ groups: [imageGroup], version: 1 }).where(eq(modelNodeGroups.capability, "image"));
    await database.db.update(modelCatalog).set({ groupId: imageGroup.id }).where(eq(modelCatalog.capability, "image"));
    const queue = { async send() { queueSends++; return `job-${queueSends}`; } };
    const options: Parameters<typeof createAccountApi>[0] = {
        database: database.db,
        origin,
        auth: {
            secret,
            sendVerificationEmail: async (mail) => { mails.push({ to: mail.to, url: mail.url }); },
            sendResetPassword: async () => undefined,
        },
        rates: createRateStore(database.pool, secret),
        verifyHuman: async (request) => request.headers.get("x-captcha-response") === "test-pass",
        generation: { enabled: true, queue },
        onFault: () => undefined,
    };
    app = createApp(createAccountApi(options), "public-test-site-key", false, false, undefined, { image: true });
    disabledApp = createApp(createAccountApi({ ...options, generation: undefined }), "public-test-site-key");
    aliceCookie = await registerAndLogin("Generation Alice", "generation-alice@example.test");
    aliceId = (await (await request("/api/v1/session", undefined, aliceCookie, "")).json()).user.id;
    bobCookie = await registerAndLogin("Generation Bob", "generation-bob@example.test");
    bobId = (await (await request("/api/v1/session", undefined, bobCookie, "")).json()).user.id;
    await database.db.insert(wallet).values({ userId: aliceId, availableUnits: "100" });
}, 30_000);

afterAll(async () => { await database?.close(); });

const intent = { modelId: "image-demo", input: { prompt: "hello" }, parameters: {} };
const submission = { ...intent, confirmedPriceVersion: 1 };

describe("gated generation HTTP contract", () => {
    test("quotes and submits a task, then replays the same idempotency key", async () => {
        const quote = await request("/api/v1/generation/quote", intent, aliceCookie, aliceId);
        expect(quote.status).toBe(200);
        expect(await quote.json()).toMatchObject({ quote: { modelId: "image-demo", priceVersion: 1, quotedUnits: 7, billingUnit: "request", creditsPerUnit: 7 } });

        const first = await request("/api/v1/generation/tasks", submission, aliceCookie, aliceId, { "idempotency-key": "generation-http-1" });
        expect(first.status).toBe(201);
        const firstBody = await first.json();
        expect(firstBody.created).toBe(true);
        expect(firstBody.task).toMatchObject({ modelId: "image-demo", priceVersion: 1, quotedUnits: 7, executionStatus: "queued", billingStatus: "reserved" });
        expect(firstBody.task).not.toHaveProperty("ownerId");
        expect(firstBody.task).not.toHaveProperty("reservationId");
        expect(firstBody.task).not.toHaveProperty("idempotencyKey");
        expect(firstBody.task).not.toHaveProperty("requestId");
        expect(queueSends).toBe(1);

        const replay = await request("/api/v1/generation/tasks", submission, aliceCookie, aliceId, { "idempotency-key": "generation-http-1" });
        expect(replay.status).toBe(200);
        expect((await replay.json()).created).toBe(false);
        expect(queueSends).toBe(1);

        const taskId = firstBody.task.id as string;
        const detail = await request(`/api/v1/generation/tasks/${taskId}`, undefined, aliceCookie, aliceId);
        expect(detail.status).toBe(200);
        expect((await detail.json()).task.id).toBe(taskId);
    });

    test("rejects anonymous, mismatched, unsafe and insufficient requests", async () => {
        expect((await request("/api/v1/generation/quote", intent, "", "")).status).toBe(401);
        expect((await request("/api/v1/generation/quote", intent, aliceCookie, bobId)).status).toBe(409);
        expect((await request("/api/v1/generation/tasks", { ...intent, quotedUnits: 1 }, aliceCookie, aliceId, { "idempotency-key": "generation-http-unsafe" })).status).toBe(400);
        expect((await request("/api/v1/generation/tasks", intent, aliceCookie, aliceId)).status).toBe(400);
        expect((await request("/api/v1/generation/tasks", submission, aliceCookie, aliceId)).status).toBe(400);
        const snapshot = async () => {
            const [tasks, reservations, ledger] = await Promise.all([
                database.db.select({ id: generationTask.id }).from(generationTask),
                database.db.select({ id: walletReservation.id }).from(walletReservation),
                database.db.select({ id: walletLedger.id }).from(walletLedger),
            ]);
            return {
                taskIds: tasks.map((row) => row.id).sort(),
                reservationIds: reservations.map((row) => row.id).sort(),
                ledgerIds: ledger.map((row) => row.id).sort(),
                queueSends,
            };
        };
        const beforeInsufficient = await snapshot();
        const insufficient = await request("/api/v1/generation/tasks", submission, bobCookie, bobId, { "idempotency-key": "generation-http-empty" });
        expect(insufficient.status).toBe(402);
        expect((await insufficient.json()).error.code).toBe("insufficient_balance");
        expect(await snapshot()).toEqual(beforeInsufficient);
    });

    test("lists only executable image/request models and rejects unsupported input before reserving", async () => {
        const models = await request("/api/v1/generation/models", undefined, aliceCookie, aliceId);
        expect(models.status).toBe(200);
        expect((await models.json()).items).toEqual([{ id: "image-demo", displayName: "image-demo", capability: "image", group: { ...imageGroup, order: 0 } }]);
        const balance = await createWalletRepository(database.db).get(aliceId);
        const sends = queueSends;
        for (const body of [
            { ...submission, modelId: "text-demo" }, { ...submission, modelId: "image-token" },
            { ...submission, modelId: "image-sub2api" }, { ...submission, modelId: "image-disabled" },
            { ...submission, parameters: { n: 2 } }, { ...submission, input: { prompt: "hello", referenceImages: [] } },
        ]) {
            const response = await request("/api/v1/generation/tasks", body, aliceCookie, aliceId, { "idempotency-key": "unsupported-image" });
            expect(response.status).toBe(400);
            expect((await response.json()).error.code).toBe("unsupported_generation");
        }
        expect(queueSends).toBe(sends);
        expect(await createWalletRepository(database.db).get(aliceId)).toEqual(balance);
        expect(await database.db.select().from(generationTask).where(eq(generationTask.idempotencyKey, "unsupported-image"))).toHaveLength(0);
    });

    test("display group changes preserve executable filtering, quotes and task balances", async () => {
        const beforeQuote = (await (await request("/api/v1/generation/quote", intent, aliceCookie, aliceId)).json()).quote;
        const beforeBalance = await createWalletRepository(database.db).get(aliceId), sends = queueSends;
        await database.db.update(modelNodeGroups).set({ groups: [{ ...imageGroup, name: "Renamed images" }], version: 2 }).where(eq(modelNodeGroups.capability, "image"));
        expect((await (await request("/api/v1/generation/models", undefined, aliceCookie, aliceId)).json()).items)
            .toEqual([{ id: "image-demo", displayName: "image-demo", capability: "image", group: { ...imageGroup, name: "Renamed images", order: 0 } }]);
        expect((await (await request("/api/v1/generation/quote", intent, aliceCookie, aliceId)).json()).quote).toEqual(beforeQuote);
        await database.db.update(modelCatalog).set({ groupId: null }).where(eq(modelCatalog.publicId, "image-demo"));
        expect((await (await request("/api/v1/generation/models", undefined, aliceCookie, aliceId)).json()).items)
            .toEqual([{ id: "image-demo", displayName: "image-demo", capability: "image", group: null }]);
        expect(await createWalletRepository(database.db).get(aliceId)).toEqual(beforeBalance);
        expect(queueSends).toBe(sends);
    });

    test("closed runtime reports unavailable without opening generation writes", async () => {
        const sends = queueSends;
        for (const [path, method, body] of [
            ["models", "GET", undefined], ["quote", "POST", intent], ["tasks", "POST", submission],
        ] as const) {
            const response = await disabledApp(new Request(`${origin}/api/v1/generation/${path}`, {
                method, headers: { origin, cookie: aliceCookie, "x-canvas-account-id": aliceId, "content-type": "application/json" },
                ...(body ? { body: JSON.stringify(body) } : {}),
            }), "198.51.100.20");
            expect(response.status).toBe(503);
            expect((await response.json()).error.code).toBe("generation_unavailable");
        }
        expect(queueSends).toBe(sends);
    });

    test("price rotation rejects a new stale submission but preserves an already accepted replay", async () => {
        const balance = await createWalletRepository(database.db).get(aliceId);
        const sends = queueSends;
        // Keep v1 enabled deliberately: confirmation must compare the latest effective price.
        await database.db.insert(modelPricing).values({ id: "image-new-price", modelId: "generation-image-demo", version: 2, billingUnit: "request", creditsPerUnit: 11, effectiveFrom: new Date("2026-01-01T00:00:00Z"), enabled: true });
        const response = await request("/api/v1/generation/tasks", submission, aliceCookie, aliceId, { "idempotency-key": "stale-quote" });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe("price_changed");
        expect(queueSends).toBe(sends);
        expect(await createWalletRepository(database.db).get(aliceId)).toEqual(balance);
        expect(await database.db.select().from(generationTask).where(eq(generationTask.idempotencyKey, "stale-quote"))).toHaveLength(0);
        expect(await database.db.select().from(walletReservation).where(eq(walletReservation.idempotencyKey, "g:stale-quote"))).toHaveLength(0);

        await database.db.update(modelPricing).set({ enabled: false }).where(and(eq(modelPricing.modelId, "generation-image-demo"), eq(modelPricing.version, 1)));
        const replay = await request("/api/v1/generation/tasks", submission, aliceCookie, aliceId, { "idempotency-key": "generation-http-1" });
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ created: false, task: { priceVersion: 1, quotedUnits: 7 } });
        expect(queueSends).toBe(sends);
        expect(await createWalletRepository(database.db).get(aliceId)).toEqual(balance);
        const changed = await request("/api/v1/generation/tasks", { ...submission, confirmedPriceVersion: 2 }, aliceCookie, aliceId, { "idempotency-key": "generation-http-1" });
        expect(changed.status).toBe(409);
        expect((await changed.json()).error.code).toBe("idempotency_conflict");
        const changedIntent = await request("/api/v1/generation/tasks", { ...submission, input: { prompt: "a different picture" } }, aliceCookie, aliceId, { "idempotency-key": "generation-http-1" });
        expect(changedIntent.status).toBe(409);
        expect((await changedIntent.json()).error.code).toBe("idempotency_conflict");
        expect(await createWalletRepository(database.db).get(aliceId)).toEqual(balance);
        const freshQuote = await request("/api/v1/generation/quote", intent, aliceCookie, aliceId);
        expect(freshQuote.status).toBe(200);
        expect((await freshQuote.json()).quote).toMatchObject({ priceVersion: 2, quotedUnits: 11, creditsPerUnit: 11 });
    });

    test("recovers an unread submit response by owner and key without a second POST", async () => {
        const sends = queueSends;
        const key = "uncertain:response";
        const accepted = await request("/api/v1/generation/tasks", { ...intent, confirmedPriceVersion: 2 }, aliceCookie, aliceId, { "idempotency-key": key });
        expect(accepted.status).toBe(201);
        // Deliberately discard the response body, as a client with an uncertain outcome would.
        const recovered = await request(`/api/v1/generation/tasks/by-key/${encodeURIComponent(key)}`, undefined, aliceCookie, aliceId);
        expect(recovered.status).toBe(200);
        const recoveredBody = await recovered.json();
        expect(recoveredBody.task).toMatchObject({ priceVersion: 2, quotedUnits: 11, executionStatus: "queued" });
        expect(recoveredBody.task).not.toHaveProperty("inputSnapshot");
        expect(recoveredBody.task).not.toHaveProperty("idempotencyKey");
        expect((await request(`/api/v1/generation/tasks/by-key/${encodeURIComponent(key)}`, undefined, bobCookie, bobId)).status).toBe(404);
        expect((await request("/api/v1/generation/tasks/by-key/absent-key", undefined, aliceCookie, aliceId)).status).toBe(404);
        expect((await request(`/api/v1/generation/tasks/${recoveredBody.task.id}`, undefined, bobCookie, bobId)).status).toBe(404);
        expect(queueSends).toBe(sends + 1);
        expect(await createWalletRepository(database.db).get(aliceId)).toMatchObject({ availableUnits: "82", reservedUnits: "18" });
    });
});
