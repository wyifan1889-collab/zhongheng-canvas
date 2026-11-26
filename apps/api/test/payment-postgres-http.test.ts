import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createAuth, getPrincipal } from "@infinite-canvas/auth";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { paymentOrder, session, user } from "@infinite-canvas/database/schema";
import { createPaymentRepository, type PaymentActor } from "../../../packages/database/src/payments";
import { createAccountApi } from "../src/accounts";
import type { PaymentPostgresMarker } from "./payment-postgres-runner";

const incomingUrl = process.env.SAAS_TEST_DATABASE_URL, markerFile = process.env.SAAS_PAYMENTS_Z1_CLUSTER_MARKER;
const allowed = new Set(["SAAS_TEST_DATABASE_URL", "SAAS_PAYMENTS_Z1_CLUSTER_MARKER"]);
const foreign = Object.keys(process.env).filter(name => !allowed.has(name) &&
    /(?:^|_)DATABASE_URL$|^PG|^SAAS_POSTGRES_|^SAAS_TEST_|^SAAS_PAYMENTS_|^CANVAS_ACCEPTANCE_|^NODE_(?:PATH|OPTIONS)$|^BUN_(?:OPTIONS|PRELOAD|CONFIG_|INSTALL$)/i.test(name));
if (foreign.length) throw new Error("payment_http_external_environment_rejected");
if ((incomingUrl === undefined) !== (markerFile === undefined) || incomingUrl === "" || markerFile === "") throw new Error("payment_http_url_marker_pair_required");
const samePath = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const safeCode = (error: unknown): string => {
    const value = error as { code?: unknown; cause?: unknown } | null;
    return typeof value?.code === "string" && /^[A-Za-z0-9_]+$/.test(value.code) ? value.code : value?.cause ? safeCode(value.cause) : "unclassified";
};
type Connection = ReturnType<typeof createDatabase>;
type Order = typeof paymentOrder.$inferSelect;
type Identity = { id: string; cookie: string; actor: PaymentActor };
type Scenario = { scenario: string; status: "running" | "passed" | "failed"; [key: string]: unknown };

