import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { prepareProviderDiscovery, recordProviderDiscovery, saveDiscoveredProvider, ProviderDiscoveryError,
    type DiscoveryActor, type ProviderWrite } from "@infinite-canvas/database/provider-discovery";
import { postgresTestUrl } from "../../../apps/api/test/database";

const url = postgresTestUrl();
if (!url || process.env.DATABASE_URL || process.env.SAAS_POSTGRES_TEST_SUITE !== "provider-discovery") {
    throw new Error("请仅通过 test:postgres --provider-discovery 的全新隔离数据库运行");
}
const prefix = `discovery-race-${crypto.randomUUID()}`, secret = crypto.randomUUID();
function connection(label: string) {
    const target = new URL(url!);
    target.searchParams.set("application_name", `${prefix}-${label}`);
    target.searchParams.set("statement_timeout", "30000");
    return createDatabase(target.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const blocker = new Client({ connectionString: url, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
const actor: DiscoveryActor = { actorId: `${prefix}-owner`, sessionId: `${prefix}-session`, sessionExpiresAt: new Date(Date.now() + 3_600_000) };
let connected = false, blockerPid: number;
beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows).toEqual([{ count: 28 }]);
    await observer.pool.query('INSERT INTO canvas_saas."user" (id, name, email, email_verified, role) VALUES ($1, $2, $3, true, $4)',
        [actor.actorId, "Isolated discovery test", "provider-race@example.test", "admin"]);
    await observer.pool.query('INSERT INTO canvas_saas.session (id, token, user_id, expires_at) VALUES ($1, $2, $3, $4)',
        [actor.sessionId, crypto.randomUUID(), actor.actorId, actor.sessionExpiresAt]);
    await blocker.connect(); connected = true;
    blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}, 30_000);
afterAll(async () => {
    try { if (connected) await blocker.query("ROLLBACK"); }
    finally {
        const closed = await Promise.allSettled([blocker.end(), first.close(), second.close(), observer.close()]);
        if (closed.some(item => item.status === "rejected")) throw new Error("Isolated database connection did not close");
    }
});
const input = (revision: number): ProviderWrite => ({ displayName: "Synthetic channel", adapter: "openai-compatible",
    endpoint: "https://provider.invalid/v1", enabled: true, apiKey: "synthetic-provider-key", revision });
async function receipt(id: string, body: ProviderWrite, models: string[]) {
    const target = await prepareProviderDiscovery(observer.db, secret, id, body, actor);
    return recordProviderDiscovery(observer.db, secret, target, body.revision, models, actor);
}
const save = (db: typeof first, id: string, body: ProviderWrite) => saveDiscoveredProvider(db.db, secret, id, body, { ...actor, requestId: crypto.randomUUID() });
type Outcome = { ok: true; revision: number } | { ok: false; code: string };
function begin(work: () => ReturnType<typeof save>) {
    const pending = { settled: false, result: Promise.resolve<Outcome>({ ok: false, code: "pending" }) };
    pending.result = work().then(result => ({ ok: true as const, revision: result.revision }), error => {
        if (!(error instanceof ProviderDiscoveryError)) throw error;
        return { ok: false as const, code: error.code };
    }).finally(() => { pending.settled = true; });
    return pending;
}
async function waitBlocked(label: string, by: number, pending: ReturnType<typeof begin>) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (pending.settled) throw new Error("Operation settled before the expected lock wait");
        const { rows } = await observer.pool.query<{ pid: number; blockers: number[] }>(
            "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [`${prefix}-${label}`]);
        const row = rows.find(value => value.blockers.includes(by));
        if (row) return row.pid;
        await Bun.sleep(10);
    }
    throw new Error("Expected PostgreSQL lock relationship was not observed");
}
async function inventory(id: string) {
    return (await observer.pool.query("SELECT provider_model, available FROM canvas_saas.provider_discovered_model WHERE provider_id = $1 ORDER BY provider_model", [id])).rows;
}

