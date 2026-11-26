import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRateStore, type RateRule } from "@infinite-canvas/database/rate-limit";
import { generationTask, user } from "@infinite-canvas/database/schema";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { accountPolicy } from "../src/policy";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";

const origin = "http://localhost:4000", batchPath = "/api/v1/generation/tasks/batch";
const secret = `batch-test-${crypto.randomUUID()}${crypto.randomUUID()}`;
const password = "synthetic-batch-password", privateMarker = "synthetic-private-batch-evidence";
const foreignId = crypto.randomUUID(), missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemFields = ["taskId", "projectId", "nodeId", "modelId", "executionStatus", "deliveryStatus", "billingStatus", "updatedAt"].sort();
const rateCalls: Array<{ bucket: string; identity: string; rule: RateRule }> = [];
const mails: Array<{ to: string; url: string }> = [];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>, writingApp: ReturnType<typeof createApp>, closedApp: ReturnType<typeof createApp>;
let ownerId = "", cookie = "", imageId = "", textId = "", foreignTaskId = "";
let taskSelects = 0, databaseFailure = false, denyRead = false, queueSends = 0;
const imageKey = "batch-owner-image-key";

type RequestOptions = {
    method?: string; cookie?: string; accountId?: string; origin?: string | null; crossSite?: boolean;
    app?: ReturnType<typeof createApp>;
};
function request(path: string, body: unknown = { taskIds: [] }, options: RequestOptions = {}) {
    const method = options.method ?? "POST";
    const headers = new Headers({ cookie: options.cookie ?? cookie, "content-type": "application/json" });
    if (options.origin !== null) headers.set("origin", options.origin ?? origin);
    const accountId = options.accountId ?? ownerId;
    if (accountId) headers.set("x-canvas-account-id", accountId);
    if (options.crossSite) headers.set("sec-fetch-site", "cross-site");
    return (options.app ?? app)(new Request(origin + path, {
        method, headers, ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.42");
}
function expectReadBudget() {
    expect(accountPolicy.read).toEqual({ points: 120, duration: 60 });
    expect(rateCalls).toEqual([{ bucket: "account-read", identity: ownerId, rule: accountPolicy.read }]);
}
function resetObserved() { rateCalls.length = 0; taskSelects = 0; }
async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
}

beforeAll(async () => {
    database = await createTestDatabase();
    // Observe and fault only generation-task SELECTs. Authentication and the
    // limiter still use the real isolated database throughout these requests.
    const observedDatabase = new Proxy(database.db, {
        get(target, property) {
            const value = Reflect.get(target, property);
            if (property !== "select") return typeof value === "function" ? value.bind(target) : value;
            return (...args: unknown[]) => {
                const selection = Reflect.apply(value, target, args);
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
    const realRates = createRateStore(database.pool, secret);
    const options: Parameters<typeof createAccountApi>[0] = {
        database: observedDatabase, origin,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); }, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) {
            rateCalls.push({ bucket, identity, rule: { ...rule } });
            if (denyRead && bucket === "account-read") return { allowed: false, retryAfter: 17 };
            return realRates.consume(bucket, identity, rule);
        } },
        verifyHuman: async () => true,
        generation: { enabled: true, imageEnabled: false, textEnabled: false, queue: { async send() { queueSends++; throw new Error("unexpected synthetic queue submission"); } } },
        onFault: () => undefined,
    };
    app = createApp(createAccountApi(options), "public-test-site-key");
    writingApp = createApp(createAccountApi({ ...options, generation: { ...options.generation!, imageEnabled: true } }), "public-test-site-key");
    closedApp = createApp(createAccountApi({ ...options, generation: { ...options.generation!, enabled: false } }), "public-test-site-key");
    const email = "batch-owner@example.test";
    expect((await request("/api/auth/sign-up/email", { name: "Batch owner", email, password }, { cookie: "", accountId: "" })).status).toBe(200);
    const mail = mails.find((value) => value.to === email);
    expect(mail).toBeDefined();
    expect((await app(new Request(mail!.url), "198.51.100.42")).status).toBe(302);
    const login = await request("/api/auth/sign-in/email", { email, password }, { cookie: "", accountId: "" });
    expect(login.status).toBe(200);
    cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).toBeTruthy();
    ownerId = (await (await request("/api/v1/session", undefined, { method: "GET" })).json()).user.id;
    await database.db.insert(user).values({ id: foreignId, name: "Foreign batch owner", email: "batch-foreign@example.test", emailVerified: true });
    await seedGenerationPricing(database.db, [
        { modelId: "batch-image", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 2 },
        { modelId: "batch-text", capability: "text", version: 1, billingUnit: "request", creditsPerUnit: 2 },
    ]);
    const tasks = createGenerationTaskRepository(database.db);
    const image = await tasks.create({ ownerId, modelId: "batch-image", projectId: "original-project", nodeId: "original-node",
        inputSnapshot: { prompt: privateMarker }, parameterSnapshot: { privateParameter: privateMarker }, idempotencyKey: imageKey, requestId: privateMarker });
    const text = await tasks.create({ ownerId, modelId: "batch-text", inputSnapshot: {}, parameterSnapshot: {}, idempotencyKey: "batch-owner-text-key", requestId: "batch-text-request" });
    const foreign = await tasks.create({ ownerId: foreignId, modelId: "batch-image", inputSnapshot: {}, parameterSnapshot: {}, idempotencyKey: "batch-foreign-key", requestId: "batch-foreign-request" });
    imageId = image.task.id; textId = text.task.id; foreignTaskId = foreign.task.id;
    await tasks.transitionExecution({ ownerId, taskId: imageId, status: "unknown", providerTaskId: privateMarker, unknownReason: privateMarker });
    await createGenerationResultRepository(database.db).create({ taskId: imageId, ownerId, status: "unknown", providerTaskId: privateMarker, unknownReason: privateMarker,
        resultSnapshot: { kind: "image", dataUrl: privateMarker, providerPayload: { secret: privateMarker } } });
    resetObserved();
}, 30_000);

afterAll(async () => { await database?.close(); });

test("batch is an owner-scoped minimal cross-type read with lowercase deduplication and safe headers", async () => {
    resetObserved();
    const response = await request(batchPath, { taskIds: [textId.toUpperCase(), missingId.toUpperCase(), imageId.toUpperCase(), textId, foreignTaskId] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["items", "missingTaskIds", "requestId"]);
    expect(body.items.map((item: { taskId: string }) => item.taskId)).toEqual([textId, imageId]);
    expect(body.missingTaskIds).toEqual([missingId, foreignTaskId]);
    for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(itemFields);
        expect(item).toMatchObject({ deliveryStatus: "pending", billingStatus: "unbilled" });
        expect(new Date(item.updatedAt).toISOString()).toBe(item.updatedAt);
    }
    expect(body.items[1]).toMatchObject({ projectId: "original-project", nodeId: "original-node", modelId: "batch-image", executionStatus: "unknown" });
    expect(body.items[0]).toMatchObject({ projectId: null, nodeId: null, modelId: "batch-text", executionStatus: "pending" });
    expect(JSON.stringify(body)).not.toContain(privateMarker);
    expect(JSON.stringify(body)).not.toContain(imageKey);
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expectReadBudget();
    expect(taskSelects).toBe(1);
    for (const id of [foreignTaskId, missingId]) {
        const hidden = await request(batchPath, { taskIds: [id] });
        expect(hidden.status).toBe(200);
        const { requestId: _requestId, ...partition } = await hidden.json();
        expect(partition).toEqual({ items: [], missingTaskIds: [id] });
    }
});

test("raw 0 and 50 are accepted, while invalid raw bodies, 51 duplicates and query parameters are rejected", async () => {
    resetObserved();
    const empty = await request(batchPath, { taskIds: [] });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ items: [], missingTaskIds: [] });
    expect(taskSelects).toBe(0);
    expectReadBudget();
    const fifty = Array.from({ length: 50 }, () => crypto.randomUUID());
    resetObserved();
    const full = await request(batchPath, { taskIds: fifty.map((id) => id.toUpperCase()) });
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({ items: [], missingTaskIds: fifty });
    expect(taskSelects).toBe(1);
    expectReadBudget();
    const invalid = [null, [], {}, { taskIds: null }, { taskIds: imageId }, { taskIds: [7] }, { taskIds: ["not-a-uuid"] },
        { taskIds: Array(51).fill(imageId) }, { taskIds: [], ownerId }, { taskIds: [], extra: true }];
    for (const body of invalid) {
        resetObserved();
        await expectError(await request(batchPath, body), 400, "invalid_input");
        expect(taskSelects).toBe(0);
        expectReadBudget();
    }
    resetObserved();
    await expectError(await request(`${batchPath}?ownerId=${ownerId}`, { taskIds: [] }), 400, "invalid_input");
    expectReadBudget();
});

