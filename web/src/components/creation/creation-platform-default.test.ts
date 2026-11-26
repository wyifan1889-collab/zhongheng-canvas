import { expect, test } from "bun:test";
import type { GenerationModel } from "@/services/saas/generation";
import { firstPlatformDefault, initialPlatformImageParameters, platformImageReferencePrice } from "./creation-platform-default";

const model: GenerationModel = { id: "published-image", displayName: "已发布图片", capability: "image", group: null,
    imagePricing: { priceVersion: 4, billingUnit: "image_specs", creditsPerUnit: null, protocol: "openai-image-v1", imageSpecs: [
        { parameters: { size: "1536x1024", quality: "high" }, creditsPerRequest: 9 },
        { parameters: { size: "1024x1024", quality: "low" }, creditsPerRequest: 2 },
        { parameters: { quality: "medium" }, creditsPerRequest: 5 },
    ] } };
const ready = { fresh: true, current: true, ready: true, loading: false, unchanged: true, busy: false, pending: false, error: false };

test("new drafts follow catalog order and initialize the actual first specification, not the lowest price", () => {
    const first = firstPlatformDefault([model, { ...model, id: "later" }], ready)!;
    const parameters = initialPlatformImageParameters(first);
    expect(parameters).toEqual({ model: model.id, imageModel: model.id, size: "1536x1024", quality: "high" });
    expect(platformImageReferencePrice([model], parameters)).toBe(9);
    expect(firstPlatformDefault([], ready)).toBeUndefined();
    expect(initialPlatformImageParameters({ ...model, imagePricing: undefined })).toEqual({ model: model.id, imageModel: model.id });
});

test("restored, edited, late, busy and pending states cannot obtain an automatic model candidate", () => {
    for (const blocked of [{ fresh: false }, { current: false }, { ready: false }, { loading: true }, { unchanged: false }, { busy: true }, { pending: true }, { error: true }]) {
        expect(firstPlatformDefault([model], { ...ready, ...blocked })).toBeUndefined();
    }
    expect(firstPlatformDefault([model], { ...ready, loading: true })).toBeUndefined();
    // A reply arriving after a local edit or scope change does not regain eligibility.
    expect(firstPlatformDefault([model], { ...ready, unchanged: false, current: false })).toBeUndefined();
});

test("catalog reference prices match every published field exactly without mutating restored parameters", () => {
    const restored = Object.freeze({ imageModel: model.id, size: "1024x1024", quality: "low", count: "4", background: "transparent" });
    expect(platformImageReferencePrice([model], restored)).toBe(2);
    expect(restored).toEqual({ imageModel: model.id, size: "1024x1024", quality: "low", count: "4", background: "transparent" });
    expect(platformImageReferencePrice([model], { imageModel: model.id, quality: "medium" })).toBe(5);
    for (const parameters of [{ imageModel: model.id }, { imageModel: model.id, size: "1024x1024" }, { imageModel: model.id, size: "1536x1024", quality: "low" },
        { imageModel: model.id, size: "1024x1024", quality: "medium" }, { imageModel: "unpublished", quality: "medium" }]) {
        expect(platformImageReferencePrice([model], parameters)).toBeUndefined();
    }
    expect(platformImageReferencePrice([{ ...model, imagePricing: undefined }], restored)).toBeUndefined();
});
