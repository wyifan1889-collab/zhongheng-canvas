import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createRateStore, type RateRule } from "@infinite-canvas/database/rate-limit";
import { auditEvent, canvasDraft, canvasMembers, canvasShares, rateLimit, user } from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage } from "@infinite-canvas/storage";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { accountPolicy } from "../src/policy";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Sharing tests require in-memory PGlite only");
const origin = "http://localhost:4000", secret = `sharing-only-${crypto.randomUUID()}${crypto.randomUUID()}`;
const password = "synthetic-sharing-password", marker = "synthetic-private-canvas-document";
type ActorName = "owner" | "viewer" | "editor" | "stranger";
type Actor = { id: string; cookie: string; email: string; peer: string };
const actors = {} as Record<ActorName, Actor>;
const mails: Array<{ to: string; url: string }> = [];
const faults: unknown[] = [], invitationTokens = new Set<string>();
const rates: Array<{ bucket: string; rule: RateRule }> = [], locks: Array<{ table: unknown; strength: string; sql: string }> = [];
const memberFields = ["canvasId", "userId", "role", "invitedBy", "joinedAt"].sort();
const shareFields = ["id", "canvasId", "token", "role", "createdBy", "expiresAt", "createdAt"].sort();
const memory = createMemoryObjectStorage();
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>, closedApp: ReturnType<typeof createApp>;
let storageFailure = "", databaseFailure = "";
let gate: { strength: string; claimed: boolean; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
// Only the returned query's real SQL result is paused. It has already acquired
// its canvas lock; all membership, auth and writes remain product operations.
function queryProxy<T extends object>(target: T, scope: { table?: unknown; strength?: string } = {}): T {
    return new Proxy(target, { get(builder, key) {
        const member = Reflect.get(builder, key);
        if (key === "then") return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
            const work = Reflect.apply(member, builder, [(value: unknown) => value, (error: unknown) => { throw error; }]);
            return Promise.resolve(work).then(async (value) => {
                if (scope.strength) {
                    locks.push({ table: scope.table, strength: scope.strength, sql: Reflect.get(builder, "toSQL").call(builder).sql });
                    if (scope.table === canvasDraft && gate && !gate.claimed && gate.strength === scope.strength) {
                        const held = gate; held.claimed = true; held.entered.resolve(); await held.release.promise;
                    }
                }
                return value;
            }).then(resolve, reject);
        };
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
            if (key === "from") { scope.table = args[0]; if (scope.table === canvasDraft && databaseFailure) throw new Error(databaseFailure); }
            if (key === "for") scope.strength = String(args[0]);
            const next = Reflect.apply(member, builder, args);
            return next && typeof next === "object" && typeof next.toSQL === "function" ? queryProxy(next, scope) : next;
        };
    } });
}
function databaseProxy<T extends object>(target: T): T {
    return new Proxy(target, { get(db, key) {
        const member = Reflect.get(db, key);
        if (key === "transaction") return (callback: (tx: T) => unknown, ...args: unknown[]) => Reflect.apply(member, db, [(tx: T) => callback(databaseProxy(tx)), ...args]);
        if (key === "select") return (...args: unknown[]) => queryProxy(Reflect.apply(member, db, args));
        return typeof member === "function" ? member.bind(db) : member;
    } });
}
type Options = { method?: string; cookie?: string; accountId?: string; origin?: string | null; crossSite?: boolean; type?: string; app?: ReturnType<typeof createApp> };
function request(path: string, body?: unknown, actor: ActorName = "owner", options: Options = {}) {
    const current = actors[actor], method = options.method ?? (body === undefined ? "GET" : "POST");
    const headers = new Headers({ cookie: options.cookie ?? current?.cookie ?? "", "content-type": options.type ?? "application/json" });
    if (options.origin !== null) headers.set("origin", options.origin ?? origin);
    const accountId = options.accountId ?? current?.id;
    if (accountId) headers.set("x-canvas-account-id", accountId);
    if (options.crossSite) headers.set("sec-fetch-site", "cross-site");
    return (options.app ?? app)(new Request(origin + path, { method, headers,
        ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    }), current?.peer ?? "198.51.100.60");
}
async function error(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code } });
    expect(JSON.stringify(body)).not.toContain(marker);
    return body;
}
async function json(response: Response, status = 200) { expect(response.status).toBe(status); return await response.json(); }
const sharePath = (id: string, action = "share") => `/api/v1/canvas/${id}/${action}`;
const memberPath = (id: string, actor: ActorName) => sharePath(id, `members/${encodeURIComponent(actors[actor].id)}`);
const joinPath = (token: string) => `/api/v1/canvas/share/${token}/join`;
async function create(document: object = { nodes: [], marker }) {
    const body = await json(await request("/api/v1/canvases", { creationId: crypto.randomUUID(), title: "Synthetic shared canvas", documentVersion: 1, document }), 201);
    return body.draft;
}
async function link(id: string, role: "viewer" | "editor", reset = false) {
    const share = (await json(await request(sharePath(id, "share-link"), { role, ...(reset ? { reset } : {}) }))).share;
    invitationTokens.add(share.token); return share;
}
async function join(token: string, actor: ActorName) { return (await json(await request(joinPath(token), {}, actor))).member; }
async function remove(id: string, actor: ActorName) { return request(memberPath(id, actor), undefined, "owner", { method: "DELETE" }); }
function save(id: string, revision: number, document: object, actor: ActorName) {
    return request(`/api/v1/canvases/${id}`, { title: "Synthetic edited canvas", documentVersion: 1, expectedRevision: revision, document }, actor, { method: "PUT" });
}
async function upload(actor: ActorName) {
    const bytes = new Uint8Array([1, 2, 3]);
    const body = await json(await request("/api/v1/media", bytes, actor, { type: "image/png" }), 201);
    return { id: body.media.id as string, bytes };
}
const documentWith = (...ids: string[]) => ({ nodes: ids.map((id) => ({ id: `node-${id}`, type: "image", metadata: { cloudMediaId: id } })), marker });

