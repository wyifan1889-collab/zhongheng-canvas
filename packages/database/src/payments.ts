import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { compareCreditAmounts, normalizeCreditAmount, type JsonObject } from "@infinite-canvas/shared";
import type { AdminPaymentMerchant } from "../../shared/src/payment-platform";
import type { Database } from "./client";
import { assertSafetyActor } from "./account-moderation";
import { decryptProviderCredential, encryptProviderCredential } from "./provider-credentials";
import { auditEvent, paymentEvent, paymentMerchantVersion, paymentOfferVersion, paymentOrder, paymentSettings, session, user } from "./schema";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;
type Order = typeof paymentOrder.$inferSelect;
type Offer = typeof paymentOfferVersion.$inferSelect;
export type PaymentActor = { actorId: string; sessionId: string; sessionExpiresAt: Date; requestId: string };
export type PaymentMerchantWrite = { expectedRevision: number; merchantId: string; merchantKey: string;
    paymentType: "alipay" | "wxpay"; channelId?: string; productName: string };
export type PaymentOfferWrite = { id: string; offerId: string; revision: number; label: string;
    amountMinor: string; creditUnits: string; policyReference?: string };
export type PaymentCreateResult = { status: "accepted"; providerTradeNo: string; providerOrderId?: string; paymentLinks: Record<string, string> }
    | { status: "rejected" | "unknown"; code: string };
export class PaymentOperationError extends Error {
    constructor(readonly code: "payment_invalid" | "payment_config_conflict" | "payment_unavailable" | "payment_not_found" |
        "payment_idempotency_conflict" | "payment_evidence_conflict" | "payment_attempt_conflict" | "account_changed", message: string) { super(message); }
}
const protocol = "zpay-epay-md5-doc-03b0f9fb1ff6";
const invalid = () => new PaymentOperationError("payment_invalid", "支付字段或格式不正确");
const configConflict = () => new PaymentOperationError("payment_config_conflict", "支付配置已变化，请读取后核对");
const evidenceConflict = () => new PaymentOperationError("payment_evidence_conflict", "支付证据与原订单不一致，请保留原单核对");
const unavailable = () => new PaymentOperationError("payment_unavailable", "支付配置尚未满足新订单条件");
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const revision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
const type = (value: unknown): value is "alipay" | "wxpay" => value === "alipay" || value === "wxpay";
const minor = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const reason = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value);
function credits(value: unknown): value is string {
    return typeof value === "string" && normalizeCreditAmount(value) === value && compareCreditAmounts(value, "0") > 0;
}
function id(value: string): string { if (!uuid(value)) throw invalid(); return value.toLowerCase(); }
function sameOffer(row: Offer, input: PaymentOfferWrite) {
    return row.offerId === input.offerId && row.revision === input.revision && row.label === input.label &&
        row.amountMinor === input.amountMinor && normalizeCreditAmount(row.creditUnits) === input.creditUnits &&
        row.policyReference === (input.policyReference ?? null);
}

