import { eq } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import { modelProvider } from "@infinite-canvas/database/schema";
import { loadProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { getVideoSpecTaskSnapshot, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { computeObjectEtag, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import { parseVideoQuoteSnapshot, type VideoBinding } from "../../../packages/shared/src/generation-video";
import type { GenerationQueueSender } from "./generation-dispatch";
import type { VideoRuntimePolicy } from "./generation-video-config";
import { createVideoProviderAdapter, type VideoProviderGateway } from "./video-provider-adapter";
import { createGenerationVideoDriver } from "./generation-video-stage";
import { createGenerationVideoMediaVerifier, resolveFetchedVideo } from "./generation-video-delivery";
import { createGenerationMediaDelivery } from "./generation-delivery";
import { createGenerationWalletSettlement } from "./generation-worker";
import { inspectGenerationVideoReference, checkVideoToolchainReadiness, type VideoToolchainIdentity } from "./generation-video-probe";
import { parseGenerationVideoRequest } from "./generation-video-request";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import type { GenerationDeliveryAsset } from "./generation-delivery";

/** Explicit composition, shared by the independent worker and the local synthetic-provider harness. */
export async function createGenerationVideoExecution(options: {
    database: Database; storage: ObjectStorage; queue: GenerationQueueSender; policy: VideoRuntimePolicy;
    authSecret: string; quotaBytes: number; maxBytes: { image: number; video: number; audio: number };
    toolchainIdentity: VideoToolchainIdentity; gateway?: VideoProviderGateway; now?: () => Date;
}) {
    if (!await checkVideoToolchainReadiness(options.policy, options.toolchainIdentity)) throw new Error("视频工具身份或受控资源边界尚未就绪");
    const db = options.database, policy = options.policy;
    const credential = async (binding: VideoBinding) => {
        const [provider] = await db.select().from(modelProvider).where(eq(modelProvider.id, binding.providerId)).limit(1);
        if (!provider?.enabled || provider.adapter !== "openai-compatible" || provider.endpoint !== binding.endpoint) return null;
        return loadProviderCredential(db, options.authSecret, binding.providerId);
    };
    const adapter = createVideoProviderAdapter({ policy, credential, gateway: options.gateway });
    const referenceResources = { storage: options.storage, verifyReference: inspectGenerationVideoReference };
    const verifyVideoDelivery = createGenerationVideoMediaVerifier({ database: db, storage: options.storage, policy, toolchainIdentity: options.toolchainIdentity });
    const settleBilling = createGenerationWalletSettlement(db, { verifyVideoDelivery, videoNow: options.now });
    const driver = createGenerationVideoDriver({ database: db, queue: options.queue, policy, provider: adapter, now: options.now, settleBilling,
        async prepare(task, stage) {
            const quote = parseVideoQuoteSnapshot(task.videoQuoteSnapshot), original = await getVideoSpecTaskSnapshot(db, task);
            const binding: VideoBinding = { protocol: stage.protocol, providerId: stage.providerId, providerModel: stage.providerModel, endpoint: stage.endpoint };
            if (!quote || original.status !== "recorded" || !await validatePublishedGenerationTask(db, task, { ...binding, adapter: "openai-compatible", capability: "video" }) ||
                !await credential(binding)) throw new Error("Video original source or permission unavailable");
            const request = parseGenerationVideoRequest({ ...task, spaceId: task.spaceId ?? undefined, projectId: task.projectId ?? undefined, nodeId: task.nodeId ?? undefined });
            if (!quote.referenceSnapshot) return { input: request.input };
            const ref = quote.referenceSnapshot, media = await createMediaRepository(db).get(task.ownerId, ref.mediaId);
            const key = objectKey(`accounts/${Buffer.from(task.ownerId).toString("base64url")}/media/${ref.mediaId}`), stored = await options.storage.get(key);
            if (!media || media.objectKey !== key || media.kind !== "image" || media.etag !== ref.etag || media.contentType !== ref.contentType || media.sizeBytes !== ref.sizeBytes ||
                !stored || stored.metadata.key !== key || stored.metadata.etag !== ref.etag || stored.metadata.contentType !== ref.contentType || stored.metadata.sizeBytes !== ref.sizeBytes ||
                stored.body.byteLength !== ref.sizeBytes || await computeObjectEtag(stored.body) !== ref.etag || !await inspectGenerationVideoReference(stored.body, ref.contentType, policy)) throw new Error("Video original reference unavailable");
            return { input: request.input, reference: { mediaId: ref.mediaId, contentType: ref.contentType, body: stored.body } };
        },
        async deliver({ task, result, stage, commitProbe }) {
            if (!stage.providerTaskId || stage.phase !== "completed") return { status: "unknown", unknownReason: "video_completion_unconfirmed" };
            const persist = async (asset: GenerationDeliveryAsset | null) => {
                // Persist a write-intent before storage I/O. If the process or a PUT
                // acknowledgement is lost, another claim may only read existing media;
                // it must never race an outstanding PUT with a replacement object.
                const marked = await db.transaction(async tx => {
                    const repo = createGenerationVideoStageRepository(tx), current = await repo.lock(task.ownerId, task.id);
                    if (!current || current.claimToken !== stage.claimToken || !current.leaseUntil || current.leaseUntil <= (options.now?.() ?? new Date())) return false;
                    await repo.update(current, { lastReason: "video_storage_io_started" }); return true;
                });
                if (!marked) return { status: "unknown" as const, unknownReason: "video_delivery_claim_expired" };
                try {
                    return await db.transaction(async tx => {
                        const repo = createGenerationVideoStageRepository(tx), current = await repo.lock(task.ownerId, task.id);
                        const valid = () => !!current && current.claimToken === stage.claimToken && !!current.leaseUntil && current.leaseUntil > (options.now?.() ?? new Date());
                        if (!valid()) throw new Error("video_delivery_claim_expired");
                        const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
                            const remaining = current!.leaseUntil!.getTime() - (options.now?.() ?? new Date()).getTime();
                            if (remaining <= 0) throw new Error("video_storage_deadline");
                            let timer: ReturnType<typeof setTimeout> | undefined;
                            try { return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
                                timer = setTimeout(() => reject(new Error("video_storage_deadline")), Math.min(remaining, 0x7fffffff));
                            })]); } finally { if (timer) clearTimeout(timer); }
                        };
                        const storage: ObjectStorage = { get: key => bounded(() => options.storage.get(key)),
                            put: input => bounded(() => options.storage.put(input)), delete: key => bounded(() => options.storage.delete(key)) };
                        const delivered = await createGenerationMediaDelivery({ database: tx, storage, quotaBytes: options.quotaBytes, maxBytes: options.maxBytes,
                            resolveAsset: async () => asset })({ task, result });
                        // Rolling back this outer transaction also rolls back media/quota
                        // writes after an expired lease. A late external object stays private
                        // and the durable write-intent blocks another PUT.
                        if (!valid()) throw new Error("video_delivery_claim_expired");
                        if (delivered.status === "saved" || delivered.status === "visible") await repo.update(current!, { lastReason: null });
                        return delivered;
                    });
                } catch { return { status: "unknown" as const, unknownReason: "video_storage_outcome_unknown" }; }
            };
            // If a previous attempt committed media but lost its acknowledgement,
            // the existing deterministic object is authoritative; never replace it.
            const existing = await createMediaRepository(db).get(task.ownerId, task.id);
            if (existing && stage.probeSnapshot) return persist(null);
            if (stage.lastReason === "video_storage_io_started") return { status: "unknown", unknownReason: "video_storage_outcome_unknown" };
            const response = await adapter.resolveAsset({ protocol: stage.protocol, providerId: stage.providerId, providerModel: stage.providerModel, endpoint: stage.endpoint }, stage.providerTaskId);
            if (response.status !== "resolved") return { status: "unknown", unknownReason: "video_content_unavailable" };
            const resolved = await resolveFetchedVideo(response.body, policy, options.toolchainIdentity);
            if (resolved.status !== "resolved" || !await commitProbe(resolved.probe)) return { status: "unknown", unknownReason: "video_probe_unconfirmed" };
            return persist(resolved.asset);
        },
    });
    return { driver, verifyVideoDelivery, referenceResources };
}
