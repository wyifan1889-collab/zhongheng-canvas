import type { Database } from "@infinite-canvas/database";
import { createMediaRepository, type MediaKind, type MediaRecord } from "@infinite-canvas/database/media";
import type { GenerationResultView } from "@infinite-canvas/database/generation-results";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import type { ObjectStorage } from "@infinite-canvas/storage";
import { computeObjectEtag, objectKey } from "@infinite-canvas/storage";
import type { GenerationDeliveryResult } from "./generation-worker";
import { resolveGenerationImage, resolveVerifiedGenerationImage, generationImageMediaId } from "./generation-image";
import { getImageSpecTaskSnapshot, validatePublishedGenerationTask, type GeminiTaskSource } from "@infinite-canvas/database/model-price-publications";
import { verifyGenerationImageSpecification } from "./generation-image-specification";
import { resolveGenerationAudio } from "./generation-audio";
import { getAudioTaskSnapshot } from "./generation-audio-policy";
import { verifyGeminiDeliveryAssets } from "./generation-gemini-delivery-evidence";
import { saveImageMediaBatch, verifyGeminiMediaBatch } from "./generation-gemini-media";

export type GenerationDeliveryAsset = {
    kind: MediaKind;
    contentType: string;
    body: Uint8Array;
};

export type GenerationDeliveryDependencies = {
    database: Database;
    storage: ObjectStorage;
    quotaBytes: number;
    maxBytes: Record<MediaKind, number>;
    /** Resolve one normalized binary asset. URLs, object keys and media ids are deliberately not accepted. */
    resolveAsset: (input: { task: GenerationTaskView; result: GenerationResultView }) => Promise<GenerationDeliveryAsset | null>;
};

/**
 * Deliver a normalized text result directly through the generation-result
 * row. Text does not need object storage or a media quota; the result query
 * already exposes the bounded text snapshot. This adapter is intentionally
 * strict so a future media/provider payload cannot be marked visible by the
 * text-only worker profile.
 */
export function createGenerationTextDelivery(): NonNullable<import("./generation-worker").GenerationWorkerDependencies["deliver"]> {
    return async ({ result }) => {
        if (result.status !== "succeeded") return { status: "failed", errorCode: "delivery_result_not_succeeded" };
        if (result.resultSnapshot.kind !== "text" || typeof result.resultSnapshot.text !== "string" ||
            result.resultSnapshot.text.length < 1 || result.resultSnapshot.text.length > 200_000) {
            return { status: "failed", errorCode: "delivery_text_result_invalid" };
        }
        return { status: "visible" };
    };
}

