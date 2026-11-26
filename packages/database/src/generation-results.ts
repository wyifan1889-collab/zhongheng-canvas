import { and, eq } from "drizzle-orm";
import type { Database } from "./client";
import { generationResult, type GenerationResultStatus } from "./schema";

export type GenerationResultView = {
    id: string;
    taskId: string;
    ownerId: string;
    status: GenerationResultStatus;
    providerStatus: number | null;
    providerTaskId: string | null;
    /** Provider meter units; wallet credits are derived from the task quote snapshot. */
    consumedUnits: number | null;
    resultSnapshot: Record<string, unknown>;
    errorCode: string | null;
    unknownReason: string | null;
    createdAt: string;
    updatedAt: string;
};

export type GenerationMediaReference = {
    mediaId: string;
    kind: "image" | "video" | "audio";
    contentType: string;
    sizeBytes: number;
    etag: string;
};

export type CreateGenerationResultInput = {
    taskId: string;
    ownerId: string;
    status: GenerationResultStatus;
    providerStatus?: number;
    providerTaskId?: string;
    consumedUnits?: number;
    resultSnapshot: Record<string, unknown>;
    errorCode?: string;
    unknownReason?: string;
};

export class GenerationResultError extends Error {
    constructor(
        public readonly code: "invalid_input" | "idempotency_conflict" | "not_found",
        message: string,
    ) {
        super(message);
        this.name = "GenerationResultError";
    }
}

function assertIdentifier(value: string, label: string) {
    if (!value.trim() || value.length > 200) throw new GenerationResultError("invalid_input", `${label}无效`);
}

function assertSnapshot(value: Record<string, unknown>) {
    if (!value || Array.isArray(value) || typeof value !== "object") {
        throw new GenerationResultError("invalid_input", "生成结果必须是对象");
    }
}

