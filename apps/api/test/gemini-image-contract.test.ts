import { beforeAll, expect, test } from "bun:test";
import sharp from "sharp";
import { parseImagePricePolicy, parseMappingExecution } from "@infinite-canvas/shared";
import { buildGeminiImageRequest, observeGeminiImageResponse } from "../src/generation-image-gemini";
import { parseGenerationImageRequest } from "../src/generation-image-request";
import { createProviderGateway, type ProviderTarget } from "../src/provider-gateway";

const model = "gemini-3.1-flash-image-preview";
const input = { prompt: "Synthetic image contract" };
const parameters = { aspectRatio: "3:2", imageSize: "1K" };
let png: Buffer;
beforeAll(async () => {
    png = await sharp({ create: { width: 6, height: 4, channels: 4, background: { r: 30, g: 120, b: 60, alpha: 1 } } }).png().toBuffer();
});
const image = (data = png.toString("base64"), mimeType = "image/png") => ({ inlineData: { mimeType, data } });
const response = (parts: unknown[] = [image()], finishReason: unknown = "STOP") => ({
    candidates: [{ index: 0, content: { role: "model", parts }, finishReason }],
});

test("IMG-04 builds only the documented native fields and requests inline IMAGE output", () => {
    const before = JSON.stringify({ input, parameters });
    expect(buildGeminiImageRequest(model, input, parameters)).toEqual({
        path: `v1beta/models/${model}:generateContent`, body: {
            contents: [{ role: "user", parts: [{ text: input.prompt }] }],
            generationConfig: { candidateCount: 1, responseModalities: ["IMAGE"], imageConfig: parameters },
        },
    });
    expect(JSON.stringify({ input, parameters })).toBe(before);
    expect(buildGeminiImageRequest(model, input, { aspectRatio: "8:1", imageSize: "512" })).toHaveProperty("body");
});

test("IMG-04 keeps exact catalog names and never guesses specifications for suffix variants", () => {
    for (const name of ["gemini-3-pro-image", "gemini-3-pro-image-default", "gemini-3-pro-image-preview",
        "gemini-3-pro-image-preview-default", "gemini-3.1-flash-image", "gemini-3.1-flash-image-default", model,
        `${model}-default`, "gemini-nano-banana-2.1", "gemini-nano-banana-2.1-default"]) {
        const request = buildGeminiImageRequest(name, input, {});
        expect(request).toEqual({ path: `v1beta/models/${name}:generateContent`, body: {
            contents: [{ role: "user", parts: [{ text: input.prompt }] }],
            generationConfig: { candidateCount: 1, responseModalities: ["IMAGE"] },
        } });
    }
});

test("IMG-04 only sends documented complete native combinations for the exact model", () => {
    const pro = "gemini-3-pro-image-preview";
    expect(buildGeminiImageRequest(pro, input, { aspectRatio: "21:9", imageSize: "4K" })).toHaveProperty("body");
    for (const [name, specification] of [[pro, { aspectRatio: "1:1", imageSize: "512" }], [pro, { aspectRatio: "8:1", imageSize: "1K" }],
        [`${model}-default`, parameters], ["gemini-3.1-flash-image", parameters], [model, { imageSize: "1K" }],
        [model, { ...parameters, quality: "high" }]] as const) {
        expect(buildGeminiImageRequest(name, input, specification)).toEqual({ errorCode: "invalid_generation_parameters" });
    }
});