/** Deliver durable normalized results; image bytes never come from caller URLs or object keys. */
export function createGenerationDelivery(
    dependencies?: Omit<GenerationDeliveryDependencies, "resolveAsset">,
): NonNullable<import("./generation-worker").GenerationWorkerDependencies["deliver"]> {
    const textDelivery = createGenerationTextDelivery();
    const imageDelivery = dependencies ? createGenerationMediaDelivery({
        ...dependencies,
        async resolveAsset({ result }) {
            return resolveGenerationImage(result.resultSnapshot, dependencies.maxBytes.image);
        },
    }) : null;
    return async (input) => {
        const specification = dependencies ? await getImageSpecTaskSnapshot(dependencies.database, input.task) : { status: "legacy" as const };
        if (specification.status === "gemini" && dependencies) {
            const { task, result } = input;
            const assets = await geminiAssets(dependencies, input, specification);
            if (!assets) return unknownDelivery("gemini_delivery_evidence_invalid");
            try {
                const references = await saveImageMediaBatch(dependencies, task, result, assets, "gemini");
                return { status: "visible", media: references[0], ...(references.length > 1 ? { images: references } : {}) };
            } catch (error) {
                return unknownDelivery(error instanceof Error && error.message === "image_delivery_quota_exceeded"
                    ? "gemini_delivery_quota_exceeded" : "gemini_delivery_storage_unknown");
            }
        }
        if (specification.status !== "legacy") {
            if (!dependencies || !imageDelivery || specification.status !== "recorded") return unknownDelivery("image_spec_source_invalid");
            const checked = await verifyGenerationImageSpecification(input.task, input.result.resultSnapshot, specification, dependencies.maxBytes.image);
            if (checked.status !== "verified") return unknownDelivery(checked.reason);
            if (!await validatePublishedGenerationTask(dependencies.database, input.task, checked.binding)) return unknownDelivery("image_spec_source_invalid");
            if (checked.assets.length > 1) {
                try {
                    const images = await saveImageMediaBatch(dependencies, input.task, input.result, checked.assets, "openai");
                    return { status: "visible", media: images[0]!, images };
                } catch {
                    return unknownDelivery("delivery_image_batch_incomplete");
                }
            }
            const delivered = await imageDelivery(input);
            if (delivered.status !== "saved" && delivered.status !== "visible") return delivered;
            return await verifyImageSpecMedia(dependencies, input, false) ? delivered : unknownDelivery("delivery_media_integrity_unknown");
        }
        if (input.result.resultSnapshot.kind === "text") return textDelivery(input);
        if (input.result.resultSnapshot.kind === "image" && dependencies && imageDelivery) {
            const asset = await resolveVerifiedGenerationImage(input.result.resultSnapshot, dependencies.maxBytes.image);
            if (!asset) return unknownDelivery("provider_image_invalid_response");
            if (["saved", "visible"].includes(input.task.deliveryStatus) &&
                !await createMediaRepository(dependencies.database).get(input.task.ownerId, input.task.id)) {
                return unknownDelivery("delivery_media_integrity_unknown");
            }
            const delivered = await imageDelivery(input);
            if (delivered.status !== "saved" && delivered.status !== "visible") return delivered;
            const ref = delivered.media;
            return ref?.kind === "image" && ref.contentType === "image/png" && ref.sizeBytes === asset.body.byteLength &&
                ref.etag === await computeObjectEtag(asset.body) ? delivered : unknownDelivery("delivery_media_integrity_unknown");
        }
        if (input.result.resultSnapshot.kind === "audio" && dependencies) {
            if ((await getAudioTaskSnapshot(dependencies.database, input.task))?.status !== "recorded") return unknownDelivery("audio_source_invalid");
            const asset = await resolveGenerationAudio(input.task, input.result.resultSnapshot, dependencies.maxBytes.audio);
            if (!asset) return unknownDelivery("audio_source_invalid");
            const delivered = await createGenerationMediaDelivery({ ...dependencies, resolveAsset: async () => asset })(input);
            if (delivered.status !== "saved" && delivered.status !== "visible") return delivered;
            return await verifyAudioMedia(dependencies, input, asset) ? delivered : unknownDelivery("delivery_audio_integrity_unknown");
        }
        return { status: "failed", errorCode: "delivery_result_unsupported" };
    };
}

