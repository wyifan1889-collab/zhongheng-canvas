import { expect, test } from "bun:test";
import { canonicalImageSpecTaskParameters, imageSpecParametersFromTask, parseImageGenerationParameters, parseImagePricePolicy } from "./generation-image-protocol";
import { emptyMappingDraft, mappingCombinationKey, parseMappingExecution } from "./model-mapping-drafts";
import { compileMappingPublication } from "./model-mapping-publications";

const protocol = "openai-image-v1" as const, parameters = { size: "1024x1024", quality: "high" as const };

test("IMG-03 response format is an explicit strict policy and never a user price dimension", () => {
    const policy = { schemaVersion: 1, protocol, responseFormat: "b64_json" };
    expect(parseImagePricePolicy(policy)).toEqual(policy);
    expect(parseMappingExecution({ protocol, parameters, responseFormat: "b64_json" }, "image", "1K")).toEqual({ protocol, parameters, responseFormat: "b64_json" });
    for (const responseFormat of ["url", "png", "", null, undefined, 1, {}]) {
        expect(parseImagePricePolicy({ ...policy, responseFormat })).toBeNull();
        expect(parseMappingExecution({ protocol, parameters, responseFormat }, "image", "1K")).toBeNull();
    }
    expect(parseMappingExecution({ protocol: "yunfei-grok-video-v1", parameters: {}, responseFormat: "b64_json" }, "video", "720P")).toBeNull();
    expect(parseImageGenerationParameters({ ...parameters, response_format: "b64_json" })).toBeNull();
});

test("IMG-03 canonical new tasks freeze Base64 only when configured and old tasks retain absence", () => {
    const old = { protocol, ...parameters, n: 1, output_format: "png" };
    expect(canonicalImageSpecTaskParameters(parameters)).toEqual(old);
    const inline = canonicalImageSpecTaskParameters(parameters, "b64_json");
    expect(inline).toEqual({ ...old, response_format: "b64_json" });
    expect(imageSpecParametersFromTask(inline)).toEqual(parameters);
    expect(imageSpecParametersFromTask(old)).toEqual(parameters);
    for (const response_format of ["url", "png", "", null, undefined, 1]) {
        expect(imageSpecParametersFromTask({ ...old, response_format })).toBeNull();
    }
});

test("IMG-03 mapping publication binds one return format per exact channel model", () => {
    for (const second of ["b64_json", undefined] as const) {
        const draft = emptyMappingDraft();
        draft.models = [{ id: "image", displayName: "Synthetic image", capability: "image", group: "" }];
        draft.modelSpecifications.image = ["1K"];
        draft.bindings = [parameters, { ...parameters, size: "1024x1536" }].map((parameters, index) => ({
            providerId: "synthetic", providerModel: "grok-imagine-image-2.0", modelId: "image", specification: "1K",
            execution: { protocol, parameters, maxImagesPerRequest: 1, ...(index === 0 || second ? { responseFormat: "b64_json" as const } : {}) },
        }));
        for (const item of draft.bindings) draft.prices[mappingCombinationKey(item)] = "7";
        const compiled = compileMappingPublication(draft, [{ providerId: "synthetic", providerModel: "grok-imagine-image-2.0", providerName: "Synthetic", available: true, providerEnabled: true }]);
        expect(compiled.targets[0]?.rules.image).toEqual({ schemaVersion: 1, protocol, maxImagesPerRequest: 1, responseFormat: "b64_json" });
        expect(compiled.issues).toHaveLength(second ? 0 : 1);
        expect(compiled.targets[0]?.rules.sale.bands[0]?.parameters).toEqual(parameters);
    }
});
