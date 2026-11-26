import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "@infinite-canvas/auth";
import { createDatabase } from "@infinite-canvas/database";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createDraftRepository } from "@infinite-canvas/database/drafts";
import { createCanvasSharingRepository } from "@infinite-canvas/database/canvas-sharing";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { auditEvent, canvasDraft, canvasMembers, canvasShares, mediaObject, rateLimit, session, storageQuota, user } from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { createAccountApi } from "../src/accounts";
import { createTestDatabase, postgresTestUrl } from "./database";

const origin = "http://localhost:4091", secret = crypto.randomUUID() + crypto.randomUUID();
const password = "synthetic-cloud-session-password";
const storage = createMemoryObjectStorage();
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let api: ReturnType<typeof createAccountApi>;
let actor: typeof user.$inferSelect, originalSession: typeof session.$inferSelect;
let cookie = "", targetId = "", canvasId = "", joinToken = "", mediaId = "";
let invalidate: (() => Promise<void>) | undefined;
let loseCommitResponse = false;
let holdWrite: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
const operations = { put: 0, delete: 0 };

function request(path: string, method: string, body?: unknown, contentType = "application/json") {
    return new Request(origin + path, { method, headers: { origin, cookie, "x-canvas-account-id": actor.id, "content-type": contentType },
        ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }) });
}

beforeAll(async () => {
    database = await createTestDatabase();
    const authOptions = { secret, sendVerificationEmail: async () => undefined };
    const auth = createAuth({ ...authOptions, database: database.db, baseURL: origin });
    const email = `cloud-session-${crypto.randomUUID()}@example.test`;
    const login = (path: string, body: object) => auth.handler(new Request(origin + "/api/auth/" + path, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await login("sign-up/email", { name: "Synthetic cloud actor", email, password })).status).toBe(200);
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
    const signedIn = await login("sign-in/email", { email, password });
    expect(signedIn.status).toBe(200);
    cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    [actor] = await database.db.select().from(user).where(eq(user.email, email));
    [originalSession] = await database.db.select().from(session).where(eq(session.userId, actor.id));
    targetId = crypto.randomUUID();
    await database.db.insert(user).values({ id: targetId, email: `${targetId}@example.test`, name: "Synthetic member", emailVerified: true });
    const create = async (ownerId: string) => {
        const result = await createDraftRepository(database.db).createOnce(ownerId, { creationId: crypto.randomUUID(), title: "Synthetic private draft", document: {} });
        if (result.status !== "saved") throw new Error("Synthetic draft was not created");
        return result.draft.id;
    };
    canvasId = await create(actor.id);
    const shares = createCanvasSharingRepository(database.db);
    await shares.upsertMember(actor.id, canvasId, { userId: targetId, role: "viewer" });
    const invitation = await shares.shareLink(targetId, await create(targetId), { role: "viewer" });
    if (invitation.status !== "saved") throw new Error("Synthetic invitation was not created");
    joinToken = invitation.share.token;
    mediaId = crypto.randomUUID();
    const stored = await storage.put({ key: objectKey(`accounts/${Buffer.from(actor.id).toString("base64url")}/media/${mediaId}`), body: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    const media = createMediaRepository(database.db);
    await media.reserve(actor.id, 3, 100);
    await media.add(actor.id, { id: mediaId, objectKey: stored.key, kind: "image", contentType: stored.contentType, sizeBytes: stored.sizeBytes, etag: stored.etag });
    const limiter = createRateStore(database.pool, secret);
    const observedDatabase = new Proxy(database.db, { get(target, property) {
        if (property === "transaction") return async (...args: Parameters<typeof target.transaction>) => {
            const [callback, ...options] = args;
            const result = await target.transaction(async tx => {
                const value = await callback(tx);
                if (holdWrite) { holdWrite.entered.resolve(); await holdWrite.release.promise; }
                return value;
            }, ...options);
            if (loseCommitResponse) { loseCommitResponse = false; throw new Error("Synthetic COMMIT response lost"); }
            return result;
        };
        const member = Reflect.get(target, property);
        return typeof member === "function" ? member.bind(target) : member;
    } });
    api = createAccountApi({ database: observedDatabase, origin, auth: authOptions, cloudCanvas: true,
        rates: { async consume(bucket, identity, rule) {
            const decision = await limiter.consume(bucket, identity, rule);
            if (invalidate) { const change = invalidate; invalidate = undefined; await change(); }
            return decision;
        } }, verifyHuman: async () => true, onFault: () => undefined,
        media: { quotaBytes: 100, maxBytes: { image: 20, audio: 20, video: 20 }, storage: {
            get: key => storage.get(key),
            async put(input) { operations.put++; return storage.put(input); },
            async delete(key) { operations.delete++; return storage.delete(key); },
        } } });
}, 30_000);

beforeEach(async () => { await database.db.delete(rateLimit); operations.put = 0; operations.delete = 0; });
afterEach(async () => {
    invalidate = undefined;
    loseCommitResponse = false;
    holdWrite?.release.resolve(); holdWrite = undefined;
    await database.db.update(user).set({ disabled: actor.disabled, emailVerified: actor.emailVerified, moderationVersion: actor.moderationVersion }).where(eq(user.id, actor.id));
    await database.db.delete(session).where(eq(session.id, originalSession.id));
    await database.db.insert(session).values(originalSession);
});
afterAll(async () => { await database?.close(); });

async function businessState() {
    return { drafts: await database.db.select().from(canvasDraft).orderBy(canvasDraft.id),
        members: await database.db.select().from(canvasMembers).orderBy(canvasMembers.canvasId, canvasMembers.userId),
        shares: await database.db.select().from(canvasShares).orderBy(canvasShares.id),
        media: await database.db.select().from(mediaObject).orderBy(mediaObject.id),
        quota: await database.db.select().from(storageQuota).orderBy(storageQuota.userId),
        audit: await database.db.select().from(auditEvent).orderBy(auditEvent.id) };
}

const routes = ["create", "save", "share-link", "member", "remove-member", "join", "upload", "delete-media"] as const;
for (const route of routes) for (const change of ["revoked", "expired", "disabled", "unverified", "moderation-version"] as const) {
    test(`${route} refuses ${change} after entry authentication without changing private data`, async () => {
        const before = await businessState();
        invalidate = async () => {
            if (change === "revoked") await database.db.delete(session).where(eq(session.id, originalSession.id));
            else if (change === "expired") await database.db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.id, originalSession.id));
            else await database.db.update(user).set(change === "disabled" ? { disabled: true } : change === "unverified" ? { emailVerified: false } : { moderationVersion: actor.moderationVersion + 1 }).where(eq(user.id, actor.id));
        };
        const input = route === "create" ? request("/api/v1/canvases", "POST", { creationId: crypto.randomUUID(), title: "Delayed create", documentVersion: 1, document: {} })
            : route === "save" ? request(`/api/v1/canvases/${canvasId}`, "PUT", { title: "Delayed save", documentVersion: 1, document: { delayed: true }, expectedRevision: 1 })
            : route === "share-link" ? request(`/api/v1/canvas/${canvasId}/share-link`, "POST", { role: "editor", reset: true })
            : route === "member" ? request(`/api/v1/canvas/${canvasId}/members`, "POST", { userId: targetId, role: "editor" })
            : route === "remove-member" ? request(`/api/v1/canvas/${canvasId}/members/${targetId}`, "DELETE")
            : route === "join" ? request(`/api/v1/canvas/share/${joinToken}/join`, "POST", {})
            : route === "upload" ? request("/api/v1/media", "POST", new Uint8Array([4, 5, 6]), "image/png")
            : request(`/api/v1/media/${mediaId}`, "DELETE");
        const response = await api(input, "198.51.100.93");
        expect(invalidate).toBeUndefined();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe("account_changed");
        expect(await businessState()).toEqual(before);
        expect(operations).toEqual({ put: 0, delete: 0 });
        expect(await storage.get(objectKey(before.media[0].objectKey))).not.toBeNull();
    });
}