/** Share user before session, matching Q1 revocation's canonical lock order. */
async function activeActor(tx: Tx, actor: PaymentActor) {
    const [owner] = await tx.select().from(user).where(eq(user.id, actor.actorId)).for("share");
    const [current] = await tx.select().from(session)
        .where(and(eq(session.id, actor.sessionId), eq(session.userId, actor.actorId))).for("share");
    const now = new Date();
    if (!owner || owner.role !== "admin" || owner.disabled || !owner.emailVerified || !revision(owner.moderationVersion) ||
        !current || current.expiresAt <= now || current.moderationVersion !== owner.moderationVersion ||
        !(actor.sessionExpiresAt instanceof Date) || !Number.isFinite(actor.sessionExpiresAt.getTime()) || actor.sessionExpiresAt <= now) {
        throw new PaymentOperationError("account_changed", "登录状态已变化，请重新确认账号");
    }
    if (!text(actor.requestId)) throw invalid();
}
async function settings(db: Db, lock?: "share" | "update") {
    await db.insert(paymentSettings).values({ id: "zpay" }).onConflictDoNothing();
    const query = db.select().from(paymentSettings).where(eq(paymentSettings.id, "zpay"));
    const [row] = await (lock ? query.for(lock) : query);
    if (!row) throw unavailable();
    return row;
}
async function order(db: Db, orderId: string, lock = false) {
    const query = db.select().from(paymentOrder).where(eq(paymentOrder.id, id(orderId))).limit(1);
    const [row] = await (lock ? query.for("update") : query);
    return row ?? null;
}
async function requiredOrder(tx: Tx, orderId: string) {
    const row = await order(tx, orderId, true);
    if (!row) throw new PaymentOperationError("payment_not_found", "支付订单不存在");
    return row;
}
function sameCreate(row: Order, offerVersionId: string, paymentType: string) {
    if (row.offerVersionId !== offerVersionId || row.paymentType !== paymentType) {
        throw new PaymentOperationError("payment_idempotency_conflict", "创建编号已用于其他充值选择，请核对原订单");
    }
    return { order: row, created: false };
}
function bound(core: JsonObject, row: Order) {
    return core.provider === row.provider && core.currency === row.currency && core.merchantId === row.merchantId &&
        core.merchantOrderId === row.merchantOrderId && core.paymentType === row.paymentType &&
        typeof core.amountMinor === "string" && core.amountMinor === row.amountMinor && identifier(core.providerTradeNo) &&
        (row.providerTradeNo === null || core.providerTradeNo === row.providerTradeNo);
}
function notificationEvidence(value: JsonObject, row: Order): JsonObject {
    if (!object(value) || !bound(value, row) || value.protocol !== protocol || !identifier(value.tradeStatus) ||
        value.kind !== (value.tradeStatus === "TRADE_SUCCESS" ? "payment_success_notification" : "unrecognized_status_notification") ||
        value.orderIdentity !== JSON.stringify(["zpay", row.merchantId, row.merchantOrderId]) ||
        value.eventIdentity !== JSON.stringify(["zpay", row.merchantId, value.providerTradeNo, value.tradeStatus])) throw evidenceConflict();
    return { protocol, provider: "zpay", kind: value.kind, merchantId: row.merchantId,
        merchantOrderId: row.merchantOrderId, providerTradeNo: value.providerTradeNo, paymentType: row.paymentType,
        currency: "CNY", amountMinor: row.amountMinor, tradeStatus: value.tradeStatus, orderIdentity: value.orderIdentity, eventIdentity: value.eventIdentity };
}
function sameNotification(left: JsonObject, right: JsonObject) {
    return Object.keys(left).length === Object.keys(right).length && Object.keys(right).every(key => left[key] === right[key]);
}
function queryEvidence(result: JsonObject, row: Order, uniqueness: "checked_unique" | "rejected"): JsonObject {
    if (uniqueness !== "checked_unique" && uniqueness !== "rejected") throw invalid();
    if (uniqueness === "rejected") {
        if (result.status !== "unknown" || !reason(result.code)) throw invalid();
        return { status: "unknown", jsonMemberUniqueness: uniqueness, code: result.code };
    }
    if (result.status === "unknown") {
        if (!reason(result.code)) throw invalid();
        return { status: "unknown", jsonMemberUniqueness: uniqueness, code: result.code };
    }
    const e = result.evidence;
    if ((result.status !== "paid" && result.status !== "unpaid") || !object(e) || !bound(e, row) ||
        e.source !== "zpay-order-query-doc-03b0f9fb1ff6" || e.level !== "bound_query_observation" || e.jsonMemberUniqueness !== "not_checked" ||
        e.orderIdentity !== JSON.stringify(["zpay", row.merchantId, row.merchantOrderId]) ||
        e.paymentIdentity !== JSON.stringify(["zpay", row.merchantId, e.providerTradeNo])) throw evidenceConflict();
    let notice: JsonObject | null = null;
    if (e.notification !== null) {
        if (!object(e.notification) || !["payment_success_notification", "unrecognized_status_notification"].includes(String(e.notification.kind)) ||
            typeof e.notification.eventIdentity !== "string" || (result.status === "unpaid" && e.notification.kind === "payment_success_notification")) throw evidenceConflict();
        if (e.notification.kind === "payment_success_notification" &&
            e.notification.eventIdentity !== JSON.stringify(["zpay", row.merchantId, e.providerTradeNo, "TRADE_SUCCESS"])) throw evidenceConflict();
        notice = { kind: e.notification.kind, eventIdentity: e.notification.eventIdentity };
    }
    return { status: result.status, jsonMemberUniqueness: uniqueness, evidence: {
        source: e.source, level: e.level, jsonMemberUniqueness: "not_checked", provider: "zpay", merchantId: row.merchantId,
        merchantOrderId: row.merchantOrderId, providerTradeNo: e.providerTradeNo, paymentType: row.paymentType, currency: "CNY",
        amountMinor: row.amountMinor, orderIdentity: e.orderIdentity, paymentIdentity: e.paymentIdentity, notification: notice,
    } };
}
function tradeConflict(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const failure = error as { code?: unknown; constraint?: unknown; cause?: unknown };
    return failure.code === "23505" && failure.constraint === "payment_order_merchant_transaction" ||
        failure.cause !== undefined && failure.cause !== error && tradeConflict(failure.cause);
}

