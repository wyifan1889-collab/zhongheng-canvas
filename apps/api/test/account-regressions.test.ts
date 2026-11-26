import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { canvasDraft, session, user } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createTestDatabase } from "./database";

// Only isolated databases and simulated services; HTTPS here tests cookie attributes, not TLS deployment.
const origin = "https://canvas.example.test";
const email = "regression-owner@example.test";
const password = "synthetic-regression-password";
const secret = "test-only-" + crypto.randomUUID() + crypto.randomUUID();
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let options: Parameters<typeof createAccountApi>[0];
let api: ReturnType<typeof createAccountApi>;
let ownerId: string;
let cookie: string;
let rateMode: "allow" | "deny" | "outage" = "allow";
let mailFailure = false;
const rateCalls: string[] = [];
const faults: unknown[] = [];
const mails: { to: string; url: string }[] = [];

function input(path: string, body?: unknown, sentCookie = cookie, site = origin, method = body === undefined ? "GET" : "POST") {
    const headers = new Headers({ origin: site, cookie: sentCookie, "content-type": "application/json" });
    if (ownerId && path.startsWith("/api/v1/canvases")) headers.set("x-canvas-account-id", ownerId);
    if (path === "/api/v1/canvases" && method === "POST" && body && typeof body === "object") body = { creationId: crypto.randomUUID(), ...body };
    return new Request(site + path, {
        method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
const request = (path: string, body?: unknown, method?: string) => api(input(path, body, cookie, origin, method), "198.51.100.80");
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
async function ageSession() {
    // Change only this synthetic account's timestamps, never the system clock or product policy.
    await database.db.update(session).set({
        createdAt: sql`now() - interval '2 days'`, updatedAt: sql`now() - interval '2 days'`,
        expiresAt: sql`now() + interval '5 days'`,
    }).where(eq(session.userId, ownerId));
}
function expectRenewal(response: Response, cacheControl: "no-store" | "private, no-store" = "no-store") {
    const values = response.headers.getSetCookie();
    expect(values).toHaveLength(1);
    expect(values[0]).toContain("__Secure-better-auth.session_token=");
    expect(values[0].toLowerCase()).toContain("httponly");
    expect(values[0]).toMatch(/;\s*Secure(?:;|$)/i);
    expect(values[0].toLowerCase()).toContain("samesite=lax");
    expect(values[0].toLowerCase()).toContain("path=/");
    expect(values[0]).toMatch(/Max-Age=[1-9]\d*/i);
    expect(response.headers.get("cache-control")).toBe(cacheControl);
}
async function expectFault(response: Response, code: string) {
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(faults).toEqual([{ requestId: body.requestId, component: "accounts", code }]);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("synthetic-private");
    expect(JSON.stringify(body)).not.toContain(password);
    return body;
}

beforeAll(async () => {
    database = await createTestDatabase();
    const send = async (mail: { to: string; url: string }) => {
        if (mailFailure) throw new Error(`synthetic-private smtp://credentials@example.test ${mail.url} ${mail.to}`);
        mails.push(mail);
    };
    options = {
        database: database.db, origin,
        cloudCanvas: true,
        auth: { secret, sendVerificationEmail: send, sendResetPassword: send },
        rates: { consume: async (bucket) => {
            rateCalls.push(bucket);
            if (rateMode === "outage") throw new Error("synthetic-private-database-connection");
            return rateMode === "deny" ? { allowed: false, retryAfter: 7 } : { allowed: true };
        } },
        verifyHuman: async () => true,
        onFault: (event) => { faults.push(event); },
    };
    api = createAccountApi(options);
    expect((await api(input("/api/auth/sign-up/email", { name: "Regression", email, password }, ""), "198.51.100.80")).status).toBe(200);
    expect((await api(new Request(mails[0].url), "198.51.100.80")).status).toBe(302);
    const [owner] = await database.db.select().from(user).where(eq(user.email, email));
    ownerId = owner.id;
}, 30_000);
beforeEach(async () => {
    rateMode = "allow";
    mailFailure = false;
    const login = await api(input("/api/auth/sign-in/email", { email, password }, ""), "198.51.100.80");
    expect(login.status).toBe(200);
    cookie = cookies(login);
    rateCalls.length = 0;
    faults.length = 0;
});
afterAll(async () => { if (database) await database.close(); });

describe("session renewal response boundary", () => {
    test("a fresh session does not issue a needless renewal", async () => {
        const response = await request("/api/v1/session");
        expect(response.status).toBe(200);
        expect(response.headers.getSetCookie()).toHaveLength(0);
    });
    test("due session renewal reaches the browser without exposing the session in JSON", async () => {
        await ageSession();
        const before = await database.db.select().from(session).where(eq(session.userId, ownerId));
        const response = await request("/api/v1/session");
        expect(response.status).toBe(200);
        expectRenewal(response);
        expect(await response.json()).toEqual({ user: { id: ownerId, name: "Regression", email, role: "user" } });
        const after = await database.db.select().from(session).where(eq(session.userId, ownerId));
        expect(after.some((record) => record.expiresAt.getTime() > before.find((old) => old.id === record.id)!.expiresAt.getTime())).toBe(true);
        expect(rateCalls).toEqual(["account-read"]);
        const renewed = await api(input("/api/v1/session", undefined, cookies(response)), "198.51.100.80");
        expect(renewed.status).toBe(200);
        expect(renewed.headers.getSetCookie()).toHaveLength(0);
    });
    test("list, create, detail, save and conflict responses retain renewal cookies", async () => {
        await ageSession();
        const created = await request("/api/v1/canvases", { title: "renewal", documentVersion: 1, document: {} });
        expect(created.status).toBe(201);
        expectRenewal(created, "private, no-store");
        const { draft } = await created.json();
        for (const path of ["/api/v1/canvases", `/api/v1/canvases/${draft.id}`]) {
            await ageSession();
            const response = await request(path);
            expect(response.status).toBe(200);
            expectRenewal(response, path === "/api/v1/canvases" ? "no-store" : "private, no-store");
        }
        for (const status of [200, 409]) {
            await ageSession();
            const response = await request(`/api/v1/canvases/${draft.id}`, {
                title: "saved", documentVersion: 1, document: {}, expectedRevision: 1,
            }, "PUT");
            expect(response.status).toBe(status);
            expectRenewal(response, status === 200 ? "private, no-store" : "no-store");
        }
        expect(rateCalls).toEqual(["canvas-save", "account-read", "account-read", "canvas-save", "canvas-save"]);
    });
    test("renewal cannot bypass rate refusal or a rate-store outage", async () => {
        const before = await database.db.select().from(canvasDraft).where(eq(canvasDraft.ownerId, ownerId));
        for (const mode of ["deny", "outage"] as const) {
            await ageSession();
            rateMode = mode;
            const response = await request("/api/v1/canvases", { title: "must-not-save", documentVersion: 1, document: {} });
            expect(response.status).toBe(mode === "deny" ? 429 : 503);
            // Authentication already renewed before the business limiter; retain that cookie even on refusal.
            expectRenewal(response);
            if (mode === "deny") {
                expect(response.headers.get("retry-after")).toBe("7");
                expect(faults).toEqual([]);
                expect((await response.json()).error.code).toBe("rate_limited");
            } else await expectFault(response, "service_unavailable");
        }
        expect(await database.db.select().from(canvasDraft).where(eq(canvasDraft.ownerId, ownerId))).toEqual(before);
        expect(rateCalls).toEqual(["canvas-save", "canvas-save"]);
    });
    test("disabled, unverified, expired and revoked sessions cannot be renewed into access", async () => {
        for (const state of [{ disabled: true }, { emailVerified: false }]) {
            await ageSession();
            await database.db.update(user).set(state).where(eq(user.id, ownerId));
            try {
                const response = await request("/api/v1/session");
                expect(response.status).toBe(401);
                expect(response.headers.getSetCookie()).toHaveLength(0);
            } finally {
                await database.db.update(user).set({ disabled: false, emailVerified: true }).where(eq(user.id, ownerId));
            }
        }
        await database.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.userId, ownerId));
        const expired = await request("/api/v1/session");
        expect(expired.status).toBe(401);
        expect(expired.headers.getSetCookie()).toHaveLength(0);
        await database.db.delete(session).where(eq(session.userId, ownerId));
        const revoked = await request("/api/v1/session");
        expect(revoked.status).toBe(401);
        expect(revoked.headers.getSetCookie()).toHaveLength(0);
        expect(rateCalls).toEqual([]);
        expect(faults).toEqual([]);
    });
    test("renewal survives the actual Bun HTTP response transport", async () => {
        let local: ReturnType<typeof createAccountApi>;
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => local(req, srv.requestIP(req)?.address) });
        const localOrigin = `http://127.0.0.1:${server.port}`;
        local = createAccountApi({ ...options, origin: localOrigin });
        try {
            const login = await fetch(input("/api/auth/sign-in/email", { email, password }, "", localOrigin));
            expect(login.status).toBe(200);
            const localCookie = cookies(login);
            await login.text();
            await ageSession();
            const response = await fetch(input("/api/v1/session", undefined, localCookie, localOrigin));
            expect(response.status).toBe(200);
            expect(response.headers.getSetCookie()).toHaveLength(1);
            expect(response.headers.get("set-cookie")?.toLowerCase()).toContain("httponly");
            expect((await response.json()).user.id).toBe(ownerId);
        } finally { await server.stop(true); }
    });
});

