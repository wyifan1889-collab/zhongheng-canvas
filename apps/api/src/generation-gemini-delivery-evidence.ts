import { createHash } from "node:crypto";
import { validImageGenerationCount } from "@infinite-canvas/shared";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import type { GeminiTaskSource } from "@infinite-canvas/database/model-price-publications";
import { GEMINI_IMAGE_PROTOCOL, geminiImageDimensions } from "../../../packages/shared/src/generation-gemini-image";
import { buildGeminiImageRequest, observeGeminiImageResponse } from "./generation-image-gemini";
import { canonicalJson } from "./generation-image-quote";
import { decodeGenerationPng, type GenerationImageAsset } from "./generation-image";
import { inspectGenerationPng } from "./generation-image-integrity";
import type { GenerationProviderResult } from "./generation-worker";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const manifestDigest = (request: unknown, response: unknown, images: unknown) => sha(canonicalJson({
    domain: "gemini-image-response-v1", request, response, images,
}));
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

export function geminiRequest(task: GenerationTaskView, source: GeminiTaskSource) {
    const { aspectRatio, imageSize } = source.parameters;
    return buildGeminiImageRequest(source.binding.providerModel, task.inputSnapshot, { aspectRatio, imageSize });
}

function requestEvidence(task: GenerationTaskView, source: GeminiTaskSource) {
    const request = geminiRequest(task, source);
    if ("errorCode" in request) return null;
    return { protocol: GEMINI_IMAGE_PROTOCOL, taskId: task.id, requestId: task.requestId, publicationId: source.publicationId,
        sha256: sha(canonicalJson({ ownerId: task.ownerId, request, binding: source.binding, parameters: source.parameters,
            priceVersion: task.priceVersion, creditsPerImage: source.creditsPerImage })) };
}

export async function normalizeGeminiDelivery(payload: unknown, task: GenerationTaskView, source: GeminiTaskSource,
    maxBytes: number, providerStatus: number): Promise<GenerationProviderResult> {
    const evidence = requestEvidence(task, source), expected = geminiImageDimensions(source.parameters);
    const coveredImages = Number(BigInt(source.parameters.budgetCredits) / BigInt(source.creditsPerImage));
    const observation = await observeGeminiImageResponse(payload, maxBytes, coveredImages);
    const images = observation.images.flatMap(item => item.status === "verified" ? [{ partIndex: item.partIndex, width: item.width,
        height: item.height, sizeBytes: item.sizeBytes, sha256: sha(Buffer.from(item.base64, "base64")) }] : []);
    const response = { candidateCount: observation.candidateCount, finishReason: observation.finishReason,
        receivedImages: observation.receivedImages ?? null, modelVersion: observation.modelVersion, responseId: observation.responseId,
        usage: observation.usage, upstreamCost: "unknown" as const };
    const reason = observation.reason ?? (!evidence || !expected || images.some(item => item.width !== expected.width || item.height !== expected.height)
        ? "gemini_image_dimensions_mismatch" : null);
    if (reason) {
        return { status: "unknown", unknownReason: reason, providerStatus,
            resultSnapshot: { kind: "image", geminiReview: { request: evidence, response, observedImages: images,
                rejectedParts: observation.images.flatMap(item => item.status === "unknown" ? [item] : []) } } };
    }
    const outputs = observation.images.flatMap(item => item.status === "verified" ? [{ image: { contentType: item.contentType, base64: item.base64 } }] : []);
    return { status: "succeeded", providerStatus, resultSnapshot: { kind: "image", image: outputs[0].image,
        ...(outputs.length > 1 ? { images: outputs } : {}),
        geminiBatch: { request: evidence, response, images, sha256: manifestDigest(evidence, response, images) } } };
}

/** Repeat the decode and bind every image position to the accepted request and original response. */
export async function verifyGeminiDeliveryAssets(task: GenerationTaskView, snapshot: Record<string, unknown>,
    source: GeminiTaskSource, maxBytes: number): Promise<GenerationImageAsset[] | null> {
    const batch = record(snapshot.geminiBatch), response = record(batch?.response), request = requestEvidence(task, source);
    const count = response?.receivedImages, dimensions = geminiImageDimensions(source.parameters);
    if (snapshot.kind !== "image" || !request || !batch || !batch.request || !same(batch.request, request) ||
        !dimensions || response?.candidateCount !== 1 || response.finishReason !== "STOP" || !validImageGenerationCount(count) ||
        BigInt(count) * BigInt(source.creditsPerImage) > BigInt(source.parameters.budgetCredits) ||
        !Array.isArray(batch.images) || batch.images.length !== count || batch.sha256 !== manifestDigest(request, response, batch.images)) return null;
    const outputs = count === 1 && snapshot.images === undefined ? [{ image: snapshot.image }] : snapshot.images;
    if (!Array.isArray(outputs) || outputs.length !== count || !snapshot.image || !record(outputs[0])?.image ||
        !same(record(outputs[0])!.image, snapshot.image)) return null;
    const assets: GenerationImageAsset[] = [];
    let lastPart = -1;
    for (const [index, item] of outputs.entries()) {
        const image = record(record(item)?.image), proof = record(batch.images[index]);
        if (!image || image.contentType !== "image/png" || !proof || typeof proof.partIndex !== "number" ||
            !Number.isSafeInteger(proof.partIndex) || proof.partIndex <= lastPart) return null;
        const body = decodeGenerationPng(image.base64, maxBytes);
        const checked = body && await inspectGenerationPng(body, maxBytes);
        if (!body || !checked || checked.status !== "verified" || checked.width !== dimensions.width || checked.height !== dimensions.height ||
            !same(proof, { partIndex: proof.partIndex, ...dimensions, sizeBytes: body.byteLength, sha256: sha(body) })) return null;
        lastPart = proof.partIndex;
        assets.push({ kind: "image", contentType: "image/png", body });
    }
    return assets;
}
