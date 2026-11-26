import { ZPAY_NOTIFICATION_PROTOCOL, type ZpayExpectedOrder, type ZpayNotificationResult } from "./payment-provider-notification";

export const ZPAY_ORDER_QUERY_SOURCE = "zpay-order-query-doc-03b0f9fb1ff6" as const;

/** Collected by a trusted server-side caller; this module cannot authenticate HTTP. */
export type ZpayOrderQueryObservation =
    | { kind: "response"; httpStatus: number; redirected: boolean; complete: boolean; body: string }
    | { kind: "unavailable" };

export type ZpayOrderQueryUnknownCode =
    | "unknown_order" | "invalid_expected_order" | "query_unavailable" | "http_response_unknown"
    | "redirected_response" | "incomplete_response" | "invalid_json" | "invalid_response"
    | "numeric_source_unavailable" | "query_not_successful" | "unsupported_status" | "unsupported_currency"
    | "merchant_mismatch" | "order_mismatch" | "provider_trade_mismatch" | "payment_type_mismatch"
    | "invalid_amount" | "amount_mismatch" | "invalid_notification_binding"
    | "notification_mismatch" | "notification_query_conflict";

export type ZpayOrderQueryResult =
    | { status: "unknown"; code: ZpayOrderQueryUnknownCode }
    | { status: "paid" | "unpaid"; evidence: {
        source: typeof ZPAY_ORDER_QUERY_SOURCE;
        level: "bound_query_observation";
        /** Standard JSON.parse uses the last member; raw member uniqueness is NOT checked. */
        jsonMemberUniqueness: "not_checked";
        provider: "zpay";
        merchantId: string;
        merchantOrderId: string;
        providerTradeNo: string;
        paymentType: "alipay" | "wxpay";
        currency: "CNY";
        amountMinor: string;
        orderIdentity: string;
        paymentIdentity: string;
        notification: null | {
            kind: "payment_success_notification" | "unrecognized_status_notification";
            eventIdentity: string;
        };
    } };

// Only the reviver can produce these instances. JSON objects cannot impersonate them.
class JsonNumberSource { constructor(readonly source: string | undefined) {} }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof JsonNumberSource);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const orderIdentifier = (value: unknown): value is string => identifier(value) && value.length <= 32;
const positiveMinor = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
const paymentType = (value: unknown): value is "alipay" | "wxpay" => value === "alipay" || value === "wxpay";
const unknown = (code: ZpayOrderQueryUnknownCode): ZpayOrderQueryResult => ({ status: "unknown", code });

function validExpected(value: unknown): value is ZpayExpectedOrder {
    return record(value) && value.provider === "zpay" && value.currency === "CNY" && identifier(value.merchantId) &&
        orderIdentifier(value.merchantOrderId) && positiveMinor(value.amountMinor) && paymentType(value.paymentType) &&
        (value.providerTradeNo === undefined || identifier(value.providerTradeNo));
}

/**
 * Pure evidence only: no I/O, secrets, query URLs, crediting decision or state transitions.
 * Use the original response TEXT, never JSON.parse(text) supplied by another caller.
 * expectedOrder is immutable server data; an optional notification must be the trusted
 * result of parseZpayPaymentNotification, not a client-constructed lookalike. Binding is
 * checked here again, but this function does not and cannot re-verify its MD5 signature.
 */
