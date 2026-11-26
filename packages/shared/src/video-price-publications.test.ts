import { expect, test } from "bun:test";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "./generation-video";
import { parseModelPriceRules, type ModelPriceBinding, type ModelPriceRules } from "./model-pricing-drafts";
import { parsePublishedVideoSpecPrice, samePublishedVideoSpecPrice, publishedDraftPrice, publishedVideoSpecDraftPrice, resolveVideoSpecDraftSelection, selectVideoSpecPrice, type PublishedVideoSpecPrice } from "./model-price-publications";

const binding: ModelPriceBinding = { providerId: "synthetic-video", providerModel: "administrator-selected-model", adapter: "openai-compatible", endpoint: "https://provider.example.test/v1", capability: "video" };
const parameters: VideoParameters = { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" };
const rule = (): ModelPriceRules => ({ schemaVersion: 1, video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY },
    cost: { template: "video_second", currency: "USD", bands: [{ parameters: {}, rates: { second: null } }] },
    sale: { template: "video_count", currency: "credit", bands: [{ parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])), rates: { video: "7" } }] } });

test("only an explicit immutable video policy makes a complete per-delivery draft publishable", () => {
    const rules = rule(), expected = { billingUnit: "video_specs", creditsPerUnit: null, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, videoSpecs: [{ parameters, creditsPerVideo: 7 }] };
    expect(parseModelPriceRules(rules, "video")).toEqual(rules);
    expect(publishedVideoSpecDraftPrice(binding, rules)).toEqual(expected);
    expect(publishedDraftPrice(binding, rules)).toEqual(expected);
    const { video: _policy, ...legacy } = rules;
    expect(parseModelPriceRules(legacy, "video")).not.toBeNull();
    expect(publishedDraftPrice(binding, legacy)).toBeNull();
    expect(publishedDraftPrice({ ...binding, adapter: "sub2api" }, rules)).toBeNull();
    expect(publishedDraftPrice({ ...binding, endpoint: "https://provider.example.test" }, rules)).toBeNull();
    expect(publishedDraftPrice({ ...binding, endpoint: "https://provider.example.test/api/v1" }, rules)).not.toBeNull();
    expect(expected).not.toHaveProperty("cost");
});

test("draft video policy is strict and cannot attach video authorization to another capability", () => {
    for (const video of [null, { schemaVersion: 1, protocol: "openai-compatible", usagePolicy: VIDEO_USAGE_POLICY },
        { schemaVersion: 2, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY },
        { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: "provider_seconds" },
        { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, fallback: true }]) {
        expect(parseModelPriceRules({ ...rule(), video }, "video")).toBeNull();
    }
    expect(parseModelPriceRules({ ...rule(), sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } }, "image")).toBeNull();
});

test("missing, partial, unknown and mode-inapplicable video specifications never publish", () => {
    for (const mutate of [
        (v: any) => { v.sale.bands[0].parameters = {}; },
        (v: any) => { delete v.sale.bands[0].parameters.generateAudio; },
        (v: any) => { delete v.sale.bands[0].parameters.aspectRatio; },
        (v: any) => { v.sale.bands[0].parameters.generateAudio = "0"; },
        (v: any) => { v.sale.bands[0].parameters.mode = "first_frame"; },
        (v: any) => { v.sale.bands[0].parameters.mode = "reference"; },
        (v: any) => { v.sale.bands[0].parameters.resolution = "4K"; },
        (v: any) => { v.sale.bands[0].parameters.durationSeconds = "16"; },
        (v: any) => { v.sale.bands[0].parameters.durationSeconds = "7.5"; },
        (v: any) => { v.sale.bands[0].parameters.aspectRatio = "2:1"; },
        (v: any) => { v.sale.bands[0].parameters.watermark = "false"; },
    ]) { const rules = rule(); mutate(rules); expect(publishedDraftPrice(binding, rules)).toBeNull(); }
    const firstFrame = rule(); firstFrame.sale.bands[0].parameters.mode = "first_frame"; delete firstFrame.sale.bands[0].parameters.aspectRatio;
    expect(publishedDraftPrice(binding, firstFrame)).toMatchObject({ videoSpecs: [{ parameters: { mode: "first_frame", generateAudio: false } }] });
});

