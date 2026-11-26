import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, like, sql } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { auditEvent, canvasDraft, rateLimit, session, user, verification } from "@infinite-canvas/database/schema";
import { containsUnresolvedMedia, createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { accountPolicy } from "../src/policy";
import { createTestDatabase } from "./database";

const origin = "http://localhost:4000";
const password = "test-only-http-password";
const secret = "test-only-" + crypto.randomUUID() + crypto.randomUUID();
const mails: { to: string; url: string }[] = [];
const faults: unknown[] = [];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let options: Parameters<typeof createAccountApi>[0];
let app: ReturnType<typeof createApp>;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let bobId: string;
let draftId: string;
let captchaCalls = 0;

function request(path: string, body?: unknown, cookie = "", peer = "198.51.100.10", method = body === undefined ? "GET" : "POST") {
    const headers = new Headers({ origin, "content-type": "application/json", "x-captcha-response": "test-pass", cookie });
    const accountId = cookie === aliceCookie ? aliceId : cookie === bobCookie ? bobId : undefined;
    if (accountId && (path.startsWith("/api/v1/canvases") || path.startsWith("/api/v1/media") || path.startsWith("/api/v1/wallet") || path.startsWith("/api/v1/admin/"))) headers.set("x-canvas-account-id", accountId);
    if (path === "/api/v1/canvases" && method === "POST" && body && typeof body === "object") body = { creationId: crypto.randomUUID(), ...body };
    return app(new Request(`${origin}${path}`, {
        method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), peer);
}
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

beforeAll(async () => {
    database = await createTestDatabase();
    options = {
        database: database.db, origin,
        cloudCanvas: true,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); }, sendResetPassword: async (mail) => { mails.push(mail); } },
        rates: createRateStore(database.pool, secret),
        verifyHuman: async (req) => { captchaCalls++; return req.headers.get("x-captcha-response") === "test-pass"; },
        onFault: (event) => { faults.push(event); },
    };
    app = createApp(createAccountApi(options), "public-test-site-key");
    for (const [name, peer] of [["http-alice", "198.51.100.1"], ["http-bob", "198.51.100.2"]]) {
        const response = await request("/api/auth/sign-up/email", { name, email: `${name}@example.test`, password }, "", peer);
        expect(response.status).toBe(200);
        expect(response.headers.has("set-cookie")).toBe(false);
        const mail = mails.find((item) => item.to === `${name}@example.test`)!;
        const verify = await app(new Request(mail.url), peer);
        expect(verify.status).toBe(302);
        const login = await request("/api/auth/sign-in/email", { email: `${name}@example.test`, password }, "", peer);
        expect(login.status).toBe(200);
        expect(login.headers.get("set-cookie")?.toLowerCase()).toContain("httponly");
        const result = await login.json();
        expect(Object.keys(result).sort()).toEqual(["ok", "requestId"]);
        if (name === "http-alice") aliceCookie = cookies(login); else bobCookie = cookies(login);
    }
    const session = await (await request("/api/v1/session", undefined, aliceCookie)).json();
    aliceId = session.user.id;
    bobId = (await (await request("/api/v1/session", undefined, bobCookie)).json()).user.id;
}, 30_000);
afterAll(async () => { if (database) await database.close(); });

