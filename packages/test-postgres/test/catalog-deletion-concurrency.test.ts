import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { CatalogDeletionError, deleteCatalogModel, deleteCatalogProvider } from "@infinite-canvas/database/catalog-deletion";
import { createGenerationTaskRepository, GenerationTaskError } from "@infinite-canvas/database/generation-tasks";
import { NodeModelConfigurationError, saveNodeModel } from "@infinite-canvas/database/node-model-groups";
import { postgresTestUrl } from "../../../apps/api/test/database";
import journal from "../../database/migrations/meta/_journal.json";

const url = postgresTestUrl();
if (!url || process.env.DATABASE_URL || process.env.SAAS_POSTGRES_TEST_SUITE !== "catalog-deletion") throw new Error("Use test:postgres --catalog-deletion with a fresh isolated database");
const prefix = `catalog-race-${crypto.randomUUID()}`;
function connection(label: string) {
    const target = new URL(url!); target.searchParams.set("application_name", `${prefix}-${label}`); target.searchParams.set("statement_timeout", "30000");
    return createDatabase(target.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const blocker = new Client({ connectionString: url, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
const actor = { actorId: `${prefix}-owner`, sessionId: `${prefix}-session`, sessionExpiresAt: new Date(Date.now() + 3_600_000), requestId: "synthetic-test" };
let connected = false;
beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows).toEqual([{ count: journal.entries.length }]);
    await observer.pool.query('INSERT INTO canvas_saas."user" (id,name,email,email_verified,role) VALUES ($1,$2,$3,true,$4)', [actor.actorId, "Catalog race", "catalog-race@example.test", "admin"]);
    await observer.pool.query('INSERT INTO canvas_saas.session (id,token,user_id,expires_at) VALUES ($1,$2,$3,$4)', [actor.sessionId, crypto.randomUUID(), actor.actorId, actor.sessionExpiresAt]);
    await blocker.connect(); connected = true;
}, 30_000);
afterAll(async () => {
    try { if (connected) await blocker.query("ROLLBACK"); }
    finally { const outcomes = await Promise.allSettled([blocker.end(), first.close(), second.close(), observer.close()]); if (outcomes.some(item => item.status === "rejected")) throw new Error("Database connection not closed"); }
});
const taskInput = (id: string) => ({ ownerId: actor.actorId, modelId: id, inputSnapshot: { prompt: "synthetic" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: "synthetic-test" });
async function seed(label: string) {
    const providerId = `provider-${label}`, id = `model-${label}`;
    await observer.pool.query("INSERT INTO canvas_saas.model_provider (id,display_name,adapter,endpoint,secret_ref,enabled) VALUES ($1,'Synthetic','openai-compatible','https://provider.invalid','isolated-test',true)", [providerId]);
    await observer.pool.query("INSERT INTO canvas_saas.model_catalog (id,public_id,provider_id,provider_model,display_name,capability,enabled) VALUES ($1,$1,$2,'synthetic-model','Synthetic','image',true)", [id, providerId]);
    return { id, providerId };
}
function begin(work: () => Promise<unknown>) {
    const pending = { settled: false, result: Promise.resolve<unknown>(null) };
    pending.result = work().catch(error => {
        if (error instanceof CatalogDeletionError || error instanceof GenerationTaskError || error instanceof NodeModelConfigurationError) return error.code;
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

for (const kind of ["model", "provider"] as const) {
    const remove = (db: typeof first.db, item: { id: string; providerId: string }) => kind === "model"
        ? deleteCatalogModel(db, item.id, 1, actor) : deleteCatalogProvider(db, item.providerId, 1, actor);
    test(`${kind}: admitted task holds deletion until commit, then deletion refuses unfinished work`, async () => {
        const item = await seed(`${kind}-task-first`), input = taskInput(item.id);
        const admitted = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
        const task = begin(() => first.db.transaction(async tx => {
            const result = await createGenerationTaskRepository(tx).create(input);
            const pid = (await observer.pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'", [`${prefix}-first`])).rows[0].pid as number;
            admitted.resolve(pid); await release.promise; return result;
        }));
        let deletion: ReturnType<typeof begin> | undefined;
        try {
            const pid = await Promise.race([admitted.promise, task.result.then(() => { throw new Error("Task failed before admission"); })]);
            deletion = begin(() => remove(second.db, item));
            await waitBlocked("second", pid, deletion);
            release.resolve(); expect(await task.result).toMatchObject({ created: true });
            expect(await deletion.result).toBe("catalog_in_use");
            expect((await observer.pool.query("SELECT deleted_at FROM canvas_saas.model_provider WHERE id=$1", [item.providerId])).rows).toEqual([{ deleted_at: null }]);
            const saved = await createGenerationTaskRepository(observer.db).create(input);
            expect(saved.created).toBe(false);
        } finally { release.resolve(); await Promise.allSettled([task.result, ...(deletion ? [deletion.result] : [])]); }
    }, 30_000);

    test(`${kind}: committed deletion blocks an already waiting new task without creating a task or reservation`, async () => {
        const item = await seed(`${kind}-delete-first`), input = taskInput(item.id);
        const removed = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
        const deletion = begin(() => first.db.transaction(async tx => {
            const receipt = await remove(tx, item);
            const pid = (await observer.pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'", [`${prefix}-first`])).rows[0].pid as number;
            removed.resolve(pid); await release.promise; return receipt;
        }));
        let task: ReturnType<typeof begin> | undefined;
        try {
            const pid = await Promise.race([removed.promise, deletion.result.then(() => { throw new Error("Deletion failed before commit"); })]);
            task = begin(() => createGenerationTaskRepository(second.db).create(input));
            await waitBlocked("second", pid, task); release.resolve();
            expect(await deletion.result).toMatchObject({ modelIds: [item.id] });
            expect(await task.result).toBe("model_unavailable");
            expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.generation_task WHERE model_id=$1", [item.id])).rows).toEqual([{ count: 0 }]);
            expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.wallet_reservation")).rows).toEqual([{ count: 0 }]);
        } finally { release.resolve(); await Promise.allSettled([deletion.result, ...(task ? [task.result] : [])]); }
    }, 30_000);
}

test("metadata save winning the row lock makes a concurrent deletion's revision stale", async () => {
    const item = await seed("save-first"), pending: ReturnType<typeof begin>[] = [];
    await blocker.query("BEGIN");
    try {
        await blocker.query("SELECT id FROM canvas_saas.model_catalog WHERE public_id=$1 FOR UPDATE", [item.id]);
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        pending.push(begin(() => saveNodeModel(first.db, item.id, { providerId: item.providerId, providerModel: "synthetic-model", displayName: "Winner", capability: "image", enabled: true, groupId: null, revision: 1 }, actor)));
        const savePid = await waitBlocked("first", pid, pending[0]);
        pending.push(begin(() => deleteCatalogModel(second.db, item.id, 1, actor)));
        await waitBlocked("second", savePid, pending[1]); await blocker.query("ROLLBACK");
        expect(await pending[0].result).toBeUndefined(); expect(await pending[1].result).toBe("catalog_revision_conflict");
        expect((await observer.pool.query("SELECT display_name,revision,deleted_at FROM canvas_saas.model_catalog WHERE public_id=$1", [item.id])).rows).toEqual([{ display_name: "Winner", revision: 2, deleted_at: null }]);
    } finally { await blocker.query("ROLLBACK"); await Promise.allSettled(pending.map(item => item.result)); }
}, 30_000);
