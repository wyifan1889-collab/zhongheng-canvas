import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { createDatabase, type Database } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { createDraftRepository } from "@infinite-canvas/database/drafts";
import { createMediaRepository } from "@infinite-canvas/database/media";
import * as schema from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { postgresTestUrl } from "../test/database";
import { createAccountApi } from "./accounts";

// Prepared for one coordinator-owned fresh PostgreSQL window. No PGlite fallback,
// cluster startup, listener, external storage, source override, or automatic retry.
if (process.env.SAAS_POSTGRES_TEST_SUITE !== "cloud-media-reference-race" || process.env.DATABASE_URL) {
    throw new Error("Use the coordinator's fresh isolated cloud-media-reference-race database window");
}
const url = postgresTestUrl();
if (!url) throw new Error("S3 requires the isolated runner's PostgreSQL URL, never serial PGlite");
const prefix = `media-reference-race-${crypto.randomUUID()}`;
function connection(label: string) {
    const target = new URL(url!);
    target.searchParams.set("application_name", `${prefix}-${label}`);
    // Existing isolated concurrency-test deadline, not a product setting.
    target.searchParams.set("statement_timeout", "30000");
    return createDatabase(target.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const storage = createMemoryObjectStorage();
const origin = "https://cloud-media-reference-race.example.test";
const secret = "synthetic-media-race-" + crypto.randomUUID() + crypto.randomUUID();
const mails: { to: string; url: string }[] = [];
const identity = { id: "", firstCookie: "", secondCookie: "" };
let firstClient: PoolClient | undefined, secondClient: PoolClient | undefined;
let firstPid = 0, secondPid = 0;
let firstApi: ReturnType<typeof createAccountApi>, secondApi: ReturnType<typeof createAccountApi>;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
type LockMode = "key share" | "update";
type Gate = { mediaId: string; mode: LockMode; reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; fired: boolean };
const gates: Partial<Record<"first" | "second", Gate>> = {};
const matchesLock = (query: string, mode: LockMode) => query.includes('"canvas_saas"."media_object"') &&
    (mode === "key share" ? /\bfor\s+key\s+share\b/i : /\bfor\s+update\b/i).test(query);

function pinnedDatabase(client: PoolClient, label: "first" | "second") {
    const wrapped = new Proxy(client, { get(target, property) {
        if (property === "query") return async (...args: unknown[]) => {
            // Pass SQL/config/parameters through unchanged. Announce the gate only
            // AFTER PostgreSQL returns the actual locking SELECT and its one row.
            const result = await Reflect.apply(target.query, target, args);
            const config = args[0] as string | { text?: string; values?: unknown[] };
            const text = typeof config === "string" ? config : config?.text ?? "";
            const values = (Array.isArray(args[1]) ? args[1] : typeof config === "object" ? config.values : []) ?? [];
            const gate = gates[label];
            if (gate && !gate.fired && matchesLock(text, gate.mode) && values.includes(gate.mediaId) && values.includes(identity.id)) {
                if (result.rowCount !== 1) throw new Error("The target media locking SELECT did not return exactly one row");
                gate.fired = true;
                gate.reached.resolve();
                await gate.release.promise;
            }
            return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
    } });
    return drizzle(wrapped, { schema });
}
function api(database: Database) {
    return createAccountApi({ database, origin, cloudCanvas: true,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
        rates: { consume: async () => ({ allowed: true }) }, verifyHuman: async () => true, onFault: () => {},
        media: { storage, quotaBytes: 20, maxBytes: { image: 8, video: 8, audio: 8 } },
    });
}
function request(handler: ReturnType<typeof createAccountApi>, path: string, cookie: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return handler(new Request(origin + path, { method,
        headers: { origin, cookie, "content-type": "application/json", "x-canvas-account-id": identity.id },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.89");
}

beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    firstClient = await first.pool.connect();
    secondClient = await second.pool.connect();
    firstPid = (await firstClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    secondPid = (await secondClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    expect(firstPid).not.toBe(secondPid);
    for (const client of [firstClient, secondClient]) {
        expect((await client.query("SHOW default_transaction_isolation")).rows).toEqual([{ default_transaction_isolation: "read committed" }]);
    }
    firstApi = api(pinnedDatabase(firstClient, "first"));
    secondApi = api(pinnedDatabase(secondClient, "second"));
    const email = `${prefix}@example.test`, password = "synthetic-media-reference-race-password";
    expect((await request(firstApi, "/api/auth/sign-up/email", "", { name: "Media race", email, password })).status).toBe(200);
    expect((await firstApi(new Request(mails.find((mail) => mail.to === email)!.url), "198.51.100.89")).status).toBe(302);
    for (const [handler, key] of [[firstApi, "firstCookie"], [secondApi, "secondCookie"]] as const) {
        const login = await request(handler, "/api/auth/sign-in/email", "", { email, password });
        expect(login.status).toBe(200);
        identity[key] = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    }
    const session = await request(firstApi, "/api/v1/session", identity.firstCookie);
    expect(session.status).toBe(200);
    identity.id = (await session.json()).user.id;
}, 30_000);

type Outcome = { response: Response } | { error: unknown };
type Pending = { settled: boolean; result: Promise<Outcome> };
const pendingOperations: Pending[] = [];
function begin(work: () => Promise<Response>): Pending {
    const pending: Pending = { settled: false, result: Promise.resolve({ error: "not started" }) };
    pending.result = work().then((response) => ({ response }), (error: unknown) => ({ error }))
        .finally(() => { pending.settled = true; });
    pendingOperations.push(pending);
    return pending;
}
async function reached(gate: Gate, holder: Pending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([gate.reached.promise,
            holder.result.then(() => { throw new Error("Holder completed without the required media lock gate"); }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Media lock gate not reached within the existing 5s observation window")), 5_000); }),
        ]);
    } finally { if (timer) clearTimeout(timer); }
}
async function observeWait(scenario: string, holderPid: number, waiterPid: number, waiterMode: LockMode, pending: Pending) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (pending.settled) throw new Error("Competing request completed before the required PostgreSQL media lock wait");
        const { rows } = await observer.pool.query<{ pid: number; blockers: number[]; wait_event_type: string; query: string }>(
            "SELECT pid,pg_blocking_pids(pid) AS blockers,wait_event_type,query FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()", [waiterPid]);
        const row = rows.find((entry) => entry.wait_event_type === "Lock" && entry.blockers.includes(holderPid) && matchesLock(entry.query, waiterMode));
        if (row) {
            // Safe receipt: no cookies, SQL parameters, owner/media IDs or URLs.
            console.info(JSON.stringify({ kind: "cloud-media-lock-wait", scenario, holderPid, waiterPid,
                waitEventType: row.wait_event_type, blockers: row.blockers, waiterLock: waiterMode }));
            return;
        }
        // The awaited observer query yields I/O; elapsed time or an unsettled
        // promise never counts as success. No sleep controls the request order.
    }
    throw new Error("The required PostgreSQL holder/waiter relationship was not observed");
}
async function response(pending: Pending) {
    const outcome = await pending.result;
    if (!("response" in outcome)) throw new Error("Handler rejected outside its HTTP response contract");
    return outcome.response;
}
async function compete(scenario: "save-first" | "delete-first", mediaId: string, saveBody: unknown, draftId: string) {
    const gate: Gate = { mediaId, mode: scenario === "save-first" ? "key share" : "update", reached: deferred(), release: deferred(), fired: false };
    gates.first = gate;
    let holder: Pending | undefined, waiter: Pending | undefined;
    const save = (handler: typeof firstApi, cookie: string) => request(handler, `/api/v1/canvases/${draftId}`, cookie, saveBody, "PUT");
    const remove = (handler: typeof firstApi, cookie: string) => request(handler, `/api/v1/media/${mediaId}`, cookie, undefined, "DELETE");
    try {
        holder = begin(() => scenario === "save-first" ? save(firstApi, identity.firstCookie) : remove(firstApi, identity.firstCookie));
        await reached(gate, holder);
        waiter = begin(() => scenario === "save-first" ? remove(secondApi, identity.secondCookie) : save(secondApi, identity.secondCookie));
        await observeWait(scenario, firstPid, secondPid, scenario === "save-first" ? "update" : "key share", waiter);
        expect(gate.fired).toBe(true);
        expect(holder.settled || waiter.settled).toBe(false);
        gate.release.resolve();
        return { holder: await response(holder), waiter: await response(waiter) };
    } finally {
        gate.release.resolve();
        delete gates.first;
        await Promise.allSettled([holder?.result, waiter?.result]);
    }
}

const mediaRepository = () => createMediaRepository(observer.db);
const draftRepository = () => createDraftRepository(observer.db);
async function seed(label: string) {
    const body = new Uint8Array(label === "save-first" ? [31, 32, 33] : [41, 42, 43]);
    const id = crypto.randomUUID(), key = objectKey(`synthetic/${prefix}/${id}`);
    const stored = await storage.put({ key, body, contentType: "image/png" });
    expect(await mediaRepository().reserve(identity.id, body.byteLength, 20)).toBe(true);
    const media = await mediaRepository().add(identity.id, { id, objectKey: key, kind: "image", contentType: "image/png", sizeBytes: body.byteLength, etag: stored.etag });
    const document = { id: `${prefix}-${label}`, nodes: [], connections: [], chatSessions: [] };
    const draft = await draftRepository().create(identity.id, { title: label, document });
    return { body, key, media, draft,
        saveBody: { title: label, documentVersion: 1, expectedRevision: 1,
            document: { ...document, nodes: [{ type: "image", metadata: { cloudMediaId: id } }] } } };
}
async function audit(draftId: string) {
    return (await observer.pool.query("SELECT action,revision FROM canvas_saas.audit_event WHERE resource_id=$1 ORDER BY revision", [draftId])).rows;
}
async function assertNoDanglingReferencesAndQuota() {
    const drafts = await draftRepository().list(identity.id);
    const media = await mediaRepository().list(identity.id);
    const ownedIds = new Set(media.map((item) => item.id));
    function walk(value: unknown): void {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            if (key === "cloudMediaId" && typeof child === "string") expect(ownedIds.has(child.toLowerCase())).toBe(true);
            else walk(child);
        }
    }
    for (const draft of drafts) walk((await draftRepository().get(identity.id, draft.id))!.document);
    const quota = await mediaRepository().getQuota(identity.id, 20);
    expect(quota.usedBytes).toBe(media.reduce((sum, item) => sum + item.sizeBytes, 0));
    expect(quota.availableBytes).toBe(quota.quotaBytes - quota.usedBytes);
    for (const item of media) {
        const stored = await storage.get(objectKey(item.objectKey));
        expect(stored).not.toBeNull();
        expect(stored!.body.byteLength).toBe(item.sizeBytes);
        expect(stored!.metadata).toMatchObject({ sizeBytes: item.sizeBytes, contentType: item.contentType, etag: item.etag });
    }
}

test("S3 save holds key share before DELETE waits, then DELETE refuses the committed reference", async () => {
    const seeded = await seed("save-first"), quotaBefore = await mediaRepository().getQuota(identity.id, 20);
    const result = await compete("save-first", seeded.media.id, seeded.saveBody, seeded.draft.id);
    expect(result.holder.status).toBe(200);
    expect((await result.holder.json()).draft).toMatchObject({ id: seeded.draft.id, revision: 2, document: seeded.saveBody.document });
    expect(result.waiter.status).toBe(409);
    expect(await result.waiter.json()).toMatchObject({ error: { code: "media_referenced" } });
    expect(await draftRepository().get(identity.id, seeded.draft.id)).toMatchObject({ revision: 2, document: seeded.saveBody.document });
    expect(await audit(seeded.draft.id)).toEqual([{ action: "canvas.saved", revision: 2 }]);
    expect(await mediaRepository().get(identity.id, seeded.media.id)).toEqual(seeded.media);
    const stored = await storage.get(seeded.key);
    expect(stored).not.toBeNull();
    expect(stored!.body).toEqual(seeded.body);
    expect(stored!.metadata.etag).toBe(seeded.media.etag);
    expect(await mediaRepository().getQuota(identity.id, 20)).toEqual(quotaBefore);
    await assertNoDanglingReferencesAndQuota();
}, 30_000);

test("S3 DELETE holds update before save waits, then save refuses the deleted media", async () => {
    const seeded = await seed("delete-first"), quotaBefore = await mediaRepository().getQuota(identity.id, 20);
    const result = await compete("delete-first", seeded.media.id, seeded.saveBody, seeded.draft.id);
    expect(result.holder.status).toBe(200);
    expect(await result.holder.json()).toMatchObject({ ok: true, quota: { usedBytes: quotaBefore.usedBytes - seeded.body.byteLength } });
    expect(result.waiter.status).toBe(400);
    expect(await result.waiter.json()).toMatchObject({ error: { code: "invalid_input" } });
    expect(await draftRepository().get(identity.id, seeded.draft.id)).toEqual(seeded.draft);
    expect(await audit(seeded.draft.id)).toEqual([]);
    expect(await mediaRepository().get(identity.id, seeded.media.id)).toBeNull();
    expect(await storage.get(seeded.key)).toBeNull();
    expect((await mediaRepository().getQuota(identity.id, 20)).usedBytes).toBe(quotaBefore.usedBytes - seeded.body.byteLength);
    await assertNoDanglingReferencesAndQuota();
}, 30_000);

afterAll(async () => {
    for (const gate of Object.values(gates)) gate?.release.resolve();
    await Promise.allSettled(pendingOperations.map((pending) => pending.result));
    const rollbacks = await Promise.allSettled([firstClient?.query("ROLLBACK"), secondClient?.query("ROLLBACK")]);
    firstClient?.release();
    secondClient?.release();
    const closed = await Promise.allSettled([first.close(), second.close(), observer.close()]);
    if ([...rollbacks, ...closed].some((item) => item.status === "rejected")) throw new Error("An isolated S3 connection did not close cleanly");
});