beforeAll(async () => {
    database = await createTestDatabase();
    const limiter = createRateStore(database.pool, secret);
    const options: Parameters<typeof createAccountApi>[0] = {
        database: databaseProxy(database.db), origin, cloudCanvas: true,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); }, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) { rates.push({ bucket, rule: { ...rule } }); return limiter.consume(bucket, identity, rule); } },
        verifyHuman: async () => true, onFault: (event) => { faults.push(event); },
        media: { storage: { put: (input) => memory.put(input), delete: (key) => memory.delete(key),
            get: (key) => { if (storageFailure) throw new Error(storageFailure); return memory.get(key); } },
            quotaBytes: 1024 * 1024 * 1024, maxBytes: { image: accountPolicy.documentBytes, audio: accountPolicy.documentBytes, video: accountPolicy.documentBytes } },
    };
    app = createApp(createAccountApi(options), "public-test-site-key", true, true);
    closedApp = createApp(createAccountApi({ ...options, cloudCanvas: false }), "public-test-site-key", false, true);
    for (const [index, name] of (["owner", "viewer", "editor", "stranger"] as ActorName[]).entries()) {
        const email = `sharing-${name}@example.test`, peer = `198.51.100.${60 + index}`;
        actors[name] = { id: "", cookie: "", email, peer };
        expect((await request("/api/auth/sign-up/email", { name, email, password }, name)).status).toBe(200);
        const mail = mails.find((value) => value.to === email)!;
        expect(mail).toBeDefined();
        expect((await app(new Request(mail.url), peer)).status).toBe(302);
        const login = await request("/api/auth/sign-in/email", { email, password }, name);
        expect(login.status).toBe(200);
        actors[name].cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        actors[name].id = (await (await request("/api/v1/session", undefined, name)).json()).user.id;
    }
}, 30_000);
beforeEach(async () => {
    // Reset this disposable fixture's counters, preserving the actual product policy.
    gate?.release.resolve(); gate = undefined;
    await database.db.delete(rateLimit); rates.length = 0; locks.length = 0; faults.length = 0;
});
afterEach(async () => {
    gate?.release.resolve(); gate = undefined; databaseFailure = ""; storageFailure = "";
    const auditText = JSON.stringify(await database.db.select().from(auditEvent));
    const faultText = JSON.stringify(faults);
    for (const token of invitationTokens) { expect(auditText).not.toContain(token); expect(faultText).not.toContain(token); }
    for (const fault of faults) expect(Object.keys(fault as object).sort()).toEqual(["code", "component", "requestId"]);
});
afterAll(async () => { try { gate?.release.resolve(); } finally { await database?.close(); } });

