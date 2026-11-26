import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeZpayOrderQuery, ZPAY_ORDER_QUERY_SOURCE, type ZpayOrderQueryObservation } from "./payment-provider-order-query";
import { parseZpayPaymentNotification, type ZpayExpectedOrder, type ZpayNotificationResult } from "./payment-provider-notification";

const expected: ZpayExpectedOrder = Object.freeze({
    provider: "zpay", merchantId: "201901151314084206659771", merchantOrderId: "query-order-0001",
    currency: "CNY", amountMinor: "1230", paymentType: "alipay", providerTradeNo: "query-trade-0001",
});
const fields = { code: 1, status: 1, pid: expected.merchantId, out_trade_no: expected.merchantOrderId,
    trade_no: expected.providerTradeNo, type: "alipay", money: "12.30", name: "Synthetic credits & JSON is unambiguous", param: "" };
const body = (changes: Record<string, unknown> = {}) => JSON.stringify({ ...fields, ...changes });
const observation = (text = body()): ZpayOrderQueryObservation => ({ kind: "response", httpStatus: 200, redirected: false, complete: true, body: text });
const query = (text = body(), order: ZpayExpectedOrder | null = expected, notice?: ZpayNotificationResult) => normalizeZpayOrderQuery(observation(text), order, notice);
// Synthetic raw-number fixtures only, not a JSON parser or production serialization.
const rawNumber = (key: string, token: string) => body({ [key]: "__numeric_fixture__" }).replace('"__numeric_fixture__"', token);

function signedNotice(changes: Record<string, string> = {}, order = expected): ZpayNotificationResult {
    const values = { pid: order.merchantId, name: "Synthetic credits", money: "12.30", out_trade_no: order.merchantOrderId,
        trade_no: order.providerTradeNo ?? "query-trade-0001", trade_status: "TRADE_SUCCESS", type: order.paymentType, ...changes };
    const material = Object.keys(values).sort().map(key => `${key}=${values[key as keyof typeof values]}`).join("&");
    const key = "synthetic-query-binding-key";
    const sign = createHash("md5").update(material + key).digest("hex");
    return parseZpayPaymentNotification(new URLSearchParams({ ...values, sign, sign_type: "MD5" }).toString(), order, key);
}