test("an upload with a lost COMMIT response retains its media, bytes and quota", async () => {
    const before = await businessState();
    loseCommitResponse = true;
    const response = await api(request("/api/v1/media", "POST", new Uint8Array([7, 8, 9]), "image/png"), "198.51.100.93");
    expect(response.status).toBe(503);
    expect(loseCommitResponse).toBe(false);
    const after = await businessState();
    const added = after.media.find(row => !before.media.some(original => original.id === row.id))!;
    expect(added).toMatchObject({ ownerId: actor.id, sizeBytes: 3 });
    expect(after.media).toHaveLength(before.media.length + 1);
    expect(after.quota[0].usedBytes).toBe(before.quota[0].usedBytes + 3);
    expect((await storage.get(objectKey(added.objectKey)))?.body).toEqual(new Uint8Array([7, 8, 9]));
    expect(operations).toEqual({ put: 1, delete: 0 });
    expect((await api(request(`/api/v1/media/${added.id}`, "DELETE"), "198.51.100.93")).status).toBe(200);
    const restored = await businessState();
    expect({ ...restored, quota: before.quota }).toEqual(before);
    expect(restored.quota.map(({ updatedAt, ...quota }) => quota)).toEqual(before.quota.map(({ updatedAt, ...quota }) => quota));
});

