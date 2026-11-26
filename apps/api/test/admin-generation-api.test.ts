import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { auditEvent, generationResult, generationTask, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

if (process.env.SAAS_TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error("Only in-memory PGlite is permitted");
const origin = "http://localhost:4031";
const secret = "admin-query-synthetic-" + crypto.randomUUID();
const password = "admin-query-synthetic-password";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let admin = { id: "", cookie: "" };
let owner = { id: "", cookie: "" };
const taskId = crypto.randomUUID();
let rejectRead = false;
const readIdentities: string[] = [];
let queueCalls = 0;

function request(path: string, session = admin, extra: HeadersInit = {}, method = "GET") {
    const headers = new Headers({ origin, cookie: session.cookie, "x-canvas-account-id": session.id });
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return app(new Request(`${origin}${path}`, { method, headers }), "198.51.100.31");
}

async function register(email: string) {
    const signup = await app(new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password, name: "Synthetic query user" }),
    }), "198.51.100.31");
    expect(signup.status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    // Seed verified identity in the isolated DB; sign-in and subsequent sessions are real Better Auth.
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const signin = await app(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    }), "198.51.100.31");
    expect(signin.status).toBe(200);
    return { id: row!.id, cookie: signin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
}

beforeAll(async () => {
    database = await createTestDatabase();
    const rates = createRateStore(database.pool, secret);
    app = createApp(createAccountApi({
        database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) {
            if (bucket === "account-read") {
                readIdentities.push(identity);
                if (rejectRead) return { allowed: false, retryAfter: 1 };
            }
            return rates.consume(bucket, identity, rule);
        } },
        verifyHuman: async () => true,
        generation: { enabled: false, queue: { async send() { queueCalls++; throw new Error("queue must not be called"); } } },
        onFault: () => undefined,
    }), "synthetic-public-site-key");
    admin = await register("admin-query@example.test");
    owner = await register("owner-query@example.test");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await database.db.insert(generationTask).values({
        id: taskId, ownerId: owner.id, modelId: "synthetic-image", inputSnapshot: { prompt: "private-synthetic-prompt" },
        parameterSnapshot: {}, idempotencyKey: "private-synthetic-key", requestId: "private-original-request",
        executionStatus: "unknown", unknownReason: "provider_response_unknown", billingStatus: "pending_review",
    });
});
afterAll(async () => { await database?.close(); });

const path = `/api/v1/admin/generation/tasks/${taskId}`;

test("admin can query another owner's exact task while generation is disabled without business writes", async () => {
    const snapshot = () => Promise.all([
        database.db.select().from(generationTask), database.db.select().from(generationResult), database.db.select().from(wallet),
        database.db.select().from(walletReservation), database.db.select().from(walletLedger), database.db.select().from(auditEvent),
    ]);
    const before = await snapshot();
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.detail.task).toMatchObject({ id: taskId, ownerId: owner.id, executionStatus: "unknown" });
    expect(body.detail.reservation).toEqual({ linkStatus: "none", details: null });
    expect(body.detail.result).toBeNull();
    expect(body.detail.ledger).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("private-");
    expect((await request(`/api/v1/generation/tasks/${taskId}`)).status).toBe(503);
    expect(await snapshot()).toEqual(before);
    expect(queueCalls).toBe(0);
    expect(readIdentities).toContain(admin.id);
});

test("anonymous, non-admin, missing/wrong account and cross-site requests are refused", async () => {
    for (const [session, headers, status, code] of [
        [{ id: "", cookie: "" }, {}, 401, "unauthorized"],
        [owner, {}, 403, "forbidden"],
        [admin, { "x-canvas-account-id": "" }, 400, "account_context_required"],
        [admin, { "x-canvas-account-id": owner.id }, 409, "account_changed"],
        [admin, { origin: "http://untrusted.invalid" }, 403, "invalid_origin"],
        [admin, { "sec-fetch-site": "cross-site" }, 403, "invalid_origin"],
    ] as const) {
        const response = await request(path, session, headers);
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
    }
});

test("UUID validation, absence and GET-only methods do not open a list or mutation route", async () => {
    for (const [url, method, status, code] of [
        ["/api/v1/admin/generation/tasks/not-a-uuid", "GET", 400, "invalid_input"],
        [`/api/v1/admin/generation/tasks/${crypto.randomUUID()}`, "GET", 404, "not_found"],
        ["/api/v1/admin/generation/tasks", "GET", 404, "not_found"],
        [path, "POST", 405, "method_not_allowed"], [path, "DELETE", 405, "method_not_allowed"],
    ] as const) {
        const response = await request(url, admin, {}, method);
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
    }
});

test("the existing authenticated read limiter still gates the detail query", async () => {
    rejectRead = true;
    try {
        const response = await request(path);
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("1");
        expect(readIdentities.at(-1)).toBe(admin.id);
    } finally { rejectRead = false; }
});
