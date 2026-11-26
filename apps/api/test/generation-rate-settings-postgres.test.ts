import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { GenerationRateSettingsError, getAdminGenerationRates, getGenerationRateOperation, publishGenerationRates,
    resolveGenerationRates, type GenerationRatePolicyWrite, type GenerationSafetyDefaults } from "../../../packages/database/src/generation-rate-settings";
import type { SafetyActor } from "../../../packages/database/src/account-moderation";
import { postgresTestUrl } from "./database";
import { expectCurrentMigrations } from "./migrations";

const enabled = process.env.Q1_D04_POSTGRES === "1";
const pgTest = enabled ? test : test.skip;
const baseUrl = enabled ? postgresTestUrl() : null;
if (enabled && (!baseUrl || process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL)) throw new Error("D04仅接受runner创建的独立回环PostgreSQL目标");
const prefix = `q1-d04-policy-${crypto.randomUUID()}`;
const defaults: GenerationSafetyDefaults = {
    policy: { ip: { enabled: true, points: 10, duration: 3600 }, user: { enabled: true, points: 50, duration: 86400 } },
    modelRates: [], checkpointMode: "record",
};
const connection = (label: string) => {
    const url = new URL(baseUrl!);
    url.searchParams.set("application_name", `${prefix}-${label}`);
    url.searchParams.set("statement_timeout", "30000");
    return createDatabase(url.toString());
};
let observer: ReturnType<typeof createDatabase>, first: ReturnType<typeof createDatabase>, second: ReturnType<typeof createDatabase>, blockerDatabase: ReturnType<typeof createDatabase>;
const acquireBlocker = () => blockerDatabase.pool.connect();
let blocker: Awaited<ReturnType<typeof acquireBlocker>>, blockerPid: number, connected = false, admin: SafetyActor;
const input = (expectedRevision: number, points = 15): GenerationRatePolicyWrite => ({ operationId: crypto.randomUUID(), expectedRevision,
    policy: { ip: { enabled: true, points }, user: { enabled: true, points: 50 } } });
async function seed(suffix: string): Promise<SafetyActor> {
    const actorId = `${prefix}-${suffix}`, sessionId = `${actorId}-session`, expiresAt = new Date(Date.now() + 3_600_000);
    await observer.pool.query('INSERT INTO canvas_saas."user"(id,name,email,email_verified,role) VALUES ($1,$2,$3,true,\'admin\')',
        [actorId, "合成政策竞争管理员", `${crypto.randomUUID()}@example.test`]);
    await observer.pool.query("INSERT INTO canvas_saas.session(id,token,user_id,expires_at) VALUES ($1,$2,$3,$4)",
        [sessionId, crypto.randomUUID(), actorId, expiresAt]);
    return { actorId, sessionId, sessionExpiresAt: expiresAt, requestId: crypto.randomUUID() };
}
async function snapshot() {
    return (await observer.pool.query(`SELECT s.revision, s.active_version_id, s.updated_at,
        (SELECT count(*)::int FROM canvas_saas.generation_rate_version) AS versions,
        (SELECT count(*)::int FROM canvas_saas.audit_event WHERE action='generation.rates.published') AS audits
        FROM canvas_saas.generation_rate_settings s WHERE s.id='generation'`)).rows[0];
}
function pending(work: ReturnType<typeof publishGenerationRates>) {
    const state = { settled: false, result: Promise.resolve<{ ok: boolean; code?: string }>({ ok: false, code: "pending" }) };
    state.result = work.then(() => ({ ok: true }), error => {
        if (!(error instanceof GenerationRateSettingsError)) throw error;
        return { ok: false, code: error.code };
    }).finally(() => { state.settled = true; });
    return state;
}
async function waitBlocked(work: ReturnType<typeof pending>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (work.settled) throw new Error("政策写入未进入预期权限锁等待");
        const { rows } = await observer.pool.query<{ blockers: number[] }>(
            "SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [`${prefix}-first`]);
        if (rows.some(row => row.blockers.includes(blockerPid))) return;
        await Bun.sleep(10);
    }
    throw new Error("未观察到实际PostgreSQL权限锁阻塞");
}

