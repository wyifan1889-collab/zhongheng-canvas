import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// An uninstalled worktree may read an already installed checkout. The caller
// must verify its source bytes against the review baseline before and after the
// run. Never install, copy dependencies, start servers, or accept a real DB here.
const source = (path: string) => process.env.CANVAS_ACCEPTANCE_SOURCE_ROOT
    ? pathToFileURL(resolve(process.env.CANVAS_ACCEPTANCE_SOURCE_ROOT, path)).href
    : new URL(`../../../${path}`, import.meta.url).href;
const load = <T,>(path: string): Promise<T> => import(path);
const { createTestDatabase } = await load<typeof import("../test/database")>(source("apps/api/test/database.ts"));
const { createAccountApi } = await load<typeof import("./accounts")>(source("apps/api/src/accounts.ts"));
const { createMemoryObjectStorage, objectKey } = await load<typeof import("@infinite-canvas/storage")>(source("packages/storage/src/index.ts"));
const { auditEvent, canvasDraft, mediaObject, storageQuota } = await load<typeof import("@infinite-canvas/database/schema")>(source("packages/database/src/schema.ts"));

async function fixture() {
    if (process.env.SAAS_TEST_DATABASE_URL) throw new Error("This acceptance slice requires in-memory PGlite.");
    const database = await createTestDatabase();
    const storage = createMemoryObjectStorage();
    const origin = "https://launch-account-cloud.example.test";
    const mails: { to: string; url: string }[] = [];
    const options: Parameters<typeof createAccountApi>[0] = {
        database: database.db, origin, cloudCanvas: true,
        auth: { secret: "synthetic-acceptance-" + crypto.randomUUID() + crypto.randomUUID(),
            sendVerificationEmail: async (mail) => { mails.push(mail); } },
        rates: { consume: async () => ({ allowed: true }) }, verifyHuman: async () => true,
        media: { storage, quotaBytes: 20, maxBytes: { image: 8, video: 8, audio: 8 } }, onFault: () => {},
    };
    const api = createAccountApi(options);
    type Actor = { id: string; cookie: string };
    function request(path: string, actor?: Actor, body?: unknown, method = body === undefined ? "GET" : "POST", handler = api) {
        const binary = body instanceof Uint8Array;
        return handler(new Request(origin + path, { method,
            headers: { origin, "content-type": binary ? "image/png" : "application/json",
                ...(actor ? { cookie: actor.cookie, "x-canvas-account-id": actor.id } : {}) },
            ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
        }), "198.51.100.88");
    }
    async function register(name: string): Promise<Actor> {
        const email = `${name}-${crypto.randomUUID()}@example.test`, password = "synthetic-acceptance-password";
        expect((await request("/api/auth/sign-up/email", undefined, { name, email, password })).status).toBe(200);
        expect((await api(new Request(mails.find((mail) => mail.to === email)!.url), "198.51.100.88")).status).toBe(302);
        const login = await request("/api/auth/sign-in/email", undefined, { email, password });
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
        const identity = await request("/api/v1/session", { cookie, id: "" });
        expect(identity.status).toBe(200);
        return { cookie, id: (await identity.json()).user.id };
    }
    async function state() {
        return { drafts: await database.db.select().from(canvasDraft), audit: await database.db.select().from(auditEvent),
            media: await database.db.select().from(mediaObject), quota: await database.db.select().from(storageQuota) };
    }
    return { database, storage, options, request, register, state };
}

test("valid Bob credentials cannot attach Alice media to Bob cloud drafts, including nested uppercase IDs", async () => {
    const f = await fixture();
    try {
        const alice = await f.register("alice"), bob = await f.register("bob");
        const ids: string[] = [];
        for (const actor of [alice, bob]) {
            const upload = await f.request("/api/v1/media", actor, new Uint8Array([11, 12, 13]));
            expect(upload.status).toBe(201);
            ids.push((await upload.json()).media.id);
        }
        const owned = { title: "Bob owned media", documentVersion: 1, document: { nodes: [{ metadata: { cloudMediaId: ids[1] } }] } };
        const creationId = crypto.randomUUID();
        expect((await f.request("/api/v1/canvases", bob, { ...owned, creationId })).status).toBe(201);
        const before = await f.state();
        const objects = await Promise.all(before.media.map((row) => f.storage.get(objectKey(row.objectKey))));
        for (const foreign of [{ cloudMediaId: ids[0] }, { extension: { refs: [{ cloudMediaId: ids[0].toUpperCase() }] } }]) {
            const document = { ...owned.document, extension: foreign };
            for (const method of ["POST", "PUT"]) {
                const response = await f.request(method === "POST" ? "/api/v1/canvases" : `/api/v1/canvases/${creationId}`, bob,
                    { ...owned, document, ...(method === "POST" ? { creationId: crypto.randomUUID() } : { expectedRevision: 1 }) }, method);
                expect(response.status).toBe(400);
                expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
                expect(await f.state()).toEqual(before);
                expect(await Promise.all(before.media.map((row) => f.storage.get(objectKey(row.objectKey))))).toEqual(objects);
            }
        }
        const allowed = await f.request(`/api/v1/canvases/${creationId}`, bob, { ...owned, expectedRevision: 1 }, "PUT");
        expect(allowed.status).toBe(200);
        expect((await allowed.json()).draft).toMatchObject({ id: creationId, revision: 2, document: owned.document });
        const after = await f.state();
        expect(after.media).toEqual(before.media);
        expect(after.quota).toEqual(before.quota);
        expect(after.audit).toHaveLength(before.audit.length + 1);
    } finally { await f.database.close(); }
}, 30_000);

// Intentionally red on a223a53: this asserts the required integrity invariant,
// rather than blessing the corrupt state. Fix belongs to the accounts.ts owner.
test("committed media survives failure of the upload response quota lookup (known launch defect S0-01)", async () => {
    const f = await fixture();
    try {
        const actor = await f.register("quota-fault");
        let quotaInserts = 0;
        const faultDatabase = new Proxy(f.database.db, { get(target, property) {
            if (property === "insert") return (table: unknown) => {
                // reserve.ensureQuota succeeds; response.getQuota fails only after
                // the actual media INSERT has committed. Other DB operations work.
                if (table === storageQuota && ++quotaInserts === 2) throw new Error("synthetic quota response failure");
                return target.insert(table as typeof storageQuota);
            };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        } });
        const api = createAccountApi({ ...f.options, database: faultDatabase });
        const response = await f.request("/api/v1/media", actor, new Uint8Array([21, 22, 23]), "POST", api);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "service_unavailable" } });
        expect(quotaInserts).toBe(2);
        const state = await f.state();
        expect(state.media).toHaveLength(1);
        const row = state.media[0];
        const stored = await f.storage.get(objectKey(row.objectKey));
        // One assertion exposes both lost bytes and incorrectly released quota.
        expect({ objectPresent: stored !== null, usedBytes: state.quota[0].usedBytes, mediaBytes: row.sizeBytes })
            .toEqual({ objectPresent: true, usedBytes: 3, mediaBytes: 3 });
    } finally { await f.database.close(); }
}, 30_000);
