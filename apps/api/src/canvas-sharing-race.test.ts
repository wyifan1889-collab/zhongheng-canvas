import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

// Only the runner's newly initialized native cluster is accepted. No PGlite,
// existing database, service startup, source override or provider is used here.
if (process.env.SAAS_POSTGRES_TEST_SUITE !== "canvas-sharing" ||
    ["DATABASE_URL", "SAAS_DATABASE_URL", "CANVAS_ACCEPTANCE_SOURCE_ROOT", "CANVAS_ACCEPTANCE_DEPENDENCIES", "NODE_PATH", "NODE_OPTIONS", "BUN_OPTIONS"].some((key) => process.env[key])) {
    throw new Error("Use the fresh isolated canvas-sharing PostgreSQL runner");
}
const url = postgresTestUrl();
if (!url) throw new Error("Canvas sharing requires native PostgreSQL, never serial PGlite");
const dataDirectory = process.env.SAAS_TEST_DATA_DIRECTORY;
const markerFile = process.env.SAAS_TEST_CLUSTER_MARKER;
const runId = process.env.SAAS_TEST_RUN_ID;
const expectedPort = process.env.SAAS_TEST_CLUSTER_PORT;
if (!dataDirectory || !markerFile || !runId || !expectedPort || !path.isAbsolute(dataDirectory) || !path.isAbsolute(markerFile) ||
    !/^\d+$/.test(expectedPort) || new URL(url).port !== expectedPort) throw new Error("Missing fresh cluster identity");

