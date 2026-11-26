import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "@infinite-canvas/auth";
import { user } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { readContentSafetyConfig } from "../src/content-safety-config";
import { createTestDatabase, postgresTestUrl } from "./database";

const enabled = process.env.Q1_SAFETY_POSTGRES === "1";
const pgTest = enabled ? test : test.skip;
if (enabled && (!postgresTestUrl() || process.env.DATABASE_URL)) throw new Error("仅接受Q1 runner新建的隔离PG16目标");
const secret = crypto.randomUUID() + crypto.randomUUID(), password = "q1-http-integration-password";
const contentSafety = readContentSafetyConfig({ SAAS_ACCOUNT_MODERATION_ENABLED: "true", SAAS_ABUSE_REPORTS_ENABLED: "true" });
let database: Awaited<ReturnType<typeof createTestDatabase>>, origin: string, server: ReturnType<typeof Bun.serve>;
let active: ReturnType<typeof createAccountApi>, closed: ReturnType<typeof createAccountApi>, features = true;
type Identity = { id: string; cookie: string; email: string };
let admin: Identity, alice: Identity, bob: Identity;
const cookie = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
function call(path: string, actor?: Identity, body?: unknown, method = body === undefined ? "GET" : "POST", extra: Record<string, string> = {}) {
    return fetch(origin + path, { method, redirect: "manual", headers: { origin, "content-type": "application/json",
        ...(actor ? { cookie: actor.cookie, "x-canvas-account-id": actor.id } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const signIn = (email: string) => call("/api/auth/sign-in/email", undefined, { email, password });
beforeAll(async () => {
    if (!enabled) return;
    database = await createTestDatabase();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => (features ? active : closed)(request, "127.0.0.1") });
    origin = server.url.origin;
    const mail = { secret, sendVerificationEmail: async () => {}, sendResetPassword: async () => {} };
    const options: Parameters<typeof createAccountApi>[0] = { database: database.db, origin, auth: mail,
        rates: { consume: async () => ({ allowed: true }) }, verifyHuman: async () => true, onFault: () => {} };
    active = createAccountApi({ ...options, contentSafety }); closed = createAccountApi(options);
    const auth = createAuth({ ...mail, database: database.db, baseURL: origin });
    async function identity(role: "user" | "admin"): Promise<Identity> {
        const email = `q1-http-${crypto.randomUUID()}@fixture.invalid`;
        const signup = await auth.handler(new Request(origin + "/api/auth/sign-up/email", { method: "POST",
            headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ name: "Q1合成HTTP账号", email, password }) }));
        expect(signup.status).toBe(200);
        const [owner] = await database.db.select().from(user).where(eq(user.email, email));
        await database.db.update(user).set({ role, emailVerified: true }).where(eq(user.id, owner.id));
        const login = await signIn(email); expect(login.status).toBe(200);
        return { id: owner.id, email, cookie: cookie(login) };
    }
    admin = await identity("admin"); alice = await identity("user"); bob = await identity("user");
    console.log(JSON.stringify({ case: "q1_real_http_boundary", hostname: server.hostname, port: server.port, database: "isolated-pg16" }));
}, 30_000);
afterAll(async () => { if (server) await server.stop(true); await database?.close(); });

pgTest("real HTTP moderation routes reject forged identity, wrong scope and ordinary users", async () => {
    const path = `/api/v1/admin/users/${alice.id}/moderation`;
    expect((await call(path)).status).toBe(401);
    expect((await call(path, alice)).status).toBe(403);
    expect((await call(path, admin, undefined, "GET", { "x-canvas-account-id": bob.id })).status).toBe(409);
    expect((await call(path, admin, undefined, "GET", { origin: "https://outside.fixture.invalid" })).status).toBe(403);
    const original = (await (await call(path, admin)).json()).item;
    expect(original).toEqual({ userId: alice.id, disabled: false, moderationVersion: 0 });
    const forged = await call(path, admin, { operationId: crypto.randomUUID(), expectedVersion: 0, disabled: true, reason: "合成原因", actorId: bob.id }, "PUT");
    expect(forged.status).toBe(400);
    expect((await (await call(path, admin)).json()).item).toEqual(original);
});

pgTest("actual HTTP ban and unban invalidate old cookies and return owner-bound immutable operation receipts", async () => {
    const path = `/api/v1/admin/users/${alice.id}/moderation`, operationId = crypto.randomUUID();
    const input = { operationId, disabled: true, expectedVersion: 0, reason: "仅合成HTTP处置原因" };
    const response = await call(path, admin, input, "PUT"), result = await response.json();
    expect(response.status).toBe(200);
    expect(result.item).toMatchObject({ operationId, targetUserId: alice.id, disabled: true, revision: 1 });
    expect(response.headers.get("x-canvas-account-id")).toBe(admin.id);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe(result.requestId);
    expect((await call("/api/v1/session", alice)).status).toBe(401);
    expect((await signIn(alice.email)).status).toBe(403);
    const enabledAgain = await call(path, admin, { operationId: crypto.randomUUID(), disabled: false, expectedVersion: 1, reason: "仅合成解封" }, "PUT");
    expect(enabledAgain.status).toBe(200);
    expect((await call("/api/v1/session", alice)).status).toBe(401);
    const fresh = await signIn(alice.email); expect(fresh.status).toBe(200); alice.cookie = cookie(fresh);
    expect((await call("/api/v1/session", alice)).status).toBe(200);
    const replay = await call(path, admin, input, "PUT");
    expect((await replay.json()).item).toEqual(result.item);
    expect((await (await call(path, admin)).json()).item).toEqual({ userId: alice.id, disabled: false, moderationVersion: 2 });
    expect((await (await call(`/api/v1/admin/moderation/operations/${operationId}`, admin)).json()).item).toEqual(result.item);
    expect((await call(`/api/v1/admin/moderation/operations/${operationId}`, bob)).status).toBe(403);
    const audits = (await database.db.execute(sql`SELECT action, revision, actor_id FROM canvas_saas.audit_event WHERE resource_id = ${alice.id} ORDER BY revision`)).rows;
    expect(audits).toEqual([{ action: "user.disabled", revision: 1, actor_id: admin.id }, { action: "user.enabled", revision: 2, actor_id: admin.id }]);
});

pgTest("formal HTTP report collection and detail routes keep owner isolation and record receipt once", async () => {
    const id = crypto.randomUUID(), input = { id, subject: "合成HTTP投诉", details: "不是真实举报，不包含账号秘密。" };
    expect((await call("/api/v1/abuse-reports", alice, { ...input, reporterId: bob.id })).status).toBe(400);
    const first = await call("/api/v1/abuse-reports", alice, input); expect(first.status).toBe(200);
    expect((await (await call("/api/v1/abuse-reports", alice, input)).json()).item.id).toBe(id);
    expect((await call(`/api/v1/abuse-reports/${id}`, bob)).status).toBe(404);
    expect((await call(`/api/v1/admin/abuse-reports/${id}`, alice)).status).toBe(403);
    expect((await (await call("/api/v1/admin/abuse-reports", admin)).json()).items.some((item: { id: string }) => item.id === id)).toBe(true);
    const received = await call(`/api/v1/admin/abuse-reports/${id}/receipt`, admin, { expectedVersion: 1 }, "PUT");
    expect(received.status).toBe(200);
    expect((await received.json()).item).toMatchObject({ id, status: "received", revision: 2 });
    expect((await call(`/api/v1/admin/abuse-reports/${id}/receipt`, admin, { expectedVersion: 1 }, "PUT")).status).toBe(409);
    expect((await (await call(`/api/v1/abuse-reports/${id}`, alice)).json()).item.status).toBe("received");
    expect((await (await call(`/api/v1/admin/abuse-reports/${id}`, admin)).json()).item.status).toBe("received");
    expect((await database.db.execute(sql`SELECT action FROM canvas_saas.audit_event WHERE resource_id = ${id} ORDER BY revision`)).rows)
        .toEqual([{ action: "abuse.report.submitted" }, { action: "abuse.report.received" }]);
    expect((await database.db.select({ disabled: user.disabled }).from(user).where(eq(user.id, alice.id)))[0].disabled).toBe(false);
});

pgTest("all safety flags off close writes while formal auth still works against its required version columns", async () => {
    features = false;
    try {
        expect((await call("/api/v1/session", alice)).status).toBe(200);
        const moderation = await call(`/api/v1/admin/users/${bob.id}/moderation`, admin);
        expect(moderation.status).toBe(503); expect((await moderation.json()).error.code).toBe("moderation_unavailable");
        const reports = await call("/api/v1/abuse-reports", alice, { id: crypto.randomUUID(), subject: "不能提交", details: "关闭默认" });
        expect(reports.status).toBe(503); expect((await reports.json()).error.code).toBe("abuse_reports_unavailable");
    } finally { features = true; }
});
