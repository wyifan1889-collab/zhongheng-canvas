import { expect, test } from "bun:test";
import { buildPaymentOffersWrite, paymentOfferDrafts, type PaymentOfferDraft } from "./PaymentPlatformConfiguration";
import type { PaymentConfigurationView } from "../../../../../packages/shared/src/payment-platform";

const id = "483da537-a1ab-427b-9dc3-78cc2abb5241", offerId = "483da537-a1ab-427b-9dc3-78cc2abb5242";
const newVersion = "483da537-a1ab-427b-9dc3-78cc2abb5243", secondOffer = "483da537-a1ab-427b-9dc3-78cc2abb5244";
const config = (): PaymentConfigurationView => ({ runtimeEnabled: false, revision: 8, newOrdersEnabled: false,
    merchant: { id: newVersion, merchantId: "synthetic_only", paymentType: "wxpay", channelId: null, productName: "合成", credentialConfigured: true },
    offers: [{ id, offerId, revision: 2, label: "合成档", amountMinor: "900719925474099301", creditUnits: "9007199254740993.000001", policyReference: "合成规则" }] });

test("exact CNY and credit strings survive beyond float precision without a default conversion ratio", () => {
    const value = config(), drafts = paymentOfferDrafts(value);
    expect(drafts[0]!.amountCny).toBe("9007199254740993.01");
    let generated = 0;
    const write = buildPaymentOffersWrite(value, drafts, false, () => { generated++; return newVersion; });
    expect(write).toEqual({ expectedRevision: 8, newOrdersEnabled: false, items: [{ ...value.offers[0]!, policyReference: "合成规则" }] });
    expect(generated).toBe(0); expect(drafts[0]!.creditUnits).toBe("9007199254740993.000001");
});

test("edits preserve offer identity and allocate one next version; new and removed offers are explicit", () => {
    const value = config(), draft = paymentOfferDrafts(value)[0]!;
    const changed = buildPaymentOffersWrite(value, [{ ...draft, amountCny: "0.01", creditUnits: "0.000002" }], false, () => newVersion);
    expect(changed.items[0]).toMatchObject({ id: newVersion, offerId, revision: 3, amountMinor: "1", creditUnits: "0.000002" });
    expect(value.offers[0]!.id).toBe(id); expect(value.offers[0]!.revision).toBe(2);
    const fresh: PaymentOfferDraft = { offerId: secondOffer, label: "新增合成档", amountCny: "0.02", creditUnits: "0.000003", policyReference: "" };
    expect(buildPaymentOffersWrite(value, [fresh], false, () => newVersion).items[0]).toEqual({ id: newVersion, offerId: secondOffer, revision: 1,
        label: "新增合成档", amountMinor: "2", creditUnits: "0.000003" });
    expect(buildPaymentOffersWrite(value, [], false).items).toEqual([]);
});

test("invalid amounts and missing rules cannot create an enabled configuration", () => {
    const value = config(), draft = paymentOfferDrafts(value)[0]!;
    for (const amountCny of ["", "0", "0.001", "1e2", "-1", "01", " 1", "1,00"]) {
        expect(() => buildPaymentOffersWrite(value, [{ ...draft, amountCny }], false)).toThrow();
    }
    for (const creditUnits of ["", "0", "-1", "1e2", "NaN", "01"]) {
        expect(() => buildPaymentOffersWrite(value, [{ ...draft, creditUnits }], false)).toThrow();
    }
    expect(() => buildPaymentOffersWrite(value, [{ ...draft, policyReference: "" }], true)).toThrow("经营规则依据");
    expect(() => buildPaymentOffersWrite({ ...value, merchant: null }, [draft], true)).toThrow("商户凭据");
    expect(() => buildPaymentOffersWrite(value, [], true)).toThrow("商户凭据");
    expect(() => buildPaymentOffersWrite(value, [draft, draft], false)).toThrow("重复");
});

test("unchanged nullable policy remains omitted, and runtime stays independently closed", () => {
    const value = config(); value.offers[0]!.policyReference = null;
    const drafts = paymentOfferDrafts(value), unchanged = buildPaymentOffersWrite(value, drafts, false, () => { throw new Error("unexpected UUID"); });
    expect(unchanged.items[0]!.policyReference).toBeUndefined(); expect(unchanged.items[0]!.id).toBe(id);
    drafts[0]!.policyReference = "已批准的合成规则";
    const enabled = buildPaymentOffersWrite(value, drafts, true, () => newVersion);
    expect(enabled.newOrdersEnabled).toBe(true); expect(value.runtimeEnabled).toBe(false);
    expect(enabled).not.toHaveProperty("runtimeEnabled");
});
