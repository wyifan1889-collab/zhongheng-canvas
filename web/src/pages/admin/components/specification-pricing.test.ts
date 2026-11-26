import { describe, expect, test } from "bun:test";
import type { ModelPriceRules } from "@/services/saas/platform";
import { pairSpecificationCosts, replaceSpecificationUnit, specificationSample } from "./specification-pricing";

const video = (): ModelPriceRules => ({ schemaVersion: 1,
    sale: { template: "video_second", currency: "credit", bands: [
        { parameters: { resolution: "1080p", durationSeconds: "10" }, rates: { second: "0.8" } },
        { parameters: { resolution: "720p", durationSeconds: "5" }, rates: { second: "0.4" } },
    ] }, cost: { template: "video_count", currency: "CNY", bands: [
        { parameters: { durationSeconds: "5", resolution: "720p" }, rates: { video: "0.3" } },
        { parameters: { durationSeconds: "10", resolution: "1080p" }, rates: { video: null } },
    ] },
});
describe("specification price configuration", () => {
    test("pairs reversed cost bands by parameters while preserving different units and unknown costs", () => {
        const rules = video(), original = structuredClone(rules), paired = pairSpecificationCosts(rules)!;
        expect(paired?.template).toBe("video_count");
        expect(paired?.bands[0].rates.video).toBeNull();
        expect(paired?.bands[1].rates.video).toBe("0.3");
        expect(rules).toEqual(original);
        expect(specificationSample(rules.sale, 0)).toMatchObject({ status: "calculated", total: "8", currency: "credit" });
        expect(specificationSample(paired, 1)).toMatchObject({ status: "calculated", total: "0.3", currency: "CNY" });
    });
    test("keeps independent cost conditions in advanced editor rather than silently dropping them", () => {
        const rules = video(); rules.cost!.bands = [{ parameters: {}, rates: { video: "0.5" } }];
        expect(pairSpecificationCosts(rules)).toBeUndefined();
        rules.cost = null; expect(pairSpecificationCosts(rules)).toBeNull();
        rules.sale.template = "image_tokens"; expect(pairSpecificationCosts(rules)).toBeUndefined();
    });
    test("changing to whole-video pricing retains specs and requires new amounts, never converts them", () => {
        const rules = video(), replaced = replaceSpecificationUnit(rules.sale, "video_count");
        expect(replaced.bands.map(row => row.parameters)).toEqual(rules.sale.bands.map(row => row.parameters));
        expect(replaced.bands.map(row => row.rates)).toEqual([{ video: "" }, { video: "" }]);
        expect(specificationSample(replaced, 0)?.status).toBe("invalid_sample");
        replaced.bands[0].rates.video = "3"; replaced.bands[1].rates.video = "2";
        expect(specificationSample(replaced, 0)).toMatchObject({ status: "calculated", total: "3" });
        expect(rules.sale.bands[0].rates.second).toBe("0.8");
    });
    test("missing duration never yields a guessed per-second charge; tiny decimals stay exact", () => {
        const rules = video(); delete rules.sale.bands[0].parameters.durationSeconds;
        expect(specificationSample(rules.sale, 0)).toMatchObject({ status: "missing_usage", fields: ["second"] });
        rules.sale.bands[0].parameters.durationSeconds = "0.125"; rules.sale.bands[0].rates.second = "0.000004";
        expect(specificationSample(rules.sale, 0)).toMatchObject({ status: "calculated", total: "0.0000005" });
    });
});
