import type { Database } from "@infinite-canvas/database";
import { generationHistoryTitle, generationResult, generationTask, mediaObject, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, walletReservation,
    type GenerationBillingStatus, type GenerationDeliveryStatus, type GenerationExecutionStatus } from "@infinite-canvas/database/schema";
import type { SafetyTx } from "@infinite-canvas/database/account-moderation";
import { addCreditAmounts, compareCreditAmounts, normalizeCreditAmount } from "@infinite-canvas/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import { z } from "zod";
import { GenerationQueryError } from "./generation-query";

export type GenerationHistoryType = "text" | "image" | "audio" | "video";
export type GenerationHistoryStatus = "succeeded" | "failed" | "running" | "queued" | "pending";
export type GenerationHistoryInput = { ownerId: string; pageNumber: number; pageSize: number; type?: GenerationHistoryType; status?: GenerationHistoryStatus; search?: string };
export type GenerationHistoryItem = {
    taskId: string; type: GenerationHistoryType | null; displayModel: string; title?: string;
    executionStatus: GenerationExecutionStatus; deliveryStatus: GenerationDeliveryStatus; billingStatus: GenerationBillingStatus;
    credits: string | null; createdAt: string; updatedAt: string; result: { url: string; thumbnailUrl?: string } | null;
};
export type GenerationHistoryResponse = { items: GenerationHistoryItem[]; total: number; pageNumber: number; pageSize: number };

const types = new Set<unknown>(["text", "image", "audio", "video"]);
const statuses = new Set<unknown>(["succeeded", "failed", "running", "queued", "pending"]);
const mediaIdSchema = z.uuid();
// Each join below proves the acceptance-time public model identity and version.
// Catalog capability/display names and current provider configuration play no part.
const historicalType = sql<GenerationHistoryType | null>`CASE WHEN ${modelCatalog.id} IS NOT NULL
    AND ${modelPriceDraft.capabilitySnapshot} IN ('text', 'image', 'audio', 'video')
    THEN ${modelPriceDraft.capabilitySnapshot} ELSE NULL END`;
function mediaString(key: "mediaId" | "kind" | "contentType" | "etag") {
    const field = sql.raw(`'${key}'`);
    const value = sql`${generationResult.resultSnapshot}->'media'->${field}`;
    const text = sql`${generationResult.resultSnapshot}->'media'->>${field}`;
    return sql<string | null>`CASE WHEN jsonb_typeof(${value}) = 'string' AND length(${text}) BETWEEN 1 AND 200 THEN ${text} ELSE NULL END`;
}
const referenceId = mediaString("mediaId"), referenceKind = mediaString("kind"), referenceContentType = mediaString("contentType"), referenceEtag = mediaString("etag");
const resultKind = sql<string | null>`CASE WHEN jsonb_typeof(${generationResult.resultSnapshot}->'kind') = 'string'
    AND length(${generationResult.resultSnapshot}->>'kind') BETWEEN 1 AND 200 THEN ${generationResult.resultSnapshot}->>'kind' ELSE NULL END`;
const referenceSize = sql<unknown>`CASE WHEN jsonb_typeof(${generationResult.resultSnapshot}->'media'->'sizeBytes') = 'number'
    AND ${generationResult.resultSnapshot}->'media'->'sizeBytes' = to_jsonb(${mediaObject.sizeBytes})
    THEN ${generationResult.resultSnapshot}->'media'->'sizeBytes' ELSE NULL END`;