describe("safe request-level fault events", () => {
    test("failed signup, verification resend and reset mail each emit one safe fault", async () => {
        mailFailure = true;
        for (const [path, body] of [
            ["/api/auth/sign-up/email", { name: "Mail failure", email: "regression-mail-failure@example.test", password }],
            ["/api/auth/send-verification-email", { email: "regression-mail-failure@example.test" }],
            ["/api/auth/request-password-reset", { email }],
        ] as const) {
            faults.length = 0;
            const response = await api(input(path, body, ""), "198.51.100.80");
            const result = await expectFault(response, "mail_unavailable");
            expect(result.error.code).toBe("mail_unavailable");
            expect(response.headers.getSetCookie()).toHaveLength(0);
        }
    });
    test("an authentication library 5xx emits a safe fault without raw console output", async () => {
        // Force an actual auth session-insert failure only for this synthetic request's IP.
        await database.db.execute(sql`ALTER TABLE canvas_saas.session ADD CONSTRAINT regression_auth_fault
            CHECK (ip_address <> '198.51.100.81') NOT VALID`);
        const rawLog = spyOn(console, "error").mockImplementation(() => {});
        try {
            const response = await api(input("/api/auth/sign-in/email", { email, password }), "198.51.100.81");
            expect((await expectFault(response, "auth_unavailable")).error.code).toBe("auth_rejected");
            expect(rawLog).not.toHaveBeenCalled();
        } finally {
            rawLog.mockRestore();
            await database.db.execute(sql`ALTER TABLE canvas_saas.session DROP CONSTRAINT regression_auth_fault`);
        }
    });
    test("expected client errors produce no server-fault event", async () => {
        expect((await request("/api/auth/sign-in/email", { email, password: "wrong-password" })).status).toBe(401);
        expect((await request("/api/auth/sign-up/email", { role: "admin" })).status).toBe(400);
        expect((await api(input("/api/v1/session", undefined, "tampered"), "198.51.100.80")).status).toBe(401);
        expect(faults).toEqual([]);
    });
    test("a broken fault sink cannot replace the safe failure response", async () => {
        mailFailure = true;
        let events = 0;
        const brokenSink = createAccountApi({ ...options, onFault: () => { events++; throw new Error("synthetic-private-log-sink"); } });
        const response = await brokenSink(input("/api/auth/request-password-reset", { email }), "198.51.100.80");
        expect(response.status).toBe(503);
        expect(events).toBe(1);
        const body = await response.json();
        expect(body.error.code).toBe("mail_unavailable");
        expect(JSON.stringify(body)).not.toContain("synthetic-private");
    });
    test("parallel success and mail failure do not mix request IDs or fault events", async () => {
        const concurrent = createAccountApi({ ...options, auth: { ...options.auth, sendVerificationEmail: async (mail) => {
            await Bun.sleep(5); // Synthetic overlap, not a product timeout or retry policy.
            if (mail.to === "regression-parallel-fail@example.test") throw new Error("synthetic-private-mail");
        } } });
        const results = await Promise.all(["fail", "ok"].map((suffix) => concurrent(input("/api/auth/sign-up/email", {
            name: suffix, email: `regression-parallel-${suffix}@example.test`, password,
        }), "198.51.100.80")));
        await expectFault(results[0], "mail_unavailable");
        expect(results[1].status).toBe(200);
        const success = await results[1].json();
        expect(faults).not.toContainEqual(expect.objectContaining({ requestId: success.requestId }));
    });
});

