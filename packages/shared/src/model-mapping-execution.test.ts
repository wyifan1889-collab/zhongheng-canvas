import { expect, test } from "bun:test";
import { emptyMappingDraft, mappingBindingKey, mappingCombinationKey, mappingSourceKey, parseMappingDraft, parseMappingExecution, pruneMappingProvider, type MappingBinding, type MappingExecution } from "./model-mapping-drafts";
import { compileMappingPublication } from "./model-mapping-publications";
import { imageRequestCounts, parseImageRequestPolicy } from "./generation-image-batch";

const image: MappingExecution = { protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "high" } };
const video: MappingExecution = { protocol: "yunfei-grok-video-v1", parameters: { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" } };

test("image request limits are explicit integer protocol metadata and determine complete plans", () => {
    const policy = { schemaVersion: 1, protocol: "openai-image-v1", maxImagesPerRequest: 4 };
    expect(parseImageRequestPolicy(policy)).toEqual(policy);
    expect(imageRequestCounts(10, 4)).toEqual([4, 4, 2]); expect(imageRequestCounts(10, 1)).toEqual(Array(10).fill(1));
    expect(imageRequestCounts(4, 4)).toEqual([4]); expect(imageRequestCounts(1, 10)).toEqual([1]);
    for (const maxImagesPerRequest of [0, 11, 1.5, "4", null, undefined]) {
        expect(parseMappingExecution({ ...image, maxImagesPerRequest }, "image", "1K")).toBeNull();
        expect(parseImageRequestPolicy({ ...policy, maxImagesPerRequest })).toBeNull();
    }
    expect(parseMappingExecution({ ...video, maxImagesPerRequest: 4 }, "video", "720P")).toBeNull();
    expect(parseImageRequestPolicy({ ...policy, protocol: "gemini" })).toBeNull();
});

test("every combination for a published channel model must retain the same request limit", () => {
    for (const secondLimit of [4, 5, undefined]) {
        const draft = fixture(); draft.bindings = draft.bindings.slice(0, 2).map((item, index) => ({ ...item,
            execution: { ...item.execution as Extract<MappingExecution, { protocol: "openai-image-v1" }>,
                ...(index === 0 || secondLimit !== undefined ? { maxImagesPerRequest: index === 0 ? 4 : secondLimit } : {}) } }));
        draft.preferred = {}; draft.prices = Object.fromEntries(draft.bindings.map(item => [mappingCombinationKey(item), "7"]));
        const compiled = compileMappingPublication(draft, [{ providerId: "A", providerModel: "image-2-5", providerName: "Synthetic channel", available: true, providerEnabled: true }]);
        expect(compiled.targets[0]!.rules.image?.maxImagesPerRequest).toBe(4);
        expect(compiled.issues.length).toBe(secondLimit === 4 ? 0 : 1);
    }
});
function fixture() {
    const draft = emptyMappingDraft();
    draft.models = [{ id: "image-2.5", displayName: "Image 2.5", capability: "image", group: "" }];
    draft.modelSpecifications["image-2.5"] = ["1K", "2K", "4K"];
    const first: MappingBinding = { providerId: "A", providerModel: "image-2-5", modelId: "image-2.5", specification: "1K", execution: image };
    draft.bindings = [first, { ...first, execution: { protocol: "openai-image-v1", parameters: { size: "1024x1536", quality: "high" } } }, { ...first, providerId: "B", providerModel: "image-2.5" }];
    draft.prices[mappingCombinationKey(first)] = "6"; draft.prices[mappingCombinationKey(draft.bindings[1])] = "9";
    draft.preferred[mappingCombinationKey(first)] = mappingSourceKey(first);
    return draft;
}
test("complete image combinations share one exact source and keep separate price identities", () => {
    const draft = fixture(); expect(parseMappingDraft(draft)).toEqual(draft);
    expect(new Set(draft.bindings.map(mappingBindingKey)).size).toBe(3);
    expect(new Set(draft.bindings.map(mappingCombinationKey)).size).toBe(2);
    const reordered = JSON.parse(JSON.stringify(draft)); reordered.bindings[0].execution = { parameters: { quality: "high", size: "1024x1024" }, protocol: "openai-image-v1" };
    expect(parseMappingDraft(reordered)).toEqual(draft);
});
test("duplicates and unknown/partial protocols fail instead of relying on labels or defaults", () => {
    const draft = fixture(); draft.bindings.push(draft.bindings[0]); expect(parseMappingDraft(draft)).toBeNull();
    for (const execution of [{ protocol: "openai-image-v1", parameters: {} }, { protocol: "openai-image-v1", parameters: { size: "1024x1024" } },
        { protocol: "openai-image-v1", parameters: { size: "auto", quality: "high" } }, { protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "high", n: 2 } },
        { ...image, protocol: "guessed-image-protocol" }, { ...image, apiKey: "reject" }]) expect(parseMappingExecution(execution, "image", "1K")).toBeNull();
    expect(parseMappingExecution(image, "video", "720P")).toBeNull();
});
test("video requires explicit mode, duration, sound, matching resolution and mode-specific ratio", () => {
    expect(parseMappingExecution(video, "video", "720P")).toEqual(video);
    expect(parseMappingExecution(video, "video", "4K")).toBeNull();
    expect(parseMappingExecution({ ...video, protocol: "sd2.0" }, "video", "720P")).toBeNull();
    for (const parameters of [{ ...video.parameters, durationSeconds: 16 }, { ...video.parameters, generateAudio: "false" }, { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false },
        { ...video.parameters, mode: "first_frame" }, { ...video.parameters, resolution: "2160p" }]) expect(parseMappingExecution({ ...video, parameters }, "video", "720P")).toBeNull();
    expect(parseMappingExecution({ ...video, parameters: { mode: "first_frame", resolution: "1080p", durationSeconds: 10, generateAudio: true } }, "video", "1080P")).not.toBeNull();
});
test("channel removal prunes every affected combination and never switches preferred routes", () => {
    const draft = fixture(), first = draft.bindings[0];
    const next = pruneMappingProvider(draft, "A", []);
    expect(next.bindings).toEqual([draft.bindings[2]]); expect(next.preferred[mappingCombinationKey(first)]).toBeNull();
    expect(next.prices).toEqual({ [mappingCombinationKey(first)]: "6" }); expect(next.modelSpecifications[first.modelId]).toContain("2K");
    expect(parseMappingDraft(next)).toEqual(next);
    expect(pruneMappingProvider(next, "B", []).models).toEqual([]);
});
test("pending label-only mappings remain explicitly unconfigured and cannot inherit a parameter price", () => {
    const draft = fixture(); const { execution, ...pending } = draft.bindings[0]; draft.bindings.push(pending);
    expect(parseMappingDraft(draft)).not.toBeNull(); expect(draft.prices[mappingCombinationKey(pending)]).toBeUndefined();
});
test("one exact upstream request cannot claim two different resolution labels", () => {
    const draft = fixture(); draft.bindings.push({ ...draft.bindings[0], specification: "4K" });
    expect(parseMappingDraft(draft)).toBeNull();
});
