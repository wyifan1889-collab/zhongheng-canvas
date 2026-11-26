import { parseGeminiImageSpecification } from "../../../packages/shared/src/generation-gemini-image";
import { decodeGenerationPng } from "./generation-image";
import { inspectGenerationPng } from "./generation-image-integrity";
import { MAX_IMAGE_GENERATION_COUNT } from "@infinite-canvas/shared";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** Native request for a root endpoint and the existing Bearer gateway. */
export function buildGeminiImageRequest(model: unknown, input: unknown, parameters: unknown):
    { path: string; body: Record<string, unknown> } | { errorCode: string } {
    if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) || model.includes("..")) {
        return { errorCode: "invalid_generation_model" };
    }
    const value = record(input), config = record(parameters);
    if (!value || Object.keys(value).some(key => key !== "prompt") || typeof value.prompt !== "string" || !value.prompt.trim()) {
        return { errorCode: "invalid_generation_input" };
    }
    const specification = parseGeminiImageSpecification(model, config);
    if (!config || (Object.keys(config).length && !specification)) {
        return { errorCode: "invalid_generation_parameters" };
    }
    // No alias normalization, pixel-to-tier guessing, requested image count or repeated calls.
    return { path: `v1beta/models/${model}:generateContent`, body: {
        contents: [{ role: "user", parts: [{ text: value.prompt }] }],
        generationConfig: { candidateCount: 1, responseModalities: ["IMAGE"],
            ...(specification ? { imageConfig: specification } : {}) },
    } };
}

const usageKeys = ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount", "totalTokenCount"] as const;
type UsageCounts = Partial<Record<typeof usageKeys[number], number>>;
type UsageObservation = { status: "missing" } | { status: "reported" | "invalid"; counts: UsageCounts };
type ImageReason = "image_format_unsupported" | "image_spec_png_invalid" | "image_spec_pixel_budget_exceeded";
type ImageObservation = { partIndex: number } & (
    { status: "verified"; contentType: "image/png"; base64: string; width: number; height: number; sizeBytes: number } |
    { status: "unknown"; reason: ImageReason });
type ResponseReason = "response_invalid" | "response_error" | "response_blocked" | "response_incomplete" |
    "response_part_unsupported" | "response_no_image" | "gemini_image_budget_exceeded" | "gemini_image_batch_limit" | ImageReason;

/** Private interface facts only: no task snapshot, deliverable root, consumed units or billing decision. */
export type GeminiImageObservation = {
    status: "observed" | "unknown";
    reason: ResponseReason | null;
    candidateCount: number | null;
    finishReason: string | null;
    receivedImages?: number;
    images: ImageObservation[];
    texts: Array<{ partIndex: number; text: string }>;
    modelVersion: string | null;
    responseId: string | null;
    usage: UsageObservation;
};

function observeUsage(response: Record<string, unknown> | null): UsageObservation {
    if (!response || !Object.hasOwn(response, "usageMetadata")) return { status: "missing" };
    const source = record(response.usageMetadata), counts: UsageCounts = {};
    if (!source) return { status: "invalid", counts };
    let invalid = false;
    for (const key of usageKeys) {
        if (!Object.hasOwn(source, key)) continue;
        const value = source[key];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid = true;
        else counts[key] = value;
    }
    // Counts are reported facts, not a cost formula; absent counters are never filled with zero.
    return invalid ? { status: "invalid", counts } : Object.keys(counts).length ? { status: "reported", counts } : { status: "missing" };
}

