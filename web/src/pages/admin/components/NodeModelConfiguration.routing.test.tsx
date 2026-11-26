import { expect, test } from "bun:test";
import { pricingConfigurationRoute } from "./NodeModelConfiguration";

test("image and video pricing opens the unified catalog while text and audio retain node pricing", () => {
    expect(pricingConfigurationRoute("image")).toBe("mapping");
    expect(pricingConfigurationRoute("video")).toBe("mapping");
    expect(pricingConfigurationRoute("text")).toBe("price-draft");
    expect(pricingConfigurationRoute("audio")).toBe("price-draft");
});