test("IMG-04 refuses path injection, unsupported inputs and OpenAI or quantity parameters", () => {
    for (const name of [null, 4, "", " model", "models/model", "model:generateContent", "model?key=x", "../model", "a%2fb", "a..b"]) {
        expect(buildGeminiImageRequest(name, input, {})).toEqual({ errorCode: "invalid_generation_model" });
    }
    for (const value of [null, [], {}, { prompt: " " }, { prompt: 1 }, { ...input, references: [] }, { ...input, systemPrompt: "system" }]) {
        expect(buildGeminiImageRequest(model, value, {})).toEqual({ errorCode: "invalid_generation_input" });
    }
    for (const value of [null, [], { n: 1 }, { size: "1024x1024" }, { quality: "high" }, { output_format: "png" },
        { response_format: "b64_json" }, { candidateCount: 1 }, { responseModalities: ["TEXT"] }, { imageSize: "1k" },
        { imageSize: "auto" }, { imageSize: null }, { imageSize: undefined }, { aspectRatio: "7:5" }, { aspectRatio: "auto" }]) {
        expect(buildGeminiImageRequest(model, input, value)).toEqual({ errorCode: "invalid_generation_parameters" });
    }
});

test("IMG-04 composes with the real Bearer gateway once and forwards the existing signal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const target: ProviderTarget = { providerId: "synthetic-gemini", adapter: "openai-compatible", endpoint: "https://provider.example/",
        credential: "synthetic-server-key", providerModel: model };
    const gateway = createProviderGateway(async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(response([image(), image()]));
    }, async () => ["93.184.216.34"]);
    const request = buildGeminiImageRequest(model, input, parameters);
    if ("errorCode" in request) throw new Error("Synthetic request missing");
    const signal = new AbortController().signal;
    const result = await gateway.request({ target, ...request, signal });
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://provider.example/v1beta/models/${model}:generateContent`);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-server-key");
    expect(headers.get("x-goog-api-key")).toBeNull();
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBe(signal);
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual(request.body);
    if (result.status !== "succeeded") throw new Error("Synthetic response missing");
    const observed = await observeGeminiImageResponse(result.payload, png.length);
    expect(observed.status).toBe("observed");
    expect(observed.candidateCount).toBe(1);
    expect(observed.images).toHaveLength(2);
    expect(calls).toHaveLength(1);
});

test("IMG-04 observes mixed text and every PNG part in order without using candidate count as image count", async () => {
    const observed = await observeGeminiImageResponse({ ...response([
        { text: "Synthetic description" }, image(), { text: "https://media.example/same-image.png" }, image(),
    ]), responseId: "synthetic-response", modelVersion: "synthetic-reported-version" }, png.length);
    expect(observed.status).toBe("observed");
    expect(observed.reason).toBeNull();
    expect(observed.finishReason).toBe("STOP");
    expect(observed.candidateCount).toBe(1);
    expect(observed.images).toEqual([1, 3].map(partIndex => ({ partIndex, status: "verified", contentType: "image/png",
        base64: png.toString("base64"), width: 6, height: 4, sizeBytes: png.length })));
    expect(observed.texts).toEqual([{ partIndex: 0, text: "Synthetic description" }, { partIndex: 2, text: "https://media.example/same-image.png" }]);
    expect(observed.modelVersion).toBe("synthetic-reported-version");
    expect(observed.responseId).toBe("synthetic-response");
    expect(observed).not.toHaveProperty("kind");
    expect(observed).not.toHaveProperty("consumedUnits");
});

test("IMG-04 refuses malformed candidates, multiple candidates and a non-model role", async () => {
    for (const payload of [null, [], {}, { candidates: [] }, { candidates: [null] },
        { candidates: [...response().candidates, ...response().candidates] },
        { candidates: [{ ...response().candidates[0], index: 1 }] },
        { candidates: [{ ...response().candidates[0], content: { role: "user", parts: [image()] } }] },
        { candidates: [{ ...response().candidates[0], content: { role: "model", parts: null } }] },
        { ...response(), modelVersion: 123 }, { ...response(), responseId: null }]) {
        expect((await observeGeminiImageResponse(payload, png.length)).status).toBe("unknown");
    }
});