function toView(row: typeof generationResult.$inferSelect): GenerationResultView {
    return {
        id: row.id,
        taskId: row.taskId,
        ownerId: row.ownerId,
        status: row.status,
        providerStatus: row.providerStatus,
        providerTaskId: row.providerTaskId,
        consumedUnits: row.consumedUnits,
        resultSnapshot: row.resultSnapshot,
        errorCode: row.errorCode,
        unknownReason: row.unknownReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function sameIntent(row: typeof generationResult.$inferSelect, input: CreateGenerationResultInput) {
    return row.ownerId === input.ownerId && row.status === input.status &&
        row.providerStatus === (input.providerStatus ?? null) &&
        row.consumedUnits === (input.consumedUnits ?? null) &&
        row.providerTaskId === (input.providerTaskId ?? null) &&
        canonicalJson(row.resultSnapshot) === canonicalJson(input.resultSnapshot) &&
        row.errorCode === (input.errorCode ?? null) &&
        row.unknownReason === (input.status === "unknown" ? input.unknownReason?.trim() ?? null : null);
}

function validateInput(input: CreateGenerationResultInput) {
    assertIdentifier(input.taskId, "任务 ID");
    assertIdentifier(input.ownerId, "账号 ID");
    assertSnapshot(input.resultSnapshot);
    if (input.providerTaskId !== undefined) assertIdentifier(input.providerTaskId, "供应商任务 ID");
    if (input.errorCode !== undefined) assertIdentifier(input.errorCode, "错误码");
    if (input.providerStatus !== undefined && (!Number.isInteger(input.providerStatus) || input.providerStatus < 100 || input.providerStatus > 599)) {
        throw new GenerationResultError("invalid_input", "供应商状态码无效");
    }
    if (input.consumedUnits !== undefined && (!Number.isSafeInteger(input.consumedUnits) || input.consumedUnits < 0)) {
        throw new GenerationResultError("invalid_input", "实际用量必须是非负整数");
    }
    if (input.status === "failed" && !input.errorCode?.trim()) {
        throw new GenerationResultError("invalid_input", "失败结果必须记录错误码");
    }
    if (input.status === "unknown" && !input.unknownReason?.trim()) {
        throw new GenerationResultError("invalid_input", "未知结果必须记录原因");
    }
}

function validateMediaReference(media: GenerationMediaReference) {
    assertIdentifier(media.mediaId, "媒体 ID");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(media.mediaId)) {
        throw new GenerationResultError("invalid_input", "媒体 ID 无效");
    }
    if (!(["image", "video", "audio"] as const).includes(media.kind)) {
        throw new GenerationResultError("invalid_input", "媒体类型无效");
    }
    if (!media.contentType || /[\r\n]/.test(media.contentType) || media.contentType.length > 200) {
        throw new GenerationResultError("invalid_input", "媒体类型无效");
    }
    if (!media.contentType.toLowerCase().startsWith(`${media.kind}/`)) {
        throw new GenerationResultError("invalid_input", "媒体类型与素材不匹配");
    }
    if (!Number.isSafeInteger(media.sizeBytes) || media.sizeBytes <= 0) {
        throw new GenerationResultError("invalid_input", "媒体大小无效");
    }
    assertIdentifier(media.etag, "媒体校验值");
}

export function createGenerationResultRepository(db: Database) {
    return {
        async create(input: CreateGenerationResultInput): Promise<{ result: GenerationResultView; created: boolean }> {
            validateInput(input);
            const [inserted] = await db.insert(generationResult).values({
                id: crypto.randomUUID(), taskId: input.taskId, ownerId: input.ownerId,
                status: input.status, providerStatus: input.providerStatus,
                providerTaskId: input.providerTaskId, consumedUnits: input.consumedUnits, resultSnapshot: input.resultSnapshot,
                errorCode: input.errorCode,
                unknownReason: input.status === "unknown" ? input.unknownReason!.trim() : undefined,
            }).onConflictDoNothing({ target: generationResult.taskId }).returning();
            if (inserted) return { result: toView(inserted), created: true };
            const [existing] = await db.select().from(generationResult)
                .where(and(eq(generationResult.ownerId, input.ownerId), eq(generationResult.taskId, input.taskId)));
            if (!existing) throw new GenerationResultError("not_found", "生成结果不存在");
            if (!sameIntent(existing, input)) throw new GenerationResultError("idempotency_conflict", "任务已有不同生成结果");
            return { result: toView(existing), created: false };
        },

        /** Resolve an unknown provider result only after an explicit operator/provider decision. */
        async resolveUnknown(input: Omit<CreateGenerationResultInput, "status"> & { status: "succeeded" | "failed" }): Promise<GenerationResultView> {
            validateInput(input);
            return db.transaction(async (tx) => {
                const [current] = await tx.select().from(generationResult)
                    .where(and(eq(generationResult.ownerId, input.ownerId), eq(generationResult.taskId, input.taskId))).for("update");
                if (!current) throw new GenerationResultError("not_found", "生成结果不存在");
                if (current.status === input.status && sameIntent(current, input)) return toView(current);
                if (current.status !== "unknown") throw new GenerationResultError("idempotency_conflict", "生成结果已经结算");
                const [updated] = await tx.update(generationResult).set({
                    status: input.status,
                    providerStatus: input.providerStatus ?? null,
                    providerTaskId: input.providerTaskId ?? null,
                    consumedUnits: input.consumedUnits ?? null,
                    resultSnapshot: input.resultSnapshot,
                    errorCode: input.errorCode ?? null,
                    unknownReason: null,
                    updatedAt: new Date(),
                }).where(eq(generationResult.id, current.id)).returning();
                if (!updated) throw new GenerationResultError("not_found", "生成结果更新失败");
                return toView(updated);
            });
        },

        /** Attach one deterministic, server-owned media reference idempotently. */
        async attachMedia(input: { ownerId: string; taskId: string; media: GenerationMediaReference; images?: GenerationMediaReference[]; audioRequestDelivered?: true; videoDelivered?: true; geminiImagesDelivered?: true }): Promise<GenerationResultView> {
            assertIdentifier(input.ownerId, "账号 ID");
            assertIdentifier(input.taskId, "任务 ID");
            validateMediaReference(input.media);
            if (input.images !== undefined) {
                if (!Array.isArray(input.images) || input.images.length < 2 || input.images.length > 10 ||
                    new Set(input.images.map(item => item.mediaId)).size !== input.images.length ||
                    canonicalJson(input.images[0]) !== canonicalJson(input.media)) throw new GenerationResultError("invalid_input", "图片引用集合无效");
                for (const image of input.images) { validateMediaReference(image); if (image.kind !== "image") throw new GenerationResultError("invalid_input", "图片引用类型无效"); }
            }
            return db.transaction(async (tx) => {
                const [current] = await tx.select().from(generationResult)
                    .where(and(eq(generationResult.ownerId, input.ownerId), eq(generationResult.taskId, input.taskId))).for("update");
                if (!current) throw new GenerationResultError("not_found", "生成结果不存在");
                if (input.images && (current.resultSnapshot.kind !== "image" || !Array.isArray(current.resultSnapshot.images) || current.resultSnapshot.images.length !== input.images.length)) throw new GenerationResultError("invalid_input", "图片交付数量不匹配");
                if (input.videoDelivered && (current.status !== "succeeded" || current.resultSnapshot.kind !== "video" || input.media.kind !== "video" ||
                    (current.consumedUnits !== null && current.consumedUnits !== 1))) throw new GenerationResultError("invalid_input", "视频交付条数证据不匹配");
                if (input.audioRequestDelivered && (current.status !== "succeeded" || current.resultSnapshot.kind !== "audio" || input.media.kind !== "audio" ||
                    (current.consumedUnits !== null && current.consumedUnits !== 1))) throw new GenerationResultError("invalid_input", "音频按次交付证据不匹配");
                const imageCount = input.images?.length ?? 1;
                if (input.geminiImagesDelivered && (current.status !== "succeeded" || current.resultSnapshot.kind !== "image" || input.media.kind !== "image" ||
                    !current.resultSnapshot.geminiBatch || (imageCount === 1 && current.resultSnapshot.images !== undefined) ||
                    current.consumedUnits !== null && current.consumedUnits !== imageCount)) throw new GenerationResultError("invalid_input", "Gemini 实际交付张数不匹配");
                const existing = current.resultSnapshot.media;
                if (existing !== undefined && canonicalJson(existing) !== canonicalJson(input.media)) {
                    throw new GenerationResultError("idempotency_conflict", "生成结果已有不同媒体引用");
                }
                if (existing !== undefined && canonicalJson(current.resultSnapshot.imageMedia ?? null) !== canonicalJson(input.images ?? null)) throw new GenerationResultError("idempotency_conflict", "图片交付集合已变化");
                if (existing !== undefined && input.geminiImagesDelivered && current.consumedUnits !== imageCount) throw new GenerationResultError("idempotency_conflict", "图片计量与已交付记录不一致");
                if (existing !== undefined && (!(input.audioRequestDelivered || input.videoDelivered) || current.consumedUnits === 1)) return toView(current);
                const [updated] = await tx.update(generationResult).set({
                    resultSnapshot: { ...current.resultSnapshot, media: input.media, ...(input.images ? { imageMedia: input.images } : {}) },
                    ...(input.geminiImagesDelivered ? { consumedUnits: imageCount } : input.audioRequestDelivered || input.videoDelivered ? { consumedUnits: 1 } : {}),
                    updatedAt: new Date(),
                }).where(eq(generationResult.id, current.id)).returning();
                if (!updated) throw new GenerationResultError("not_found", "生成结果更新失败");
                return toView(updated);
            });
        },

        async get(ownerId: string, taskId: string): Promise<GenerationResultView | null> {
            assertIdentifier(ownerId, "账号 ID");
            assertIdentifier(taskId, "任务 ID");
            const [row] = await db.select().from(generationResult)
                .where(and(eq(generationResult.ownerId, ownerId), eq(generationResult.taskId, taskId)));
            return row ? toView(row) : null;
        },
    };
}
