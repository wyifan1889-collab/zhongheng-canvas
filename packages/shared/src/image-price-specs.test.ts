import { expect, test } from "bun:test";
import { evaluatePriceRule, type ModelPriceBinding, type ModelPriceRules } from "./model-pricing-drafts";
import {
    canonicalImageSpecTaskParameters, executableImageDraftCredits, imageSpecParametersFromTask,
    parseImageSpecParameters, publishedDraftPrice, publishedImageSpecDraftPrice,
    resolveImageSpecDraftSelection, selectImageSpecPrice,
} from "./model-price-publications";

// Synthetic prices and parameter combinations only; no supplier support or real price approval.
const binding: ModelPriceBinding = {
    providerId: "synthetic-image-provider", providerModel: "synthetic-image-model",
    adapter: "openai-compatible", endpoint: "https://image-spec.example.test/v1", capability: "image",
};
const rules = (): ModelPriceRules => ({
    schemaVersion: 1,
    cost: { template: "image_request", currency: "USD", bands: [{ parameters: {}, rates: { request: null } }] },
    sale: { template: "image_request", currency: "credit", bands: [
        { parameters: { size: "1024x1024", quality: "low" }, rates: { request: "2" } },
        { parameters: { size: "2048x2048", quality: "high" }, rates: { request: "7" } },
    ] },
});

test("image specification publication exposes every exact sale combination without a scalar or private rules", () => {
    const value = rules();
    const expected = { billingUnit: "image_specs", creditsPerUnit: null, protocol: "openai-image-v1", imageSpecs: [
        { parameters: { size: "1024x1024", quality: "low" }, creditsPerRequest: 2 },
        { parameters: { size: "2048x2048", quality: "high" }, creditsPerRequest: 7 },
    ] };
    expect(publishedImageSpecDraftPrice(binding, value)).toEqual(expected);
    expect(publishedDraftPrice(binding, value)).toEqual(expected);
    expect(executableImageDraftCredits(binding, value)).toBeNull();
    value.cost!.bands[0].rates.request = "123";
    expect(publishedImageSpecDraftPrice(binding, value)).toEqual(expected);
    expect(Object.keys(publishedImageSpecDraftPrice(binding, value)!)).toEqual(["billingUnit", "creditsPerUnit", "protocol", "imageSpecs"]);
});

test("a rule publication rejects the entire draft when any sale band is outside the first image slice", () => {
    for (const change of [
        (value: ModelPriceRules) => { value.sale.bands[1].parameters.mode = "synthetic-mode"; },
        (value: ModelPriceRules) => { value.sale.bands[1].parameters.size = "auto"; },
        (value: ModelPriceRules) => { value.sale.bands[1].parameters.quality = "auto"; },
        (value: ModelPriceRules) => { value.sale.bands[1].parameters.background = "opaque"; },
        (value: ModelPriceRules) => { value.sale.bands[1].parameters = {}; },
        (value: ModelPriceRules) => { value.sale.bands[1].rates.request = "0"; },
        (value: ModelPriceRules) => { value.sale.bands[1].rates.request = "0.5"; },
        (value: ModelPriceRules) => { value.sale.bands[1].rates.request = "9007199254740993"; },
        (value: ModelPriceRules) => { value.sale.bands.push(structuredClone(value.sale.bands[0])); },
    ]) {
        const value = rules(); change(value);
        expect(publishedImageSpecDraftPrice(binding, value)).toBeNull();
        expect(publishedDraftPrice(binding, value)).toBeNull();
    }
    expect(publishedImageSpecDraftPrice({ ...binding, adapter: "sub2api" }, rules())).toBeNull();
    const count = rules(); count.sale = { template: "image_count", currency: "credit", bands: [{ parameters: { size: "1024x1024" }, rates: { image: "2" } }] };
    expect(publishedImageSpecDraftPrice(binding, count)).toBeNull();
});