export async function observeGeminiImageResponse(payload: unknown, maxBytes: number, coveredImages?: number): Promise<GeminiImageObservation> {
    const response = record(payload);
    const candidates = Array.isArray(response?.candidates) ? response.candidates : null;
    const observation: GeminiImageObservation = { status: "unknown", reason: null, candidateCount: candidates?.length ?? null,
        finishReason: null, images: [], texts: [], modelVersion: null, responseId: null, usage: observeUsage(response) };
    if (!response || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { ...observation, reason: "response_invalid" };
    let reason: ResponseReason | null = response.error != null || response.success === false ? "response_error" : null;
    for (const key of ["modelVersion", "responseId"] as const) {
        if (!Object.hasOwn(response, key)) continue;
        if (typeof response[key] !== "string" || !response[key]) reason ??= "response_invalid";
        else observation[key] = response[key];
    }
    if (Object.hasOwn(response, "promptFeedback")) {
        const feedback = record(response.promptFeedback);
        if (!feedback) reason ??= "response_invalid";
        else if (Object.hasOwn(feedback, "blockReason")) reason ??= typeof feedback.blockReason === "string" && feedback.blockReason
            ? "response_blocked" : "response_invalid";
    }
    // candidateCount=1 constrains candidates, not the number of image parts within one candidate.
    if (!candidates || candidates.length !== 1) return { ...observation, reason: reason ?? "response_invalid" };
    const candidate = record(candidates[0]), content = record(candidate?.content);
    if (!candidate || Object.hasOwn(candidate, "index") && candidate.index !== 0 || !content || content.role !== "model" || !Array.isArray(content.parts)) {
        return { ...observation, reason: reason ?? "response_invalid" };
    }
    if (candidate.error != null || candidate.success === false) reason ??= "response_error";
    if (Object.hasOwn(candidate, "safetyRatings")) {
        if (!Array.isArray(candidate.safetyRatings)) reason ??= "response_invalid";
        else for (const item of candidate.safetyRatings) {
            const rating = record(item);
            if (!rating || Object.hasOwn(rating, "blocked") && typeof rating.blocked !== "boolean") reason ??= "response_invalid";
            else if (rating.blocked === true) reason ??= "response_blocked";
        }
    }
    observation.finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : null;
    if (candidate.finishReason !== "STOP") reason ??= "response_incomplete";
    if (coveredImages !== undefined) {
        const received = content.parts.filter(part => Object.hasOwn(record(part) ?? {}, "inlineData")).length;
        observation.receivedImages = received;
        if (received > coveredImages) return { ...observation, reason: reason ?? "gemini_image_budget_exceeded" };
        if (received > MAX_IMAGE_GENERATION_COUNT) return { ...observation, reason: reason ?? "gemini_image_batch_limit" };
    }
    for (const [partIndex, value] of content.parts.entries()) {
        const part = record(value);
        if (!part || part.thought === true) { reason ??= "response_part_unsupported"; continue; }
        if (Object.keys(part).some(key => !["text", "inlineData", "thought", "thoughtSignature"].includes(key))) reason ??= "response_part_unsupported";
        if (Object.hasOwn(part, "thought") && part.thought !== false || Object.hasOwn(part, "thoughtSignature") && typeof part.thoughtSignature !== "string") reason ??= "response_invalid";
        const hasText = Object.hasOwn(part, "text"), hasImage = Object.hasOwn(part, "inlineData");
        if (hasText === hasImage) reason ??= "response_invalid";
        if (hasText) {
            if (typeof part.text !== "string") reason ??= "response_invalid";
            else if (coveredImages === undefined) observation.texts.push({ partIndex, text: part.text });
        }
        if (!hasImage) continue;
        const inline = record(part.inlineData);
        let image: ImageObservation;
        if (!inline || typeof inline.mimeType !== "string") image = { partIndex, status: "unknown", reason: "image_spec_png_invalid" };
        else if (inline.mimeType !== "image/png") image = { partIndex, status: "unknown", reason: "image_format_unsupported" };
        else {
            const bytes = decodeGenerationPng(inline.data, maxBytes);
            const inspected = bytes && await inspectGenerationPng(bytes, maxBytes);
            image = bytes && inspected?.status === "verified"
                ? { partIndex, status: "verified", contentType: "image/png", base64: inline.data as string,
                    width: inspected.width, height: inspected.height, sizeBytes: bytes.byteLength }
                : { partIndex, status: "unknown", reason: inspected?.status === "unknown" ? inspected.reason : "image_spec_png_invalid" };
        }
        observation.images.push(image);
        if (image.status === "unknown") reason ??= image.reason;
    }
    if (!observation.images.length) reason ??= "response_no_image";
    return { ...observation, status: reason ? "unknown" : "observed", reason };
}