// No service starts on import. Only the runner's dedicated fresh --http cluster enables this suite.
(incomingUrl === undefined ? describe.skip : describe)("payment HTTP pipeline on the isolated runner PostgreSQL 16", () => {
    let marker: PaymentPostgresMarker | undefined, database: Connection | undefined, server: ReturnType<typeof Bun.serve> | undefined;
    let api: ReturnType<typeof createAccountApi>, auth: ReturnType<typeof createAuth>, origin: string, admin: Identity;
    let applicationName: string, setupStatus = "not_started", generations = 0, createCalls = 0, queryCalls = 0, droppedAcks = 0, apiPort: number | null = null;
    let dropNextSuccessAck = false, migrationReceipt: Record<string, unknown> | null = null, blockedExternalFetches = 0, fetchGuardInstalled = false;
    const realFetch = globalThis.fetch;
    const poolErrors: string[] = [], faults: { code: string; requestId: string }[] = [], scenarios: Scenario[] = [];
    const ackInjections: Record<string, unknown>[] = [], queryModes = new Map<string, "paid" | "unknown">();
    const secret = crypto.randomUUID() + crypto.randomUUID(), merchantKey = `synthetic-http&key=${crypto.randomUUID()}`;
    const password = "synthetic-http-password-only", offerVersionId = crypto.randomUUID();
    const runtime = { enabled: true as const, timeoutMs: 2000, maxResponseBytes: 8192, paymentLinkOrigins: ["https://synthetic-pay.example.test"] };
    const repo = () => createPaymentRepository(database!.db, secret);
    const mail = { secret, sendVerificationEmail: async () => {}, sendResetPassword: async () => {} };
    const peer = "127.0.0.1";
    const money = (order: Order) => `${BigInt(order.amountMinor) / BigInt(100)}.${(BigInt(order.amountMinor) % BigInt(100)).toString().padStart(2, "0")}`;
    const identitySql = `SELECT host(inet_server_addr()) AS host, inet_server_port() AS port, current_database() AS database,
        current_user AS role, current_setting('server_version_num') AS server_version_num, current_setting('cluster_name') AS cluster_name,
        pg_postmaster_start_time()::text AS postmaster_start, extract(epoch FROM pg_postmaster_start_time())::text AS postmaster_start_epoch,
        current_setting('application_name') AS application_name,
        (SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS restricted`;

    async function verifyIdentity() {
        if (!marker || !database) throw new Error("payment_http_identity_not_prepared");
        const actual = (await database.pool.query(identitySql)).rows[0];
        if (!actual || actual.host !== peer || actual.port !== marker.port || actual.database !== marker.database || actual.role !== marker.role ||
            actual.server_version_num !== marker.serverVersionNum || !/^16[0-9]{4}$/.test(actual.server_version_num) ||
            actual.cluster_name !== marker.clusterName || actual.postmaster_start !== marker.postmasterStart ||
            actual.postmaster_start_epoch !== marker.postmasterStartEpoch || actual.application_name !== applicationName || actual.restricted !== true) {
            throw new Error("payment_http_actual_identity_mismatch");
        }
        const postmaster = (await readFile(join(marker.dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/);
        if (Number(postmaster[0]) !== marker.postmasterPid || !samePath(postmaster[1] ?? "", marker.dataDir) ||
            Number(postmaster[2]) !== marker.postmasterPidStartSeconds || Number(postmaster[3]) !== marker.port || postmaster[5] !== peer) {
            throw new Error("payment_http_postmaster_changed");
        }
        const stored: PaymentPostgresMarker = JSON.parse(await readFile(markerFile!, "utf8"));
        if (JSON.stringify(stored) !== JSON.stringify(marker)) throw new Error("payment_http_verified_marker_changed");
    }

    const providerFetch = Object.assign(async (source: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(source instanceof Request ? source.url : String(source));
        if (url.origin !== "https://zpayz.cn" || init?.redirect !== "manual") throw new Error("synthetic_provider_target_mismatch");
        if (url.pathname === "/mapi.php" && init.method === "POST") {
            createCalls++;
            const form = init.body as FormData, number = form.get("out_trade_no");
            if (typeof number !== "string") throw new Error("synthetic_original_order_missing");
            const [order] = await database!.db.select().from(paymentOrder).where(eq(paymentOrder.merchantOrderId, number));
            if (!order || form.get("money") !== money(order) || form.get("pid") !== order.merchantId || form.get("name") !== order.productName ||
                form.get("clientip") !== peer || form.has("return_url")) throw new Error("synthetic_server_order_binding_mismatch");
            return new Response(JSON.stringify({ code: 1, trade_no: `trade_${number}`, O_id: `oid_${number}`, payurl: `https://synthetic-pay.example.test/${number}` }));
        }
        if (url.pathname !== "/api.php" || init?.method !== "GET" || url.searchParams.get("act") !== "order" ||
            url.searchParams.get("key") !== merchantKey) throw new Error("synthetic_original_query_mismatch");
        queryCalls++;
        const number = url.searchParams.get("out_trade_no")!;
        if (queryModes.get(number) === "unknown") throw new Error("synthetic_provider_query_unknown");
        const [order] = await database!.db.select().from(paymentOrder).where(eq(paymentOrder.merchantOrderId, number));
        if (!order || url.searchParams.get("pid") !== order.merchantId) throw new Error("synthetic_original_query_order_missing");
        return new Response(JSON.stringify({ code: 1, status: 1, pid: order.merchantId, out_trade_no: number,
            trade_no: `trade_${number}`, type: order.paymentType, money: money(order) }));
    }, { preconnect() {} }) as typeof fetch;

    function rebuildApi() {
        generations++;
        api = createAccountApi({ database: database!.db, origin, auth: mail, rates: { consume: async () => ({ allowed: true }) },
            verifyHuman: async () => true, payments: runtime, paymentFetcher: providerFetch,
            onFault: event => { faults.push({ code: event.code, requestId: event.requestId }); } });
    }
    async function call(path: string, identity?: Identity, method = "GET", value?: unknown, headers: Record<string, string> = {}) {
        return fetch(`${origin}${path}`, { method, headers: { origin, "content-type": "application/json", ...(identity ? {
            cookie: identity.cookie, "x-canvas-account-id": identity.id,
        } : {}), ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), redirect: "manual" });
    }
    async function identity(role: "user" | "admin" = "user"): Promise<Identity> {
        const email = `http-${crypto.randomUUID()}@example.test`;
        const signup = await call("/api/auth/sign-up/email", undefined, "POST", { name: "合成HTTP支付账号", email, password });
        expect(signup.status).toBe(200); await signup.text();
        const [owner] = await database!.db.select().from(user).where(eq(user.email, email));
        if (!owner) throw new Error("synthetic_http_auth_user_missing");
        await database!.db.update(user).set({ emailVerified: true, role }).where(eq(user.id, owner.id));
        const login = await call("/api/auth/sign-in/email", undefined, "POST", { email, password });
        expect(login.status).toBe(200); await login.text();
        const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
        const principal = await getPrincipal(auth, new Headers({ cookie }));
        if (principal.principal?.id !== owner.id || !principal.sessionContext) throw new Error("synthetic_http_auth_session_missing");
        return { id: owner.id, cookie, actor: { actorId: owner.id, sessionId: principal.sessionContext.id,
            sessionExpiresAt: principal.sessionContext.expiresAt, requestId: crypto.randomUUID() } };
    }
    async function createOrder(owner: Identity) {
        const key = crypto.randomUUID(), response = await call("/api/v1/payments/orders", owner, "POST", { offerVersionId, paymentType: "alipay" }, { "idempotency-key": key });
        expect(response.status).toBe(201);
        const body = await response.json();
        if (!uuid(body.order?.id)) throw new Error("synthetic_http_created_order_missing");
        const order = await repo().getOrder(body.order.id);
        if (!order || order.ownerId !== owner.id) throw new Error("synthetic_http_order_owner_mismatch");
        return { order, key };
    }
    async function callbackPath(order: Order) {
        const merchant = await repo().loadMerchant(order.merchantVersionId);
        if (!merchant) throw new Error("synthetic_http_original_merchant_missing");
        const fields = { pid: order.merchantId, name: order.productName, money: money(order), out_trade_no: order.merchantOrderId,
            trade_no: `trade_${order.merchantOrderId}`, trade_status: "TRADE_SUCCESS", type: order.paymentType };
        const material = Object.keys(fields).sort().map(key => `${key}=${fields[key as keyof typeof fields]}`).join("&");
        const sign = createHash("md5").update(material, "utf8").update(merchant.merchantKey, "utf8").digest("hex");
        return `${new URL(merchant.notifyUrl).pathname}?${new URLSearchParams({ ...fields, sign, sign_type: "MD5" })}`;
    }
    const callback = (path: string) => fetch(`${origin}${path}`, { redirect: "manual" }); // Deliberately no Origin, cookie or account header.
    async function funds(order: Order) {
        return (await database!.pool.query(`SELECT o.credit_state, o.payment_state, o.credited_ledger_id,
            COALESCE((SELECT available_units::text FROM canvas_saas.wallet WHERE user_id=o.owner_id),'0') AS available,
            COALESCE((SELECT reserved_units::text FROM canvas_saas.wallet WHERE user_id=o.owner_id),'0') AS reserved,
            EXISTS(SELECT 1 FROM canvas_saas.wallet WHERE user_id=o.owner_id) AS wallet_exists,
            (SELECT count(*)::int FROM canvas_saas.wallet_ledger WHERE kind='recharge' AND reference_type='payment_order' AND reference_id=o.id::text) AS recharge_count
            FROM canvas_saas.payment_order o WHERE o.id=$1`, [order.id])).rows[0];
    }
    async function scenario(name: string, work: (entry: Scenario) => Promise<void>) {
        const entry: Scenario = { scenario: name, status: "running" }; scenarios.push(entry);
        try { await verifyIdentity(); await work(entry); await verifyIdentity(); entry.status = "passed"; }
        catch (error) { entry.status = "failed"; entry.errorCode = safeCode(error); throw error; }
        finally { dropNextSuccessAck = false; }
    }
    async function close() {
        const currentServer = server; server = undefined;
        try { await currentServer?.stop(true); }
        finally {
            const currentDatabase = database; database = undefined;
            try { await currentDatabase?.close(); }
            finally { if (fetchGuardInstalled) { globalThis.fetch = realFetch; fetchGuardInstalled = false; } }
        }
    }

    beforeAll(async () => {
        setupStatus = "identity";
        try {
            if (process.platform !== "win32" || !markerFile || !incomingUrl || !isAbsolute(markerFile)) throw new Error("payment_http_runner_required");
            const runParent = join(await realpath(tmpdir()), "canvas-payments-z1"), supplied = resolve(markerFile);
            if (!/^[A-Za-z]:[\\/]/.test(markerFile) || /[^\x20-\x7e]/.test(markerFile) || basename(supplied) !== "marker.json" ||
                !basename(dirname(supplied)).startsWith("run-") || !samePath(dirname(dirname(supplied)), runParent) || !samePath(await realpath(supplied), supplied)) {
                throw new Error("payment_http_marker_location_rejected");
            }
            const candidate: PaymentPostgresMarker = JSON.parse(await readFile(markerFile, "utf8"));
            if (candidate.kind !== "canvas-payments-z1-pg16" || candidate.mode !== "http" || candidate.status !== "identity-verified" || !uuid(candidate.runId) ||
                !isAbsolute(candidate.runDir) || /[^\x20-\x7e]/.test(candidate.runDir) || !samePath(markerFile, join(candidate.runDir, "marker.json")) ||
                !samePath(dirname(candidate.runDir), runParent) || !basename(candidate.runDir).startsWith("run-") || !samePath(candidate.dataDir, join(candidate.runDir, "data")) ||
                !samePath(await realpath(candidate.runDir), candidate.runDir) || !samePath(await realpath(candidate.dataDir), candidate.dataDir) ||
                candidate.host !== peer || candidate.database !== "canvas_payments_z1" || candidate.role !== "canvas_payments_z1_app" ||
                !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535 || !/^16[0-9]{4}$/.test(candidate.serverVersionNum) ||
                candidate.clusterName !== `canvas_payments_z1_${candidate.runId.replaceAll("-", "")}` || !Number.isSafeInteger(candidate.postmasterPid) ||
                !candidate.postmasterPid || candidate.postmasterPid < 1 || !Number.isSafeInteger(candidate.postmasterPidStartSeconds) ||
                !candidate.postmasterStart || !candidate.postmasterStartEpoch) throw new Error("payment_http_marker_rejected");
            const target = new URL(incomingUrl);
            if (target.protocol !== "postgresql:" || target.hostname !== peer || Number(target.port) !== candidate.port || target.username !== candidate.role ||
                !target.password || target.pathname !== `/${candidate.database}` || target.search || target.hash) throw new Error("payment_http_url_identity_mismatch");
            marker = candidate;
            applicationName = `payment_z1_${candidate.runId.replaceAll("-", "")}_http`;
            target.searchParams.set("application_name", applicationName);
            database = createDatabase(target.href);
            database.pool.on("error", error => { poolErrors.push(safeCode(error)); });
            await verifyIdentity();
            if ((await database.pool.query("SELECT to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_migrations') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh")).rows[0]?.fresh !== true) {
                throw new Error("payment_http_fresh_application_schema_required");
            }
            setupStatus = "migrations";
            await migrateDatabase(database.db); await verifyIdentity();
            const count = (await database.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
            const journal = JSON.parse(await readFile(new URL("../../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8"));
            expect(count).toBe(journal.entries.length);
            await migrateDatabase(database.db); await verifyIdentity();
            const repeated = (await database.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
            expect(repeated).toBe(count);
            migrationReceipt = { before: 0, after: count, repeated, verifiedIdentity: true, serverVersionNum: candidate.serverVersionNum };
            setupStatus = "loopback_http";
            server = Bun.serve({ hostname: peer, port: 0, fetch: async (request, serving) => {
                if (!api) return new Response("fixture_initializing", { status: 503 });
                const response = await api(request, serving.requestIP(request)?.address);
                const path = new URL(request.url).pathname;
                if (dropNextSuccessAck && /^\/api\/v1\/payments\/zpay\/notify\/[^/]+$/.test(path) && response.status === 200 && await response.clone().text() === "success") {
                    dropNextSuccessAck = false; droppedAcks++;
                    ackInjections.push({ boundary: "test_loopback_proxy_after_createAccountApi_response", apiStatus: 200, apiBody: "success", deliveredStatus: 503,
                        deliveredBody: "synthetic_ack_not_delivered", at: new Date().toISOString() });
                    return new Response("synthetic_ack_not_delivered", { status: 503, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
                }
                return response;
            } });
            origin = `http://${peer}:${server.port}`;
            apiPort = server.port;
            if (server.port === candidate.port) throw new Error("payment_http_and_pg_ports_must_differ");
            // Even a broken product injection cannot accidentally call the real provider.
            globalThis.fetch = Object.assign((source: Parameters<typeof fetch>[0], init?: RequestInit) => {
                const target = new URL(source instanceof Request ? source.url : String(source));
                if (target.origin !== origin || init?.redirect !== "manual") {
                    blockedExternalFetches++;
                    return Promise.reject(new Error("payment_http_external_fetch_rejected"));
                }
                return realFetch(source, init);
            }, { preconnect() { throw new Error("payment_http_preconnect_rejected"); } }) as typeof fetch;
            fetchGuardInstalled = true;
            auth = createAuth({ database: database.db, baseURL: origin, ...mail });
            rebuildApi();
            admin = await identity("admin");
            // Explicit fixture prices and rules; this is not a D01 default or a real merchant.
            await repo().saveMerchant({ expectedRevision: 0, merchantId: "synthetic_http_merchant", merchantKey, paymentType: "alipay",
                productName: "仅隔离HTTP充值夹具" }, admin.actor, "https://synthetic.example.test");
            await repo().saveOffers({ expectedRevision: 1, newOrdersEnabled: true, items: [{ id: offerVersionId, offerId: crypto.randomUUID(), revision: 1,
                label: "合成HTTP档位", amountMinor: "1230", creditUnits: "0.006", policyReference: "synthetic-http-only" }] }, admin.actor);
            setupStatus = "ready";
        } catch (error) { setupStatus = `failed_${setupStatus}`; await close(); throw error; }
    }, 30_000);
    afterAll(async () => {
        try {
            if (marker) await writeFile(join(marker.runDir, "payment-http-evidence.json"), JSON.stringify({ kind: "payments-z1-pg16-http", mode: "http", runId: marker.runId,
                synthetic: true, command: ["bun", "--no-env-file", "--no-install", "test", "apps/api/test/payment-postgres-http.test.ts"],
                setupStatus, migration: migrationReceipt, loopbackApi: { host: peer, port: apiPort, postgresPort: marker.port }, tlsVerified: false, mailAndCaptcha: "synthetic", realZpay: false,
                callbackDelivery: "actual loopback HTTP path from stored HTTPS fixture notify URL; no TLS or real gateway delivery", generations,
                providerCalls: { create: createCalls, query: queryCalls }, blockedExternalFetches, droppedAcks, ackInjections, poolErrors, faults, scenarios }, null, 2) + "\n", { flag: "wx" });
        } finally { await close(); }
        expect(poolErrors).toEqual([]);
        expect(blockedExternalFetches).toBe(0);
    });

    test("real HTTP creation and signed callback credit once across proxy ACK loss and a fresh API object", async () => {
        await scenario("http_callback_ack_loss_and_rebuild", async entry => {
            const owner = await identity(), beforeCreate = createCalls, { order } = await createOrder(owner), path = await callbackPath(order);
            const wrongMethod = await fetch(`${origin}${path}`, { method: "POST", redirect: "manual" });
            expect(wrongMethod.status).toBeGreaterThanOrEqual(400); await wrongMethod.text();
            dropNextSuccessAck = true;
            const lost = await callback(path), lostBody = await lost.text();
            expect(lost.status).toBe(503); expect(lostBody.includes("success")).toBe(false);
            const committed = await funds(order);
            expect(committed).toMatchObject({ credit_state: "credited", recharge_count: 1, available: "0.006", reserved: "0" });
            const queriesBeforeReplay = queryCalls, generationBefore = generations;
            queryModes.set(order.merchantOrderId, "unknown"); rebuildApi();
            const replay = await callback(path);
            expect(replay.status).toBe(200); expect(await replay.text()).toBe("success");
            expect(queryCalls).toBe(queriesBeforeReplay); expect(createCalls - beforeCreate).toBe(1);
            expect((await funds(order)).recharge_count).toBe(1);
            Object.assign(entry, { deliveredFirstStatus: 503, firstDeliveredSuccess: false, apiCommitBeforeDrop: true, replayStatus: 200,
                originalCreateCalls: createCalls - beforeCreate, replayAdditionalQueries: queryCalls - queriesBeforeReplay,
                rebuiltApi: generations > generationBefore, funds: committed, injection: "response replacement after API success; not a real gateway/TCP loss" });
        });
    }, 30_000);

    test("real HTTP paid observation and cross-account isolation precede a deferred-COMMIT callback fault with no partial funds", async () => {
        await scenario("http_deferred_commit_fault_and_isolation", async entry => {
            const owner = await identity(), other = await identity(), { order, key } = await createOrder(owner);
            const crossId = await call(`/api/v1/payments/orders/${order.id}`, other), crossKey = await call(`/api/v1/payments/orders/by-key/${key}`, other);
            expect(crossId.status).toBe(404); expect(crossKey.status).toBe(404); await crossId.text(); await crossKey.text();
            const paid = await call(`/api/v1/payments/orders/${order.id}/query`, owner, "POST");
            expect(paid.status).toBe(200); expect((await paid.json()).order).toMatchObject({ paymentState: "paid", creditState: "pending" });
            const before = await funds(order); expect(before).toMatchObject({ recharge_count: 0, available: "0", reserved: "0" });
            const faultMarker = `payment_http_commit_fault_${marker!.runId}_${order.id}`;
            await database!.pool.query(`CREATE FUNCTION canvas_saas.z1_http_commit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE LOG '${faultMarker}'; RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='synthetic_http_deferred_commit_fault'; END; $$`);
            await database!.pool.query(`CREATE CONSTRAINT TRIGGER z1_http_commit_fault AFTER UPDATE ON canvas_saas.payment_order DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW WHEN (NEW.id='${order.id}'::uuid AND NEW.credit_state='credited') EXECUTE FUNCTION canvas_saas.z1_http_commit_fault()`);
            const trigger = (await database!.pool.query("SELECT tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname='z1_http_commit_fault' AND tgrelid='canvas_saas.payment_order'::regclass")).rows[0];
            expect(trigger).toEqual({ tgdeferrable: true, tginitdeferred: true });
            let failedStatus = 0, triggerLogObserved = false;
            const path = await callbackPath(order);
            try {
                const failed = await callback(path); failedStatus = failed.status;
                expect(failed.status).toBe(503); expect((await failed.text()).includes("success")).toBe(false);
                expect(await funds(order)).toEqual(before);
                triggerLogObserved = (await readFile(join(marker!.runDir, "postgres.log"), "utf8")).includes(faultMarker);
                expect(triggerLogObserved).toBe(true);
            } finally {
                await database!.pool.query("DROP TRIGGER z1_http_commit_fault ON canvas_saas.payment_order");
                await database!.pool.query("DROP FUNCTION canvas_saas.z1_http_commit_fault()");
            }
            const retried = await callback(path); expect(retried.status).toBe(200); expect(await retried.text()).toBe("success");
            const after = await funds(order); expect(after).toMatchObject({ credit_state: "credited", recharge_count: 1, available: "0.006", reserved: "0" });
            Object.assign(entry, { crossAccountIdStatus: 404, crossAccountKeyStatus: 404, paidQueryAlone: before,
                deferredFault: { failedStatus, trigger, triggerLogObserved, injectedSqlstate: "P0001", partialFunds: false }, finalFunds: after });
        });
    }, 30_000);

    test("a fresh real HTTP administrator recovery revalidates durable notice while ordinary or revoked users cannot credit", async () => {
        await scenario("http_admin_reconcile_and_revocation", async entry => {
            const owner = await identity(), { order } = await createOrder(owner), path = await callbackPath(order);
            queryModes.set(order.merchantOrderId, "unknown");
            const pending = await callback(path); expect(pending.status).toBe(503); expect((await pending.text()).includes("success")).toBe(false);
            expect(await repo().recentSuccessfulNotification(order.id)).not.toBeNull(); expect((await funds(order)).recharge_count).toBe(0);
            const generationBefore = generations; rebuildApi(); queryModes.set(order.merchantOrderId, "paid");
            const ordinary = await call(`/api/v1/admin/payments/orders/${order.id}/reconcile`, owner, "POST");
            expect(ordinary.status).toBe(403); await ordinary.text();
            const queriesBeforeRecovery = queryCalls;
            const recovered = await call(`/api/v1/admin/payments/orders/${order.id}/reconcile`, admin, "POST");
            expect(recovered.status).toBe(200); expect((await recovered.json()).order.creditState).toBe("credited");
            const independentRecoveryQueries = queryCalls - queriesBeforeRecovery;
            expect(independentRecoveryQueries).toBe(1);
            expect(await funds(order)).toMatchObject({ recharge_count: 1, available: "0.006", reserved: "0" });
            const noNoticeOwner = await identity(), { order: noNotice } = await createOrder(noNoticeOwner);
            const plain = await call(`/api/v1/payments/orders/${noNotice.id}/query`, noNoticeOwner, "POST"); expect(plain.status).toBe(200); await plain.text();
            const missing = await call(`/api/v1/admin/payments/orders/${noNotice.id}/reconcile`, admin, "POST");
            expect(missing.status).toBe(202); await missing.text();
            expect(await funds(noNotice)).toMatchObject({ credit_state: "pending", recharge_count: 0, available: "0" });
            const revokedAdmin = await identity("admin"), isolatedOwner = await identity(), { order: revokedOrder } = await createOrder(isolatedOwner);
            queryModes.set(revokedOrder.merchantOrderId, "unknown");
            const saved = await callback(await callbackPath(revokedOrder)); expect(saved.status).toBe(503); await saved.text();
            await database!.db.delete(session).where(eq(session.id, revokedAdmin.actor.sessionId));
            queryModes.set(revokedOrder.merchantOrderId, "paid");
            const queriesBeforeRevoked = queryCalls;
            const rejected = await call(`/api/v1/admin/payments/orders/${revokedOrder.id}/reconcile`, revokedAdmin, "POST");
            expect([401, 409]).toContain(rejected.status); await rejected.text();
            expect(queryCalls).toBe(queriesBeforeRevoked);
            expect(await funds(revokedOrder)).toMatchObject({ credit_state: "pending", recharge_count: 0, available: "0" });
            Object.assign(entry, { durableNoticeRecoveredAfterApiRebuild: generations > generationBefore, ordinaryStatus: 403, recoveryStatus: 200, independentRecoveryQueries,
                recoveredFunds: await funds(order), missingNoticeStatus: 202, missingNoticeFunds: await funds(noNotice),
                revokedAdministratorStatus: rejected.status, revokedFunds: await funds(revokedOrder) });
        });
    }, 30_000);
});
