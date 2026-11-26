import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { paymentOrder, session, user, walletLedger } from "@infinite-canvas/database/schema";
import { createPaymentRepository, type PaymentActor, type PaymentOfferWrite } from "../../../packages/database/src/payments";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { normalizeZpayOrderQuery } from "../src/payment-provider-order-query";
import { parseZpayPaymentNotification, type ZpayExpectedOrder, type ZpayNotificationResult } from "../src/payment-provider-notification";
import { validatePaymentJson } from "../src/payment-provider-json";
import { checkPaymentDatabaseReadiness, checkVideoDatabaseReadiness } from "../src/readiness";
import type { PaymentPostgresMarker } from "./payment-postgres-runner";
import type { JsonObject } from "@infinite-canvas/shared";

const incomingUrl = process.env.SAAS_TEST_DATABASE_URL, markerFile = process.env.SAAS_PAYMENTS_Z1_CLUSTER_MARKER;
const allowed = new Set(["SAAS_TEST_DATABASE_URL", "SAAS_PAYMENTS_Z1_CLUSTER_MARKER"]);
const foreign = Object.keys(process.env).filter(name => !allowed.has(name) &&
    /(?:^|_)DATABASE_URL$|^PG|^SAAS_POSTGRES_|^SAAS_TEST_|^SAAS_PAYMENTS_|^CANVAS_ACCEPTANCE_|^NODE_(?:PATH|OPTIONS)$|^BUN_(?:OPTIONS|PRELOAD|CONFIG_|INSTALL$)/i.test(name));
if (foreign.length) throw new Error("payment_pg_external_environment_rejected");
if ((incomingUrl === undefined) !== (markerFile === undefined) || incomingUrl === "" || markerFile === "") throw new Error("payment_pg_url_marker_pair_required");

type Connection = ReturnType<typeof createDatabase>;
type Order = typeof paymentOrder.$inferSelect;
type Proof = { notificationEventId: string; queryEventId: string };
const samePath = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const safeCode = (error: unknown): string => {
    if (!error || typeof error !== "object") return "unclassified";
    const value = error as { code?: unknown; cause?: unknown };
    return typeof value.code === "string" && /^[A-Za-z0-9_]+$/.test(value.code) ? value.code : value.cause ? safeCode(value.cause) : "unclassified";
};
async function rejected(operation: Promise<unknown>) {
    try { await operation; } catch (error) { return safeCode(error); }
    throw new Error("expected_payment_operation_rejection");
}
const identitySql = `SELECT host(inet_server_addr()) AS host, inet_server_port() AS port, current_database() AS database,
    current_user AS role, current_setting('server_version_num') AS server_version_num, current_setting('cluster_name') AS cluster_name,
    pg_postmaster_start_time()::text AS postmaster_start, extract(epoch FROM pg_postmaster_start_time())::text AS postmaster_start_epoch,
    current_setting('application_name') AS application_name,
    (SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS restricted`;

