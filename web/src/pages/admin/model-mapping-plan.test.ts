import { describe, expect, test } from "bun:test";
import { addMapping, emptyMappingDraft, mappingSourceKey, mappingSpecKey, previewMappingRoute, removeMappingSource, suggestModelMapping, validMappingPrice, validMappingSpecification, type MappingDraft, type MappingModel, type MappingSource } from "./model-mapping-plan";

const source = (providerId: string, providerModel: string): MappingSource => ({ providerId, providerName: providerId, providerModel, available: true, providerEnabled: true });
const model: MappingModel = { id: "image-2.5", displayName: "Image 2.5", capability: "image", group: "GPT" };

describe("model mapping suggestions and exact identity", () => {
    test("separator aliases suggest one family without changing the original request name", () => {
        const a = source("A", "gpt-image-2.5-4k"), b = source("B", "image-2-5-4k");
        expect(suggestModelMapping(a.providerModel)?.id).toBe("image-2.5");
        expect(suggestModelMapping(b.providerModel)?.id).toBe("image-2.5");
        const draft = addMapping(addMapping(emptyMappingDraft(), a, model, "4K"), b, model, "4K");
        expect(draft.models).toHaveLength(1);
        expect(draft.bindings.map(item => item.providerModel)).toEqual([a.providerModel, b.providerModel]);
    });
    test("different versions and named variants remain separate", () => {
        const names = ["gpt-image-2-4k", "gpt-image-2.5-4k", "gpt-image-2.6-4k", "gpt-image-2.5-flare-4k", "gpt-image-2.5-sunburst-4k"];
        expect(new Set(names.map(name => suggestModelMapping(name)?.id)).size).toBe(5);
        expect(suggestModelMapping(names[3])?.caution).toBeTruthy();
    });
    test("missing specifications and arbitrary names are not guessed", () => {
        expect(suggestModelMapping("gpt-image-2.5-flare")?.specification).toBeNull();
        expect(suggestModelMapping("image-2-5")?.specification).toBeNull();
        expect(suggestModelMapping("unknown-image-2.5-4k")).toBeNull();
        expect(suggestModelMapping("gpt-image-2-high")).toBeNull();
        expect(suggestModelMapping("grok-imagine-video-1.5")).toBeNull();
    });
    test("video family keeps fast/mini but separates their resolution", () => {
        expect(suggestModelMapping("sd2.0-fast-480p")).toMatchObject({ id: "sd2.0-fast", specification: "480P", capability: "video" });
        expect(suggestModelMapping("sd2.0-fast-720p")?.id).toBe("sd2.0-fast");
        expect(suggestModelMapping("sd2.0-mini-720p")?.id).toBe("sd2.0-mini");
    });
    test("identical raw names from different channels are distinct sources", () => {
        expect(mappingSourceKey(source("A", "image-2.5"))).not.toBe(mappingSourceKey(source("B", "image-2.5")));
        expect(mappingSourceKey(source("A:B", "C"))).not.toBe(mappingSourceKey(source("A", "B:C")));
    });
    test("display specifications reserve 2K without granting availability and keep model overrides", () => {
        const a = source("A", "image-2.5-4k"), b = source("B", "image-2-5-8k");
        const draft = addMapping(emptyMappingDraft(), a, model, "4K");
        expect(draft.modelSpecifications[model.id]).toEqual(["1K", "2K", "4K"]);
        expect(previewMappingRoute(draft, [a], model.id, "2K").status).toBe("missing");
        const next = addMapping({ ...draft, modelSpecifications: { [model.id]: ["2K", "4K"] } }, b, model, "8K");
        expect(next.specificationOptions.image).toContain("8K");
        expect(next.modelSpecifications[model.id]).toEqual(["2K", "4K"]);
        expect(next.bindings[1].providerModel).toBe("image-2-5-8k");
    });
    test("future video P/K labels remain distinct without assuming pixel or protocol conversions", () => {
        const video: MappingModel = { id: "video-demo", displayName: "Video", capability: "video", group: "" };
        const draft = addMapping(emptyMappingDraft(), source("V", "upstream-video-4k"), video, "4K");
        expect(validMappingSpecification("1080P", "video")).toBe(true);
        expect(validMappingSpecification("4K", "video")).toBe(true);
        expect(validMappingSpecification("8K", "image")).toBe(true);
        expect(validMappingSpecification("1080P", "image")).toBe(false);
        expect(validMappingSpecification("1080", "video")).toBe(false);
        expect(draft.modelSpecifications[video.id]).toEqual(["480P", "720P", "4K"]);
        expect(draft.specificationOptions.image).toEqual(["1K", "2K", "4K"]);
    });
});