test("per-second, zero, fractions and unsafe integer prices are never rounded into the task ledger", () => {
    for (const amount of ["0", "0.1", "7.5", "9007199254740992", "1e2", null, 7]) {
        const rules = rule(); (rules.sale.bands[0].rates as Record<string, unknown>).video = amount;
        expect(publishedDraftPrice(binding, rules)).toBeNull();
    }
    const seconds = rule(); seconds.sale.template = "video_second"; seconds.sale.bands[0].rates = { second: "7" };
    expect(parseModelPriceRules(seconds, "video")).not.toBeNull();
    expect(publishedDraftPrice(binding, seconds)).toBeNull();
});

test("sound and aspect ratio are exact selection fields even when all bands have the same price", () => {
    const rules = rule(); rules.sale.bands.push({ parameters: { ...rules.sale.bands[0].parameters, generateAudio: "true" }, rates: { video: "7" } },
        { parameters: { ...rules.sale.bands[0].parameters, aspectRatio: "9:16" }, rates: { video: "7" } });
    const price = publishedVideoSpecDraftPrice(binding, rules)!;
    expect(price.videoSpecs).toHaveLength(3);
    for (const spec of price.videoSpecs) expect(resolveVideoSpecDraftSelection(binding, rules, spec.parameters)).toEqual(spec);
    expect(selectVideoSpecPrice(price, { ...parameters, aspectRatio: "1:1" })).toBeNull();
    expect(selectVideoSpecPrice(price, { ...parameters, generateAudio: true, aspectRatio: "9:16" })).toBeNull();
    expect(selectVideoSpecPrice(price, { ...parameters, durationSeconds: "5" })).toBeNull();
    expect(selectVideoSpecPrice({ ...price, videoSpecs: [...price.videoSpecs, price.videoSpecs[0]] }, parameters)).toBeNull();
    expect(selectVideoSpecPrice({ ...price, videoSpecs: [...price.videoSpecs, { parameters, creditsPerVideo: 0 }] }, parameters)).toBeNull();
});

const publicVideoPrice = (): PublishedVideoSpecPrice => ({ billingUnit: "video_specs", creditsPerUnit: null, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY,
    videoSpecs: [{ parameters: { ...parameters }, creditsPerVideo: 7 }, { parameters: { ...parameters, generateAudio: true }, creditsPerVideo: 9 },
        { parameters: { mode: "first_frame", resolution: "480p", durationSeconds: 1, generateAudio: false }, creditsPerVideo: 3 }] });

test("public video price parsing needs no channel binding and projects only detached allowlisted price fields", () => {
    const original = publicVideoPrice();
    const input = { ...original, modelId: "video-model", displayName: "Synthetic published video", version: 2, enabled: true, publicPriceNote: "Synthetic only" };
    Object.defineProperty(input, "binding", { get: () => { throw new Error("Private binding must not be read"); } });
    const parsed = parsePublishedVideoSpecPrice(input)!;
    expect(parsed).toEqual(original);
    expect(Object.keys(parsed)).toEqual(["billingUnit", "creditsPerUnit", "protocol", "usagePolicy", "videoSpecs"]);
    original.videoSpecs[0].parameters.durationSeconds = 6;
    original.videoSpecs[1].creditsPerVideo = 100;
    expect(parsed.videoSpecs[0].parameters.durationSeconds).toBe(5);
    expect(parsed.videoSpecs[1].creditsPerVideo).toBe(9);
});