(incomingUrl === undefined ? describe.skip : describe)("payments on the runner's fresh, identity-bound PostgreSQL 16", () => {
    let marker: PaymentPostgresMarker | undefined, first: Connection, second: Connection, observer: Connection;
    const connections: Connection[] = [], poolErrors: string[] = [], evidence: JsonObject[] = [];
    const secret = crypto.randomUUID() + crypto.randomUUID(), originalMerchantKey = `synthetic-${crypto.randomUUID()}`;
    let actor: PaymentActor, offerVersionId: string, offerId: string;
    let firstName: string, secondName: string;
    const repo = () => createPaymentRepository(first.db, secret);
    const purse = () => createWalletRepository(first.db);

    async function verifyTarget(connection: Connection, expected: PaymentPostgresMarker, applicationName: string) {
        const actual = (await connection.pool.query(identitySql)).rows[0];
        if (!actual || actual.host !== "127.0.0.1" || actual.port !== expected.port || actual.database !== "canvas_payments_z1" ||
            actual.role !== "canvas_payments_z1_app" || actual.server_version_num !== expected.serverVersionNum ||
            !/^16[0-9]{4}$/.test(actual.server_version_num) || actual.cluster_name !== expected.clusterName ||
            actual.postmaster_start !== expected.postmasterStart || actual.postmaster_start_epoch !== expected.postmasterStartEpoch ||
            actual.application_name !== applicationName || actual.restricted !== true) throw new Error("payment_pg_actual_identity_mismatch");
    }
    async function owner(label: string) {
        const id = crypto.randomUUID();
        await first.db.insert(user).values({ id, name: `合成${label}`, email: `${id}@example.test`, emailVerified: true });
        await purse().get(id);
        return id;
    }
    async function newOrder(ownerId?: string) {
        return (await repo().createOrder({ ownerId: ownerId ?? await owner("付款人"), offerVersionId, paymentType: "alipay", createKey: crypto.randomUUID() })).order;
    }
    function expected(order: Order): ZpayExpectedOrder {
        return { provider: "zpay", merchantId: order.merchantId, merchantOrderId: order.merchantOrderId, currency: "CNY",
            amountMinor: order.amountMinor, paymentType: order.paymentType, ...(order.providerTradeNo ? { providerTradeNo: order.providerTradeNo } : {}) };
    }
    function money(order: Order) {
        const amount = BigInt(order.amountMinor);
        return `${amount / BigInt(100)}.${(amount % BigInt(100)).toString().padStart(2, "0")}`;
    }
    async function notice(order: Order, trade: string, tradeStatus = "TRADE_SUCCESS") {
        const merchant = await repo().loadMerchant(order.merchantVersionId);
        if (!merchant) throw new Error("synthetic_merchant_missing");
        const fields = new Map(Object.entries({ pid: order.merchantId, name: order.productName, money: money(order),
            out_trade_no: order.merchantOrderId, trade_no: trade, trade_status: tradeStatus, type: order.paymentType, sign_type: "MD5" }));
        const material = [...fields].filter(([key, value]) => key !== "sign_type" && value !== "").sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, value]) => `${key}=${value}`).join("&");
        fields.set("sign", createHash("md5").update(material).update(merchant.merchantKey).digest("hex"));
        const raw = new URLSearchParams(fields).toString(), parsed = parseZpayPaymentNotification(raw, expected(order), merchant.merchantKey);
        if (!parsed.ok) throw new Error("synthetic_notification_invalid");
        return { raw, parsed };
    }
    function query(order: Order, trade: string, status: 0 | 1 | 2, notification?: ZpayNotificationResult) {
        const raw = JSON.stringify({ code: 1, status, pid: order.merchantId, out_trade_no: order.merchantOrderId,
            trade_no: trade, type: order.paymentType, money: money(order) });
        const uniqueness = validatePaymentJson(raw);
        if (!uniqueness.ok) throw new Error("synthetic_query_not_unique");
        return { result: normalizeZpayOrderQuery({ kind: "response", httpStatus: 200, redirected: false, complete: true, body: raw }, expected(order), notification),
            uniqueness: uniqueness.jsonMemberUniqueness };
    }
    async function proof(order: Order, trade = `trade_${crypto.randomUUID().replaceAll("-", "")}`): Promise<Proof> {
        const notification = await notice(order, trade), observation = query(order, trade, 1, notification.parsed);
        expect(observation.result.status).toBe("paid");
        const n = await repo().recordNotification(order.id, notification.parsed.notification, notification.raw, crypto.randomUUID());
        const q = await repo().recordQuery(order.id, observation.result, observation.uniqueness, crypto.randomUUID());
        return { notificationEventId: n.id, queryEventId: q.id };
    }
    async function funds(order: Order) {
        const [state, current, entries] = await Promise.all([
            observer.pool.query("SELECT provider_trade_no, credit_state, credited_ledger_id, payment_state, refund_state FROM canvas_saas.payment_order WHERE id=$1", [order.id]),
            observer.pool.query("SELECT available_units::text AS available, reserved_units::text AS reserved, version FROM canvas_saas.wallet WHERE user_id=$1", [order.ownerId]),
            observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.wallet_ledger WHERE kind='recharge' AND reference_type='payment_order' AND reference_id=$1", [order.id]),
        ]);
        return { ...state.rows[0], ...current.rows[0], rechargeCount: entries.rows[0].count };
    }
    // 5s is a test lock-observation budget, not a product timeout or retry policy.
    async function blocked(label: string, names: string[], blockerPid: number) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            const rows = (await observer.pool.query(`SELECT pid, application_name, pg_blocking_pids(pid) AS blockers,
                wait_event_type, wait_event FROM pg_stat_activity WHERE datname=current_database() AND application_name=ANY($1::text[])`, [names])).rows;
            const waits = rows.filter(row => Array.isArray(row.blockers) && row.blockers.length > 0);
            if (names.every(name => waits.some(row => row.application_name === name)) && waits.some(row => row.blockers.includes(blockerPid))) {
                expect(new Set([blockerPid, ...waits.map(row => row.pid)]).size).toBe(names.length + 1);
                evidence.push({ scenario: label, blockerPid, waits: waits.map(row => ({ pid: row.pid, applicationName: row.application_name,
                    blockingPids: row.blockers, waitEventType: row.wait_event_type, waitEvent: row.wait_event })), observedAt: new Date().toISOString() });
                return;
            }
            await Bun.sleep(20);
        }
        throw new Error("payment_pg_expected_lock_wait_not_observed");
    }

    beforeAll(async () => {
        try {
            if (process.platform !== "win32" || !markerFile || !incomingUrl || !isAbsolute(markerFile)) throw new Error("payment_pg_runner_required");
            const runParent = join(await realpath(tmpdir()), "canvas-payments-z1"), suppliedMarker = resolve(markerFile);
            if (!/^[A-Za-z]:[\\/]/.test(markerFile) || /[^\x20-\x7e]/.test(markerFile) || basename(suppliedMarker) !== "marker.json" ||
                !basename(dirname(suppliedMarker)).startsWith("run-") || !samePath(dirname(dirname(suppliedMarker)), runParent) ||
                !samePath(await realpath(suppliedMarker), suppliedMarker)) throw new Error("payment_pg_marker_location_rejected");
            const candidate: PaymentPostgresMarker = JSON.parse(await readFile(markerFile, "utf8"));
            if (candidate.kind !== "canvas-payments-z1-pg16" || candidate.status !== "identity-verified" || !uuid(candidate.runId) ||
                !isAbsolute(candidate.runDir) || /[^\x20-\x7e]/.test(candidate.runDir) || !samePath(markerFile, join(candidate.runDir, "marker.json")) ||
                !samePath(dirname(candidate.runDir), join(await realpath(tmpdir()), "canvas-payments-z1")) || !basename(candidate.runDir).startsWith("run-") ||
                !samePath(candidate.dataDir, join(candidate.runDir, "data")) || !samePath(await realpath(candidate.runDir), candidate.runDir) ||
                !samePath(await realpath(candidate.dataDir), candidate.dataDir) || candidate.host !== "127.0.0.1" ||
                candidate.database !== "canvas_payments_z1" || candidate.role !== "canvas_payments_z1_app" ||
                !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535 ||
                candidate.clusterName !== `canvas_payments_z1_${candidate.runId.replaceAll("-", "")}` || !/^16[0-9]{4}$/.test(candidate.serverVersionNum) ||
                !Number.isSafeInteger(candidate.postmasterPid) || !candidate.postmasterPid || candidate.postmasterPid < 1 ||
                !Number.isSafeInteger(candidate.postmasterPidStartSeconds) || !candidate.postmasterStart || !candidate.postmasterStartEpoch) throw new Error("payment_pg_marker_rejected");
            const target = new URL(incomingUrl);
            if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1" || Number(target.port) !== candidate.port ||
                target.username !== candidate.role || !target.password || target.pathname !== `/${candidate.database}` || target.search || target.hash) throw new Error("payment_pg_url_identity_mismatch");
            const postmaster = (await readFile(join(candidate.dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/);
            if (Number(postmaster[0]) !== candidate.postmasterPid || !samePath(postmaster[1] ?? "", candidate.dataDir) ||
                Number(postmaster[2]) !== candidate.postmasterPidStartSeconds || Number(postmaster[3]) !== candidate.port || postmaster[5] !== "127.0.0.1") throw new Error("payment_pg_postmaster_changed");
            const connect = (suffix: string, max: number) => {
                const url = new URL(incomingUrl), name = `payment_z1_${candidate.runId.replaceAll("-", "")}_${suffix}`;
                url.searchParams.set("application_name", name);
                const connection = createDatabase(url.toString());
                // A single backend per actor makes the observed wait graph unambiguous.
                connection.pool.options.max = max;
                connection.pool.on("error", () => { poolErrors.push(name); });
                connections.push(connection);
                return { connection, name };
            };
            const a = connect("first", 1), b = connect("second", 1), c = connect("observer", 3);
            first = a.connection; second = b.connection; observer = c.connection; firstName = a.name; secondName = b.name;
            await verifyTarget(first, candidate, a.name); await verifyTarget(second, candidate, b.name); await verifyTarget(observer, candidate, c.name);
            const fresh = (await observer.pool.query("SELECT to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_migrations') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh")).rows[0];
            if (fresh?.fresh !== true) throw new Error("payment_pg_fresh_application_schema_required");
            marker = candidate;
            await verifyTarget(first, candidate, a.name);
            await migrateDatabase(first.db);
            await verifyTarget(first, candidate, a.name);
            const before = (await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
            const journal = JSON.parse(await readFile(new URL("../../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8"));
            expect(before).toBe(journal.entries.length);
            await migrateDatabase(first.db);
            await verifyTarget(first, candidate, a.name);
            expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count).toBe(before);
            const readinessDatabase = { query: (text: string, values?: readonly unknown[]) => first.pool.query(text, values ? [...values] : undefined) };
            const paymentDatabaseReadiness = await checkPaymentDatabaseReadiness(readinessDatabase);
            const videoDatabaseReadiness = await checkVideoDatabaseReadiness(readinessDatabase);
            evidence.push({ scenario: "fresh_migrations", before: 0, after: before, repeated: before, serverVersionNum: candidate.serverVersionNum,
                clusterName: candidate.clusterName, postmasterPid: candidate.postmasterPid, paymentDatabaseReadiness, videoDatabaseReadiness });
            expect(paymentDatabaseReadiness).toBe(true);
            expect(videoDatabaseReadiness).toBe(true);
            const adminId = crypto.randomUUID(), sessionId = crypto.randomUUID(), expiresAt = new Date(Date.now() + 3_600_000);
            await first.db.insert(user).values({ id: adminId, name: "合成支付管理员", email: `${adminId}@example.test`, emailVerified: true, role: "admin" });
            await first.db.insert(session).values({ id: sessionId, userId: adminId, token: crypto.randomUUID(), expiresAt });
            actor = { actorId: adminId, sessionId, sessionExpiresAt: expiresAt, requestId: crypto.randomUUID() };
            expect((await repo().getSettings()).newOrdersEnabled).toBe(false);
            await repo().saveMerchant({ expectedRevision: 0, merchantId: "synthetic_z1_merchant", merchantKey: originalMerchantKey,
                paymentType: "alipay", productName: "合成充值测试" }, actor, "https://payments.example.test");
            offerVersionId = crypto.randomUUID(); offerId = crypto.randomUUID();
            await repo().saveOffers({ expectedRevision: 1, newOrdersEnabled: true, items: [{ id: offerVersionId, offerId, revision: 1,
                label: "仅隔离夹具", amountMinor: "1230", creditUnits: "0.006", policyReference: "synthetic" }] }, actor);
        } catch (error) {
            await Promise.allSettled(connections.map(connection => connection.close()));
            throw error;
        }
    }, 30_000);

    afterAll(async () => {
        try {
            if (marker) await writeFile(join(marker.runDir, "payment-component-evidence.json"), JSON.stringify({ kind: "payments-z1-pg16-components",
                runId: marker.runId, synthetic: true, httpAckLossCovered: false, poolErrors, scenarios: evidence }, null, 2) + "\n", { flag: "wx" });
        } finally { await Promise.allSettled(connections.map(connection => connection.close())); }
        expect(poolErrors).toEqual([]);
    });

    test("two genuinely blocked callback credit transactions commit one recharge", async () => {
        const order = await newOrder(), verified = await proof(order), blocker = await observer.pool.connect();
        let results: PromiseSettledResult<Awaited<ReturnType<ReturnType<typeof createWalletRepository>["rechargePaymentOrder"]>>>[] = [];
        try {
            await blocker.query("BEGIN");
            const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await blocker.query("SELECT id FROM canvas_saas.payment_order WHERE id=$1 FOR UPDATE", [order.id]);
            const pending = Promise.allSettled([purse().rechargePaymentOrder(order.id, verified), createWalletRepository(second.db).rechargePaymentOrder(order.id, verified)]);
            try { await blocked("duplicate_callback_order_lock", [firstName, secondName], pid); }
            finally { await blocker.query("ROLLBACK"); results = await pending; }
        } finally { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); }
        expect(results.every(result => result.status === "fulfilled")).toBe(true);
        const values = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
        expect(values.filter(value => value.credited)).toHaveLength(1);
        expect(new Set(values.map(value => value.ledgerId)).size).toBe(1);
        expect(await funds(order)).toMatchObject({ available: "0.006", reserved: "0", rechargeCount: 1, credit_state: "credited" });
    }, 30_000);

    test("two users compete for one merchant transaction through an actual unique-index wait", async () => {
        const left = await newOrder(), current = await repo().getSettings(), original = await repo().loadMerchant(left.merchantVersionId);
        if (!original) throw new Error("synthetic_merchant_missing");
        await repo().saveMerchant({ expectedRevision: current.revision, merchantId: original.merchantId, merchantKey: original.merchantKey,
            paymentType: original.paymentType, productName: original.productName }, actor, "https://payments.example.test");
        const right = await newOrder(), a = await repo().claimCreate(left.id), b = await createPaymentRepository(second.db, secret).claimCreate(right.id);
        expect(left.ownerId).not.toBe(right.ownerId); expect(left.merchantVersionId).not.toBe(right.merchantVersionId);
        expect(left.merchantId).toBe(right.merchantId);
        if (!a || !b) throw new Error("synthetic_create_claim_missing");
        const trade = `shared_${crypto.randomUUID().replaceAll("-", "")}`;
        let started!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
        let firstPid = 0;
        const one = first.db.transaction(async tx => {
            firstPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
            const saved = await createPaymentRepository(tx, secret).updateCreate(left.id, a.token, { status: "accepted", providerTradeNo: trade, paymentLinks: {} });
            started(); await gate; return saved;
        });
        const firstObserved = one.then(() => { throw new Error("synthetic_transaction_gate_not_held"); });
        firstObserved.catch(() => {});
        let outcomes: PromiseSettledResult<Order>[] = [];
        try {
            await Promise.race([ready, firstObserved]);
            const two = createPaymentRepository(second.db, secret).updateCreate(right.id, b.token, { status: "accepted", providerTradeNo: trade, paymentLinks: {} });
            const pending = Promise.allSettled([one, two]);
            try { await blocked("cross_user_merchant_transaction_unique", [secondName], firstPid); }
            finally { release(); outcomes = await pending; }
        } finally { release(); await Promise.allSettled([one]); }
        expect(outcomes).toHaveLength(2); expect(outcomes.every(result => result.status === "fulfilled")).toBe(true);
        expect(await repo().getOrder(left.id)).toMatchObject({ providerTradeNo: trade, createState: "accepted", creditState: "pending" });
        expect(await repo().getOrder(right.id)).toMatchObject({ providerTradeNo: null, createState: "unknown", lastReason: "provider_trade_conflict", creditState: "pending" });
        expect((await funds(left)).rechargeCount + (await funds(right)).rechargeCount).toBe(0);
    }, 30_000);

    test("unknown and unpaid observations do not consume success; late observations cannot undo paid", async () => {
        const order = await newOrder(), trade = `ordered_${crypto.randomUUID().replaceAll("-", "")}`;
        const unknown = query(order, trade, 2), unpaid = query(order, trade, 0);
        await repo().recordQuery(order.id, unknown.result, unknown.uniqueness, crypto.randomUUID());
        await repo().recordQuery(order.id, unpaid.result, unpaid.uniqueness, crypto.randomUUID());
        const unrecognized = await notice(order, trade, "WAIT_BUYER_PAY");
        expect((await repo().recordNotification(order.id, unrecognized.parsed.notification, unrecognized.raw, crypto.randomUUID())).outcome).toBe("unrecognized_status");
        expect(await repo().recentSuccessfulNotification(order.id)).toBeNull();
        const verified = await proof(order, trade), credited = await purse().rechargePaymentOrder(order.id, verified);
        expect(credited.credited).toBe(true);
        await repo().recordQuery(order.id, unpaid.result, unpaid.uniqueness, crypto.randomUUID());
        await repo().recordQuery(order.id, unknown.result, unknown.uniqueness, crypto.randomUUID());
        expect(await funds(order)).toMatchObject({ payment_state: "paid", credit_state: "credited", rechargeCount: 1, available: "0.006" });
        const queryOnly = await newOrder(), observation = query(queryOnly, `queryonly_${crypto.randomUUID().replaceAll("-", "")}`, 1);
        const event = await repo().recordQuery(queryOnly.id, observation.result, observation.uniqueness, crypto.randomUUID());
        expect(await rejected(purse().rechargePaymentOrder(queryOnly.id, { notificationEventId: crypto.randomUUID(), queryEventId: event.id }))).toBe("payment_not_verified");
        expect(await funds(queryOnly)).toMatchObject({ provider_trade_no: null, credit_state: "pending", rechargeCount: 0, available: "0", reserved: "0" });
    }, 30_000);

    test("recharge and an existing wallet reservation both wait and preserve exact balances", async () => {
        const ownerId = await owner("钱包竞争"), seed = await newOrder(ownerId), seedProof = await proof(seed);
        await purse().rechargePaymentOrder(seed.id, seedProof);
        const order = await newOrder(ownerId), verified = await proof(order), blocker = await observer.pool.connect();
        try {
            await blocker.query("BEGIN");
            const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await blocker.query("SELECT user_id FROM canvas_saas.wallet WHERE user_id=$1 FOR UPDATE", [ownerId]);
            const pending = Promise.allSettled([purse().rechargePaymentOrder(order.id, verified), createWalletRepository(second.db).reserve({ userId: ownerId,
                requestedUnits: "0.002", idempotencyKey: crypto.randomUUID() })]);
            let results: PromiseSettledResult<unknown>[] = [];
            try { await blocked("wallet_recharge_reserve_lock", [firstName, secondName], pid); }
            finally { await blocker.query("ROLLBACK"); results = await pending; }
            expect(results).toHaveLength(2); expect(results.every(result => result.status === "fulfilled")).toBe(true);
        } finally { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); }
        expect(await purse().get(ownerId)).toMatchObject({ availableUnits: "0.01", reservedUnits: "0.002", totalUnits: "0.012", version: 4 });
        expect((await observer.pool.query("SELECT kind,count(*)::int AS count FROM canvas_saas.wallet_ledger WHERE user_id=$1 GROUP BY kind ORDER BY kind", [ownerId])).rows)
            .toEqual([{ kind: "recharge", count: 2 }, { kind: "reserve", count: 1 }]);
    }, 30_000);

    test("binding, wallet, ledger, final-order and deferred-COMMIT faults leave no partial recharge", async () => {
        for (const phase of ["binding", "wallet", "ledger", "credited_order", "commit"] as const) {
            const order = await newOrder(), verified = await proof(order), before = await funds(order);
            const table = phase === "wallet" ? "wallet" : phase === "ledger" ? "wallet_ledger" : "payment_order";
            const condition = phase === "wallet" ? `NEW.user_id = '${order.ownerId}'` : phase === "ledger" ? `NEW.reference_id = '${order.id}' AND NEW.kind = 'recharge'`
                : phase === "binding" ? `NEW.id = '${order.id}' AND OLD.provider_trade_no IS NULL AND NEW.provider_trade_no IS NOT NULL`
                : `NEW.id = '${order.id}' AND NEW.credit_state = 'credited'`;
            const trigger = phase === "commit" ? `CREATE CONSTRAINT TRIGGER z1_payment_fault AFTER UPDATE ON canvas_saas.${table} DEFERRABLE INITIALLY DEFERRED`
                : `CREATE TRIGGER z1_payment_fault BEFORE ${phase === "ledger" ? "INSERT" : "UPDATE"} ON canvas_saas.${table}`;
            await first.pool.query(`CREATE FUNCTION canvas_saas.z1_payment_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_payment_fault'; END; $$;
                ${trigger} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION canvas_saas.z1_payment_fault()`);
            let failure = "";
            try { failure = await rejected(purse().rechargePaymentOrder(order.id, verified)); }
            finally { await first.pool.query(`DROP TRIGGER z1_payment_fault ON canvas_saas.${table}; DROP FUNCTION canvas_saas.z1_payment_fault()`); }
            expect(failure).toBe("P0001");
            expect(await funds(order)).toMatchObject({ provider_trade_no: null, credit_state: "pending", credited_ledger_id: null,
                available: before.available, reserved: before.reserved, version: before.version, rechargeCount: 0 });
            expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.payment_event WHERE order_id=$1", [order.id])).rows[0].count).toBe(2);
            evidence.push({ scenario: "atomic_fault", phase, errorCode: failure, tradeBinding: null, rechargeCount: 0, committed: false });
        }
    }, 30_000);

    test("a real commit with a lost application acknowledgement replays its original ledger", async () => {
        const order = await newOrder(), verified = await proof(order);
        let loseAcknowledgement = true;
        const transaction: Database["transaction"] = async (work, config) => {
            const result = await first.db.transaction(work, config);
            if (loseAcknowledgement) { loseAcknowledgement = false; throw Object.assign(new Error("synthetic_commit_ack_lost"), { code: "synthetic_commit_ack_lost" }); }
            return result;
        };
        const unknownClient = new Proxy(first.db, { get: (target, property) => property === "transaction" ? transaction : Reflect.get(target, property, target) });
        expect(await rejected(createWalletRepository(unknownClient).rechargePaymentOrder(order.id, verified))).toBe("synthetic_commit_ack_lost");
        const committed = await funds(order);
        expect(committed).toMatchObject({ credit_state: "credited", rechargeCount: 1, available: "0.006", reserved: "0" });
        const replay = await purse().rechargePaymentOrder(order.id, verified);
        expect(replay.credited).toBe(false); expect(replay.ledgerId).toBe(committed.credited_ledger_id);
        expect((await funds(order)).rechargeCount).toBe(1);
        evidence.push({ scenario: "commit_ack_lost", committed: true, applicationOutcome: "unknown", replayCredited: false, rechargeCount: 1, httpAckLossCovered: false });
        await first.pool.query("UPDATE canvas_saas.payment_order SET refund_state='refunded' WHERE id=$1", [order.id]);
        expect(await rejected(purse().rechargePaymentOrder(order.id, verified))).toBe("payment_not_verified");
        expect(await funds(order)).toMatchObject({ refund_state: "refunded", available: "0.006", rechargeCount: 1 });
        evidence.push({ scenario: "synthetic_refund_state_guard", actualCashRefund: false, repeatedRecharge: false });
    }, 30_000);

    test("SQL guards reject mutable cash/owner/evidence and wrong recharge associations; numeric money is refused", async () => {
        const order = await newOrder(), other = await owner("错误归属"), verified = await proof(order);
        for (const [column, value] of [["amount_minor", "1231"], ["credit_units", "0.007"], ["owner_id", other]] as const) {
            expect(await rejected(first.pool.query(`UPDATE canvas_saas.payment_order SET ${column}=$1 WHERE id=$2`, [value, order.id]))).toBe("P0001");
        }
        expect(await rejected(first.pool.query("UPDATE canvas_saas.payment_event SET evidence='{}'::jsonb WHERE id=$1", [verified.notificationEventId]))).toBe("P0001");
        expect(await rejected(first.pool.query("DELETE FROM canvas_saas.payment_event WHERE id=$1", [verified.queryEventId]))).toBe("P0001");
        const config = await repo().getSettings();
        const base = { id: crypto.randomUUID(), offerId: crypto.randomUUID(), revision: 1, label: "非法数字夹具", amountMinor: "1230", creditUnits: "0.006", policyReference: "synthetic" };
        for (const patch of [{ amountMinor: 1230 }, { creditUnits: 0.006 }]) {
            const item = { ...base, ...patch } as unknown as PaymentOfferWrite;
            expect(await rejected(repo().saveOffers({ expectedRevision: config.revision, items: [item], newOrdersEnabled: true }, actor))).toBe("payment_invalid");
        }
        const signed = await notice(order, `numeric_${crypto.randomUUID().replaceAll("-", "")}`);
        expect(await rejected(repo().recordNotification(order.id, { ...signed.parsed.notification, amountMinor: 1230 }, signed.raw, crypto.randomUUID()))).toBe("payment_evidence_conflict");
        expect(await repo().getForOwner(other, order.id)).toBeNull(); expect(await repo().getByKey(other, order.createKey)).toBeNull();
        for (const mismatch of ["owner", "amount"] as const) {
            const target = await newOrder(), pair = await proof(target), trade = (await repo().recentSuccessfulNotification(target.id))!.evidence.providerTradeNo;
            const ledgerId = crypto.randomUUID();
            const failure = await rejected(first.db.transaction(async tx => {
                await tx.update(paymentOrder).set({ providerTradeNo: String(trade), paymentState: "paid" }).where(eq(paymentOrder.id, target.id));
                await tx.insert(walletLedger).values({ id: ledgerId, userId: mismatch === "owner" ? other : target.ownerId, kind: "recharge",
                    deltaAvailableUnits: mismatch === "amount" ? "0.007" : "0.006", deltaReservedUnits: "0", availableUnitsAfter: "0.006", reservedUnitsAfter: "0",
                    idempotencyKey: `payment:${target.id}:recharge`, referenceType: "payment_order", referenceId: target.id,
                    metadata: { notificationEventId: pair.notificationEventId, queryEventId: pair.queryEventId } });
                await tx.update(paymentOrder).set({ creditState: "credited", creditedLedgerId: ledgerId, creditedAt: new Date() }).where(eq(paymentOrder.id, target.id));
            }));
            expect(failure).toBe("P0001"); expect(await funds(target)).toMatchObject({ provider_trade_no: null, credit_state: "pending", rechargeCount: 0, available: "0" });
        }
        await purse().rechargePaymentOrder(order.id, verified);
        const ledger = (await first.db.select().from(walletLedger).where(and(eq(walletLedger.referenceType, "payment_order"), eq(walletLedger.referenceId, order.id))))[0];
        expect(await rejected(first.db.insert(walletLedger).values({ ...ledger, id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }))).toBe("23505");
        expect(await rejected(first.pool.query("UPDATE canvas_saas.wallet_ledger SET delta_available_units=0 WHERE id=$1", [ledger.id]))).toBe("P0001");
        evidence.push({ scenario: "sql_and_string_boundaries", exactStringsRequired: true, ownerAndAmountMismatchRejected: true, duplicateOrderLedgerRejected: true });
    }, 30_000);

    test("new immutable configuration does not change an old order or its original verification key", async () => {
        const order = await newOrder(), original = await repo().loadMerchant(order.merchantVersionId);
        if (!original) throw new Error("synthetic_original_merchant_missing");
        const current = await repo().getSettings(), rotated = await repo().saveMerchant({ expectedRevision: current.revision,
            merchantId: original.merchantId, merchantKey: `rotated-synthetic-${crypto.randomUUID()}`, paymentType: "alipay", productName: "合成新版本" }, actor, "https://payments.example.test");
        const newVersion = crypto.randomUUID();
        await repo().saveOffers({ expectedRevision: rotated.settings.revision, newOrdersEnabled: false, items: [{ id: newVersion, offerId, revision: 2,
            label: "合成第二版", amountMinor: "1230", creditUnits: "0.006", policyReference: "synthetic" }] }, actor);
        expect((await repo().loadMerchant(order.merchantVersionId))!.merchantKey).toBe(originalMerchantKey);
        expect((await repo().getOrder(order.id))!.merchantVersionId).toBe(order.merchantVersionId);
        expect((await repo().createOrder({ ownerId: order.ownerId, offerVersionId: order.offerVersionId, paymentType: order.paymentType, createKey: order.createKey })).created).toBe(false);
        expect(await rejected(repo().createOrder({ ownerId: order.ownerId, offerVersionId: newVersion, paymentType: "alipay", createKey: crypto.randomUUID() }))).toBe("payment_unavailable");
        expect(await rejected(first.pool.query("UPDATE canvas_saas.payment_offer_version SET label='changed' WHERE id=$1", [order.offerVersionId]))).toBe("P0001");
        expect(await rejected(first.pool.query("UPDATE canvas_saas.payment_merchant_version SET product_name='changed' WHERE id=$1", [order.merchantVersionId]))).toBe("P0001");
        const verified = await proof(order);
        expect((await purse().rechargePaymentOrder(order.id, verified)).credited).toBe(true);
        evidence.push({ scenario: "old_configuration_late_payment", newOrdersEnabled: false, originalCredentialRetained: true, originalOrderCreditedOnce: true });
    }, 30_000);
});