test("IMG-04 never promotes valid image fragments past an error or block", async () => {
    const cases = [
        { payload: { ...response(), error: { message: "synthetic-private-error" } }, reason: "response_error" },
        { payload: { ...response(), success: false }, reason: "response_error" },
        { payload: { ...response(), promptFeedback: { blockReason: "SAFETY" } }, reason: "response_blocked" },
        { payload: { candidates: [{ ...response().candidates[0], safetyRatings: [{ blocked: true }] }] }, reason: "response_blocked" },
        { payload: { candidates: [{ ...response().candidates[0], error: { message: "synthetic-private-error" } }] }, reason: "response_error" },
    ];
    for (const { payload, reason } of cases) {
        const observed = await observeGeminiImageResponse(payload, png.length);
        expect(observed.status).toBe("unknown");
        expect(observed.reason).toBe(reason);
        expect(observed.images[0]?.status).toBe("verified");
        expect(JSON.stringify(observed)).not.toContain("synthetic-private-error");
    }
    expect((await observeGeminiImageResponse({ promptFeedback: { blockReason: "SAFETY" } }, png.length)).reason).toBe("response_blocked");
});

test("IMG-04 requires STOP even if valid image bytes arrived", async () => {
    for (const finishReason of [undefined, null, 1, "stop", "MAX_TOKENS", "SAFETY", "OTHER", ""]) {
        const payload = response();
        payload.candidates[0]!.finishReason = finishReason;
        const observed = await observeGeminiImageResponse(payload, png.length);
        expect(observed.status).toBe("unknown");
        expect(observed.reason).toBe("response_incomplete");
        expect(observed.images[0]?.status).toBe("verified");
    }
    const payload = response();
    delete (payload.candidates[0] as Record<string, unknown>).finishReason;
    expect((await observeGeminiImageResponse(payload, png.length)).reason).toBe("response_incomplete");
});

test("IMG-04 keeps URL-only and empty outputs unfulfilled and performs no download", async () => {
    for (const parts of [[], [{ text: "No image" }], [{ text: "https://media.example/image.png" }]]) {
        const observed = await observeGeminiImageResponse(response(parts), png.length);
        expect(observed.status).toBe("unknown");
        expect(observed.reason).toBe("response_no_image");
        expect(observed.images).toHaveLength(0);
    }
    expect((await observeGeminiImageResponse(response([{ fileData: { fileUri: "https://media.example/image.png" } }]), png.length)).status).toBe("unknown");
});

test("IMG-04 rejects malformed Base64 and fully decodes PNG rather than trusting its header", async () => {
    const corrupt = Buffer.from(png);
    corrupt[corrupt.length - 1] ^= 1;
    for (const data of ["", "!!!!", `${png.toString("base64")}\n`, `data:image/png;base64,${png.toString("base64")}`,
        png.subarray(0, 8).toString("base64"), png.subarray(0, -1).toString("base64"), corrupt.toString("base64"),
        Buffer.from([255, 216, 255, 217]).toString("base64")]) {
        const observed = await observeGeminiImageResponse(response([image(data)]), png.length);
        expect(observed.status).toBe("unknown");
        expect(observed.images).toEqual([{ partIndex: 0, status: "unknown", reason: "image_spec_png_invalid" }]);
    }
});

test("IMG-04 never relabels JPEG or WebP as PNG and requires the declared MIME", async () => {
    for (const mime of ["image/jpeg", "image/webp", "application/octet-stream", "image/PNG"]) {
        const observed = await observeGeminiImageResponse(response([image(png.toString("base64"), mime)]), png.length);
        expect(observed.status).toBe("unknown");
        expect(observed.reason).toBe("image_format_unsupported");
        expect(observed.images).toEqual([{ partIndex: 0, status: "unknown", reason: "image_format_unsupported" }]);
    }
    for (const inlineData of [null, [], {}, { data: png.toString("base64") }, { mimeType: "image/png", data: 7 }]) {
        expect((await observeGeminiImageResponse(response([{ inlineData }]), png.length)).status).toBe("unknown");
    }
});

