import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { session, user } from "@infinite-canvas/database/schema";
import { createAuth, getPrincipal } from "@infinite-canvas/auth";
import { AccountModerationError, setAccountModeration, type SafetyActor } from "../../../packages/database/src/account-moderation";
import { postgresTestUrl } from "./database";

const enabled = process.env.Q1_SAFETY_POSTGRES === "1";
const pgTest = enabled ? test : test.skip;
const baseUrl = enabled ? postgresTestUrl() : null;
if (enabled && (!baseUrl || process.env.DATABASE_URL)) throw new Error("Q1仅接受runner新建的隔离回环PostgreSQL目标");
const prefix = `q1-moderation-${crypto.randomUUID()}`;
const connection = (label: string) => {
    const url = new URL(baseUrl!);
    url.searchParams.set("application_name", `${prefix}-${label}`);
    url.searchParams.set("statement_timeout", "30000");
    return createDatabase(url.toString());
};
let observer: ReturnType<typeof createDatabase>, first: ReturnType<typeof createDatabase>, second: ReturnType<typeof createDatabase>;
let blocker: Client, blockerPid: number, connected = false;
const future = () => new Date(Date.now() + 3_600_000);
async function seed(suffix: string, role: "user" | "admin" = "admin"): Promise<SafetyActor> {
    const id = `${prefix}-${suffix}`, sessionId = `${id}-session`, expires = future();
    await observer.pool.query('INSERT INTO canvas_saas."user" (id,name,email,email_verified,role) VALUES ($1,$2,$3,true,$4)',
        [id, "合成权限竞争账号", `${suffix}-${crypto.randomUUID()}@example.test`, role]);
    await observer.pool.query("INSERT INTO canvas_saas.session (id,token,user_id,expires_at) VALUES ($1,$2,$3,$4)",
        [sessionId, crypto.randomUUID(), id, expires]);
    return { actorId: id, sessionId, sessionExpiresAt: expires, requestId: crypto.randomUUID() };
}
const input = (disabled = true, expectedVersion = 0) => ({ operationId: crypto.randomUUID(), disabled, expectedVersion, reason: "合成竞争验证" });
type Outcome = { ok: true; revision: number } | { ok: false; code: string };
function pending(work: () => ReturnType<typeof setAccountModeration>) {
    const state = { settled: false, result: Promise.resolve<Outcome>({ ok: false, code: "pending" }) };
    state.result = work().then(value => ({ ok: true as const, revision: value.revision }), error => {
        if (!(error instanceof AccountModerationError)) throw error;
        return { ok: false as const, code: error.code };
    }).finally(() => { state.settled = true; });
    return state;
}
async function waitBlocked(label: string, work: ReturnType<typeof pending>) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (work.settled) throw new Error("处置未进入预期数据库锁等待");
        const { rows } = await observer.pool.query<{ pid: number; blockers: number[] }>(
            "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [`${prefix}-${label}`]);
        if (rows.some(row => row.blockers.length)) return rows[0]!;
        await Bun.sleep(10);
    }
    throw new Error("未观察到真实PostgreSQL阻塞关系");
}
beforeAll(async () => {
    if (!enabled) return;
    observer = connection("observer"); first = connection("first"); second = connection("second");
    const boundary = (await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged`)).rows[0];
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false });
    await migrateDatabase(observer.db);
    const versionColumns = (await observer.pool.query(`SELECT table_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema='canvas_saas' AND table_name IN ('user','session')
        AND column_name='moderation_version' ORDER BY table_name`)).rows;
    expect(versionColumns).toEqual([
        { table_name: "session", data_type: "integer", is_nullable: "NO", column_default: "0" },
        { table_name: "user", data_type: "integer", is_nullable: "NO", column_default: "0" },
    ]);
    const triggers = (await observer.pool.query(`SELECT tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgrelid='canvas_saas.account_moderation_operation'::regclass AND tgname='account_moderation_operation_immutable' AND NOT tgisinternal`)).rows;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].tgenabled).toBe("O");
    expect(triggers[0].definition).toMatch(/BEFORE .*DELETE.*UPDATE|BEFORE .*UPDATE.*DELETE/);
    expect(triggers[0].definition).toContain("reject_account_moderation_operation_mutation()");
    blocker = new Client({ connectionString: baseUrl!, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
    await blocker.connect(); connected = true;
    blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}, 30_000);
afterAll(async () => {
    if (!enabled) return;
    if (connected) await blocker.query("ROLLBACK");
    const closed = await Promise.allSettled([blocker?.end(), first?.close(), second?.close(), observer?.close()]);
    if (closed.some(value => value.status === "rejected")) throw new Error("Q1隔离数据库连接未完整关闭");
});

pgTest("the formal migration rejects receipt UPDATE and DELETE without changing its audit or account", async () => {
    const actor = await seed("immutable-admin"), target = await seed("immutable-target", "user"), change = input();
    await setAccountModeration(first.db, target.actorId, change, actor);
    const readReceipt = () => observer.pool.query("SELECT * FROM canvas_saas.account_moderation_operation WHERE id=$1", [change.operationId]);
    const readAudit = () => observer.pool.query("SELECT * FROM canvas_saas.audit_event WHERE resource_id=$1 ORDER BY id", [target.actorId]);
    const originalReceipt = (await readReceipt()).rows, originalAudit = (await readAudit()).rows;
    expect(originalReceipt).toHaveLength(1); expect(originalAudit).toHaveLength(1);
    for (const statement of ["UPDATE canvas_saas.account_moderation_operation SET reason='synthetic-change' WHERE id=$1",
        "DELETE FROM canvas_saas.account_moderation_operation WHERE id=$1"]) {
        const rejection = await first.pool.query(statement, [change.operationId]).then(() => null,
            (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));
        expect(rejection).toEqual({ code: "P0001", message: "account moderation operations are immutable" });
        expect((await readReceipt()).rows).toEqual(originalReceipt);
        expect((await readAudit()).rows).toEqual(originalAudit);
    }
    expect((await observer.pool.query('SELECT disabled,moderation_version FROM canvas_saas."user" WHERE id=$1', [target.actorId])).rows)
        .toEqual([{ disabled: true, moderation_version: 1 }]);
}, 30_000);

pgTest("two administrators banning each other use one user lock order without deadlock or partial writes", async () => {
    const a = await seed("cross-a"), b = await seed("cross-b"), jobs: ReturnType<typeof pending>[] = [];
    await blocker.query("BEGIN");
    try {
        await blocker.query('SELECT id FROM canvas_saas."user" WHERE id=$1 FOR UPDATE', [a.actorId]);
        jobs.push(pending(() => setAccountModeration(first.db, b.actorId, input(), a)));
        const blockedA = await waitBlocked("first", jobs[0]!);
        expect(blockedA.blockers).toContain(blockerPid);
        jobs.push(pending(() => setAccountModeration(second.db, a.actorId, input(), b)));
        const blockedB = await waitBlocked("second", jobs[1]!);
        expect(blockedB.blockers.length).toBeGreaterThan(0);
        await blocker.query("ROLLBACK");
        expect(await Promise.all(jobs.map(job => job.result))).toEqual([{ ok: true, revision: 1 }, { ok: false, code: "account_changed" }]);
        const states = (await observer.pool.query('SELECT id,disabled,moderation_version FROM canvas_saas."user" WHERE id=ANY($1::text[]) ORDER BY id', [[a.actorId, b.actorId]])).rows;
        expect(states).toEqual([{ id: a.actorId, disabled: false, moderation_version: 0 }, { id: b.actorId, disabled: true, moderation_version: 1 }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.account_moderation_operation WHERE actor_id=ANY($1::text[])", [[a.actorId, b.actorId]])).rows).toEqual([{ count: 1 }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.audit_event WHERE actor_id=ANY($1::text[])", [[a.actorId, b.actorId]])).rows).toEqual([{ count: 1 }]);
        console.log(JSON.stringify({ case: "q1_cross_admin", blockerPid, first: blockedA, second: blockedB, result: "one_commit_one_revoked" }));
    } finally { await blocker.query("ROLLBACK"); await Promise.allSettled(jobs.map(job => job.result)); }
}, 30_000);

pgTest("an administrator revoked while waiting on a target cannot commit after the wait", async () => {
    const actor = await seed("wait-a"), target = await seed("wait-z", "user");
    let job: ReturnType<typeof pending> | undefined;
    await blocker.query("BEGIN");
    try {
        await blocker.query('SELECT id FROM canvas_saas."user" WHERE id=$1 FOR UPDATE', [target.actorId]);
        job = pending(() => setAccountModeration(first.db, target.actorId, input(), actor));
        const blocked = await waitBlocked("first", job);
        expect(blocked.blockers).toContain(blockerPid);
        await second.pool.query("DELETE FROM canvas_saas.session WHERE id=$1", [actor.sessionId]);
        await blocker.query("ROLLBACK");
        expect(await job.result).toEqual({ ok: false, code: "account_changed" });
        expect((await observer.pool.query('SELECT disabled,moderation_version FROM canvas_saas."user" WHERE id=$1', [target.actorId])).rows)
            .toEqual([{ disabled: false, moderation_version: 0 }]);
        expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.account_moderation_operation WHERE target_user_id=$1", [target.actorId])).rows).toEqual([{ count: 0 }]);
        console.log(JSON.stringify({ case: "q1_revoked_waiter", blockerPid, blocked, result: "rejected_no_write" }));
    } finally { await blocker.query("ROLLBACK"); if (job) await Promise.allSettled([job.result]); }
}, 30_000);

/** Test barrier before the real adapter INSERT, after the actual auth hook read. */
function delayedSessionDatabase(db: Database, gate: (data: Record<string, unknown>) => Promise<void>): Database {
    return new Proxy(db, { get(target, key) {
        if (key === "transaction") return (callback: (tx: Database) => Promise<unknown>, ...args: unknown[]) =>
            Reflect.apply(target.transaction, target, [(tx: Database) => callback(delayedSessionDatabase(tx, gate)), ...args]);
        if (key === "insert") return (table: unknown) => {
            const builder = Reflect.apply(target.insert, target, [table]);
            return new Proxy(builder, { get(builder, key) {
                if (key === "values") return (...values: unknown[]) => {
                    const query = Reflect.apply(builder.values, builder, values);
                    if (table !== session) return query;
                    return new Proxy(query, { get(query, key) {
                        if (key === "returning") return async (...args: unknown[]) => {
                            await gate(values[0] as Record<string, unknown>);
                            return Reflect.apply(query.returning, query, args);
                        };
                        const value = Reflect.get(query, key, query);
                        return typeof value === "function" ? value.bind(query) : value;
                    } });
                };
                const value = Reflect.get(builder, key, builder);
                return typeof value === "function" ? value.bind(builder) : value;
            } });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
    } });
}

pgTest("a real login delayed after its version read stays invalid after ban and unban", async () => {
    const actor = await seed("login-admin"), origin = "http://localhost:4000", password = "synthetic-q1-login-password";
    const email = `late-${crypto.randomUUID()}@example.test`;
    let release!: () => void, entered!: () => void, delay = false, capturedVersion: unknown;
    const waiting = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const auth = createAuth({ database: delayedSessionDatabase(second.db, async data => {
        if (!delay) return;
        capturedVersion = data.moderationVersion; entered(); await waiting;
    }), baseURL: origin, secret: crypto.randomUUID() + crypto.randomUUID(), sendVerificationEmail: async () => {}, sendResetPassword: async () => {} });
    const request = (path: string, body: unknown) => auth.handler(new Request(`${origin}/api/auth${path}`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await request("/sign-up/email", { name: "合成迟到登录", email, password })).status).toBe(200);
    const [target] = await observer.db.select().from(user).where(eq(user.email, email));
    await observer.db.update(user).set({ emailVerified: true }).where(eq(user.id, target.id));
    delay = true;
    const pendingLogin = request("/sign-in/email", { email, password });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([reached, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("未到达真实登录INSERT屏障")), 5_000); })]);
        clearTimeout(deadline);
        expect(capturedVersion).toBe(0);
        await setAccountModeration(first.db, target.id, input(true, 0), actor);
        await setAccountModeration(first.db, target.id, input(false, 1), actor);
        delay = false; release();
        const result = await pendingLogin;
        expect(result.status).toBe(200);
        const cookie = result.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
        expect((await observer.pool.query("SELECT moderation_version FROM canvas_saas.session WHERE user_id=$1", [target.id])).rows)
            .toEqual([{ moderation_version: 0 }]);
        const denied = await getPrincipal(auth, new Headers({ cookie }));
        expect(denied.principal).toBeNull(); expect(denied.headers.getSetCookie()).toHaveLength(0);
        const fresh = await request("/sign-in/email", { email, password });
        const freshCookie = fresh.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
        expect((await getPrincipal(auth, new Headers({ cookie: freshCookie }))).sessionContext?.moderationVersion).toBe(2);
        console.log(JSON.stringify({ case: "q1_late_login", capturedVersion, currentVersion: 2, result: "old_rejected_fresh_accepted" }));
    } finally { clearTimeout(deadline); delay = false; release(); await pendingLogin; }
}, 30_000);