async function verifyAudioMedia(dependencies: Pick<GenerationDeliveryDependencies, "database" | "storage" | "maxBytes">,
    { task, result }: { task: GenerationTaskView; result: GenerationResultView }, validatedAsset?: GenerationDeliveryAsset, requireReference = false): Promise<boolean> {
    try {
        if (result.status !== "succeeded" || result.taskId !== task.id || result.ownerId !== task.ownerId ||
            (requireReference && (result.consumedUnits !== 1 || task.executionStatus !== "succeeded" || !["saved", "visible"].includes(task.deliveryStatus)))) return false;
        if ((await getAudioTaskSnapshot(dependencies.database, task))?.status !== "recorded") return false;
        const asset = validatedAsset ?? await resolveGenerationAudio(task, result.resultSnapshot, dependencies.maxBytes.audio);
        const media = await createMediaRepository(dependencies.database).get(task.ownerId, task.id);
        if (!asset || !media || media.kind !== "audio" || media.contentType !== asset.contentType || media.sizeBytes !== asset.body.byteLength) return false;
        const reference = result.resultSnapshot.media as Record<string, unknown> | undefined;
        if (requireReference && !reference || reference && (reference.mediaId !== media.id || reference.kind !== "audio" ||
            reference.contentType !== media.contentType || reference.sizeBytes !== media.sizeBytes || reference.etag !== media.etag)) return false;
        const expected = objectKey(`accounts/${Buffer.from(task.ownerId).toString("base64url")}/media/${task.id}`);
        const object = await dependencies.storage.get(expected);
        return media.objectKey === expected && !!object && object.metadata.key === expected && object.metadata.contentType === media.contentType &&
            object.metadata.sizeBytes === media.sizeBytes && object.body.byteLength === media.sizeBytes && object.metadata.etag === media.etag &&
            await computeObjectEtag(asset.body) === media.etag && await computeObjectEtag(object.body) === media.etag;
    } catch { return false; }
}

export function createGenerationAudioMediaVerifier(dependencies: Pick<GenerationDeliveryDependencies, "database" | "storage" | "maxBytes">) {
    return (input: { task: GenerationTaskView; result: GenerationResultView }) => verifyAudioMedia(dependencies, input, undefined, true);
}

type ImageSpecMediaDependencies = Pick<GenerationDeliveryDependencies, "database" | "storage" | "maxBytes">;
async function geminiAssets(dependencies: ImageSpecMediaDependencies, { task, result }: { task: GenerationTaskView; result: GenerationResultView }, source: GeminiTaskSource) {
    if (result.status !== "succeeded" || result.taskId !== task.id || result.ownerId !== task.ownerId) return null;
    return verifyGeminiDeliveryAssets(task, result.resultSnapshot, source, dependencies.maxBytes.image);
}

/** Settlement supplies its transaction so verified media rows stay locked until the ledger commits. */
export function createGeminiImageDeliveryVerifier(resources: Omit<ImageSpecMediaDependencies, "database">) {
    return async (database: Database, task: GenerationTaskView, result: GenerationResultView, source: GeminiTaskSource) => {
        const dependencies = { ...resources, database };
        const assets = await geminiAssets(dependencies, { task, result }, source);
        return assets && await verifyGeminiMediaBatch(dependencies, task, result, assets) ? assets.length : null;
    };
}

async function verifyImageSpecMedia(dependencies: ImageSpecMediaDependencies,
    input: { task: GenerationTaskView; result: GenerationResultView }, requireReference: boolean): Promise<boolean> {
    try {
        const { task, result } = input;
        if (result.status !== "succeeded" || result.taskId !== task.id || result.ownerId !== task.ownerId || result.consumedUnits !== 1) return false;
        const specification = await getImageSpecTaskSnapshot(dependencies.database, task);
        if (specification.status !== "recorded") return false;
        const checked = await verifyGenerationImageSpecification(task, result.resultSnapshot, specification, dependencies.maxBytes.image);
        if (checked.status !== "verified" || !await validatePublishedGenerationTask(dependencies.database, task, checked.binding)) return false;
        const references = result.resultSnapshot.imageMedia;
        if (checked.assets.length > 1 && requireReference && (!Array.isArray(references) || references.length !== checked.assets.length)) return false;
        if (checked.assets.length === 1 && references !== undefined) return false;
        const media = createMediaRepository(dependencies.database), ids = checked.assets.map((_, index) => generationImageMediaId(task.id, index));
        const rows = await (requireReference ? media.resolveForSave(task.ownerId, ids) : media.resolve(task.ownerId, ids));
        if (rows.length !== ids.length) return false;
        for (const [index, asset] of checked.assets.entries()) {
            const id = ids[index]!, sha256 = await computeObjectEtag(asset.body), existing = rows[index];
            if (!existing || existing.id !== id || existing.kind !== "image" || existing.contentType !== "image/png" ||
                existing.sizeBytes !== asset.body.byteLength || existing.etag !== sha256) return false;
            const expectedKey = objectKey(`accounts/${Buffer.from(task.ownerId).toString("base64url")}/media/${id}`);
            if (existing.objectKey !== expectedKey) return false;
            const reference = (index === 0 ? result.resultSnapshot.media : Array.isArray(references) ? references[index] : undefined) as Record<string, unknown> | undefined;
            if (requireReference && !reference || reference && (reference.mediaId !== existing.id || reference.kind !== existing.kind ||
                reference.contentType !== existing.contentType || reference.sizeBytes !== existing.sizeBytes || reference.etag !== existing.etag)) return false;
            if (index === 0 && Array.isArray(references) && JSON.stringify(references[0]) !== JSON.stringify(reference)) return false;
            const stored = await dependencies.storage.get(expectedKey);
            // Equal SHA-256 binds this object to the decoded PNG and its evidence.
            if (!(stored && stored.metadata.key === expectedKey && stored.metadata.contentType === existing.contentType &&
                stored.metadata.sizeBytes === existing.sizeBytes && stored.metadata.etag === existing.etag &&
                stored.body.byteLength === existing.sizeBytes && await computeObjectEtag(stored.body) === sha256)) return false;
        }
        return true;
    } catch { return false; }
}

