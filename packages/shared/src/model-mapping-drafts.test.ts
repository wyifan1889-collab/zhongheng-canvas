import { expect, test } from "bun:test";
import { emptyMappingDraft, mappingSourceKey, mappingSpecKey, parseMappingCatalog, parseMappingDraft, parseMappingDraftWrite, pruneMappingProvider } from "./model-mapping-drafts";
function fixture() {
    const draft = emptyMappingDraft();
    draft.models.push({ id: "image-2.5", displayName: "Image 2.5", capability: "image", group: "图片" });
    draft.modelSpecifications["image-2.5"] = ["1K", "2K", "4K"];
    draft.bindings.push({ providerId: "image-a", providerModel: "image-2-5-4k", modelId: "image-2.5", specification: "4K" });
    draft.prices[mappingSpecKey("image-2.5", "4K")] = "12";
    return draft;
}

test("channel cleanup retains other sources and reserved specs but never selects a replacement", () => {
    const draft = fixture(), first = draft.bindings[0], key = mappingSpecKey(first.modelId, first.specification);
    draft.bindings.push({ ...first, providerId: "image-b" }); draft.preferred[key] = mappingSourceKey(first);
    const next = pruneMappingProvider(draft, "image-a", []);
    expect(next.bindings.map(item => item.providerId)).toEqual(["image-b"]); expect(next.preferred[key]).toBeNull();
    expect(next.modelSpecifications[first.modelId]).toContain("2K"); expect(next.prices[key]).toBe("12"); expect(parseMappingDraft(next)).toEqual(next);
    const empty = pruneMappingProvider(next, "image-b", []);
    expect(empty.models).toHaveLength(0); expect(empty.prices).toEqual({}); expect(empty.modelSpecifications).toEqual({});
    expect(pruneMappingProvider(draft, "image-a", [first.providerModel])).toBe(draft);
});
test("complete draft round trips ordered names, reserved specs and explicit source preferences", () => {
    const draft = fixture(); draft.specificationOptions.image.push("8K"); draft.modelSpecifications["image-2.5"].push("8K");
    draft.preferred[mappingSpecKey("image-2.5", "4K")] = mappingSourceKey(draft.bindings[0]);
    const parsed = parseMappingDraft(draft); expect(parsed).toEqual(draft); expect(parsed).not.toBe(draft);
    expect(parseMappingDraftWrite({ expectedVersion: 0, draft, providers: [{ providerId: "image-a", revision: 1 }] })?.draft).toEqual(draft);
});
test("draft rejects duplicate identities, unknown keys and invalid model references", () => {
    for (const alter of [(d: ReturnType<typeof fixture>) => d.models.push(d.models[0]), d => d.bindings.push(d.bindings[0]), d => { d.bindings[0].modelId = "other"; }, d => { d.modelSpecifications.other = []; }]) {
        const draft = fixture(); alter(draft); expect(parseMappingDraft(draft)).toBeNull();
    }
    expect(parseMappingDraft({ ...fixture(), apiKey: "must-not-be-stored" })).toBeNull();
});
test("display labels cannot cross capability or point at absent preferred routes", () => {
    const draft = fixture(); draft.modelSpecifications["image-2.5"].push("1080P"); expect(parseMappingDraft(draft)).toBeNull();
    const other = fixture(); other.preferred[mappingSpecKey("image-2.5", "4K")] = '["different","source"]'; expect(parseMappingDraft(other)).toBeNull();
    other.preferred[mappingSpecKey("image-2.5", "4K")] = null; expect(parseMappingDraft(other)).not.toBeNull();
});

test("capability must be a literal string, never a coercible or malformed object", () => {
    for (const capability of [["image"], { toString: null }, { toString: () => "image" }, null]) {
        const draft = fixture();
        expect(parseMappingDraft({ ...draft, models: [{ ...draft.models[0], capability }] })).toBeNull();
    }
});
test("unpriced input is allowed; invalid credit numbers are not persisted", () => {
    for (const price of ["", "1", "9007199254740991"]) { const draft = fixture(); draft.prices[mappingSpecKey("image-2.5", "4K")] = price; expect(parseMappingDraft(draft)).not.toBeNull(); }
    for (const price of ["0", "-1", "1.5", "1e2", "9007199254740992"]) { const draft = fixture(); draft.prices[mappingSpecKey("image-2.5", "4K")] = price; expect(parseMappingDraft(draft)).toBeNull(); }
});
test("save requires each bound provider revision exactly once, including explicit deleted source", () => {
    const draft = fixture();
    for (const providers of [[], [{ providerId: "wrong", revision: 1 }], [{ providerId: "image-a", revision: 1 }, { providerId: "image-a", revision: 1 }]]) expect(parseMappingDraftWrite({ expectedVersion: 0, draft, providers })).toBeNull();
    expect(parseMappingDraftWrite({ expectedVersion: 3, draft, providers: [{ providerId: "image-a", revision: null }] })).not.toBeNull();
    expect(parseMappingDraftWrite({ expectedVersion: 2_147_483_647, draft, providers: [{ providerId: "image-a", revision: 1 }] })).toBeNull();
});
test("directory response validates exact fields, source uniqueness and provider ownership", () => {
    const catalog = { version: 0, draft: fixture(), providers: [{ providerId: "image-a", revision: 1 }], sources: [{ providerId: "image-a", providerName: "A", providerModel: "image-2-5-4k", available: true, providerEnabled: true }] };
    expect(parseMappingCatalog(catalog)).toEqual(catalog);
    expect(parseMappingCatalog({ ...catalog, providers: [] })).toBeNull();
    expect(parseMappingCatalog({ ...catalog, sources: [...catalog.sources, ...catalog.sources] })).toBeNull();
});