export function normalizeZpayOrderQuery(
    observation: ZpayOrderQueryObservation,
    expectedOrder: ZpayExpectedOrder | null,
    verifiedNotification?: ZpayNotificationResult,
): ZpayOrderQueryResult {
    if (expectedOrder === null) return unknown("unknown_order");
    if (!validExpected(expectedOrder)) return unknown("invalid_expected_order");
    if (!observation || observation.kind === "unavailable") return unknown("query_unavailable");
    if (observation.kind !== "response" || observation.httpStatus !== 200) return unknown("http_response_unknown");
    if (observation.redirected !== false) return unknown("redirected_response");
    if (observation.complete !== true) return unknown("incomplete_response");
    if (typeof observation.body !== "string") return unknown("invalid_response");

    let payload: unknown;
    let sourceMissing = false;
    try {
        payload = JSON.parse(observation.body, (_key, value, context?: { source?: string }) => {
            if (typeof value !== "number") return value;
            if (typeof context?.source !== "string") sourceMissing = true;
            return new JsonNumberSource(context?.source);
        });
    } catch { return unknown("invalid_json"); }
    if (sourceMissing) return unknown("numeric_source_unavailable");
    if (!record(payload)) return unknown("invalid_response");
    if (!(payload.code instanceof JsonNumberSource) || payload.code.source !== "1") return unknown("query_not_successful");
    if (!(payload.status instanceof JsonNumberSource) || (payload.status.source !== "0" && payload.status.source !== "1")) return unknown("unsupported_status");
    if (Object.hasOwn(payload, "currency")) return unknown("unsupported_currency");

    // The API calls pid an Int; accept only its ORIGINAL plain integer token, or
    // an exact string ID. Never obtain an ID by String(the already-rounded Number).
    const merchantId = payload.pid instanceof JsonNumberSource
        ? (typeof payload.pid.source === "string" && /^(0|[1-9]\d*)$/.test(payload.pid.source) ? payload.pid.source : null)
        : payload.pid;
    if (!identifier(merchantId) || !orderIdentifier(payload.out_trade_no) || !identifier(payload.trade_no) || !paymentType(payload.type)) return unknown("invalid_response");
    if (typeof payload.money !== "string" || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(payload.money)) return unknown("invalid_amount");
    const [whole, fraction = ""] = payload.money.split(".");
    const amountMinor = (BigInt(whole!) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))).toString();
    if (amountMinor === "0") return unknown("invalid_amount");
    if (merchantId !== expectedOrder.merchantId) return unknown("merchant_mismatch");
    if (payload.out_trade_no !== expectedOrder.merchantOrderId) return unknown("order_mismatch");
    if (payload.type !== expectedOrder.paymentType) return unknown("payment_type_mismatch");
    if (amountMinor !== expectedOrder.amountMinor) return unknown("amount_mismatch");
    if (expectedOrder.providerTradeNo !== undefined && payload.trade_no !== expectedOrder.providerTradeNo) return unknown("provider_trade_mismatch");

    let notification: Extract<ZpayOrderQueryResult, { evidence: unknown }>["evidence"]["notification"] = null;
    if (verifiedNotification !== undefined) {
        if (!verifiedNotification || verifiedNotification.ok !== true) return unknown("invalid_notification_binding");
        const n = verifiedNotification.notification;
        if (!validExpected(n) || n.protocol !== ZPAY_NOTIFICATION_PROTOCOL || !identifier(n.providerTradeNo) || !identifier(n.tradeStatus) ||
            n.kind !== (n.tradeStatus === "TRADE_SUCCESS" ? "payment_success_notification" : "unrecognized_status_notification") ||
            n.orderIdentity !== JSON.stringify(["zpay", n.merchantId, n.merchantOrderId]) ||
            n.eventIdentity !== JSON.stringify(["zpay", n.merchantId, n.providerTradeNo, n.tradeStatus])) return unknown("invalid_notification_binding");
        if (n.merchantId !== merchantId || n.merchantOrderId !== payload.out_trade_no || n.providerTradeNo !== payload.trade_no ||
            n.paymentType !== payload.type || n.amountMinor !== amountMinor) return unknown("notification_mismatch");
        if (n.kind === "payment_success_notification" && payload.status.source === "0") return unknown("notification_query_conflict");
        notification = { kind: n.kind, eventIdentity: n.eventIdentity };
    }

    return { status: payload.status.source === "1" ? "paid" : "unpaid", evidence: {
        source: ZPAY_ORDER_QUERY_SOURCE, level: "bound_query_observation", jsonMemberUniqueness: "not_checked",
        provider: "zpay", merchantId, merchantOrderId: payload.out_trade_no, providerTradeNo: payload.trade_no,
        paymentType: payload.type, currency: "CNY", amountMinor,
        orderIdentity: JSON.stringify(["zpay", merchantId, payload.out_trade_no]),
        paymentIdentity: JSON.stringify(["zpay", merchantId, payload.trade_no]), notification,
    } };
}