test("owner management returns only Share7/Member5 fields, preserves owner authority and never audits invitation tokens", async () => {
    const draft = await create();
    const initial = await json(await request(sharePath(draft.id)));
    expect(initial.share).toBeNull();
    expect(initial.members).toHaveLength(1);
    expect(Object.keys(initial.members[0]).sort()).toEqual(memberFields);
    expect(initial.members[0]).toMatchObject({ canvasId: draft.id, userId: actors.owner.id, role: "owner" });
    expect(initial.members[0].joinedAt).toBe(draft.createdAt);
    const first = await link(draft.id, "viewer");
    expect(Object.keys(first).sort()).toEqual(shareFields);
    expect(first).toMatchObject({ canvasId: draft.id, role: "viewer", createdBy: actors.owner.id, expiresAt: null });
    expect(await link(draft.id, "viewer")).toEqual(first);
    await error(await request(sharePath(draft.id, "share-link"), { role: "editor" }), 409, "share_reset_required");
    const reset = await link(draft.id, "editor", true);
    expect(reset.token).not.toBe(first.token);
    for (const field of ["id", "createdBy", "createdAt", "expiresAt"]) expect(reset[field]).toEqual(first[field]);
    for (const body of [{ userId: actors.owner.id, role: "viewer" }, { userId: "absent-text-user", role: "viewer" }]) await error(await request(sharePath(draft.id, "members"), body), 400, "invalid_input");
    await error(await request(memberPath(draft.id, "owner"), undefined, "owner", { method: "DELETE" }), 400, "invalid_input");
    const ownerView = await json(await request(`/api/v1/canvases/${draft.id}`));
    expect(ownerView.access).toEqual({ role: "owner", ownerId: actors.owner.id, readOnly: false });
    const serializedAudit = JSON.stringify(await database.db.select().from(auditEvent));
    expect(serializedAudit).not.toContain(first.token); expect(serializedAudit).not.toContain(reset.token);
});

test("sharing has real auth/cloud/account/origin gates and strict method, body and query contracts", async () => {
    const draft = await create(), current = await link(draft.id, "viewer");
    for (const entry of [
        { options: { cookie: "" }, status: 401, code: "unauthorized" }, { options: { accountId: "" }, status: 400, code: "account_context_required" },
        { options: { accountId: actors.viewer.id }, status: 409, code: "account_changed" }, { options: { origin: "https://foreign.example.test" }, status: 403, code: "invalid_origin" },
        { options: { crossSite: true }, status: 403, code: "invalid_origin" }, { options: { app: closedApp }, status: 503, code: "cloud_unavailable" },
    ]) await error(await request(sharePath(draft.id), undefined, "owner", entry.options), entry.status, entry.code);
    await error(await request(sharePath(draft.id, "share-link"), { role: "viewer" }, "owner", { origin: null }), 403, "invalid_origin");
    for (const [path, body, method] of [
        [sharePath(draft.id, "share-link"), { role: "owner" }, "POST"], [sharePath(draft.id, "share-link"), { role: "viewer", token: crypto.randomUUID() }, "POST"],
        [sharePath(draft.id, "share-link"), { role: "viewer", reset: "true" }, "POST"], [joinPath(current.token), { userId: actors.viewer.id }, "POST"],
        [joinPath(current.token), { role: "editor" }, "POST"], [sharePath(draft.id, "members"), { userId: actors.viewer.id, role: "viewer", invitedBy: actors.owner.id }, "POST"],
        [memberPath(draft.id, "viewer"), {}, "DELETE"],
    ] as Array<[string, unknown, string]>) await error(await request(path, body, "owner", { method }), 400, "invalid_input");
    for (const path of [sharePath(draft.id), sharePath(draft.id, "share-link"), joinPath(current.token), sharePath(draft.id, "members"), memberPath(draft.id, "viewer")]) {
        const method = path.endsWith("/share") ? "GET" : path.includes("/members/") ? "DELETE" : "POST";
        await error(await request(`${path}?unexpected=1`, method === "POST" ? {} : undefined, "owner", { method }), 400, "invalid_input");
    }
    for (const [path, method] of [[sharePath(draft.id), "POST"], [sharePath(draft.id, "share-link"), "GET"], [joinPath(current.token), "GET"], [sharePath(draft.id, "members"), "GET"], [memberPath(draft.id, "viewer"), "POST"]]) await error(await request(path, undefined, "owner", { method }), 405, "method_not_allowed");
    const response = await request(sharePath(draft.id));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await response.json()).requestId).toBe(response.headers.get("x-request-id"));
});

