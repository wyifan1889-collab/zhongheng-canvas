import { createHash } from "node:crypto";
import { OPENAI_IMAGE_PROTOCOL, canonicalImageSpecTaskParameters, imageSpecParametersFromTask, parseModelPriceBinding, sameModelPriceBinding,
    validImageGenerationCount, type ImageSpecification, type ImageGenerationParameters, type ImageSpecParameters, type ImageResponseFormat, type ModelPriceBinding } from "@infinite-canvas/shared";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { generationImageResponseData, normalizeGenerationImage, resolveGenerationImage, type GenerationImageAsset } from "./generation-image";
import { inspectGenerationPng } from "./generation-image-integrity";
import { imageRequestCounts } from "../../../packages/shared/src/generation-image-batch";

export type ImageSpecEvidenceReason = "image_spec_evidence_missing" | "image_spec_evidence_conflicting" |
    "image_spec_png_invalid" | "image_spec_pixel_budget_exceeded";
type Specification = ImageSpecification & { publicationId: string; requestIndex?: number };
type Source = Specification & { binding: ModelPriceBinding };
type ResponseFacts = { quality: string | null; size: string | null; outputFormat: string | null };
export type ImageSpecEvidence = {
    schemaVersion: 2; sourceProtocol: "openai_images_response"; taskId: string; publicationId: string;
    requestIndex: number; imageIndex: number;
    binding: ModelPriceBinding; requestBodySha256: string; response: ResponseFacts;
    image: { width: number; height: number; sizeBytes: number; sha256: string };
};
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonicalJson(value: unknown): string {
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("invalid image specification request");
    return encoded;
}
function requestDigest(task: GenerationTaskView, binding: ModelPriceBinding, parameters: ImageGenerationParameters, responseFormat?: ImageResponseFormat): string {
    const { protocol: _protocol, ...transport } = canonicalImageSpecTaskParameters(parameters, responseFormat);
    const body = { model: binding.providerModel, prompt: task.inputSnapshot.prompt, ...transport };
    return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}
function responseReason(facts: ResponseFacts, selected: ImageSpecParameters, width: number, height: number): ImageSpecEvidenceReason | null {
    if (selected.size !== undefined && selected.size !== `${width}x${height}`) return "image_spec_evidence_conflicting";
    if (facts.size !== null && facts.size !== `${width}x${height}` || facts.outputFormat !== null && facts.outputFormat !== "png") {
        return "image_spec_evidence_conflicting";
    }
    if (selected.quality !== undefined) {
        if (facts.quality === null || !["low", "medium", "high"].includes(facts.quality)) return "image_spec_evidence_missing";
        if (facts.quality !== selected.quality) return "image_spec_evidence_conflicting";
    }
    return null;
}
function responseFacts(value: Record<string, unknown>): ResponseFacts {
    // Only these same-response protocol fields count. Neither the request nor
    // data[0], usage, file size or pixels can supply missing quality evidence.
    return { quality: typeof value.quality === "string" ? value.quality : null,
        size: typeof value.size === "string" ? value.size : null,
        outputFormat: typeof value.output_format === "string" ? value.output_format : null };
}