const prefix = `canvas-sharing-race-${crypto.randomUUID()}`;
function connection(label: string) {
    const target = new URL(url!);
    target.searchParams.set("application_name", `${prefix}-${label}`);
    target.searchParams.set("statement_timeout", "30000");
    return createDatabase(target.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const storage = createMemoryObjectStorage();
const origin = "https://canvas-sharing-race.example.test";
const secret = `synthetic-sharing-race-${crypto.randomUUID()}${crypto.randomUUID()}`;
const mails: { to: string; url: string }[] = [];
type Actor = { id: string; cookie: string };
const owner: Actor = { id: "", cookie: "" }, editor: Actor = { id: "", cookie: "" };
let firstClient: PoolClient | undefined, secondClient: PoolClient | undefined;
let firstPid = 0, secondPid = 0;
let firstApi: ReturnType<typeof createAccountApi>, secondApi: ReturnType<typeof createAccountApi>;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}
type LockMode = "key share" | "update";
type LockTable = "canvas_draft" | "media_object";
type Gate = { id: string; table: LockTable; mode: LockMode; reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; fired: boolean };
const gates: Partial<Record<"first" | "second", Gate>> = {};
const matchesLock = (query: string, table: LockTable, mode: LockMode) => query.includes(`"canvas_saas"."${table}"`) &&
    (mode === "key share" ? /\bfor\s+key\s+share\b/i : /\bfor\s+update\b/i).test(query);
function hasParameter(value: unknown, id: string): boolean {
    return Array.isArray(value) ? value.some((item) => hasParameter(item, id)) : value === id;
}
function pinnedDatabase(client: PoolClient, label: "first" | "second") {
    const wrapped = new Proxy(client, { get(target, property) {
        if (property === "query") return async (...args: unknown[]) => {
            // The real SQL and parameters pass through unchanged. Pause only
            // after PostgreSQL has actually granted the target row lock.
            const result = await Reflect.apply(target.query, target, args);
            const config = args[0] as string | { text?: string; values?: unknown[] };
            const text = typeof config === "string" ? config : config?.text ?? "";
            const values = (Array.isArray(args[1]) ? args[1] : typeof config === "object" ? config.values : []) ?? [];
            const gate = gates[label];
            if (gate && !gate.fired && matchesLock(text, gate.table, gate.mode) && hasParameter(values, gate.id)) {
                if (result.rowCount !== 1) throw new Error("The target locking SELECT did not return exactly one row");
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
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); }, sendResetPassword: async () => undefined },
        rates: { consume: async () => ({ allowed: true }) }, verifyHuman: async () => true, onFault: () => {},
        media: { storage, quotaBytes: 1024, maxBytes: { image: 8, video: 8, audio: 8 } },
    });
}
function request(handler: ReturnType<typeof createAccountApi>, route: string, actor: Actor, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return handler(new Request(origin + route, { method,
        headers: { origin, cookie: actor.cookie, "content-type": body instanceof Uint8Array ? "image/png" : "application/json", "x-canvas-account-id": actor.id },
        ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    }), "198.51.100.90");
}
async function json(response: Response, status = 200) {
    expect(response.status).toBe(status);
    return response.json();
}
async function signup(actor: Actor, name: string) {
    const email = `${prefix}-${name}@example.test`, password = "synthetic-canvas-sharing-race-password";
    expect((await request(firstApi, "/api/auth/sign-up/email", actor, { name, email, password })).status).toBe(200);
    const mail = mails.find((value) => value.to === email);
    expect(mail).toBeDefined();
    expect((await firstApi(new Request(mail!.url), "198.51.100.90")).status).toBe(302);
    const login = await request(firstApi, "/api/auth/sign-in/email", actor, { email, password });
    expect(login.status).toBe(200);
    actor.cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    actor.id = (await json(await request(firstApi, "/api/v1/session", actor))).user.id;
    expect((await json(await request(secondApi, "/api/v1/session", actor))).user.id).toBe(actor.id);
}

beforeAll(async () => {
    const marker = JSON.parse(await readFile(markerFile!, "utf8"));
    expect(marker).toMatchObject({ kind: "canvas-sharing-native-cluster", runId, host: "127.0.0.1", port: Number(expectedPort) });
    expect(path.resolve(marker.dataDir)).toBe(path.resolve(dataDirectory!));
    expect(path.resolve(marker.runDir)).toBe(path.dirname(path.resolve(markerFile!)));
    expect(path.dirname(path.resolve(dataDirectory!))).toBe(path.resolve(marker.runDir));
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, inet_server_port() AS port, current_setting('server_version_num')::integer AS version,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", port: Number(expectedPort), version: 180004, privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    firstClient = await first.pool.connect(); secondClient = await second.pool.connect();
    firstPid = (await firstClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    secondPid = (await secondClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    expect(firstPid).not.toBe(secondPid);
    for (const client of [firstClient, secondClient]) expect((await client.query("SHOW default_transaction_isolation")).rows).toEqual([{ default_transaction_isolation: "read committed" }]);
    firstApi = api(pinnedDatabase(firstClient, "first")); secondApi = api(pinnedDatabase(secondClient, "second"));
    await signup(owner, "owner"); await signup(editor, "editor");
    console.info(JSON.stringify({ kind: "canvas-sharing-native-boundary", ...boundary, firstPid, secondPid }));
}, 30_000);

type Outcome = { response: Response } | { error: unknown };
type Pending = { settled: boolean; result: Promise<Outcome> };
const pendingOperations: Pending[] = [];
function begin(work: () => Promise<Response>): Pending {
    const pending: Pending = { settled: false, result: Promise.resolve({ error: "not started" }) };
    pending.result = work().then((response) => ({ response }), (error: unknown) => ({ error })).finally(() => { pending.settled = true; });
    pendingOperations.push(pending);
    return pending;
}
async function reached(gate: Gate, holder: Pending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([gate.reached.promise,
            holder.result.then(() => { throw new Error("Holder completed without the required lock gate"); }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Required lock gate was not reached within 5s")), 5_000); }),
        ]);
    } finally { if (timer) clearTimeout(timer); }
}
async function observeWait(scenario: string, table: LockTable, mode: LockMode, pending: Pending) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (pending.settled) throw new Error("Competing request completed before the required PostgreSQL lock wait");
        const { rows } = await observer.pool.query<{ blockers: number[]; wait_event_type: string; query: string }>(
            "SELECT pg_blocking_pids(pid) AS blockers,wait_event_type,query FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()", [secondPid]);
        const row = rows.find((entry) => entry.wait_event_type === "Lock" && entry.blockers.includes(firstPid) && matchesLock(entry.query, table, mode));
        if (row) {
            // Only native backend IDs and lock classifications reach the receipt.
            console.info(JSON.stringify({ kind: "canvas-sharing-lock-wait", scenario, holderPid: firstPid, waiterPid: secondPid,
                waitEventType: row.wait_event_type, blockers: row.blockers, waiterTable: table, waiterLock: mode }));
            return;
        }
        // Observer I/O yields; elapsed time or an unsettled promise is never proof.
    }
    throw new Error("The required native holder/waiter relationship was not observed");
}
async function response(pending: Pending) {
    const outcome = await pending.result;
    if (!("response" in outcome)) throw new Error("Handler rejected outside its HTTP response contract");
    return outcome.response;
}
async function race(scenario: string, gate: Gate, holderWork: () => Promise<Response>, waiterWork: () => Promise<Response>, waitTable: LockTable, waitMode: LockMode) {
    gates.first = gate;
    let holder: Pending | undefined, waiter: Pending | undefined;
    try {
        holder = begin(holderWork); await reached(gate, holder);
        waiter = begin(waiterWork); await observeWait(scenario, waitTable, waitMode, waiter);
        expect(gate.fired).toBe(true); expect(holder.settled || waiter.settled).toBe(false);
        gate.release.resolve();
        return { holder: await response(holder), waiter: await response(waiter) };
    } finally {
        gate.release.resolve(); delete gates.first;
        await Promise.allSettled([holder?.result, waiter?.result]);
    }
}
function gate(table: LockTable, mode: LockMode, id: string): Gate {
    return { table, mode, id, reached: deferred(), release: deferred(), fired: false };
}
const removeMember = (handler: typeof firstApi, id: string) => request(handler, `/api/v1/canvas/${id}/members/${encodeURIComponent(editor.id)}`, owner, undefined, "DELETE");
const save = (handler: typeof firstApi, seeded: Awaited<ReturnType<typeof seed>>) => request(handler, `/api/v1/canvases/${seeded.draft.id}`, editor, seeded.saveBody, "PUT");
const removeMedia = (handler: typeof firstApi, id: string) => request(handler, `/api/v1/media/${id}`, editor, undefined, "DELETE");
async function seed(label: string, checkPending = false) {
    const bytes = new Uint8Array([51, 52, 53]);
    const media = (await json(await request(firstApi, "/api/v1/media", editor, bytes), 201)).media;
    const draft = (await json(await request(firstApi, "/api/v1/canvases", owner,
        { creationId: crypto.randomUUID(), title: label, documentVersion: 1, document: { nodes: [] } }), 201)).draft;
    if (checkPending) {
        const invited = (await json(await request(firstApi, `/api/v1/canvas/${draft.id}/members`, owner, { userId: editor.id, role: "editor" }))).member;
        expect(invited.joinedAt).toBeNull();
        expect((await request(secondApi, `/api/v1/canvases/${draft.id}`, editor)).status).toBe(404);
    }
    const share = (await json(await request(firstApi, `/api/v1/canvas/${draft.id}/share-link`, owner, { role: "editor" }))).share;
    const member = (await json(await request(secondApi, `/api/v1/canvas/share/${share.token}/join`, editor, {}))).member;
    expect(member.role).toBe("editor"); expect(typeof member.joinedAt).toBe("string");
    return { bytes, media, draft, saveBody: { title: label, documentVersion: 1, expectedRevision: 1,
        document: { nodes: [{ type: "image", metadata: { cloudMediaId: media.id } }] } } };
}
async function savedAudits(draftId: string) {
    return (await observer.pool.query("SELECT actor_id AS actor,revision FROM canvas_saas.audit_event WHERE resource_id=$1 AND action='canvas.saved' ORDER BY revision", [draftId])).rows;
}
async function assertIntegrity() {
    const { rows: documents } = await observer.pool.query<{ document: unknown }>("SELECT document FROM canvas_saas.canvas_draft");
    const { rows: media } = await observer.pool.query<{ id: string; owner_id: string; size_bytes: string }>("SELECT id,owner_id,size_bytes FROM canvas_saas.media_object");
    const ids = new Set(media.map((item) => item.id));
    function walk(value: unknown): void {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            if (key === "cloudMediaId" && typeof child === "string") expect(ids.has(child.toLowerCase())).toBe(true);
            else walk(child);
        }
    }
    documents.forEach((item) => walk(item.document));
    for (const actor of [owner, editor]) {
        const quota = await createMediaRepository(observer.db).getQuota(actor.id, 1024);
        expect(quota.usedBytes).toBe(media.filter((item) => item.owner_id === actor.id).reduce((sum, item) => sum + Number(item.size_bytes), 0));
        expect(quota.availableBytes).toBe(quota.quotaBytes - quota.usedBytes);
    }
}

