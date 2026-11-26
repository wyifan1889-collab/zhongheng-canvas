import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createZpayPaymentClient, type ZpayPaymentClientConfig } from "./payment-provider-client";
import { parseZpayPaymentNotification, type ZpayExpectedOrder } from "./payment-provider-notification";

const config: ZpayPaymentClientConfig = {
    merchantId: "201901151314084206659771", merchantKey: "synthetic-client-key",
    notifyUrl: "https://canvas.example/api/v1/payments/zpay/notify/version-1",
    timeoutMs: 1000, maxResponseBytes: 8192, paymentLinkOrigins: ["https://pay.example", "http://qr.example"],
};
const expected: ZpayExpectedOrder = {
    provider: "zpay", merchantId: config.merchantId, merchantOrderId: "client-order-1",
    currency: "CNY", amountMinor: "1230", paymentType: "alipay",
};
const input = { expected, name: "合成积分 = + %; ＆", clientIp: "203.0.113.10", channelId: "0" };
const created = (fields: Record<string, unknown> = {}) => JSON.stringify({ code: 1, trade_no: "client-trade-1", ...fields });
const queried = (fields: Record<string, unknown> = {}) => JSON.stringify({ code: 1, status: 1, pid: expected.merchantId,
    out_trade_no: expected.merchantOrderId, trade_no: "client-trade-1", type: "alipay", money: "12.30", ...fields });
const fakeFetch = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
    Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        handler(new URL(url instanceof Request ? url.url : String(url)), init ?? {}), { preconnect() {} }) as typeof fetch;
const responseFetch = (raw: string) => fakeFetch(() => new Response(raw));
const bytesResponse = (chunks: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
}));

function notice() {
    const fields = { pid: expected.merchantId, name: "Synthetic credits", money: "12.30", out_trade_no: expected.merchantOrderId,
        trade_no: "client-trade-1", trade_status: "TRADE_SUCCESS", type: "alipay" };
    const material = Object.keys(fields).sort().map(key => `${key}=${fields[key as keyof typeof fields]}`).join("&");
    const sign = createHash("md5").update(material + config.merchantKey).digest("hex");
    return parseZpayPaymentNotification(new URLSearchParams({ ...fields, sign, sign_type: "MD5" }).toString(), expected, config.merchantKey);
}