test("batch retains cookie, same-origin, account-context, total gate and exact-method protections", async () => {
    const cases: Array<{ options: RequestOptions; status: number; code: string }> = [
        { options: { cookie: "" }, status: 401, code: "unauthorized" },
        { options: { origin: null }, status: 403, code: "invalid_origin" },
        { options: { origin: "https://foreign.example.test" }, status: 403, code: "invalid_origin" },
        { options: { crossSite: true }, status: 403, code: "invalid_origin" },
        { options: { accountId: "" }, status: 400, code: "account_context_required" },
        { options: { accountId: foreignId }, status: 409, code: "account_changed" },
        { options: { app: closedApp }, status: 503, code: "generation_unavailable" },
    ];
    for (const entry of cases) await expectError(await request(batchPath, { taskIds: [imageId] }, entry.options), entry.status, entry.code);
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        await expectError(await request(batchPath, { taskIds: [] }, { method }), 405, "method_not_allowed");
    }
});

test("batch consumes one read budget and preserves Retry-After while adjacent submissions retain save budgets", async () => {
    resetObserved();
    denyRead = true;
    try {
        const response = await request(batchPath, { taskIds: [imageId, textId] });
        await expectError(response, 429, "rate_limited");
        expect(response.headers.get("retry-after")).toBe("17");
        expect(taskSelects).toBe(0);
        expectReadBudget();
    } finally { denyRead = false; }
    for (const path of ["/api/v1/generation/quote", "/api/v1/generation/tasks"]) {
        resetObserved();
        // Invalid intent reaches the existing route's input boundary without
        // reserving credits, sending a queue job or contacting a provider.
        await expectError(await request(path, {}, { app: writingApp }), 400, "invalid_input");
        expect(rateCalls).toEqual([{ bucket: "canvas-save", identity: ownerId, rule: accountPolicy.save }]);
    }
    for (const path of [`/api/v1/generation/tasks/${imageId}`, `/api/v1/generation/tasks/by-key/${imageKey}`]) {
        resetObserved();
        const response = await request(path, undefined, { method: "GET" });
        expect(response.status).toBe(200);
        expect((await response.json()).task.id).toBe(imageId);
        expectReadBudget();
    }
    expect(queueSends).toBe(0);
});

test("a task-query database failure fails the whole batch rather than returning missing IDs", async () => {
    databaseFailure = true;
    try {
        resetObserved();
        const response = await request(batchPath, { taskIds: [imageId, missingId] });
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body).toMatchObject({ error: { code: "service_unavailable" } });
        expect(body).not.toHaveProperty("items");
        expect(body).not.toHaveProperty("missingTaskIds");
        expect(JSON.stringify(body)).not.toContain(privateMarker);
        expect(taskSelects).toBe(1);
        expectReadBudget();
        resetObserved();
        const empty = await request(batchPath, { taskIds: [] });
        expect(empty.status).toBe(200);
        expect(await empty.json()).toMatchObject({ items: [], missingTaskIds: [] });
        expect(taskSelects).toBe(0);
        expectReadBudget();
    } finally { databaseFailure = false; }
});
