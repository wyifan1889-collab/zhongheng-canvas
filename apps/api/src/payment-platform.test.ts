import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createPaymentRepository } from "../../../packages/database/src/payments";
import { parseAdminPaymentOrder, parsePaymentConfiguration, parsePaymentOrder, paymentMinorToCny } from "../../../packages/shared/src/payment-platform";
import { createPaymentPlatform, type PaymentRouteContext } from "./payment-platform";
import { HttpError } from "./http";

const origin = "https://canvas.example", secret = "synthetic-platform-secret-with-at-least-32-characters";
const orderId = "c1729008-59de-4a99-8756-b8c439db1902", offerId = "d1729008-59de-4a99-8756-b8c439db1902";
const user: PaymentRouteContext = { actor: { actorId: "synthetic-user", sessionId: "synthetic-session", sessionExpiresAt: new Date(Date.now() + 60_000), requestId: "synthetic-request" },
    role: "user", peerIp: "203.0.113.10", documentBytes: 4096 };
const admin: PaymentRouteContext = { ...user, role: "admin" };
const good = JSON.stringify({ offerVersionId: offerId, paymentType: "alipay" });
function request(path: string, method = "GET", raw?: string | Uint8Array, headers: Record<string, string> = {}) {
    return new Request(`${origin}${path}`, { method, headers: { "content-type": "application/json", ...headers },
        ...(raw === undefined ? {} : { body: raw }) });
}
function isolated(enabled = false) {
    let databaseCalls = 0, networkCalls = 0;
    const database = new Proxy({}, { get() { databaseCalls++; throw new Error("database access is forbidden in these mock boundary tests"); } });
    const fetcher = Object.assign(async () => { networkCalls++; throw new Error("network access is forbidden in these mock boundary tests"); }, { preconnect() {} }) as typeof fetch;
    const platform = createPaymentPlatform({ database: database as never, secret, origin, config: enabled ? { enabled: true, timeoutMs: 100,
        maxResponseBytes: 4096, paymentLinkOrigins: ["https://pay.example"] } : { enabled: false }, fetcher });
    return { platform, counts: () => ({ databaseCalls, networkCalls }) };
}
async function rejects(promise: Promise<unknown>, status: number, code?: string) {
    try { await promise; throw new Error("expected a safe HttpError"); }
    catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).status).toBe(status);
        if (code) expect((error as HttpError).code).toBe(code);
    }
}