describe("mapping draft protects ambiguity and channel removal", () => {
    const a = source("A", "image-2.5-4k"), b = source("B", "image-2-5-4k");
    test("same exact binding is idempotent and one source can map several specs of the same model", () => {
        const draft = addMapping(emptyMappingDraft(), a, model, "4K");
        expect(addMapping(draft, a, model, "4K")).toBe(draft);
        expect(addMapping(draft, a, model, "1K").bindings).toHaveLength(2);
        expect(() => addMapping(draft, a, { ...model, id: "different" }, "1K")).toThrow("已有映射");
        expect(draft.bindings[0].specification).toBe("4K");
    });
    test("unavailable inventory and incompatible node specifications are rejected", () => {
        expect(() => addMapping(emptyMappingDraft(), { ...a, available: false }, model, "4K")).toThrow();
        expect(() => addMapping(emptyMappingDraft(), a, model, "720P")).toThrow();
        expect(() => addMapping(emptyMappingDraft(), a, model, "auto")).toThrow();
        const draft = addMapping(emptyMappingDraft(), a, model, "4K");
        expect(() => addMapping(draft, b, { ...model, capability: "video" }, "720P")).toThrow("节点");
    });
    test("several channel bindings require a selected route", () => {
        let draft = addMapping(addMapping(emptyMappingDraft(), a, model, "4K"), b, model, "4K");
        expect(previewMappingRoute(draft, [a, b], model.id, "4K").status).toBe("choose_channel");
        draft = { ...draft, preferred: { [mappingSpecKey(model.id, "4K")]: mappingSourceKey(b) } };
        expect(previewMappingRoute(draft, [a, b], model.id, "4K")).toMatchObject({ status: "ready", source: { providerId: "B" } });
    });
    test("missing or disabled preferred source never falls back to a different channel", () => {
        const draft = { ...addMapping(addMapping(emptyMappingDraft(), a, model, "4K"), b, model, "4K"),
            preferred: { [mappingSpecKey(model.id, "4K")]: mappingSourceKey(a) } };
        expect(previewMappingRoute(draft, [b], model.id, "4K").status).toBe("missing");
        expect(previewMappingRoute(draft, [{ ...a, providerEnabled: false }, b], model.id, "4K").status).toBe("unavailable");
        expect(previewMappingRoute(draft, [{ ...a, available: false }, b], model.id, "4K").status).toBe("missing");
    });
    test("removing one channel source preserves other bindings and their model price", () => {
        const spec = mappingSpecKey(model.id, "4K");
        let draft: MappingDraft = { ...addMapping(addMapping(emptyMappingDraft(), a, model, "4K"), b, model, "4K"),
            preferred: { [spec]: mappingSourceKey(a) }, prices: { [spec]: "12" } };
        draft = removeMappingSource(draft, a);
        expect(draft.bindings).toHaveLength(1);
        expect(draft.models).toEqual([model]);
        expect(draft.prices[spec]).toBe("12");
        expect(draft.preferred[spec]).toBeNull();
        expect(previewMappingRoute(draft, [b], model.id, "4K").status).toBe("choose_channel");
        draft = removeMappingSource(draft, b);
        expect(draft.prices[spec]).toBeUndefined();
        expect(draft.models).toEqual([model]);
    });
    test("unpriced, decimal or unsafe values cannot appear as an executable price", () => {
        for (const value of ["", "0", "1.5", "1e2", "-1", "9007199254740992"]) expect(validMappingPrice(value)).toBe(false);
        expect(validMappingPrice("12")).toBe(true);
    });
});
