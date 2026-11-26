import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "@infinite-canvas/auth";
import { generationRateSettings, session, user, walletLedger } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { checkAccountDatabaseReadiness } from "../src/readiness";
import { readContentSafetyConfig } from "../src/content-safety-config";
import { createTestDatabase } from "./database";

const origin = "http://localhost:4000", password = "synthetic-integration-password";
const secret = crypto.randomUUID() + crypto.randomUUID();
const contentSafety = readContentSafetyConfig({ SAAS_ACCOUNT_MODERATION_ENABLED: "true", SAAS_ABUSE_REPORTS_ENABLED: "true", SAAS_CONTENT_SAFETY_MODE: "record" });
let database: Awaited<ReturnType<typeof createTestDatabase>>, api: ReturnType<typeof createAccountApi>, closed: ReturnType<typeof createAccountApi>;
type Identity = { id: string; cookie: string };
let admin: Identity, alice: Identity, bob: Identity, revoking: Identity;
let hold: { actorId: string; entered: () => void; wait: Promise<void> } | undefined;

async function identity(auth: ReturnType<typeof createAuth>, role: "user" | "admin"): Promise<Identity> {
    const email = `payment-safety-${crypto.randomUUID()}@example.test`;
    const authRequest = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth/${path}`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await authRequest("sign-up/email", { name: "隔离接线账号", email, password })).status).toBe(200);
    const [owner] = await database.db.select().from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true, role }).where(eq(user.id, owner.id));
    const login = await authRequest("sign-in/email", { email, password });
    expect(login.status).toBe(200);
    return { id: owner.id, cookie: login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}
function request(path: string, actor?: Identity, body?: unknown, method = body === undefined ? "GET" : "POST", extra: Record<string, string> = {}) {
    return new Request(`${origin}${path}`, { method,
        headers: { origin, "content-type": "application/json", ...(actor ? { cookie: actor.cookie, "x-canvas-account-id": actor.id } : {}), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
const call = (path: string, actor?: Identity, body?: unknown, method?: string, extra?: Record<string, string>) => api(request(path, actor, body, method, extra), "198.51.100.70");

beforeAll(async () => {
    database = await createTestDatabase();
    const mail = { secret, sendVerificationEmail: async () => {}, sendResetPassword: async () => {} };
    const auth = createAuth({ ...mail, database: database.db, baseURL: origin });
    admin = await identity(auth, "admin"); alice = await identity(auth, "user"); bob = await identity(auth, "user"); revoking = await identity(auth, "admin");
    const options: Parameters<typeof createAccountApi>[0] = { database: database.db, origin, auth: mail,
        rates: { consume: async (_bucket, actorId) => {
            const current = hold;
            if (current?.actorId === actorId) { current.entered(); await current.wait; }
            return { allowed: true };
        } }, verifyHuman: async () => true, onFault: () => {} };
    api = createAccountApi({ ...options, contentSafety }); closed = createAccountApi(options);
}, 30_000);
afterAll(async () => { await database?.close(); });

test("formal safety schema is ready only with the enabled immutable receipt and exact state guards", async () => {
    const target = { query: (text: string, values?: readonly unknown[]) => database.pool.query({ text, values: values ? [...values] : undefined }) };
    expect(await checkAccountDatabaseReadiness(target, false, contentSafety)).toBe(true);
    await database.db.execute(sql`ALTER TABLE canvas_saas.account_moderation_operation DISABLE TRIGGER account_moderation_operation_immutable`);
    try {
        expect(await checkAccountDatabaseReadiness(target, false, contentSafety)).toBe(false);
        expect(await checkAccountDatabaseReadiness(target, false)).toBe(true);
    } finally { await database.db.execute(sql`ALTER TABLE canvas_saas.account_moderation_operation ENABLE TRIGGER account_moderation_operation_immutable`); }
    await database.db.execute(sql`ALTER TABLE canvas_saas.abuse_report DROP CONSTRAINT abuse_report_receipt`);
    try { expect(await checkAccountDatabaseReadiness(target, false, contentSafety)).toBe(false); }
    finally {
        await database.db.execute(sql`ALTER TABLE canvas_saas.abuse_report ADD CONSTRAINT abuse_report_receipt CHECK (
            (status = 'submitted' AND received_by IS NULL AND received_at IS NULL) OR
            (status = 'received' AND received_by IS NOT NULL AND received_at IS NOT NULL))`);
    }
    expect(await checkAccountDatabaseReadiness(target, false, contentSafety)).toBe(true);
});

test("safety paths retain origin, login, account context and explicit default-off gates", async () => {
    const path = `/api/v1/admin/users/${alice.id}/moderation`;
    expect((await call(path)).status).toBe(401);
    expect((await call(path, admin, undefined, "GET", { origin: "https://outside.example.test" })).status).toBe(403);
    expect((await call(path, admin, undefined, "GET", { "x-canvas-account-id": "" })).status).toBe(400);
    expect((await call(path, admin, undefined, "GET", { "x-canvas-account-id": bob.id })).status).toBe(409);
    expect((await closed(request(path, admin), "198.51.100.70")).status).toBe(503);
    expect((await closed(request("/api/v1/abuse-reports", alice, { id: crypto.randomUUID(), subject: "合成", details: "仅隔离测试" }), "198.51.100.70")).status).toBe(503);
    expect((await call(`${path}/extra`, admin)).status).toBe(404);
    const response = await call(path, admin), body = await response.json();
    expect(response.status).toBe(200);
    expect(body.item).toEqual({ userId: alice.id, disabled: false, moderationVersion: 0 });
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(response.headers.get("x-canvas-account-id")).toBe(admin.id);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("real report handlers share the account API envelope and owner boundary", async () => {
    const id = crypto.randomUUID();
    const created = await call("/api/v1/abuse-reports", alice, { id, subject: "接线核对", details: "这是隔离合成投诉" });
    expect(created.status).toBe(200);
    expect((await created.json()).item).toMatchObject({ id, status: "submitted", revision: 1 });
    expect((await call(`/api/v1/abuse-reports/${id}`, bob)).status).toBe(404);
    const own = await call(`/api/v1/abuse-reports/${id}`, alice);
    expect((await own.json()).item.id).toBe(id);
    const receipt = await call(`/api/v1/admin/abuse-reports/${id}/receipt`, admin, { expectedVersion: 1 }, "PUT");
    expect(receipt.status).toBe(200);
    expect((await receipt.json()).item).toMatchObject({ id, status: "received", revision: 2 });
});

test("a revoked administrator between HTTP authentication and balance write is rejected inside the write transaction", async () => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    hold = { actorId: revoking.id, entered, wait: new Promise<void>(resolve => { release = resolve; }) };
    const response = call(`/api/v1/admin/users/${bob.id}/balance`, revoking, { amount: "0.25", reason: "不得提交的隔离调整" }, "POST", { "idempotency-key": crypto.randomUUID() });
    try {
        await reached;
        await database.db.delete(session).where(eq(session.userId, revoking.id));
    } finally { hold = undefined; release(); }
    const result = await response;
    expect(result.status).toBe(409);
    expect((await result.json()).error.code).toBe("account_changed");
    expect(await database.db.select().from(walletLedger).where(eq(walletLedger.userId, bob.id))).toEqual([]);
});

test("actual account entry registers generation policy read, explicit publication and original operation receipt", async () => {
    const path = "/api/v1/admin/content-safety/settings";
    expect((await call(path)).status).toBe(401);
    expect((await call(path, alice)).status).toBe(403);
    expect((await call(path, admin, undefined, "GET", { origin: "https://outside.example.test" })).status).toBe(403);
    expect((await call(path, admin, undefined, "GET", { "x-canvas-account-id": bob.id })).status).toBe(409);
    const response = await call(path, admin), initial = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-canvas-account-id")).toBe(admin.id);
    expect(initial.config).toMatchObject({ revision: 0, publicationId: null, source: "server-default", checkpointMode: "record",
        policy: { ip: { enabled: true, points: 10, duration: 3600 }, user: { enabled: true, points: 50, duration: 86400 } } });
    const input = { operationId: crypto.randomUUID(), expectedRevision: 0,
        policy: { ip: { enabled: true, points: 8 }, user: { enabled: true, points: 40 } } };
    expect((await call(path, admin, { ...input, actorId: alice.id }, "PUT")).status).toBe(400);
    const saved = await call(path, admin, input, "PUT"), result = await saved.json();
    expect(saved.status).toBe(200);
    expect(result.receipt).toMatchObject({ operationId: input.operationId, publishedRevision: 1,
        policy: { ip: { enabled: true, points: 8, duration: 3600 }, user: { enabled: true, points: 40, duration: 86400 } } });
    const receipt = await call(`${path}/operations/${input.operationId}`, admin);
    expect(receipt.status).toBe(200);
    expect((await receipt.json()).receipt).toEqual(result.receipt);
    const current = await call(path, admin);
    expect((await current.json()).config).toMatchObject({ source: "published", publicationId: input.operationId, revision: 1, policy: result.receipt.policy });
    expect((await call(path, admin, { ...input, operationId: crypto.randomUUID() }, "PUT")).status).toBe(409);
    expect((await call(`${path}/operations/${crypto.randomUUID()}`, admin)).status).toBe(404);
});

test("actual policy GET fails closed when the persisted pointer is absent instead of showing defaults", async () => {
    const [saved] = await database.db.select().from(generationRateSettings).where(eq(generationRateSettings.id, "generation"));
    expect(saved.revision).toBe(1);
    await database.db.delete(generationRateSettings).where(eq(generationRateSettings.id, "generation"));
    try {
        const response = await call("/api/v1/admin/content-safety/settings", admin);
        expect(response.status).toBe(503);
        expect((await response.json()).error.code).toBe("rate_settings_unavailable");
    } finally { await database.db.insert(generationRateSettings).values(saved); }
});
