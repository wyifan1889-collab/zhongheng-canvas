import { describe, expect, test } from "bun:test";
import { normalizeMultiplierAmount, previewMultiplierPricing, type MultiplierBasis, type MultiplierPreviewInput } from "./multiplier-pricing";

const textBasis = (): MultiplierBasis => ({ model: "example-text", currency: "USD", source: "explicit test reference", version: "v1", context: "独立普通输入与缓存用量桶",
    rows: [
        { id: "input", label: "普通输入", unit: "百万 Token", amount: "2.5", quantityBase: 1000000 },
        { id: "cache", label: "缓存读取", unit: "百万 Token", amount: "0.25", quantityBase: 1000000 },
        { id: "output", label: "输出", unit: "百万 Token", amount: "10", quantityBase: 1000000 },
    ] });
const input = (): MultiplierPreviewInput => ({ basis: textBasis(), costMultiplier: "0.3", saleMultiplier: "0.6", creditsPerCurrency: "70",
    quantities: { input: "1000", cache: "2000", output: "500" } });

describe("local multiplier price preview", () => {
    test("separately prices confirmed normal input, cached input and output, then converts sale to credits", () => {
        const value = input(), original = structuredClone(value), preview = previewMultiplierPricing(value);
        expect(preview.issues).toEqual([]);
        expect(preview.valid).toBe(true);
        expect(preview.rows.map(row => [row.costRate, row.saleRate])).toEqual([["0.75", "105"], ["0.075", "10.5"], ["3", "420"]]);
        expect(preview.sample).toEqual({ baseTotal: "0.008", costTotal: "0.0024", saleTotal: "0.336" });
        expect(value).toEqual(original);
    });

    test("preserves unknown cost independently of sale rather than converting unknown to zero", () => {
        const value = input(); value.costMultiplier = "";
        const preview = previewMultiplierPricing(value);
        expect(preview.valid).toBe(true);
        expect(preview.rows.every(row => row.costRate === null && row.sampleCost === null)).toBe(true);
        expect(preview.sample).toEqual({ baseTotal: "0.008", costTotal: null, saleTotal: "0.336" });
    });

    test("requires an explicit positive sale and quote conversion without a default currency relationship", () => {
        for (const invalid of ["", "0", "-1", "1e-3", "NaN", " 1", "1.", "Infinity"]) {
            const value = input(); value.saleMultiplier = invalid;
            const preview = previewMultiplierPricing(value);
            expect(preview.valid).toBe(false);
            expect(preview.issues.some(issue => issue.field === "saleMultiplier")).toBe(true);
            expect(preview.sample.saleTotal).toBeNull();
        }
        const value = input(); value.creditsPerCurrency = "";
        const preview = previewMultiplierPricing(value);
        expect(preview.issues.some(issue => issue.field === "creditsPerCurrency")).toBe(true);
        expect(preview.rows.every(row => row.saleRate === null)).toBe(true);
        expect(preview.sample.costTotal).toBe("0.0024");
    });

    test("keeps a confirmed zero procurement multiplier distinct from a blank or invalid multiplier", () => {
        const value = input(); value.costMultiplier = "0";
        expect(previewMultiplierPricing(value).sample.costTotal).toBe("0");
        value.costMultiplier = "bad";
        const preview = previewMultiplierPricing(value);
        expect(preview.sample.costTotal).toBeNull();
        expect(preview.issues.some(issue => issue.field === "costMultiplier")).toBe(true);
    });

    test("leaves missing reference prices and sample usage unknown even when other rows have values", () => {
        const value = input(); value.basis.rows[1].amount = null; delete value.quantities.output;
        const preview = previewMultiplierPricing(value);
        expect(preview.valid).toBe(false);
        expect(preview.issues.map(issue => issue.field)).toEqual(["row:cache", "quantity:output"]);
        expect(preview.rows[0].saleRate).toBe("105");
        expect(preview.rows[1].saleRate).toBeNull();
        expect(preview.sample).toEqual({ baseTotal: null, costTotal: null, saleTotal: null });
        value.basis.rows[1].amount = "0"; value.quantities.output = "0";
        expect(previewMultiplierPricing(value).sample.baseTotal).toBe("0.0025");
    });

    test("retains video resolution and duration conditions, and computes fractional seconds exactly", () => {
        const value: MultiplierPreviewInput = { basis: { model: "example-video", currency: "CNY", source: "custom", version: "preview", rows: [
            { id: "720p", label: "720p", unit: "秒", amount: "0.000004", quantityBase: 1, parameters: { resolution: "720p", durationSeconds: "0.125" } },
            { id: "1080p", label: "1080p", unit: "条", amount: "0.8", quantityBase: 1, parameters: { resolution: "1080p", durationSeconds: "10" } },
        ] }, costMultiplier: "0.5", saleMultiplier: "1.25", creditsPerCurrency: "10", quantities: { "720p": "0.125", "1080p": "0" } };
        const preview = previewMultiplierPricing(value);
        expect(preview.sample).toEqual({ baseTotal: "0.0000005", costTotal: "0.00000025", saleTotal: "0.00000625" });
        expect(preview.rows[1].parameters).toEqual({ resolution: "1080p", durationSeconds: "10" });
        expect(preview.rows[1].saleRate).toBe("10");
    });

    test("preserves image size and quality instead of choosing a cheaper default specification", () => {
        const value = input(); value.basis = { model: "example-image", currency: "USD", source: "custom", version: "preview", rows: [
            { id: "4k", label: "4K high", unit: "张", amount: "0.06", quantityBase: 1, parameters: { size: "4K", quality: "high" } },
        ] }; value.quantities = { "4k": "2" };
        const preview = previewMultiplierPricing(value);
        expect(preview.rows[0].parameters).toEqual({ size: "4K", quality: "high" });
        expect(preview.sample).toEqual({ baseTotal: "0.12", costTotal: "0.036", saleTotal: "5.04" });
    });

    test("retains very small decimals and values beyond safe integers without rounding", () => {
        const value = input(); value.basis.rows = [{ id: "tiny", label: "tiny", unit: "次", amount: "0.000000000000000001", quantityBase: 1 }];
        value.costMultiplier = "0.1"; value.saleMultiplier = "0.2"; value.creditsPerCurrency = "0.3"; value.quantities = { tiny: "1" };
        expect(previewMultiplierPricing(value).sample).toEqual({ baseTotal: "0.000000000000000001", costTotal: "0.0000000000000000001", saleTotal: "0.00000000000000000006" });
        value.basis.rows[0].amount = "9007199254740993.1"; value.saleMultiplier = "0.1"; value.creditsPerCurrency = "10";
        expect(previewMultiplierPricing(value).rows[0].saleRate).toBe("9007199254740993.1");
        value.basis.rows[0].amount = "9".repeat(80); value.saleMultiplier = "9".repeat(80); value.creditsPerCurrency = "9".repeat(80);
        expect(previewMultiplierPricing(value).rows[0].saleRate).toBe((BigInt("9".repeat(80)) ** BigInt(3)).toString());
    });

    test("normalizes decimal strings but refuses unsupported numeric notation", () => {
        expect(normalizeMultiplierAmount("0002.5000")).toBe("2.5");
        expect(normalizeMultiplierAmount("000.000")).toBe("0");
        expect(normalizeMultiplierAmount(1)).toBeNull();
        expect(normalizeMultiplierAmount("0x10")).toBeNull();
        expect(normalizeMultiplierAmount("1,000")).toBeNull();
    });

    test("requires integer Token and explicitly counted-image usage while preserving per-second decimals", () => {
        const value = input(); value.quantities.input = "1.5";
        const token = previewMultiplierPricing(value);
        expect(token.issues).toContainEqual({ field: "quantity:input", message: "此项样例用量须为整数。" });
        expect(token.sample.saleTotal).toBeNull();
        value.basis.rows = [{ id: "image", label: "图片", unit: "张", amount: "1", quantityBase: 1, quantityKind: "integer" }];
        value.quantities = { image: "0.5" };
        expect(previewMultiplierPricing(value).issues).toContainEqual({ field: "quantity:image", message: "此项样例用量须为整数。" });
        value.basis.rows[0].quantityKind = "decimal";
        expect(previewMultiplierPricing(value).sample.baseTotal).toBe("0.5");
    });
});
