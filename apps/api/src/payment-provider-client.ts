import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { validatePaymentJson } from "./payment-provider-json";
import type { ZpayExpectedOrder, ZpayNotificationResult } from "./payment-provider-notification";
import { normalizeZpayOrderQuery, type ZpayOrderQueryResult } from "./payment-provider-order-query";

export type ZpayPaymentClientConfig = {
    merchantId: string;
    merchantKey: string;
    notifyUrl: string;
    timeoutMs: number;
    maxResponseBytes: number;
    paymentLinkOrigins: readonly string[];
};
export type ZpayCreatePaymentResult =
    | { status: "accepted"; providerTradeNo: string; providerOrderId?: string; paymentLinks: Record<string, string> }
    | { status: "rejected"; code: "provider_rejected" }
    | { status: "unknown"; code: string };
export type ZpayPaymentQueryResult = {
    result: ZpayOrderQueryResult;
    jsonMemberUniqueness: "checked_unique" | "rejected";
};

const createEndpoint = "https://zpayz.cn/mapi.php";
const queryEndpoint = "https://zpayz.cn/api.php";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const safeValue = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
    !/[&\u0000-\u001f\u007f-\u009f]/.test(value) && !/[\uD800-\uDFFF]/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" &&
    !Array.isArray(value) && !(value instanceof JsonNumberSource);
const unknown = (code: string): ZpayCreatePaymentResult => ({ status: "unknown", code });
const unknownQuery = (code: Extract<ZpayOrderQueryResult, { status: "unknown" }>["code"],
    jsonMemberUniqueness: ZpayPaymentQueryResult["jsonMemberUniqueness"] = "rejected"): ZpayPaymentQueryResult =>
    ({ result: { status: "unknown", code }, jsonMemberUniqueness });
class JsonNumberSource { constructor(readonly source: string | undefined) {} }

function validExpected(value: unknown): value is ZpayExpectedOrder {
    return record(value) && value.provider === "zpay" && value.currency === "CNY" && identifier(value.merchantId) &&
        identifier(value.merchantOrderId) && value.merchantOrderId.length <= 32 &&
        typeof value.amountMinor === "string" && /^[1-9]\d*$/.test(value.amountMinor) &&
        (value.paymentType === "alipay" || value.paymentType === "wxpay") &&
        (value.providerTradeNo === undefined || identifier(value.providerTradeNo));
}

