import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAuth, getPrincipal } from "@infinite-canvas/auth";
import { createDatabase } from "@infinite-canvas/database";
import { createDraftRepository } from "@infinite-canvas/database/drafts";
import { account, session, user } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

const origin = "http://localhost:4000";
const password = "local-test-password-not-a-real-credential";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let drafts: ReturnType<typeof createDraftRepository>;
const verificationMail: Array<{ to: string; url: string }> = [];
const resetMail: Array<{ to: string; url: string }> = [];
let alice: string;
let bob: string;
let cookie: string;

function request(path: string, body?: unknown, sessionCookie?: string, requestOrigin = origin) {
    return auth.handler(new Request(`${origin}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            origin: requestOrigin,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(sessionCookie ? { cookie: sessionCookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
}

beforeAll(async () => {
    database = await createTestDatabase();
    auth = createAuth({
        database: database.db, baseURL: origin, secret: "test-only-" + crypto.randomUUID() + crypto.randomUUID(),
        sendVerificationEmail: async (mail) => { verificationMail.push(mail); },
        sendResetPassword: async (mail) => { resetMail.push(mail); },
    });
    drafts = createDraftRepository(database.db);
}, 30_000);

afterAll(async () => { if (database) await database.close(); });

describe("authentication and session boundary (local only)", () => {
    test("signup cannot set an administrator role or bypass email verification", async () => {
        const response = await request("/sign-up/email", {
            name: "Alice", email: "alice@example.test", password, role: "admin", emailVerified: true,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
        const [record] = await database.db.select().from(user).where(eq(user.email, "alice@example.test"));
        alice = record.id;
        expect(record.role).toBe("user");
        expect(record.emailVerified).toBe(false);
        expect(record.disabled).toBe(false);
        const [credential] = await database.db.select().from(account).where(eq(account.userId, alice));
        expect(credential.password).not.toBe(password);
        expect(credential.password).toBeTruthy();
        const denied = await request("/sign-in/email", { email: record.email, password });
        expect(denied.status).toBe(403);
    });

    test("verification permits login and a server-resolved principal", async () => {
        const mail = verificationMail.find((item) => item.to === "alice@example.test")!;
        expect(mail).toBeDefined();
        const verified = await auth.handler(new Request(mail.url));
        expect(verified.status).toBeLessThan(400);
        const login = await request("/sign-in/email", { email: "alice@example.test", password });
        expect(login.status).toBe(200);
        cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        expect(cookie).toContain("session_token");
        expect((await getPrincipal(auth, new Headers({ cookie }))).principal).toMatchObject({ id: alice, role: "user" });
    });

    test("another signup owns a different identity", async () => {
        expect((await request("/sign-up/email", { name: "Bob", email: "bob@example.test", password })).status).toBe(200);
        const [record] = await database.db.select().from(user).where(eq(user.email, "bob@example.test"));
        bob = record.id;
        expect(bob).not.toBe(alice);
    });

    test("missing cookies and disabled accounts cannot obtain a principal", async () => {
        expect((await getPrincipal(auth, new Headers())).principal).toBeNull();
        await database.db.update(user).set({ disabled: true }).where(eq(user.id, alice));
        expect((await getPrincipal(auth, new Headers({ cookie }))).principal).toBeNull();
        await database.db.update(user).set({ disabled: false }).where(eq(user.id, alice));
    });

    test("cross-origin mutations are rejected", async () => {
        expect((await request("/sign-out", {}, cookie, "https://untrusted.example")).status).toBe(403);
        expect((await getPrincipal(auth, new Headers({ cookie }))).principal).not.toBeNull();
    });

    test("wrong passwords and tampered session cookies are rejected", async () => {
        expect((await request("/sign-in/email", { email: "alice@example.test", password: "wrong-password" })).status).toBe(401);
        expect((await getPrincipal(auth, new Headers({ cookie: "better-auth.session_token=tampered" }))).principal).toBeNull();
    });

    test("external reset redirects cannot be used as email destinations", async () => {
        const mailCount = resetMail.length;
        const response = await request("/request-password-reset", {
            email: "alice@example.test", redirectTo: "https://untrusted.example/steal",
        });
        expect(response.status).toBe(403);
        expect(resetMail).toHaveLength(mailCount);
    });
});

describe("draft ownership and optimistic save", () => {
    test("each account only sees its own records", async () => {
        const draft = await drafts.create(alice, { title: "Alice 草稿", document: { nodes: [], connections: [] } });
        expect(draft.revision).toBe(1);
        expect(draft).not.toHaveProperty("ownerId");
        expect(await drafts.get(alice, draft.id)).toMatchObject({ id: draft.id });
        expect(await drafts.get(bob, draft.id)).toBeNull();
        expect(await drafts.list(bob)).toEqual([]);
        expect(await drafts.save(bob, draft.id, {
            expectedRevision: 1, title: "越权覆盖", document: {},
        })).toEqual({ status: "not_found" });
        expect((await drafts.get(alice, draft.id))?.title).toBe("Alice 草稿");
    });

    test("two saves of the same revision have exactly one winner", async () => {
        const draft = await drafts.create(alice, { title: "并发草稿", document: {} });
        const results = await Promise.all([
            drafts.save(alice, draft.id, { expectedRevision: 1, title: "标签页一", document: { source: "one" } }),
            drafts.save(alice, draft.id, { expectedRevision: 1, title: "标签页二", document: { source: "two" } }),
        ]);
        expect(results.filter((result) => result.status === "saved")).toHaveLength(1);
        expect(results.filter((result) => result.status === "conflict")).toEqual([{ status: "conflict", currentRevision: 2 }]);
        expect((await drafts.get(alice, draft.id))?.revision).toBe(2);
    });

    test("invalid revisions are rejected and a missing draft does not expose state", async () => {
        expect(await drafts.save(alice, "missing", { expectedRevision: 1, title: "x", document: {} })).toEqual({ status: "not_found" });
        await expect(drafts.save(alice, "missing", { expectedRevision: 0, title: "x", document: {} })).rejects.toThrow();
    });

    test("a rolled-back transaction leaves no draft", async () => {
        const before = await drafts.list(alice);
        await expect(database.db.transaction(async (transaction) => {
            await createDraftRepository(transaction).create(alice, { title: "不应落库", document: {} });
            throw new Error("rollback-test");
        })).rejects.toThrow("rollback-test");
        expect(await drafts.list(alice)).toEqual(before);
    });

    test("database connection rejects non-PostgreSQL URLs", () => {
        expect(() => createDatabase("https://example.test")).toThrow();
    });

    test("database constraints refuse orphan drafts", async () => {
        await expect(drafts.create("nonexistent-user", { title: "孤立草稿", document: {} })).rejects.toThrow();
    });
});

describe("session revocation", () => {
    test("password reset invalidates the previous session", async () => {
        const requested = await request("/request-password-reset", { email: "alice@example.test", redirectTo: origin });
        expect(requested.status).toBe(200);
        const mail = resetMail.find((item) => item.to === "alice@example.test")!;
        expect(mail).toBeDefined();
        const resetUrl = new URL(mail.url);
        const token = resetUrl.pathname.split("/").pop();
        const reset = await request("/reset-password", { token, newPassword: `${password}-new` });
        expect(reset.status).toBe(200);
        expect((await getPrincipal(auth, new Headers({ cookie }))).principal).toBeNull();
    });

    test("signout invalidates a fresh session", async () => {
        const login = await request("/sign-in/email", { email: "alice@example.test", password: `${password}-new` });
        expect(login.status).toBe(200);
        const freshCookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        expect((await getPrincipal(auth, new Headers({ cookie: freshCookie }))).principal).not.toBeNull();
        expect((await request("/sign-out", {}, freshCookie)).status).toBe(200);
        expect((await getPrincipal(auth, new Headers({ cookie: freshCookie }))).principal).toBeNull();
    });

    test("expired sessions cannot obtain a principal", async () => {
        const login = await request("/sign-in/email", { email: "alice@example.test", password: `${password}-new` });
        expect(login.status).toBe(200);
        const expiredCookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        await database.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.userId, alice));
        expect((await getPrincipal(auth, new Headers({ cookie: expiredCookie }))).principal).toBeNull();
    });
});