/** Settlement supplies its transaction to hold media row locks through capture. */
export function createGenerationImageSpecMediaVerifier(resources: Omit<ImageSpecMediaDependencies, "database">) {
    return (database: Database, input: { task: GenerationTaskView; result: GenerationResultView }) =>
        verifyImageSpecMedia({ ...resources, database }, input, true);
}

const ALLOWED_CONTENT_TYPES: Record<MediaKind, ReadonlySet<string>> = {
    image: new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]),
    video: new Set(["video/mp4", "video/webm", "video/quicktime", "video/mpeg"]),
    audio: new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4", "audio/aac"]),
};

function invalidDelivery(errorCode: string): GenerationDeliveryResult {
    return { status: "failed", errorCode };
}

function unknownDelivery(unknownReason: string): GenerationDeliveryResult {
    return { status: "unknown", unknownReason };
}

/**
 * Persist one server-normalized generation asset as an account-owned media
 * object. The task id is the deterministic media id so retries cannot create
 * a second asset or consume quota twice. Provider URLs, object keys and ids
 * never cross this boundary.
 */
export function createGenerationMediaDelivery(
    dependencies: GenerationDeliveryDependencies,
): (input: { task: GenerationTaskView; result: GenerationResultView; mediaId?: string }) => Promise<GenerationDeliveryResult> {
    if (!Number.isSafeInteger(dependencies.quotaBytes) || dependencies.quotaBytes < 0) throw new Error("存储额度无效");
    for (const kind of ["image", "video", "audio"] as const) {
        const maxBytes = dependencies.maxBytes[kind];
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("媒体大小上限无效");
    }
    const media = createMediaRepository(dependencies.database);

    return async ({ task, result, mediaId = task.id }) => {
        if (result.status !== "succeeded") return invalidDelivery("delivery_result_not_succeeded");

        // A replay must be safe even when the original resolver is no longer
        // available. Verify both the database ownership and the object.
        const existing = await media.get(task.ownerId, mediaId);
        if (existing) {
            try {
                const expectedKey = objectKey(`accounts/${Buffer.from(task.ownerId).toString("base64url")}/media/${mediaId}`);
                const stored = await dependencies.storage.get(objectKey(existing.objectKey));
                if (existing.objectKey !== expectedKey || !stored || stored.metadata.key !== expectedKey ||
                    stored.metadata.sizeBytes !== existing.sizeBytes || stored.body.byteLength !== existing.sizeBytes ||
                    stored.metadata.etag !== existing.etag || stored.metadata.contentType !== existing.contentType ||
                    await computeObjectEtag(stored.body) !== existing.etag) {
                    return unknownDelivery("delivery_media_integrity_unknown");
                }
                return { status: "visible", media: {
                    mediaId: existing.id, kind: existing.kind, contentType: existing.contentType,
                    sizeBytes: existing.sizeBytes, etag: existing.etag,
                } };
            } catch {
                return unknownDelivery("delivery_media_integrity_unknown");
            }
        }

        let asset: GenerationDeliveryAsset | null;
        try {
            asset = await dependencies.resolveAsset({ task, result });
        } catch {
            return unknownDelivery("delivery_asset_resolver_exception");
        }
        if (!asset) return invalidDelivery("delivery_asset_missing");
        if (!(asset.body instanceof Uint8Array) || asset.body.byteLength <= 0) return invalidDelivery("delivery_asset_invalid");
        if (!ALLOWED_CONTENT_TYPES[asset.kind]?.has(asset.contentType)) return invalidDelivery("delivery_content_type_invalid");
        const maxBytes = dependencies.maxBytes[asset.kind];
        if (asset.body.byteLength > maxBytes) return invalidDelivery("delivery_asset_too_large");

        const key = objectKey(`accounts/${Buffer.from(task.ownerId).toString("base64url")}/media/${mediaId}`);
        let stored: Awaited<ReturnType<ObjectStorage["put"]>> | null = null;
        let mediaWriteAttempted = false;
        let quotaRefused = false;
        try {
            // A row-less object can be left behind by a crashed delivery. Do
            // not overwrite it with a new provider result; send it to review.
            if (await dependencies.storage.get(key)) return unknownDelivery("delivery_storage_key_conflict");
            stored = await dependencies.storage.put({ key, body: new Uint8Array(asset.body), contentType: asset.contentType });
            if (stored.key !== key || stored.sizeBytes !== asset.body.byteLength || stored.contentType !== asset.contentType || !stored.etag) {
                throw new Error("delivery_storage_metadata_mismatch");
            }
            let saved: MediaRecord | null = null;
            try {
                mediaWriteAttempted = true;
                saved = await dependencies.database.transaction(async tx => {
                    const repository = createMediaRepository(tx);
                    // Match deletion's media-before-quota order. Duplicate inserts
                    // roll back before charging, including at the exact quota limit.
                    const created = await repository.add(task.ownerId, {
                        id: mediaId, objectKey: stored!.key, kind: asset.kind, contentType: asset.contentType,
                        sizeBytes: stored!.sizeBytes, etag: stored!.etag,
                    });
                    if (!await repository.reserve(task.ownerId, stored!.sizeBytes, dependencies.quotaBytes)) {
                        quotaRefused = true;
                        throw new Error("delivery_quota_exceeded");
                    }
                    return created;
                });
            } catch {
                // Either this COMMIT or a competing delivery may have won. Its
                // quota committed with the row, so recovery never releases it.
                saved = await media.get(task.ownerId, mediaId);
                if (!saved && quotaRefused) {
                    try { await dependencies.storage.delete(key); }
                    catch { return unknownDelivery("delivery_quota_cleanup_unknown"); }
                    return invalidDelivery("delivery_quota_exceeded");
                }
                if (!saved || saved.objectKey !== stored.key || saved.kind !== asset.kind || saved.contentType !== asset.contentType ||
                    saved.sizeBytes !== stored.sizeBytes || saved.etag !== stored.etag) {
                    throw new Error("delivery_media_record_conflict");
                }
            }
            return { status: "visible", media: {
                mediaId: saved.id, kind: saved.kind, contentType: saved.contentType,
                sizeBytes: saved.sizeBytes, etag: saved.etag,
            } };
        } catch {
            if (stored && !mediaWriteAttempted) await dependencies.storage.delete(key).catch(() => undefined);
            return unknownDelivery("delivery_persistence_unknown");
        }
    };
}