describe("protected account and draft HTTP", () => {
    test("configured public metadata enables accounts without claiming complete cloud canvases", async () => {
        const site = await (await request("/api/v1/site")).json();
        expect(site.features.registration).toBe(true);
        expect(site.features.cloudCanvas).toBe(false);
        expect(site.features.recharge).toBe(false);
        expect(site.authentication.captcha.siteKey).toBe("public-test-site-key");
        expect(JSON.stringify(site)).not.toContain(secret);
        const meta = await (await request("/api/v1/meta")).json();
        expect(meta.authentication).toBe("enabled");
        expect(meta.features).toEqual(site.features);
        expect(meta.features.cloudCanvas).toBe(false);
        expect(JSON.stringify(meta)).not.toContain(secret);
    });
    test("anonymous requests and unmounted auth/admin endpoints are rejected", async () => {
        expect((await request("/api/v1/canvases")).status).toBe(401);
        expect((await request("/api/auth/get-session")).status).toBe(404);
        expect((await request("/api/auth/update-user", { role: "admin" }, aliceCookie)).status).toBe(404);
        expect((await request("/api/v1/payments", {})).status).toBe(404);
    });
    test("cloud draft routes stay closed when the server feature gate is false", async () => {
        const closed = createApp(createAccountApi({ ...options, cloudCanvas: false }), "public-test-site-key", false, false);
        const headers = new Headers({ origin, cookie: aliceCookie, "x-canvas-account-id": aliceId, "content-type": "application/json" });
        const before = await database.db.select().from(canvasDraft);
        const create = await closed(new Request(`${origin}/api/v1/canvases`, { method: "POST", headers, body: JSON.stringify({ creationId: crypto.randomUUID(), title: "closed", documentVersion: 1, document: {} }) }), "198.51.100.1");
        expect(create.status).toBe(503);
        expect(await create.json()).toMatchObject({ error: { code: "cloud_unavailable" } });
        const list = await closed(new Request(`${origin}/api/v1/canvases`, { headers }), "198.51.100.1");
        expect(list.status).toBe(503);
        expect((await database.db.select().from(canvasDraft)).length).toBe(before.length);
    });
    test("the session projection contains the account identifier without tokens or extra fields", async () => {
        const response = await request("/api/v1/session", undefined, aliceCookie);
        const result = await response.json();
        expect(result.user.id).toBe(aliceId);
        expect(result.user.email).toBe("http-alice@example.test");
        expect(Object.keys(result.user).sort()).toEqual(["email", "id", "name", "role"]);
        expect(response.headers.get("cache-control")).toBe("no-store");
    });
    test("wallet read model is account-scoped and starts with an empty immutable ledger", async () => {
        const walletResponse = await request("/api/v1/wallet", undefined, aliceCookie);
        expect(walletResponse.status).toBe(200);
        const walletResult = await walletResponse.json();
        expect(walletResult.wallet).toMatchObject({
            unit: "credit", availableUnits: "0", reservedUnits: "0", totalUnits: "0", version: 1,
        });
        expect(walletResult.wallet).not.toHaveProperty("userId");
        const ledgerResponse = await request("/api/v1/wallet/ledger", undefined, aliceCookie);
        expect(ledgerResponse.status).toBe(200);
        expect((await ledgerResponse.json()).items).toEqual([]);
        expect((await request("/api/v1/wallet", undefined, "")).status).toBe(401);
    });
    test("captcha failure, unavailable verification and missing peer fail closed", async () => {
        const req = () => new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST", headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ name: "Denied", email: "denied-http@example.test", password }),
        });
        expect((await app(req(), "198.51.100.30")).status).toBe(403);
        const unavailable = createAccountApi({ ...options, verifyHuman: async () => { throw new Error("private-provider-detail"); } });
        const failed = await unavailable(req(), "198.51.100.31");
        expect(failed.status).toBe(503);
        expect(await failed.text()).not.toContain("private-provider-detail");
        expect((await app(req())).status).toBe(503);
        expect(await database.db.select().from(user).where(eq(user.email, "denied-http@example.test"))).toHaveLength(0);
    });
    test("origin checks reject foreign and absent origins before writes", async () => {
        for (const sentOrigin of ["https://untrusted.example", undefined]) {
            const headers = new Headers({ cookie: aliceCookie, "content-type": "application/json" });
            if (sentOrigin) headers.set("origin", sentOrigin);
            const response = await app(new Request(`${origin}/api/v1/canvases`, {
                method: "POST", headers, body: JSON.stringify({ title: "x", documentVersion: 1, document: {} }),
            }), "198.51.100.32");
            expect(response.status).toBe(403);
        }
    });
    test("invalid captcha does not consume another email's sending budget", async () => {
        const email = "captcha-victim@example.test";
        const invalid = new Request(`${origin}/api/auth/request-password-reset`, {
            method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email }),
        });
        expect((await app(invalid, "198.51.100.60")).status).toBe(403);
        for (let index = 0; index < 3; index++) {
            expect((await request("/api/auth/request-password-reset", { email }, "", `198.51.100.${61 + index}`)).status).toBe(200);
        }
    });
    test("mail delivery failure cannot turn an unverified signup into a logged-in account", async () => {
        const broken = createAccountApi({ ...options, auth: { ...options.auth, sendVerificationEmail: async () => { throw new Error("smtp-private-data"); } } });
        const response = await broken(new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST", headers: { origin, "content-type": "application/json", "x-captcha-response": "test-pass" },
            body: JSON.stringify({ name: "Mail failure", email: "mail-failure-http@example.test", password }),
        }), "198.51.100.64");
        expect(response.status).toBe(503);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(await response.text()).not.toContain("smtp-private-data");
        const records = await database.db.select().from(user).where(eq(user.email, "mail-failure-http@example.test"));
        expect(records.every((record) => !record.emailVerified)).toBe(true);
    });
    test("concurrent mail failures do not contaminate another registration's result", async () => {
        const isolated = createAccountApi({ ...options, auth: { ...options.auth, sendVerificationEmail: async (mail) => {
            await Bun.sleep(5); // Synthetic overlap only, not a product delay or retry.
            if (mail.to === "mail-overlap-fail@example.test") throw new Error("synthetic-mail-failure");
        } } });
        const results = await Promise.all(["fail", "ok"].map((name, index) => isolated(new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST", headers: { origin, "content-type": "application/json", "x-captcha-response": "test-pass" },
            body: JSON.stringify({ name, email: `mail-overlap-${name}@example.test`, password }),
        }), `198.51.100.${70 + index}`)));
        expect(results.map((result) => result.status)).toEqual([503, 200]);
        expect(results.every((result) => !result.headers.has("set-cookie"))).toBe(true);
    });
    test("strict input refuses ownership, role and redirect injection", async () => {
        expect((await request("/api/v1/canvases", { title: "x", documentVersion: 1, document: {}, ownerId: "other" }, aliceCookie)).status).toBe(400);
        expect((await request("/api/auth/sign-up/email", { name: "Injected", email: "injected@example.test", password, role: "admin" }, "", "198.51.100.33")).status).toBe(400);
        expect((await request("/api/auth/request-password-reset", { email: "http-alice@example.test", redirectTo: "https://untrusted.example" }, "", "198.51.100.34")).status).toBe(400);
    });
    test("create and save record owner-scoped drafts and transactional audit events", async () => {
        const created = await request("/api/v1/canvases", { title: "HTTP 草稿", documentVersion: 1, document: { nodes: [] } }, aliceCookie);
        expect(created.status).toBe(201);
        const { draft, requestId } = await created.json();
        draftId = draft.id;
        expect(draft).not.toHaveProperty("ownerId");
        const [audit] = await database.db.select().from(auditEvent).where(eq(auditEvent.requestId, requestId));
        expect(audit).toMatchObject({ actorId: aliceId, resourceId: draft.id, revision: 1, action: "canvas.created" });
        const saved = await request(`/api/v1/canvases/${draftId}`, { title: "已保存", documentVersion: 1, document: {}, expectedRevision: 1 }, aliceCookie, undefined, "PUT");
        expect(saved.status).toBe(200);
        expect((await saved.json()).draft.revision).toBe(2);
    });
    test("a different account sees neither the draft nor its revision", async () => {
        expect((await request(`/api/v1/canvases/${draftId}`, undefined, bobCookie)).status).toBe(404);
        const denied = await request(`/api/v1/canvases/${draftId}`, { title: "steal", documentVersion: 1, document: {}, expectedRevision: 2 }, bobCookie, undefined, "PUT");
        expect(denied.status).toBe(404);
        expect(await denied.json()).not.toHaveProperty("currentRevision");
        expect((await (await request("/api/v1/canvases", undefined, bobCookie)).json()).items).toEqual([]);
    });
    test("competing HTTP saves produce one success and one 409 without overwriting", async () => {
        const responses = await Promise.all(["one", "two"].map((title) => request(`/api/v1/canvases/${draftId}`, {
            title, documentVersion: 1, document: {}, expectedRevision: 2,
        }, aliceCookie, undefined, "PUT")));
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        expect((await responses.find((response) => response.status === 409)!.json()).currentRevision).toBe(3);
    });
    test("title, document, revision and pagination are validated", async () => {
        const valid = { title: "x", documentVersion: 1, document: {} };
        for (const bad of [{ ...valid, title: "字".repeat(101) }, { ...valid, document: [] }, { ...valid, documentVersion: 2 }]) {
            expect((await request("/api/v1/canvases", bad, aliceCookie)).status).toBe(400);
        }
        for (const query of ["limit=51", "limit=0", "limit=1&limit=2", "cursor=broken", "ownerId=other"]) {
            expect((await request(`/api/v1/canvases?${query}`, undefined, aliceCookie)).status).toBe(400);
        }
    });
    test("server-side JSON draft gate refuses unresolved media without blocking prompt URLs", async () => {
        const blocked = [
            { nodes: [{ type: "image", metadata: { content: "https://cdn.example.test/image.png" } }] },
            { nodes: [{ type: "image", metadata: { storageKey: "image:local" } }] },
            { nodes: [{ type: "video", metadata: { videoTaskId: "task-1" } }] },
            { nodes: [{ type: "image", metadata: { cloudMediaId: "11111111-1111-4111-8111-111111111111" } }] },
            { nodes: [{ type: "plugin", metadata: { url: "https://cdn.example.test/plugin.bin" } }] },
            { chatSessions: [{ messages: [{ references: [{ dataUrl: "https://cdn.example.test/chat.png" }] }] }] },
        ];
        for (const document of blocked) {
            const response = await request("/api/v1/canvases", { title: "blocked", documentVersion: 1, document }, aliceCookie);
            expect(response.status).toBe(400);
            expect((await response.json()).error.code).toBe("invalid_input");
        }
        expect(containsUnresolvedMedia({ nodes: [{ type: "text", metadata: { content: "参考 https://example.test/docs" } }] })).toBe(false);
    });
    test("pagination retains microseconds and does not return document bodies", async () => {
        for (const [id, time] of [
            ["00000000-0000-4000-8000-000000000001", "2026-01-01T00:00:00.000101Z"],
            ["00000000-0000-4000-8000-000000000002", "2026-01-01T00:00:00.000102Z"],
        ]) {
            await database.db.execute(sql`INSERT INTO canvas_saas.canvas_draft (id, owner_id, title, document, created_at)
                VALUES (${id}, ${aliceId}, '分页测试', '{}', ${time}::timestamptz)`);
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const response = await request(`/api/v1/canvases?limit=1${cursor ? `&cursor=${cursor}` : ""}`, undefined, aliceCookie);
            expect(response.status).toBe(200);
            const page = await response.json();
            expect(page.items).toHaveLength(1);
            expect(page.items[0]).not.toHaveProperty("document");
            seen.push(page.items[0].id);
            cursor = page.nextCursor;
        } while (cursor && seen.length < 4);
        expect(seen).toHaveLength(3);
        expect(new Set(seen).size).toBe(3);
        expect(cursor).toBeNull();
    });
    test("a chunked oversized request with a false length cannot overwrite a draft", async () => {
        const response = await app(new Request(`${origin}/api/v1/canvases/${draftId}`, {
            method: "PUT", headers: { origin, cookie: aliceCookie, "x-canvas-account-id": aliceId, "content-type": "application/json", "content-length": "1" },
            body: new ReadableStream({ start(controller) {
                controller.enqueue(new Uint8Array(3 * 1024 * 1024));
                controller.enqueue(new Uint8Array(3 * 1024 * 1024));
                controller.close();
            } }),
        }), "198.51.100.35");
        expect(response.status).toBe(413);
        const [draft] = await database.db.select().from(canvasDraft).where(eq(canvasDraft.id, draftId));
        expect(draft.revision).toBe(3);
    });
    test("an audit insert failure rolls back the draft insert", async () => {
        await database.db.execute(sql`ALTER TABLE canvas_saas.audit_event ADD CONSTRAINT test_block_audit CHECK (action <> 'canvas.created') NOT VALID`);
        try {
            expect((await request("/api/v1/canvases", { title: "audit-must-rollback", documentVersion: 1, document: {} }, aliceCookie)).status).toBe(503);
            expect(await database.db.select().from(canvasDraft).where(eq(canvasDraft.title, "audit-must-rollback"))).toHaveLength(0);
        } finally {
            await database.db.execute(sql`ALTER TABLE canvas_saas.audit_event DROP CONSTRAINT test_block_audit`);
        }
    });
    test("database limiter failure prevents captcha and registration", async () => {
        const count = captchaCalls;
        const unavailable = createAccountApi({ ...options, rates: { consume: async () => { throw new Error("private-database-url"); } } });
        const response = await unavailable(new Request(`${origin}/api/auth/sign-up/email`, {
            method: "POST", headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ name: "Unavailable", email: "db-down@example.test", password }),
        }), "198.51.100.36");
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("private-database-url");
        expect(captchaCalls).toBe(count);
        expect(faults.every((event) => Object.keys(event as object).sort().join() === "code,component,requestId")).toBe(true);
    });
    test("disabled accounts cannot use an existing session or create a fresh one", async () => {
        await database.db.update(user).set({ disabled: true }).where(eq(user.id, aliceId));
        try {
            expect((await request("/api/v1/session", undefined, aliceCookie)).status).toBe(401);
            const login = await request("/api/auth/sign-in/email", { email: "http-alice@example.test", password }, "", "198.51.100.37");
            expect(login.status).toBe(403);
            expect(login.headers.has("set-cookie")).toBe(false);
        } finally { await database.db.update(user).set({ disabled: false }).where(eq(user.id, aliceId)); }
    });
    test("protected password reset and logout invalidate the old HTTP session", async () => {
        expect((await request("/api/auth/request-password-reset", { email: "http-alice@example.test" }, "", "198.51.100.65")).status).toBe(200);
        const mail = mails.findLast((item) => item.to === "http-alice@example.test")!;
        const callback = await app(new Request(mail.url), "198.51.100.65");
        const redirect = new URL(callback.headers.get("location")!);
        expect(redirect.origin).toBe(origin);
        expect(redirect.pathname).toBe("/reset-password");
        const token = redirect.searchParams.get("token")!;
        expect((await request("/api/auth/reset-password", { token, newPassword: `${password}-changed` }, "", "198.51.100.65")).status).toBe(200);
        const reused = await request("/api/auth/reset-password", { token, newPassword: `${password}-changed-again` }, "", "198.51.100.65");
        expect(reused.status).toBe(400);
        expect((await reused.json()).error.code).toBe("invalid_token");
        expect((await request("/api/v1/session", undefined, aliceCookie)).status).toBe(401);
        const login = await request("/api/auth/sign-in/email", { email: "http-alice@example.test", password: `${password}-changed` }, "", "198.51.100.65");
        const fresh = cookies(login);
        expect((await request("/api/auth/sign-out", {}, fresh, "198.51.100.65")).status).toBe(200);
        expect((await request("/api/v1/session", undefined, fresh)).status).toBe(401);

        expect((await request("/api/auth/request-password-reset", { email: "http-alice@example.test" }, "", "198.51.100.66")).status).toBe(200);
        const expiringMail = mails.findLast((item) => item.to === "http-alice@example.test")!;
        const expiringCallback = await app(new Request(expiringMail.url), "198.51.100.66");
        const expiringRedirect = new URL(expiringCallback.headers.get("location")!);
        const expiringToken = expiringRedirect.searchParams.get("token")!;
        await database.db.update(verification).set({ expiresAt: new Date(0) }).where(eq(verification.identifier, `reset-password:${expiringToken}`));
        const expired = await request("/api/auth/reset-password", { token: expiringToken, newPassword: `${password}-expired` }, "", "198.51.100.66");
        expect(expired.status).toBe(400);
        expect((await expired.json()).error.code).toBe("invalid_token");
    });
    test("revoke-sessions invalidates every session and expires the current cookie", async () => {
        const firstLogin = await request("/api/auth/sign-in/email", { email: "http-alice@example.test", password: `${password}-changed` }, "", "198.51.100.67");
        const firstCookie = cookies(firstLogin);
        const secondLogin = await request("/api/auth/sign-in/email", { email: "http-alice@example.test", password: `${password}-changed` }, "", "198.51.100.68");
        const secondCookie = cookies(secondLogin);
        expect(await database.db.select().from(session).where(eq(session.userId, aliceId))).toHaveLength(2);
        const crossSite = await app(new Request(`${origin}/api/auth/revoke-sessions`, {
            method: "POST",
            headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: firstCookie, "content-type": "application/json" },
            body: "{}",
        }), "198.51.100.67");
        expect(crossSite.status).toBe(403);
        expect(await database.db.select().from(session).where(eq(session.userId, aliceId))).toHaveLength(2);
        expect((await request("/api/auth/revoke-sessions", {}, "", "198.51.100.69")).status).toBe(401);
        const revoked = await request("/api/auth/revoke-sessions", {}, firstCookie, "198.51.100.67");
        expect(revoked.status).toBe(200);
        expect(revoked.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
        expect((await request("/api/v1/session", undefined, firstCookie)).status).toBe(401);
        expect((await request("/api/v1/session", undefined, secondCookie)).status).toBe(401);
    });
});

