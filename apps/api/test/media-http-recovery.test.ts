import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { session as sessionTable, user as userTable } from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { createDraftRepository } from "@infinite-canvas/database/drafts";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createMediaClient } from "../../../web/src/services/api/media";
import { createDraftClient } from "../../../web/src/services/saas/drafts";
import { createAccountDraftStore } from "../../../web/src/services/saas/account-draft-store";
import { createAccountDraftWorkspace } from "../../../web/src/services/saas/account-draft-workspace";
import { createAccountClient } from "../../../web/src/services/saas/account";
import type { AccountSessionSync } from "../../../web/src/services/saas/account-session-sync";
import { getAccountLocalScope, setAccountLocalAccount } from "../../../web/src/services/saas/account-local-scope";
import { createAccountStore } from "../../../web/src/stores/use-account-store";
import { loadProjectCloudMedia, startProjectRestore } from "../../../web/src/pages/canvas/project-restore";
import { revokeCloudMediaObjectUrls } from "../../../web/src/services/saas/cloud-media-hydration";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

// Resolve the Web package's existing test dependency without installing a
// global IndexedDB shim or adding a second dependency to the API workspace.
const { IDBFactory } = createRequire(new URL("../../../web/package.json", import.meta.url))("fake-indexeddb");

// Real loopback HTTP and database, synthetic identity and object storage.
// This checks staging/cleanup, not browser rendering or an OSS restore.
test("a corrupt second media object over HTTP cannot stage a partial cloud draft", async () => {
    const database = await createTestDatabase();
    try {
        let app: ReturnType<typeof createApp>;
        const requests: { method: string; path: string; status: number }[] = [];
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
            const response = await app(request, server.requestIP(request)?.address);
            const path = new URL(request.url).pathname;
            if (path.startsWith("/api/v1/canvases") || path.startsWith("/api/v1/media")) {
                requests.push({ method: request.method, path, status: response.status });
            }
            return response;
        } });
        let workspace: ReturnType<typeof createAccountDraftWorkspace> | undefined;
        const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
        const previews: string[] = [], revoked: string[] = [];
        try {
            const origin = `http://127.0.0.1:${server.port}`;
            const secret = "synthetic-media-recovery-" + crypto.randomUUID() + crypto.randomUUID();
            const mails: { to: string; url: string }[] = [];
            const storage = createMemoryObjectStorage();
            app = createApp(createAccountApi({
                database: database.db, origin, cloudCanvas: true,
                auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
                rates: createRateStore(database.pool, secret),
                verifyHuman: async (request) => request.headers.get("x-captcha-response") === "synthetic-pass",
                media: { storage, quotaBytes: 10, maxBytes: { image: 8, video: 8, audio: 8 } },
                onFault: () => {},
            }), "synthetic-public-site-key", true, true);
            const authRequest = (path: string, body?: object, cookie = "") => fetch(new URL(path, origin), {
                method: body === undefined ? "GET" : "POST", redirect: "manual",
                headers: { origin, cookie, "content-type": "application/json", "x-captcha-response": "synthetic-pass" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const email = `media-recovery-${crypto.randomUUID()}@example.test`, password = "synthetic-media-recovery-password";
            const signup = await authRequest("/api/auth/sign-up/email", { name: "Media recovery", email, password });
            expect(signup.status).toBe(200); await signup.text();
            const verification = await authRequest(mails.find((mail) => mail.to === email)!.url);
            expect(verification.status).toBe(302); await verification.text();
            const login = await authRequest("/api/auth/sign-in/email", { email, password });
            expect(login.status).toBe(200);
            const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
            await login.text();
            const identity = await authRequest("/api/v1/session", undefined, cookie);
            expect(identity.status).toBe(200);
            const { user } = await identity.json();
            const scope = { accountId: user.id as string, epoch: 1 };
            const transport: typeof fetch = Object.assign((path: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
                const headers = new Headers(options?.headers);
                headers.set("origin", origin); headers.set("cookie", cookie);
                return fetch(new URL(String(path), origin), { ...options, headers });
            }, { preconnect: fetch.preconnect });
            const media = createMediaClient(() => scope.accountId, transport);
            const first = (await media.upload(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }))).media;
            const second = (await media.upload(new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }))).media;
            const document = {
                id: "synthetic-media-source", title: "媒体恢复检查", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
                nodes: [first, second].map((item, index) => ({ id: `image-${index}`, type: "image", title: "图片", position: { x: index * 200, y: 0 }, width: 200, height: 100,
                    metadata: { cloudMediaId: item.id, content: "", status: "success" } })),
                connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
            };
            const created = await createDraftClient(() => scope, transport).create({ title: document.title, documentVersion: 1, document });
            const repository = createMediaRepository(database.db);
            const secondRow = (await repository.get(scope.accountId, second.id))!;
            const quota = await repository.getQuota(scope.accountId, 10);
            // Keep both the original metadata and length while changing bytes,
            // like a damaged on-disk object with its old metadata sidecar.
            const originalGet = storage.get;
            storage.get = async (key) => {
                const result = await originalGet(key);
                return result && key === secondRow.objectKey ? { ...result, body: new Uint8Array([4, 5, 7]) } : result;
            };

            const factory = new IDBFactory();
            const store = createAccountDraftStore(() => new Promise<IDBDatabase>((resolve, reject) => {
                const request = factory.open("synthetic-media-recovery", 1);
                request.onupgradeneeded = () => request.result.createObjectStore("canvas_drafts");
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }));
            workspace = createAccountDraftWorkspace(() => ({ ...scope, cloudCanvas: true }), store,
                (getScope) => createDraftClient(getScope, transport), (getScope) => createMediaClient(() => getScope()?.accountId ?? null, transport));
            const local = { ...document, id: "synthetic-media-target", title: "保留当前本机内容", nodes: [] };
            workspace.createLocal(local);
            const localRecord = await workspace.saveLocal();
            requests.length = 0;
            URL.createObjectURL = (blob) => { const url = originalCreate(blob); previews.push(url); return url; };
            URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };

            await expect(workspace.openCloud(created.id)).rejects.toMatchObject({ code: "media_unavailable" });
            expect(requests).toEqual([
                { method: "GET", path: `/api/v1/canvases/${created.id}`, status: 200 },
                { method: "POST", path: "/api/v1/media/resolve", status: 200 },
                { method: "GET", path: `/api/v1/media/${first.id}`, status: 200 },
                { method: "GET", path: `/api/v1/media/${second.id}`, status: 503 },
            ]);
            expect(previews).toHaveLength(1);
            expect(revoked).toEqual(previews);
            expect(workspace.getCloudMediaObjectUrls()).toEqual([]);
            expect(workspace.getState()).toMatchObject({ phase: "error", project: local, draft: localRecord, dirty: false });
            expect(await store.read(scope.accountId, created.id)).toBeNull();
            expect(await store.read(scope.accountId, local.id)).toEqual(localRecord);
            expect(await repository.get(scope.accountId, second.id)).toEqual(secondRow);
            expect(await repository.getQuota(scope.accountId, 10)).toEqual(quota);
            expect(await createDraftRepository(database.db).get(scope.accountId, created.id)).toMatchObject({ revision: 1, document });
            expect((await originalGet(objectKey(secondRow.objectKey)))!.body).toEqual(new Uint8Array([4, 5, 6]));
        } finally {
            workspace?.dispose();
            previews.forEach((url) => originalRevoke(url));
            URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
            await server.stop(true);
        }
    } finally { await database.close(); }
}, 30_000);

