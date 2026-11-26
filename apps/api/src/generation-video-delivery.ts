import type { Database } from "@infinite-canvas/database";
import { createMediaRepository } from "@infinite-canvas/database/media";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import type { GenerationResultView } from "@infinite-canvas/database/generation-results";
import { getVideoSpecTaskSnapshot, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { VIDEO_PROTOCOL, parseVideoQuoteSnapshot, sameVideoParameters } from "../../../packages/shared/src/generation-video";
import type { ObjectStorage } from "@infinite-canvas/storage";
import { computeObjectEtag, objectKey } from "@infinite-canvas/storage";
import type { VideoRuntimePolicy } from "./generation-video-config";
import { probeGenerationVideo, type VideoProbeSnapshot, type VideoToolchainIdentity } from "./generation-video-probe";

/** Full, bounded, pinned-tool verification precedes the existing account media delivery. */
export async function resolveFetchedVideo(body: Uint8Array, policy: VideoRuntimePolicy, identity: VideoToolchainIdentity) {
    if (!(body instanceof Uint8Array) || !Number.isSafeInteger(policy.maxVideoBytes) || policy.maxVideoBytes <= 0 ||
        !body.byteLength || body.byteLength > policy.maxVideoBytes) return { status: "unknown" as const, reason: "video_probe_invalid" as const };
    const owned = new Uint8Array(body);
    const checked = await probeGenerationVideo(owned, policy, identity);
    return checked.status === "verified" ? { status: "resolved" as const,
        asset: { kind: "video" as const, contentType: "video/mp4", body: owned }, probe: checked.probe } : checked;
}

const probeFields: (keyof VideoProbeSnapshot)[] = ["source", "toolVersion", "ffprobeSha256", "ffmpegSha256", "contentSha256", "format", "width", "height", "durationSeconds", "frames"];
/** Read-only proof for settlement: a declared delivery status or supplier URL can never satisfy it. */
export function createGenerationVideoMediaVerifier(dependencies: { database: Database; storage: ObjectStorage; policy: VideoRuntimePolicy;
    toolchainIdentity: VideoToolchainIdentity; validateTask?: (task: GenerationTaskView) => Promise<boolean> }) {
    return async ({ task, result }: { task: GenerationTaskView; result: GenerationResultView }): Promise<boolean> => {
        try {
            const quote = parseVideoQuoteSnapshot(task.videoQuoteSnapshot);
            const policy = result.resultSnapshot.billingPolicy as Record<string, unknown> | undefined;
            if (!quote || task.executionStatus !== "succeeded" || !["saved", "visible"].includes(task.deliveryStatus) || result.status !== "succeeded" ||
                result.ownerId !== task.ownerId || result.taskId !== task.id || result.consumedUnits !== 1 || result.resultSnapshot.kind !== "video" ||
                result.resultSnapshot.protocol !== VIDEO_PROTOCOL || policy?.source !== "platform_delivered_video" || policy.unit !== "video") return false;
            const original = await getVideoSpecTaskSnapshot(dependencies.database, task);
            const stage = await createGenerationVideoStageRepository(dependencies.database).get(task.ownerId, task.id);
            if (original.status !== "recorded" || !stage || stage.phase !== "completed" || !stage.completedAt || stage.protocol !== VIDEO_PROTOCOL ||
                stage.ownerId !== task.ownerId || stage.taskId !== task.id || !stage.providerTaskId || task.providerTaskId !== stage.providerTaskId ||
                result.providerTaskId !== stage.providerTaskId || result.resultSnapshot.providerTaskId !== undefined && result.resultSnapshot.providerTaskId !== stage.providerTaskId ||
                stage.pricePublicationId !== quote.publicationId || !sameVideoParameters(stage.parametersSnapshot, quote.selectedBand.parameters) ||
                !await validatePublishedGenerationTask(dependencies.database, task, { providerId: stage.providerId, providerModel: stage.providerModel,
                    endpoint: stage.endpoint, adapter: "openai-compatible", capability: "video" }) ||
                dependencies.validateTask && !await dependencies.validateTask(task)) return false;
            const media = await createMediaRepository(dependencies.database).get(task.ownerId, task.id);
            const reference = result.resultSnapshot.media as Record<string, unknown> | undefined;
            const expectedKey = objectKey(`accounts/${Buffer.from(task.ownerId).toString("base64url")}/media/${task.id}`);
            if (!media || media.id !== task.id || media.ownerId !== task.ownerId || media.objectKey !== expectedKey || media.kind !== "video" || media.contentType !== "video/mp4" ||
                media.sizeBytes <= 0 || media.sizeBytes > dependencies.policy.maxVideoBytes || !reference || reference.mediaId !== task.id || reference.kind !== "video" ||
                reference.contentType !== media.contentType || reference.sizeBytes !== media.sizeBytes || reference.etag !== media.etag) return false;
            const stored = await dependencies.storage.get(expectedKey);
            if (!stored || stored.metadata.key !== expectedKey || stored.metadata.contentType !== "video/mp4" || stored.metadata.sizeBytes !== media.sizeBytes ||
                stored.body.byteLength !== media.sizeBytes || stored.metadata.etag !== media.etag || await computeObjectEtag(stored.body) !== media.etag) return false;
            const probe = stage.probeSnapshot as Record<string, unknown> | null;
            if (!probe || probe.contentSha256 !== media.etag) return false;
            const checked = await probeGenerationVideo(stored.body, dependencies.policy, dependencies.toolchainIdentity);
            return checked.status === "verified" && probeFields.every(field => probe[field] === checked.probe[field]);
        } catch { return false; }
    };
}
