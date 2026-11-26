import { expect, test } from "bun:test";
import { executableImageDraftCredits, publishedDraftPrice, publishedTextDraftRates } from "./model-price-publications";
import type { ModelPriceBinding, ModelPriceRules } from "./model-pricing-drafts";

const binding: ModelPriceBinding = { providerId: "channel", providerModel: "text-model", adapter: "openai-compatible", endpoint: "https://example.test/v1", capability: "text" };
const rules = (): ModelPriceRules => ({ schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit",
    bands: [{ parameters: {}, rates: { input_token: "0.00000000000000012300", output_token: "9007199254740993.500" } }] } });

test("text publication keeps both exact rates in one discriminated price without a fabricated scalar", () => {
    const expected = { billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: "0.000000000000000123", outputCreditsPerMillion: "9007199254740993.5" };
    expect(publishedTextDraftRates(binding, rules())).toEqual(expected);
    expect(publishedDraftPrice(binding, rules())).toEqual(expected);
    expect(executableImageDraftCredits(binding, rules())).toBeNull();
    const privateRules = rules();
    privateRules.cost = { template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "0.5", output_token: null } }] };
    expect(publishedDraftPrice(binding, privateRules)).toEqual(expected);
    expect(Object.keys(publishedDraftPrice(binding, privateRules)!)).toEqual(Object.keys(expected));
});

test("publication refuses incomplete, zero, foreign-unit and malformed dual prices", () => {
    for (const change of [
        (v: any) => { delete v.sale.bands[0].rates.output_token; },
        (v: any) => { v.sale.bands[0].rates.output_token = null; },
        (v: any) => { v.sale.bands[0].rates.input_token = "0.000"; },
        (v: any) => { v.sale.bands[0].rates.output_token = "0"; },
        (v: any) => { v.sale.bands[0].rates.input_token = 2; },
        (v: any) => { v.sale.bands[0].rates.input_token = "1e-9"; },
        (v: any) => { v.sale.bands[0].rates.cache_read_token = "1"; },
        (v: any) => { v.sale.currency = "CNY"; },
        (v: any) => { v.sale.bands[0].parameters.quality = "high"; },
        (v: any) => { v.sale.bands.push(structuredClone(v.sale.bands[0])); },
    ]) {
        const value = rules(); change(value);
        expect(publishedDraftPrice(binding, value)).toBeNull();
    }
    expect(publishedDraftPrice({ ...binding, capability: "image" }, rules())).toBeNull();
    expect(publishedDraftPrice({ ...binding, capability: "video" }, rules())).toBeNull();
});

test("single-image publication retains the existing positive integer request contract", () => {
    const image = { ...binding, capability: "image" as const };
    const value: ModelPriceRules = { schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "3" } }] } };
    expect(publishedDraftPrice(image, value)).toEqual({ billingUnit: "request", creditsPerUnit: 3 });
    expect(publishedDraftPrice({ ...image, adapter: "sub2api" }, value)).toBeNull();
    expect(executableImageDraftCredits({ ...image, adapter: "sub2api" }, value)).toBeNull();
    expect(publishedTextDraftRates(image, value)).toBeNull();
    for (const amount of ["0", "0.1", "9007199254740993"]) {
        value.sale.bands[0].rates.request = amount;
        expect(publishedDraftPrice(image, value)).toBeNull();
    }
});

test("Sub2API text publication keeps exact dual rates for its explicit Responses execution profile", () => {
    const sub2api = { ...binding, adapter: "sub2api" as const };
    const expected = { billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: "0.000000000000000123", outputCreditsPerMillion: "9007199254740993.5" };
    expect(publishedTextDraftRates(sub2api, rules())).toEqual(expected);
    expect(publishedDraftPrice(sub2api, rules())).toEqual(expected);
    expect(executableImageDraftCredits(sub2api, rules())).toBeNull();
});
