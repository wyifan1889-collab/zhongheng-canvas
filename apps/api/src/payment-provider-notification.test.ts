import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseZpayPaymentNotification, ZPAY_NOTIFICATION_PROTOCOL, type ZpayExpectedOrder } from "./payment-provider-notification";

const merchantKey = "synthetic-only-key-not-a-merchant-secret";
const expected: ZpayExpectedOrder = Object.freeze({
    provider: "zpay", merchantId: "merchant_synthetic_01", merchantOrderId: "local-order-0001",
    currency: "CNY", amountMinor: "1230", paymentType: "alipay", providerTradeNo: "zpay-trade-0001",
});
const fields = {
    pid: expected.merchantId, name: "画布积分 + 100% test=1", money: "12.30",
    out_trade_no: expected.merchantOrderId, trade_no: expected.providerTradeNo!,
    trade_status: "TRADE_SUCCESS", type: "alipay", param: "tag%2B+中文",
    extra: "0", empty: "", sign_type: "MD5",
};
// Independently computed with .NET MD5 over UTF-8 (PowerShell), not our signer:
// extra=0&money=12.30&name=画布积分 + 100% test=1&out_trade_no=local-order-0001&param=tag%2B+中文&pid=merchant_synthetic_01&trade_no=zpay-trade-0001&trade_status=TRADE_SUCCESS&type=alipay
// followed immediately by merchantKey. All credentials and data are synthetic.
const fixedSignature = "37927fd869c80bc8d0760efe5077abd5";
const fixedQuery = new URLSearchParams({ ...fields, sign: fixedSignature }).toString();

function signed(changes: Record<string, string | undefined> = {}) {
    const values: Record<string, string> = { ...fields };
    for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete values[key];
        else values[key] = value;
    }
    const material = Object.keys(values).sort().filter(key => key !== "sign" && key !== "sign_type" && values[key] !== "")
        .map(key => `${key}=${values[key]}`).join("&");
    values.sign = createHash("md5").update(material + merchantKey, "utf8").digest("hex");
    return new URLSearchParams(values).toString();
}

function parsed(query = fixedQuery, order: ZpayExpectedOrder | null = expected, key = merchantKey) {
    return parseZpayPaymentNotification(query, order, key);
}