test("two real transactions creating one channel commit only one complete inventory", async () => {
    const id = "provider-race-create", body = input(0);
    const a = await receipt(id, body, ["model-a"]), b = await receipt(id, body, ["model-b"]);
    const pending: ReturnType<typeof begin>[] = [];
    await blocker.query("BEGIN");
    try {
        // Both transactions can read the missing row; their INSERTs wait on this table lock.
        await blocker.query("LOCK TABLE canvas_saas.model_provider IN SHARE MODE");
        pending.push(begin(() => save(first, id, { ...body, discoveryReceiptId: a.receiptId })));
        await waitBlocked("first", blockerPid, pending[0]!);
        pending.push(begin(() => save(second, id, { ...body, discoveryReceiptId: b.receiptId })));
        await waitBlocked("second", blockerPid, pending[1]!);
        await blocker.query("ROLLBACK");
        const results = await Promise.all(pending.map(item => item.result));
        expect(results.filter(item => item.ok)).toHaveLength(1);
        expect(results.filter(item => !item.ok)).toEqual([{ ok: false, code: "provider_revision_conflict" }]);
        expect(await inventory(id)).toEqual([{ provider_model: results[0]!.ok ? "model-a" : "model-b", available: true }]);
        expect((await observer.pool.query("SELECT revision FROM canvas_saas.model_provider WHERE id = $1", [id])).rows).toEqual([{ revision: 1 }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.audit_event WHERE resource_id = $1", [id])).rows).toEqual([{ count: 1 }]);
    } finally { await blocker.query("ROLLBACK"); await Promise.allSettled(pending.map(item => item.result)); }
}, 30_000);

test("an observed row-lock race rejects the stale catalog update without mixing rows", async () => {
    const id = "provider-race-update", initial = input(0);
    const initialReceipt = await receipt(id, initial, ["model-original"]);
    await save(observer, id, { ...initial, discoveryReceiptId: initialReceipt.receiptId });
    const body = { ...input(1), apiKey: "" }, a = await receipt(id, body, ["model-a"]), b = await receipt(id, body, ["model-b"]);
    const pending: ReturnType<typeof begin>[] = [];
    await blocker.query("BEGIN");
    try {
        await blocker.query("SELECT id FROM canvas_saas.model_provider WHERE id = $1 FOR UPDATE", [id]);
        pending.push(begin(() => save(first, id, { ...body, discoveryReceiptId: a.receiptId })));
        const firstPid = await waitBlocked("first", blockerPid, pending[0]!);
        pending.push(begin(() => save(second, id, { ...body, discoveryReceiptId: b.receiptId })));
        await waitBlocked("second", firstPid, pending[1]!);
        await blocker.query("ROLLBACK");
        expect(await Promise.all(pending.map(item => item.result))).toEqual([
            { ok: true, revision: 2 }, { ok: false, code: "provider_revision_conflict" },
        ]);
        expect(await inventory(id)).toEqual([{ provider_model: "model-a", available: true }, { provider_model: "model-original", available: false }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.audit_event WHERE resource_id = $1", [id])).rows).toEqual([{ count: 2 }]);
    } finally { await blocker.query("ROLLBACK"); await Promise.allSettled(pending.map(item => item.result)); }
}, 30_000);

test("session revocation committed while saving waits prevents the channel write", async () => {
    const id = "provider-race-revoked", body = input(0), proof = await receipt(id, body, ["model-a"]);
    let pending: ReturnType<typeof begin> | undefined;
    await blocker.query("BEGIN");
    try {
        await blocker.query("DELETE FROM canvas_saas.session WHERE id = $1", [actor.sessionId]);
        pending = begin(() => save(first, id, { ...body, discoveryReceiptId: proof.receiptId }));
        await waitBlocked("first", blockerPid, pending);
        await blocker.query("COMMIT");
        expect(await pending.result).toEqual({ ok: false, code: "account_changed" });
        expect((await observer.pool.query("SELECT id FROM canvas_saas.model_provider WHERE id = $1", [id])).rows).toEqual([]);
        expect(await inventory(id)).toEqual([]);
    } finally { await blocker.query("ROLLBACK"); if (pending) await Promise.allSettled([pending.result]); }
}, 30_000);