// A missing publication alone proves nothing. Only a complete original image
// delivery can identify a legacy output; a conflicting publication never falls back.
const historyType = sql<GenerationHistoryType | null>`CASE WHEN ${generationTask.pricePublicationId} IS NULL
    AND ${generationTask.executionStatus} = 'succeeded' AND ${generationTask.deliveryStatus} IN ('saved', 'visible')
    AND ${generationResult.status} = 'succeeded' AND ${resultKind} = 'image'
    AND ${referenceId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ${referenceId} = ${generationTask.id} AND ${referenceId} = ${mediaObject.id}
    AND ${referenceKind} = 'image' AND ${mediaObject.kind} = 'image'
    AND ${referenceContentType} LIKE 'image/%' AND ${referenceContentType} !~ E'[\\r\\n]'
    AND ${referenceContentType} = ${mediaObject.contentType}
    AND ${referenceSize} IS NOT NULL AND ${mediaObject.sizeBytes} BETWEEN 1 AND 9007199254740991
    AND ${referenceEtag} !~ E'[\\r\\n]' AND ${referenceEtag} = ${mediaObject.etag}
    THEN 'image' ELSE ${historicalType} END`;

function validateInput(input: GenerationHistoryInput) {
    if (typeof input.ownerId !== "string" || !input.ownerId.trim() || input.ownerId.length > 200 ||
        !Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1 || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 50 ||
        !Number.isSafeInteger((input.pageNumber - 1) * input.pageSize) ||
        (input.type !== undefined && !types.has(input.type)) || (input.status !== undefined && !statuses.has(input.status))) {
        throw new GenerationQueryError("invalid_input", "创作历史查询参数无效");
    }
}

function capturedCredits(row: { billingStatus: GenerationBillingStatus; reservationStatus: string | null;
    requested: string | null; captured: string | null; released: string | null }): string | null {
    const requested = normalizeCreditAmount(row.requested), captured = normalizeCreditAmount(row.captured), released = normalizeCreditAmount(row.released);
    if (requested === null || captured === null || released === null || compareCreditAmounts(requested, "0") <= 0 ||
        compareCreditAmounts(captured, "0") < 0 || compareCreditAmounts(released, "0") < 0) return null;
    const settled = compareCreditAmounts(addCreditAmounts(captured, released), requested);
    const consistent = row.reservationStatus === "pending" ? settled < 0
        : row.reservationStatus === "captured" ? settled === 0 && compareCreditAmounts(captured, "0") > 0
            : row.reservationStatus === "released" ? settled === 0 && captured === "0" : false;
    if (!consistent || (row.billingStatus !== "pending_review" &&
        !(row.billingStatus === "reserved" && row.reservationStatus === "pending") &&
        !(row.billingStatus === "captured" && row.reservationStatus === "captured") &&
        !(row.billingStatus === "released" && row.reservationStatus === "released"))) return null;
    return captured;
}

function bounded(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
}

export async function renameGenerationHistoryForOwner(tx: SafetyTx, ownerId: string, taskId: string, title: string) {
    const [saved] = await tx.insert(generationHistoryTitle).select(tx.select({ taskId: generationTask.id, title: sql<string>`${title}::text` })
        .from(generationTask).where(and(eq(generationTask.id, taskId), eq(generationTask.ownerId, ownerId))))
        .onConflictDoUpdate({ target: generationHistoryTitle.taskId, set: { title } })
        .returning({ taskId: generationHistoryTitle.taskId, title: generationHistoryTitle.title });
    return saved ?? null;
}