describe("R02 authentication budgets", () => {
    test("OTP verification and reset submission are independently rate-limited", async () => {
        rateMode = "deny";
        const otp = await api(input("/api/auth/email-otp/verify-email", { email, otp: "000000" }), "198.51.100.82");
        expect(otp.status).toBe(429);
        expect(otp.headers.get("retry-after")).toBe("7");
        expect((await otp.json()).error.code).toBe("rate_limited");

        rateMode = "outage";
        const reset = await api(input("/api/auth/reset-password", { token: "synthetic-reset-token", newPassword: password }), "198.51.100.83");
        expect(reset.status).toBe(503);
        expect(reset.headers.get("retry-after")).toBeNull();
        expect((await reset.json()).error.code).toBe("service_unavailable");
        expect(faults).toEqual([{ requestId: expect.any(String), component: "accounts", code: "service_unavailable" }]);
    });

    test("verification and reset link GETs consume IP and token budgets", async () => {
        rateMode = "deny";
        const verification = await api(new Request(`${origin}/api/auth/verify-email?token=synthetic-token`, { headers: { origin } }), "198.51.100.84");
        expect(verification.status).toBe(429);
        expect(verification.headers.get("retry-after")).toBe("7");
        expect((await verification.json()).error.code).toBe("rate_limited");
    });
});