describe("ZPay MD5 notification evidence, without payment/wallet side effects", () => {
    test("rejects cross-order canonical ambiguity when reusing the original B signature", () => {
        // Sign B once. Mutate only the decoded fields; NEVER sign A independently.
        const originalB = new URLSearchParams(signed({ name: "N&out_trade_no=A&param=P", out_trade_no: "B", param: "Q" }));
        const forgedA = new URLSearchParams(originalB);
        forgedA.set("name", "N");
        forgedA.set("out_trade_no", "A");
        forgedA.set("param", "P&out_trade_no=B&param=Q");
        const material = (values: URLSearchParams) => [...values]
            .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "")
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
        expect(forgedA.get("sign")).toBe(originalB.get("sign"));
        expect(material(forgedA)).toBe(material(originalB));
        const orderA: ZpayExpectedOrder = { ...expected, merchantOrderId: "A", providerTradeNo: undefined };
        expect(parsed(forgedA.toString(), orderA)).toEqual({ ok: false, errorCode: "invalid_notification_query" });
        expect(parsed(originalB.toString(), { ...orderA, merchantOrderId: "B" })).toEqual({ ok: false, errorCode: "invalid_notification_query" });
    });

    test("rejects the previously accepted ampersand vector without rewriting its valid signature", () => {
        const previousQuery = new URLSearchParams({ ...fields, name: "画布积分 + 100% & test=1", sign: "fb94522051cec220f049c1e252e46d14" });
        expect(parsed(previousQuery.toString())).toEqual({ ok: false, errorCode: "invalid_notification_query" });
    });

    test("rejects a decoded ampersand in every known, unknown and signature-excluded field value", () => {
        for (const field of [...Object.keys(fields), "sign", "unknown_extension"]) {
            const unsafe = new URLSearchParams(fixedQuery);
            unsafe.set(field, "left&right");
            expect(parsed(unsafe.toString())).toEqual({ ok: false, errorCode: "invalid_notification_query" });
        }
        expect(parsed(signed({ unknown_extension: "left&right" }))).toEqual({ ok: false, errorCode: "invalid_notification_query" });
        expect(parsed(signed({ param: "left&amp;right" }))).toEqual({ ok: false, errorCode: "invalid_notification_query" });
    });

    test("keeps signature-safe equals, semicolons, unicode lookalikes and literal percent escapes intact", () => {
        const safe = signed({ name: "N=value=more", param: "literal%26and%3D;not-a-delimiter；＆＝" });
        expect(safe).toContain("%2526");
        expect(parsed(safe)).toEqual(parsed());
        // A percent-encoded & decodes to a forbidden separator; double encoding remains literal %26.
        expect(parsed(signed({ param: "literal&separator" }))).toEqual({ ok: false, errorCode: "invalid_notification_query" });
        expect(parsed(signed({ param: "literal%26separator" }))).toEqual(parsed());
    });

    test("accepts the independent UTF-8 signature vector and returns only bound evidence", () => {
        expect(parsed()).toEqual({ ok: true, notification: {
            protocol: ZPAY_NOTIFICATION_PROTOCOL, provider: "zpay", kind: "payment_success_notification",
            merchantId: expected.merchantId, merchantOrderId: expected.merchantOrderId,
            providerTradeNo: expected.providerTradeNo, paymentType: "alipay", currency: "CNY", amountMinor: "1230",
            tradeStatus: "TRADE_SUCCESS", orderIdentity: '["zpay","merchant_synthetic_01","local-order-0001"]',
            eventIdentity: '["zpay","merchant_synthetic_01","zpay-trade-0001","TRADE_SUCCESS"]',
        } });
    });

    test("reorder, leading ?, escape casing and equivalent space encoding preserve the event", () => {
        const reversed = new URLSearchParams([...new URLSearchParams(fixedQuery)].reverse()).toString();
        expect(parsed(`?${reversed.replace(/\+/g, "%20").replace(/%E7/g, "%e7")}`)).toEqual(parsed());
        // Literal %2B must remain %2B after one decoding; literal + must remain +.
        const changed = new URLSearchParams(fixedQuery);
        changed.set("param", "tag++中文");
        expect(parsed(changed.toString())).toEqual({ ok: false, errorCode: "invalid_signature" });
    });

    test("every signed field, including ignored extensions and a zero string, is authenticated", () => {
        for (const [key, value] of Object.entries({
            pid: "merchant_other", name: "篡改商品", money: "12.31", out_trade_no: "local-other",
            trade_no: "trade-other", trade_status: "WAIT_BUYER_PAY", type: "wxpay", param: "other", extra: "1",
            new_extension: "injected",
        })) {
            const tampered = new URLSearchParams(fixedQuery);
            tampered.set(key, value);
            expect(parsed(tampered.toString())).toEqual({ ok: false, errorCode: "invalid_signature" });
        }
        const removedZero = new URLSearchParams(fixedQuery);
        removedZero.delete("extra");
        expect(parsed(removedZero.toString())).toEqual({ ok: false, errorCode: "invalid_signature" });
    });

    test("empty extensions are excluded while an ASCII uppercase key is included", () => {
        expect(parsed(`${fixedQuery}&another_empty=`)).toEqual(parsed());
        expect(parsed(signed({ A_extra: "signed" }))).toEqual(parsed());
        const changedEmpty = new URLSearchParams(fixedQuery);
        changedEmpty.set("empty", "0");
        expect(parsed(changedEmpty.toString())).toEqual({ ok: false, errorCode: "invalid_signature" });
    });

    test("forged, uppercase, truncated and incorrect-key signatures fail without echoing secrets", () => {
        for (const signature of ["0".repeat(32), fixedSignature.toUpperCase(), fixedSignature.slice(1), "z".repeat(32)]) {
            const forged = new URLSearchParams(fixedQuery);
            forged.set("sign", signature);
            expect(parsed(forged.toString())).toEqual({ ok: false, errorCode: "invalid_signature" });
        }
        expect(parsed(fixedQuery, expected, "synthetic-wrong-key")).toEqual({ ok: false, errorCode: "invalid_signature" });
    });

    test("defaults only an absent sign_type to MD5 and rejects other or empty algorithms", () => {
        const absent = new URLSearchParams(fixedQuery);
        absent.delete("sign_type");
        expect(parsed(absent.toString())).toEqual(parsed());
        for (const sign_type of ["RSA", "HMAC-SHA256", "md5", ""]) {
            expect(parsed(signed({ sign_type }))).toEqual({ ok: false, errorCode: "unsupported_signature_type" });
        }
    });

    test("rejects duplicates before information can be lost, even encoded names and empty values", () => {
        for (const suffix of ["&pid=merchant_synthetic_01", "&%70id=merchant_synthetic_01", `&sign=${fixedSignature}`,
            "&sign_type=MD5", "&empty=", "&unused=&unused="]) {
            expect(parsed(fixedQuery + suffix)).toEqual({ ok: false, errorCode: "invalid_notification_query" });
        }
    });

    test("rejects malformed escapes, UTF-8, controls, illegal keys and fragments", () => {
        for (const suffix of ["&x=%", "&x=%GG", "&x=%C3%28", "&x=%FF", "&x=%00", "&x=\n", "&=x",
            "&bad-key=x", "#fragment", "&x=\uD800"]) {
            expect(parsed(fixedQuery + suffix)).toEqual({ ok: false, errorCode: "invalid_notification_query" });
        }
    });

    test("enforces required local-profile fields without requiring optional param", () => {
        for (const field of ["pid", "name", "money", "out_trade_no", "trade_no", "trade_status", "type", "sign"]) {
            const missing = new URLSearchParams(fixedQuery);
            missing.delete(field);
            expect(parsed(missing.toString())).toEqual({ ok: false, errorCode: "invalid_notification_fields" });
        }
        expect(parsed(signed({ param: undefined }))).toEqual(parsed());
        expect(parsed(signed({ param: "" }))).toEqual(parsed());
    });

    test("keeps identity fields unambiguous and rejects unsupported payment methods", () => {
        for (const [changes, errorCode] of [
            [{ pid: "merchant&x=1" }, "invalid_notification_query"], [{ out_trade_no: "x".repeat(33) }, "invalid_notification_fields"],
            [{ trade_no: "trade=x" }, "invalid_notification_fields"], [{ trade_status: "STATE&x=1" }, "invalid_notification_query"],
            [{ type: "qqpay" }, "invalid_notification_fields"],
        ] as const) {
            expect(parsed(signed(changes))).toEqual({ ok: false, errorCode });
        }
    });

    test("binds independently loaded merchant, order, amount, payment method and known gateway trade", () => {
        for (const [change, errorCode] of [
            [{ merchantId: "other-merchant" }, "merchant_mismatch"], [{ merchantOrderId: "other-order" }, "order_mismatch"],
            [{ amountMinor: "1231" }, "amount_mismatch"], [{ paymentType: "wxpay" }, "payment_type_mismatch"],
            [{ providerTradeNo: "other-trade" }, "provider_trade_mismatch"],
        ] as const) {
            expect(parsed(fixedQuery, { ...expected, ...change })).toEqual({ ok: false, errorCode });
        }
        // A new gateway identity may be observed; only the future DB can uniquely bind it.
        expect(parsed(fixedQuery, { ...expected, providerTradeNo: undefined })).toEqual(parsed());
        expect(parsed(signed({ type: "wxpay" }), { ...expected, paymentType: "wxpay" })).toMatchObject({ ok: true });
    });

    test("compares cash fen exactly, including integers beyond Number's safe range", () => {
        for (const money of ["1", "1.0", "1.00"]) {
            expect(parsed(signed({ money }), { ...expected, amountMinor: "100" })).toMatchObject({ ok: true, notification: { amountMinor: "100" } });
        }
        expect(parsed(signed({ money: "12.3" }))).toEqual(parsed());
        expect(parsed(signed({ money: "0.01" }), { ...expected, amountMinor: "1" })).toMatchObject({ ok: true, notification: { amountMinor: "1" } });
        const huge = signed({ money: "9007199254740993.01" });
        expect(parsed(huge, { ...expected, amountMinor: "900719925474099301" })).toMatchObject({ ok: true, notification: { amountMinor: "900719925474099301" } });
        expect(parsed(huge, { ...expected, amountMinor: "900719925474099300" })).toEqual({ ok: false, errorCode: "amount_mismatch" });
    });

    test("never rounds or coerces signed but invalid cash amounts", () => {
        for (const money of ["0", "0.00", "12.301", "+12.30", "-12.30", " 12.30", "12.30 ", "012.30", "1e2", "NaN", "Infinity", "1,000", ".5", "1."]) {
            expect(parsed(signed({ money }))).toEqual({ ok: false, errorCode: "invalid_amount" });
        }
    });

    test("does not repair invalid expected configuration, currency or secrets", () => {
        for (const change of [{ provider: "other" }, { currency: "USD" }, { merchantId: "" }, { merchantOrderId: "" },
            { amountMinor: 1230 }, { amountMinor: "0" }, { amountMinor: "01230" }, { amountMinor: "12.30" },
            { paymentType: "qqpay" }, { providerTradeNo: "" }]) {
            expect(parsed(fixedQuery, { ...expected, ...change } as ZpayExpectedOrder)).toEqual({ ok: false, errorCode: "invalid_expected_order" });
        }
        expect(parsed(fixedQuery, expected, "")).toEqual({ ok: false, errorCode: "invalid_merchant_key" });
        for (const currency of ["USD", "CNY", ""]) {
            expect(parsed(signed({ currency }))).toEqual({ ok: false, errorCode: "unsupported_currency" });
        }
    });

    test("unknown orders cannot be invented, and a forged unknown-order notice stays invalid", () => {
        expect(parsed(fixedQuery, null)).toEqual({ ok: false, errorCode: "unknown_order" });
        expect(parsed(fixedQuery, null, "synthetic-wrong-key")).toEqual({ ok: false, errorCode: "invalid_signature" });
    });

    test("replay and out-of-order unknown statuses are evidence, never state transitions", () => {
        const success = parsed();
        for (const trade_status of ["WAIT_BUYER_PAY", "TRADE_CLOSED", "TRADE_REFUNDED", "TRADE_SUCCESS_2"]) {
            const observed = parsed(signed({ trade_status }));
            expect(observed).toMatchObject({ ok: true, notification: { kind: "unrecognized_status_notification", tradeStatus: trade_status } });
            if (observed.ok && success.ok) {
                expect(observed.notification.orderIdentity).toBe(success.notification.orderIdentity);
                expect(observed.notification.eventIdentity).not.toBe(success.notification.eventIdentity);
            }
            expect(parsed()).toEqual(success);
        }
        expect(parsed()).toEqual(success);
        expect(parsed(signed({ money: "12.3", name: "另一合成商品名", param: "other-signed-metadata" }))).toEqual(success);
    });
});