test("IMG-04 retains valid parts around a corrupt part for private review without accepting partial success", async () => {
    const observed = await observeGeminiImageResponse(response([image(), image("broken"), { text: "Synthetic explanation" }, image()]), png.length);
    expect(observed.status).toBe("unknown");
    expect(observed.reason).toBe("image_spec_png_invalid");
    expect(observed.images.map(item => [item.partIndex, item.status])).toEqual([[0, "verified"], [1, "unknown"], [3, "verified"]]);
    expect(observed.texts).toEqual([{ partIndex: 2, text: "Synthetic explanation" }]);
});

test("IMG-04 uses the caller's existing byte budget without truncating or transcoding", async () => {
    const observed = await observeGeminiImageResponse(response(), png.length - 1);
    expect(observed.status).toBe("unknown");
    expect(observed.reason).toBe("image_spec_png_invalid");
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect((await observeGeminiImageResponse(response(), maxBytes)).reason).toBe("response_invalid");
    }
});

test("IMG-04 keeps unsupported thought or ambiguous parts out of accepted output", async () => {
    for (const part of [null, { inline_data: image().inlineData }, { text: "x", inlineData: image().inlineData },
        { functionCall: { name: "tool" } }, { text: 7 }, { ...image(), functionCall: { name: "tool" } },
        { ...image(), thought: "false" }, { ...image(), thoughtSignature: 123 }]) {
        expect((await observeGeminiImageResponse(response([part, image()]), png.length)).status).toBe("unknown");
    }
    const thought = await observeGeminiImageResponse(response([{ text: "synthetic-private-thought", thought: true }, image()]), png.length);
    expect(thought.status).toBe("unknown");
    expect(JSON.stringify(thought)).not.toContain("synthetic-private-thought");
    const signed = await observeGeminiImageResponse(response([{ ...image(), thought: false, thoughtSignature: "synthetic-signature" }]), png.length);
    expect(signed.status).toBe("observed");
    expect(JSON.stringify(signed)).not.toContain("synthetic-signature");
});

test("IMG-04 preserves only reported token counts and makes no charge or missing-zero inference", async () => {
    expect((await observeGeminiImageResponse(response(), png.length)).usage).toEqual({ status: "missing" });
    const usageMetadata = { promptTokenCount: 0, candidatesTokenCount: 21, thoughtsTokenCount: 3, totalTokenCount: 24,
        syntheticUnknownField: "not forwarded" };
    const observed = await observeGeminiImageResponse({ ...response(), usageMetadata }, png.length);
    expect(observed.usage).toEqual({ status: "reported", counts: { promptTokenCount: 0, candidatesTokenCount: 21,
        thoughtsTokenCount: 3, totalTokenCount: 24 } });
    expect(observed.usage).not.toHaveProperty("counts.toolUsePromptTokenCount");
    for (const value of [null, [], { totalTokenCount: "24" }, { promptTokenCount: -1 }, { thoughtsTokenCount: 0.5 },
        { candidatesTokenCount: Number.MAX_SAFE_INTEGER + 1 }]) {
        const invalid = await observeGeminiImageResponse({ ...response(), usageMetadata: value }, png.length);
        expect(invalid.usage.status).toBe("invalid");
        expect(invalid.status).toBe("observed");
        expect(invalid).not.toHaveProperty("consumedUnits");
    }
    expect((await observeGeminiImageResponse({ ...response(), usageMetadata: {} }, png.length)).usage).toEqual({ status: "missing" });
});

test("IMG-04 does not expose the isolated contract as a chargeable image protocol", () => {
    for (const protocol of ["gemini", "gemini-generate-content-v1"]) {
        expect(parseMappingExecution({ protocol, parameters: { size: "1024x1024" } }, "image", "1K")).toBeNull();
        expect(parseImagePricePolicy({ schemaVersion: 1, protocol })).toBeNull();
        expect(parseGenerationImageRequest(input, { protocol, n: 1 })).toEqual({ errorCode: "invalid_generation_parameters" });
    }
});
