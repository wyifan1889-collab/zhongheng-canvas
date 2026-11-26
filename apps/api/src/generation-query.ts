import type { Database } from "@infinite-canvas/database";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { generationTask } from "@infinite-canvas/database/schema";
import { createGenerationResultRepository, type GenerationResultView } from "@infinite-canvas/database/generation-results";
import { createGenerationTaskRepository, type GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { parseTextQuoteSnapshot, parseTextUsageEvidence, type ImageGenerationParameters, type TextQuoteSnapshot } from "@infinite-canvas/shared";
import { getImageSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { getTextTaskSettlementPolicy } from "../../../packages/database/src/model-price-publications";
import { explainTextBilling, type TextBillingExplanation } from "../../../packages/shared/src/text-billing";
import { getAudioTaskSnapshot } from "./generation-audio-policy";
import { getVideoSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { parseVideoQuoteSnapshot, VIDEO_USAGE_POLICY, type PublicVideoTask } from "../../../packages/shared/src/generation-video";
import { GEMINI_IMAGE_PROTOCOL, GEMINI_IMAGE_USAGE, type GeminiImageIntent } from "../../../packages/shared/src/generation-gemini-image";

export class GenerationQueryError extends Error {
    constructor(public readonly code: "invalid_input" | "not_found", message: string) {
        super(message);
        this.name = "GenerationQueryError";
    }
}

export type GenerationPublicTask = Pick<GenerationTaskView,
    "id" | "spaceId" | "projectId" | "nodeId" | "modelId" | "priceVersion" | "quotedUnits" |
    "billingUnitSnapshot" | "creditsPerUnitSnapshot" | "executionStatus" | "deliveryStatus" |
    "billingStatus" | "unknownReason" | "finishedAt" | "createdAt" | "updatedAt"
> & { textQuoteSnapshot: TextQuoteSnapshot | null; billing?: { reservedCredits: string; capturedCredits: string; releasedCredits: string } | null;
    imageSpecSnapshot?: { status: "recorded"; protocol: "openai-image-v1"; parameters: ImageGenerationParameters; maxImagesPerRequest?: number } | { status: "invalid" };
    geminiImage?: { protocol: typeof GEMINI_IMAGE_PROTOCOL; usagePolicy: typeof GEMINI_IMAGE_USAGE; parameters: GeminiImageIntent; creditsPerImage: number };
    audioSnapshot?: { status: "recorded"; input: { text: string }; parameters: Record<string, unknown> } | { status: "invalid" };
    video?: PublicVideoTask; textBillingExplanation?: TextBillingExplanation };

export type GenerationPublicResult = Pick<GenerationResultView,
    "id" | "taskId" | "status" | "consumedUnits" | "resultSnapshot" | "errorCode" |
    "unknownReason" | "createdAt" | "updatedAt"
>;

export type GenerationPublicTaskView = {
    task: GenerationPublicTask;
    result: GenerationPublicResult | null;
};

type GenerationTrackingRow = Pick<typeof generationTask.$inferSelect,
    "id" | "projectId" | "nodeId" | "modelId" | "executionStatus" | "deliveryStatus" | "billingStatus" | "updatedAt"
>;
export type GenerationTrackingItem = Omit<GenerationTrackingRow, "id" | "updatedAt"> & { taskId: string; updatedAt: string };
const trackingTaskIdSchema = z.uuid();

function assertOwner(value: string) {
    if (typeof value !== "string" || !value.trim() || value.length > 200) throw new GenerationQueryError("invalid_input", "账号 ID 无效");
}

function assertTaskId(value: string) {
    if (!value.trim() || value.length > 200) throw new GenerationQueryError("invalid_input", "任务 ID 无效");
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
    return typeof value === "string" && value.length <= maxLength ? value : null;
}

function publicMedia(value: unknown): Record<string, unknown> | null {
    const media = record(value);
    const mediaId = boundedString(media?.mediaId, 200);
    const kind = media?.kind;
    const contentType = boundedString(media?.contentType, 200);
    const sizeBytes = media?.sizeBytes;
    const etag = boundedString(media?.etag, 200);
    if (!media || !mediaId || (kind !== "image" && kind !== "video" && kind !== "audio") || !contentType ||
        !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0 || !etag) return null;
    return { mediaId, kind, contentType, sizeBytes, etag };
}

function publicResultSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    const kind = snapshot.kind;
    if (kind === "text" || kind === "image" || kind === "video" || kind === "audio") safe.kind = kind;
    const text = boundedString(snapshot.text, 200_000);
    if (text !== null) safe.text = text;
    const usageEvidence = parseTextUsageEvidence(snapshot.usageEvidence);
    if (usageEvidence) safe.usageEvidence = usageEvidence;
    const media = publicMedia(snapshot.media);
    if (media) safe.media = media;
    if (kind === "image" && Array.isArray(snapshot.imageMedia) && snapshot.imageMedia.length >= 2 && snapshot.imageMedia.length <= 10) {
        const images = snapshot.imageMedia.map(publicMedia);
        if (images.every(item => item?.kind === "image") && new Set(images.map(item => item!.mediaId)).size === images.length) safe.imageMedia = images;
    }
    if (kind === "audio") {
        const evidence = record(snapshot.usageEvidence);
        if (evidence?.status === "missing" && (evidence.source === "audio_speech_binary" || evidence.source === "audio_chat_data_uri")) safe.usageEvidence = { status: "missing", source: evidence.source };
        const technical = record(snapshot.technicalAudio);
        if (technical?.source === "decoded_samples" && [technical.samplesPerChannel, technical.sampleRate, technical.channels].every(value => Number.isSafeInteger(value) && Number(value) > 0) &&
            typeof technical.durationSeconds === "number" && Number.isFinite(technical.durationSeconds) && technical.durationSeconds > 0) {
            safe.technicalAudio = { source: "decoded_samples", samplesPerChannel: technical.samplesPerChannel, sampleRate: technical.sampleRate,
                channels: technical.channels, durationSeconds: technical.durationSeconds };
        }
        const policy = record(snapshot.billingPolicy);
        if (policy?.source === "platform_successful_request" && policy.unit === "request") safe.billingPolicy = { source: "platform_successful_request", unit: "request" };
    }
    const usage = record(snapshot.usage);
    if (usage) {
        const safeUsage: Record<string, number> = {};
        for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
            const value = usage[key];
            if (Number.isSafeInteger(value) && (value as number) >= 0) safeUsage[key] = value as number;
        }
        if (Object.keys(safeUsage).length > 0) safe.usage = safeUsage;
    }
    return safe;
}

export function publicTask(task: GenerationTaskView): GenerationPublicTask {
    // Runtime projection must remain safe when repositories gain private evidence fields.
    return {
        id: task.id, spaceId: task.spaceId, projectId: task.projectId, nodeId: task.nodeId,
        modelId: task.modelId, priceVersion: task.priceVersion, quotedUnits: task.quotedUnits,
        billingUnitSnapshot: task.billingUnitSnapshot, creditsPerUnitSnapshot: task.creditsPerUnitSnapshot,
        textQuoteSnapshot: parseTextQuoteSnapshot(task.textQuoteSnapshot),
        executionStatus: task.executionStatus, deliveryStatus: task.deliveryStatus, billingStatus: task.billingStatus,
        unknownReason: task.unknownReason, finishedAt: task.finishedAt, createdAt: task.createdAt, updatedAt: task.updatedAt,
    };
}

function publicResult(result: GenerationResultView): GenerationPublicResult {
    const {
        ownerId: _ownerId,
        providerStatus: _providerStatus,
        providerTaskId: _providerTaskId,
        ...safe
    } = result;
    return { ...safe, resultSnapshot: publicResultSnapshot(result.resultSnapshot) };
}

/** Shared status-only projection; repository additions cannot widen this response. */
export function publicTrackingTask(task: GenerationTrackingRow): GenerationTrackingItem {
    return { taskId: task.id, projectId: task.projectId, nodeId: task.nodeId, modelId: task.modelId,
        executionStatus: task.executionStatus, deliveryStatus: task.deliveryStatus, billingStatus: task.billingStatus,
        updatedAt: task.updatedAt.toISOString() };
}

/** One owner-scoped status read, without loading task intent, results, billing or the current catalog. */
export async function getGenerationTasksForOwner(db: Database, input: { ownerId: string; taskIds: string[] }): Promise<{
    items: GenerationTrackingItem[]; missingTaskIds: string[];
}> {
    assertOwner(input.ownerId);
    if (!Array.isArray(input.taskIds) || input.taskIds.length > 50) throw new GenerationQueryError("invalid_input", "任务 ID 列表无效");
    const normalized: string[] = [];
    for (const value of input.taskIds) {
        const parsed = trackingTaskIdSchema.safeParse(value);
        if (!parsed.success) throw new GenerationQueryError("invalid_input", "任务 ID 无效");
        normalized.push(parsed.data.toLowerCase());
    }
    const taskIds = [...new Set(normalized)];
    if (!taskIds.length) return { items: [], missingTaskIds: [] };
    const rows = await db.select({ id: generationTask.id, projectId: generationTask.projectId, nodeId: generationTask.nodeId,
        modelId: generationTask.modelId, executionStatus: generationTask.executionStatus, deliveryStatus: generationTask.deliveryStatus,
        billingStatus: generationTask.billingStatus, updatedAt: generationTask.updatedAt }).from(generationTask).where(and(
        eq(generationTask.ownerId, input.ownerId), inArray(generationTask.id, taskIds),
    ));
    const byId = new Map(rows.map(task => [task.id, publicTrackingTask(task)]));
    const items: GenerationTrackingItem[] = [], missingTaskIds: string[] = [];
    for (const taskId of taskIds) {
        const task = byId.get(taskId);
        if (task) items.push(task);
        else missingTaskIds.push(taskId);
    }
    return { items, missingTaskIds };
}

/** Return a user-facing task/result projection without owner, idempotency, reservation or provider identifiers. */
export async function getGenerationTaskForOwner(
    db: Database,
    input: { ownerId: string; taskId: string },
): Promise<GenerationPublicTaskView> {
    assertOwner(input.ownerId);
    assertTaskId(input.taskId);
    const task = await createGenerationTaskRepository(db).get(input.ownerId, input.taskId);
    if (!task) throw new GenerationQueryError("not_found", "生成任务不存在");
    const result = await createGenerationResultRepository(db).get(input.ownerId, input.taskId);
    const view = publicTask(task);
    if (task.textQuoteSnapshot != null && task.priceVersion !== null) {
        view.textBillingExplanation = explainTextBilling({ ...task, priceVersion: task.priceVersion }, result?.resultSnapshot.usageEvidence,
            await getTextTaskSettlementPolicy(db, task));
    }
    const specification = await getImageSpecTaskSnapshot(db, task);
    if (specification.status === "recorded") view.imageSpecSnapshot = { status: "recorded", protocol: specification.protocol, parameters: specification.parameters,
        ...(specification.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: specification.maxImagesPerRequest }) };
    else if (specification.status === "invalid") view.imageSpecSnapshot = { status: "invalid" };
    else if (specification.status === "gemini") view.geminiImage = { protocol: GEMINI_IMAGE_PROTOCOL, usagePolicy: GEMINI_IMAGE_USAGE,
        parameters: specification.parameters, creditsPerImage: specification.creditsPerImage };
    const audio = await getAudioTaskSnapshot(db, task);
    if (audio) view.audioSnapshot = audio;
    if (task.videoQuoteSnapshot != null) {
        const snapshot = parseVideoQuoteSnapshot(task.videoQuoteSnapshot), original = await getVideoSpecTaskSnapshot(db, task);
        const stage = await createGenerationVideoStageRepository(db).get(task.ownerId, task.id);
        if (snapshot && original.status === "recorded" && stage) view.video = { parameters: snapshot.selectedBand.parameters,
            usagePolicy: VIDEO_USAGE_POLICY, quotedVideoUnits: 1, reservedCredits: snapshot.reservedCredits, phase: stage.phase };
    }
    if (task.textQuoteSnapshot || audio || task.videoQuoteSnapshot != null || specification.status === "gemini") {
        const reservation = task.reservationId ? await createWalletRepository(db).getReservation(input.ownerId, task.reservationId) : null;
        view.billing = reservation ? { reservedCredits: reservation.requestedUnits, capturedCredits: reservation.capturedUnits, releasedCredits: reservation.releasedUnits } : null;
    }
    return { task: view, result: result ? publicResult(result) : null };
}

/** Recover an uncertain submission without sending or reserving anything again. */
export async function getGenerationTaskByKeyForOwner(db: Database, input: { ownerId: string; idempotencyKey: string }): Promise<GenerationPublicTaskView> {
    assertOwner(input.ownerId);
    const [task] = await db.select({ id: generationTask.id }).from(generationTask).where(and(
        eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!task) throw new GenerationQueryError("not_found", "生成任务不存在");
    return getGenerationTaskForOwner(db, { ownerId: input.ownerId, taskId: task.id });
}
