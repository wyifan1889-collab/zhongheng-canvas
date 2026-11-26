import { expect, test } from "bun:test";
import { createPaymentPlatformClient, PaymentPlatformError, type PaymentPlatformScope } from "./payment-platform";
import type { AdminPaymentMerchant, PaymentConfigurationView, PaymentMerchantWrite, PaymentOffersWrite } from "../../../../packages/shared/src/payment-platform";

const id = "e2da1111-b618-483b-abd8-88a65ac25a11", offerId = "e2da1111-b618-483b-abd8-88a65ac25a12";
const intent = "e2da1111-b618-483b-abd8-88a65ac25a13", nextIntent = "e2da1111-b618-483b-abd8-88a65ac25a14";
const scope: PaymentPlatformScope = { accountId: "synthetic-admin", epoch: 1, role: "admin" };
const empty = (): PaymentConfigurationView => ({ runtimeEnabled: false, revision: 0, newOrdersEnabled: false, merchant: null, offers: [] });
const merchant: PaymentMerchantWrite = { expectedRevision: 0, merchantId: "synthetic_only", merchantKey: "write-only-test-secret", paymentType: "wxpay", productName: "合成配置" };
const receipt = (): AdminPaymentMerchant => ({ id: intent, merchantId: merchant.merchantId, paymentType: merchant.paymentType,
    channelId: null, productName: merchant.productName, credentialConfigured: true });
const offers = (): PaymentOffersWrite => ({ expectedRevision: 0, newOrdersEnabled: false, items: [
    { id, offerId, revision: 1, label: "合成档", amountMinor: "900719925474099301", creditUnits: "1.01", policyReference: "synthetic-policy" },
] });
function fixture(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    let current: PaymentPlatformScope | null = scope, invalidations = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createPaymentPlatformClient({ scope, getScope: () => current, onAccountInvalidated: () => { invalidations++; },
        fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as typeof fetch });
    return { client, calls, changeScope: (value: PaymentPlatformScope | null) => { current = value; }, invalidations: () => invalidations };
}
const ok = (config: unknown) => Response.json({ config, requestId: "synthetic-request" });
async function error(action: Promise<unknown>, code: string, outcome?: string) {
    const caught = await action.then(() => null, value => value);
    expect(caught).toBeInstanceOf(PaymentPlatformError); expect(caught.code).toBe(code);
    if (outcome) expect(caught.outcome).toBe(outcome);
    return caught as PaymentPlatformError;
}

