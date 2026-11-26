import { expect, test } from "bun:test";
import { canonicalImageSpecTaskParameters, imageSpecParametersFromTask, imageModelMaxCount, publishedImageSpecDraftPrice, selectImageSpecPrice } from "./model-price-publications";
import { parseModelPriceRules, type ModelPriceBinding } from "./model-pricing-drafts";
import { compileMappingPublication } from "./model-mapping-publications";
import { emptyMappingDraft, mappingCombinationKey } from "./model-mapping-drafts";

const protocol = "openai-image-v1", parameters = { size: "1024x1024", quality: "high" as const };
const binding: ModelPriceBinding = { providerId: "synthetic-provider", providerModel: "synthetic-image", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability: "image" };
const rules = () => ({ schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands: [{ parameters, rates: { request: "7" } }] } });

test("image publications and canonical tasks retain an explicit execution protocol", () => {
    const price = publishedImageSpecDraftPrice(binding, rules());
    expect(price).toMatchObject({ protocol });
    const task = canonicalImageSpecTaskParameters({ ...parameters, n: 4 });
    expect(task).toEqual({ protocol, ...parameters, n: 4, output_format: "png" });
    expect(imageSpecParametersFromTask(task)).toEqual({ ...parameters, n: 4 });
    // Historical accepted tasks keep their original, strictly OpenAI transport contract.
    expect(imageSpecParametersFromTask({ ...parameters, n: 1, output_format: "png" })).toEqual(parameters);
});

test("unknown protocol metadata cannot select an otherwise matching image price or task", () => {
    const price = publishedImageSpecDraftPrice(binding, rules())!;
    for (const unsupported of ["grok", "gemini", "", null, 1]) {
        expect(selectImageSpecPrice({ ...price, protocol: unsupported } as typeof price, parameters)).toBeNull();
        expect(imageSpecParametersFromTask({ ...parameters, n: 1, output_format: "png", protocol: unsupported })).toBeNull();
        expect(parseModelPriceRules({ ...rules(), image: { schemaVersion: 1, protocol: unsupported } }, "image")).toBeNull();
    }
});

test("protocol identity is independent of an administrator's optional request count limit", () => {
    const policy = { schemaVersion: 1, protocol };
    const value = { ...rules(), image: policy };
    expect(parseModelPriceRules(value, "image")).toMatchObject({ image: policy });
    expect(publishedImageSpecDraftPrice(binding, value)).toMatchObject({ protocol });
    expect(imageModelMaxCount(binding.providerModel, policy)).toBe(1);
    expect(imageModelMaxCount(binding.providerModel, { ...policy, maxImagesPerRequest: 4 })).toBe(10);
});

test("mapping publication freezes the image protocol even without batch configuration", () => {
    const draft = emptyMappingDraft();
    draft.models = [{ id: "synthetic-model", displayName: "Synthetic", capability: "image", group: "" }];
    draft.modelSpecifications["synthetic-model"] = ["1K"];
    const item = { providerId: binding.providerId, providerModel: binding.providerModel, modelId: "synthetic-model", specification: "1K", execution: { protocol: "openai-image-v1" as const, parameters } };
    draft.bindings = [item]; draft.prices[mappingCombinationKey(item)] = "7";
    const compiled = compileMappingPublication(draft, [{ providerId: binding.providerId, providerModel: binding.providerModel, providerName: "Synthetic", available: true, providerEnabled: true }]);
    expect(compiled.issues).toEqual([]);
    expect(compiled.targets[0]?.rules.image).toEqual({ schemaVersion: 1, protocol });
});
