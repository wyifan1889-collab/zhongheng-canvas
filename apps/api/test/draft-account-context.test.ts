import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { auditEvent, canvasDraft, session } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createTestDatabase } from "./database";

// Synthetic accounts, in-memory database and fake external services; no browser or production state.
const origin = "https://canvas-context.example.test";
const password = "synthetic-context-password";
const mails: { to: string; url: string }[] = [];
const rateCalls: { bucket: string; identity: string }[] = [];
type Actor = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let api: ReturnType<typeof createAccountApi>;
let alice: Actor;
let bob: Actor;
let aliceDraft: string;
let bobDraft: string;

function input(path: string, cookie = "", accountId: string | null = null, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const headers = new Headers({ origin, cookie, "content-type": "application/json" });
    if (accountId !== null) headers.set("x-canvas-account-id", accountId);
    if (path === "/api/v1/canvases" && method === "POST" && body && typeof body === "object") body = { creationId: crypto.randomUUID(), ...body };
    return new Request(origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const send = (request: Request) => api(request, "198.51.100.91");
const document = { title: "synthetic context draft", documentVersion: 1, document: { nodes: [] } };
function operations() {
    return [
        { path: "/api/v1/canvases", method: "GET" },
        { path: `/api/v1/canvases/${bobDraft}`, method: "GET" },
        { path: "/api/v1/canvases", method: "POST", body: document },
        { path: `/api/v1/canvases/${bobDraft}`, method: "PUT", body: { ...document, expectedRevision: 1 } },
    ];
}
async function expectRejection(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(Object.keys(result).sort()).toEqual(["error", "requestId"]);
    expect(result.error.code).toBe(code);
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(result)).not.toContain(alice.id);
    expect(JSON.stringify(result)).not.toContain(bob.id);
}

beforeAll(async () => {
    database = await createTestDatabase();
    api = createAccountApi({
        database: database.db, origin, cloudCanvas: true,
        auth: {
            secret: "test-only-" + crypto.randomUUID() + crypto.randomUUID(),
            sendVerificationEmail: async (mail) => { mails.push(mail); }, sendResetPassword: async () => {},
        },
        rates: { consume: async (bucket, identity) => { rateCalls.push({ bucket, identity }); return { allowed: true }; } },
        verifyHuman: async () => true, onFault: () => {},
    });
    for (const name of ["alice", "bob"]) {
        const email = `context-${name}@example.test`;
        expect((await send(input("/api/auth/sign-up/email", "", null, { name, email, password }))).status).toBe(200);
        const mail = mails.find((item) => item.to === email)!;
        expect((await send(new Request(mail.url))).status).toBe(302);
        const login = await send(input("/api/auth/sign-in/email", "", null, { email, password }));
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        const response = await send(input("/api/v1/session", cookie));
        expect(response.status).toBe(200);
        const actor = { cookie, id: (await response.json()).user.id };
        if (name === "alice") alice = actor; else bob = actor;
    }
    for (const actor of [alice, bob]) {
        const response = await send(input("/api/v1/canvases", actor.cookie, actor.id, document));
        expect(response.status).toBe(201);
        const id = (await response.json()).draft.id;
        if (actor === alice) aliceDraft = id; else bobDraft = id;
    }
}, 30_000);
afterAll(async () => { if (database) await database.close(); });

describe("draft requests are bound to the initiating account", () => {
    test("an old Alice page cannot create a draft under a replacement Bob cookie", async () => {
        const beforeDrafts = await database.db.select().from(canvasDraft);
        const beforeAudit = await database.db.select().from(auditEvent);
        const response = await send(input("/api/v1/canvases", bob.cookie, alice.id, document));
        const afterDrafts = await database.db.select().from(canvasDraft);
        const afterAudit = await database.db.select().from(auditEvent);
        expect({ status: response.status, newDrafts: afterDrafts.length - beforeDrafts.length, newAudit: afterAudit.length - beforeAudit.length })
            .toEqual({ status: 409, newDrafts: 0, newAudit: 0 });
        expect(await response.json()).toMatchObject({ error: { code: "account_changed" } });
    });

    test("missing and mismatched account contexts refuse all draft operations without data or audit changes", async () => {
        const beforeDrafts = await database.db.select().from(canvasDraft);
        const beforeAudit = await database.db.select().from(auditEvent);
        rateCalls.length = 0;
        for (const accountId of [null, alice.id]) {
            for (const { path, body, method } of operations()) {
                const response = await send(input(path, bob.cookie, accountId, body, method));
                await expectRejection(response, accountId === null ? 400 : 409, accountId === null ? "account_context_required" : "account_changed");
            }
        }
        expect(await database.db.select().from(canvasDraft)).toEqual(beforeDrafts);
        expect(await database.db.select().from(auditEvent)).toEqual(beforeAudit);
        expect(rateCalls).toEqual([null, alice.id].flatMap(() => [
            { bucket: "account-read", identity: bob.id }, { bucket: "account-read", identity: bob.id },
            { bucket: "canvas-save", identity: bob.id }, { bucket: "canvas-save", identity: bob.id },
        ]));
    });

    test("rejected contexts never reach draft queries even when the draft relation is unavailable", async () => {
        // Rename only this isolated fixture's relation to detect any attempted repository access.
        await database.db.execute(sql`ALTER TABLE canvas_saas.canvas_draft RENAME TO context_test_draft_unavailable`);
        try {
            for (const accountId of [null, alice.id]) {
                for (const { path, body, method } of operations()) {
                    const response = await send(input(path, bob.cookie, accountId, body, method));
                    expect(response.status).toBe(accountId === null ? 400 : 409);
                }
            }
            expect((await send(input("/api/v1/canvases", bob.cookie, bob.id))).status).toBe(503);
        } finally {
            await database.db.execute(sql`ALTER TABLE canvas_saas.context_test_draft_unavailable RENAME TO canvas_draft`);
        }
    });

    test("an account header cannot authenticate or grant another owner's drafts", async () => {
        rateCalls.length = 0;
        await expectRejection(await send(input("/api/v1/canvases", "", alice.id)), 401, "unauthorized");
        expect(rateCalls).toEqual([]);
        await expectRejection(await send(input(`/api/v1/canvases/${aliceDraft}`, bob.cookie, alice.id)), 409, "account_changed");
        for (const method of ["GET", "PUT"]) {
            const body = method === "PUT" ? { ...document, expectedRevision: 1 } : undefined;
            await expectRejection(await send(input(`/api/v1/canvases/${aliceDraft}`, bob.cookie, bob.id, body, method)), 404, "not_found");
        }
        await expectRejection(await send(input("/api/v1/canvases", bob.cookie, bob.id, { ...document, ownerId: alice.id })), 400, "invalid_input");
        const response = await send(input("/api/v1/canvases", bob.cookie, bob.id));
        expect(response.status).toBe(200);
        expect((await response.json()).items.map((item: { id: string }) => item.id)).toEqual([bobDraft]);
        const [draft] = await database.db.select().from(canvasDraft).where(eq(canvasDraft.id, aliceDraft));
        expect(draft.revision).toBe(1);
        expect(draft.ownerId).toBe(alice.id);
    });

    test("empty, multiple and case-changed account headers cannot satisfy an exact account condition", async () => {
        for (const accountId of ["", `${bob.id}, ${alice.id}`, bob.id.toUpperCase() === bob.id ? bob.id.toLowerCase() : bob.id.toUpperCase()]) {
            const response = await send(input("/api/v1/canvases", bob.cookie, accountId));
            await expectRejection(response, accountId ? 409 : 400, accountId ? "account_changed" : "account_context_required");
        }
    });

    test("context checks precede query, document and resource parsing while origin protection remains first", async () => {
        for (const path of ["/api/v1/canvases?limit=invalid", "/api/v1/canvases/not-a-uuid"]) {
            await expectRejection(await send(input(path, bob.cookie, alice.id)), 409, "account_changed");
        }
        const malformed = () => new Request(origin + "/api/v1/canvases", {
            method: "POST", headers: { origin, cookie: bob.cookie, "x-canvas-account-id": alice.id, "content-type": "application/json" }, body: "{",
        });
        await expectRejection(await send(malformed()), 409, "account_changed");
        const foreign = malformed();
        foreign.headers.set("origin", "https://untrusted.example.test");
        await expectRejection(await send(foreign), 403, "invalid_origin");
    });

    test("context refusal retains a valid session renewal but never returns the actual account identity", async () => {
        for (const accountId of [null, alice.id]) {
            await database.db.update(session).set({
                createdAt: sql`now() - interval '2 days'`, updatedAt: sql`now() - interval '2 days'`,
                expiresAt: sql`now() + interval '5 days'`,
            }).where(eq(session.userId, bob.id));
            const response = await send(input("/api/v1/canvases", bob.cookie, accountId));
            await expectRejection(response, accountId === null ? 400 : 409, accountId === null ? "account_context_required" : "account_changed");
            const values = response.headers.getSetCookie();
            expect(values).toHaveLength(1);
            expect(values[0]).toContain("__Secure-better-auth.session_token=");
            expect(values[0].toLowerCase()).toContain("httponly");
            expect(values[0]).toMatch(/;\s*Secure(?:;|$)/i);
        }
        // The session endpoint remains the authoritative, separately authenticated identity lookup.
        const response = await send(input("/api/v1/session", bob.cookie));
        expect(response.status).toBe(200);
        expect((await response.json()).user.id).toBe(bob.id);
    });
});