describe("payment platform mock boundaries without database or network", () => {
    test("ignores unrelated paths and exempts only the exact callback path", async () => {
        const { platform, counts } = isolated();
        for (const path of ["/api/v1/account", "/api/v1/payments/other", `/api/v1/payments/zpay/notify/${orderId}/extra`, "/api/v1/payments/zpay/notify"]) {
            expect(await platform.handleNotification(request(path), "test-request")).toBeNull();
            expect(await platform.handleAccountRequest(request(path), user)).toBeNull();
        }
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("closed runtime blocks every network or funding operation with no success acknowledgement", async () => {
        const { platform, counts } = isolated();
        for (const [path, method, context] of [["/api/v1/payments/offers", "GET", user], ["/api/v1/payments/orders", "POST", user],
            [`/api/v1/payments/orders/${orderId}/query`, "POST", user], [`/api/v1/admin/payments/orders/${orderId}/reconcile`, "POST", admin]] as const) {
            await rejects(platform.handleAccountRequest(request(path, method), context), 503, "payment_unavailable");
        }
        const response = await platform.handleNotification(request(`/api/v1/payments/zpay/notify/${orderId}`), "synthetic-request");
        expect(response?.status).toBe(503);
        expect((await response!.text()).includes("success")).toBe(false);
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("requires a trusted account context and administrator role before private reads or writes", async () => {
        const { platform, counts } = isolated();
        await rejects(platform.handleAccountRequest(request(`/api/v1/payments/orders/${orderId}`), { ...user, actor: undefined as never }), 401);
        for (const [path, method] of [["/api/v1/admin/payments/config", "GET"], ["/api/v1/admin/payments/merchant", "PUT"],
            ["/api/v1/admin/payments/offers", "PUT"], [`/api/v1/admin/payments/orders/${orderId}`, "GET"],
            [`/api/v1/admin/payments/orders/${orderId}/reconcile`, "POST"]]) {
            await rejects(platform.handleAccountRequest(request(path!, method), user), 403);
        }
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("uses exact methods and rejects query parameters and malformed UUIDs before storage", async () => {
        const { platform, counts } = isolated();
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "GET"), user), 405);
        await rejects(platform.handleAccountRequest(request(`/api/v1/payments/orders/${orderId}/query`), user), 405);
        await rejects(platform.handleAccountRequest(request(`/api/v1/payments/orders/${orderId}?owner=other`), user), 400);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders/not-uuid"), user), 400);
        const response = await platform.handleNotification(request(`/api/v1/payments/zpay/notify/${orderId}`, "POST"), "synthetic-request");
        expect(response?.status).toBe(405);
        expect((await response!.text()).includes("success")).toBe(false);
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("strict raw admission rejects duplicate, malformed, non-object and client-controlled funding fields", async () => {
        const { platform, counts } = isolated(true);
        for (const raw of [good.replace('"paymentType":"alipay"', '"paymentType":"wxpay","paymentType":"alipay"'),
            good.replace('"paymentType":', '"paymentT\\u0079pe":"wxpay","paymentType":'),
            good.replace(/}$/, ',"creditUnits":"999"}'), good.replace(/}$/, ',"amountMinor":"1"}'),
            good.replace(/}$/, ',"ownerId":"other"}'), good.replace(/}$/, ',}'), `/* comment */${good}`, "[]", "null", "", '\uFEFF' + good,
            good.replace('"alipay"', '"\\ud800"')]) {
            await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", raw), user), 400, "invalid_input");
        }
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("validates content type, no compression, fatal UTF8 and actual byte budget", async () => {
        const { platform, counts } = isolated(true);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", good, { "content-type": "text/plain" }), user), 415);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", good, { "content-encoding": "gzip" }), user), 415);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", Uint8Array.of(0xED, 0xA0, 0x80)), user), 400);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", good), { ...user, documentBytes: 1 }), 413);
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("requires a creation key and trusted peer IP before persisting or claiming an order", async () => {
        const { platform, counts } = isolated(true);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", good), user), 400);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", good, { "idempotency-key": "synthetic-create-1" }), { ...user, peerIp: undefined }), 400);
        await rejects(platform.handleAccountRequest(request("/api/v1/payments/orders", "POST", good, { "idempotency-key": "synthetic-create-1" }), { ...user, peerIp: "untrusted.example" }), 400);
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("administrator payloads remain strict while the runtime gate is closed", async () => {
        const { platform, counts } = isolated();
        await rejects(platform.handleAccountRequest(request("/api/v1/admin/payments/merchant", "PUT", '{"expectedRevision":0,"merchantKey":"synthetic","extra":true}',
            { "idempotency-key": crypto.randomUUID() }), admin), 400);
        await rejects(platform.handleAccountRequest(request("/api/v1/admin/payments/offers", "PUT", '{"expectedRevision":0,"newOrdersEnabled":false,"items":[],"secret":"client"}'), admin), 400);
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
    test("merchant operation routes require an administrator and PUT requires a UUID operation header", async () => {
        const { platform, counts } = isolated();
        await rejects(platform.handleAccountRequest(request(`/api/v1/admin/payments/merchant-operations/${orderId}`), user), 403);
        await rejects(platform.handleAccountRequest(request(`/api/v1/admin/payments/merchant-operations/not-uuid`), admin), 400);
        const raw = JSON.stringify({ expectedRevision: 0, merchantId: "synthetic", merchantKey: "synthetic-only-key", paymentType: "alipay", productName: "合成积分" });
        const invalidHeaders: Record<string, string>[] = [{}, { "idempotency-key": "not-uuid" }];
        for (const headers of invalidHeaders) {
            await rejects(platform.handleAccountRequest(request("/api/v1/admin/payments/merchant", "PUT", raw, headers), admin), 400);
        }
        expect(counts()).toEqual({ databaseCalls: 0, networkCalls: 0 });
    });
});