test("public video price parsing rejects every incomplete, duplicated, mixed-unit and unsafe band", () => {
    const changes: ((value: any) => void)[] = [
        value => { value.protocol = "openai-compatible"; }, value => { value.usagePolicy = "provider_seconds"; },
        value => { value.billingUnit = "second"; }, value => { value.creditsPerUnit = 7; }, value => { value.videoSpecs = []; },
        value => { delete value.videoSpecs[0].parameters.generateAudio; }, value => { delete value.videoSpecs[0].parameters.aspectRatio; },
        value => { value.videoSpecs[0].parameters = {}; }, value => { value.videoSpecs[0].parameters.durationSeconds = "5"; },
        value => { value.videoSpecs[0].parameters.generateAudio = "false"; }, value => { value.videoSpecs[0].parameters.watermark = false; },
        value => { value.videoSpecs[2].parameters.aspectRatio = "16:9"; }, value => { value.videoSpecs.push(structuredClone(value.videoSpecs[0])); },
        value => { value.videoSpecs.push({ ...structuredClone(value.videoSpecs[0]), creditsPerVideo: 77 }); },
        value => { value.videoSpecs[2].creditsPerVideo = 0; }, value => { value.videoSpecs[2].creditsPerVideo = 0.5; },
        value => { value.videoSpecs[2].creditsPerVideo = Number.MAX_SAFE_INTEGER + 1; }, value => { value.videoSpecs[2].creditsPerVideo = "3"; },
        value => { value.videoSpecs[0].providerTaskId = "private"; }, value => { value.imageSpecs = []; },
        value => { value.inputCreditsPerMillion = "1"; }, value => { value.cachedInputCreditsPerMillion = null; },
    ];
    for (const change of changes) { const value = publicVideoPrice(); change(value); expect(parsePublishedVideoSpecPrice(value)).toBeNull(); }
    for (const value of [null, [], "video_specs", { billingUnit: "video_specs", videoSpecs: publicVideoPrice().videoSpecs }]) expect(parsePublishedVideoSpecPrice(value)).toBeNull();
});

test("public video pricing comparison covers every band, protocol and exact price regardless of band order", () => {
    const left = publicVideoPrice(), right = publicVideoPrice(); right.videoSpecs.reverse();
    expect(samePublishedVideoSpecPrice(left, { ...right, modelId: "unrelated-metadata" })).toBe(true);
    for (const change of [
        (value: any) => { value.videoSpecs.pop(); }, (value: any) => { value.videoSpecs[1].creditsPerVideo = 10; },
        (value: any) => { value.videoSpecs[0].parameters.aspectRatio = "9:16"; }, (value: any) => { value.videoSpecs[2].parameters.resolution = "720p"; },
        (value: any) => { value.videoSpecs[2].parameters.generateAudio = true; }, (value: any) => { value.protocol = "different"; },
    ]) { const changed = publicVideoPrice(); change(changed); expect(samePublishedVideoSpecPrice(left, changed)).toBe(false); }
    const invalid = { ...left, videoSpecs: [...left.videoSpecs, left.videoSpecs[0]] };
    expect(samePublishedVideoSpecPrice(invalid, invalid)).toBe(false);
    expect(samePublishedVideoSpecPrice(null, null)).toBe(false);
});

test("public video price accessors cannot run while normalizing untrusted price fields", () => {
    let reads = 0;
    const top = publicVideoPrice(); Object.defineProperty(top, "protocol", { get: () => { reads++; return VIDEO_PROTOCOL; } });
    expect(parsePublishedVideoSpecPrice(top)).toBeNull();
    const nested = publicVideoPrice(); Object.defineProperty(nested.videoSpecs[0].parameters, "mode", { get: () => { reads++; return "text"; } });
    expect(parsePublishedVideoSpecPrice(nested)).toBeNull();
    const inherited = publicVideoPrice(); inherited.videoSpecs[0].parameters = Object.create({ get mode() { reads++; return "text"; } });
    expect(parsePublishedVideoSpecPrice(inherited)).toBeNull(); expect(reads).toBe(0);
});