/** Server-only transport. It never retries or turns a query observation into wallet credit. */
export function createZpayPaymentClient(config: ZpayPaymentClientConfig, fetcher: typeof fetch = fetch) {
    const linkOrigins = new Set<string>();
    try {
        if (!config || !identifier(config.merchantId) || typeof config.merchantKey !== "string" || config.merchantKey.length === 0 || !safeValue(config.notifyUrl) ||
            !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2_147_483_647 ||
            !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes <= 0 ||
            !Array.isArray(config.paymentLinkOrigins) || typeof fetcher !== "function") throw new Error();
        const notify = new URL(config.notifyUrl);
        if (notify.protocol !== "https:" || notify.username || notify.password || notify.search || notify.hash) throw new Error();
        for (const origin of config.paymentLinkOrigins) {
            if (!safeValue(origin)) throw new Error();
            const url = new URL(origin);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
                url.pathname !== "/" || url.search || url.hash) throw new Error();
            linkOrigins.add(url.origin);
        }
    } catch { throw new Error("invalid_payment_config"); }
    // Snapshot caller-owned configuration before any asynchronous operation.
    const { merchantId, merchantKey, notifyUrl, timeoutMs, maxResponseBytes } = config;

    type TransportResult = { ok: true; raw: string } | { ok: false; code: string };
    async function request(url: string, init: RequestInit): Promise<TransportResult> {
        const controller = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired: TransportResult = { ok: false, code: "provider_timeout" };
        const deadline = new Promise<TransportResult>(resolve => {
            timer = setTimeout(() => { resolve(expired); controller.abort(); }, timeoutMs);
        });
        async function read(): Promise<TransportResult> {
            try {
                const response = await fetcher(url, { ...init, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
                if (controller.signal.aborted) {
                    void response.body?.cancel().catch(() => {});
                    return expired;
                }
                if (response.redirected || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
                    void response.body?.cancel().catch(() => {});
                    return { ok: false, code: "redirected_response" };
                }
                if (response.status !== 200) {
                    void response.body?.cancel().catch(() => {});
                    return { ok: false, code: "http_response_unknown" };
                }
                if (response.url && response.url !== url) {
                    void response.body?.cancel().catch(() => {});
                    return { ok: false, code: "redirected_response" };
                }
                if (!response.body) return { ok: false, code: "incomplete_response" };
                reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
                let size = 0, raw = "";
                for (;;) {
                    const next = await reader.read();
                    if (controller.signal.aborted) return expired;
                    if (next.done) break;
                    size += next.value.byteLength;
                    if (size > maxResponseBytes) return { ok: false, code: "response_too_large" };
                    try { raw += decoder.decode(next.value, { stream: true }); }
                    catch { return { ok: false, code: "invalid_utf8" }; }
                }
                try { raw += decoder.decode(); }
                catch { return { ok: false, code: "invalid_utf8" }; }
                return { ok: true, raw };
            } catch { return controller.signal.aborted ? expired : { ok: false, code: "response_unavailable" }; }
        }
        try { return await Promise.race([read(), deadline]); }
        finally {
            clearTimeout(timer);
            // Cancellation is best-effort and cannot extend the configured deadline.
            void reader?.cancel().catch(() => {});
        }
    }

    async function create(input: { expected: ZpayExpectedOrder; name: string; clientIp: string; channelId?: string }): Promise<ZpayCreatePaymentResult> {
        try {
            if (!input || !validExpected(input.expected) || !safeValue(input.name) || typeof input.clientIp !== "string" || !isIP(input.clientIp) ||
                (input.channelId !== undefined && !safeValue(input.channelId))) return unknown("invalid_create_input");
            const expected = { ...input.expected };
            if (expected.merchantId !== merchantId) return unknown("merchant_mismatch");
            const amount = BigInt(expected.amountMinor);
            const fields: Record<string, string> = {
                pid: merchantId, type: expected.paymentType, out_trade_no: expected.merchantOrderId,
                notify_url: notifyUrl, name: input.name,
                money: `${amount / BigInt(100)}.${(amount % BigInt(100)).toString().padStart(2, "0")}`,
                clientip: input.clientIp,
            };
            if (input.channelId !== undefined) fields.cid = input.channelId;
            if (Object.values(fields).some(value => !safeValue(value))) return unknown("invalid_create_input");
            const material = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("&");
            const form = new FormData();
            for (const [key, value] of Object.entries(fields)) form.set(key, value);
            form.set("sign", createHash("md5").update(material, "utf8").update(merchantKey, "utf8").digest("hex"));
            form.set("sign_type", "MD5");
            const response = await request(createEndpoint, { method: "POST", body: form });
            if (!response.ok) return unknown(response.code);
            const admission = validatePaymentJson(response.raw);
            if (!admission.ok) return unknown(admission.code);
            let sourceMissing = false;
            const payload: unknown = JSON.parse(response.raw, (_key, value, context?: { source?: string }) => {
                if (typeof value !== "number") return value;
                if (typeof context?.source !== "string") sourceMissing = true;
                return new JsonNumberSource(context?.source);
            });
            if (sourceMissing) return unknown("numeric_source_unavailable");
            if (!record(payload) || !(payload.code instanceof JsonNumberSource) ||
                typeof payload.code.source !== "string" || !/^(0|-?[1-9]\d*)$/.test(payload.code.source)) return unknown("invalid_create_response");
            if (payload.code.source !== "1") return { status: "rejected", code: "provider_rejected" };
            if (!identifier(payload.trade_no)) return unknown("invalid_provider_trade_no");
            if (expected.providerTradeNo !== undefined && payload.trade_no !== expected.providerTradeNo) return unknown("provider_trade_mismatch");
            let providerOrderId: string | undefined;
            if (Object.hasOwn(payload, "O_id")) {
                const id = payload.O_id instanceof JsonNumberSource ? payload.O_id.source : payload.O_id;
                if (!identifier(id) || (payload.O_id instanceof JsonNumberSource && !/^(0|[1-9]\d*)$/.test(id))) return unknown("invalid_provider_order_id");
                providerOrderId = id;
            }
            const paymentLinks: Record<string, string> = {};
            for (const key of ["payurl", "payurl2", "qrcode", "img"]) {
                if (!Object.hasOwn(payload, key)) continue;
                if (typeof payload[key] !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(payload[key])) return unknown("invalid_payment_link");
                let link: URL;
                try { link = new URL(payload[key]); } catch { return unknown("invalid_payment_link"); }
                if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password || !linkOrigins.has(link.origin)) return unknown("invalid_payment_link");
                paymentLinks[key] = link.href;
            }
            return { status: "accepted", providerTradeNo: payload.trade_no, ...(providerOrderId === undefined ? {} : { providerOrderId }), paymentLinks };
        } catch { return unknown("create_unavailable"); }
    }

    async function query(expectedOrder: ZpayExpectedOrder, verifiedNotification?: ZpayNotificationResult): Promise<ZpayPaymentQueryResult> {
        try {
            if (!validExpected(expectedOrder)) return unknownQuery("invalid_expected_order");
            const expected = { ...expectedOrder };
            if (expected.merchantId !== merchantId) return unknownQuery("merchant_mismatch");
            const url = new URL(queryEndpoint);
            url.search = new URLSearchParams({ act: "order", pid: merchantId, key: merchantKey, out_trade_no: expected.merchantOrderId }).toString();
            const response = await request(url.href, { method: "GET" });
            if (!response.ok) {
                if (response.code === "redirected_response" || response.code === "http_response_unknown" || response.code === "incomplete_response") return unknownQuery(response.code);
                if (response.code === "invalid_utf8") return unknownQuery("invalid_json");
                return unknownQuery(response.code === "response_too_large" || response.code === "response_unavailable" ? "incomplete_response" : "query_unavailable");
            }
            if (!validatePaymentJson(response.raw).ok) return unknownQuery("invalid_json");
            return { result: normalizeZpayOrderQuery({ kind: "response", httpStatus: 200, redirected: false, complete: true, body: response.raw },
                expected, verifiedNotification), jsonMemberUniqueness: "checked_unique" };
        } catch { return unknownQuery("query_unavailable"); }
    }
    return Object.freeze({ create, query });
}