test("image selection has no cheapest fallback, missing-field default or Cartesian expansion", () => {
    const value = rules(), price = publishedImageSpecDraftPrice(binding, value)!;
    expect(resolveImageSpecDraftSelection(binding, value, { quality: "high", size: "2048x2048" }))
        .toEqual({ parameters: { size: "2048x2048", quality: "high" }, creditsPerRequest: 7 });
    expect(selectImageSpecPrice(price, { quality: "low", size: "1024x1024" })?.creditsPerRequest).toBe(2);
    for (const parameters of [
        {}, { size: "1024x1024" }, { quality: "high" },
        { size: "1024x1024", quality: "high" }, { size: "2048x2048", quality: "low" },
        { size: "512x512", quality: "low" }, { size: "1024x1024", quality: "low", n: 1 },
    ]) {
        expect(selectImageSpecPrice(price, parameters)).toBeNull();
        expect(resolveImageSpecDraftSelection(binding, value, parameters)).toBeNull();
    }
});

test("single-dimension exact execution does not rewrite the saved draft predicate semantics", () => {
    const value = rules();
    value.sale.bands = [{ parameters: { size: "1024x1024" }, rates: { request: "3" } }];
    expect(evaluatePriceRule(value.sale, { size: "1024x1024", quality: "high" }, { request: "1" }))
        .toMatchObject({ status: "calculated", total: "3" });
    expect(resolveImageSpecDraftSelection(binding, value, { size: "1024x1024", quality: "high" })).toBeNull();
    expect(resolveImageSpecDraftSelection(binding, value, { size: "1024x1024" }))
        .toEqual({ parameters: { size: "1024x1024" }, creditsPerRequest: 3 });
});

test("image spec parser preserves explicit values and rejects unsupported or malformed parameter fields", () => {
    expect(parseImageSpecParameters({ quality: "medium", size: "1024x1024" })).toEqual({ size: "1024x1024", quality: "medium" });
    expect(parseImageSpecParameters({ quality: "low" })).toEqual({ quality: "low" });
    for (const parameters of [
        null, [], {}, { size: undefined }, { quality: undefined }, { size: 1024 },
        { size: "auto" }, { size: "1K" }, { size: "01024x1024" }, { size: "1024X1024" },
        { size: "9007199254740992x1" }, { quality: "standard" }, { quality: "auto" },
        { size: "1024x1024", background: "opaque" }, { size: "1024x1024", mode: "synthetic" },
    ]) expect(parseImageSpecParameters(parameters)).toBeNull();
});

test("canonical rule task parameters include fixed single PNG transport and no hidden choices", () => {
    const selection = { size: "1024x1024", quality: "high" as const };
    const canonical = canonicalImageSpecTaskParameters(selection);
    expect(canonical).toEqual({ protocol: "openai-image-v1", ...selection, n: 1, output_format: "png" });
    expect(imageSpecParametersFromTask(canonical)).toEqual(selection);
    for (const parameters of [
        selection, { ...canonical, n: 11 }, { ...canonical, output_format: "webp" },
        { ...canonical, background: "transparent" }, { ...canonical, response_format: "url" },
        { n: 1, output_format: "png" }, { ...canonical, size: undefined },
    ]) expect(imageSpecParametersFromTask(parameters)).toBeNull();
    expect(() => canonicalImageSpecTaskParameters({})).toThrow();
    expect(imageSpecParametersFromTask(canonicalImageSpecTaskParameters({ ...selection, n: 4 }))).toEqual({ ...selection, n: 4 });
});

test("a malformed or duplicate projected selection cannot select a price", () => {
    const price = publishedImageSpecDraftPrice(binding, rules())!;
    price.imageSpecs.push(structuredClone(price.imageSpecs[0]));
    expect(selectImageSpecPrice(price, price.imageSpecs[0].parameters)).toBeNull();
    price.imageSpecs.pop();
    price.imageSpecs[1].creditsPerRequest = 0;
    expect(selectImageSpecPrice(price, price.imageSpecs[0].parameters)).toBeNull();
});

test("the empty single-band legacy image price is never reinterpreted as a specification", () => {
    const value = rules(); value.sale.bands = [{ parameters: {}, rates: { request: "4" } }];
    expect(publishedImageSpecDraftPrice(binding, value)).toBeNull();
    expect(publishedDraftPrice(binding, value)).toEqual({ billingUnit: "request", creditsPerUnit: 4 });
    expect(imageSpecParametersFromTask({})).toBeNull();
});