describe("ZPay controlled server-only payment client", () => {
    test("requires every safety configuration value and fails without leaking supplied values", () => {
        const invalids = [{ merchantId: "" }, { merchantId: "merchant&other=1" }, { merchantKey: "" },
            { notifyUrl: "http://canvas.example/notify" }, { notifyUrl: "https://user:secret@canvas.example/notify" },
            { notifyUrl: "https://canvas.example/notify?secret=value" }, { notifyUrl: "https://canvas.example/notify#fragment" },
            { timeoutMs: undefined }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: NaN },
            { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 }, { maxResponseBytes: undefined }, { maxResponseBytes: 0 },
            { maxResponseBytes: 1.5 }, { maxResponseBytes: NaN }, { paymentLinkOrigins: undefined },
            { paymentLinkOrigins: ["file:///private"] }, { paymentLinkOrigins: ["https://pay.example/path"] },
            { paymentLinkOrigins: ["https://pay.example?secret=value"] }, { paymentLinkOrigins: ["https://user:secret@pay.example"] },
            { paymentLinkOrigins: ["https://pay.example\n"] }, { paymentLinkOrigins: ["https://pay.example/\uD800"] }];
        for (const change of invalids) expect(() => createZpayPaymentClient({ ...config, ...change } as ZpayPaymentClientConfig, responseFetch(created())))
            .toThrow("invalid_payment_config");
    });

    test("uses exact fixed endpoint, FormData and ASCII sorted MD5 material without a return URL", async () => {
        let calls = 0;
        const client = createZpayPaymentClient(config, fakeFetch((url, init) => {
            calls++;
            expect(url.href).toBe("https://zpayz.cn/mapi.php");
            expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit", cache: "no-store" });
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(init.body).toBeInstanceOf(FormData);
            const form = init.body as FormData;
            expect(Object.fromEntries(form.entries())).toEqual({ pid: expected.merchantId, type: "alipay", out_trade_no: "client-order-1",
                notify_url: config.notifyUrl, name: input.name, money: "12.30", clientip: "203.0.113.10", cid: "0", sign_type: "MD5",
                sign: createHash("md5").update(`cid=0&clientip=203.0.113.10&money=12.30&name=合成积分 = + %; ＆&notify_url=${config.notifyUrl}&out_trade_no=client-order-1&pid=${config.merchantId}&type=alipay${config.merchantKey}`).digest("hex") });
            expect(form.has("return_url")).toBe(false);
            expect(form.has("param")).toBe(false);
            return new Response(created());
        }));
        expect(await client.create(input)).toEqual({ status: "accepted", providerTradeNo: "client-trade-1", paymentLinks: {} });
        expect(calls).toBe(1);
    });

    test("keeps an ampersand merchant secret as the exact MD5 suffix and a single encoded query value", async () => {
        const merchantKey = "synthetic&tail=+%";
        const client = createZpayPaymentClient({ ...config, merchantKey }, fakeFetch((url, init) => {
            if (init.method === "POST") {
                const form = init.body as FormData;
                const material = `clientip=203.0.113.10&money=12.30&name=Synthetic&notify_url=${config.notifyUrl}&out_trade_no=client-order-1&pid=${config.merchantId}&type=alipay`;
                expect(form.get("sign")).toBe(createHash("md5").update(material + merchantKey, "utf8").digest("hex"));
                return new Response(created());
            }
            expect(url.searchParams.get("key")).toBe(merchantKey);
            expect([...url.searchParams.keys()].sort()).toEqual(["act", "key", "out_trade_no", "pid"]);
            return new Response(queried());
        }));
        expect(await client.create({ expected, name: "Synthetic", clientIp: "203.0.113.10" })).toMatchObject({ status: "accepted" });
        const fields = { pid: expected.merchantId, name: "Synthetic", money: "12.30", out_trade_no: expected.merchantOrderId,
            trade_no: "client-trade-1", trade_status: "TRADE_SUCCESS", type: "alipay" };
        const material = Object.keys(fields).sort().map(key => `${key}=${fields[key as keyof typeof fields]}`).join("&");
        const sign = createHash("md5").update(material + merchantKey, "utf8").digest("hex");
        const verified = parseZpayPaymentNotification(new URLSearchParams({ ...fields, sign, sign_type: "MD5" }).toString(), expected, merchantKey);
        expect(verified.ok).toBe(true);
        expect(await client.query(expected, verified)).toMatchObject({ jsonMemberUniqueness: "checked_unique", result: { status: "paid" } });
    });

    test("formats cash fen without Number rounding and accepts a trusted IPv6 peer", async () => {
        const client = createZpayPaymentClient(config, fakeFetch((_url, init) => {
            const form = init.body as FormData;
            expect(form.get("money")).toBe("9007199254740993.01");
            expect(form.get("clientip")).toBe("2001:db8::1");
            expect(form.has("cid")).toBe(false);
            return new Response(created());
        }));
        expect(await client.create({ expected: { ...expected, amountMinor: "900719925474099301" }, name: "Synthetic", clientIp: "2001:db8::1" }))
            .toMatchObject({ status: "accepted" });
    });

    test("rejects invalid server order, signature values and peer IP before any request", async () => {
        let calls = 0;
        const client = createZpayPaymentClient(config, fakeFetch(() => { calls++; return new Response(created()); }));
        for (const change of [{ name: "bad&name=1" }, { name: "" }, { name: "bad\u0000value" }, { name: "\uD800" },
            { channelId: "bad&cid=1" }, { channelId: "" }, { clientIp: "203.0.113.10, 127.0.0.1" }, { clientIp: "not-an-ip" }]) {
            expect(await client.create({ ...input, ...change })).toEqual({ status: "unknown", code: "invalid_create_input" });
        }
        for (const change of [{ merchantOrderId: "x".repeat(33) }, { merchantOrderId: "bad&order=1" }, { amountMinor: "01230" },
            { amountMinor: "0" }, { amountMinor: 1230 }, { amountMinor: "1.23" }, { paymentType: "unsupported" }, { currency: "USD" }]) {
            expect(await client.create({ ...input, expected: { ...expected, ...change } as ZpayExpectedOrder }))
                .toEqual({ status: "unknown", code: "invalid_create_input" });
        }
        expect(await client.create({ ...input, expected: { ...expected, merchantId: "other" } }))
            .toEqual({ status: "unknown", code: "merchant_mismatch" });
        expect(calls).toBe(0);
    });

    test("accepts only original numeric code 1; canonical explicit refusals stay separate from unknown", async () => {
        for (const code of ["0", "-1", "2", "9007199254740993"]) {
            expect(await createZpayPaymentClient(config, responseFetch(`{"code":${code},"msg":"synthetic refusal"}`)).create(input))
                .toEqual({ status: "rejected", code: "provider_rejected" });
        }
        for (const code of ['"1"', '"0"', "1.0", "1e0", "0.0", "0e0", "-0", "true", "null", "{}", "1e400"]) {
            expect(await createZpayPaymentClient(config, responseFetch(`{"code":${code},"trade_no":"client-trade-1"}`)).create(input))
                .toEqual({ status: "unknown", code: "invalid_create_response" });
        }
    });

    test("requires independent trade_no and preserves an optional O_id original numeric identity", async () => {
        const hugeId = "9007199254740993".repeat(24);
        const raw = `{"code":1,"trade_no":"client-trade-1","O_id":${hugeId}}`;
        expect(await createZpayPaymentClient(config, responseFetch(raw)).create(input)).toEqual({ status: "accepted",
            providerTradeNo: "client-trade-1", providerOrderId: hugeId, paymentLinks: {} });
        expect(await createZpayPaymentClient(config, responseFetch(created({ O_id: "provider-order-1" }))).create(input))
            .toMatchObject({ status: "accepted", providerTradeNo: "client-trade-1", providerOrderId: "provider-order-1" });
        for (const raw of ['{"code":1,"O_id":"not-a-trade"}', created({ trade_no: 123 }), created({ trade_no: "bad&trade=1" })]) {
            expect(await createZpayPaymentClient(config, responseFetch(raw)).create(input)).toEqual({ status: "unknown", code: "invalid_provider_trade_no" });
        }
        for (const raw of ['{"code":1,"trade_no":"client-trade-1","O_id":1.0}', created({ O_id: null }), created({ O_id: "" })]) {
            expect(await createZpayPaymentClient(config, responseFetch(raw)).create(input)).toEqual({ status: "unknown", code: "invalid_provider_order_id" });
        }
        expect(await createZpayPaymentClient(config, responseFetch(created())).create({ ...input, expected: { ...expected, providerTradeNo: "other" } }))
            .toEqual({ status: "unknown", code: "provider_trade_mismatch" });
    });

    test("returns only approved http(s) payment links and never fetches those links", async () => {
        let calls = 0;
        const client = createZpayPaymentClient(config, fakeFetch(() => {
            calls++;
            return new Response(created({ payurl: "https://pay.example/pay?id=1", payurl2: "https://pay.example:443/mobile",
                qrcode: "http://qr.example/code", img: "https://pay.example/image.png", unrelated_url: "https://evil.invalid" }));
        }));
        expect(await client.create(input)).toEqual({ status: "accepted", providerTradeNo: "client-trade-1", paymentLinks: {
            payurl: "https://pay.example/pay?id=1", payurl2: "https://pay.example/mobile", qrcode: "http://qr.example/code", img: "https://pay.example/image.png",
        } });
        expect(calls).toBe(1);
    });

    test("rejects the entire creation observation when any delivered link is unapproved or malformed", async () => {
        for (const link of ["https://evil.invalid/pay", "https://pay.example.evil.invalid", "https://pay.example@evil.invalid", "https://user:secret@pay.example/pay",
            "https://pay.example:444/pay", "javascript:alert(1)", "data:image/png,abc", "file:///private", "/relative", "", "https://pay.example/\nsecret", 1, null]) {
            expect(await createZpayPaymentClient(config, responseFetch(created({ payurl: "https://pay.example/good", img: link }))).create(input))
                .toEqual({ status: "unknown", code: "invalid_payment_link" });
        }
        expect(await createZpayPaymentClient({ ...config, paymentLinkOrigins: [] }, responseFetch(created({ payurl: "https://pay.example/pay" }))).create(input))
            .toEqual({ status: "unknown", code: "invalid_payment_link" });
    });

    test("raw duplicate members, escaped duplicates and nested duplicates cannot become acceptance or refusal", async () => {
        for (const raw of ['{"code":0,"code":1,"trade_no":"client-trade-1"}', '{"code":1,"code":0}',
            '{"code":1,"\\u0063ode":0}', created({ extra: "__nested__" }).replace('"__nested__"', '{"status":0,"status":1}')]) {
            expect(await createZpayPaymentClient(config, responseFetch(raw)).create(input)).toEqual({ status: "unknown", code: "duplicate_json_member" });
        }
        for (const raw of [created() + "trailing", '{"code":0,}', '{/* comment */"code":0}', '', '{"code":1,"name":"\\ud800"}']) {
            expect(await createZpayPaymentClient(config, responseFetch(raw)).create(input)).toEqual({ status: "unknown", code: "invalid_json" });
        }
    });

    test("network errors and all non-200 responses remain unknown without retry or secret echo", async () => {
        let calls = 0;
        const client = createZpayPaymentClient(config, fakeFetch(url => { calls++; throw new Error(`private ${url.href} ${config.merchantKey}`); }));
        expect(await client.create(input)).toEqual({ status: "unknown", code: "response_unavailable" });
        expect(calls).toBe(1);
        for (const status of [201, 400, 401, 404, 429, 500, 503]) {
            expect(await createZpayPaymentClient(config, fakeFetch(() => new Response('{"code":0}', { status }))).create(input))
                .toEqual({ status: "unknown", code: "http_response_unknown" });
        }
    });

    test("refuses redirect statuses, redirect flags and changed response URLs without following", async () => {
        for (const makeResponse of [() => new Response(null, { status: 302, headers: { Location: "https://evil.invalid" } }),
            () => Object.defineProperty(new Response(created()), "redirected", { value: true }),
            () => Object.defineProperty(new Response(created()), "url", { value: "https://evil.invalid/mapi.php" })]) {
            let calls = 0;
            expect(await createZpayPaymentClient(config, fakeFetch(() => { calls++; return makeResponse(); })).create(input))
                .toEqual({ status: "unknown", code: "redirected_response" });
            expect(calls).toBe(1);
        }
    });

    test("bounds streamed bytes rather than characters and decodes UTF8 across chunk boundaries", async () => {
        const raw = created({ name: "合成😀" });
        const bytes = new TextEncoder().encode(raw);
        const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
        expect(await createZpayPaymentClient({ ...config, maxResponseBytes: bytes.length }, fakeFetch(() => bytesResponse(chunks))).create(input))
            .toMatchObject({ status: "accepted" });
        expect(await createZpayPaymentClient({ ...config, maxResponseBytes: bytes.length - 1 }, fakeFetch(() => bytesResponse(chunks))).create(input))
            .toEqual({ status: "unknown", code: "response_too_large" });
    });

    test("fatal UTF8 rejects invalid byte sequences, UTF8 encoded surrogate codepoints and truncated tails", async () => {
        for (const bytes of [Uint8Array.of(0xC3, 0x28), Uint8Array.of(0xED, 0xA0, 0x80), Uint8Array.of(0xF0, 0x9F)]) {
            expect(await createZpayPaymentClient(config, fakeFetch(() => bytesResponse([bytes]))).create(input))
                .toEqual({ status: "unknown", code: "invalid_utf8" });
        }
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(created())]);
        expect(await createZpayPaymentClient(config, fakeFetch(() => bytesResponse([bom]))).create(input))
            .toEqual({ status: "unknown", code: "invalid_json" });
    });

    test("bounds a fetch that ignores AbortSignal and cancels a stalled response body", async () => {
        let signal: AbortSignal | null | undefined, calls = 0;
        const client = createZpayPaymentClient({ ...config, timeoutMs: 10 }, fakeFetch((_url, init) => {
            calls++; signal = init.signal; return new Promise<Response>(() => {});
        }));
        expect(await client.create(input)).toEqual({ status: "unknown", code: "provider_timeout" });
        expect(signal?.aborted).toBe(true);
        expect(calls).toBe(1);
        let cancelled = 0;
        const stalled = createZpayPaymentClient({ ...config, timeoutMs: 10 }, fakeFetch(() => new Response(new ReadableStream({ cancel() { cancelled++; } }))));
        expect(await stalled.create(input)).toEqual({ status: "unknown", code: "provider_timeout" });
        expect(cancelled).toBe(1);
    });

    test("does not accept a response whose body read fails after complete-looking JSON", async () => {
        let reads = 0;
        const client = createZpayPaymentClient(config, fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
            pull(controller) { if (reads++ === 0) controller.enqueue(new TextEncoder().encode(created())); else controller.error(new Error("synthetic secret")); },
        }))));
        expect(await client.create(input)).toEqual({ status: "unknown", code: "response_unavailable" });
    });

    test("cancels an ignored-abort late response without reading it or changing the prior unknown result", async () => {
        let deliver!: (response: Response) => void, cancelled = 0;
        const response = new Response(new ReadableStream({ cancel() { cancelled++; } }));
        const client = createZpayPaymentClient({ ...config, timeoutMs: 10 }, fakeFetch(() => new Promise<Response>(resolve => { deliver = resolve; })));
        const result = await client.create(input);
        expect(result).toEqual({ status: "unknown", code: "provider_timeout" });
        deliver(response);
        await Promise.resolve();
        await Promise.resolve();
        expect(cancelled).toBe(1);
        expect(result).toEqual({ status: "unknown", code: "provider_timeout" });
    });

    test("queries only the original order and returns bound paid evidence without crediting state", async () => {
        let calls = 0;
        const client = createZpayPaymentClient(config, fakeFetch((url, init) => {
            calls++;
            expect(url.origin + url.pathname).toBe("https://zpayz.cn/api.php");
            expect(Object.fromEntries(url.searchParams.entries())).toEqual({ act: "order", pid: config.merchantId, key: config.merchantKey, out_trade_no: expected.merchantOrderId });
            expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
            return new Response(queried());
        }));
        const verified = notice();
        expect(verified.ok).toBe(true);
        const result = await client.query(expected, verified);
        expect(result).toMatchObject({ jsonMemberUniqueness: "checked_unique", result: { status: "paid", evidence: {
            merchantId: expected.merchantId, amountMinor: "1230", jsonMemberUniqueness: "not_checked", notification: { kind: "payment_success_notification" },
        } } });
        expect(Object.keys(result).sort()).toEqual(["jsonMemberUniqueness", "result"]);
        expect(calls).toBe(1);
    });

    test("passes original huge pid lexemes to the existing normalizer and keeps status lexical rules", async () => {
        const merchantId = "9007199254740993".repeat(24);
        const raw = queried().replace(`"pid":"${expected.merchantId}"`, `"pid":${merchantId}`);
        expect(await createZpayPaymentClient({ ...config, merchantId }, responseFetch(raw)).query({ ...expected, merchantId }))
            .toMatchObject({ jsonMemberUniqueness: "checked_unique", result: { status: "paid", evidence: { merchantId } } });
        for (const token of ["1.0", "1e0", "-0"]) {
            expect(await createZpayPaymentClient(config, responseFetch(queried().replace('"status":1', `"status":${token}`))).query(expected))
                .toEqual({ jsonMemberUniqueness: "checked_unique", result: { status: "unknown", code: "unsupported_status" } });
        }
        for (const token of ["1.0", "1e0"]) {
            expect(await createZpayPaymentClient(config, responseFetch(queried().replace('"code":1', `"code":${token}`))).query(expected))
                .toEqual({ jsonMemberUniqueness: "checked_unique", result: { status: "unknown", code: "query_not_successful" } });
        }
    });

    test("query rejects raw duplicates before paid normalization and retains explicit binding conflicts", async () => {
        for (const raw of [queried().replace('"status":1', '"status":0,"status":1'), queried().replace('"pid":', '"p\\u0069d":1,"pid":'),
            queried({ extra: "__nested__" }).replace('"__nested__"', '{"__proto__":1,"__proto__":2}')]) {
            expect(await createZpayPaymentClient(config, responseFetch(raw)).query(expected))
                .toEqual({ jsonMemberUniqueness: "rejected", result: { status: "unknown", code: "invalid_json" } });
        }
        expect(await createZpayPaymentClient(config, responseFetch(queried({ money: "12.31" }))).query(expected))
            .toEqual({ jsonMemberUniqueness: "checked_unique", result: { status: "unknown", code: "amount_mismatch" } });
        expect(await createZpayPaymentClient(config, responseFetch(queried({ status: 0 }))).query(expected, notice()))
            .toEqual({ jsonMemberUniqueness: "checked_unique", result: { status: "unknown", code: "notification_query_conflict" } });
    });

    test("query transport, encoding, size and input failures stay unknown with a rejected admission marker", async () => {
        const cases: [typeof fetch, Partial<ZpayPaymentClientConfig>, string][] = [
            [fakeFetch(() => { throw new Error(config.merchantKey); }), {}, "incomplete_response"],
            [fakeFetch(() => new Response(null, { status: 302 })), {}, "redirected_response"],
            [fakeFetch(() => new Response(queried(), { status: 503 })), {}, "http_response_unknown"],
            [fakeFetch(() => bytesResponse([Uint8Array.of(0xC3, 0x28)])), {}, "invalid_json"],
            [responseFetch(queried()), { maxResponseBytes: 1 }, "incomplete_response"],
            [fakeFetch(() => new Promise<Response>(() => {})), { timeoutMs: 10 }, "query_unavailable"],
        ];
        for (const [fetcher, change, code] of cases) expect(await createZpayPaymentClient({ ...config, ...change }, fetcher).query(expected))
            .toEqual({ jsonMemberUniqueness: "rejected", result: { status: "unknown", code } });
        let calls = 0;
        const client = createZpayPaymentClient(config, fakeFetch(() => { calls++; return new Response(queried()); }));
        expect(await client.query({ ...expected, amountMinor: "1.23" })).toEqual({ jsonMemberUniqueness: "rejected", result: { status: "unknown", code: "invalid_expected_order" } });
        expect(await client.query({ ...expected, merchantId: "other" })).toEqual({ jsonMemberUniqueness: "rejected", result: { status: "unknown", code: "merchant_mismatch" } });
        expect(calls).toBe(0);
    });

    test("snapshots configuration so caller mutation cannot change secrets, merchant, callback or link origins", async () => {
        const origins = ["https://pay.example"];
        const mutable = { ...config, paymentLinkOrigins: origins };
        const client = createZpayPaymentClient(mutable, fakeFetch((_url, init) => {
            const form = init.body as FormData;
            expect(form.get("pid")).toBe(config.merchantId);
            expect(form.get("notify_url")).toBe(config.notifyUrl);
            return new Response(created({ payurl: "https://evil.invalid" }));
        }));
        mutable.merchantId = "other"; mutable.merchantKey = "other"; mutable.notifyUrl = "https://evil.invalid/notify";
        origins.push("https://evil.invalid");
        expect(await client.create(input)).toEqual({ status: "unknown", code: "invalid_payment_link" });
    });
});