/** Server-only storage. Observing paid never grants authority to credit a wallet. */
export function createPaymentRepository(db: Database, secret: string) {
    if (typeof secret !== "string" || secret.length < 32) throw new PaymentOperationError("payment_unavailable", "支付凭据加密配置不可用");
    return {
        getSettings: () => settings(db),
        async getOffers(ids?: string[]) {
            const chosen = (ids === undefined ? (await settings(db)).offerVersionIds : ids).map(id);
            if (!chosen.length) return [];
            const rows = await db.select().from(paymentOfferVersion).where(inArray(paymentOfferVersion.id, chosen));
            const byId = new Map(rows.map(row => [row.id, row]));
            return chosen.map(versionId => {
                const row = byId.get(versionId);
                if (!row) throw unavailable();
                return row;
            });
        },
        getOrder: (orderId: string) => order(db, orderId),
        async getForOwner(ownerId: string, orderId: string) {
            const [row] = await db.select().from(paymentOrder).where(and(eq(paymentOrder.id, id(orderId)), eq(paymentOrder.ownerId, ownerId))).limit(1);
            return row ?? null;
        },
        async getByKey(ownerId: string, key: string) {
            const [row] = await db.select().from(paymentOrder).where(and(eq(paymentOrder.ownerId, ownerId), eq(paymentOrder.createKey, key))).limit(1);
            return row ?? null;
        },
        async getByMerchantOrder(merchantVersionId: string, merchantOrderId: string) {
            const [row] = await db.select().from(paymentOrder).where(and(eq(paymentOrder.merchantVersionId, id(merchantVersionId)), eq(paymentOrder.merchantOrderId, merchantOrderId))).limit(1);
            return row ?? null;
        },
        async loadMerchant(merchantVersionId: string) {
            const [row] = await db.select().from(paymentMerchantVersion).where(eq(paymentMerchantVersion.id, id(merchantVersionId))).limit(1);
            if (!row) return null;
            if (row.keyVersion !== 1) throw unavailable();
            return { ...row, merchantKey: decryptProviderCredential(secret, `payment-merchant:${row.id}`, { ...row, keyVersion: 1 }) };
        },
        async getMerchantOperation(operationId: string, actor: PaymentActor): Promise<AdminPaymentMerchant | null> {
            const operation = id(operationId);
            return db.transaction(async tx => {
                await assertSafetyActor(tx, actor, true);
                const [receipt] = await tx.select({ id: paymentMerchantVersion.id, merchantId: paymentMerchantVersion.merchantId,
                    paymentType: paymentMerchantVersion.paymentType, channelId: paymentMerchantVersion.channelId, productName: paymentMerchantVersion.productName,
                    credentialConfigured: sql<boolean>`${paymentMerchantVersion.keyVersion} = 1 AND length(${paymentMerchantVersion.ciphertext}) > 0`,
                }).from(paymentMerchantVersion).where(and(eq(paymentMerchantVersion.id, operation), eq(paymentMerchantVersion.actorId, actor.actorId))).limit(1);
                return receipt ?? null;
            });
        },
        async saveMerchant(input: PaymentMerchantWrite, actor: PaymentActor, origin: string, operationId?: string) {
            if (!revision(input.expectedRevision) || !identifier(input.merchantId) || typeof input.merchantKey !== "string" || !input.merchantKey ||
                !type(input.paymentType) || !text(input.productName) || input.productName.includes("&") ||
                input.channelId !== undefined && (!text(input.channelId) || input.channelId.includes("&"))) throw invalid();
            let site: URL;
            try { site = new URL(origin); } catch { throw invalid(); }
            if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash) throw invalid();
            const merchantId = operationId === undefined ? crypto.randomUUID() : id(operationId);
            return db.transaction(async tx => {
                await activeActor(tx, actor);
                async function replay() {
                    const [merchant] = await tx.select().from(paymentMerchantVersion).where(eq(paymentMerchantVersion.id, merchantId)).limit(1);
                    if (!merchant) return null;
                    if (merchant.actorId !== actor.actorId || merchant.merchantId !== input.merchantId || merchant.protocol !== protocol || merchant.currency !== "CNY" ||
                        merchant.paymentType !== input.paymentType || merchant.channelId !== (input.channelId ?? null) || merchant.productName !== input.productName ||
                        merchant.notifyUrl !== `${site.origin}/api/v1/payments/zpay/notify/${merchantId}`) throw configConflict();
                    const [audit] = await tx.select({ revision: auditEvent.revision }).from(auditEvent).where(and(eq(auditEvent.resourceId, merchantId),
                        eq(auditEvent.actorId, actor.actorId), eq(auditEvent.action, "payment.merchant.saved"))).limit(1);
                    if (!audit || audit.revision !== input.expectedRevision + 1) throw configConflict();
                    let originalKey: string;
                    try {
                        if (merchant.keyVersion !== 1) throw new Error();
                        originalKey = decryptProviderCredential(secret, `payment-merchant:${merchantId}`, { ...merchant, keyVersion: 1 });
                    } catch { throw unavailable(); }
                    if (originalKey !== input.merchantKey) throw configConflict();
                    return merchant;
                }
                const prior = await replay();
                if (prior) return { settings: await settings(tx), merchant: prior };
                const current = await settings(tx, "update");
                // The settings lock serializes first writes; a competing same operation may now exist.
                const raced = await replay();
                if (raced) return { settings: current, merchant: raced };
                if (current.revision !== input.expectedRevision || current.revision === 2_147_483_647) throw configConflict();
                const [merchant] = await tx.insert(paymentMerchantVersion).values({
                    id: merchantId, merchantId: input.merchantId, protocol, currency: "CNY", paymentType: input.paymentType,
                    channelId: input.channelId ?? null, productName: input.productName,
                    notifyUrl: `${site.origin}/api/v1/payments/zpay/notify/${merchantId}`, actorId: actor.actorId,
                    ...encryptProviderCredential(secret, `payment-merchant:${merchantId}`, input.merchantKey),
                }).returning();
                const nextRevision = current.revision + 1;
                const [next] = await tx.update(paymentSettings).set({ merchantVersionId: merchantId, revision: nextRevision, updatedAt: new Date() })
                    .where(and(eq(paymentSettings.id, "zpay"), eq(paymentSettings.revision, current.revision))).returning();
                if (!merchant || !next) throw configConflict();
                await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "payment.merchant.saved",
                    resourceId: merchantId, revision: nextRevision, requestId: actor.requestId });
                return { settings: next, merchant };
            });
        },
        async saveOffers(input: { expectedRevision: number; items: PaymentOfferWrite[]; newOrdersEnabled: boolean }, actor: PaymentActor) {
            if (!revision(input.expectedRevision) || typeof input.newOrdersEnabled !== "boolean" || !Array.isArray(input.items)) throw invalid();
            const items = input.items.map(item => {
                if (!object(item) || !uuid(item.id) || !uuid(item.offerId) || !revision(item.revision) || item.revision === 0 || !text(item.label) ||
                    !minor(item.amountMinor) || !credits(item.creditUnits) || item.policyReference !== undefined && !text(item.policyReference)) throw invalid();
                return { id: item.id.toLowerCase(), offerId: item.offerId.toLowerCase(), revision: item.revision, label: item.label,
                    amountMinor: item.amountMinor, creditUnits: item.creditUnits,
                    ...(item.policyReference !== undefined ? { policyReference: item.policyReference } : {}) };
            });
            if (new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => item.offerId)).size !== items.length) throw invalid();
            return db.transaction(async tx => {
                await activeActor(tx, actor);
                const current = await settings(tx, "update");
                if (current.revision !== input.expectedRevision || current.revision === 2_147_483_647) throw configConflict();
                if (input.newOrdersEnabled && (!current.merchantVersionId || !items.length || items.some(item => !item.policyReference))) throw unavailable();
                const offers: Offer[] = [];
                for (const item of items) {
                    await tx.insert(paymentOfferVersion).values({ ...item, policyReference: item.policyReference ?? null, actorId: actor.actorId }).onConflictDoNothing();
                    const [saved] = await tx.select().from(paymentOfferVersion).where(eq(paymentOfferVersion.id, item.id)).limit(1);
                    if (!saved || !sameOffer(saved, item)) throw configConflict();
                    offers.push(saved);
                }
                const nextRevision = current.revision + 1;
                const [next] = await tx.update(paymentSettings).set({ offerVersionIds: items.map(item => item.id), newOrdersEnabled: input.newOrdersEnabled,
                    revision: nextRevision, updatedAt: new Date() }).where(and(eq(paymentSettings.id, "zpay"), eq(paymentSettings.revision, current.revision))).returning();
                if (!next) throw configConflict();
                await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "payment.offers.saved",
                    resourceId: "zpay", revision: nextRevision, requestId: actor.requestId });
                return { settings: next, offers };
            });
        },
        async createOrder(input: { ownerId: string; offerVersionId: string; paymentType: "alipay" | "wxpay"; createKey: string }) {
            if (!text(input.ownerId) || !text(input.createKey) || !type(input.paymentType)) throw invalid();
            const offerId = id(input.offerVersionId);
            return db.transaction(async tx => {
                const [existing] = await tx.select().from(paymentOrder).where(and(eq(paymentOrder.ownerId, input.ownerId), eq(paymentOrder.createKey, input.createKey))).limit(1);
                if (existing) return sameCreate(existing, offerId, input.paymentType);
                const current = await settings(tx, "share");
                if (!current.newOrdersEnabled || !current.merchantVersionId || !current.offerVersionIds.includes(offerId)) throw unavailable();
                const [merchant] = await tx.select().from(paymentMerchantVersion).where(eq(paymentMerchantVersion.id, current.merchantVersionId)).limit(1);
                const [offer] = await tx.select().from(paymentOfferVersion).where(eq(paymentOfferVersion.id, offerId)).limit(1);
                if (!merchant || !offer || merchant.paymentType !== input.paymentType || !offer.policyReference ||
                    !minor(offer.amountMinor) || !credits(offer.creditUnits)) throw unavailable();
                const localId = crypto.randomUUID();
                const [created] = await tx.insert(paymentOrder).values({ id: localId, ownerId: input.ownerId, createKey: input.createKey,
                    provider: "zpay", merchantVersionId: merchant.id, offerVersionId: offer.id, merchantId: merchant.merchantId,
                    merchantOrderId: localId.replace(/-/g, ""), currency: "CNY", amountMinor: offer.amountMinor, creditUnits: offer.creditUnits,
                    paymentType: merchant.paymentType, productName: merchant.productName, channelId: merchant.channelId,
                }).onConflictDoNothing({ target: [paymentOrder.ownerId, paymentOrder.createKey] }).returning();
                if (created) return { order: created, created: true };
                const [replay] = await tx.select().from(paymentOrder).where(and(eq(paymentOrder.ownerId, input.ownerId), eq(paymentOrder.createKey, input.createKey))).limit(1);
                if (!replay) throw new PaymentOperationError("payment_idempotency_conflict", "创建编号状态未确认，请核对原订单");
                return sameCreate(replay, offerId, input.paymentType);
            });
        },
        async claimCreate(orderId: string) {
            return db.transaction(async tx => {
                const current = await requiredOrder(tx, orderId);
                if (current.createState !== "pending" || current.createAttemptToken !== null || current.creditState === "credited" || current.refundState !== "none") return null;
                const token = crypto.randomUUID();
                const [claimed] = await tx.update(paymentOrder).set({ createState: "attempting", createAttemptToken: token,
                    createAttemptedAt: new Date(), updatedAt: new Date() }).where(eq(paymentOrder.id, current.id)).returning();
                if (!claimed) throw new PaymentOperationError("payment_attempt_conflict", "原订单创建状态未确认");
                return { order: claimed, token };
            });
        },
        async updateCreate(orderId: string, token: string, result: PaymentCreateResult) {
            id(token);
            if (!result || typeof result !== "object") throw invalid();
            if (result.status === "accepted") {
                if (!identifier(result.providerTradeNo) || result.providerOrderId !== undefined && !text(result.providerOrderId) || !object(result.paymentLinks) ||
                    Object.entries(result.paymentLinks).some(([key, value]) => !["payurl", "payurl2", "qrcode", "img"].includes(key) || !text(value))) throw invalid();
            } else if (!result || !["rejected", "unknown"].includes(result.status) || !reason(result.code)) throw invalid();
            return db.transaction(async tx => {
                const current = await requiredOrder(tx, orderId);
                if (current.createAttemptToken !== token.toLowerCase()) throw new PaymentOperationError("payment_attempt_conflict", "创建回执不属于原订单尝试");
                if (result.status === "accepted" && current.providerTradeNo !== null && current.providerTradeNo !== result.providerTradeNo) throw evidenceConflict();
                if (current.createState !== "attempting" || current.creditState === "credited") return current;
                try {
                    return await tx.transaction(async savepoint => {
                        const [saved] = await savepoint.update(paymentOrder).set(result.status === "accepted"
                            ? { createState: "accepted", providerTradeNo: result.providerTradeNo, providerOrderId: result.providerOrderId ?? null,
                                paymentLinks: result.paymentLinks, lastReason: null, updatedAt: new Date() }
                            : { createState: result.status, lastReason: result.code, updatedAt: new Date() })
                            .where(eq(paymentOrder.id, current.id)).returning();
                        if (!saved) throw new PaymentOperationError("payment_attempt_conflict", "原订单创建状态未确认");
                        return saved;
                    });
                } catch (error) {
                    if (!tradeConflict(error)) throw error;
                    const [saved] = await tx.update(paymentOrder).set({ createState: "unknown", lastReason: "provider_trade_conflict", updatedAt: new Date() })
                        .where(eq(paymentOrder.id, current.id)).returning();
                    if (!saved) throw evidenceConflict();
                    return saved;
                }
            });
        },
        async recordNotification(orderId: string, notification: JsonObject, rawQuery: string, requestId: string) {
            if (typeof rawQuery !== "string" || !rawQuery || !text(requestId)) throw invalid();
            return db.transaction(async tx => {
                const current = await requiredOrder(tx, orderId);
                const evidence = notificationEvidence(notification, current), eventIdentity = evidence.eventIdentity;
                if (typeof eventIdentity !== "string") throw evidenceConflict();
                const outcome = evidence.kind === "payment_success_notification" ? "verified_success" : "unrecognized_status";
                const encrypted = encryptProviderCredential(secret, `payment-notice:${eventIdentity}`, rawQuery);
                const [created] = await tx.insert(paymentEvent).values({ id: crypto.randomUUID(), orderId: current.id, kind: "notification",
                    eventIdentity, outcome, evidence, requestId, ...encrypted }).onConflictDoNothing().returning();
                if (created) return created;
                const [existing] = await tx.select().from(paymentEvent).where(and(eq(paymentEvent.kind, "notification"), eq(paymentEvent.eventIdentity, eventIdentity))).limit(1);
                if (!existing || existing.orderId !== current.id || existing.outcome !== outcome || !sameNotification(existing.evidence, evidence)) throw evidenceConflict();
                return existing;
            });
        },
        async recordQuery(orderId: string, result: JsonObject, uniqueness: "checked_unique" | "rejected", requestId: string) {
            if (!object(result) || !text(requestId)) throw invalid();
            return db.transaction(async tx => {
                const current = await requiredOrder(tx, orderId), evidence = queryEvidence(result, current, uniqueness);
                const [event] = await tx.insert(paymentEvent).values({ id: crypto.randomUUID(), orderId: current.id, kind: "query",
                    outcome: String(evidence.status), evidence, requestId }).returning();
                if (!event) throw evidenceConflict();
                if (current.paymentState !== "paid") {
                    const paymentState = evidence.status === "paid" ? "paid" : evidence.status === "unpaid" ? "unpaid" : "unknown";
                    await tx.update(paymentOrder).set({ paymentState, lastReason: paymentState === "unknown" && typeof evidence.code === "string" ? evidence.code : null,
                        updatedAt: new Date() }).where(eq(paymentOrder.id, current.id));
                }
                return event;
            });
        },
        async recordReview(orderId: string, code: string, requestId: string) {
            if (!reason(code) || !text(requestId)) throw invalid();
            return db.transaction(async tx => {
                const current = await requiredOrder(tx, orderId);
                const [event] = await tx.insert(paymentEvent).values({ id: crypto.randomUUID(), orderId: current.id, kind: "reconcile",
                    outcome: "unknown", evidence: { code }, requestId }).returning();
                if (!event) throw evidenceConflict();
                await tx.update(paymentOrder).set({ lastReason: code, updatedAt: new Date() }).where(eq(paymentOrder.id, current.id));
                return event;
            });
        },
        async recentSuccessfulNotification(orderId: string) {
            const [event] = await db.select().from(paymentEvent).where(and(eq(paymentEvent.orderId, id(orderId)),
                eq(paymentEvent.kind, "notification"), eq(paymentEvent.outcome, "verified_success")))
                .orderBy(desc(paymentEvent.createdAt), desc(paymentEvent.id)).limit(1);
            return event ?? null;
        },
    };
}