/** Private evidence from one provider response, tied to the exact request and bytes. */
async function normalizeSingleImageSpecification(payload: unknown, task: GenerationTaskView, source: Source, maxBytes: number, imageIndex: number) {
    const raw = record(payload);
    const binding = parseModelPriceBinding(source.binding);
    const parameters = { ...source.parameters }, publicationId = source.publicationId, taskId = task.id;
    if (!raw || !binding) return { status: "unknown" as const, reason: "image_spec_evidence_missing" as const };
    if (["quality", "size", "output_format"].some(key => Object.hasOwn(raw, key) && typeof raw[key] !== "string")) {
        return { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
    }
    const response = responseFacts(raw);
    const requestBodySha256 = requestDigest(task, binding, parameters, source.responseFormat);
    const snapshot = normalizeGenerationImage(payload, maxBytes);
    const asset = snapshot && resolveGenerationImage(snapshot, maxBytes);
    if (!snapshot || !asset) return { status: "unknown" as const, reason: "image_spec_png_invalid" as const };
    const inspected = await inspectGenerationPng(asset.body, maxBytes);
    if (inspected.status !== "verified") return { status: "unknown" as const, reason: inspected.reason };
    const evidence: ImageSpecEvidence = { schemaVersion: 2, sourceProtocol: "openai_images_response", taskId,
        requestIndex: source.requestIndex ?? 0, imageIndex,
        publicationId, binding, requestBodySha256,
        response, image: { width: inspected.width, height: inspected.height, sizeBytes: asset.body.byteLength, sha256: digest(asset.body) } };
    const resultSnapshot = { ...snapshot, imageSpecEvidence: evidence };
    const reason = responseReason(response, parameters, inspected.width, inspected.height);
    return reason ? { status: "unknown" as const, reason, resultSnapshot }
        : { status: "verified" as const, resultSnapshot };
}

/** Recompute evidence on persisted bytes; a stored boolean is never a proof. */
async function verifySingleImageSpecification(task: GenerationTaskView, snapshot: unknown,
    specification: Specification, maxBytes: number, imageIndex: number): Promise<
        { status: "verified"; asset: GenerationImageAsset; binding: ModelPriceBinding; sha256: string } |
        { status: "unknown"; reason: ImageSpecEvidenceReason }> {
    const value = record(snapshot), evidence = record(value?.imageSpecEvidence), response = record(evidence?.response), image = record(evidence?.image);
    const binding = evidence && parseModelPriceBinding(evidence.binding);
    const selected = imageSpecParametersFromTask(task.parameterSnapshot);
    if (!evidence || evidence.schemaVersion !== 2 || evidence.sourceProtocol !== "openai_images_response" ||
        !binding || binding.adapter !== "openai-compatible" || binding.capability !== "image" || !response || !image || !selected ||
        !["quality", "size", "outputFormat"].every(key => response[key] === null || typeof response[key] === "string")) {
        return { status: "unknown", reason: "image_spec_evidence_missing" };
    }
    if (evidence.taskId !== task.id || evidence.publicationId !== specification.publicationId ||
        evidence.requestIndex !== (specification.requestIndex ?? 0) || evidence.imageIndex !== imageIndex ||
        selected.size !== specification.parameters.size || selected.quality !== specification.parameters.quality || (selected.n ?? 1) !== (specification.parameters.n ?? 1) ||
        task.parameterSnapshot.response_format !== specification.responseFormat ||
        evidence.requestBodySha256 !== requestDigest(task, binding, selected, specification.responseFormat)) return { status: "unknown", reason: "image_spec_evidence_conflicting" };
    const fixedResponse = { quality: response.quality, size: response.size, outputFormat: response.outputFormat } as ResponseFacts;
    const fixedImage = { width: image.width, height: image.height, sizeBytes: image.sizeBytes, sha256: image.sha256 };
    const asset = resolveGenerationImage(value, maxBytes);
    if (!asset) return { status: "unknown", reason: "image_spec_png_invalid" };
    const inspected = await inspectGenerationPng(asset.body, maxBytes);
    if (inspected.status !== "verified") return inspected;
    const sha256 = digest(asset.body);
    if (fixedImage.width !== inspected.width || fixedImage.height !== inspected.height || fixedImage.sizeBytes !== asset.body.byteLength || fixedImage.sha256 !== sha256) {
        return { status: "unknown", reason: "image_spec_evidence_conflicting" };
    }
    const reason = responseReason(fixedResponse, selected, inspected.width, inspected.height);
    return reason ? { status: "unknown", reason } : { status: "verified", asset, binding, sha256 };
}

export async function normalizeGenerationImageSpecification(payload: unknown, task: GenerationTaskView, source: Source, maxBytes: number) {
    const raw = record(payload), data = generationImageResponseData(payload), count = source.parameters.n ?? 1;
    if (source.protocol !== OPENAI_IMAGE_PROTOCOL || !raw || !data || !validImageGenerationCount(count) ||
        task.parameterSnapshot.response_format !== source.responseFormat) return { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
    if (count === 1 && data.length === 1) return normalizeSingleImageSpecification(payload, task, source, maxBytes, 0);
    const images: Record<string, unknown>[] = [];
    const items: Array<{ index: number; status: "verified" | "unknown"; reason?: ImageSpecEvidenceReason; resultSnapshot?: Record<string, unknown> }> = [];
    let reason: ImageSpecEvidenceReason | null = data.length === count ? null : "image_spec_evidence_conflicting";
    // Inspect every requested position, including positions after a broken image.
    // Unexpected extras do not expand the task's approved decode budget.
    for (const [index, item] of data.slice(0, count).entries()) {
        const normalized = await normalizeSingleImageSpecification({ ...raw, data: [item] }, task, source, maxBytes, index);
        items.push({ index, status: normalized.status, ...(normalized.status === "unknown" ? { reason: normalized.reason } : {}),
            ...(normalized.resultSnapshot ? { resultSnapshot: normalized.resultSnapshot } : {}) });
        if (normalized.status === "verified") images.push(normalized.resultSnapshot);
        else reason ??= normalized.reason;
    }
    if (reason) {
        // Review evidence has no deliverable root image and is never projected publicly.
        return { status: "unknown" as const, reason, resultSnapshot: { kind: "image", imageResponseReview: {
            schemaVersion: 1, expectedImages: count, receivedImages: data.length, inspectedImages: items.length, items,
        } } };
    }
    return { status: "verified" as const, resultSnapshot: { ...images[0], images } };
}

export async function verifyGenerationImageSpecification(task: GenerationTaskView, snapshot: unknown,
    specification: Specification & { maxImagesPerRequest?: number }, maxBytes: number) {
    const value = record(snapshot), count = specification.parameters.n ?? 1;
    if (specification.protocol !== OPENAI_IMAGE_PROTOCOL || task.parameterSnapshot.response_format !== specification.responseFormat)
        return { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
    const counts = imageRequestCounts(count, specification.maxImagesPerRequest ?? count);
    if (counts.length > 1 ? JSON.stringify(value?.imageRequestPlan) !== JSON.stringify(counts) : value?.imageRequestPlan !== undefined)
        return { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
    const positions = counts.flatMap((amount, requestIndex) => Array.from({ length: amount }, (_, imageIndex) => ({ amount,
        requestIndex: counts.length > 1 ? requestIndex : specification.requestIndex ?? 0, imageIndex })));
    const member = ({ amount, requestIndex }: typeof positions[number]) => counts.length > 1 ? {
        task: { ...task, parameterSnapshot: canonicalImageSpecTaskParameters({ ...specification.parameters, n: amount }, specification.responseFormat) },
        specification: { ...specification, parameters: { ...specification.parameters, n: amount }, requestIndex },
    } : { task, specification };
    const firstMember = member(positions[0]);
    const first = await verifySingleImageSpecification(firstMember.task, snapshot, firstMember.specification, maxBytes, 0);
    if (first.status !== "verified") return first;
    if (count === 1) return value?.images === undefined ? { ...first, assets: [first.asset] }
        : { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
    if (!Array.isArray(value?.images) || value.images.length !== count) return { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
    const assets: GenerationImageAsset[] = [];
    for (const [index, image] of value.images.entries()) {
        const expected = member(positions[index]);
        const checked = await verifySingleImageSpecification(expected.task, image, expected.specification, maxBytes, positions[index].imageIndex);
        if (checked.status !== "verified") return checked;
        if (!sameModelPriceBinding(checked.binding, first.binding)) return { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
        if (!assets.length && checked.sha256 !== first.sha256) return { status: "unknown" as const, reason: "image_spec_evidence_conflicting" as const };
        assets.push(checked.asset);
    }
    return { ...first, assets };
}
