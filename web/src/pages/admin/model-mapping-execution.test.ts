import { expect, test } from "bun:test";
import { addMapping, emptyMappingDraft, mappingBindingKey, mappingCombinationKey, mappingSourceKey, previewMappingRoute, removeMappingBindings, replaceMappingBinding, type MappingExecution, type MappingModel, type MappingSource } from "./model-mapping-plan";
const source: MappingSource = { providerId: "A", providerName: "A", providerModel: "image-2-5", available: true, providerEnabled: true };
const model: MappingModel = { id: "image-2.5", displayName: "Image 2.5", capability: "image", group: "" };
const one: MappingExecution = { protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "high" } };
const two: MappingExecution = { protocol: "openai-image-v1", parameters: { size: "1024x1536", quality: "high" } };
test("changing parameters drops the old price but preserves another combination and exact raw model", () => {
    let draft = addMapping(addMapping(emptyMappingDraft(), source, model, "1K", one), source, model, "4K", { protocol: "openai-image-v1", parameters: { size: "4096x4096", quality: "high" } });
    const first = draft.bindings[0], other = draft.bindings[1]; draft.prices[mappingCombinationKey(first)] = "4"; draft.prices[mappingCombinationKey(other)] = "12";
    expect(replaceMappingBinding(draft, source, model, "1K", one, first)).toBe(draft);
    draft = replaceMappingBinding(draft, source, model, "1K", two, first);
    expect(draft.prices).toEqual({ [mappingCombinationKey(other)]: "12" }); expect(draft.bindings.at(-1)?.providerModel).toBe("image-2-5");
    expect(() => replaceMappingBinding(draft, source, model, "1K", one, first)).toThrow("原组合已变化");
});
test("a preferred route applies to exactly one full combination; removing it cannot switch channels", () => {
    const b = { ...source, providerId: "B" };
    let draft = addMapping(addMapping(addMapping(emptyMappingDraft(), source, model, "1K", one), b, model, "1K", one), source, model, "1K", two);
    const first = draft.bindings[0], key = mappingCombinationKey(first);
    expect(previewMappingRoute(draft, [source, b], model.id, "1K", one).status).toBe("choose_channel");
    draft.preferred[key] = mappingSourceKey(source); draft.prices[key] = "6";
    expect(previewMappingRoute(draft, [source, b], model.id, "1K", two).status).toBe("ready");
    draft = removeMappingBindings(draft, binding => mappingBindingKey(binding) === mappingBindingKey(first));
    expect(draft.bindings).toHaveLength(2); expect(draft.preferred[key]).toBeNull(); expect(draft.prices[key]).toBe("6");
    expect(previewMappingRoute(draft, [source, b], model.id, "1K", one).status).toBe("choose_channel");
    expect(previewMappingRoute(draft, [source, b], model.id, "1K", two).status).toBe("ready");
});
test("editing into a duplicate cannot silently merge or discard prices", () => {
    const draft = addMapping(addMapping(emptyMappingDraft(), source, model, "1K", one), source, model, "1K", two);
    draft.prices[mappingCombinationKey(draft.bindings[0])] = "6"; draft.prices[mappingCombinationKey(draft.bindings[1])] = "9";
    expect(() => replaceMappingBinding(draft, source, model, "1K", two, draft.bindings[0])).toThrow("相同参数组合");
    expect(Object.values(draft.prices)).toEqual(["6", "9"]);
});