describe("database rate budgets", () => {
    test("concurrent stores share one atomic budget and persist across client recreation", async () => {
        const stores = [createRateStore(database.pool, secret), createRateStore(database.pool, secret)];
        const results = await Promise.all(Array.from({ length: 20 }, (_, index) => stores[index % 2].consume("limit-test", "private-test-email@example.test", accountPolicy.login)));
        expect(results.filter((result) => result.allowed)).toHaveLength(10);
        const denied = await createRateStore(database.pool, secret).consume("limit-test", "private-test-email@example.test", accountPolicy.login);
        expect(denied.allowed).toBe(false);
        if (!denied.allowed) expect(denied.retryAfter).toBeGreaterThan(0);
        const rows = await database.db.select().from(rateLimit).where(like(rateLimit.key, "limit-test:%"));
        expect(JSON.stringify(rows)).not.toContain("private-test-email@example.test");
        await database.db.update(rateLimit).set({ expire: 0 }).where(like(rateLimit.key, "limit-test:%"));
        expect((await stores[0].consume("limit-test", "private-test-email@example.test", accountPolicy.login)).allowed).toBe(true);
    });
    test("expired counters can be removed through the explicit cleanup boundary", async () => {
        const store = createRateStore(database.pool, secret);
        await store.consume("cleanup-test", "private-cleanup@example.test", accountPolicy.login);
        const before = await database.db.select().from(rateLimit).where(like(rateLimit.key, "cleanup-test:%"));
        expect(before.length).toBeGreaterThan(0);
        const removed = await store.cleanupExpired!(Date.now() + 60 * 60 * 1000);
        expect(removed).toBeGreaterThanOrEqual(before.length);
        expect(await database.db.select().from(rateLimit).where(like(rateLimit.key, "cleanup-test:%"))).toHaveLength(0);
    });
    test("mail limits aggregate by email across different source IPs", async () => {
        for (let i = 0; i < 3; i++) {
            expect((await request("/api/auth/request-password-reset", { email: "unknown-budget@example.test" }, "", `198.51.100.${50 + i}`)).status).toBe(200);
        }
        const blocked = await request("/api/auth/send-verification-email", { email: "unknown-budget@example.test" }, "", "198.51.100.55");
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    });
    test("real HTTP derives the login budget from the socket, not forged forwarding headers", async () => {
        let liveApp: ReturnType<typeof createApp>;
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => liveApp(req, srv.requestIP(req)?.address) });
        const liveOrigin = `http://127.0.0.1:${server.port}`;
        liveApp = createApp(createAccountApi({ ...options, origin: liveOrigin }), "public-test-site-key");
        try {
            for (let index = 0; index < 11; index++) {
                const response = await fetch(`${liveOrigin}/api/auth/sign-in/email`, {
                    method: "POST", headers: { origin: liveOrigin, "content-type": "application/json", "x-captcha-response": "test-pass",
                        "x-forwarded-for": `192.0.2.${index + 1}`, "x-canvas-peer-ip": `192.0.2.${index + 1}` },
                    body: JSON.stringify({ email: "unknown-wire@example.test", password }),
                });
                expect(response.status).toBe(index < 10 ? 401 : 429);
                await response.text();
            }
        } finally { await server.stop(true); }
    }, 30_000);
});