beforeAll(async () => {
    if (!enabled) return;
    observer = connection("observer"); first = connection("first"); second = connection("second"); blockerDatabase = connection("blocker");
    blocker = await acquireBlocker(); connected = true;
    blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const boundary = (await observer.pool.query(`SELECT current_database() AS database, current_user AS username,
        host(inet_server_addr()) AS host, current_setting('server_version_num') AS version,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged`)).rows[0];
    expect(boundary).toEqual({ database: "canvas_saas_test", username: "canvas_test_app", host: "127.0.0.1", version: "160015", privileged: false });
    await migrateDatabase(observer.db);
    await expectCurrentMigrations(observer.pool);
    admin = await seed("admin");
}, 30_000);
afterAll(async () => {
    if (connected) blocker.release();
    await Promise.all([observer?.close(), first?.close(), second?.close(), blockerDatabase?.close()]);
});

pgTest("two independent pools publishing the same revision yield one version, pointer and audit", async () => {
    const before = await snapshot(), current = await resolveGenerationRates(observer.db, defaults);
    const outcomes = await Promise.allSettled([publishGenerationRates(first.db, input(current.revision, 17), admin, defaults),
        publishGenerationRates(second.db, input(current.revision, 19), admin, defaults)]);
    const fulfilled = outcomes.filter(result => result.status === "fulfilled"), rejected = outcomes.filter(result => result.status === "rejected");
    expect(fulfilled).toHaveLength(1); expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "rate_settings_conflict" });
    const receipt = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof publishGenerationRates>>>).value;
    const after = await snapshot();
    expect(after.revision).toBe(before.revision + 1); expect(after.active_version_id).toBe(receipt.operationId);
    expect(after.versions - before.versions).toBe(1); expect(after.audits - before.audits).toBe(1);
}, 30_000);

pgTest("concurrent same-operation publication returns the original receipt with one audit", async () => {
    const before = await snapshot(), requested = input(before.revision, 21);
    const receipts = await Promise.all([publishGenerationRates(first.db, requested, admin, defaults),
        publishGenerationRates(second.db, requested, admin, defaults)]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await getGenerationRateOperation(observer.db, requested.operationId, admin)).toEqual(receipts[0]);
    const after = await snapshot();
    expect(after.revision).toBe(before.revision + 1); expect(after.versions - before.versions).toBe(1); expect(after.audits - before.audits).toBe(1);
}, 30_000);

pgTest("audit insert failure rolls back the complete publication without deleting immutable evidence", async () => {
    const before = await snapshot();
    let triggerCreated = false, functionCreated = false;
    try {
        await observer.pool.query(`CREATE FUNCTION canvas_saas.q1_d04_policy_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.action='generation.rates.published' THEN RAISE EXCEPTION 'synthetic-policy-audit-failure'; END IF; RETURN NEW; END; $$`);
        functionCreated = true;
        await observer.pool.query(`CREATE TRIGGER q1_d04_policy_audit_failure BEFORE INSERT ON canvas_saas.audit_event
            FOR EACH ROW EXECUTE FUNCTION canvas_saas.q1_d04_policy_audit_failure()`);
        triggerCreated = true;
        await expect(publishGenerationRates(first.db, input(before.revision, 23), admin, defaults)).rejects.toMatchObject({ code: "rate_settings_unavailable" });
        expect(await snapshot()).toEqual(before);
    } finally {
        // Only this test's fault trigger/function; immutable publication/audit protections remain untouched.
        if (triggerCreated) await observer.pool.query("DROP TRIGGER q1_d04_policy_audit_failure ON canvas_saas.audit_event");
        if (functionCreated) await observer.pool.query("DROP FUNCTION canvas_saas.q1_d04_policy_audit_failure()");
    }
}, 30_000);