/** All reads share one snapshot; nothing here ensures a wallet or writes task state. */
export async function getGenerationHistoryForOwner(db: Database, input: GenerationHistoryInput): Promise<GenerationHistoryResponse> {
    validateInput(input);
    const predicate = and(eq(generationTask.ownerId, input.ownerId),
        input.type === undefined ? undefined : eq(historyType, input.type),
        input.status === undefined ? undefined : eq(generationTask.executionStatus, input.status),
        input.search === undefined ? undefined : sql`(strpos(lower(${generationHistoryTitle.title}), lower(${input.search})) > 0
            OR strpos(lower(${generationTask.modelId}), lower(${input.search})) > 0)`);
    return db.transaction(async (tx) => {
        const source = <T extends SelectedFields>(fields: T) => tx.select(fields).from(generationTask)
            .leftJoin(generationHistoryTitle, eq(generationHistoryTitle.taskId, generationTask.id))
            .leftJoin(modelPricePublication, eq(modelPricePublication.id, generationTask.pricePublicationId))
            .leftJoin(modelPricing, and(eq(modelPricing.id, modelPricePublication.pricingId), eq(modelPricing.version, generationTask.priceVersion)))
            .leftJoin(modelPriceDraft, and(eq(modelPriceDraft.id, modelPricePublication.draftId), eq(modelPriceDraft.modelId, modelPricing.modelId)))
            .leftJoin(modelCatalog, and(eq(modelCatalog.id, modelPricing.modelId), eq(modelCatalog.publicId, generationTask.modelId)))
            .leftJoin(generationResult, and(eq(generationResult.taskId, generationTask.id), eq(generationResult.ownerId, generationTask.ownerId)))
            .leftJoin(mediaObject, and(eq(mediaObject.ownerId, generationTask.ownerId), eq(mediaObject.id, referenceId)));
        const [count] = await source({ total: sql<string>`count(*)::text` }).where(predicate);
        const total = Number(count?.total);
        if (!Number.isSafeInteger(total) || total < 0) throw new Error("创作历史数量无法安全表示");
        const rows = await source({
            taskId: generationTask.id, type: historyType, modelId: generationTask.modelId, title: generationHistoryTitle.title,
            executionStatus: generationTask.executionStatus, deliveryStatus: generationTask.deliveryStatus, billingStatus: generationTask.billingStatus,
            createdAt: generationTask.createdAt, updatedAt: generationTask.updatedAt,
            reservationStatus: walletReservation.status, requested: walletReservation.requestedUnits,
            captured: walletReservation.capturedUnits, released: walletReservation.releasedUnits,
            resultStatus: generationResult.status, resultKind, referenceId, referenceKind, referenceContentType, referenceSize, referenceEtag,
            mediaId: mediaObject.id, mediaKind: mediaObject.kind, mediaContentType: mediaObject.contentType, mediaSize: mediaObject.sizeBytes, mediaEtag: mediaObject.etag,
        }).leftJoin(walletReservation, and(eq(walletReservation.id, generationTask.reservationId),
            eq(walletReservation.userId, generationTask.ownerId), eq(walletReservation.taskId, generationTask.id)))
            .where(predicate).orderBy(desc(generationTask.createdAt), desc(generationTask.id)).limit(input.pageSize).offset((input.pageNumber - 1) * input.pageSize);
        return { items: rows.map((row): GenerationHistoryItem => {
            let result: GenerationHistoryItem["result"] = null;
            // Existing generation delivery stores media under the deterministic task ID.
            if (row.executionStatus === "succeeded" && (row.deliveryStatus === "saved" || row.deliveryStatus === "visible") &&
                row.resultStatus === "succeeded" && row.type !== null && row.type !== "text" && row.resultKind === row.type && row.referenceKind === row.type &&
                bounded(row.referenceId) && row.referenceId === row.referenceId.toLowerCase() && mediaIdSchema.safeParse(row.referenceId).success &&
                row.referenceId === row.taskId && row.referenceId === row.mediaId && row.referenceKind === row.mediaKind &&
                bounded(row.referenceContentType) && row.referenceContentType.startsWith(`${row.type}/`) && row.referenceContentType === row.mediaContentType &&
                typeof row.referenceSize === "number" && Number.isSafeInteger(row.referenceSize) && row.referenceSize > 0 && row.referenceSize === row.mediaSize &&
                bounded(row.referenceEtag) && row.referenceEtag === row.mediaEtag) result = { url: `/api/v1/media/${encodeURIComponent(row.referenceId)}` };
            return { taskId: row.taskId, type: row.type, displayModel: row.modelId, ...(row.title === null ? {} : { title: row.title }), executionStatus: row.executionStatus,
                deliveryStatus: row.deliveryStatus, billingStatus: row.billingStatus, credits: capturedCredits(row),
                createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), result };
        }), total, pageNumber: input.pageNumber, pageSize: input.pageSize };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
