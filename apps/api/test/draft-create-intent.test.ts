import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { auditEvent, canvasDraft } from "@infinite-canvas/database/schema";
import type { CanvasProject } from "../../../web/src/stores/canvas/use-canvas-store";
import { createDraftClient } from "../../../web/src/services/saas/drafts";
import { createCreationReceiptStore, type CreationReceipt, type CreationReceiptBacking } from "../../../web/src/services/saas/creation-receipt-store";
import { createReceiptedDraftClient } from "../../../web/src/services/saas/creation-receipts";
import { createAccountApi } from "../src/accounts";
import { createTestDatabase } from "./database";

// Real account handler/database, synthetic identities and external services. No stored browser artwork.
const origin = "https://canvas-intent.example.test";
const password = "synthetic-creation-intent-password";
const mails: { to: string; url: string }[] = [];
type Actor = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let api: ReturnType<typeof createAccountApi>;
let alice: Actor;
let bob: Actor;
let rateMode: "allow" | "deny" | "outage" = "allow";
const faults: unknown[] = [];

const project = {
    id: "synthetic-local-project", title: "完整原版项目 JSON", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
        { id: "text-a", type: "text", title: "创意", position: { x: 10, y: 20 }, width: 300, height: 150, metadata: { content: "合成创意 🎨", status: "idle" } },
        { id: "text-b", type: "text", title: "分镜", position: { x: 500, y: 20 }, width: 300, height: 150, metadata: { content: "合成分镜", status: "idle" } },
    ],
    connections: [{ id: "link-1", fromNodeId: "text-a", toNodeId: "text-b" }],
    chatSessions: [{ id: "chat-1", title: "创作助手", messages: [{ id: "message-1", role: "user", text: "保留合成历史" }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    activeChatId: "chat-1", backgroundMode: "lines", showImageInfo: true, viewport: { x: 30, y: -20, k: 0.75 },
} satisfies CanvasProject;
const draft = (creationId = crypto.randomUUID(), title = project.title) => ({ creationId, title, documentVersion: 1, document: project });
function input(path: string, body?: unknown, actor?: Actor, method = body === undefined ? "GET" : "POST") {
    return new Request(origin + path, {
        method, headers: { origin, "content-type": "application/json", cookie: actor?.cookie ?? "", ...(actor ? { "x-canvas-account-id": actor.id } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
const send = (request: Request) => api(request, "198.51.100.92");
const records = (id: string) => database.db.select().from(canvasDraft).where(eq(canvasDraft.id, id));
const audits = (id: string) => database.db.select().from(auditEvent).where(eq(auditEvent.resourceId, id));
async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["error", "requestId"]);
    expect(body.error.code).toBe(code);
    expect(body).not.toHaveProperty("currentRevision");
    expect(body).not.toHaveProperty("draft");
    return body;
}

beforeAll(async () => {
    database = await createTestDatabase();
    api = createAccountApi({
        database: database.db, origin, cloudCanvas: true,
        auth: { secret: "test-only-" + crypto.randomUUID() + crypto.randomUUID(), sendVerificationEmail: async (mail) => { mails.push(mail); }, sendResetPassword: async () => {} },
        rates: { consume: async () => {
            if (rateMode === "outage") throw new Error("synthetic-rate-outage");
            return rateMode === "deny" ? { allowed: false, retryAfter: 7 } : { allowed: true };
        } },
        verifyHuman: async () => true, onFault: (event) => { faults.push(event); },
    });
    for (const name of ["alice", "bob"]) {
        const email = `intent-${name}@example.test`;
        expect((await send(input("/api/auth/sign-up/email", { name, email, password }))).status).toBe(200);
        expect((await send(new Request(mails.find((mail) => mail.to === email)!.url))).status).toBe(302);
        const login = await send(input("/api/auth/sign-in/email", { email, password }));
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        const response = await send(input("/api/v1/session", undefined, { id: "unused", cookie }));
        const actor = { cookie, id: (await response.json()).user.id };
        if (name === "alice") alice = actor; else bob = actor;
    }
}, 30_000);
afterAll(async () => { if (database) await database.close(); });

describe("fixed draft creation identity and owner-scoped reconciliation", () => {
    test("the real client reconciles a lost committed response by ID and explicit resubmission cannot duplicate it", async () => {
        let dropResponse = true;
        const methods: string[] = [];
        const client = createDraftClient(() => ({ accountId: alice.id, epoch: 1 }), (async (path, options) => {
            const headers = new Headers(options?.headers);
            headers.set("origin", origin);
            headers.set("cookie", alice.cookie);
            const method = options?.method ?? "GET";
            methods.push(method);
            const response = await send(new Request(new URL(String(path), origin), { ...options, headers }));
            if (method === "POST" && dropResponse) {
                dropResponse = false;
                expect(response.status).toBe(201);
                await response.text(); // The handler committed, but the caller receives no response.
                throw new Error("synthetic committed response loss");
            }
            return response;
        }) as typeof fetch);
        const intent = client.prepareCreate({ title: project.title, documentVersion: 1, document: project });
        await expect(intent.submit()).rejects.toMatchObject({ code: "unavailable", outcome: "unknown", creationId: intent.id });
        expect(methods).toEqual(["POST"]);
        expect(await records(intent.id)).toHaveLength(1);
        expect(await audits(intent.id)).toHaveLength(1);
        const check = await intent.reconcile();
        expect(check.status).toBe("found-current");
        if (check.status !== "found-current") throw new Error("expected the committed synthetic draft");
        expect(check.draft).toMatchObject({ id: intent.id, revision: 1, document: project });
        const before = await records(intent.id);
        const beforeAudit = await audits(intent.id);
        // Explicit test action only: neither submit nor reconcile retries automatically.
        await expect(intent.submit()).rejects.toMatchObject({ code: "creation_exists", status: 409, outcome: "rejected", creationId: intent.id });
        expect(methods).toEqual(["POST", "GET", "POST"]);
        expect(await records(intent.id)).toEqual(before);
        expect(await audits(intent.id)).toEqual(beforeAudit);
    });

    test("a new client can only read-check an old creation ID without reviving the lost write", async () => {
        const methods: string[] = [];
        const transport = (actor: Actor, dropResponse = false) => (async (path, options) => {
            const headers = new Headers(options?.headers);
            headers.set("origin", origin);
            headers.set("cookie", actor.cookie);
            methods.push(options?.method ?? "GET");
            const response = await send(new Request(new URL(String(path), origin), { ...options, headers }));
            if (dropResponse) {
                expect(response.status).toBe(201);
                await response.text();
                throw new Error("synthetic response lost after commit");
            }
            return response;
        }) as typeof fetch;
        // Only the ID escapes this lifetime. This models client recreation, not browser persistence.
        const creationId = await (async () => {
            const client = createDraftClient(() => ({ accountId: alice.id, epoch: 1 }), transport(alice, true));
            const intent = client.prepareCreate({ title: project.title, documentVersion: 1, document: project });
            await expect(intent.submit()).rejects.toMatchObject({ outcome: "unknown", creationId: intent.id });
            return intent.id;
        })();
        const edited = { title: "核对时已是新版本", documentVersion: 1, document: { ...project, title: "later revision" }, expectedRevision: 1 };
        expect((await send(input(`/api/v1/canvases/${creationId}`, edited, alice, "PUT"))).status).toBe(200);
        const before = await records(creationId);
        const beforeAudit = await audits(creationId);
        const fresh = createDraftClient(() => ({ accountId: alice.id, epoch: 7 }), transport(alice));
        const reference = fresh.recoverCreate(creationId.toUpperCase());
        expect(Object.keys(reference).sort()).toEqual(["id", "reconcile"]);
        expect(Object.isFrozen(reference)).toBe(true);
        expect(reference.id).toBe(creationId);
        expect(methods).toEqual(["POST"]);
        expect(await reference.reconcile()).toMatchObject({ status: "found-current", draft: { id: creationId, revision: 2, document: edited.document } });
        const other = createDraftClient(() => ({ accountId: bob.id, epoch: 1 }), transport(bob)).recoverCreate(creationId);
        expect(await other.reconcile()).toEqual({ status: "not-found-yet" });
        expect(methods).toEqual(["POST", "GET", "GET"]);
        expect(await records(creationId)).toEqual(before);
        expect(await audits(creationId)).toEqual(beforeAudit);
    });

    test("persisted receipt metadata survives client recreation and explicitly reconciles a lost committed response without another creation", async () => {
        // Real receipt-store logic over isolated memory, not a browser IndexedDB/refresh test.
        const rows = new Map<string, CreationReceipt>();
        const backing: CreationReceiptBacking = {
            async getItem(key) { return structuredClone(rows.get(key) ?? null); },
            async setItem(key, value) { rows.set(key, structuredClone(value)); },
            async keys() { return [...rows.keys()]; },
        };
        const methods: string[] = [];
        const transport = (async (path, options) => {
            const headers = new Headers(options?.headers);
            headers.set("origin", origin);
            headers.set("cookie", alice.cookie);
            const request = new Request(new URL(String(path), origin), { ...options, headers });
            methods.push(request.method);
            if (request.method === "POST") {
                const payload = await request.clone().json();
                // A committed three-field receipt must precede the actual server request.
                expect([...rows.values()]).toEqual([{ accountId: alice.id, localProjectId: project.id, creationId: payload.creationId }]);
            }
            const response = await send(request);
            if (request.method === "POST") {
                expect(response.status).toBe(201);
                await response.text();
                throw new Error("synthetic response lost after committed creation");
            }
            return response;
        }) as typeof fetch;
        // No old client, write intent, or snapshot escapes this lifetime.
        const creationId = await (async () => {
            const client = createReceiptedDraftClient(() => ({ accountId: alice.id, epoch: 1 }), createCreationReceiptStore(backing), transport);
            const intent = client.prepareCreate(project.id, { title: project.title, documentVersion: 1, document: project });
            expect(rows.size).toBe(0);
            expect(methods).toEqual([]);
            await expect(intent.submit()).rejects.toMatchObject({ code: "unavailable", outcome: "unknown", creationId: intent.id });
            return intent.id;
        })();
        const before = await records(creationId);
        const beforeAudit = await audits(creationId);
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ ownerId: alice.id, revision: 1, document: project });
        expect(beforeAudit).toHaveLength(1);
        expect(beforeAudit[0]).toMatchObject({ action: "canvas.created", actorId: alice.id, revision: 1 });
        const fresh = createReceiptedDraftClient(() => ({ accountId: alice.id, epoch: 9 }), createCreationReceiptStore(backing), transport);
        const recovered = await fresh.recover(project.id);
        expect(methods).toEqual(["POST"]);
        expect(recovered).toHaveLength(1);
        const reference = recovered[0];
        expect(Object.keys(reference).sort()).toEqual(["id", "reconcile"]);
        expect(Object.isFrozen(reference)).toBe(true);
        expect(reference.id).toBe(creationId);
        const check = await reference.reconcile(); // Explicit read only, never an automatic upload.
        expect(check.status).toBe("found-current");
        if (check.status !== "found-current") throw new Error("expected the committed synthetic draft");
        expect(check.draft).toMatchObject({ id: creationId, revision: 1, title: project.title, documentVersion: 1 });
        expect(check.draft.document).toEqual(project);
        expect(methods).toEqual(["POST", "GET"]);
        expect(await records(creationId)).toEqual(before);
        expect(await audits(creationId)).toEqual(beforeAudit);
        expect([...rows.values()]).toEqual([{ accountId: alice.id, localProjectId: project.id, creationId }]);
    });

    test("a fixed creation ID stores the complete original project and is recoverable with a read", async () => {
        const value = draft();
        const response = await send(input("/api/v1/canvases", value, alice));
        expect(response.status).toBe(201);
        const created = await response.json();
        expect(created.draft).toMatchObject({ id: value.creationId, revision: 1, document: project });
        expect(created.draft).not.toHaveProperty("ownerId");
        const found = await send(input(`/api/v1/canvases/${value.creationId}`, undefined, alice));
        expect(found.status).toBe(200);
        expect((await found.json()).draft).toEqual(created.draft);
        const [audit] = await audits(value.creationId);
        expect(audit).toMatchObject({ action: "canvas.created", revision: 1, actorId: alice.id, requestId: created.requestId });
    });

    test("concurrent equal submissions create only one draft and one success audit", async () => {
        const value = draft();
        const responses = await Promise.all([1, 2].map(() => send(input("/api/v1/canvases", value, alice))));
        expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
        const rejected = await expectError(responses.find((response) => response.status === 409)!, 409, "creation_exists");
        const stored = await records(value.creationId);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ document: project, revision: 1, ownerId: alice.id });
        const events = await audits(value.creationId);
        expect(events).toHaveLength(1);
        expect(events[0].requestId).not.toBe(rejected.requestId);
        expect(events[0].action).toBe("canvas.created");
    });

    test("concurrent different payloads never replace the winning creation", async () => {
        const creationId = crypto.randomUUID();
        const values = ["first", "second"].map((text) => ({ ...draft(creationId, text), document: { ...project, extra: text } }));
        const responses = await Promise.all(values.map((value) => send(input("/api/v1/canvases", value, alice))));
        expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
        const winner = values[responses.findIndex((response) => response.status === 201)];
        await expectError(responses.find((response) => response.status === 409)!, 409, "creation_exists");
        const [stored] = await records(creationId);
        expect(stored).toMatchObject({ title: winner.title, document: winner.document, revision: 1 });
        expect(await audits(creationId)).toHaveLength(1);
    });

    test("repeated creation after an edit does not reset revision, body or audit history", async () => {
        const value = draft();
        expect((await send(input("/api/v1/canvases", value, alice))).status).toBe(201);
        const edited = { title: "已编辑的云稿", documentVersion: 1, document: { ...project, title: "revision two" }, expectedRevision: 1 };
        const saved = await send(input(`/api/v1/canvases/${value.creationId}`, edited, alice, "PUT"));
        expect(saved.status).toBe(200);
        expect((await saved.json()).draft.revision).toBe(2);
        const before = await records(value.creationId);
        const beforeAudit = await audits(value.creationId);
        for (const repeated of [value, { ...value, title: "不得覆盖", document: {} }]) {
            await expectError(await send(input("/api/v1/canvases", repeated, alice)), 409, "creation_exists");
        }
        expect(await records(value.creationId)).toEqual(before);
        expect(await audits(value.creationId)).toEqual(beforeAudit);
        expect(beforeAudit.map((event) => event.action).sort()).toEqual(["canvas.created", "canvas.saved"]);
        const reconciled = await send(input(`/api/v1/canvases/${value.creationId}`, undefined, alice));
        expect((await reconciled.json()).draft).toMatchObject({ revision: 2, document: edited.document });
    });

    test("an occupied ID belonging to another account returns only 404 and grants no read or write", async () => {
        const value = draft();
        expect((await send(input("/api/v1/canvases", value, alice))).status).toBe(201);
        const before = await records(value.creationId);
        const beforeAudit = await audits(value.creationId);
        const denied = await expectError(await send(input("/api/v1/canvases", { ...value, title: "foreign attempt" }, bob)), 404, "not_found");
        expect(JSON.stringify(denied)).not.toContain(alice.id);
        expect(JSON.stringify(denied)).not.toContain(project.title);
        await expectError(await send(input(`/api/v1/canvases/${value.creationId}`, undefined, bob)), 404, "not_found");
        await expectError(await send(input("/api/v1/canvases", { ...draft(), ownerId: alice.id }, bob)), 400, "invalid_input");
        const switched = input("/api/v1/canvases", draft(), bob);
        switched.headers.set("x-canvas-account-id", alice.id);
        await expectError(await send(switched), 409, "account_changed");
        await expectError(await send(input("/api/v1/canvases", draft())), 401, "unauthorized");
        expect(await records(value.creationId)).toEqual(before);
        expect(await audits(value.creationId)).toEqual(beforeAudit);
    });

    test("competing accounts cannot each acquire the same creation ID", async () => {
        const creationId = crypto.randomUUID();
        const actors = [alice, bob];
        const responses = await Promise.all(actors.map((actor) => send(input("/api/v1/canvases", draft(creationId), actor))));
        expect(responses.map((response) => response.status).sort()).toEqual([201, 404]);
        const winner = actors[responses.findIndex((response) => response.status === 201)];
        await expectError(responses.find((response) => response.status === 404)!, 404, "not_found");
        const stored = await records(creationId);
        expect(stored).toHaveLength(1);
        expect(stored[0].ownerId).toBe(winner.id);
        const events = await audits(creationId);
        expect(events).toHaveLength(1);
        expect(events[0].actorId).toBe(winner.id);
    });

    test("uppercase creation UUIDs normalize to the same stored draft", async () => {
        const creationId = "A1B2C3D4-E5F6-47A8-B9C0-123456ABCDEF";
        const response = await send(input("/api/v1/canvases", draft(creationId), alice));
        expect(response.status).toBe(201);
        expect((await response.json()).draft.id).toBe(creationId.toLowerCase());
        await expectError(await send(input("/api/v1/canvases", draft(creationId.toLowerCase()), alice)), 409, "creation_exists");
        const found = await send(input(`/api/v1/canvases/${creationId}`, undefined, alice));
        expect(found.status).toBe(200);
        expect((await found.json()).draft.id).toBe(creationId.toLowerCase());
        expect(await records(creationId.toLowerCase())).toHaveLength(1);
        expect(await audits(creationId.toLowerCase())).toHaveLength(1);
    });

    test("missing or invalid creation IDs cannot write and PUT cannot carry creationId", async () => {
        const before = await database.db.select().from(canvasDraft);
        const beforeAudit = await database.db.select().from(auditEvent);
        for (const creationId of [undefined, null, "", 42, "not-a-uuid", "a1b2c3d4e5f647a8b9c0123456abcdef", " a1b2c3d4-e5f6-47a8-b9c0-123456abcdef", "a1b2c3d4-e5f6-47a8-09c0-123456abcdef"]) {
            await expectError(await send(input("/api/v1/canvases", { ...draft(), creationId }, alice)), 400, "invalid_input");
        }
        expect(await database.db.select().from(canvasDraft)).toEqual(before);
        expect(await database.db.select().from(auditEvent)).toEqual(beforeAudit);
        const value = draft();
        expect((await send(input("/api/v1/canvases", value, alice))).status).toBe(201);
        await expectError(await send(input(`/api/v1/canvases/${value.creationId}`, { ...value, expectedRevision: 1 }, alice, "PUT")), 400, "invalid_input");
        expect((await records(value.creationId))[0].revision).toBe(1);
        expect(await audits(value.creationId)).toHaveLength(1);
    });

    test("a failed success audit rolls creation back and leaves the same ID available for an explicit submission", async () => {
        const value = draft();
        await database.db.execute(sql`ALTER TABLE canvas_saas.audit_event ADD CONSTRAINT intent_test_block_audit CHECK (action <> 'canvas.created') NOT VALID`);
        try {
            const beforeFaults = faults.length;
            await expectError(await send(input("/api/v1/canvases", value, alice)), 503, "service_unavailable");
            expect(await records(value.creationId)).toHaveLength(0);
            expect(await audits(value.creationId)).toHaveLength(0);
            expect(faults).toHaveLength(beforeFaults + 1);
        } finally {
            await database.db.execute(sql`ALTER TABLE canvas_saas.audit_event DROP CONSTRAINT intent_test_block_audit`);
        }
        // A separate explicit request, not an automatic retry in the API or client.
        expect((await send(input("/api/v1/canvases", value, alice))).status).toBe(201);
        expect(await records(value.creationId)).toHaveLength(1);
        expect(await audits(value.creationId)).toHaveLength(1);
    });

    test("creation IDs do not bypass existing origin, rate-store or actual byte limits", async () => {
        const value = draft();
        const foreign = input("/api/v1/canvases", value, alice);
        foreign.headers.set("origin", "https://untrusted.example.test");
        await expectError(await send(foreign), 403, "invalid_origin");
        try {
            for (const mode of ["deny", "outage"] as const) {
                rateMode = mode;
                const response = await send(input("/api/v1/canvases", value, alice));
                if (mode === "deny") expect(response.headers.get("retry-after")).toBe("7");
                await expectError(response, mode === "deny" ? 429 : 503, mode === "deny" ? "rate_limited" : "service_unavailable");
            }
        } finally { rateMode = "allow"; }
        const oversized = input("/api/v1/canvases", { ...value, document: { content: "x".repeat(5 * 1024 * 1024) } }, alice);
        oversized.headers.set("content-length", "1");
        await expectError(await send(oversized), 413, "payload_too_large");
        expect(await records(value.creationId)).toHaveLength(0);
        expect(await audits(value.creationId)).toHaveLength(0);
    });

    test("checking an unobserved creation only reads and never creates a replacement", async () => {
        const creationId = crypto.randomUUID();
        const before = await database.db.select().from(canvasDraft);
        const beforeAudit = await database.db.select().from(auditEvent);
        for (const actor of [alice, bob]) {
            await expectError(await send(input(`/api/v1/canvases/${creationId}`, undefined, actor)), 404, "not_found");
        }
        expect(await database.db.select().from(canvasDraft)).toEqual(before);
        expect(await database.db.select().from(auditEvent)).toEqual(beforeAudit);
    });
});
