import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { createWalletRepository, WalletOperationError, type WalletReservationView } from "@infinite-canvas/database/wallet";
import { postgresTestUrl } from "../../../apps/api/test/database";

const testUrl = postgresTestUrl();
if (!testUrl || process.env.DATABASE_URL || process.env.SAAS_POSTGRES_TEST_SUITE !== "decimal-wallet") {
    throw new Error("请仅通过 test:postgres --decimal-wallet 的全新隔离数据库运行");
}
const prefix = `wallet-race-${crypto.randomUUID()}`;
function connection(label: string) {
    const url = new URL(testUrl!);
    url.searchParams.set("application_name", `${prefix}-${label}`);
    // Reuse the existing isolated PostgreSQL test deadline, not a product timeout.
    url.searchParams.set("statement_timeout", "30000");
    return createDatabase(url.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const firstWallet = createWalletRepository(first.db), secondWallet = createWalletRepository(second.db);
const blocker = new Client({ connectionString: testUrl, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
let blockerConnected = false, blockerPid: number;

beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows).toEqual([{ count: 28 }]);
    await blocker.connect(); blockerConnected = true;
    blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}, 30_000);
afterAll(async () => {
    try { if (blockerConnected) await blocker.query("ROLLBACK"); }
    finally {
        const closed = await Promise.allSettled([blocker.end(), first.close(), second.close(), observer.close()]);
        if (closed.some((entry) => entry.status === "rejected")) throw new Error("An isolated wallet database connection did not close cleanly");
    }
});

async function owner(balance = "0.006") {
    const id = crypto.randomUUID();
    await observer.pool.query('INSERT INTO canvas_saas."user" (id,name,email) VALUES ($1,$2,$3)', [id, "Synthetic concurrent wallet", `${id}@example.test`]);
    await observer.pool.query("INSERT INTO canvas_saas.wallet (user_id,available_units) VALUES ($1,$2::numeric)", [id, balance]);
    return id;
}
type Outcome = { value: WalletReservationView } | { error: unknown };
type Pending = { settled: boolean; result: Promise<Outcome> };
function begin(operation: () => Promise<WalletReservationView>): Pending {
    const pending: Pending = { settled: false, result: Promise.resolve({ error: "not started" }) };
    pending.result = operation().then((value) => { pending.settled = true; return { value }; }, (error: unknown) => {
        pending.settled = true; return { error };
    });
    return pending;
}
async function blockedPid(label: "first" | "second", expectedBlockers: number[], pending: Pending): Promise<number> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (pending.settled) throw new Error("Wallet operation completed before the expected row-lock wait");
        const { rows } = await observer.pool.query<{ pid: number; blockers: number[] }>(
            "SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [`${prefix}-${label}`]);
        const row = rows.find((entry) => entry.blockers.some((pid) => expectedBlockers.includes(pid)));
        if (row) return row.pid;
        await Bun.sleep(10);
    }
    throw new Error("The expected wallet row-lock relationship was not observed");
}
async function compete(userId: string, a: () => Promise<WalletReservationView>, b: () => Promise<WalletReservationView>): Promise<Outcome[]> {
    const pending: Pending[] = []; let locked = false;
    try {
        await blocker.query("BEGIN"); locked = true;
        expect((await blocker.query("SELECT user_id FROM canvas_saas.wallet WHERE user_id=$1 FOR UPDATE", [userId])).rowCount).toBe(1);
        pending.push(begin(a));
        const firstPid = await blockedPid("first", [blockerPid], pending[0]!);
        pending.push(begin(b));
        const secondPid = await blockedPid("second", [blockerPid, firstPid], pending[1]!);
        expect(new Set([blockerPid, firstPid, secondPid]).size).toBe(3);
        expect(pending.every((entry) => !entry.settled)).toBe(true);
        await blocker.query("ROLLBACK"); locked = false;
        return await Promise.all(pending.map((entry) => entry.result));
    } finally {
        try { if (locked) await blocker.query("ROLLBACK"); }
        finally { await Promise.allSettled(pending.map((entry) => entry.result)); }
    }
}
async function counts(userId: string) {
    return (await observer.pool.query(`SELECT (SELECT count(*)::int FROM canvas_saas.wallet_reservation WHERE user_id=$1) AS reservations,
        (SELECT count(*)::int FROM canvas_saas.wallet_ledger WHERE user_id=$1) AS ledger`, [userId])).rows[0];
}

test("two real connections cannot overspend a fractional balance after observed wallet lock waits", async () => {
    const userId = await owner();
    const outcomes = await compete(userId,
        () => firstWallet.reserve({ userId, requestedUnits: "0.004", idempotencyKey: "first" }),
        () => secondWallet.reserve({ userId, requestedUnits: "0.004", idempotencyKey: "second" }));
    expect(outcomes.filter((entry) => "value" in entry)).toHaveLength(1);
    const rejected = outcomes.find((entry) => "error" in entry);
    expect(rejected && "error" in rejected ? rejected.error : null).toBeInstanceOf(WalletOperationError);
    expect(rejected && "error" in rejected ? rejected.error : null).toMatchObject({ code: "insufficient_balance" });
    expect(await firstWallet.get(userId)).toMatchObject({ availableUnits: "0.002", reservedUnits: "0.004", version: 2 });
    expect(await counts(userId)).toEqual({ reservations: 1, ledger: 1 });
}, 30_000);

test("concurrent identical reservation keys create exactly one fractional reserve and ledger entry", async () => {
    const userId = await owner(), input = { userId, requestedUnits: "0.004", idempotencyKey: "same-reserve" };
    const outcomes = await compete(userId, () => firstWallet.reserve(input), () => secondWallet.reserve({ ...input, requestedUnits: "0.004000" }));
    expect(outcomes.every((entry) => "value" in entry)).toBe(true);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(await firstWallet.get(userId)).toMatchObject({ availableUnits: "0.002", reservedUnits: "0.004", version: 2 });
    expect(await counts(userId)).toEqual({ reservations: 1, ledger: 1 });
}, 30_000);

for (const operation of ["capture", "release"] as const) test(`concurrent ${operation} with task references changes funds once`, async () => {
    const userId = await owner(), taskId = crypto.randomUUID();
    const reservation = await firstWallet.reserve({ userId, requestedUnits: "0.004", taskId, idempotencyKey: "reserve" });
    const input = { userId, reservationId: reservation.id, idempotencyKey: "settle", referenceType: "generation", referenceId: taskId };
    const settle = (repository: ReturnType<typeof createWalletRepository>) => operation === "capture"
        ? repository.capture({ ...input, capturedUnits: "0.004" }) : repository.release({ ...input, releasedUnits: "0.004" });
    const outcomes = await compete(userId, () => settle(firstWallet), () => settle(secondWallet));
    expect(outcomes.every((entry) => "value" in entry)).toBe(true); expect(outcomes[0]).toEqual(outcomes[1]);
    expect(await firstWallet.get(userId)).toMatchObject({ availableUnits: operation === "capture" ? "0.002" : "0.006", reservedUnits: "0", version: 3 });
    expect(await counts(userId)).toEqual({ reservations: 1, ledger: 2 });
}, 30_000);
