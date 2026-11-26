import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { saveNodeModel, saveNodeModelGroups, NodeModelConfigurationError } from "@infinite-canvas/database/node-model-groups";
import { postgresTestUrl } from "../../../apps/api/test/database";

const url = postgresTestUrl();
if (!url || process.env.DATABASE_URL || process.env.SAAS_POSTGRES_TEST_SUITE !== "node-models") throw new Error("Use test:postgres --node-models with a fresh isolated database");
const prefix = `node-race-${crypto.randomUUID()}`;
function connection(label: string) {
    const target = new URL(url!); target.searchParams.set("application_name", `${prefix}-${label}`); target.searchParams.set("statement_timeout", "30000");
    return createDatabase(target.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const blocker = new Client({ connectionString: url, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
const actor = { actorId: `${prefix}-owner`, sessionId: `${prefix}-session`, sessionExpiresAt: new Date(Date.now() + 3_600_000), requestId: "synthetic-test" };
const groupId = crypto.randomUUID();
let connected = false, blockerPid: number;
beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows).toEqual([{ count: 28 }]);
    await observer.pool.query('INSERT INTO canvas_saas."user" (id,name,email,email_verified,role) VALUES ($1,$2,$3,true,$4)', [actor.actorId,"Node race test","node-race@example.test","admin"]);
    await observer.pool.query('INSERT INTO canvas_saas.session (id,token,user_id,expires_at) VALUES ($1,$2,$3,$4)', [actor.sessionId,crypto.randomUUID(),actor.actorId,actor.sessionExpiresAt]);
    await observer.pool.query("INSERT INTO canvas_saas.model_provider (id,display_name,adapter,endpoint,secret_ref,enabled) VALUES ('node-channel','Synthetic','openai-compatible','https://provider.invalid','isolated-test',true)");
    await saveNodeModelGroups(observer.db, { capability: "image", expectedVersion: 0, groups: [{ id: groupId, name: "Initial" }] }, actor);
    await blocker.connect(); connected = true; blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}, 30_000);
afterAll(async () => {
    try { if (connected) await blocker.query("ROLLBACK"); }
    finally { const outcomes = await Promise.allSettled([blocker.end(),first.close(),second.close(),observer.close()]); if (outcomes.some(item => item.status === "rejected")) throw new Error("Database connection not closed"); }
});
function begin(work: () => Promise<unknown>) {
    const pending = { settled: false, result: Promise.resolve("pending") };
    pending.result = work().then(() => "saved", error => { if (!(error instanceof NodeModelConfigurationError)) throw error; return error.code; }).finally(() => { pending.settled = true; });
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
const model = (revision: number, displayName = "Synthetic image") => ({ revision, groupId, providerId: "node-channel", providerModel: "synthetic-image", displayName, capability: "image" as const, enabled: false });

test("competing group updates keep one complete ordered document", async () => {
    const pending: ReturnType<typeof begin>[] = []; await blocker.query("BEGIN");
    try {
        await blocker.query("SELECT capability FROM canvas_saas.model_node_groups WHERE capability='image' FOR UPDATE");
        pending.push(begin(() => saveNodeModelGroups(first.db, { capability: "image", expectedVersion: 1, groups: [{ id: groupId, name: "Winner" }] }, actor)));
        const firstPid = await waitBlocked("first", blockerPid, pending[0]);
        pending.push(begin(() => saveNodeModelGroups(second.db, { capability: "image", expectedVersion: 1, groups: [{ id: groupId, name: "Stale" }] }, actor)));
        await waitBlocked("second", firstPid, pending[1]); await blocker.query("ROLLBACK");
        expect(await Promise.all(pending.map(item => item.result))).toEqual(["saved","model_group_conflict"]);
        expect((await observer.pool.query("SELECT version,groups FROM canvas_saas.model_node_groups WHERE capability='image'")).rows).toEqual([{ version: 2, groups: [{ id: groupId, name: "Winner" }] }]);
    } finally { await blocker.query("ROLLBACK"); await Promise.allSettled(pending.map(item => item.result)); }
},30_000);

test("group removal waits for assignment then refuses to leave a dangling model", async () => {
    const pending: ReturnType<typeof begin>[] = []; await blocker.query("BEGIN");
    try {
        await blocker.query("SELECT id FROM canvas_saas.session WHERE id=$1 FOR UPDATE", [actor.sessionId]);
        pending.push(begin(() => saveNodeModel(first.db,"race-image",model(0),actor)));
        const firstPid = await waitBlocked("first",blockerPid,pending[0]);
        pending.push(begin(() => saveNodeModelGroups(second.db,{ capability:"image",expectedVersion:2,groups:[] },actor)));
        await waitBlocked("second",firstPid,pending[1]); await blocker.query("ROLLBACK");
        expect(await Promise.all(pending.map(item => item.result))).toEqual(["saved","model_group_in_use"]);
        expect((await observer.pool.query("SELECT group_id,revision FROM canvas_saas.model_catalog WHERE public_id='race-image'")).rows).toEqual([{ group_id:groupId,revision:1 }]);
    } finally { await blocker.query("ROLLBACK"); await Promise.allSettled(pending.map(item => item.result)); }
},30_000);

test("same model revision cannot overwrite the winning metadata save", async () => {
    const pending: ReturnType<typeof begin>[] = []; await blocker.query("BEGIN");
    try {
        await blocker.query("SELECT id FROM canvas_saas.model_catalog WHERE public_id='race-image' FOR UPDATE");
        pending.push(begin(() => saveNodeModel(first.db,"race-image",model(1,"Winner image"),actor)));
        const firstPid = await waitBlocked("first",blockerPid,pending[0]);
        pending.push(begin(() => saveNodeModel(second.db,"race-image",model(1,"Stale image"),actor)));
        await waitBlocked("second",firstPid,pending[1]); await blocker.query("ROLLBACK");
        expect(await Promise.all(pending.map(item => item.result))).toEqual(["saved","model_revision_conflict"]);
        expect((await observer.pool.query("SELECT display_name,revision FROM canvas_saas.model_catalog WHERE public_id='race-image'")).rows).toEqual([{ display_name:"Winner image",revision:2 }]);
    } finally { await blocker.query("ROLLBACK"); await Promise.allSettled(pending.map(item => item.result)); }
},30_000);

test("session revoked during a model save leaves metadata and audit unchanged", async () => {
    let pending: ReturnType<typeof begin> | undefined; await blocker.query("BEGIN");
    try {
        await blocker.query("DELETE FROM canvas_saas.session WHERE id=$1",[actor.sessionId]);
        pending = begin(() => saveNodeModel(first.db,"race-image",model(2,"Revoked image"),actor));
        await waitBlocked("first",blockerPid,pending); await blocker.query("COMMIT");
        expect(await pending.result).toBe("account_changed");
        expect((await observer.pool.query("SELECT revision FROM canvas_saas.model_catalog WHERE public_id='race-image'")).rows).toEqual([{ revision:2 }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.audit_event WHERE resource_id='race-image'")).rows).toEqual([{ count:2 }]);
    } finally { await blocker.query("ROLLBACK"); if (pending) await Promise.allSettled([pending.result]); }
},30_000);
