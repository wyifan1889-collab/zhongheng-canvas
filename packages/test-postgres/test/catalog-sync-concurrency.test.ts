import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { CatalogDeletionError } from "@infinite-canvas/database/catalog-deletion";
import { createGenerationTaskRepository, GenerationTaskError } from "@infinite-canvas/database/generation-tasks";
import { saveNodeModel } from "@infinite-canvas/database/node-model-groups";
import { prepareProviderDiscovery, recordProviderDiscovery, saveDiscoveredProvider, ProviderDiscoveryError } from "@infinite-canvas/database/provider-discovery";
import { readModelMappingDraft, saveModelMappingDraft, ModelMappingDraftError } from "@infinite-canvas/database/model-mapping-drafts";
import { emptyMappingDraft, mappingSourceKey, mappingSpecKey } from "@infinite-canvas/shared";
import { postgresTestUrl } from "../../../apps/api/test/database";
import journal from "../../database/migrations/meta/_journal.json";

const url = postgresTestUrl();
if (!url || process.env.DATABASE_URL || process.env.SAAS_POSTGRES_TEST_SUITE !== "catalog-sync") throw new Error("Use --catalog-sync with a fresh isolated database");
const prefix = `sync-race-${crypto.randomUUID()}`, secret = crypto.randomUUID() + crypto.randomUUID();
function connection(label: string) {
    const target = new URL(url!); target.searchParams.set("application_name", `${prefix}-${label}`); target.searchParams.set("statement_timeout", "30000");
    return createDatabase(target.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const blocker = new Client({ connectionString: url, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
const actor = { actorId: `${prefix}-owner`, sessionId: `${prefix}-session`, sessionExpiresAt: new Date(Date.now() + 3_600_000), requestId: "synthetic-sync" };
let connected = false;
beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows).toEqual([{ count: journal.entries.length }]);
    await observer.pool.query('INSERT INTO canvas_saas."user" (id,name,email,email_verified,role) VALUES ($1,$2,$3,true,$4)', [actor.actorId, "Sync race", "sync-race@example.test", "admin"]);
    await observer.pool.query('INSERT INTO canvas_saas.session (id,token,user_id,expires_at) VALUES ($1,$2,$3,$4)', [actor.sessionId, crypto.randomUUID(), actor.actorId, actor.sessionExpiresAt]);
    await blocker.connect(); connected = true;
}, 30_000);
afterAll(async () => {
    try { if (connected) await blocker.query("ROLLBACK"); }
    finally { const outcomes = await Promise.allSettled([blocker.end(), first.close(), second.close(), observer.close()]); if (outcomes.some(item => item.status === "rejected")) throw new Error("Database connection not closed"); }
});
const input = (revision: number) => ({ displayName: "Synthetic", adapter: "openai-compatible" as const, endpoint: "https://example.test/v1", apiKey: "synthetic-key", enabled: true, revision });
async function discover(providerId: string, revision: number, models: string[]) {
    const body = input(revision), target = await prepareProviderDiscovery(observer.db, secret, providerId, body, actor);
    const receipt = await recordProviderDiscovery(observer.db, secret, target, revision, models, actor);
    return { ...body, discoveryReceiptId: receipt.receiptId };
}
async function seed(label: string, inventory = ["keep", "remove"]) {
    const providerId = `sync-${label}`, id = `node-${label}`;
    await saveDiscoveredProvider(observer.db, secret, providerId, await discover(providerId, 0, inventory), actor);
    await saveNodeModel(observer.db, id, { providerId, providerModel: "remove", displayName: "Synthetic image", capability: "image", enabled: true, groupId: null, revision: 0 }, actor);
    return { id, providerId, write: await discover(providerId, 1, ["keep"]) };
}
const taskInput = (id: string) => ({ ownerId: actor.actorId, modelId: id, inputSnapshot: { prompt: "synthetic" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: "synthetic-sync" });
function begin(work: () => Promise<unknown>) {
    const pending = { settled: false, result: Promise.resolve<unknown>(null) };
    pending.result = work().catch(error => {
        if (error instanceof CatalogDeletionError || error instanceof GenerationTaskError || error instanceof ProviderDiscoveryError || error instanceof ModelMappingDraftError) return error.code;
        throw error;
    }).finally(() => { pending.settled = true; });
    return pending;
}
async function waitBlocked(label: string, by: number, pending: ReturnType<typeof begin>) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (pending.settled) throw new Error("Operation settled before expected lock wait");
        const { rows } = await observer.pool.query<{ pid: number; blockers: number[] }>("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [`${prefix}-${label}`]);
        const row = rows.find(item => item.blockers.includes(by)); if (row) return row.pid;
        await Bun.sleep(10);
    }
    throw new Error("Expected PostgreSQL lock relationship not observed");
}
async function idlePid() { return (await observer.pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'", [`${prefix}-first`])).rows[0].pid as number; }
async function state(providerId: string) {
    return (await observer.pool.query("SELECT p.revision,array_agg(d.provider_model ORDER BY d.provider_model) AS models FROM canvas_saas.model_provider p LEFT JOIN canvas_saas.provider_discovered_model d ON d.provider_id=p.id WHERE p.id=$1 GROUP BY p.revision", [providerId])).rows;
}

test("task admission holds sync until commit, then unfinished work rejects the whole snapshot", async () => {
    const item = await seed("task-first"), ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const task = begin(() => first.db.transaction(async tx => {
        const result = await createGenerationTaskRepository(tx).create(taskInput(item.id)); ready.resolve(await idlePid()); await release.promise; return result;
    }));
    let sync: ReturnType<typeof begin> | undefined;
    try {
        const pid = await Promise.race([ready.promise, task.result.then(() => { throw new Error("Admission failed"); })]);
        sync = begin(() => saveDiscoveredProvider(second.db, secret, item.providerId, item.write, actor));
        await waitBlocked("second", pid, sync); release.resolve();
        expect(await task.result).toMatchObject({ created: true }); expect(await sync.result).toBe("catalog_in_use");
        expect(await state(item.providerId)).toEqual([{ revision: 1, models: ["keep", "remove"] }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.provider_discovery_receipt WHERE id=$1", [item.write.discoveryReceiptId])).rows).toEqual([{ count: 1 }]);
    } finally { release.resolve(); await Promise.allSettled([task.result, ...(sync ? [sync.result] : [])]); }
}, 30_000);

test("sync commits before a waiting task, which cannot create work or reserve credits for a retired model", async () => {
    const item = await seed("sync-first"), ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const sync = begin(() => first.db.transaction(async tx => {
        const result = await saveDiscoveredProvider(tx, secret, item.providerId, item.write, actor); ready.resolve(await idlePid()); await release.promise; return result;
    }));
    let task: ReturnType<typeof begin> | undefined;
    try {
        const pid = await Promise.race([ready.promise, sync.result.then(() => { throw new Error("Sync failed"); })]);
        task = begin(() => createGenerationTaskRepository(second.db).create(taskInput(item.id)));
        await waitBlocked("second", pid, task); release.resolve();
        expect(await sync.result).toMatchObject({ removedModelIds: [item.id] }); expect(await task.result).toBe("model_unavailable");
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.generation_task WHERE model_id=$1", [item.id])).rows).toEqual([{ count: 0 }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.wallet_reservation")).rows).toEqual([{ count: 0 }]);
    } finally { release.resolve(); await Promise.allSettled([sync.result, ...(task ? [task.result] : [])]); }
}, 30_000);

test("a newly bound model while sync waits for its provider invalidates the whole reviewed snapshot", async () => {
    const item = await seed("new-binding", ["keep", "remove", "late-remove"]), ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const writer = begin(() => first.db.transaction(async tx => {
        await prepareProviderDiscovery(tx, secret, item.providerId, input(1), actor);
        ready.resolve(await idlePid()); await release.promise;
        await saveNodeModel(tx, `${item.id}-late`, { providerId: item.providerId, providerModel: "late-remove", displayName: "Late binding", capability: "image", enabled: true, groupId: null, revision: 0 }, actor);
    }));
    let sync: ReturnType<typeof begin> | undefined;
    try {
        const pid = await Promise.race([ready.promise, writer.result.then(() => { throw new Error("Writer failed"); })]);
        sync = begin(() => saveDiscoveredProvider(second.db, secret, item.providerId, item.write, actor));
        await waitBlocked("second", pid, sync); release.resolve();
        expect(await writer.result).toBeUndefined(); expect(await sync.result).toBe("provider_revision_conflict");
        expect(await state(item.providerId)).toEqual([{ revision: 1, models: ["keep", "late-remove", "remove"] }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.model_catalog WHERE provider_id=$1 AND deleted_at IS NULL", [item.providerId])).rows).toEqual([{ count: 2 }]);
    } finally { release.resolve(); await Promise.allSettled([writer.result, ...(sync ? [sync.result] : [])]); }
}, 30_000);

test("sync prunes the draft before a queued old draft save, which reports a version conflict", async () => {
    const item = await seed("draft-race"), draft = emptyMappingDraft();
    draft.models = [{ id: "race-image", displayName: "Race image", capability: "image", group: "" }];
    draft.modelSpecifications["race-image"] = ["1K", "2K", "4K"];
    draft.bindings = [{ providerId: item.providerId, providerModel: "remove", modelId: "race-image", specification: "4K" }];
    draft.preferred[mappingSpecKey("race-image", "4K")] = mappingSourceKey(draft.bindings[0]);
    const current = await readModelMappingDraft(observer.db, actor);
    const saved = await saveModelMappingDraft(observer.db, { expectedVersion: current.version, draft, providers: [{ providerId: item.providerId, revision: 1 }] }, actor);
    const ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const sync = begin(() => first.db.transaction(async tx => {
        const result = await saveDiscoveredProvider(tx, secret, item.providerId, item.write, actor); ready.resolve(await idlePid()); await release.promise; return result;
    }));
    let edit: ReturnType<typeof begin> | undefined;
    try {
        const pid = await Promise.race([ready.promise, sync.result.then(() => { throw new Error("Sync failed"); })]);
        edit = begin(() => saveModelMappingDraft(second.db, { expectedVersion: saved.version, draft, providers: [{ providerId: item.providerId, revision: 1 }] }, actor));
        await waitBlocked("second", pid, edit); release.resolve();
        expect(await sync.result).toMatchObject({ removedModelIds: [item.id] }); expect(await edit.result).toBe("mapping_conflict");
        const next = await readModelMappingDraft(observer.db, actor); expect(next.version).toBe(saved.version + 1); expect(next.draft.bindings).toEqual([]);
    } finally { release.resolve(); await Promise.allSettled([sync.result, ...(edit ? [edit.result] : [])]); }
}, 30_000);

test("two channel snapshots serialize with one winner and leave the losing receipt unconsumed", async () => {
    const item = await seed("two-snapshots"), other = await discover(item.providerId, 1, ["remove"]);
    const ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const sync = begin(() => first.db.transaction(async tx => {
        const result = await saveDiscoveredProvider(tx, secret, item.providerId, item.write, actor); ready.resolve(await idlePid()); await release.promise; return result;
    }));
    let competing: ReturnType<typeof begin> | undefined;
    try {
        const pid = await Promise.race([ready.promise, sync.result.then(() => { throw new Error("Sync failed"); })]);
        competing = begin(() => saveDiscoveredProvider(second.db, secret, item.providerId, other, actor));
        await waitBlocked("second", pid, competing); release.resolve();
        expect(await sync.result).toMatchObject({ removedModelIds: [item.id] }); expect(await competing.result).toBe("provider_revision_conflict");
        expect(await state(item.providerId)).toEqual([{ revision: 2, models: ["keep"] }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.provider_discovery_receipt WHERE id=$1", [other.discoveryReceiptId])).rows).toEqual([{ count: 1 }]);
    } finally { release.resolve(); await Promise.allSettled([sync.result, ...(competing ? [competing.result] : [])]); }
}, 30_000);

test("administrator revocation while sync waits prevents any channel or inventory change", async () => {
    const item = await seed("revocation");
    await blocker.query("BEGIN");
    const pending: ReturnType<typeof begin>[] = [];
    try {
        await blocker.query("SELECT id FROM canvas_saas.model_mapping_draft WHERE id='catalog' FOR UPDATE");
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        pending.push(begin(() => saveDiscoveredProvider(first.db, secret, item.providerId, item.write, actor)));
        await waitBlocked("first", pid, pending[0]);
        await observer.pool.query('UPDATE canvas_saas."user" SET role=$1 WHERE id=$2', ["user", actor.actorId]);
        await blocker.query("ROLLBACK"); expect(await pending[0].result).toBe("account_changed");
        expect(await state(item.providerId)).toEqual([{ revision: 1, models: ["keep", "remove"] }]);
    } finally {
        await blocker.query("ROLLBACK"); await Promise.allSettled(pending.map(item => item.result));
        await observer.pool.query('UPDATE canvas_saas."user" SET role=$1 WHERE id=$2', ["admin", actor.actorId]);
    }
}, 30_000);

test("an existing model edit holds sync in model-before-provider order without a deadlock", async () => {
    const item = await seed("edit-first"), ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    const edit = begin(() => first.db.transaction(async tx => {
        await saveNodeModel(tx, item.id, { providerId: item.providerId, providerModel: "remove", displayName: "Edited before sync", capability: "image", enabled: true, groupId: null, revision: 1 }, actor);
        ready.resolve(await idlePid()); await release.promise;
    }));
    let sync: ReturnType<typeof begin> | undefined;
    try {
        const pid = await Promise.race([ready.promise, edit.result.then(() => { throw new Error("Edit failed"); })]);
        sync = begin(() => saveDiscoveredProvider(second.db, secret, item.providerId, item.write, actor));
        await waitBlocked("second", pid, sync); release.resolve();
        expect(await edit.result).toBeUndefined(); expect(await sync.result).toMatchObject({ removedModelIds: [item.id] });
        expect((await observer.pool.query("SELECT display_name,revision,enabled,deleted_at IS NOT NULL AS deleted FROM canvas_saas.model_catalog WHERE public_id=$1", [item.id])).rows)
            .toEqual([{ display_name: "Edited before sync", revision: 3, enabled: false, deleted: true }]);
    } finally { release.resolve(); await Promise.allSettled([edit.result, ...(sync ? [sync.result] : [])]); }
}, 30_000);
