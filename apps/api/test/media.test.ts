import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createMemoryObjectStorage, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";
import { generationImageMediaId } from "../src/generation-image";

const origin = "http://localhost:4000";
const password = "test-only-media-password";
const secret = "test-only-" + crypto.randomUUID() + crypto.randomUUID();
const mails: { to: string; url: string }[] = [];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let aliceCookie = "";
let bobCookie = "";
let aliceId = "";
let bobId = "";
let storage: ObjectStorage;

function cookies(response: Response) {
    return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function request(path: string, init: RequestInit = {}, cookie = "", accountId?: string, peer = "198.51.100.90") {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    if (accountId) headers.set("x-canvas-account-id", accountId);
    return app(new Request(`${origin}${path}`, { ...init, headers }), peer);
}

async function register(name: string) {
    const email = `${name}@example.test`;
    const signup = await request("/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json", "x-captcha-response": "test-pass" },
        body: JSON.stringify({ name, email, password }),
    }, "", undefined, name === "alice-media" ? "198.51.100.91" : "198.51.100.92");
    expect(signup.status).toBe(200);
    const mail = mails.findLast((item) => item.to === email)!;
    expect((await app(new Request(mail.url), name === "alice-media" ? "198.51.100.91" : "198.51.100.92")).status).toBe(302);
    const login = await request("/api/auth/sign-in/email", {
        method: "POST", headers: { "content-type": "application/json", "x-captcha-response": "test-pass" },
        body: JSON.stringify({ email, password }),
    }, "", undefined, name === "alice-media" ? "198.51.100.91" : "198.51.100.92");
    expect(login.status).toBe(200);
    return cookies(login);
}

beforeAll(async () => {
    database = await createTestDatabase();
    storage = createMemoryObjectStorage();
    const options: Parameters<typeof createAccountApi>[0] = {
        database: database.db, origin,
        cloudCanvas: true,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
        rates: createRateStore(database.pool, secret),
        verifyHuman: async (request) => request.headers.get("x-captcha-response") === "test-pass",
        media: { storage, quotaBytes: 10, maxBytes: { image: 8, video: 8, audio: 8 } },
        onFault: () => {},
    };
    app = createApp(createAccountApi(options), "public-test-site-key", true, true);
    aliceCookie = await register("alice-media");
    bobCookie = await register("bob-media");
    aliceId = (await (await request("/api/v1/session", {}, aliceCookie)).json()).user.id;
    bobId = (await (await request("/api/v1/session", {}, bobCookie)).json()).user.id;
});

afterAll(async () => { await database.close(); });