pgTest("session revocation committed during a real user lock wait rejects the waiting publication", async () => {
    const actor = await seed("revoked"), before = await snapshot();
    let transactionOpen = false, work: ReturnType<typeof pending> | undefined;
    try {
        await blocker.query("BEGIN"); transactionOpen = true;
        await blocker.query('SELECT id FROM canvas_saas."user" WHERE id=$1 FOR UPDATE', [actor.actorId]);
        await blocker.query("DELETE FROM canvas_saas.session WHERE id=$1", [actor.sessionId]);
        work = pending(publishGenerationRates(first.db, input(before.revision, 25), actor, defaults));
        await waitBlocked(work);
        await blocker.query("COMMIT"); transactionOpen = false;
        expect(await work.result).toEqual({ ok: false, code: "account_changed" });
        expect(await snapshot()).toEqual(before);
        await expect(getAdminGenerationRates(observer.db, actor, defaults)).rejects.toMatchObject({ code: "account_changed" });
    } finally {
        if (transactionOpen) await blocker.query("ROLLBACK");
        if (work) await work.result;
    }
}, 30_000);

pgTest("replaying an older operation after another publication cannot replace the active policy", async () => {
    const start = await snapshot(), old = input(start.revision, 27);
    const receipt = await publishGenerationRates(first.db, old, admin, defaults);
    const newer = input(receipt.publishedRevision, 29);
    const active = await publishGenerationRates(second.db, newer, admin, defaults);
    const beforeReplay = await snapshot();
    const changedDefaults = { ...defaults, policy: { ip: { ...defaults.policy.ip, duration: 60 }, user: { ...defaults.policy.user, duration: 120 } } };
    expect(await publishGenerationRates(first.db, old, admin, changedDefaults)).toEqual(receipt);
    expect(await snapshot()).toEqual(beforeReplay);
    const effective = await resolveGenerationRates(observer.db, defaults);
    expect(effective.publicationId).toBe(active.operationId); expect(effective.revision).toBe(active.publishedRevision);
    expect(effective.policy).toEqual(active.policy);
}, 30_000);

pgTest("expiry after a real settings lock wait rejects publication without version or audit", async () => {
    const actor = await seed("expired-settings-wait"), before = await snapshot();
    const expiresAt = new Date(Date.now() + 1500);
    await observer.pool.query("UPDATE canvas_saas.session SET expires_at=$1 WHERE id=$2", [expiresAt, actor.sessionId]);
    actor.sessionExpiresAt = expiresAt;
    let open = false, work: ReturnType<typeof pending> | undefined;
    try {
        await blocker.query("BEGIN"); open = true;
        await blocker.query("SELECT id FROM canvas_saas.generation_rate_settings WHERE id='generation' FOR UPDATE");
        work = pending(publishGenerationRates(first.db, input(before.revision), actor, defaults));
        await waitBlocked(work);
        await Bun.sleep(Math.max(1, expiresAt.getTime() - Date.now() + 30));
        await blocker.query("COMMIT"); open = false;
        expect(await work.result).toEqual({ ok: false, code: "account_changed" });
        expect(await snapshot()).toEqual(before);
    } finally { if (open) await blocker.query("ROLLBACK"); if (work) await work.result; }
}, 30_000);

pgTest("operation conflicts do not disclose another actor receipt or change the active policy", async () => {
    const start = await snapshot(), requested = input(start.revision), receipt = await publishGenerationRates(first.db, requested, admin, defaults);
    const other = await seed("other-admin"), before = await snapshot();
    expect(await getGenerationRateOperation(second.db, requested.operationId, other)).toBeNull();
    await expect(publishGenerationRates(second.db, requested, other, defaults)).rejects.toMatchObject({ code: "rate_settings_conflict" });
    await expect(publishGenerationRates(first.db, { ...requested, policy: { ...requested.policy, ip: { enabled: true, points: 99 } } }, admin, defaults))
        .rejects.toMatchObject({ code: "rate_settings_conflict" });
    expect(await snapshot()).toEqual(before);
    expect(await getGenerationRateOperation(first.db, requested.operationId, admin)).toEqual(receipt);
}, 30_000);
