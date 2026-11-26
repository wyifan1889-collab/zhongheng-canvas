import type { Database } from "@infinite-canvas/database";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { createGenerationImageRequestRepository } from "../../../packages/database/src/generation-image-requests";
import type { ImageSpecification, ModelPriceBinding } from "@infinite-canvas/shared";
import { imageRequestCounts } from "../../../packages/shared/src/generation-image-batch";
import { parseGenerationImageRequest } from "./generation-image-request";
import { normalizeGenerationImageSpecification, verifyGenerationImageSpecification } from "./generation-image-specification";
import type { GenerationProviderGateway } from "./generation-provider";
import type { GenerationProviderResult } from "./generation-worker";
import type { ProviderTarget } from "./provider-gateway";

/** One frozen quote and task own all preplanned calls; an attempted call is never retried here. */
export async function generatePlannedImageRequests(input: {
    database: Database; task: GenerationTaskView; binding: ModelPriceBinding; target: ProviderTarget;
    specification: ImageSpecification & { publicationId: string; maxImagesPerRequest: number };
    gateway: GenerationProviderGateway; timeoutMs: number; maxBytes: number; canSend: () => Promise<boolean>;
}): Promise<GenerationProviderResult> {
    const { task, specification, binding } = input;
    const repository = createGenerationImageRequestRepository(input.database);
    const counts = imageRequestCounts(specification.parameters.n ?? 1, specification.maxImagesPerRequest);
    const rows = await repository.initialize(task, specification, binding);
    const images: Record<string, unknown>[] = [];
    const unknown = (reason: string): GenerationProviderResult => ({ status: "unknown", errorCode: reason, unknownReason: reason,
        resultSnapshot: { kind: "image", imageRequestProgress: { counts, completedImages: images.length,
            phases: rows.map(row => row.phase) } } });
    for (const [index, initial] of rows.entries()) {
        const parameters = { ...specification.parameters, n: initial.imageCount };
        const chunkTask = { ...task, parameterSnapshot: initial.parametersSnapshot };
        const source = { protocol: specification.protocol, publicationId: specification.publicationId, parameters,
            ...(specification.responseFormat === undefined ? {} : { responseFormat: specification.responseFormat }), requestIndex: initial.requestIndex };
        const transport = parseGenerationImageRequest(chunkTask.inputSnapshot, chunkTask.parameterSnapshot);
        if ("errorCode" in transport) return unknown(transport.errorCode);
        let snapshot = initial.resultSnapshot;
        if (initial.phase === "succeeded") {
            const checked = await verifyGenerationImageSpecification(chunkTask, snapshot, source, input.maxBytes);
            if (checked.status !== "verified") return unknown(checked.reason);
        } else {
            if (initial.phase !== "ready") return unknown("image_request_requires_review");
            if (!await input.canSend()) return images.length ? unknown("image_request_binding_changed") : { status: "failed", errorCode: "model_unavailable" };
            const claimed = await repository.claim(initial);
            if (!claimed) return unknown("image_request_claim_conflict");
            rows[index] = claimed;
            const path = `${/\/v1$/i.test(new URL(binding.endpoint).pathname.replace(/\/+$/, "")) ? "" : "v1/"}images/generations`;
            let result;
            try { result = await input.gateway.request({ target: input.target, path,
                body: { model: binding.providerModel, ...transport.body }, signal: AbortSignal.timeout(input.timeoutMs) }); }
            catch {
                rows[index] = await repository.complete(claimed, { phase: "unknown", reason: "provider_adapter_exception" });
                return unknown("provider_adapter_exception");
            }
            if (result.status !== "succeeded") {
                const failed = result.status === "failed" && (result.code === "provider_rejected" || result.requestSent === false);
                rows[index] = await repository.complete(claimed, { phase: failed ? "failed" : "unknown", reason: result.code });
                return failed && !images.length ? { status: "failed", errorCode: result.code } : unknown(result.code);
            }
            const normalized = await normalizeGenerationImageSpecification(result.payload, chunkTask, { ...source, binding }, input.maxBytes);
            if (normalized.status !== "verified") {
                rows[index] = await repository.complete(claimed, { phase: "unknown", reason: normalized.reason,
                    ...(normalized.resultSnapshot ? { resultSnapshot: normalized.resultSnapshot } : {}) });
                return unknown(normalized.reason);
            }
            snapshot = normalized.resultSnapshot;
            rows[index] = await repository.complete(claimed, { phase: "succeeded", resultSnapshot: snapshot });
        }
        images.push(...(Array.isArray(snapshot.images) ? snapshot.images as Record<string, unknown>[] : [snapshot]));
    }
    return { status: "succeeded", consumedUnits: 1, resultSnapshot: { ...images[0], images, imageRequestPlan: counts } };
}
