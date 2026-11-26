import { describe, expect, test } from "bun:test";
import { validatePaymentJson } from "./payment-provider-json";
import { normalizeZpayOrderQuery } from "./payment-provider-order-query";
import type { ZpayExpectedOrder } from "./payment-provider-notification";

const unique = { ok: true, jsonMemberUniqueness: "checked_unique" };
const duplicate = { ok: false, code: "duplicate_json_member" };
const invalid = { ok: false, code: "invalid_json" };

describe("payment raw JSON admission", () => {
    test("admits strict JSON without inventing an envelope or numeric payload", () => {
        for (const raw of ['{}', '[]', 'null', 'true', 'false', '0', '1e400', '"text"', '\t\r\n {"code":1,"status":0} \n']) {
            expect(validatePaymentJson(raw)).toEqual(unique);
        }
    });

    test("rejects repeated code and status regardless of order or matching value", () => {
        for (const raw of ['{"code":0,"code":1}', '{"code":1,"code":0}', '{"code":1,"code":1}',
            '{"status":0,"status":1}', '{"status":1,"status":0}', '{"status":1,"status":1}']) {
            expect(validatePaymentJson(raw)).toEqual(duplicate);
        }
    });

    test("compares decoded keys including escaped pid and escaped Unicode pairs", () => {
        for (const raw of ['{"pid":1,"p\\u0069d":2}', '{"\\u0070id":1,"pid":2}',
            '{"😀":1,"\\ud83d\\ude00":2}', '{"a\\u0000":1,"a\\u0000":2}']) {
            expect(validatePaymentJson(raw)).toEqual(duplicate);
        }
    });

    test("checks every nested object including objects inside arrays", () => {
        for (const raw of ['{"safe":{"pid":1,"pid":2}}', '[{"code":1,"code":0}]',
            '{"rows":[[{}, {"safe":true,"safe":false}]]}', '{"first":{},"second":{"nested":{"status":0,"status":1}}}']) {
            expect(validatePaymentJson(raw)).toEqual(duplicate);
        }
    });

    test("keeps object scopes separate across nesting, siblings and arrays", () => {
        expect(validatePaymentJson('{"pid":1,"nested":{"pid":2},"rows":[{"pid":3},{"pid":4}],"tail":{"pid":5}}')).toEqual(unique);
        expect(validatePaymentJson('{"rows":[{},[]],"pid":1,"pid":2}')).toEqual(duplicate);
    });

    test("handles prototype-shaped member names as ordinary own names", () => {
        expect(validatePaymentJson('{"__proto__":{},"constructor":{},"toString":0,"hasOwnProperty":false}')).toEqual(unique);
        for (const raw of ['{"__proto__":1,"__proto__":2}', '{"constructor":1,"constructor":2}',
            '{"toString":1,"toString":2}', '{"__proto__":1,"__pr\\u006fto__":2}']) {
            expect(validatePaymentJson(raw)).toEqual(duplicate);
        }
    });

    test("rejects comments, trailing commas, empty content and non-JSON syntax", () => {
        for (const raw of ['', ' \t\n\r', '// note\n{}', '{/* note */"code":1}', '{"code":1}// note',
            '{"code":1,}', '[1,]', '{', '{code:1}', "{'code':1}", '{"code":01}', '{"code":NaN}',
            '{"code":Infinity}', 'true false', '{}{}', '\uFEFF{}', '{"name":"raw\u0000control"}', '{"name":"\\x41"}']) {
            expect(validatePaymentJson(raw)).toEqual(invalid);
        }
    });

    test("does not accept a duplicate-bearing document with any syntax error", () => {
        for (const raw of ['{"pid":1,"pid":2,}', '{"pid":1,"pid":2} trailing', '[{"pid":1,"pid":2}',
            '{"pid":1,"pid":2,"broken":"\\uZZZZ"}']) {
            expect(validatePaymentJson(raw)).toEqual(invalid);
        }
    });

    test("rejects lone surrogates in raw and decoded member names and values", () => {
        for (const raw of ['"\uD800"', '"\uDC00"', '{"\uD800":1}', '{"name":"\uDC00"}',
            '"\\ud800"', '"\\udfff"', '{"\\ud800":1}', '{"name":"\\udc00"}',
            '["\\ud800x"]', '"\\udc00\\ud800"']) {
            expect(validatePaymentJson(raw)).toEqual(invalid);
        }
        expect(validatePaymentJson('{"pid":1,"pid":2,"name":"\\ud800"}')).toEqual(invalid);
    });

    test("accepts valid Unicode pairs, noncharacters and a literal replacement character", () => {
        for (const raw of ['"😀"', '"\\ud83d\\ude00"', '{"😀":"\\ud83d\\ude00"}',
            '"�"', '"\\ufffd"', '"\\uffff"']) {
            expect(validatePaymentJson(raw)).toEqual(unique);
        }
    });

    test("forwards the same huge numeric pid text without narrowing the original query contract", () => {
        const merchantId = "9007199254740993".repeat(24);
        const order: ZpayExpectedOrder = { provider: "zpay", merchantId, merchantOrderId: "json-order-1",
            providerTradeNo: "json-trade-1", currency: "CNY", amountMinor: "1230", paymentType: "alipay" };
        const raw = `{"code":1,"status":1,"pid":${merchantId},"out_trade_no":"json-order-1","trade_no":"json-trade-1","type":"alipay","money":"12.30"}`;
        expect(validatePaymentJson(raw)).toEqual(unique);
        expect(normalizeZpayOrderQuery({ kind: "response", httpStatus: 200, redirected: false, complete: true, body: raw }, order))
            .toMatchObject({ status: "paid", evidence: { merchantId, amountMinor: "1230", jsonMemberUniqueness: "not_checked" } });
        expect(raw).toContain(`"pid":${merchantId},`);
    });

    test("fails safely when called at runtime with a pre-parsed value", () => {
        for (const raw of [null, undefined, {}, [], 1, new String('{}')]) {
            expect(validatePaymentJson(raw as never)).toEqual(invalid);
        }
    });
});