describe("payment platform formal migration with synthetic PGlite fixtures", () => {
    let memory: PGlite, db: ReturnType<typeof drizzle<typeof schema>>, platform: ReturnType<typeof createPaymentPlatform>, closed: ReturnType<typeof createPaymentPlatform>;
    let adminContext: PaymentRouteContext, repo: ReturnType<typeof createPaymentRepository>;
    let initialConfiguration: unknown, createCalls = 0, queryCalls = 0, loseNextCreateResponse = false;
    const merchantKey = "synthetic-platform&merchant=key+%";
    const queryModes = new Map<string, "paid" | "unpaid" | "duplicate" | "unavailable">();
    const beforeQuery = new Map<string, () => Promise<void>>();
    // These cash/credit values are isolated fixtures, never product defaults or approved rates.
    const offer = { id: crypto.randomUUID(), offerId: crypto.randomUUID(), revision: 1, label: "合成充值档位",
        amountMinor: "1230", creditUnits: "3.25", policyReference: "synthetic-only-policy" };
    const runtime = { enabled: true as const, timeoutMs: 2000, maxResponseBytes: 8192, paymentLinkOrigins: ["https://pay.example"] };
    const fake = Object.assign(async (source: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(source instanceof Request ? source.url : String(source));
        if (url.pathname === "/mapi.php") {
            createCalls++;
            const form = init!.body as FormData, number = form.get("out_trade_no") as string;
            if (loseNextCreateResponse) { loseNextCreateResponse = false; throw new Error("synthetic response lost after possible acceptance"); }
            return new Response(JSON.stringify({ code: 1, trade_no: `trade_${number}`, O_id: `oid_${number}`, payurl: `https://pay.example/${number}` }));
        }
        expect(url.origin + url.pathname).toBe("https://zpayz.cn/api.php");
        expect(url.searchParams.get("key")).toBe(merchantKey);
        queryCalls++;
        const number = url.searchParams.get("out_trade_no")!;
        await beforeQuery.get(number)?.();
        const mode = queryModes.get(number) ?? "paid";
        if (mode === "unavailable") throw new Error("synthetic private URL and secret must not escape");
        const raw = JSON.stringify({ code: 1, status: mode === "unpaid" ? 0 : 1, pid: "synthetic_merchant",
            out_trade_no: number, trade_no: `trade_${number}`, type: "alipay", money: "12.30" });
        return new Response(mode === "duplicate" ? raw.replace('"status":1', '"status":0,"status":1') : raw);
    }, { preconnect() {} }) as typeof fetch;

    async function identity(role: "user" | "admin" = "user"): Promise<PaymentRouteContext> {
        const id = crypto.randomUUID(), sessionId = crypto.randomUUID(), expiresAt = new Date(Date.now() + 3_600_000);
        await db.insert(schema.user).values({ id, email: `${id}@example.test`, name: "合成支付账号", emailVerified: true, role });
        await db.insert(schema.session).values({ id: sessionId, token: crypto.randomUUID(), userId: id, expiresAt });
        return { actor: { actorId: id, sessionId, sessionExpiresAt: expiresAt, requestId: crypto.randomUUID() }, role,
            peerIp: "203.0.113.10", documentBytes: 8192 };
    }
    const call = (path: string, context: PaymentRouteContext, method = "GET", value?: unknown, key?: string, target = platform) =>
        target.handleAccountRequest(request(path, method, value === undefined ? undefined : JSON.stringify(value), key ? { "idempotency-key": key } : {}), context);
    async function createOrder(context: PaymentRouteContext, key = crypto.randomUUID()) {
        const response = await call("/api/v1/payments/orders", context, "POST", { offerVersionId: offer.id, paymentType: "alipay" }, key);
        const row = response!.data.order as { id: string };
        return { response: response!, row: (await repo.getOrder(row.id))!, key };
    }
    function notification(row: NonNullable<Awaited<ReturnType<typeof repo.getOrder>>>, status = "TRADE_SUCCESS", changes: Record<string, string> = {}) {
        const fields = { pid: row.merchantId, name: row.productName, money: paymentMinorToCny(row.amountMinor), out_trade_no: row.merchantOrderId,
            trade_no: `trade_${row.merchantOrderId}`, trade_status: status, type: row.paymentType, ...changes };
        const material = Object.keys(fields).sort().map(key => `${key}=${fields[key as keyof typeof fields]}`).join("&");
        const sign = createHash("md5").update(material + merchantKey, "utf8").digest("hex");
        return new URLSearchParams({ ...fields, sign, sign_type: "MD5" }).toString();
    }
    const notify = async (row: NonNullable<Awaited<ReturnType<typeof repo.getOrder>>>, raw = notification(row)) => {
        const merchant = await repo.loadMerchant(row.merchantVersionId);
        return platform.handleNotification(new Request(`${merchant!.notifyUrl}?${raw}`), crypto.randomUUID());
    };
    const ledger = (context: PaymentRouteContext) => db.select().from(schema.walletLedger).where(eq(schema.walletLedger.userId, context.actor.actorId));
    const balance = (context: PaymentRouteContext) => createWalletRepository(db as never).get(context.actor.actorId);

    beforeAll(async () => {
        memory = new PGlite();
        db = drizzle(memory, { schema });
        await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: "canvas_migrations" });
        adminContext = await identity("admin");
        repo = createPaymentRepository(db as never, secret);
        closed = createPaymentPlatform({ database: db as never, secret, origin, config: { enabled: false }, fetcher: fake });
        platform = createPaymentPlatform({ database: db as never, secret, origin, config: runtime, fetcher: fake });
        initialConfiguration = (await call("/api/v1/admin/payments/config", adminContext, "GET", undefined, undefined, closed))!.data.config;
        await call("/api/v1/admin/payments/merchant", adminContext, "PUT", { expectedRevision: 0, merchantId: "synthetic_merchant", merchantKey,
            paymentType: "alipay", productName: "合成积分服务" }, crypto.randomUUID(), closed);
        await call("/api/v1/admin/payments/offers", adminContext, "PUT", { expectedRevision: 1, newOrdersEnabled: true, items: [offer] }, undefined, closed);
    }, 30_000);
    afterAll(async () => { await memory?.close(); });

    test("administrator can save explicit configuration while closed and all projections pass the shared whitelist", async () => {
        expect(initialConfiguration).toEqual({ runtimeEnabled: false, revision: 0, newOrdersEnabled: false, merchant: null, offers: [] });
        const response = await call("/api/v1/admin/payments/config", adminContext, "GET", undefined, undefined, closed);
        const view = response!.data.config;
        expect(parsePaymentConfiguration(view)).not.toBeNull();
        expect(view).toMatchObject({ runtimeEnabled: false, revision: 2, newOrdersEnabled: true, merchant: { credentialConfigured: true },
            offers: [{ id: offer.id, amountMinor: "1230", creditUnits: "3.25" }] });
        const raw = JSON.stringify(view);
        for (const forbidden of [merchantKey, "ciphertext", "nonce", "authTag", "notifyUrl"]) expect(raw.includes(forbidden)).toBe(false);
        await rejects(call("/api/v1/payments/offers", adminContext, "GET", undefined, undefined, closed), 503);
        await rejects(call("/api/v1/admin/payments/offers", adminContext, "PUT", { expectedRevision: 0, items: [offer], newOrdersEnabled: false }), 409);
    });
    test("a creation key has one outbound attempt and owner reads never expose private order identities", async () => {
        const a = await identity(), b = await identity(), before = createCalls;
        const first = await createOrder(a);
        expect(first.response.status).toBe(201);
        expect(parsePaymentOrder(first.response.data.order)).not.toBeNull();
        expect(await call("/api/v1/payments/orders", a, "POST", { offerVersionId: offer.id, paymentType: "alipay" }, first.key))
            .toMatchObject({ status: 200, data: { order: { id: first.row.id, createState: "accepted" } } });
        expect(createCalls - before).toBe(1);
        const own = await call(`/api/v1/payments/orders/by-key/${first.key}`, a);
        expect(parsePaymentOrder(own!.data.order)).not.toBeNull();
        expect(Object.hasOwn(own!.data.order as object, "ownerId")).toBe(false);
        expect((await call(`/api/v1/payments/orders/${first.row.id}`, a, "GET", undefined, undefined, closed))!.data.order)
            .toMatchObject({ id: first.row.id, paymentLinks: {} });
        await rejects(call(`/api/v1/payments/orders/${first.row.id}`, b), 404);
        await rejects(call(`/api/v1/payments/orders/by-key/${first.key}`, b), 404);
        expect(parseAdminPaymentOrder((await call(`/api/v1/admin/payments/orders/${first.row.id}`, adminContext))!.data.order)).not.toBeNull();
        await rejects(call("/api/v1/payments/orders", a, "POST", { offerVersionId: offer.id, paymentType: "wxpay" }, first.key), 409);
    });
    test("an unknown create response never reissues creation for the same local order", async () => {
        const context = await identity(), before = createCalls;
        loseNextCreateResponse = true;
        const first = await createOrder(context);
        expect(first.row.createState).toBe("unknown");
        expect((await call("/api/v1/payments/orders", context, "POST", { offerVersionId: offer.id, paymentType: "alipay" }, first.key))!.data.order)
            .toMatchObject({ id: first.row.id, createState: "unknown" });
        expect(createCalls - before).toBe(1);
        expect((await notify(first.row))!.status).toBe(200);
        expect((await balance(context)).availableUnits).toBe("3.25");
    });
    test("paid query alone cannot credit and a lost success ACK reenters through the original complete proof", async () => {
        const context = await identity(), { row } = await createOrder(context);
        const queried = await call(`/api/v1/payments/orders/${row.id}/query`, context, "POST");
        expect(queried!.data.order).toMatchObject({ paymentState: "paid", creditState: "pending" });
        expect(await ledger(context)).toHaveLength(0);
        const response = await notify(row); // Deliberately discard the committed ACK, then replay the original notice.
        expect(response!.status).toBe(200);
        const queriesBeforeReplay = queryCalls;
        queryModes.set(row.merchantOrderId, "unavailable");
        const replay = await notify(row);
        expect(await replay!.text()).toBe("success");
        expect(queryCalls).toBe(queriesBeforeReplay);
        expect(await ledger(context)).toHaveLength(1);
        expect(await balance(context)).toMatchObject({ availableUnits: "3.25", reservedUnits: "0" });
    });
    test("unpaid and duplicate-member observations cannot credit, then the same signed notice can recover once", async () => {
        for (const mode of ["unpaid", "duplicate"] as const) {
            const context = await identity(), { row } = await createOrder(context);
            queryModes.set(row.merchantOrderId, mode);
            const unknown = await notify(row);
            expect(unknown!.status).toBe(503);
            expect((await unknown!.text()).includes("success")).toBe(false);
            expect(await ledger(context)).toHaveLength(0);
            queryModes.set(row.merchantOrderId, "paid");
            expect(await (await notify(row))!.text()).toBe("success");
            expect(await ledger(context)).toHaveLength(1);
        }
    });
    test("unrecognized notices remain observations and cannot roll back a later successful credit", async () => {
        const context = await identity(), { row } = await createOrder(context);
        const pending = await notify(row, notification(row, "WAIT_BUYER_PAY"));
        expect(await pending!.text()).toBe("observed");
        expect(await ledger(context)).toHaveLength(0);
        expect(await (await notify(row))!.text()).toBe("success");
        expect((await notify(row, notification(row, "WAIT_BUYER_PAY")))!.status).toBe(202);
        expect((await repo.getOrder(row.id))!.creditState).toBe("credited");
        expect(await ledger(context)).toHaveLength(1);
    });
    test("forged, duplicate, mismatched and unknown-order notices never become an ACK or a new order", async () => {
        const context = await identity(), { row } = await createOrder(context), before = queryCalls;
        const raw = notification(row);
        const forged = raw.replace(/sign=[0-9a-f]{32}/, "sign=" + "0".repeat(32));
        for (const invalid of [forged, raw + "&out_trade_no=" + row.merchantOrderId, notification(row, "TRADE_SUCCESS", { money: "12.31" }),
            notification(row, "TRADE_SUCCESS", { out_trade_no: "unknown_order" })]) {
            const response = await notify(row, invalid);
            expect(response!.status).toBe(400);
            expect((await response!.text()).includes("success")).toBe(false);
        }
        expect(queryCalls).toBe(before);
        expect(await ledger(context)).toHaveLength(0);
        expect(await db.select().from(schema.paymentEvent).where(eq(schema.paymentEvent.orderId, row.id))).toHaveLength(0);
    });
    test("administrator recovery revalidates saved encrypted success evidence and cannot credit from paid observation alone", async () => {
        const context = await identity(), { row } = await createOrder(context);
        await call(`/api/v1/payments/orders/${row.id}/query`, context, "POST");
        expect((await call(`/api/v1/admin/payments/orders/${row.id}/reconcile`, adminContext, "POST"))!.status).toBe(202);
        expect(await ledger(context)).toHaveLength(0);
        queryModes.set(row.merchantOrderId, "unavailable");
        expect((await notify(row))!.status).toBe(503);
        queryModes.set(row.merchantOrderId, "paid");
        const recovered = await call(`/api/v1/admin/payments/orders/${row.id}/reconcile`, adminContext, "POST");
        expect(parseAdminPaymentOrder(recovered!.data.order)).not.toBeNull();
        expect(recovered!.data.order).toMatchObject({ creditState: "credited" });
        expect(await ledger(context)).toHaveLength(1);
        const audit = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, row.id));
        expect(audit.map(row => row.action)).toContain("payment.reconciled");
    });
    test("administrator revoked during independent query cannot persist recovery or credit", async () => {
        const context = await identity(), admin = await identity("admin"), { row } = await createOrder(context);
        queryModes.set(row.merchantOrderId, "unpaid");
        expect((await notify(row))!.status).toBe(503);
        queryModes.set(row.merchantOrderId, "paid");
        beforeQuery.set(row.merchantOrderId, async () => { await db.delete(schema.session).where(eq(schema.session.id, admin.actor.sessionId)); });
        await rejects(call(`/api/v1/admin/payments/orders/${row.id}/reconcile`, admin, "POST"), 409, "account_changed");
        expect(await ledger(context)).toHaveLength(0);
        expect(await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, row.id))).toHaveLength(0);
    });
    test("a wallet transaction fault produces no partial balance, ledger or credit and never ACKs before retry", async () => {
        const context = await identity(), { row } = await createOrder(context);
        await db.execute(sql.raw(`CREATE FUNCTION canvas_saas.test_payment_handler_fault() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.kind = 'recharge' THEN RAISE EXCEPTION 'synthetic wallet handler fault'; END IF; RETURN NEW; END; $$`));
        await db.execute(sql.raw("CREATE TRIGGER test_payment_handler_fault BEFORE INSERT ON canvas_saas.wallet_ledger FOR EACH ROW EXECUTE FUNCTION canvas_saas.test_payment_handler_fault()"));
        try {
            const response = await notify(row);
            expect(response!.status).toBe(503);
            expect((await response!.text()).includes("success")).toBe(false);
            expect((await balance(context)).availableUnits).toBe("0");
            expect(await ledger(context)).toHaveLength(0);
            expect((await repo.getOrder(row.id))!.creditState).toBe("pending");
        } finally {
            await db.execute(sql.raw("DROP TRIGGER test_payment_handler_fault ON canvas_saas.wallet_ledger"));
            await db.execute(sql.raw("DROP FUNCTION canvas_saas.test_payment_handler_fault()"));
        }
        expect(await (await notify(row))!.text()).toBe("success");
        expect(await ledger(context)).toHaveLength(1);
    });
    test("a refund-marked credited order cannot ACK an old success or add another recharge", async () => {
        const context = await identity(), { row } = await createOrder(context);
        expect(await (await notify(row))!.text()).toBe("success");
        await db.update(schema.paymentOrder).set({ refundState: "pending_review" }).where(eq(schema.paymentOrder.id, row.id));
        const response = await notify(row);
        expect(response!.status).toBe(503);
        expect((await response!.text()).includes("success")).toBe(false);
        expect(await ledger(context)).toHaveLength(1);
        expect((await balance(context)).availableUnits).toBe("3.25");
    });
    test("merchant operation receipt recovers a lost response and replays without changing a newer active merchant", async () => {
        const operationId = crypto.randomUUID(), nextOperationId = crypto.randomUUID(), current = await repo.getSettings();
        const input = { expectedRevision: current.revision, merchantId: "operation_merchant_a", merchantKey: "synthetic-operation&key-a",
            paymentType: "alipay", channelId: "channel-a", productName: "合成操作回执A" };
        const created = await call("/api/v1/admin/payments/merchant", adminContext, "PUT", input, operationId, closed);
        const original = created!.data.receipt;
        expect(original).toEqual({ id: operationId, merchantId: input.merchantId, paymentType: "alipay", channelId: "channel-a",
            productName: input.productName, credentialConfigured: true });
        // The client discards this write response and recovers only its original operation ID.
        expect((await call(`/api/v1/admin/payments/merchant-operations/${operationId}`, adminContext, "GET", undefined, undefined, closed))!.data)
            .toEqual({ receipt: original });
        const next = await call("/api/v1/admin/payments/merchant", adminContext, "PUT", { ...input, expectedRevision: current.revision + 1,
            merchantId: "operation_merchant_b", merchantKey: "synthetic-operation-key-b", productName: "合成操作回执B" }, nextOperationId, closed);
        expect((next!.data.config as { merchant: { id: string } }).merchant.id).toBe(nextOperationId);
        const replay = await call("/api/v1/admin/payments/merchant", adminContext, "PUT", input, operationId, closed);
        expect(replay!.data.receipt).toEqual(original);
        expect((replay!.data.config as { revision: number; merchant: { id: string } })).toMatchObject({ revision: current.revision + 2, merchant: { id: nextOperationId } });
        expect((await call(`/api/v1/admin/payments/merchant-operations/${operationId}`, adminContext, "GET", undefined, undefined, closed))!.data.receipt).toEqual(original);
        const audits = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, operationId));
        expect(audits.map(row => row.action)).toEqual(["payment.merchant.saved"]);
        expect((await repo.getSettings()).merchantVersionId).toBe(nextOperationId);
    });
    test("merchant operation identity rejects another actor and every altered original input including the secret key", async () => {
        const operationId = crypto.randomUUID(), admin = await identity("admin"), current = await repo.getSettings();
        const input = { expectedRevision: current.revision, merchantId: "operation_isolation", merchantKey: "synthetic-key-with&suffix",
            paymentType: "alipay", productName: "合成操作归属" };
        await call("/api/v1/admin/payments/merchant", admin, "PUT", input, operationId, closed);
        await rejects(call(`/api/v1/admin/payments/merchant-operations/${operationId}`, adminContext, "GET", undefined, undefined, closed), 404);
        await rejects(call(`/api/v1/admin/payments/merchant-operations/${crypto.randomUUID()}`, adminContext, "GET", undefined, undefined, closed), 404);
        await rejects(call("/api/v1/admin/payments/merchant", adminContext, "PUT", input, operationId, closed), 409);
        for (const change of [{ merchantKey: "different-synthetic-key" }, { expectedRevision: current.revision + 1 }, { merchantId: "other" },
            { paymentType: "wxpay" }, { channelId: "new-channel" }, { productName: "其他合成商品" }]) {
            await rejects(call("/api/v1/admin/payments/merchant", admin, "PUT", { ...input, ...change }, operationId, closed), 409);
        }
        expect(await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, operationId))).toHaveLength(1);
        expect((await repo.getSettings()).revision).toBe(current.revision + 1);
    });
    test("merchant operation metadata receipt does not need successful secret decryption or enable payment", async () => {
        const operationId = crypto.randomUUID(), current = await repo.getSettings(), beforeCreate = createCalls, beforeQueryCount = queryCalls;
        const input = { expectedRevision: current.revision, merchantId: "operation_metadata", merchantKey: "synthetic-receipt-key",
            paymentType: "alipay", productName: "合成只读回执" };
        await call("/api/v1/admin/payments/merchant", adminContext, "PUT", input, operationId, closed);
        const otherSecret = createPaymentPlatform({ database: db as never, secret: "different-synthetic-secret-with-more-than-32-characters", origin,
            config: { enabled: false }, fetcher: fake });
        const receipt = (await call(`/api/v1/admin/payments/merchant-operations/${operationId}`, adminContext, "GET", undefined, undefined, otherSecret))!.data.receipt;
        expect(receipt).toEqual({ id: operationId, merchantId: input.merchantId, paymentType: "alipay", channelId: null,
            productName: input.productName, credentialConfigured: true });
        for (const forbidden of [input.merchantKey, "ciphertext", "nonce", "authTag", "notifyUrl"]) expect(JSON.stringify(receipt).includes(forbidden)).toBe(false);
        await rejects(call("/api/v1/payments/offers", adminContext, "GET", undefined, undefined, otherSecret), 503);
        expect(createCalls).toBe(beforeCreate);
        expect(queryCalls).toBe(beforeQueryCount);
    });
    test("offer replacement keeps the configured first-slot order after a discarded PUT ACK and rejects missing versions", async () => {
        expect((await db.execute(sql`SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations`)).rows[0]).toEqual({ count: 32 });
        const current = await repo.getSettings(), beforeCreate = createCalls, beforeQueryCount = queryCalls;
        const first = { id: crypto.randomUUID(), offerId: crypto.randomUUID(), revision: 1, label: "合成顺序A", amountMinor: "101", creditUnits: "0.01", policyReference: "synthetic-order-policy-a" };
        const second = { id: crypto.randomUUID(), offerId: crypto.randomUUID(), revision: 1, label: "合成顺序B", amountMinor: "202", creditUnits: "0.02", policyReference: "synthetic-order-policy-b" };
        await call("/api/v1/admin/payments/offers", adminContext, "PUT", { expectedRevision: current.revision, newOrdersEnabled: false, items: [first, second] }, undefined, closed);
        const replacement = { ...first, id: crypto.randomUUID(), revision: 2, label: "合成顺序A2", amountMinor: "303", creditUnits: "0.03" };
        // Actual immutable row insertion order is A,B,A2; discard the committed second PUT ACK.
        await call("/api/v1/admin/payments/offers", adminContext, "PUT", { expectedRevision: current.revision + 1, newOrdersEnabled: false, items: [replacement, second] }, undefined, closed);
        const read = (await call("/api/v1/admin/payments/config", adminContext, "GET", undefined, undefined, closed))!.data.config;
        expect(parsePaymentConfiguration(read)).not.toBeNull();
        expect(read).toMatchObject({ revision: current.revision + 2, newOrdersEnabled: false, offers: [replacement, second] });
        expect((await repo.getOffers()).map(row => row.id)).toEqual([replacement.id, second.id]);
        expect((await repo.getOffers([second.id, replacement.id])).map(row => row.id)).toEqual([second.id, replacement.id]);
        expect(await repo.getOffers([])).toEqual([]);
        await expect(repo.getOffers([replacement.id, crypto.randomUUID()])).rejects.toMatchObject({ code: "payment_unavailable" });
        await expect(repo.getOffers(["invalid-version-id"])).rejects.toMatchObject({ code: "payment_invalid" });
        const audits = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, "payment.offers.saved"));
        expect(audits.filter(row => row.revision === current.revision + 1 || row.revision === current.revision + 2)).toHaveLength(2);
        const raw = JSON.stringify(read);
        for (const forbidden of [merchantKey, "ciphertext", "nonce", "authTag", "notifyUrl"]) expect(raw).not.toContain(forbidden);
        expect(createCalls).toBe(beforeCreate); expect(queryCalls).toBe(beforeQueryCount);
    });
});
