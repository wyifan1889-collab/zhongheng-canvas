import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { generationResult, generationTask } from "@infinite-canvas/database/schema";
import { createMediaRepository, type MediaRecord } from "@infinite-canvas/database/media";
import { createGenerationResultRepository, type GenerationMediaReference, type GenerationResultView } from "@infinite-canvas/database/generation-results";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { computeObjectEtag, objectKey, type ObjectKey } from "@infinite-canvas/storage";
import type { GenerationDeliveryDependencies } from "./generation-delivery";
import { generationImageMediaId, type GenerationImageAsset } from "./generation-image";
import { canonicalJson } from "./generation-image-quote";

type Resources = Pick<GenerationDeliveryDependencies, "database" | "storage">;
type AssetReference = { reference: GenerationMediaReference; key: ObjectKey; body: Uint8Array };

function refs(task: GenerationTaskView, assets: GenerationImageAsset[]): Promise<AssetReference[]> {
    return Promise.all(assets.map(async ({ body, kind, contentType }, index) => {
        const mediaId = generationImageMediaId(task.id, index);
        return { reference: { mediaId, kind, contentType, sizeBytes: body.byteLength, etag: await computeObjectEtag(body) },
            key: objectKey(`accounts/${Buffer.from(task.ownerId).toString("base64url")}/media/${mediaId}`), body };
    }));
}

function matchesRow(row: MediaRecord | null | undefined, task: GenerationTaskView, { reference, key }: AssetReference) {
    return !!row && row.ownerId === task.ownerId && row.id === reference.mediaId && row.kind === reference.kind &&
        row.objectKey === key && row.contentType === reference.contentType && row.sizeBytes === reference.sizeBytes && row.etag === reference.etag;
}

async function inspectObject({ storage }: Resources, { reference, key }: AssetReference) {
    const object = await storage.get(key);
    if (!object) return "missing";
    return object.metadata.key === key && object.metadata.contentType === reference.contentType && object.metadata.etag === reference.etag &&
        object.metadata.sizeBytes === reference.sizeBytes && object.body.byteLength === reference.sizeBytes &&
        await computeObjectEtag(object.body) === reference.etag ? "verified" : "conflict";
}

function withoutMedia(snapshot: GenerationResultView["resultSnapshot"]) {
    const { media: _media, imageMedia: _imageMedia, ...source } = snapshot;
    return source;
}

export async function saveImageMediaBatch(resources: Resources & { quotaBytes: number }, task: GenerationTaskView,
    result: GenerationResultView, assets: GenerationImageAsset[], mode: "gemini" | "openai") {
    const gemini = mode === "gemini";
    const items = await refs(task, assets);
    return resources.database.transaction(async tx => {
        // Serialize delivery of the same batch, including reuse of exact unindexed objects left by an interruption.
        const [parent] = await tx.select({ status: generationTask.executionStatus, delivery: generationTask.deliveryStatus }).from(generationTask)
            .where(and(eq(generationTask.id, task.id), eq(generationTask.ownerId, task.ownerId))).for("update");
        if (parent?.status !== "succeeded" || parent.delivery === "failed") throw new Error("image_delivery_task_mismatch");
        const [savedResult] = await tx.select({ status: generationResult.status, snapshot: generationResult.resultSnapshot,
            consumedUnits: generationResult.consumedUnits }).from(generationResult)
            .where(and(eq(generationResult.id, result.id), eq(generationResult.taskId, task.id), eq(generationResult.ownerId, task.ownerId))).for("update");
        if (savedResult?.status !== "succeeded" || (gemini ? !savedResult.snapshot.geminiBatch ||
            canonicalJson(savedResult.snapshot.geminiBatch) !== canonicalJson(result.resultSnapshot.geminiBatch) :
            savedResult.consumedUnits !== 1 || !isDeepStrictEqual(withoutMedia(savedResult.snapshot), withoutMedia(result.resultSnapshot)))) {
            throw new Error("image_delivery_result_conflict");
        }
        const media = createMediaRepository(tx);
        const existing = await media.resolveForSave(task.ownerId, items.map(item => item.reference.mediaId));
        const byId = new Map(existing.map(row => [row.id, row]));
        const missing = items.filter(item => !byId.has(item.reference.mediaId));
        const committed = Object.hasOwn(savedResult.snapshot, "media") || Object.hasOwn(savedResult.snapshot, "imageMedia") ||
            parent.delivery === "saved" || parent.delivery === "visible" || gemini && existing.length > 0;
        if (committed && missing.length) throw new Error("image_delivery_media_conflict");
        // The old OpenAI writer may have indexed a prefix; only the missing rows incur new quota.
        for (const { key, reference } of missing) {
            const { mediaId: id, ...metadata } = reference;
            await media.add(task.ownerId, { ...metadata, id, objectKey: key });
        }
        if (missing.length && !await media.reserve(task.ownerId, missing.reduce((sum, item) => sum + item.reference.sizeBytes, 0), resources.quotaBytes))
            throw new Error("image_delivery_quota_exceeded");
        // Object writes remain private until the rows, quota and all references commit together.
        for (const item of items) {
            const { key, body, reference } = item;
            const row = byId.get(reference.mediaId), state = await inspectObject(resources, item);
            if (state === "conflict" || row && (!matchesRow(row, task, item) || state !== "verified"))
                throw new Error("image_delivery_media_conflict");
            if (state === "missing") {
                const saved = await resources.storage.put({ key, body, contentType: reference.contentType });
                if (saved.key !== key || saved.etag !== reference.etag || saved.sizeBytes !== reference.sizeBytes ||
                    saved.contentType !== reference.contentType || await inspectObject(resources, item) !== "verified")
                    throw new Error("image_delivery_media_conflict");
            }
        }
        const references = items.map(item => item.reference);
        await createGenerationResultRepository(tx).attachMedia({ ownerId: task.ownerId, taskId: task.id, media: references[0],
            ...(references.length > 1 ? { images: references } : {}), ...(gemini ? { geminiImagesDelivered: true as const } : {}) });
        if (parent.delivery !== "visible") await tx.update(generationTask).set({ deliveryStatus: "visible", updatedAt: new Date() }).where(eq(generationTask.id, task.id));
        return references;
    });
}

export async function verifyGeminiMediaBatch(resources: Resources, task: GenerationTaskView, result: GenerationResultView, assets: GenerationImageAsset[]) {
    const items = await refs(task, assets), expected = items.map(item => item.reference);
    if (result.consumedUnits !== items.length || !result.resultSnapshot.media ||
        canonicalJson(result.resultSnapshot.media) !== canonicalJson(expected[0]) ||
        canonicalJson(result.resultSnapshot.imageMedia ?? null) !== canonicalJson(expected.length > 1 ? expected : null)) return false;
    const media = createMediaRepository(resources.database);
    const rows = new Map((await media.resolveForSave(task.ownerId, items.map(item => item.reference.mediaId))).map(row => [row.id, row]));
    for (const item of items) {
        if (!matchesRow(rows.get(item.reference.mediaId), task, item) || await inspectObject(resources, item) !== "verified") return false;
    }
    return true;
}
