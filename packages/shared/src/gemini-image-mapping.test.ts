import { expect, test } from "bun:test";
import { emptyMappingDraft, mappingCombinationKey, parseMappingDraft } from "./model-mapping-drafts";
import { mappingExecutionKey, parseMappingExecution } from "./model-mapping-execution";
import { compileMappingPublication } from "./model-mapping-publications";
import { GEMINI_IMAGE_PROTOCOL as protocol } from "./generation-gemini-image";
import { publishedDraftPrice } from "./model-price-publications";

const source = { providerId: "native", providerName: "Synthetic", providerModel: "gemini-3.1-flash-image-preview", available: true, providerEnabled: true };
function draft() {
    const value = emptyMappingDraft(); value.specificationOptions.image.push("512");
    value.models.push({ id: "gemini", displayName: "Gemini", capability: "image", group: "Google" }); value.modelSpecifications.gemini = ["512", "1K"];
    value.bindings = ["1:1", "8:1"].map(aspectRatio => ({ providerId: source.providerId, providerModel: source.providerModel, modelId: "gemini", specification: "512",
        execution: { protocol, parameters: { aspectRatio: aspectRatio as "1:1" | "8:1", imageSize: "512" } } }));
    for (const binding of value.bindings) value.prices[mappingCombinationKey(binding)] = "7";
    return value;
}
test("native mapping roundtrips JSONB order, exact tiers and per-delivered-image publication", () => {
    const value = draft(), compiled = compileMappingPublication(value, [source]); expect(compiled.issues).toEqual([]);
    expect(parseMappingDraft(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(mappingExecutionKey({ protocol, parameters: { imageSize: "512", aspectRatio: "8:1" } })).toBe(mappingExecutionKey(value.bindings[1].execution!));
    const rules = compiled.targets[0].rules;
    expect(rules.sale).toMatchObject({ template: "image_count", bands: [{ rates: { image: "7" } }, { rates: { image: "7" } }] });
    expect(rules.image).toBeUndefined();
    expect(publishedDraftPrice({ providerId: source.providerId, providerModel: source.providerModel, endpoint: "https://synthetic.example.test/", adapter: "openai-compatible", capability: "image" }, rules))
        .toMatchObject({ protocol, usagePolicy: "delivered_images", imageSpecs: [{ creditsPerImage: 7 }, { creditsPerImage: 7 }] });
});
test("native mappings reject count, response format, budget, wrong tier and video fields", () => {
    const execution = draft().bindings[0].execution!;
    for (const value of [{ ...execution, maxImagesPerRequest: 4 }, { ...execution, responseFormat: "b64_json" },
        { ...execution, parameters: { ...execution.parameters, n: 4 } }, { ...execution, parameters: { ...execution.parameters, budgetCredits: 17 } },
        { protocol, parameters: { resolution: "512", aspectRatio: "1:1" } }]) expect(parseMappingExecution(value, "image", "512")).toBeNull();
    expect(parseMappingExecution(execution, "image", "1K")).toBeNull(); expect(parseMappingExecution(execution, "video", "512")).toBeNull();
});
test("only exact preview models may publish native specifications; mixed protocols on one source fail", () => {
    for (const providerModel of ["gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview-1k", "grok-imagine-image"]) {
        const value = draft(); value.bindings.forEach(binding => binding.providerModel = providerModel);
        expect(compileMappingPublication(value, [{ ...source, providerModel }]).issues.length).toBeGreaterThan(0);
    }
    const value = draft(); value.bindings.push({ ...value.bindings[0], specification: "1K", execution: { protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "high" } } });
    value.prices[mappingCombinationKey(value.bindings[2])] = "7";
    expect(compileMappingPublication(value, [source]).issues[0].message).toContain("协议须一致");
});