const postgresUrl = postgresTestUrl();
if (postgresUrl) {
    async function lockWait(connection: ReturnType<typeof createDatabase>, application: string) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const result = await connection.pool.query({ text: "SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", values: [application] });
            if (result.rows.length) return result.rows[0];
            await Bun.sleep(10);
        }
        throw new Error("Expected an actual PostgreSQL lock wait");
    }
    for (const route of ["create", "upload", "share-link", "delete-media"] as const) {
        test(`${route} holds the original session until its database write commits`, async () => {
            const target = new URL(postgresUrl);
            const application = `cloud-revoke-${crypto.randomUUID()}`;
            target.searchParams.set("application_name", application);
            const revoker = createDatabase(target.toString());
            const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
            holdWrite = gate;
            let pending: Promise<Response> | undefined, revoked: Promise<{ rows: unknown[] }> | undefined;
            try {
                const input = route === "create" ? request("/api/v1/canvases", "POST", { creationId: crypto.randomUUID(), title: "Locked create", documentVersion: 1, document: {} })
                    : route === "upload" ? request("/api/v1/media", "POST", new Uint8Array([10, 11, 12]), "image/png")
                    : route === "share-link" ? request(`/api/v1/canvas/${canvasId}/share-link`, "POST", { role: "viewer" })
                    : request(`/api/v1/media/${mediaId}`, "DELETE");
                const replay = input.clone();
                pending = api(input, "198.51.100.93");
                await Promise.race([gate.entered.promise, pending.then(() => { throw new Error("Expected the write to pause before COMMIT"); })]);
                revoked = revoker.pool.query({ text: "DELETE FROM canvas_saas.session WHERE id=$1 RETURNING id", values: [originalSession.id] });
                const blocked = await lockWait(revoker, application);
                expect(blocked.blockers.length).toBeGreaterThan(0);
                gate.release.resolve(); holdWrite = undefined;
                const response = await pending;
                expect(response.status).toBe(route === "create" || route === "upload" ? 201 : 200);
                expect((await revoked).rows).toHaveLength(1);
                const accepted = await businessState();
                expect((await api(replay, "198.51.100.93")).status).toBe(401);
                expect(await businessState()).toEqual(accepted);
                console.log(JSON.stringify({ scenario: "cloud-write-session-lock", route, blocked, outcome: "commit-before-revocation" }));
            } finally {
                gate.release.resolve(); holdWrite = undefined;
                await pending; await revoked; await revoker.close();
            }
        }, 30_000);
    }
    test("a write waiting for its user lock rejects a session revoked while waiting", async () => {
        const target = new URL(postgresUrl), application = `cloud-write-wait-${crypto.randomUUID()}`;
        target.searchParams.set("application_name", application);
        const blocker = createDatabase(target.toString()), client = await blocker.pool.connect();
        let pending: Promise<Response> | undefined;
        try {
            const before = await businessState();
            await client.query("BEGIN");
            await client.query('SELECT id FROM canvas_saas."user" WHERE id=$1 FOR UPDATE', [actor.id]);
            pending = api(request("/api/v1/canvases", "POST", { creationId: crypto.randomUUID(), title: "Waiting create", documentVersion: 1, document: {} }), "198.51.100.93");
            const deadline = Date.now() + 5000;
            let blocked: unknown;
            while (Date.now() < deadline) {
                const waiting = await client.query("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))");
                if (waiting.rows.length) { blocked = waiting.rows[0]; break; }
                await Bun.sleep(10);
            }
            expect(blocked).toBeDefined();
            await blocker.db.delete(session).where(eq(session.id, originalSession.id));
            await client.query("ROLLBACK");
            const response = await pending;
            expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("account_changed");
            expect(await businessState()).toEqual(before);
            console.log(JSON.stringify({ scenario: "cloud-write-user-lock-wait", blocked, outcome: "revoked-session-rejected" }));
        } finally {
            await client.query("ROLLBACK"); client.release(); await pending; await blocker.close();
        }
    }, 30_000);
}

test("an upload rejected at COMMIT rolls back both the media and quota before object cleanup", async () => {
    const before = await businessState();
    await database.db.execute(sql.raw("CREATE FUNCTION canvas_saas.test_upload_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic upload commit failure'; END $$"));
    await database.db.execute(sql.raw("CREATE CONSTRAINT TRIGGER test_upload_commit_failure AFTER INSERT ON canvas_saas.media_object DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION canvas_saas.test_upload_commit_failure()"));
    try {
        const response = await api(request("/api/v1/media", "POST", new Uint8Array([7, 8, 9]), "image/png"), "198.51.100.93");
        expect(response.status).toBe(503);
        expect(await businessState()).toEqual(before);
        expect(operations).toEqual({ put: 1, delete: 1 });
    } finally {
        await database.db.execute(sql.raw("DROP TRIGGER test_upload_commit_failure ON canvas_saas.media_object"));
        await database.db.execute(sql.raw("DROP FUNCTION canvas_saas.test_upload_commit_failure()"));
    }
});