test("pending invitations grant nothing; join activates only the caller at the lower role and is idempotent", async () => {
    const draft = await create(), current = await link(draft.id, "editor");
    const invitation = (await json(await request(sharePath(draft.id, "members"), { userId: actors.viewer.id, role: "viewer" }))).member;
    expect(Object.keys(invitation).sort()).toEqual(memberFields);
    expect(invitation).toMatchObject({ canvasId: draft.id, userId: actors.viewer.id, role: "viewer", invitedBy: actors.owner.id, joinedAt: null });
    for (const actor of ["viewer", "stranger"] as const) {
        await error(await request(`/api/v1/canvases/${draft.id}`, undefined, actor), 404, "not_found");
        await error(await save(draft.id, 1, {}, actor), 404, "not_found");
        await error(await request(sharePath(draft.id), undefined, actor), 404, "not_found");
    }
    const accepted = await join(current.token, "viewer");
    expect(accepted).toMatchObject({ canvasId: draft.id, userId: actors.viewer.id, role: "viewer", invitedBy: actors.owner.id });
    expect(new Date(accepted.joinedAt).toISOString()).toBe(accepted.joinedAt);
    expect(await join(current.token, "viewer")).toEqual(accepted);
    await error(await save(draft.id, 1, {}, "viewer"), 404, "not_found");
    expect((await json(await request(`/api/v1/canvases/${draft.id}`, undefined, "viewer"))).access).toEqual({ role: "viewer", ownerId: actors.owner.id, readOnly: true });
    expect((await join(current.token, "owner")).role).toBe("owner");
    const textId = "CaseSensitive-Text-Invitee";
    await database.db.insert(user).values({ id: textId, name: "Text identity", email: "sharing-text-id@example.test" });
    expect((await json(await request(sharePath(draft.id, "members"), { userId: textId, role: "editor" }))).member.userId).toBe(textId);
    await error(await request(sharePath(draft.id, "members"), { userId: textId.toLowerCase(), role: "viewer" }), 400, "invalid_input");
});

test("reset and expiry block new joins but retain active roles; deletion revokes and permits a later valid rejoin", async () => {
    const draft = await create(), original = await link(draft.id, "editor");
    const active = await join(original.token, "editor");
    await json(await request(sharePath(draft.id, "members"), { userId: actors.viewer.id, role: "editor" }));
    const replacement = await link(draft.id, "viewer", true);
    await error(await request(joinPath(original.token), {}, "stranger"), 404, "not_found");
    expect(await join(replacement.token, "editor")).toEqual(active);
    expect((await join(replacement.token, "viewer")).role).toBe("viewer");
    await database.db.update(canvasShares).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(canvasShares.canvasId, draft.id));
    await error(await request(joinPath(replacement.token), {}, "stranger"), 404, "not_found");
    expect((await request(`/api/v1/canvases/${draft.id}`, undefined, "editor")).status).toBe(200);
    await json(await remove(draft.id, "editor"));
    await error(await request(`/api/v1/canvases/${draft.id}`, undefined, "editor"), 404, "not_found");
    await database.db.update(canvasShares).set({ expiresAt: null }).where(eq(canvasShares.canvasId, draft.id));
    expect((await join(replacement.token, "editor")).role).toBe("viewer");
    await json(await remove(draft.id, "stranger")); // Missing targets are idempotent.
});

