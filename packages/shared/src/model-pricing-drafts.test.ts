import { describe, expect, test } from "bun:test";
import { evaluatePriceRule, parseModelPriceDraftWrite, parseModelPriceRule, parseModelPriceRules, describePriceDraftSupport, type ModelPriceBinding, type ModelPriceRule, type ModelPriceRules } from "./model-pricing-drafts";

const binding: ModelPriceBinding = { providerId: "sample", providerModel: "sample-text", adapter: "openai-compatible", endpoint: "https://provider.example/v1", capability: "text" };
const textSale: ModelPriceRule = { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] };
const textRules: ModelPriceRules = { schemaVersion: 1, cost: null, sale: textSale };
const input = () => ({ modelId: "text-one", expectedVersion: 0, binding: structuredClone(binding), rules: structuredClone(textRules), priceNote: "说明" });

describe("model price draft contracts and exact examples", () => {
    test("text input and output live in one version and sum fractional credits exactly", () => {
        expect(parseModelPriceDraftWrite(input())?.rules).toEqual(textRules);
        expect(evaluatePriceRule(textSale, {}, { input_token: "1000", output_token: "500" })).toEqual({
            status: "calculated", currency: "credit", total: "0.004", bandIndex: 0, lines: [
                { meter: "input_token", quantity: "1000", rate: "2", base: 1_000_000, total: "0.002" },
                { meter: "output_token", quantity: "500", rate: "4", base: 1_000_000, total: "0.002" },
            ],
        });
        const tiny = structuredClone(textSale); tiny.bands[0].rates.input_token = "0.000000000001";
        expect(evaluatePriceRule(tiny, {}, { input_token: "1", output_token: "0" })).toMatchObject({ total: "0.000000000000000001" });
    });
    test("cost and sale may use different units; no invented exchange or gross margin", () => {
        const cost: ModelPriceRule = { template: "image_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "1", output_token: "0", image_input_token: "3", image_output_token: "4" } }] };
        const sale: ModelPriceRule = { template: "image_count", currency: "credit", bands: [{ parameters: {}, rates: { image: "7" } }] };
        const rules = parseModelPriceRules({ schemaVersion: 1, cost, sale }, "image");
        expect(rules).toEqual({ schemaVersion: 1, cost, sale });
        const usage = { input_token: "1000", output_token: "0", image_input_token: "1000", image_output_token: "1000", image: "2" };
        expect(evaluatePriceRule(cost, {}, usage)).toMatchObject({ currency: "USD", total: "0.008" });
        expect(evaluatePriceRule(sale, {}, usage)).toMatchObject({ currency: "credit", total: "14" });
        expect(rules).not.toHaveProperty("grossMargin");
    });
    test("unknown costs stay unknown, including partially unknown cost items", () => {
        expect(parseModelPriceRules(textRules, "text")?.cost).toBeNull();
        const cost: ModelPriceRule = { ...structuredClone(textSale), currency: "CNY" }; cost.bands[0].rates.output_token = null;
        expect(parseModelPriceRule(cost, "text", "cost")).not.toBeNull();
        expect(evaluatePriceRule(cost, {}, { input_token: "1000", output_token: "500" })).toMatchObject({ total: null, lines: [{ total: "0.002" }, { total: null }] });
        expect(parseModelPriceRule({ ...cost, currency: "credit" }, "text", "sale")).toBeNull();
    });
    test("second and whole video prices are distinct, fractional seconds are exact", () => {
        const perSecond: ModelPriceRule = { template: "video_second", currency: "credit", bands: [
            { parameters: { resolution: "720p" }, rates: { second: "0.2" } }, { parameters: { resolution: "1080p" }, rates: { second: "0.5" } },
        ] };
        const perVideo: ModelPriceRule = { template: "video_count", currency: "credit", bands: [{ parameters: { resolution: "720p", durationSeconds: "7.5" }, rates: { video: "9" } }] };
        expect(evaluatePriceRule(perSecond, { resolution: "720p" }, { second: "7.5" })).toMatchObject({ total: "1.5" });
        expect(evaluatePriceRule(perVideo, { resolution: "720p", durationSeconds: "7.500" }, { video: "1" })).toMatchObject({ total: "9" });
        perVideo.bands[0].parameters.durationSeconds = "7.500";
        expect(evaluatePriceRule(perVideo, { resolution: "720p", durationSeconds: "7.5" }, { video: "1" })).toMatchObject({ total: "9" });
        expect(evaluatePriceRule(perVideo, { resolution: "720p", durationSeconds: "7.500" }, { video: "1" })).toMatchObject({ total: "9" });
        expect(evaluatePriceRule(perSecond, { resolution: "4K" }, { second: "7.5" }).status).toBe("no_matching_band");
        expect(evaluatePriceRule(perSecond, {}, { second: "7.5" }).status).toBe("missing_parameters");
        expect(evaluatePriceRule(perSecond, { resolution: "720p" }, {}).status).toBe("missing_usage");
        expect(evaluatePriceRule(perVideo, { resolution: "720p", durationSeconds: "7.5" }, { video: "1.1" }).status).toBe("invalid_sample");
    });
    test("rejects overlapping price bands instead of applying the first or cheapest", () => {
        const sale: ModelPriceRule = { template: "image_count", currency: "credit", bands: [
            { parameters: { size: "1024x1024" }, rates: { image: "1" } }, { parameters: { quality: "high" }, rates: { image: "2" } },
        ] };
        expect(parseModelPriceRule(sale, "image", "sale")).toBeNull();
        sale.bands[1].parameters = { size: "1024x1024" }; expect(parseModelPriceRule(sale, "image", "sale")).toBeNull();
        sale.bands[1].parameters = {}; expect(parseModelPriceRule(sale, "image", "sale")).toBeNull();
        sale.bands[1].parameters = { size: "1536x1024" }; expect(parseModelPriceRule(sale, "image", "sale")).not.toBeNull();
    });
    test("strict nested structure rejects undeclared meters, currencies, parameters and numeric coercion", () => {
        for (const invalid of ["1e3", "NaN", "-1", "1\n", "01", 0, null, ""]) {
            const value = input(); (value.rules.sale.bands[0].rates as Record<string, unknown>).input_token = invalid;
            expect(parseModelPriceDraftWrite(value)).toBeNull();
        }
        for (const mutate of [
            (v: any) => { v.rules.sale.bands[0].rates.cache_read_token = "1"; },
            (v: any) => { v.rules.sale.bands[0].rates.request = "1"; },
            (v: any) => { v.rules.sale.currency = "CNY"; },
            (v: any) => { v.rules.sale.bands[0].parameters.resolution = "720p"; },
            (v: any) => { v.rules.sale.bands = []; },
            (v: any) => { v.binding.capability = "video"; },
            (v: any) => { v.binding.key = "never-accepted"; },
            (v: any) => { v.rules.sale.bands[0].extra = true; },
            (v: any) => { v.rules.schemaVersion = 2; },
            (v: any) => { v.expectedVersion = "0"; },
            (v: any) => { v.published = true; },
            (v: any) => { v.binding.endpoint = "https://user:secret@provider.example"; },
        ]) { const value = input(); mutate(value); expect(parseModelPriceDraftWrite(value)).toBeNull(); }
        expect(evaluatePriceRule(textSale, {}, { input_token: "-1", output_token: "1" }).status).toBe("invalid_sample");
    });
    test("normalizes decimal rates while retaining explicit zero and capability boundaries", () => {
        const value = input(); value.rules.sale.bands[0].rates.input_token = "2.000"; value.rules.sale.bands[0].rates.output_token = "0.000";
        expect(parseModelPriceDraftWrite(value)?.rules.sale.bands[0].rates).toEqual({ input_token: "2", output_token: "0" });
        expect(describePriceDraftSupport(binding, textSale)).toContain("待适配");
        expect(describePriceDraftSupport({ ...binding, capability: "image" }, { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "1" } }] })).toContain("尚未接入实际扣费");
    });
});