// The backend role change is real in the isolated database. Only the visibility
// notification and delivery of an already authenticated HTTP 200 are controlled.
test("real role downgrade preserves the cookie and owner while rejecting late media from the old scope", async () => {
    const database = await createTestDatabase();
    let captured!: () => void, release!: () => void;
    const mediaCaptured = new Promise<void>((resolve) => { captured = resolve; });
    const releaseMedia = new Promise<void>((resolve) => { release = resolve; });
    const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
    const previews: string[] = [], revoked: string[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;
    let restore: ReturnType<typeof startProjectRestore> | undefined;
    let freshRestore: ReturnType<typeof startProjectRestore> | undefined;
    let recheck: Promise<void> | undefined;
    try {
        let app: ReturnType<typeof createApp>;
        let delayedMediaPath = "";
        const requests: { method: string; path: string; status: number }[] = [];
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
            const response = await app(request, server.requestIP(request)?.address);
            const path = new URL(request.url).pathname;
            requests.push({ method: request.method, path, status: response.status });
            if (request.method === "GET" && path === delayedMediaPath && response.status === 200) {
                delayedMediaPath = "";
                const body = await response.arrayBuffer();
                captured();
                await releaseMedia;
                return new Response(body, { status: response.status, headers: response.headers });
            }
            return response;
        } });
        const origin = `http://127.0.0.1:${server.port}`;
        const secret = "synthetic-role-recovery-" + crypto.randomUUID() + crypto.randomUUID();
        const mails: { to: string; url: string }[] = [];
        app = createApp(createAccountApi({
            database: database.db, origin, cloudCanvas: true,
            auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
            rates: createRateStore(database.pool, secret),
            verifyHuman: async (request) => request.headers.get("x-captcha-response") === "synthetic-pass",
            media: { storage: createMemoryObjectStorage(), quotaBytes: 10, maxBytes: { image: 8, video: 8, audio: 8 } },
            onFault: () => {},
        }), "synthetic-public-site-key", true, true);
        const authRequest = (path: string, body?: object) => fetch(new URL(path, origin), {
            method: body === undefined ? "GET" : "POST", redirect: "manual",
            headers: { origin, "content-type": "application/json", "x-captcha-response": "synthetic-pass" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const email = `role-recovery-${crypto.randomUUID()}@example.test`, password = "synthetic-role-recovery-password";
        const signup = await authRequest("/api/auth/sign-up/email", { name: "Role recovery", email, password });
        expect(signup.status).toBe(200); await signup.text();
        const verification = await authRequest(mails.find((mail) => mail.to === email)!.url);
        expect(verification.status).toBe(302); await verification.text();
        const login = await authRequest("/api/auth/sign-in/email", { email, password });
        expect(login.status).toBe(200);
        // Every later HTTP request uses this same cookie; no re-login or bootstrap adminEmail.
        const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        await login.text();
        const [owner] = await database.db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, email));
        await database.db.update(userTable).set({ role: "admin" }).where(eq(userTable.id, owner.id));
        const sessions = await database.db.select({ id: sessionTable.id }).from(sessionTable).where(eq(sessionTable.userId, owner.id));
        expect(sessions).toHaveLength(1);
        const transport: typeof fetch = Object.assign((path: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(options?.headers);
            headers.set("origin", origin); headers.set("cookie", cookie);
            return fetch(new URL(String(path), origin), { ...options, headers });
        }, { preconnect: fetch.preconnect });
        let visible = () => {};
        const sync: AccountSessionSync = {
            publishInvalidated: () => {}, subscribeInvalidated: () => () => {}, close: () => {},
            subscribeVisible: (listener) => { visible = listener; return () => { visible = () => {}; }; },
        };
        const account = createAccountStore(createAccountClient(transport), sync);
        await account.getState().initialize();
        const scope = account.getState().getDraftScope()!;
        const localScope = getAccountLocalScope();
        expect(account.getState()).toMatchObject({ status: "ready", user: { id: owner.id, role: "admin" } });
        expect(localScope).toMatchObject({ accountId: owner.id });
        const allowedAdmin = await transport("/api/v1/admin/providers", { headers: { "x-canvas-account-id": scope.accountId } });
        expect(allowedAdmin.status).toBe(200); await allowedAdmin.text();
        const bytes = new Uint8Array([1, 2, 3]);
        const media = createMediaClient(() => account.getState().getDraftScope()?.accountId ?? null, transport);
        const upload = await media.upload(new Blob([bytes], { type: "image/png" }));
        const document = {
            id: "synthetic-role-project", title: "角色变化保留原稿", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            nodes: [{ id: "image", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 200, height: 100,
                metadata: { cloudMediaId: upload.media.id, content: "", status: "success" } }],
            connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        };
        const original = structuredClone(document);
        const draft = await createDraftClient(account.getState().getDraftScope, transport).create({ title: document.title, documentVersion: 1, document });
        URL.createObjectURL = (blob) => { const url = originalCreate(blob); previews.push(url); return url; };
        URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
        let applied = 0, failed = 0, editor = original;
        const load = (isCurrent: () => boolean) => loadProjectCloudMedia(document, isCurrent,
            createMediaClient(() => isCurrent() ? account.getState().getDraftScope()?.accountId ?? null : null, transport));
        const apply = (loaded: Awaited<ReturnType<typeof load>>) => { applied++; editor = loaded.project; };
        const boundary = { getScope: account.getState().getDraftScope, discard: (loaded: Awaited<ReturnType<typeof load>>) => revokeCloudMediaObjectUrls(loaded.objectUrls) };
        delayedMediaPath = `/api/v1/media/${upload.media.id}`;
        restore = startProjectRestore(load, apply, () => { failed++; }, boundary);
        await mediaCaptured;
        expect(previews).toHaveLength(0);

        // Direct DB administration is confined to this fresh synthetic account.
        await database.db.update(userTable).set({ role: "user" }).where(eq(userTable.id, owner.id));
        visible();
        expect(account.getState().getDraftScope()).toEqual(scope);
        recheck = account.getState().initialize();
        await recheck;
        expect(account.getState()).toMatchObject({ status: "ready", user: { id: owner.id, role: "user" } });
        const newScope = account.getState().getDraftScope()!;
        expect(newScope.accountId).toBe(scope.accountId);
        expect(newScope.epoch).toBeGreaterThan(scope.epoch);
        expect(getAccountLocalScope()).toEqual(localScope);
        expect(requests.filter((request) => request.path === "/api/v1/session").map((request) => request.status)).toEqual([200, 200]);
        const deniedAdmin = await transport("/api/v1/admin/providers", { headers: { "x-canvas-account-id": scope.accountId } });
        expect(deniedAdmin.status).toBe(403);
        expect(await deniedAdmin.json()).toMatchObject({ error: { code: "forbidden" } });
        const ownMedia = await media.download(upload.media.id);
        expect(new Uint8Array(await ownMedia.arrayBuffer())).toEqual(bytes);

        release();
        await restore.settled;
        expect([applied, failed]).toEqual([0, 1]);
        expect(editor).toBe(original);
        expect(document).toEqual(original);
        expect(previews).toHaveLength(0);
        expect(revoked).toEqual([]);
        expect(await createDraftRepository(database.db).get(owner.id, draft.id)).toMatchObject({ revision: 1, document: original });

        // The user's own media remains allowed under the freshly confirmed role.
        freshRestore = startProjectRestore(load, apply, () => { failed++; }, boundary);
        await freshRestore.settled;
        expect([applied, failed]).toEqual([1, 1]);
        expect(previews).toHaveLength(1);
        expect(revoked).toEqual([]);
        expect(editor.nodes[0].metadata).toMatchObject({ cloudMediaId: upload.media.id, content: previews[0] });
        expect(new Uint8Array(await (await fetch(previews[0])).arrayBuffer())).toEqual(bytes);
        expect(document).toEqual(original);
        expect(await createDraftRepository(database.db).get(owner.id, draft.id)).toMatchObject({ revision: 1, document: original });
        expect(await database.db.select({ id: sessionTable.id }).from(sessionTable).where(eq(sessionTable.userId, owner.id))).toEqual(sessions);
        expect(requests.filter((request) => request.method === "GET" && request.path === `/api/v1/media/${upload.media.id}`).map((request) => request.status)).toEqual([200, 200, 200]);
        expect(requests.filter((request) => request.path.startsWith("/api/v1/canvases") && request.method !== "GET")).toEqual([
            { method: "POST", path: "/api/v1/canvases", status: 201 },
        ]);
    } finally {
        release(); restore?.cancel(); freshRestore?.cancel();
        await Promise.allSettled([recheck, restore?.settled, freshRestore?.settled]);
        setAccountLocalAccount(null);
        previews.forEach((url) => originalRevoke(url));
        URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
        await server?.stop(true);
        await database.close();
    }
}, 30_000);