test("editor writes use revision CAS and the actual actor; members and site-admin never acquire owner management", async () => {
    const draft = await create(), current = await link(draft.id, "editor");
    const accepted = await join(current.token, "editor");
    const saved = await json(await save(draft.id, 1, { marker, value: "editor" }, "editor"));
    expect(saved.draft.revision).toBe(2);
    expect(saved.access).toEqual({ role: "editor", ownerId: actors.owner.id, readOnly: false });
    expect(await error(await save(draft.id, 1, { overwritten: true }, "editor"), 409, "revision_conflict")).toMatchObject({ currentRevision: 2 });
    const audit = await database.db.select().from(auditEvent).where(eq(auditEvent.requestId, saved.requestId));
    expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ actorId: actors.editor.id, action: "canvas.saved", resourceId: draft.id, revision: 2 });
    for (const [path, body, method] of [[sharePath(draft.id), undefined, "GET"], [sharePath(draft.id, "share-link"), { role: "viewer", reset: true }, "POST"], [sharePath(draft.id, "members"), { userId: actors.viewer.id, role: "viewer" }, "POST"], [memberPath(draft.id, "viewer"), undefined, "DELETE"]] as Array<[string, unknown, string]>) await error(await request(path, body, "editor", { method }), 404, "not_found");
    const changed = (await json(await request(sharePath(draft.id, "members"), { userId: actors.editor.id, role: "viewer" }))).member;
    expect(changed.joinedAt).toBe(accepted.joinedAt);
    await error(await save(draft.id, 2, {}, "editor"), 404, "not_found");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, actors.stranger.id));
    try {
        await error(await request(sharePath(draft.id), undefined, "stranger"), 404, "not_found");
        await error(await request(`/api/v1/canvases/${draft.id}`, undefined, "stranger"), 404, "not_found");
    } finally { await database.db.update(user).set({ role: "user" }).where(eq(user.id, actors.stranger.id)); }
    const list = await json(await request("/api/v1/canvases", undefined, "editor"));
    expect(list.items.some((item: { id: string }) => item.id === draft.id)).toBe(false);
});

test("scoped media requires active canvas access and exact references, never membership in an owner's entire library", async () => {
    const referenced = await upload("owner"), unrelated = await upload("owner"), own = await upload("viewer");
    const draft = await create(documentWith(referenced.id)), current = await link(draft.id, "viewer");
    const scoped = `/api/v1/media/${referenced.id}?canvasId=${draft.id}`;
    await error(await request(scoped, undefined, "viewer"), 404, "not_found");
    await join(current.token, "viewer");
    const resolved = await json(await request(`/api/v1/media/resolve?canvasId=${draft.id}`, { ids: [referenced.id, unrelated.id, own.id] }, "viewer"));
    expect(resolved.items.map((item: { id: string }) => item.id)).toEqual([referenced.id]);
    expect(resolved.items[0].url).toBe(scoped);
    expect(resolved.missing).toEqual([unrelated.id, own.id]);
    expect(JSON.stringify(resolved)).not.toContain("objectKey");
    const binary = await request(scoped, undefined, "viewer"); expect(binary.status).toBe(200);
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(referenced.bytes);
    expect(binary.headers.get("cache-control")).toBe("private, no-store");
    for (const boundary of ["storage", "database"] as const) {
        faults.length = 0;
        if (boundary === "storage") storageFailure = marker + current.token; else databaseFailure = marker + current.token;
        try {
            const failed = await error(await request(scoped, undefined, "viewer"), 503, "service_unavailable");
            expect(faults).toEqual([{ requestId: failed.requestId, component: "accounts", code: "service_unavailable" }]);
        } finally { storageFailure = ""; databaseFailure = ""; }
    }
    await error(await request(`/api/v1/media/${referenced.id}`, undefined, "viewer"), 404, "not_found");
    const library = await json(await request("/api/v1/media", undefined, "viewer"));
    expect(library.items.map((item: { id: string }) => item.id)).toContain(own.id);
    expect(library.items.map((item: { id: string }) => item.id)).not.toContain(referenced.id);
    for (const [path, body, method] of [[`/api/v1/media?canvasId=${draft.id}`, undefined, "GET"], [scoped, undefined, "DELETE"], [`/api/v1/media/resolve?canvasId=${draft.id}&canvasId=${draft.id}`, { ids: [referenced.id] }, "POST"], [`${scoped}&extra=1`, undefined, "GET"]] as Array<[string, unknown, string]>) await error(await request(path, body, "viewer", { method }), 400, "invalid_input");
    await json(await remove(draft.id, "viewer"));
    await error(await request(scoped, undefined, "viewer"), 404, "not_found");
});