test("T10 native revoke owns canvas UPDATE before editor save waits and then refuses revoked authority", async () => {
    const seeded = await seed("revoke-first", true);
    const result = await race("revoke-before-save", gate("canvas_draft", "update", seeded.draft.id),
        () => removeMember(firstApi, seeded.draft.id), () => save(secondApi, seeded), "canvas_draft", "update");
    expect((await json(result.holder)).ok).toBe(true);
    expect(await json(result.waiter, 404)).toMatchObject({ error: { code: "not_found" } });
    expect(await createDraftRepository(observer.db).get(owner.id, seeded.draft.id)).toEqual(seeded.draft);
    expect(await savedAudits(seeded.draft.id)).toEqual([]);
    expect((await request(secondApi, `/api/v1/canvases/${seeded.draft.id}`, editor)).status).toBe(404);
    await assertIntegrity();
}, 30_000);

test("T10 native editor save owns canvas UPDATE and media KEY SHARE before revoke waits", async () => {
    const seeded = await seed("save-first"), mediaRepo = createMediaRepository(observer.db);
    const quotaBefore = await mediaRepo.getQuota(editor.id, 1024);
    const result = await race("save-before-revoke", gate("media_object", "key share", seeded.media.id),
        () => save(firstApi, seeded), () => removeMember(secondApi, seeded.draft.id), "canvas_draft", "update");
    expect((await json(result.holder)).draft).toMatchObject({ id: seeded.draft.id, revision: 2, document: seeded.saveBody.document });
    expect((await json(result.waiter)).ok).toBe(true);
    expect(await savedAudits(seeded.draft.id)).toEqual([{ actor: editor.id, revision: 2 }]);
    expect((await request(firstApi, `/api/v1/canvases/${seeded.draft.id}`, editor)).status).toBe(404);
    expect((await save(firstApi, seeded)).status).toBe(404);
    expect((await request(firstApi, `/api/v1/media/${seeded.media.id}?canvasId=${seeded.draft.id}`, editor)).status).toBe(404);
    expect(await json(await removeMedia(firstApi, seeded.media.id), 409)).toMatchObject({ error: { code: "media_referenced" } });
    const record = await mediaRepo.get(editor.id, seeded.media.id);
    expect(record).not.toBeNull();
    expect((await storage.get(objectKey(record!.objectKey)))!.body).toEqual(seeded.bytes);
    expect(await mediaRepo.getQuota(editor.id, 1024)).toEqual(quotaBefore);
    await assertIntegrity();
}, 30_000);

