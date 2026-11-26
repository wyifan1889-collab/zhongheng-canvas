import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRateStore, type RateRule } from "@infinite-canvas/database/rate-limit";
import { generationTask, generationResult, mediaObject, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, user, type GenerationExecutionStatus } from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { eq } from "drizzle-orm";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { accountPolicy } from "../src/policy";
import { createTestDatabase } from "./database";

const origin = "http://localhost:4000", logsPath = "/api/v1/generation/logs";
const secret = `history-test-${crypto.randomUUID()}${crypto.randomUUID()}`, password = "synthetic-history-password";
const privateMarker = "synthetic-private-history-evidence", foreignOwner = crypto.randomUUID();
const imageId = crypto.randomUUID(), foreignTaskId = crypto.randomUUID();
const states: GenerationExecutionStatus[] = ["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"];
const legacyIds = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`);
const orderedIds = [imageId, ...legacyIds.toReversed()];
const itemFields = ["taskId", "type", "displayModel", "executionStatus", "deliveryStatus", "billingStatus", "credits", "createdAt", "updatedAt", "result"].sort();
const rateCalls: Array<{ bucket: string; identity: string; rule: RateRule }> = [];
const mails: Array<{ to: string; url: string }> = [];
const storage = createMemoryObjectStorage();
const mediaBytes = new Uint8Array([1, 2, 3]);
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>, closedApp: ReturnType<typeof createApp>;
let ownerId = "", cookie = "", taskSelects = 0, readTransactions = 0, queueSends = 0;
let databaseFailure = false, denyRead = false;

type RequestOptions = { method?: string; cookie?: string; accountId?: string; origin?: string | null; crossSite?: boolean; body?: unknown; app?: ReturnType<typeof createApp> };
function request(path = logsPath, options: RequestOptions = {}) {
    const method = options.method ?? "GET";
    const headers = new Headers({ cookie: options.cookie ?? cookie, "content-type": "application/json" });
    if (options.origin !== null) headers.set("origin", options.origin ?? origin);
    const accountId = options.accountId ?? ownerId;
    if (accountId) headers.set("x-canvas-account-id", accountId);
    if (options.crossSite) headers.set("sec-fetch-site", "cross-site");
    return (options.app ?? app)(new Request(origin + path, { method, headers,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(options.body ?? {}) }),
    }), "198.51.100.45");
}
function resetObserved() { rateCalls.length = 0; taskSelects = 0; readTransactions = 0; }
function expectReadBudget() {
    expect(rateCalls).toEqual([{ bucket: "account-read", identity: ownerId, rule: accountPolicy.read }]);
}
async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
}

/** Retain real auth/SQL, including the history reader's transaction snapshot. */
function observeDatabase<T extends object>(target: T): T {
    return new Proxy(target, {
        get(db, property) {
            const value = Reflect.get(db, property);
            if (property === "transaction") return (callback: (tx: T) => unknown, ...args: unknown[]) => {
                readTransactions++;
                return Reflect.apply(value, db, [(tx: T) => callback(observeDatabase(tx)), ...args]);
            };
            if (property !== "select") return typeof value === "function" ? value.bind(db) : value;
            return (...args: unknown[]) => {
                const selection = Reflect.apply(value, db, args);
                return new Proxy(selection, {
                    get(builder, key) {
                        const member = Reflect.get(builder, key);
                        if (key !== "from") return typeof member === "function" ? member.bind(builder) : member;
                        return (table: unknown) => {
                            if (table === generationTask) {
                                taskSelects++;
                                if (databaseFailure) throw new Error(privateMarker);
                            }
                            return Reflect.apply(member, builder, [table]);
                        };
                    },
                });
            };
        },
    });
}

beforeAll(async () => {
    database = await createTestDatabase();
    const realRates = createRateStore(database.pool, secret);
    const options: Parameters<typeof createAccountApi>[0] = {
        database: observeDatabase(database.db), origin,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); }, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) {
            rateCalls.push({ bucket, identity, rule: { ...rule } });
            if (denyRead && bucket === "account-read") return { allowed: false, retryAfter: 17 };
            return realRates.consume(bucket, identity, rule);
        } },
        verifyHuman: async () => true,
        generation: { enabled: true, imageEnabled: false, textEnabled: false, audioEnabled: false,
            queue: { async send() { queueSends++; throw new Error("unexpected history submission"); } } },
        media: { storage, quotaBytes: 1024 * 1024 * 1024,
            maxBytes: { image: accountPolicy.documentBytes, video: accountPolicy.documentBytes, audio: accountPolicy.documentBytes } },
        onFault: () => undefined,
    };
    app = createApp(createAccountApi(options), "public-test-site-key");
    closedApp = createApp(createAccountApi({ ...options, generation: { ...options.generation!, enabled: false } }), "public-test-site-key");
    const email = "history-owner@example.test";
    expect((await request("/api/auth/sign-up/email", { method: "POST", body: { name: "History owner", email, password }, cookie: "", accountId: "" })).status).toBe(200);
    const mail = mails.find((entry) => entry.to === email);
    expect(mail).toBeDefined();
    expect((await app(new Request(mail!.url), "198.51.100.45")).status).toBe(302);
    const login = await request("/api/auth/sign-in/email", { method: "POST", body: { email, password }, cookie: "", accountId: "" });
    expect(login.status).toBe(200);
    cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).toBeTruthy();
    ownerId = (await (await request("/api/v1/session")).json()).user.id;
    await database.db.insert(user).values({ id: foreignOwner, name: "Foreign history owner", email: "history-foreign@example.test", emailVerified: true });
    await database.db.insert(generationTask).values(legacyIds.map((id, index) => ({
        id, ownerId, modelId: "history-legacy", inputSnapshot: { prompt: privateMarker, type: "video" }, parameterSnapshot: { privateMarker },
        idempotencyKey: `history-legacy-${index}`, requestId: privateMarker, executionStatus: states[index % states.length],
        unknownReason: states[index % states.length] === "unknown" ? privateMarker : null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    })));
    await database.db.insert(generationTask).values({ id: foreignTaskId, ownerId: foreignOwner, modelId: "foreign-private-model", inputSnapshot: {}, parameterSnapshot: {},
        idempotencyKey: "foreign-history", requestId: "foreign-history", createdAt: new Date("2026-03-01T00:00:00.000Z") });
    await seedPublishedImage();
    resetObserved();
}, 30_000);

afterAll(async () => { await database?.close(); });

async function seedPublishedImage() {
    const providerId = "history-provider", internalId = "history-image-internal", draftId = crypto.randomUUID(), pricingId = crypto.randomUUID();
    await database.db.insert(modelProvider).values({ id: providerId, displayName: privateMarker, adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", secretRef: privateMarker, enabled: true });
    await database.db.insert(modelCatalog).values([
        { id: "history-current-only", publicId: "history-legacy", providerId, providerModel: "private-current-legacy", displayName: privateMarker, capability: "image", enabled: true },
        { id: internalId, publicId: "history-image", providerId, providerModel: "private-original-image", displayName: privateMarker, capability: "image", enabled: true },
    ]);
    await database.db.insert(modelPriceDraft).values({ id: draftId, modelId: internalId, version: 1, priceNote: privateMarker,
        providerIdSnapshot: providerId, providerModelSnapshot: "private-original-image", adapterSnapshot: "openai-compatible", endpointSnapshot: "https://provider.invalid/v1", capabilitySnapshot: "image",
        rules: { schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } } });
    await database.db.transaction(async (tx) => {
        await tx.insert(modelPricing).values({ id: pricingId, modelId: internalId, version: 1, billingUnit: "request", creditsPerUnit: 7, effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), enabled: true });
        await tx.insert(modelPricePublication).values({ id: crypto.randomUUID(), pricingId, draftId, publicPriceNote: "Synthetic history publication" });
    });
    await database.db.insert(generationTask).values({ id: imageId, ownerId, modelId: "history-image", inputSnapshot: { prompt: privateMarker }, parameterSnapshot: {},
        priceVersion: 1, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7, quotedUnits: 7,
        idempotencyKey: "history-published-image", requestId: privateMarker, executionStatus: "succeeded", deliveryStatus: "saved",
        createdAt: new Date("2026-02-01T00:00:00.000Z"), updatedAt: new Date("2026-02-02T00:00:00.000Z") });
    const stored = await storage.put({ key: objectKey(`accounts/${Buffer.from(ownerId).toString("base64url")}/media/${imageId}`), body: mediaBytes, contentType: "image/png" });
    await database.db.insert(mediaObject).values({ id: imageId, ownerId, objectKey: stored.key, kind: "image", contentType: "image/png", sizeBytes: stored.sizeBytes, etag: stored.etag });
    await database.db.insert(generationResult).values({ id: crypto.randomUUID(), taskId: imageId, ownerId, status: "succeeded", providerTaskId: privateMarker,
        resultSnapshot: { kind: "image", media: { mediaId: imageId, kind: "image", contentType: "image/png", sizeBytes: stored.sizeBytes, etag: stored.etag },
            providerUrl: "https://provider.invalid/private", objectKey: stored.key, data: privateMarker, text: privateMarker } });
}

test("GET history defaults to 50 owner rows, preserves all 8 states and exposes only the history whitelist", async () => {
    resetObserved();
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["items", "pageNumber", "pageSize", "requestId", "total"]);
    expect(body).toMatchObject({ total: 52, pageNumber: 1, pageSize: 50 });
    expect(body.items.map((item: { taskId: string }) => item.taskId)).toEqual(orderedIds.slice(0, 50));
    expect(new Set(body.items.map((item: { executionStatus: string }) => item.executionStatus))).toEqual(new Set(states));
    for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(itemFields);
        expect(item.credits).toBeNull(); // Neither the quote of 7 nor absent capture evidence is a charge.
        expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
        expect(new Date(item.updatedAt).toISOString()).toBe(item.updatedAt);
        if (item.taskId !== imageId) expect(item).toMatchObject({ type: null, displayModel: "history-legacy", result: null });
    }
    expect(body.items[0]).toMatchObject({ type: "image", displayModel: "history-image", executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "unbilled" });
    const serialized = JSON.stringify(body);
    for (const hidden of [privateMarker, "provider.invalid", "private-original-image", "foreign-private-model", "accounts/", "inputSnapshot", "parameterSnapshot"]) expect(serialized).not.toContain(hidden);
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expectReadBudget();
    expect(readTransactions).toBeGreaterThan(0);
});

test("pagination and type/status totals use the same owner filter without classifying legacy rows by today's catalog", async () => {
    const second = await (await request(`${logsPath}?pageNumber=2`)).json();
    expect(second).toMatchObject({ total: 52, pageNumber: 2, pageSize: 50 });
    expect(second.items.map((item: { taskId: string }) => item.taskId)).toEqual(orderedIds.slice(50));
    expect(await (await request(`${logsPath}?pageNumber=3`)).json()).toMatchObject({ items: [], total: 52, pageNumber: 3, pageSize: 50 });
    const small = await (await request(`${logsPath}?pageNumber=2&pageSize=1`)).json();
    expect(small).toMatchObject({ total: 52, pageNumber: 2, pageSize: 1 });
    expect(small.items.map((item: { taskId: string }) => item.taskId)).toEqual([legacyIds.at(-1)]);
    for (const type of ["text", "image", "audio", "video"]) {
        const response = await request(`${logsPath}?type=${type}`);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.total).toBe(type === "image" ? 1 : 0);
        expect(body.items.map((item: { taskId: string }) => item.taskId)).toEqual(type === "image" ? [imageId] : []);
    }
    for (const status of ["succeeded", "failed", "running", "queued", "pending"]) {
        const expected = legacyIds.filter((_id, index) => states[index % states.length] === status).toReversed();
        if (status === "succeeded") expected.unshift(imageId);
        const body = await (await request(`${logsPath}?status=${status}`)).json();
        expect(body.total).toBe(expected.length);
        expect(body.items.map((item: { taskId: string }) => item.taskId)).toEqual(expected);
    }
    expect(await (await request(`${logsPath}?type=image&status=failed`)).json()).toMatchObject({ total: 0, items: [] });
});

test("query parsing rejects duplicates, extras, empty or unsafe pagination and unsupported filters", async () => {
    for (const query of [
        "pageNumber=1&pageNumber=2", "pageSize=1&pageSize=1", "type=image&type=image", "status=failed&status=failed", "ownerId=anyone",
        "pageNumber=", "pageSize=", "type=", "status=", "pageNumber=0", "pageNumber=-1", "pageNumber=1.5", "pageNumber=1e2", "pageNumber=%201",
        "pageSize=0", "pageSize=51", "pageSize=1.5", "pageNumber=9007199254740992", "pageNumber=9007199254740991&pageSize=50",
        "type=unknown", "status=unknown", "status=cancelled", "status=timeout",
    ]) {
        resetObserved();
        await expectError(await request(`${logsPath}?${query}`), 400, "invalid_input");
        expect(taskSelects).toBe(0);
    }
});

test("history requires auth, origin and matching account while submission-type flags remain independent", async () => {
    const cases: Array<{ options: RequestOptions; status: number; code: string }> = [
        { options: { cookie: "" }, status: 401, code: "unauthorized" },
        { options: { origin: "https://foreign.example.test" }, status: 403, code: "invalid_origin" },
        { options: { crossSite: true }, status: 403, code: "invalid_origin" },
        { options: { accountId: "" }, status: 400, code: "account_context_required" },
        { options: { accountId: foreignOwner }, status: 409, code: "account_changed" },
        { options: { app: closedApp }, status: 503, code: "generation_unavailable" },
    ];
    for (const entry of cases) await expectError(await request(logsPath, entry.options), entry.status, entry.code);
    expect((await request(logsPath, { origin: null })).status).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) await expectError(await request(logsPath, { method }), 405, "method_not_allowed");
    expect((await request(`${logsPath}/`)).status).toBe(404);
});

test("the saved image result is a protected local media URL with no fabricated thumbnail", async () => {
    const history = await (await request(`${logsPath}?type=image`)).json();
    expect(history.items[0].result).toEqual({ url: `/api/v1/media/${imageId}` });
    expect(history.items[0].result).not.toHaveProperty("thumbnailUrl");
    await expectError(await request(history.items[0].result.url, { cookie: "" }), 401, "unauthorized");
    await expectError(await request(history.items[0].result.url, { accountId: "" }), 400, "account_context_required");
    const download = await request(history.items[0].result.url);
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(mediaBytes);
});

test("history consumes one existing read budget, retains Retry-After and preserves adjacent reads", async () => {
    resetObserved();
    const success = await request(`${logsPath}?pageSize=1`);
    expect(success.status).toBe(200);
    expectReadBudget();
    resetObserved();
    denyRead = true;
    try {
        const response = await request();
        await expectError(response, 429, "rate_limited");
        expect(response.headers.get("retry-after")).toBe("17");
        expectReadBudget();
        expect(taskSelects).toBe(0);
    } finally { denyRead = false; }
    const batch = await request("/api/v1/generation/tasks/batch", { method: "POST", body: { taskIds: [legacyIds[0]] } });
    expect(batch.status).toBe(200);
    expect((await batch.json()).items[0].taskId).toBe(legacyIds[0]);
    for (const path of [`/api/v1/generation/tasks/${legacyIds[0]}`, "/api/v1/generation/tasks/by-key/history-legacy-0"]) {
        const detail = await request(path);
        expect(detail.status).toBe(200);
        expect((await detail.json()).task.id).toBe(legacyIds[0]);
    }
    expect(queueSends).toBe(0);
});

test("task-query failure inside the history transaction returns 503 instead of an empty successful page", async () => {
    resetObserved();
    databaseFailure = true;
    try {
        const response = await request();
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body).toMatchObject({ error: { code: "service_unavailable" } });
        expect(body).not.toHaveProperty("items");
        expect(body).not.toHaveProperty("total");
        expect(JSON.stringify(body)).not.toContain(privateMarker);
        expect(readTransactions).toBeGreaterThan(0);
        expect(taskSelects).toBeGreaterThan(0);
        expectReadBudget();
    } finally { databaseFailure = false; }
});

test("renaming an older record persists outside the task, searches all pages, and cannot change another owner's title", async () => {
    const id = legacyIds[0]!, path = `${logsPath}/${id}/title`;
    const [original] = await database.db.select().from(generationTask).where(eq(generationTask.id, id));
    await expectError(await request(path, { method: "PUT", origin: null, body: { title: "Invalid origin" } }), 403, "invalid_origin");
    await expectError(await request(path, { method: "PUT", accountId: foreignOwner, body: { title: "Wrong account" } }), 409, "account_changed");
    await expectError(await request(`${logsPath}/${foreignTaskId}/title`, { method: "PUT", body: { title: "Other owner's task" } }), 404, "not_found");
    await expectError(await request(path, { method: "PUT", body: { title: "拒\u0000绝" } }), 400, "invalid_input");
    await expectError(await request(path, { method: "PUT", body: { title: "标题", ownerId: foreignOwner } }), 400, "invalid_input");
    const renamed = await request(path, { method: "PUT", body: { title: "  封面 A_%  " } });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ taskId: id, title: "封面 A_%" });
    const [after] = await database.db.select().from(generationTask).where(eq(generationTask.id, id));
    expect(after).toEqual(original);
    expect((await (await request()).json()).items.some((item: { taskId: string }) => item.taskId === id)).toBe(false);
    const search = async (term: string) => (await request(`${logsPath}?search=${encodeURIComponent(term)}&pageSize=1`)).json();
    expect(await search("封面 a_%")).toMatchObject({ total: 1, items: [{ taskId: id, title: "封面 A_%", displayModel: "history-legacy" }] });
    expect(await search("%_")).toMatchObject({ total: 0, items: [] });
    expect((await search("HISTORY-LEGACY")).total).toBe(51);
    expect(await search("foreign-private-model")).toMatchObject({ total: 0, items: [] });
    expect((await request(path, { method: "PUT", body: { title: "新版封面" } })).status).toBe(200);
    expect(await search("新版")).toMatchObject({ total: 1, items: [{ taskId: id, title: "新版封面" }] });
    expect((await search("封面 A_%")).total).toBe(0);
    expect(queueSends).toBe(0);
});
