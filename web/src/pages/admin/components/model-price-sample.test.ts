import { expect, test } from "bun:test";
import { manualPriceSample } from "./model-price-sample";
import type { ModelPriceRule } from "@/services/saas/platform";

const dual = (currency: ModelPriceRule["currency"]): ModelPriceRule => ({ template: "text_tokens", currency, bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] });
const cached = (currency: ModelPriceRule["currency"]): ModelPriceRule => ({ template: "text_cached_tokens", currency, bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.5", output_token: "4" } }] });

test("one manual total uses each cost or sale template's own input scope in both directions", () => {
    const usage = { input_token: "1000", cached_input_token: "400", output_token: "500" };
    expect(manualPriceSample(dual("USD"), {}, usage)).toMatchObject({ status: "calculated", total: "0.004" });
    expect(manualPriceSample(cached("credit"), {}, usage)).toMatchObject({ status: "calculated", total: "0.0034", lines: [{ meter: "input_token", quantity: "600" }, { meter: "cached_input_token", quantity: "400" }, { meter: "output_token", quantity: "500" }] });
    expect(manualPriceSample(cached("USD"), {}, usage)).toMatchObject({ status: "calculated", total: "0.0034" });
    expect(manualPriceSample(dual("credit"), {}, usage)).toMatchObject({ status: "calculated", total: "0.004" });
    expect(usage).toEqual({ input_token: "1000", cached_input_token: "400", output_token: "500" });
});

test("cache subtraction remains exact above Number's safe integer range", () => {
    const result = manualPriceSample(cached("credit"), {}, { input_token: "9007199254740993", cached_input_token: "9007199254740992", output_token: "1" });
    expect(result).toMatchObject({ status: "calculated", total: "4503599627.370502" });
    if (result.status === "calculated") expect(result.lines[0].quantity).toBe("1");
});

test("manual cache quantities are explicit integer subsets and are never filled with zero", () => {
    for (const value of [undefined, ""]) expect(manualPriceSample(cached("credit"), {}, { input_token: "10", cached_input_token: value, output_token: "1" })).toEqual({ status: "missing_usage", fields: ["cached_input_token"] });
    for (const value of ["11", "1.5", "-1", "NaN", "1e1"]) expect(manualPriceSample(cached("credit"), {}, { input_token: "10", cached_input_token: value, output_token: "1" })).toEqual({ status: "invalid_sample", fields: ["cached_input_token"] });
    expect(manualPriceSample(cached("credit"), {}, { input_token: "0.5", cached_input_token: "0", output_token: "1" })).toEqual({ status: "invalid_sample", fields: ["input_token"] });
    expect(manualPriceSample(cached("credit"), {}, { input_token: "10", cached_input_token: "0", output_token: "1" })).toMatchObject({ status: "calculated", total: "0.000024" });
    expect(manualPriceSample(cached("credit"), {}, { input_token: "10", cached_input_token: "10", output_token: "1" })).toMatchObject({ status: "calculated", total: "0.000009" });
});
