import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

// Local profile of https://zpayz.cn/doc.html, UTF-8 HTML SHA-256 pinned in P0.
// This is not a provider API version or evidence of a real payment.
export const ZPAY_NOTIFICATION_PROTOCOL = "zpay-epay-md5-doc-03b0f9fb1ff6" as const;

export type ZpayExpectedOrder = {
    provider: "zpay";
    merchantId: string;
    merchantOrderId: string;
    currency: "CNY";
    /** Canonical positive integer string in cash fen; never wallet credits. */
    amountMinor: string;
    paymentType: "alipay" | "wxpay";
    providerTradeNo?: string;
};

export type ZpayNotificationErrorCode =
    | "invalid_expected_order" | "invalid_merchant_key" | "invalid_notification_query"
    | "invalid_notification_fields" | "unsupported_signature_type" | "invalid_signature"
    | "signature_verification_unavailable" | "unknown_order" | "unsupported_currency"
    | "merchant_mismatch" | "order_mismatch" | "payment_type_mismatch"
    | "provider_trade_mismatch" | "invalid_amount" | "amount_mismatch";

export type ZpayNotificationResult =
    | { ok: false; errorCode: ZpayNotificationErrorCode }
    | { ok: true; notification: {
        protocol: typeof ZPAY_NOTIFICATION_PROTOCOL;
        provider: "zpay";
        kind: "payment_success_notification" | "unrecognized_status_notification";
        merchantId: string;
        merchantOrderId: string;
        providerTradeNo: string;
        paymentType: "alipay" | "wxpay";
        currency: "CNY";
        amountMinor: string;
        tradeStatus: string;
        orderIdentity: string;
        eventIdentity: string;
    } };

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const orderIdentifier = (value: unknown): value is string => identifier(value) && value.length <= 32;
const paymentType = (value: unknown): value is "alipay" | "wxpay" => value === "alipay" || value === "wxpay";
const reject = (errorCode: ZpayNotificationErrorCode): ZpayNotificationResult => ({ ok: false, errorCode });

/**
 * Authenticate and bind a notification, without network, environment, DB or wallet access.
 * expectedOrder must come from trusted local storage/configuration, not this query.
 * The caller still needs an independent order query and atomic crediting/uniqueness.
 * Replays deliberately return the same identities; this function does NOT deduplicate.
 */
export function parseZpayPaymentNotification(
    rawQuery: string,
    expectedOrder: ZpayExpectedOrder | null,
    merchantKey: string,
): ZpayNotificationResult {
    if (expectedOrder !== null && (!expectedOrder || expectedOrder.provider !== "zpay" || expectedOrder.currency !== "CNY" ||
        !identifier(expectedOrder.merchantId) || !orderIdentifier(expectedOrder.merchantOrderId) ||
        typeof expectedOrder.amountMinor !== "string" || !/^[1-9]\d*$/.test(expectedOrder.amountMinor) ||
        !paymentType(expectedOrder.paymentType) ||
        (expectedOrder.providerTradeNo !== undefined && !identifier(expectedOrder.providerTradeNo)))) {
        return reject("invalid_expected_order");
    }
    if (typeof merchantKey !== "string" || merchantKey.length === 0) return reject("invalid_merchant_key");
    if (typeof rawQuery !== "string" || rawQuery.includes("#") ||
        Buffer.from(rawQuery, "utf8").toString("utf8") !== rawQuery) return reject("invalid_notification_query");

    // URLSearchParams is forgiving of malformed escapes/UTF-8; validate first.
    // Validation does not feed decoded data back into the parser (no double decoding).
    try { decodeURIComponent(rawQuery.replace(/\+/g, " ")); }
    catch { return reject("invalid_notification_query"); }
    const fields = new Map<string, string>();
    for (const [key, value] of new URLSearchParams(rawQuery)) {
        // The official unescaped signature format is ambiguous if ANY value has &.
        // Reject rather than rewrite signed data, including unknown/excluded fields.
        if (fields.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("&") || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
            return reject("invalid_notification_query");
        }
        fields.set(key, value);
    }
    if (["pid", "name", "money", "out_trade_no", "trade_no", "trade_status", "type", "sign"].some(key => !fields.get(key)) ||
        !identifier(fields.get("pid")) || !orderIdentifier(fields.get("out_trade_no")) ||
        !identifier(fields.get("trade_no")) || !identifier(fields.get("trade_status")) || !paymentType(fields.get("type"))) {
        return reject("invalid_notification_fields");
    }
    if (fields.has("sign_type") && fields.get("sign_type") !== "MD5") return reject("unsupported_signature_type");
    const signature = fields.get("sign")!;
    if (!/^[0-9a-f]{32}$/.test(signature)) return reject("invalid_signature");

    const material = [...fields].filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "")
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
    let digest: Buffer;
    try { digest = createHash("md5").update(material, "utf8").update(merchantKey, "utf8").digest(); }
    catch { return reject("signature_verification_unavailable"); }
    if (!timingSafeEqual(digest, Buffer.from(signature, "hex"))) return reject("invalid_signature");
    // The published callback has no currency field; do not interpret an invented extension.
    if (fields.has("currency")) return reject("unsupported_currency");
    if (expectedOrder === null) return reject("unknown_order");

    const merchantId = fields.get("pid")!, merchantOrderId = fields.get("out_trade_no")!;
    const providerTradeNo = fields.get("trade_no")!, tradeStatus = fields.get("trade_status")!;
    const type = fields.get("type")!;
    if (merchantId !== expectedOrder.merchantId) return reject("merchant_mismatch");
    if (merchantOrderId !== expectedOrder.merchantOrderId) return reject("order_mismatch");
    if (type !== expectedOrder.paymentType) return reject("payment_type_mismatch");
    if (expectedOrder.providerTradeNo !== undefined && providerTradeNo !== expectedOrder.providerTradeNo) return reject("provider_trade_mismatch");

    const money = fields.get("money")!;
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(money)) return reject("invalid_amount");
    const [whole, fraction = ""] = money.split(".");
    const amountMinor = (BigInt(whole!) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))).toString();
    if (amountMinor === "0") return reject("invalid_amount");
    if (amountMinor !== expectedOrder.amountMinor) return reject("amount_mismatch");

    return { ok: true, notification: {
        protocol: ZPAY_NOTIFICATION_PROTOCOL, provider: "zpay",
        kind: tradeStatus === "TRADE_SUCCESS" ? "payment_success_notification" : "unrecognized_status_notification",
        merchantId, merchantOrderId, providerTradeNo, paymentType: expectedOrder.paymentType,
        currency: "CNY", amountMinor, tradeStatus,
        orderIdentity: JSON.stringify(["zpay", merchantId, merchantOrderId]),
        eventIdentity: JSON.stringify(["zpay", merchantId, providerTradeNo, tradeStatus]),
    } };
}