test("T10 native own-media DELETE wins before cross-owner canvas save waits and rejects a dangling reference", async () => {
    const seeded = await seed("delete-first"), mediaRepo = createMediaRepository(observer.db);
    const record = await mediaRepo.get(editor.id, seeded.media.id), quotaBefore = await mediaRepo.getQuota(editor.id, 1024);
    expect(record).not.toBeNull();
    const result = await race("delete-before-save", gate("media_object", "update", seeded.media.id),
        () => removeMedia(firstApi, seeded.media.id), () => save(secondApi, seeded), "media_object", "key share");
    expect(await json(result.holder)).toMatchObject({ ok: true, quota: { usedBytes: quotaBefore.usedBytes - seeded.bytes.byteLength } });
    expect(await json(result.waiter, 400)).toMatchObject({ error: { code: "invalid_input" } });
    expect(await createDraftRepository(observer.db).get(owner.id, seeded.draft.id)).toEqual(seeded.draft);
    expect(await savedAudits(seeded.draft.id)).toEqual([]);
    expect(await mediaRepo.get(editor.id, seeded.media.id)).toBeNull();
    expect(await storage.get(objectKey(record!.objectKey))).toBeNull();
    expect((await mediaRepo.getQuota(editor.id, 1024)).usedBytes).toBe(quotaBefore.usedBytes - seeded.bytes.byteLength);
    await assertIntegrity();
}, 30_000);

afterAll(async () => {
    for (const held of Object.values(gates)) held?.release.resolve();
    await Promise.allSettled(pendingOperations.map((pending) => pending.result));
    const rolledBack = await Promise.allSettled([firstClient?.query("ROLLBACK"), secondClient?.query("ROLLBACK")]);
    firstClient?.release(); secondClient?.release();
    const closed = await Promise.allSettled([first.close(), second.close(), observer.close()]);
    if ([...rolledBack, ...closed].some((item) => item.status === "rejected")) throw new Error("A native canvas-sharing connection did not close cleanly");
    console.info(JSON.stringify({ kind: "canvas-sharing-connections-closed", closed: true, pools: 3 }));
}, 30_000);