describe("ZPay independent order query evidence only", () => {
    test("binds a complete paid observation and exposes only a fixed evidence whitelist", () => {
        expect(query(body({ key: "synthetic-secret", msg: "https://untrusted.invalid/private", buyer: "private-buyer", balance: "999", arbitrary_url: "https://untrusted.invalid" }))).toEqual({
            status: "paid", evidence: { source: ZPAY_ORDER_QUERY_SOURCE, level: "bound_query_observation", jsonMemberUniqueness: "not_checked",
                provider: "zpay", merchantId: expected.merchantId, merchantOrderId: expected.merchantOrderId, providerTradeNo: expected.providerTradeNo,
                paymentType: "alipay", currency: "CNY", amountMinor: "1230", notification: null,
                orderIdentity: JSON.stringify(["zpay", expected.merchantId, expected.merchantOrderId]),
                paymentIdentity: JSON.stringify(["zpay", expected.merchantId, expected.providerTradeNo]),
            },
        });
    });

    test("preserves an unsafe numeric pid from its original lexeme, not the rounded Number", () => {
        expect(query(rawNumber("pid", expected.merchantId))).toMatchObject({ status: "paid", evidence: { merchantId: expected.merchantId } });
        expect(query(rawNumber("pid", "9007199254740993"), { ...expected, merchantId: "9007199254740993" })).toMatchObject({ status: "paid", evidence: { merchantId: "9007199254740993" } });
        expect(query(rawNumber("pid", "9007199254740993"), { ...expected, merchantId: "9007199254740992" })).toEqual({ status: "unknown", code: "merchant_mismatch" });
        expect(normalizeZpayOrderQuery({ ...observation(), body: JSON.parse(rawNumber("pid", expected.merchantId)) } as never, expected)).toEqual({ status: "unknown", code: "invalid_response" });
    });

    test("keeps numeric sources attached to their own values despite nested same-name fields", () => {
        const text = rawNumber("pid", expected.merchantId).replace(/}$/, ',"extra":{"pid":123,"code":0,"status":0}}');
        expect(query(text)).toMatchObject({ status: "paid", evidence: { merchantId: expected.merchantId } });
        expect(query(body({ pid: { source: expected.merchantId } }))).toEqual({ status: "unknown", code: "invalid_response" });
        expect(query(body({ code: { source: "1" } }))).toEqual({ status: "unknown", code: "query_not_successful" });
    });

    test("unpaid followed by paid stays independent observations without a failure or state mutation", () => {
        expect(query(body({ status: 0 }))).toMatchObject({ status: "unpaid", evidence: { amountMinor: "1230" } });
        expect(query()).toMatchObject({ status: "paid" });
        expect(query(body({ status: 0 }))).toMatchObject({ status: "unpaid" });
        expect(expected.amountMinor).toBe("1230");
    });

    test("transport, HTTP errors, redirects and incomplete reads remain unknown even with a success notification", () => {
        const notice = signedNotice();
        expect(notice.ok).toBe(true);
        expect(normalizeZpayOrderQuery({ kind: "unavailable" }, expected, notice)).toEqual({ status: "unknown", code: "query_unavailable" });
        for (const httpStatus of [0, 201, 301, 400, 404, 429, 500, 503]) {
            expect(normalizeZpayOrderQuery({ ...observation(), httpStatus } as ZpayOrderQueryObservation, expected, notice)).toEqual({ status: "unknown", code: "http_response_unknown" });
        }
        expect(normalizeZpayOrderQuery({ ...observation(), redirected: true } as ZpayOrderQueryObservation, expected, notice)).toEqual({ status: "unknown", code: "redirected_response" });
        expect(normalizeZpayOrderQuery({ ...observation(), complete: false } as ZpayOrderQueryObservation, expected, notice)).toEqual({ status: "unknown", code: "incomplete_response" });
    });

    test("rejects malformed JSON, non-object envelopes and pre-parsed payloads without echoing them", () => {
        for (const text of ["", "{", body() + "trailing", '{"code":NaN}', '{"code":Infinity}']) {
            expect(query(text)).toEqual({ status: "unknown", code: "invalid_json" });
        }
        for (const text of ["null", "[]", '"secret-payload"', "1"]) expect(query(text)).toEqual({ status: "unknown", code: "invalid_response" });
    });

    test("only a numeric code with original integer lexeme 1 confirms a successful query envelope", () => {
        for (const code of [0, -1, 2, "1", "error", true, null, undefined]) {
            expect(query(body({ code }), expected, signedNotice())).toEqual({ status: "unknown", code: "query_not_successful" });
        }
        for (const token of ["1.0", "1e0", "-0", "1e400"]) expect(query(rawNumber("code", token))).toEqual({ status: "unknown", code: "query_not_successful" });
    });

    test("only original integer status 0 or 1 is supported; other states are not payment failures", () => {
        for (const status of [2, -1, "0", "1", true, false, null, undefined]) expect(query(body({ status }))).toEqual({ status: "unknown", code: "unsupported_status" });
        for (const token of ["1.0", "0.0", "1e0", "-0"]) expect(query(rawNumber("status", token))).toEqual({ status: "unknown", code: "unsupported_status" });
    });

    test("numeric pid must be an original plain integer; string identity stays exact", () => {
        for (const token of ["1e21", "1.0", "-0", "-1", "1e400"]) expect(query(rawNumber("pid", token))).toEqual({ status: "unknown", code: "invalid_response" });
        expect(query(body({ pid: "00123" }), { ...expected, merchantId: "00123" })).toMatchObject({ status: "paid", evidence: { merchantId: "00123" } });
        expect(query(body({ pid: "00123" }), { ...expected, merchantId: "123" })).toEqual({ status: "unknown", code: "merchant_mismatch" });
    });

    test("requires correctly typed complete identity fields even for unpaid observations", () => {
        for (const changes of [{ pid: undefined }, { pid: true }, { out_trade_no: undefined }, { out_trade_no: 123 },
            { trade_no: undefined }, { trade_no: 123 }, { type: undefined }, { type: "qqpay" }, { trade_no: "trade&other=1" }]) {
            expect(query(body({ status: 0, ...changes }))).toEqual({ status: "unknown", code: "invalid_response" });
        }
    });

    test("binds merchant, local order, gateway trade, method and exact amount before paid or unpaid", () => {
        for (const status of [0, 1]) {
            for (const [changes, code] of [[{ pid: "other" }, "merchant_mismatch"], [{ out_trade_no: "other-order" }, "order_mismatch"],
                [{ trade_no: "other-trade" }, "provider_trade_mismatch"], [{ type: "wxpay" }, "payment_type_mismatch"], [{ money: "12.31" }, "amount_mismatch"]] as const) {
                expect(query(body({ status, ...changes }))).toEqual({ status: "unknown", code });
            }
        }
    });

    test("cash uses exact positive fen strings, supports large values and never rounds numeric money", () => {
        for (const money of ["12.3", "12.30"]) expect(query(body({ money }))).toMatchObject({ status: "paid", evidence: { amountMinor: "1230" } });
        for (const money of ["1", "1.0", "1.00"]) expect(query(body({ money }), { ...expected, amountMinor: "100" })).toMatchObject({ status: "paid", evidence: { amountMinor: "100" } });
        expect(query(body({ money: "9007199254740993.01" }), { ...expected, amountMinor: "900719925474099301" })).toMatchObject({ status: "paid", evidence: { amountMinor: "900719925474099301" } });
        for (const money of [12.30, "0", "0.00", "12.301", "012.30", "+12.30", "-12.30", "1e2", " 12.30", ".5", "1.", null, undefined]) {
            expect(query(body({ money }))).toEqual({ status: "unknown", code: "invalid_amount" });
        }
    });

    test("requires trusted expected configuration and CNY without accepting an invented response currency", () => {
        expect(query(body(), null)).toEqual({ status: "unknown", code: "unknown_order" });
        for (const change of [{ provider: "other" }, { currency: "USD" }, { amountMinor: 1230 }, { amountMinor: "01230" },
            { amountMinor: "0" }, { merchantId: "" }, { merchantOrderId: "x".repeat(33) }, { paymentType: "qqpay" }]) {
            expect(query(body(), { ...expected, ...change } as ZpayExpectedOrder)).toEqual({ status: "unknown", code: "invalid_expected_order" });
        }
        for (const currency of ["USD", "CNY", null]) expect(query(body({ currency }))).toEqual({ status: "unknown", code: "unsupported_currency" });
    });

    test("binds a real synthetic verified notification and keeps unknown notification status explicit", () => {
        const notice = signedNotice();
        expect(notice.ok).toBe(true);
        expect(query(body(), expected, notice)).toMatchObject({ status: "paid", evidence: { notification: { kind: "payment_success_notification" } } });
        const unrecognized = signedNotice({ trade_status: "WAIT_BUYER_PAY" });
        expect(unrecognized.ok).toBe(true);
        expect(query(body(), expected, unrecognized)).toMatchObject({ status: "paid", evidence: { level: "bound_query_observation", notification: { kind: "unrecognized_status_notification" } } });
        expect(query(body({ status: 0 }), expected, unrecognized)).toMatchObject({ status: "unpaid" });
    });

    test("rejects notification/query cross-order, cross-trade and amount mismatches before first trade binding", () => {
        const unbound = { ...expected, providerTradeNo: undefined };
        const cases = [signedNotice({}, { ...expected, merchantOrderId: "order-B" }), signedNotice({}, { ...expected, merchantId: "other" }),
            signedNotice({ trade_no: "trade-B" }, unbound), signedNotice({ money: "12.31" }, { ...expected, amountMinor: "1231" }),
            signedNotice({}, { ...expected, paymentType: "wxpay" })];
        for (const notice of cases) {
            expect(notice.ok).toBe(true);
            expect(query(body(), unbound, notice)).toEqual({ status: "unknown", code: "notification_mismatch" });
        }
    });

    test("success notification plus unpaid query is a conflict, not unpaid or paid", () => {
        expect(query(body({ status: 0 }), expected, signedNotice())).toEqual({ status: "unknown", code: "notification_query_conflict" });
        expect(query(body({ code: 0, status: 1 }), expected, signedNotice())).toEqual({ status: "unknown", code: "query_not_successful" });
    });

    test("does not trust failed notifications, type assertions, stale identities or mismatched state metadata", () => {
        expect(query(body(), expected, { ok: false, errorCode: "invalid_signature" })).toEqual({ status: "unknown", code: "invalid_notification_binding" });
        const valid = signedNotice();
        expect(valid.ok).toBe(true);
        if (!valid.ok) throw new Error("Synthetic notification setup failed");
        for (const changes of [{ protocol: "other" }, { provider: "other" }, { currency: "USD" }, { amountMinor: "01230" },
            { kind: "unrecognized_status_notification" }, { eventIdentity: "stale-event" }, { orderIdentity: "stale-order" }, { providerTradeNo: undefined }]) {
            const mutated = { ok: true, notification: { ...valid.notification, ...changes } } as ZpayNotificationResult;
            expect(query(body(), expected, mutated)).toEqual({ status: "unknown", code: "invalid_notification_binding" });
        }
    });

    test("marks raw member uniqueness unverified rather than pretending standard JSON rejects duplicates", () => {
        const duplicateStatus = body().replace('"status":1', '"status":0,"status":1');
        expect(query(duplicateStatus)).toMatchObject({ status: "paid", evidence: { level: "bound_query_observation", jsonMemberUniqueness: "not_checked" } });
        const duplicateCode = body().replace('"code":1', '"code":1,"code":0');
        expect(query(duplicateCode)).toEqual({ status: "unknown", code: "query_not_successful" });
    });
});
