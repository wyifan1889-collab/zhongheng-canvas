import { describe, expect, test } from "bun:test";
import { parseVideoParameters, parseVideoQuoteSnapshot, VIDEO_PROTOCOL, VIDEO_USAGE_POLICY } from "./generation-video";
const parameters = { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" };
describe("video public specification contract", () => {
    test("does not infer missing or unknown transport fields", () => {
        expect(parseVideoParameters(parameters)).toEqual(parameters);
        for (const value of [{ ...parameters, generateAudio: undefined }, { ...parameters, durationSeconds: 1.5 },
            { ...parameters, durationSeconds: 16 }, { ...parameters, watermark: false }, { ...parameters, mode: "first_frame" }]) expect(parseVideoParameters(value)).toBeNull();
        expect(parseVideoParameters({ mode: "first_frame", resolution: "720p", durationSeconds: 5, generateAudio: true })).not.toBeNull();
    });
    test("quote snapshot cannot invent delivered units or round a price", () => {
        const snapshot = { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY,
            publicationId: "00000000-0000-4000-8000-000000000001", priceVersion: 1, selectedBand: { parameters, creditsPerVideo: 3 },
            quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 3 };
        expect(parseVideoQuoteSnapshot(snapshot)).toEqual(snapshot);
        for (const patch of [{ reservedCredits: 4 }, { quotedVideoUnits: 5 }, { protocol: "openai-compatible" },
            { selectedBand: { parameters, creditsPerVideo: 0.5 }, reservedCredits: 0.5 }, { referenceSnapshot: {} }, { seconds: "5" }]) {
            expect(parseVideoQuoteSnapshot({ ...snapshot, ...patch })).toBeNull();
        }
    });
    test("enum fields reject coercible arrays and objects, including first-frame bypass", () => {
        for (const patch of [{ mode: ["text"] }, { mode: { toString: () => "text" } }, { resolution: ["720p"] },
            { resolution: { toString: () => "720p" } }, { aspectRatio: ["16:9"] }, { aspectRatio: { toString: () => "16:9" } }]) {
            expect(parseVideoParameters({ ...parameters, ...patch })).toBeNull();
        }
        expect(parseVideoParameters({ mode: ["first_frame"], resolution: "720p", durationSeconds: 5, generateAudio: false })).toBeNull();
        expect(parseVideoQuoteSnapshot({ schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY,
            publicationId: "00000000-0000-4000-8000-000000000001", priceVersion: 1,
            selectedBand: { parameters: { mode: ["first_frame"], resolution: "720p", durationSeconds: 5, generateAudio: false }, creditsPerVideo: 3 },
            quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 3 })).toBeNull();
    });
});
