import { eq, sql } from "drizzle-orm";
import { isIP } from "node:net";
import { z } from "zod";
import type { Database } from "@infinite-canvas/database";
import { auditEvent, paymentMerchantVersion, paymentSettings, walletLedger } from "@infinite-canvas/database/schema";
import { createWalletRepository, WalletOperationError } from "@infinite-canvas/database/wallet";
import { decryptProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { normalizeCreditAmount, type JsonObject } from "@infinite-canvas/shared";
import type { AdminPaymentMerchant, AdminPaymentOrderView, PaymentConfigurationView, PaymentOrderView } from "../../../packages/shared/src/payment-platform";
import { assertSafetyActor } from "../../../packages/database/src/account-moderation";
import { createPaymentRepository, PaymentOperationError, type PaymentActor } from "../../../packages/database/src/payments";
import { rethrowModerationError } from "./account-moderation-contract";
import { HttpError, readBytes } from "./http";
import type { PaymentRuntimeConfig } from "./payment-config";
import { createZpayPaymentClient } from "./payment-provider-client";
import { validatePaymentJson } from "./payment-provider-json";
import { parseZpayPaymentNotification, type ZpayExpectedOrder, type ZpayNotificationResult } from "./payment-provider-notification";

export type PaymentRouteContext = { actor: PaymentActor; role: "user" | "admin"; peerIp?: string; documentBytes: number };
export type PaymentRouteResult = { data: Record<string, unknown>; status?: number };
type Repository = ReturnType<typeof createPaymentRepository>;
type Order = NonNullable<Awaited<ReturnType<Repository["getOrder"]>>>;
type Merchant = NonNullable<Awaited<ReturnType<Repository["loadMerchant"]>>>;
const revision = z.number().int().min(0).max(2_147_483_647);
const merchantWrite = z.strictObject({ expectedRevision: revision, merchantId: z.string().min(1), merchantKey: z.string().min(1),
    paymentType: z.enum(["alipay", "wxpay"]), channelId: z.string().min(1).optional(), productName: z.string().min(1) });
const offerWrite = z.strictObject({ expectedRevision: revision, newOrdersEnabled: z.boolean(), items: z.array(z.strictObject({
    id: z.uuid(), offerId: z.uuid(), revision: revision.min(1), label: z.string().min(1), amountMinor: z.string().regex(/^[1-9]\d*$/),
    creditUnits: z.string().min(1), policyReference: z.string().min(1).optional(),
})) });
const orderWrite = z.strictObject({ offerVersionId: z.uuid(), paymentType: z.enum(["alipay", "wxpay"]) });
const emptyWrite = z.strictObject({});
const unavailable = () => new HttpError(503, "payment_unavailable", "支付尚未开放或状态尚未确认，请保留原订单核对");
const notFound = () => new HttpError(404, "payment_not_found", "支付订单不存在");
const inputError = () => new HttpError(400, "invalid_input", "请核对支付字段与原订单编号");
function creditAmount(value: string): string {
    const normalized = normalizeCreditAmount(value);
    if (normalized === null) throw unavailable();
    return normalized;
}
const acknowledgement = (text: string, status: number) => new Response(text, { status, headers: {
    "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
} });

function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
    const result = schema.safeParse(input);
    if (!result.success) throw inputError();
    return result.data;
}
async function body<T extends z.ZodType>(request: Request, maxBytes: number, schema: T): Promise<z.infer<T>> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) {
        throw new HttpError(415, "unsupported_media_type", "请使用未压缩的 JSON 请求");
    }
    const bytes = await readBytes(request, maxBytes);
    let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw inputError(); }
    if (!validatePaymentJson(raw).ok) throw inputError();
    return parseInput(schema, JSON.parse(raw));
}
function pathId(value: string): string {
    try { return parseInput(z.uuid(), decodeURIComponent(value)).toLowerCase(); }
    catch { throw inputError(); }
}
function actor(context: PaymentRouteContext, admin = false) {
    if (!context.actor?.actorId || !context.actor.sessionId || !(context.actor.sessionExpiresAt instanceof Date) ||
        !Number.isFinite(context.actor.sessionExpiresAt.getTime()) || context.actor.sessionExpiresAt <= new Date()) throw new HttpError(401, "unauthorized", "请重新登录");
    if (admin && context.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
}
function expected(row: Order): ZpayExpectedOrder {
    return { provider: "zpay", merchantId: row.merchantId, merchantOrderId: row.merchantOrderId, currency: "CNY",
        amountMinor: row.amountMinor, paymentType: row.paymentType, ...(row.providerTradeNo === null ? {} : { providerTradeNo: row.providerTradeNo }) };
}
function rethrow(error: unknown): never {
    if (error instanceof HttpError) throw error;
    if (error instanceof PaymentOperationError) throw new HttpError(error.code === "payment_invalid" ? 400 : error.code === "payment_not_found" ? 404 :
        error.code === "payment_unavailable" ? 503 : 409, error.code, "支付操作未确认，请核对当前配置或原订单");
    if (error instanceof WalletOperationError) throw new HttpError(409, error.code, "充值账务尚未确认，请保留原订单核对");
    try { rethrowModerationError(error); }
    catch (mapped) { if (mapped instanceof HttpError) throw mapped; throw unavailable(); }
}

/** Accounts supplies the authenticated actor, role and trusted peer IP; callback routing is exact. */
export function createPaymentPlatform(options: { database: Database; secret: string; origin: string; config: PaymentRuntimeConfig; fetcher?: typeof fetch }) {
    const { database, secret, origin, fetcher } = options;
    const config: PaymentRuntimeConfig = options.config.enabled ? Object.freeze({ ...options.config,
        paymentLinkOrigins: Object.freeze([...options.config.paymentLinkOrigins]) }) : { enabled: false };
    const repository = createPaymentRepository(database, secret);
    const wallet = createWalletRepository(database);
    function enabled() { if (!config.enabled) throw unavailable(); return config; }
    function client(merchant: Merchant) {
        const safety = enabled();
        return createZpayPaymentClient({ merchantId: merchant.merchantId, merchantKey: merchant.merchantKey, notifyUrl: merchant.notifyUrl,
            timeoutMs: safety.timeoutMs, maxResponseBytes: safety.maxResponseBytes, paymentLinkOrigins: safety.paymentLinkOrigins }, fetcher);
    }
    async function loadMerchant(row: Order) {
        const merchant = await repository.loadMerchant(row.merchantVersionId);
        if (!merchant || merchant.merchantId !== row.merchantId || merchant.paymentType !== row.paymentType) throw unavailable();
        return merchant;
    }
    function merchantReceipt(row: Pick<Merchant, "id" | "merchantId" | "paymentType" | "channelId" | "productName" | "keyVersion" | "ciphertext">): AdminPaymentMerchant {
        return { id: row.id, merchantId: row.merchantId, paymentType: row.paymentType, channelId: row.channelId,
            productName: row.productName, credentialConfigured: row.keyVersion === 1 && row.ciphertext.length > 0 };
    }
    function orderView(row: Order, admin: true): AdminPaymentOrderView;
    function orderView(row: Order, admin?: false): PaymentOrderView;
    function orderView(row: Order, admin = false): PaymentOrderView | AdminPaymentOrderView {
        const paymentLinks: Record<string, string> = {};
        if (config.enabled && row.paymentLinks) for (const key of ["payurl", "payurl2", "qrcode", "img"]) {
            const value = row.paymentLinks[key];
            if (typeof value !== "string") continue;
            try {
                const url = new URL(value);
                if (url.protocol === "https:" && !url.username && !url.password && config.paymentLinkOrigins.includes(url.origin)) paymentLinks[key] = url.href;
            } catch { /* Corrupt delivery fields are never forwarded. */ }
        }
        const core: PaymentOrderView = { id: row.id, currency: row.currency, amountMinor: row.amountMinor, creditUnits: creditAmount(row.creditUnits),
            paymentType: row.paymentType, createState: row.createState, paymentState: row.paymentState, creditState: row.creditState,
            refundState: row.refundState, paymentLinks, creditedAt: row.creditedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastReason: row.lastReason };
        return admin ? { ...core, ownerId: row.ownerId, merchantVersionId: row.merchantVersionId, merchantOrderId: row.merchantOrderId,
            providerTradeNo: row.providerTradeNo, providerOrderId: row.providerOrderId, creditedLedgerId: row.creditedLedgerId } : core;
    }
    async function configuration(): Promise<PaymentConfigurationView> {
        const settings = await repository.getSettings();
        const [merchant] = settings.merchantVersionId ? await database.select({ id: paymentMerchantVersion.id, merchantId: paymentMerchantVersion.merchantId,
            paymentType: paymentMerchantVersion.paymentType, channelId: paymentMerchantVersion.channelId, productName: paymentMerchantVersion.productName,
            credentialConfigured: sql<boolean>`${paymentMerchantVersion.keyVersion} = 1 AND length(${paymentMerchantVersion.ciphertext}) > 0`,
        }).from(paymentMerchantVersion).where(eq(paymentMerchantVersion.id, settings.merchantVersionId)) : [];
        const offers = (await repository.getOffers(settings.offerVersionIds)).map(row => ({ id: row.id, offerId: row.offerId, revision: row.revision,
            label: row.label, amountMinor: row.amountMinor, creditUnits: creditAmount(row.creditUnits), policyReference: row.policyReference }));
        return { runtimeEnabled: config.enabled, revision: settings.revision, newOrdersEnabled: settings.newOrdersEnabled, merchant: merchant ?? null, offers };
    }
    async function observe(row: Order, merchant: Merchant, requestId: string, notice?: ZpayNotificationResult, context?: PaymentRouteContext) {
        const observed = await client(merchant).query(expected(row), notice);
        const event = context ? await database.transaction(async tx => {
            await assertSafetyActor(tx, context.actor, context.role === "admin");
            return createPaymentRepository(tx, secret).recordQuery(row.id, observed.result as JsonObject, observed.jsonMemberUniqueness, requestId);
        }) : await repository.recordQuery(row.id, observed.result as JsonObject, observed.jsonMemberUniqueness, requestId);
        return { ...observed, event };
    }
    async function replayProof(row: Order, notificationEventId: string) {
        if (row.creditState !== "credited" || !row.creditedLedgerId) return false;
        const [ledger] = await database.select({ metadata: walletLedger.metadata }).from(walletLedger).where(eq(walletLedger.id, row.creditedLedgerId));
        const metadata = ledger?.metadata;
        if (!metadata || metadata.notificationEventId !== notificationEventId || typeof metadata.queryEventId !== "string") return false;
        await wallet.rechargePaymentOrder(row.id, { notificationEventId, queryEventId: metadata.queryEventId });
        return true;
    }
    async function review(row: Order, code: string, context: PaymentRouteContext) {
        await database.transaction(async tx => {
            await assertSafetyActor(tx, context.actor, true);
            await createPaymentRepository(tx, secret).recordReview(row.id, code, context.actor.requestId);
        });
        return { data: { order: orderView((await repository.getOrder(row.id))!, true) }, status: 202 };
    }
    async function reconcile(row: Order, context: PaymentRouteContext): Promise<PaymentRouteResult> {
        enabled();
        await database.transaction(tx => assertSafetyActor(tx, context.actor, true));
        const saved = await repository.recentSuccessfulNotification(row.id);
        if (!saved) return review(row, "missing_success_notification", context);
        let merchant: Merchant, notice: ZpayNotificationResult;
        try {
            merchant = await loadMerchant(row);
            if (!saved.eventIdentity || !saved.ciphertext || !saved.nonce || !saved.authTag || saved.keyVersion !== 1) throw new Error();
            const raw = decryptProviderCredential(secret, `payment-notice:${saved.eventIdentity}`, { ciphertext: saved.ciphertext,
                nonce: saved.nonce, authTag: saved.authTag, keyVersion: 1 });
            notice = parseZpayPaymentNotification(raw, expected(row), merchant.merchantKey);
        } catch { return review(row, "notification_revalidation_unavailable", context); }
        if (!notice.ok || notice.notification.kind !== "payment_success_notification" || notice.notification.eventIdentity !== saved.eventIdentity) {
            return review(row, "notification_revalidation_conflict", context);
        }
        const observed = await observe(row, merchant, context.actor.requestId, notice, context);
        if (observed.jsonMemberUniqueness !== "checked_unique" || observed.result.status !== "paid") {
            return review(row, "payment_query_unconfirmed", context);
        }
        await database.transaction(async tx => {
            await assertSafetyActor(tx, context.actor, true);
            const result = await createWalletRepository(tx).rechargePaymentOrder(row.id, { notificationEventId: saved.id, queryEventId: observed.event.id });
            await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: context.actor.actorId, action: "payment.reconciled",
                resourceId: row.id, revision: result.wallet.version, requestId: context.actor.requestId });
        });
        return { data: { order: orderView((await repository.getOrder(row.id))!, true) } };
    }

    async function handleNotification(request: Request, requestId: string): Promise<Response | null> {
        const url = new URL(request.url), match = url.pathname.match(/^\/api\/v1\/payments\/zpay\/notify\/([^/]+)$/);
        if (!match) return null;
        if (request.method !== "GET") return acknowledgement("method_not_allowed", 405);
        if (!config.enabled) return acknowledgement("payment_unavailable", 503);
        try {
            const merchant = await repository.loadMerchant(pathId(match[1]!));
            if (!merchant) return acknowledgement("payment_unavailable", 503);
            const raw = url.search.slice(1);
            const merchantOrderId = new URLSearchParams(raw).get("out_trade_no");
            const row = merchantOrderId ? await repository.getByMerchantOrder(merchant.id, merchantOrderId) : null;
            const verified = parseZpayPaymentNotification(raw, row ? expected(row) : null, merchant.merchantKey);
            if (!verified.ok || !row) return acknowledgement("notification_rejected", 400);
            const event = await repository.recordNotification(row.id, verified.notification, raw, requestId);
            if (verified.notification.kind !== "payment_success_notification") return acknowledgement("observed", 202);
            if (await replayProof(row, event.id)) return acknowledgement("success", 200);
            const observed = await observe(row, merchant, requestId, verified);
            if (observed.jsonMemberUniqueness !== "checked_unique" || observed.result.status !== "paid") return acknowledgement("pending_review", 503);
            await wallet.rechargePaymentOrder(row.id, { notificationEventId: event.id, queryEventId: observed.event.id });
            return acknowledgement("success", 200);
        } catch { return acknowledgement("pending_review", 503); }
    }

    async function handleAccountRequest(request: Request, context: PaymentRouteContext): Promise<PaymentRouteResult | null> {
        const url = new URL(request.url), path = url.pathname;
        const adminConfig = path === "/api/v1/admin/payments/config", merchantPath = path === "/api/v1/admin/payments/merchant";
        const merchantOperation = path.match(/^\/api\/v1\/admin\/payments\/merchant-operations\/([^/]+)$/);
        const offersPath = path === "/api/v1/admin/payments/offers", publicOffers = path === "/api/v1/payments/offers";
        const createPath = path === "/api/v1/payments/orders";
        const byKey = path.match(/^\/api\/v1\/payments\/orders\/by-key\/([^/]+)$/);
        const ownOrder = path.match(/^\/api\/v1\/payments\/orders\/([^/]+)(\/query)?$/);
        const adminOrder = path.match(/^\/api\/v1\/admin\/payments\/orders\/([^/]+)(\/reconcile)?$/);
        if (!adminConfig && !merchantPath && !merchantOperation && !offersPath && !publicOffers && !createPath && !byKey && !ownOrder && !adminOrder) return null;
        try {
            actor(context, adminConfig || merchantPath || !!merchantOperation || offersPath || !!adminOrder);
            if (url.search) throw inputError();
            const method = merchantPath || offersPath ? "PUT" : createPath || ownOrder?.[2] || adminOrder?.[2] ? "POST" : "GET";
            if (request.method !== method) throw new HttpError(405, "method_not_allowed", "不支持此操作");
            if (adminConfig) return { data: { config: await configuration() } };
            if (merchantOperation) {
                const receipt = await repository.getMerchantOperation(pathId(merchantOperation[1]!), context.actor);
                if (!receipt) throw notFound();
                return { data: { receipt } };
            }
            if (merchantPath) {
                const operationId = parseInput(z.uuid(), request.headers.get("idempotency-key")).toLowerCase();
                const saved = await repository.saveMerchant(await body(request, context.documentBytes, merchantWrite), context.actor, origin, operationId);
                return { data: { config: await configuration(), receipt: merchantReceipt(saved.merchant) } };
            }
            if (offersPath) {
                await repository.saveOffers(await body(request, context.documentBytes, offerWrite), context.actor);
                return { data: { config: await configuration() } };
            }
            if (publicOffers) {
                enabled();
                const current = await configuration(), available = current.newOrdersEnabled && !!current.merchant?.credentialConfigured;
                return { data: { available, offers: available ? current.offers.map(row => ({ id: row.id, label: row.label,
                    amountMinor: row.amountMinor, creditUnits: row.creditUnits, paymentType: current.merchant!.paymentType })) : [] } };
            }
            if (createPath) {
                enabled();
                const input = await body(request, context.documentBytes, orderWrite), createKey = request.headers.get("idempotency-key");
                if (!createKey || createKey.trim() !== createKey || /[\u0000-\u001f\u007f-\u009f]/.test(createKey)) throw inputError();
                if (!context.peerIp || !isIP(context.peerIp)) throw inputError();
                const accepted = await database.transaction(async tx => {
                    await assertSafetyActor(tx, context.actor, false);
                    const repo = createPaymentRepository(tx, secret);
                    const result = await repo.createOrder({ ownerId: context.actor.actorId, offerVersionId: input.offerVersionId, paymentType: input.paymentType, createKey });
                    // Replayed pending orders also share-lock admission until the attempt claim commits.
                    await repo.getSettings();
                    const [settings] = await tx.select({ newOrdersEnabled: paymentSettings.newOrdersEnabled }).from(paymentSettings)
                        .where(eq(paymentSettings.id, "zpay")).for("share");
                    return { ...result, claim: settings?.newOrdersEnabled ? await repo.claimCreate(result.order.id) : null };
                });
                let row = accepted.order;
                if (accepted.claim) {
                    let result: Awaited<ReturnType<ReturnType<typeof createZpayPaymentClient>["create"]>>;
                    try {
                        const merchant = await loadMerchant(accepted.claim.order);
                        result = await client(merchant).create({ expected: expected(accepted.claim.order), name: accepted.claim.order.productName,
                            clientIp: context.peerIp, ...(accepted.claim.order.channelId === null ? {} : { channelId: accepted.claim.order.channelId }) });
                    } catch { result = { status: "unknown", code: "merchant_unavailable" }; }
                    row = await repository.updateCreate(row.id, accepted.claim.token, result);
                }
                return { data: { order: orderView(row) }, status: accepted.created ? 201 : 200 };
            }
            if (byKey) {
                let key: string;
                try { key = decodeURIComponent(byKey[1]!); } catch { throw inputError(); }
                const row = await repository.getByKey(context.actor.actorId, key);
                if (!row) throw notFound();
                return { data: { order: orderView(row) } };
            }
            if (ownOrder) {
                if (ownOrder[2]) enabled();
                const row = await repository.getForOwner(context.actor.actorId, pathId(ownOrder[1]!));
                if (!row) throw notFound();
                if (ownOrder[2]) {
                    if (request.body) await body(request, context.documentBytes, emptyWrite);
                    await database.transaction(tx => assertSafetyActor(tx, context.actor, false));
                    await observe(row, await loadMerchant(row), context.actor.requestId, undefined, context);
                }
                return { data: { order: orderView((await repository.getForOwner(context.actor.actorId, row.id))!) } };
            }
            if (adminOrder) {
                if (adminOrder[2]) enabled();
                const row = await repository.getOrder(pathId(adminOrder[1]!));
                if (!row) throw notFound();
                if (adminOrder[2]) {
                    if (request.body) await body(request, context.documentBytes, emptyWrite);
                    return await reconcile(row, context);
                }
                return { data: { order: orderView(row, true) } };
            }
            return null;
        } catch (error) { rethrow(error); }
    }
    return { handleNotification, handleAccountRequest };
}