describe("protected media storage HTTP", () => {
    test("uploads all supported media kinds, lists quota, reads bytes and deletes", async () => {
        const image = await request("/api/v1/media", {
            method: "POST", headers: { "content-type": "image/png", "content-length": "3" }, body: new Uint8Array([1, 2, 3]),
        }, aliceCookie, aliceId);
        expect(image.status).toBe(201);
        const created = await image.json();
        expect(created.media).toMatchObject({ kind: "image", contentType: "image/png", sizeBytes: 3, url: expect.stringContaining("/api/v1/media/") });
        expect(created.quota).toEqual({ quotaBytes: 10, usedBytes: 3, availableBytes: 7 });
        const mediaId = created.media.id;
        const listed = await request("/api/v1/media", {}, aliceCookie, aliceId);
        expect((await listed.json()).items).toHaveLength(1);
        const fetched = await request(`/api/v1/media/${mediaId}`, {}, aliceCookie, aliceId);
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get("content-type")).toBe("image/png");
        expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([1, 2, 3]);
        const deleted = await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
        expect(deleted.status).toBe(200);
        expect((await deleted.json()).quota.usedBytes).toBe(0);
    });

    test("rejects damaged media reads without changing ownership or quota", async () => {
        const repository = createMediaRepository(database.db);
        const before = await repository.getQuota(aliceId, 10);
        const uploaded = await request("/api/v1/media", {
            method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([51, 52, 53]),
        }, aliceCookie, aliceId);
        expect(uploaded.status).toBe(201);
        const mediaId = (await uploaded.json()).media.id as string;
        const row = (await repository.get(aliceId, mediaId))!;
        const quota = await repository.getQuota(aliceId, 10);
        const originalGet = storage.get;
        try {
            for (const fault of ["wrong-key", "short-body", "wrong-size", "wrong-type", "wrong-etag", "changed-body"] as const) {
                let reads = 0;
                storage.get = async (key) => {
                    const stored = await originalGet(key);
                    if (!stored || key !== row.objectKey) return stored;
                    reads++;
                    if (fault === "wrong-key") stored.metadata.key = objectKey("synthetic/wrong-object");
                    if (fault === "short-body") stored.body = stored.body.slice(0, -1);
                    if (fault === "wrong-size") stored.metadata.sizeBytes++;
                    if (fault === "wrong-type") stored.metadata.contentType = "text/plain";
                    if (fault === "wrong-etag") stored.metadata.etag = "synthetic-wrong-etag";
                    if (fault === "changed-body") stored.body = new Uint8Array([51, 52, 54]);
                    return stored;
                };
                const failed = await request(`/api/v1/media/${mediaId}`, {}, aliceCookie, aliceId);
                expect(failed.status).toBe(503);
                expect(await failed.json()).toEqual({ error: { code: "service_unavailable", message: "素材暂时不可读取，请稍后重试" }, requestId: expect.any(String) });
                expect(reads).toBe(1);
                expect(await repository.get(aliceId, mediaId)).toEqual(row);
                expect(await repository.getQuota(aliceId, 10)).toEqual(quota);
            }
            storage.get = originalGet;
            const recovered = await request(`/api/v1/media/${mediaId}`, {}, aliceCookie, aliceId);
            expect(recovered.status).toBe(200);
            expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(new Uint8Array([51, 52, 53]));
        } finally {
            storage.get = originalGet;
            expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId)).status).toBe(200);
        }
        expect(await repository.getQuota(aliceId, 10)).toEqual(before);
    });

    test("rejects unsupported types, per-file overflow and quota overflow without records", async () => {
        expect((await request("/api/v1/media", { method: "POST", headers: { "content-type": "text/plain" }, body: new Uint8Array([1]) }, aliceCookie, aliceId)).status).toBe(415);
        expect((await request("/api/v1/media", { method: "POST", headers: { "content-type": "video/mp4" }, body: new Uint8Array(9) }, aliceCookie, aliceId)).status).toBe(413);
        const first = await request("/api/v1/media", { method: "POST", headers: { "content-type": "audio/mpeg" }, body: new Uint8Array(8) }, aliceCookie, aliceId);
        expect(first.status).toBe(201);
        const second = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array(3) }, aliceCookie, aliceId);
        expect(second.status).toBe(413);
        expect((await (await request("/api/v1/media", {}, aliceCookie, aliceId)).json()).items).toHaveLength(1);
    });

    test("does not expose one account's media to another account", async () => {
        const created = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([4]) }, aliceCookie, aliceId);
        const mediaId = (await created.json()).media.id;
        expect((await request(`/api/v1/media/${mediaId}`, {}, bobCookie, bobId)).status).toBe(404);
        expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, bobCookie, bobId)).status).toBe(404);
        expect((await (await request("/api/v1/media", {}, bobCookie, bobId)).json()).items).toEqual([]);
    });

    test("resolves only owned media IDs and never returns provider object keys", async () => {
        const aliceItems = (await (await request("/api/v1/media", {}, aliceCookie, aliceId)).json()).items;
        expect(aliceItems.length).toBeGreaterThan(0);
        const bobUpload = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([8]) }, bobCookie, bobId);
        const bobMediaId = (await bobUpload.json()).media.id;
        const unknownId = "99999999-9999-4999-8999-999999999999";
        const resolved = await request("/api/v1/media/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [aliceItems[0].id, bobMediaId, unknownId] }) }, aliceCookie, aliceId);
        expect(resolved.status).toBe(200);
        const data = await resolved.json();
        expect(data.items).toHaveLength(1);
        expect(data.items[0]).toMatchObject({ id: aliceItems[0].id, kind: aliceItems[0].kind });
        expect(data.items[0]).not.toHaveProperty("objectKey");
        expect(data.missing).toEqual([bobMediaId, unknownId]);
        expect((await request(`/api/v1/media/${bobMediaId}`, { method: "DELETE" }, bobCookie, bobId)).status).toBe(200);
    });

    test("requires a page account context even with a valid session", async () => {
        expect((await request("/api/v1/media", {}, aliceCookie)).status).toBe(400);
        expect((await request("/api/v1/media", {}, aliceCookie, bobId)).status).toBe(409);
    });

    test("does not delete media referenced by an owned cloud draft, then permits deletion after unlinking", async () => {
        const uploaded = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([7]) }, aliceCookie, aliceId);
        const mediaId = (await uploaded.json()).media.id;
        const creationId = crypto.randomUUID();
        const created = await request("/api/v1/canvases", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creationId, title: "引用测试", documentVersion: 1, document: { nodes: [{ metadata: { cloudMediaId: mediaId } }] } }),
        }, aliceCookie, aliceId);
        expect(created.status).toBe(201);
        const blocked = await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
        expect(blocked.status).toBe(409);
        expect((await blocked.json()).error.code).toBe("media_referenced");
        const unlinked = await request(`/api/v1/canvases/${creationId}`, {
            method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "引用测试", documentVersion: 1, document: {}, expectedRevision: 1 }),
        }, aliceCookie, aliceId);
        expect(unlinked.status).toBe(200);
        expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId)).status).toBe(200);
    });

    test("generated v5 media saves to its owner's canvas and keeps foreign references blocked", async () => {
        const repository = createMediaRepository(database.db), mediaId = generationImageMediaId(crypto.randomUUID(), 1);
        const key = objectKey(`synthetic/generated/${mediaId}`), body = new Uint8Array([7]);
        const stored = await storage.put({ key, body, contentType: "image/png" });
        expect(await repository.reserve(aliceId, body.length, 10)).toBe(true);
        await repository.add(aliceId, { id: mediaId, objectKey: key, kind: "image", contentType: "image/png", sizeBytes: body.length, etag: stored.etag });
        const creationId = crypto.randomUUID(), document = { nodes: [{ type: "image", metadata: { cloudMediaId: mediaId } }] };
        const input = { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ creationId, title: "Generated batch reference", documentVersion: 1, document }) };
        try {
            expect((await request("/api/v1/canvases", input, bobCookie, bobId)).status).toBe(400);
            const saved = await request("/api/v1/canvases", input, aliceCookie, aliceId);
            expect(saved.status).toBe(201);
            const read = await request(`/api/v1/canvases/${creationId}`, {}, aliceCookie, aliceId);
            expect((await read.json()).draft.document).toEqual(document);
            expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId)).status).toBe(409);
        } finally {
            await request(`/api/v1/canvases/${creationId}`, { method: "PUT", headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "Generated batch reference", documentVersion: 1, document: {}, expectedRevision: 1 }) }, aliceCookie, aliceId);
            await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
        }
    });

    test("keeps the DB row when object deletion fails or the object is missing", async () => {
        const uploaded = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([9]) }, aliceCookie, aliceId);
        expect(uploaded.status).toBe(201);
        const mediaId = (await uploaded.json()).media.id as string;
        const originalDelete = storage.delete;
        storage.delete = async () => { throw new Error("simulated OSS failure"); };
        const failed = await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
        expect(failed.status).toBe(503);
        storage.delete = originalDelete;
        expect((await request(`/api/v1/media/${mediaId}`, {}, aliceCookie, aliceId)).status).toBe(200);

        const row = await createMediaRepository(database.db).get(aliceId, mediaId);
        expect(row).not.toBeNull();
        await storage.delete(objectKey(row!.objectKey));
        const missing = await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
        expect(missing.status).toBe(503);
        expect((await request(`/api/v1/media/${mediaId}`, {}, aliceCookie, aliceId)).status).toBe(503);
        await storage.put({ key: objectKey(row!.objectKey), body: new Uint8Array([9]), contentType: row!.contentType });
        expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId)).status).toBe(200);
    });

    test("restores a deleted object when the storage delete acknowledgement is lost", async () => {
        const repository = createMediaRepository(database.db);
        const before = await repository.getQuota(aliceId, 10);
        const uploaded = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([41]) }, aliceCookie, aliceId);
        expect(uploaded.status).toBe(201);
        const mediaId = (await uploaded.json()).media.id as string;
        const row = (await repository.get(aliceId, mediaId))!;
        const key = objectKey(row.objectKey);
        const originalDelete = storage.delete;
        storage.delete = async (key) => { await originalDelete(key); throw new Error("private OSS response lost"); };
        try {
            const failed = await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
            expect(failed.status).toBe(503);
            expect(await failed.json()).toMatchObject({ error: { code: "service_unavailable", message: "素材删除暂时不可用，请稍后重试" } });
            expect(await repository.get(aliceId, mediaId)).toEqual(row);
            expect(await repository.getQuota(aliceId, 10)).toEqual({ ...before, usedBytes: before.usedBytes + 1, availableBytes: before.availableBytes - 1 });
            const recovered = await storage.get(key);
            expect(recovered?.metadata).toMatchObject({ key, etag: row.etag, contentType: row.contentType, sizeBytes: 1 });
            expect(recovered?.body).toEqual(new Uint8Array([41]));
            const fetched = await request(`/api/v1/media/${mediaId}`, {}, aliceCookie, aliceId);
            expect(fetched.status).toBe(200);
            expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(new Uint8Array([41]));
        } finally {
            storage.delete = originalDelete;
            await storage.put({ key, body: new Uint8Array([41]), contentType: row.contentType });
            expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId)).status).toBe(200);
        }
        expect(await repository.get(aliceId, mediaId)).toBeNull();
        expect(await storage.get(key)).toBeNull();
        expect(await repository.getQuota(aliceId, 10)).toEqual(before);
    });

    for (const restoration of ["throws", "wrong-key", "wrong-size", "wrong-etag", "wrong-content-type"] as const) {
        test(`keeps ownership and quota pending recovery when object restoration ${restoration}`, async () => {
            const repository = createMediaRepository(database.db);
            const uploaded = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([42]) }, aliceCookie, aliceId);
            expect(uploaded.status).toBe(201);
            const mediaId = (await uploaded.json()).media.id as string;
            const row = (await repository.get(aliceId, mediaId))!;
            const quota = await repository.getQuota(aliceId, 10);
            const key = objectKey(row.objectKey);
            const originalDelete = storage.delete, originalPut = storage.put;
            storage.delete = async (key) => { await originalDelete(key); throw new Error("private OSS response lost"); };
            storage.put = async (input) => {
                if (restoration === "throws") throw new Error("private OSS restore failed");
                const restored = await originalPut(input);
                if (restoration === "wrong-key") return { ...restored, key: objectKey("test/wrong-object") };
                if (restoration === "wrong-size") return { ...restored, sizeBytes: restored.sizeBytes + 1 };
                return restoration === "wrong-etag" ? { ...restored, etag: "wrong-etag" } : { ...restored, contentType: "text/plain" };
            };
            try {
                const failed = await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
                expect(failed.status).toBe(503);
                expect(await failed.json()).toMatchObject({ error: { code: "service_unavailable", message: "素材删除状态待恢复，请稍后重试" } });
                expect(await repository.get(aliceId, mediaId)).toEqual(row);
                expect(await repository.getQuota(aliceId, 10)).toEqual(quota);
            } finally {
                storage.delete = originalDelete; storage.put = originalPut;
                await storage.put({ key, body: new Uint8Array([42]), contentType: row.contentType });
                expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId)).status).toBe(200);
            }
        });
    }

    test("restores the object and quota when a deferred database constraint rejects deletion at commit", async () => {
        const repository = createMediaRepository(database.db);
        const before = await repository.getQuota(aliceId, 10);
        const uploaded = await request("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([43]) }, aliceCookie, aliceId);
        expect(uploaded.status).toBe(201);
        const mediaId = (await uploaded.json()).media.id as string;
        const row = (await repository.get(aliceId, mediaId))!;
        // A deferred trigger fails after the DELETE callback has completed,
        // exercising the outer transaction compensation rather than a stub.
        await database.db.execute(sql.raw(`CREATE FUNCTION canvas_saas.test_media_delete_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only commit failure'; END $$`));
        await database.db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER test_media_delete_commit_failure AFTER DELETE ON canvas_saas.media_object DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.id = '${mediaId}') EXECUTE FUNCTION canvas_saas.test_media_delete_commit_failure()`));
        try {
            const failed = await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId);
            expect(failed.status).toBe(503);
            expect(await repository.get(aliceId, mediaId)).toEqual(row);
            expect(await repository.getQuota(aliceId, 10)).toEqual({ ...before, usedBytes: before.usedBytes + 1, availableBytes: before.availableBytes - 1 });
            const recovered = await storage.get(objectKey(row.objectKey));
            expect(recovered?.metadata.etag).toBe(row.etag);
            expect(recovered?.body).toEqual(new Uint8Array([43]));
        } finally {
            await database.db.execute(sql.raw("DROP TRIGGER test_media_delete_commit_failure ON canvas_saas.media_object"));
            await database.db.execute(sql.raw("DROP FUNCTION canvas_saas.test_media_delete_commit_failure()"));
            expect((await request(`/api/v1/media/${mediaId}`, { method: "DELETE" }, aliceCookie, aliceId)).status).toBe(200);
        }
        expect(await repository.getQuota(aliceId, 10)).toEqual(before);
    });
});