test("only fixed same-origin routes, admin scope and explicit baseline read", async () => {
    const f = fixture(() => ok(empty()));
    await error(f.client.saveMerchant(intent, merchant), "configuration_read_required", "not-sent");
    expect(f.calls).toHaveLength(0);
    await f.client.readConfiguration();
    const request = f.calls[0]!;
    expect(request.url).toBe("/api/v1/admin/payments/config");
    expect(request.init).toMatchObject({ credentials: "include", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(new Headers(request.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    f.changeScope({ ...scope, role: "user" });
    await error(f.client.readConfiguration(), "context_changed"); expect(f.calls).toHaveLength(1);
});

test("strict DTO rejects scalar cash, illegal credits, arrays, enums and credential leakage", async () => {
    const valid = { ...empty(), offers: [{ ...offers().items[0], policyReference: "synthetic-policy" }] };
    const invalidConfigs: unknown[] = [[], { ...empty(), merchantKey: "should-never-surface" },
        { ...valid, offers: [{ ...valid.offers[0], amountMinor: 1 }] },
        { ...valid, offers: [{ ...valid.offers[0], amountMinor: "1.01" }] },
        { ...valid, offers: [{ ...valid.offers[0], creditUnits: "-1" }] },
        { ...valid, offers: [{ ...valid.offers[0], creditUnits: "1.010" }] },
        { ...valid, offers: [{ ...valid.offers[0], secret: "should-never-surface" }] },
        { ...empty(), merchant: { id, merchantId: "synthetic", paymentType: "card", channelId: null, productName: "合成", credentialConfigured: true } },
        { ...valid, offers: [valid.offers[0], { ...valid.offers[0], id: nextIntent }] },
    ];
    for (const value of invalidConfigs) {
        const f = fixture(() => ok(value));
        const caught = await error(f.client.readConfiguration(), "read_failed");
        expect(caught.message).not.toContain("should-never-surface");
    }
    const f = fixture(() => ok(empty())); await f.client.readConfiguration();
    for (const input of [{ ...offers(), items: [{ ...offers().items[0], creditUnits: 1 }] },
        { ...offers(), newOrdersEnabled: true, items: [{ ...offers().items[0], policyReference: undefined }] },
        { ...offers(), items: [{ ...offers().items[0], amountMinor: "0" }] }, { ...offers(), merchantKey: "extra" },
        { ...offers(), items: [offers().items[0], { ...offers().items[0], id: nextIntent }] }]) {
        await error(f.client.saveOffers(intent, input as PaymentOffersWrite), "invalid_input", "not-sent");
    }
    await error(f.client.saveMerchant(intent, { ...merchant, paymentType: "card" } as unknown as PaymentMerchantWrite), "invalid_input");
    expect(f.calls).toHaveLength(1);
});

test("acknowledged write uses receipt, never refreshes or reuses an intent", async () => {
    const f = fixture((_, init) => init?.method === "GET" ? ok(empty()) : ok({ ...empty(), revision: 1 }));
    await f.client.readConfiguration();
    expect(await f.client.saveOffers(intent, offers())).toMatchObject({ revision: 1 });
    expect(f.calls).toHaveLength(2); expect(f.calls[1]!.url).toBe("/api/v1/admin/payments/offers");
    expect(JSON.parse(String(f.calls[1]!.init?.body))).toEqual(offers());
    await error(f.client.saveOffers(intent, offers()), "intent_already_sent", "not-sent");
    expect(f.client.getPendingIntent()).toBeNull(); expect(f.calls).toHaveLength(2);
});

test("network unknown preserves intent, blocks new writes and only matching GET settles offers", async () => {
    let current = empty();
    const f = fixture((_, init) => { if (init?.method === "PUT") throw new Error("secret transport detail"); return ok(current); });
    await f.client.readConfiguration();
    const caught = await error(f.client.saveOffers(intent, offers()), "outcome_unknown", "unknown");
    expect(caught.message).not.toContain("secret transport detail");
    expect(f.client.getPendingIntent()).toEqual({ id: intent, kind: "offers" });
    await error(f.client.saveOffers(nextIntent, offers()), "outcome_unknown"); expect(f.calls).toHaveLength(2);
    await f.client.readConfiguration(); expect(f.client.getPendingIntent()).not.toBeNull();
    current = { ...empty(), revision: 1, offers: [{ ...offers().items[0]!, policyReference: "synthetic-policy" }] };
    await f.client.readConfiguration(); expect(f.client.getPendingIntent()).toBeNull();
    await error(f.client.saveOffers(intent, offers()), "intent_already_sent");
});

test("replacing the first of two offers recovers a lost ACK from a reordered exact GET without another PUT", async () => {
    const first = { ...offers().items[0]!, policyReference: "synthetic-policy" }, second = { ...first, id: crypto.randomUUID(), offerId: crypto.randomUUID(), label: "合成第二档", amountMinor: "202", creditUnits: "0.02" };
    const replacement = { ...first, id: crypto.randomUUID(), revision: 2, label: "合成第一档新版本", amountMinor: "303", creditUnits: "0.03" };
    const input: PaymentOffersWrite = { expectedRevision: 7, newOrdersEnabled: false, items: [replacement, second] };
    let current: PaymentConfigurationView = { ...empty(), revision: 7, merchant: receipt(), offers: [first, second] };
    const f = fixture((_, init) => {
        if (init?.method === "PUT") {
            expect(JSON.parse(String(init.body))).toEqual(input);
            current = { ...current, revision: 8, offers: [second, replacement] };
            throw new Error(`synthetic discarded commit ACK ${merchant.merchantKey}`);
        }
        return ok(current);
    });
    expect((await f.client.readConfiguration()).offers.map(row => row.id)).toEqual([first.id, second.id]);
    const caught = await error(f.client.saveOffers(intent, input), "outcome_unknown", "unknown");
    expect(caught.message).not.toContain(merchant.merchantKey); expect(f.client.getPendingIntent()).toEqual({ id: intent, kind: "offers" });
    await error(f.client.saveOffers(nextIntent, input), "outcome_unknown");
    const recovered = await f.client.readConfiguration();
    expect(recovered.offers.map(row => row.id)).toEqual([second.id, replacement.id]); expect(f.client.getPendingIntent()).toBeNull();
    expect(f.client.requiresConfigurationRead()).toBe(false);
    await error(f.client.saveOffers(intent, input), "intent_already_sent", "not-sent");
    expect(f.calls.filter(call => call.init?.method === "PUT")).toHaveLength(1);
    expect(JSON.stringify({ recovered, pending: f.client.getPendingIntent(), calls: f.calls })).not.toContain(merchant.merchantKey);
    expect(recovered.merchant).not.toHaveProperty("merchantKey");
});

test("reordered offer GET keeps unknown pending for every mismatched identity, value, count, gate or revision", async () => {
    const first = { ...offers().items[0]!, policyReference: "synthetic-policy" }, second = { ...first, id: crypto.randomUUID(), offerId: crypto.randomUUID(), label: "合成第二档", amountMinor: "202", creditUnits: "0.02" };
    const input: PaymentOffersWrite = { expectedRevision: 7, newOrdersEnabled: false, items: [first, second] };
    const exact: PaymentConfigurationView = { ...empty(), revision: 8, merchant: receipt(), offers: [second, first] };
    let current = empty();
    const f = fixture((_, init) => { if (init?.method === "PUT") throw new Error("synthetic ACK lost"); return ok(current); });
    await f.client.readConfiguration(); await error(f.client.saveOffers(intent, input), "outcome_unknown");
    const changes = [{ id: crypto.randomUUID() }, { offerId: crypto.randomUUID() }, { revision: 2 }, { label: "different" },
        { amountMinor: "1" }, { creditUnits: "0.01" }, { policyReference: "different" }, { policyReference: null }];
    const mismatches = [{ ...exact, revision: 7 }, { ...exact, newOrdersEnabled: true }, { ...exact, offers: [second] },
        ...changes.map(change => ({ ...exact, offers: [second, { ...first, ...change }] }))];
    for (const mismatch of mismatches) {
        current = mismatch; await f.client.readConfiguration();
        expect(f.client.getPendingIntent()).toEqual({ id: intent, kind: "offers" });
        await error(f.client.saveOffers(nextIntent, input), "outcome_unknown");
    }
    current = exact; await f.client.readConfiguration(); expect(f.client.getPendingIntent()).toBeNull();
    expect(f.calls.filter(call => call.init?.method === "PUT")).toHaveLength(1);
});

test("merchant unknown config GET alone cannot permit blind resend", async () => {
    const f = fixture((_, init) => { if (init?.method === "PUT") return new Response("unexpected secret body", { status: 502 }); return ok(empty()); });
    await f.client.readConfiguration(); await error(f.client.saveMerchant(intent, merchant), "outcome_unknown");
    await f.client.readConfiguration(); expect(f.client.getPendingIntent()).toEqual({ id: intent, kind: "merchant" });
    await error(f.client.saveMerchant(nextIntent, merchant), "outcome_unknown"); expect(f.calls).toHaveLength(3);
});

test("CAS rejection requires GET; safe errors never expose server messages", async () => {
    const f = fixture((_, init) => init?.method === "PUT"
        ? Response.json({ error: { code: "payment_config_conflict", message: "raw secret" } }, { status: 409 }) : ok(empty()));
    await f.client.readConfiguration();
    const caught = await error(f.client.saveOffers(intent, offers()), "payment_config_conflict", "rejected");
    expect(caught.message).not.toContain("raw secret"); expect(f.client.getPendingIntent()).toBeNull();
    await error(f.client.saveOffers(nextIntent, offers()), "configuration_read_required"); expect(f.calls).toHaveLength(2);
    await f.client.readConfiguration(); expect(f.client.requiresConfigurationRead()).toBe(false);
});

test("malformed success is unknown, while later read failure does not undo a received receipt", async () => {
    let reading = 0;
    const acknowledged = fixture((_, init) => init?.method === "PUT" ? Response.json({ config: { ...empty(), revision: 1 }, receipt: receipt() })
        : ++reading === 1 ? ok(empty()) : Response.json({ error: { code: "internal", message: "secret" } }, { status: 500 }));
    await acknowledged.client.readConfiguration();
    expect(await acknowledged.client.saveMerchant(intent, merchant)).toMatchObject({ revision: 1 });
    await error(acknowledged.client.readConfiguration(), "read_failed");
    expect(acknowledged.client.getPendingIntent()).toBeNull();
    await error(acknowledged.client.saveMerchant(intent, merchant), "intent_already_sent");
    const malformed = fixture((_, init) => init?.method === "PUT" ? ok({ ...empty(), revision: 1, merchantKey: "secret" }) : ok(empty()));
    await malformed.client.readConfiguration();
    await error(malformed.client.saveMerchant(intent, merchant), "outcome_unknown");
    expect(malformed.client.getPendingIntent()).toEqual({ id: intent, kind: "merchant" });
});

test("merchant receipt requires the original intent header and permits a different active merchant", async () => {
    const active = { ...receipt(), id: nextIntent, merchantId: "later_synthetic_only" };
    const f = fixture((_, init) => init?.method === "PUT" ? Response.json({ config: { ...empty(), revision: 2, merchant: active }, receipt: receipt() }) : ok(empty()));
    await f.client.readConfiguration();
    const current = await f.client.saveMerchant(intent, merchant);
    expect(current.merchant?.id).toBe(nextIntent); expect(f.client.getPendingIntent()).toBeNull();
    expect(new Headers(f.calls[1]!.init?.headers).get("Idempotency-Key")).toBe(intent);
    expect(JSON.parse(String(f.calls[1]!.init?.body))).toEqual(merchant); expect(f.calls).toHaveLength(2);
});

test("merchant receipt recovers a lost PUT response by original operation after active configuration changes", async () => {
    const active = { ...receipt(), id: nextIntent, merchantId: "later_synthetic_only" };
    let reads = 0;
    const f = fixture((url, init) => {
        if (init?.method === "PUT") throw new Error("lost response");
        if (url.includes("/merchant-operations/")) return Response.json({ receipt: receipt() });
        return ok(++reads === 1 ? empty() : { ...empty(), revision: 2, merchant: active });
    });
    await f.client.readConfiguration(); await error(f.client.saveMerchant(intent, merchant), "outcome_unknown");
    await error(f.client.readMerchantOperation(intent), "configuration_read_required"); expect(f.calls).toHaveLength(2);
    const current = await f.client.readConfiguration(); expect(current.merchant?.id).toBe(nextIntent);
    expect(await f.client.readMerchantOperation(intent)).toEqual(receipt()); expect(f.client.getPendingIntent()).toBeNull();
    expect(f.calls[3]!.url).toBe(`/api/v1/admin/payments/merchant-operations/${intent}`);
    expect(f.calls[3]!.init).toMatchObject({ method: "GET", credentials: "include", mode: "same-origin" });
    expect(new Headers(f.calls[3]!.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(f.calls.filter(call => call.init?.method === "PUT")).toHaveLength(1);
    await error(f.client.saveMerchant(intent, merchant), "intent_already_sent");
});

test("merchant receipt 404 or failed GET keeps the original pending intent and blocks a new PUT", async () => {
    for (const mode of ["not-found", "network"] as const) {
        let permitReceipt = false;
        const f = fixture((url, init) => {
            if (init?.method === "PUT") throw new Error("lost response");
            if (!url.includes("/merchant-operations/")) return ok(empty());
            if (permitReceipt) return Response.json({ receipt: receipt() });
            if (mode === "network") throw new Error("raw secret");
            return Response.json({ error: { code: "payment_not_found", message: "raw secret" } }, { status: 404 });
        });
        await f.client.readConfiguration(); await error(f.client.saveMerchant(intent, merchant), "outcome_unknown");
        await f.client.readConfiguration();
        const caught = await error(f.client.readMerchantOperation(intent), mode === "network" ? "read_failed" : "payment_not_found");
        expect(caught.message).not.toContain("raw secret"); expect(f.client.getPendingIntent()).toEqual({ id: intent, kind: "merchant" });
        await error(f.client.saveMerchant(nextIntent, merchant), "outcome_unknown");
        expect(f.calls.filter(call => call.init?.method === "PUT")).toHaveLength(1);
        permitReceipt = true; await f.client.readMerchantOperation(intent); expect(f.client.getPendingIntent()).toBeNull();
    }
});

test("merchant receipt rejects bad, different-id, changed-input and secret-bearing PUT or GET receipts", async () => {
    const invalidReceipts: unknown[] = [[], { ...receipt(), id: nextIntent }, { ...receipt(), merchantId: "different" },
        { ...receipt(), paymentType: "card" }, { ...receipt(), credentialConfigured: false }, { ...receipt(), merchantKey: "raw secret" }];
    for (const invalidReceipt of invalidReceipts) {
        const f = fixture((url, init) => init?.method === "PUT" ? Response.json({ config: { ...empty(), revision: 1 }, receipt: invalidReceipt })
            : url.includes("/merchant-operations/") ? Response.json({ receipt: invalidReceipt }) : ok(empty()));
        await f.client.readConfiguration();
        const rejectedPut = await error(f.client.saveMerchant(intent, merchant), "outcome_unknown");
        expect(rejectedPut.message).not.toContain("raw secret");
        await f.client.readConfiguration(); await error(f.client.readMerchantOperation(intent), "read_failed");
        expect(f.client.getPendingIntent()).toEqual({ id: intent, kind: "merchant" });
    }
});

test("merchant receipt arriving after an account change cannot clear pending or invalidate the new scope", async () => {
    let resolve!: (response: Response) => void;
    const gate = new Promise<Response>(done => { resolve = done; });
    const f = fixture((url, init) => {
        if (init?.method === "PUT") throw new Error("lost response");
        return url.includes("/merchant-operations/") ? gate : ok(empty());
    });
    await f.client.readConfiguration(); await error(f.client.saveMerchant(intent, merchant), "outcome_unknown");
    await f.client.readConfiguration(); const reading = f.client.readMerchantOperation(intent);
    f.changeScope({ ...scope, epoch: 2 }); resolve(Response.json({ receipt: receipt() }));
    await error(reading, "context_changed"); expect(f.invalidations()).toBe(0);
    expect(f.client.getPendingIntent()).toEqual({ id: intent, kind: "merchant" });
    expect(f.calls[3]!.init?.signal?.aborted).toBe(true);
    const fresh = fixture(() => ok(empty())); await fresh.client.readConfiguration(); expect(fresh.client.getPendingIntent()).toBeNull();
});

test("late account responses cannot show data, invalidate new scope or unfreeze writes", async () => {
    let resolve!: (response: Response) => void;
    const gate = new Promise<Response>(done => { resolve = done; });
    const f = fixture(() => gate);
    const read = f.client.readConfiguration();
    f.changeScope({ ...scope, epoch: 2 });
    resolve(Response.json({ error: { code: "account_changed", message: "secret" } }, { status: 409 }));
    await error(read, "context_changed"); expect(f.invalidations()).toBe(0);
    expect(f.calls[0]!.init?.signal?.aborted).toBe(true);
});

test("close aborts outstanding write; concurrent writes never send", async () => {
    let resolve!: (response: Response) => void;
    const gate = new Promise<Response>(done => { resolve = done; });
    const f = fixture((_, init) => init?.method === "PUT" ? gate : ok(empty()));
    await f.client.readConfiguration(); const writing = f.client.saveMerchant(intent, merchant);
    await error(f.client.saveMerchant(nextIntent, merchant), "outcome_unknown");
    f.client.close(); resolve(ok({ ...empty(), revision: 1 }));
    await error(writing, "context_changed", "unknown"); expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.init?.signal?.aborted).toBe(true);
});