test("editor retains existing foreign references and adds only own uploads; deletion checks references across canvas owners", async () => {
    const source = await upload("owner"), unreferenced = await upload("owner"), added = await upload("editor"), stranger = await upload("stranger");
    const draft = await create(documentWith(source.id)), current = await link(draft.id, "editor"); await join(current.token, "editor");
    const editorBefore = (await json(await request("/api/v1/media", undefined, "editor"))).quota.usedBytes;
    const ownerBefore = (await json(await request("/api/v1/media", undefined, "owner"))).quota.usedBytes;
    await json(await save(draft.id, 1, documentWith(source.id, added.id), "editor"));
    for (const forbidden of [unreferenced.id, stranger.id]) await error(await save(draft.id, 2, documentWith(source.id, added.id, forbidden), "editor"), 400, "invalid_input");
    await json(await save(draft.id, 2, documentWith(source.id, added.id), "owner"));
    await error(await request(`/api/v1/media/${added.id}`, undefined, "editor", { method: "DELETE" }), 409, "media_referenced");
    expect((await json(await request("/api/v1/media", undefined, "editor"))).quota.usedBytes).toBe(editorBefore);
    expect((await json(await request("/api/v1/media", undefined, "owner"))).quota.usedBytes).toBe(ownerBefore);
    const [record] = await database.db.select().from(canvasDraft).where(eq(canvasDraft.id, draft.id));
    expect(record.ownerId).toBe(actors.owner.id); expect(record.revision).toBe(3);
    await error(await save(draft.id, 3, { nodes: [{ metadata: { cloudMediaId: source.id, content: "blob:synthetic" } }] }, "editor"), 400, "invalid_input");
    await json(await save(draft.id, 3, documentWith(source.id), "owner"));
    const removed = await json(await request(`/api/v1/media/${added.id}`, undefined, "editor", { method: "DELETE" }));
    expect(removed.quota.usedBytes).toBe(editorBefore - added.bytes.length);
    expect(locks.some((entry) => /for key share\b/i.test(entry.sql))).toBe(true);
});

test("controlled save/revoke ordering rechecks membership after the earlier canvas UPDATE transaction commits", async () => {
    // PGlite has one connection. These are controlled transaction interleavings,
    // not a claim of native PostgreSQL parallel lock arbitration.
    for (const first of ["save", "revoke"] as const) {
        const draft = await create(), current = await link(draft.id, "editor"); await join(current.token, "editor");
        locks.length = 0;
        gate = { strength: "update", claimed: false, entered: deferred<void>(), release: deferred<void>() };
        const firstRequest = first === "save" ? save(draft.id, 1, { marker, order: first }, "editor") : remove(draft.id, "editor");
        await gate.entered.promise;
        const secondRequest = first === "save" ? remove(draft.id, "editor") : save(draft.id, 1, { marker, order: first }, "editor");
        gate.release.resolve();
        const [earlier, later] = await Promise.all([firstRequest, secondRequest]);
        expect(earlier.status).toBe(200);
        if (first === "save") expect(later.status).toBe(200); else await error(later, 404, "not_found");
        const [stored] = await database.db.select().from(canvasDraft).where(eq(canvasDraft.id, draft.id));
        expect(stored.revision).toBe(first === "save" ? 2 : 1);
        await error(await save(draft.id, stored.revision, { stale: true }, "editor"), 404, "not_found");
        expect(locks.filter((entry) => entry.table === canvasDraft).every((entry) => /for update\b/i.test(entry.sql))).toBe(true);
        gate = undefined;
    }
}, 30_000);

test("an authorized SHARE read may complete before revocation; every later read and media resolution is denied", async () => {
    const media = await upload("owner"), draft = await create(documentWith(media.id)), current = await link(draft.id, "viewer"); await join(current.token, "viewer");
    locks.length = 0;
    gate = { strength: "share", claimed: false, entered: deferred<void>(), release: deferred<void>() };
    const reading = request(`/api/v1/canvases/${draft.id}`, undefined, "viewer");
    await gate.entered.promise;
    const revoked = remove(draft.id, "viewer"); gate.release.resolve();
    expect((await reading).status).toBe(200); expect((await revoked).status).toBe(200);
    gate = undefined;
    await error(await request(`/api/v1/canvases/${draft.id}`, undefined, "viewer"), 404, "not_found");
    await error(await request(`/api/v1/media/resolve?canvasId=${draft.id}`, { ids: [media.id] }, "viewer"), 404, "not_found");
    expect(locks.some((entry) => entry.table === canvasDraft && /for share\b/i.test(entry.sql))).toBe(true);
    expect(locks.some((entry) => entry.table === canvasDraft && /for update\b/i.test(entry.sql))).toBe(true);
});