// Only response delivery and the advisory cross-tab notification are controlled.
// Authentication, revocation, the replacement 401 and media bytes use real HTTP.
test("real revocation during a foreground session check rejects stale identity and late media", async () => {
    const database = await createTestDatabase();
    const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        return { promise, resolve };
    };
    const sessionCaptured = deferred(), mediaCaptured = deferred();
    const releaseSession = deferred(), releaseMedia = deferred();
    const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
    const previews: string[] = [], revoked: string[] = [];
    let server: ReturnType<typeof Bun.serve> | undefined;
    let refresh: Promise<void> | undefined, restore: ReturnType<typeof startProjectRestore> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
        let app: ReturnType<typeof createApp>;
        let delaySession = false, delayedMediaPath = "";
        const requests: { method: string; path: string; status: number }[] = [];
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
            const response = await app(request, server.requestIP(request)?.address);
            const path = new URL(request.url).pathname;
            requests.push({ method: request.method, path, status: response.status });
            if (path === "/api/v1/session" && delaySession && response.status === 200) {
                delaySession = false;
                const body = await response.arrayBuffer();
                sessionCaptured.resolve();
                await releaseSession.promise;
                return new Response(body, { status: response.status, headers: response.headers });
            }
            if (request.method === "GET" && path === delayedMediaPath && response.status === 200) {
                delayedMediaPath = "";
                const body = await response.arrayBuffer();
                mediaCaptured.resolve();
                await releaseMedia.promise;
                return new Response(body, { status: response.status, headers: response.headers });
            }
            return response;
        } });
        const origin = `http://127.0.0.1:${server.port}`;
        const secret = "synthetic-foreground-recovery-" + crypto.randomUUID() + crypto.randomUUID();
        const mails: { to: string; url: string }[] = [];
        app = createApp(createAccountApi({
            database: database.db, origin, cloudCanvas: true,
            auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
            rates: createRateStore(database.pool, secret),
            verifyHuman: async (request) => request.headers.get("x-captcha-response") === "synthetic-pass",
            media: { storage: createMemoryObjectStorage(), quotaBytes: 10, maxBytes: { image: 8, video: 8, audio: 8 } },
            onFault: () => {},
        }), "synthetic-public-site-key", true, true);
        const authRequest = (path: string, body?: object, cookie = "") => fetch(new URL(path, origin), {
            method: body === undefined ? "GET" : "POST", redirect: "manual",
            headers: { origin, cookie, "content-type": "application/json", "x-captcha-response": "synthetic-pass" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const email = `foreground-recovery-${crypto.randomUUID()}@example.test`, password = "synthetic-foreground-recovery-password";
        const signup = await authRequest("/api/auth/sign-up/email", { name: "Foreground recovery", email, password });
        expect(signup.status).toBe(200); await signup.text();
        const verification = await authRequest(mails.find((mail) => mail.to === email)!.url);
        expect(verification.status).toBe(302); await verification.text();
        const login = await authRequest("/api/auth/sign-in/email", { email, password });
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        await login.text();
        const transport: typeof fetch = Object.assign((path: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
            const headers = new Headers(options?.headers);
            headers.set("origin", origin); headers.set("cookie", cookie);
            return fetch(new URL(String(path), origin), { ...options, headers });
        }, { preconnect: fetch.preconnect });
        let invalidate = () => {};
        const sync: AccountSessionSync = {
            publishInvalidated: () => {}, subscribeVisible: () => () => {}, close: () => {},
            subscribeInvalidated: (listener) => { invalidate = listener; return () => { invalidate = () => {}; }; },
        };
        const account = createAccountStore(createAccountClient(transport), sync);
        await account.getState().initialize();
        const scope = account.getState().getDraftScope()!;
        expect(scope?.accountId).toBeString();
        const upload = await createMediaClient(() => scope.accountId, transport).upload(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
        const document = {
            id: "synthetic-foreground-project", title: "保留当前本机原稿", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            nodes: [{ id: "image", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 200, height: 100,
                metadata: { cloudMediaId: upload.media.id, content: "", status: "success" } }],
            connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        };
        const original = structuredClone(document);
        const draft = await createDraftClient(account.getState().getDraftScope, transport).create({ title: document.title, documentVersion: 1, document });
        URL.createObjectURL = (blob) => { const url = originalCreate(blob); previews.push(url); return url; };
        URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
        let applied = 0, failed = 0, editor = original;
        delayedMediaPath = `/api/v1/media/${upload.media.id}`;
        restore = startProjectRestore((isCurrent) => loadProjectCloudMedia(document, isCurrent,
            createMediaClient(() => isCurrent() ? account.getState().getDraftScope()?.accountId ?? null : null, transport)),
        (loaded) => { applied++; editor = loaded.project; }, () => { failed++; }, {
            getScope: account.getState().getDraftScope,
            discard: (loaded) => revokeCloudMediaObjectUrls(loaded.objectUrls),
        });
        await mediaCaptured.promise;
        expect(previews).toHaveLength(0);
        delaySession = true;
        refresh = account.getState().refresh();
        await sessionCaptured.promise;
        expect(account.getState()).toMatchObject({ status: "loading", user: null });
        const observedIdentities: (string | null)[] = [];
        unsubscribe = account.subscribe((state) => { observedIdentities.push(state.user?.id ?? null); });

        // This independent HTTP command really removes the BetterAuth session.
        const revokedSession = await authRequest("/api/auth/revoke-sessions", {}, cookie);
        expect(revokedSession.status).toBe(200); await revokedSession.text();
        invalidate();
        releaseSession.resolve();
        await refresh;
        await account.getState().initialize();
        expect(requests.filter((request) => request.path === "/api/v1/session").map((request) => request.status)).toEqual([200, 200, 401]);
        expect(account.getState()).toMatchObject({ status: "ready", user: null });
        expect(account.getState().getDraftScope()).toBeNull();
        expect(getAccountLocalScope()).toBeNull();
        expect(observedIdentities.every((id) => id === null)).toBe(true);

        releaseMedia.resolve();
        await restore.settled;
        expect(requests.filter((request) => request.method === "GET" && request.path === `/api/v1/media/${upload.media.id}`).map((request) => request.status)).toEqual([200]);
        expect(previews).toHaveLength(0);
        expect(revoked).toEqual([]);
        expect([applied, failed]).toEqual([0, 1]);
        expect(editor).toBe(original);
        expect(document).toEqual(original);
        expect(await createDraftRepository(database.db).get(scope.accountId, draft.id)).toMatchObject({ revision: 1, document: original });
        const deniedMedia = await transport(`/api/v1/media/${upload.media.id}`, { headers: { "x-canvas-account-id": scope.accountId } });
        expect(deniedMedia.status).toBe(401); await deniedMedia.text();
        expect(requests.filter((request) => request.path.startsWith("/api/v1/canvases") && request.method !== "GET")).toEqual([
            { method: "POST", path: "/api/v1/canvases", status: 201 },
        ]);
    } finally {
        releaseSession.resolve(); releaseMedia.resolve();
        restore?.cancel();
        await Promise.allSettled([refresh, restore?.settled]);
        unsubscribe?.();
        setAccountLocalAccount(null);
        previews.forEach((url) => originalRevoke(url));
        URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
        await server?.stop(true);
        await database.close();
    }
}, 30_000);
