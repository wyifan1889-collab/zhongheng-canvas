import { and, desc, eq, or } from "drizzle-orm";
import type { Database } from "./client";
import { parseTextQuoteSnapshot, type TextQuoteSnapshot } from "@infinite-canvas/shared";
import { parseVideoQuoteSnapshot, type VideoQuoteSnapshot } from "../../shared/src/generation-video";
import {
    generationTask,
    modelCatalog,
    modelProvider,
    type TaskBillingUnit,
    type GenerationBillingStatus,
    type GenerationDeliveryStatus,
    type GenerationExecutionStatus,
} from "./schema";

export type GenerationTaskView = {
    id: string;
    ownerId: string;
    spaceId: string | null;
    projectId: string | null;
    nodeId: string | null;
    inputSnapshot: Record<string, unknown>;
    modelId: string;
    parameterSnapshot: Record<string, unknown>;
    priceVersion: number | null;
    quotedUnits: number | null;
    billingUnitSnapshot: TaskBillingUnit | null;
    creditsPerUnitSnapshot: number | null;
    textQuoteSnapshot: TextQuoteSnapshot | null;
    videoQuoteSnapshot: VideoQuoteSnapshot | null;
    /** Internal immutable publication identity; public task projection must omit it. */
    pricePublicationId: string | null;
    idempotencyKey: string;
    reservationId: string | null;
    providerTaskId: string | null;
    executionStatus: GenerationExecutionStatus;
    deliveryStatus: GenerationDeliveryStatus;
    billingStatus: GenerationBillingStatus;
    unknownReason: string | null;
    requestId: string;
    finishedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type CreateGenerationTaskInput = {
    ownerId: string;
    spaceId?: string;
    projectId?: string;
    nodeId?: string;
    inputSnapshot: Record<string, unknown>;
    modelId: string;
    parameterSnapshot: Record<string, unknown>;
    priceVersion?: number;
    quotedUnits?: number;
    billingUnitSnapshot?: TaskBillingUnit;
    creditsPerUnitSnapshot?: number;
    textQuoteSnapshot?: TextQuoteSnapshot;
    videoQuoteSnapshot?: VideoQuoteSnapshot;
    idempotencyKey: string;
    requestId: string;
};

export class GenerationTaskError extends Error {
    constructor(
        public readonly code: "invalid_input" | "idempotency_conflict" | "not_found" | "invalid_transition" | "model_unavailable",
        message: string,
    ) {
        super(message);
        this.name = "GenerationTaskError";
    }
}

const executionTransitions: Record<GenerationExecutionStatus, readonly GenerationExecutionStatus[]> = {
    pending: ["queued", "cancelled", "unknown"],
    queued: ["running", "cancelled", "unknown"],
    running: ["succeeded", "failed", "cancelled", "timeout", "unknown"],
    succeeded: [],
    failed: [],
    unknown: ["succeeded", "failed", "cancelled"],
    cancelled: [],
    timeout: ["unknown"],
};

const deliveryTransitions: Record<GenerationDeliveryStatus, readonly GenerationDeliveryStatus[]> = {
    pending: ["saved", "failed", "unknown"],
    saved: ["visible", "failed"],
    visible: [],
    failed: [],
    unknown: ["saved", "visible", "failed"],
};

const billingTransitions: Record<GenerationBillingStatus, readonly GenerationBillingStatus[]> = {
    unbilled: ["reserved"],
    reserved: ["captured", "released", "pending_review"],
    captured: [],
    released: [],
    pending_review: ["captured", "released"],
};

function assertIdentifier(value: string, label: string) {
    if (!value.trim() || value.length > 200) throw new GenerationTaskError("invalid_input", `${label}无效`);
}

function assertSnapshot(value: Record<string, unknown>, label: string) {
    if (!value || Array.isArray(value) || typeof value !== "object") {
        throw new GenerationTaskError("invalid_input", `${label}必须是对象`);
    }
}

function assertPositiveInteger(value: number | undefined, label: string) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new GenerationTaskError("invalid_input", `${label}必须是正整数`);
    }
}

function assertNonNegativeInteger(value: number | undefined, label: string) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new GenerationTaskError("invalid_input", `${label}必须是非负整数`);
    }
}

function assertBillingUnit(value: TaskBillingUnit | undefined, label: string) {
    if (value !== undefined && !["request", "input_token", "output_token", "second", "megapixel", "image"].includes(value)) {
        throw new GenerationTaskError("invalid_input", `${label}无效`);
    }
}

function assertPricingSnapshot(input: CreateGenerationTaskInput) {
    if (input.videoQuoteSnapshot !== undefined) {
        const video = parseVideoQuoteSnapshot(input.videoQuoteSnapshot);
        if (!video || input.textQuoteSnapshot !== undefined || input.priceVersion !== video.priceVersion ||
            input.billingUnitSnapshot !== "request" || input.creditsPerUnitSnapshot !== video.selectedBand.creditsPerVideo ||
            input.quotedUnits !== video.reservedCredits || canonicalJson(input.parameterSnapshot) !== canonicalJson(video.selectedBand.parameters)) {
            throw new GenerationTaskError("invalid_input", "视频原价与完整规格快照不匹配");
        }
    }
    if (input.textQuoteSnapshot !== undefined) {
        if (!parseTextQuoteSnapshot(input.textQuoteSnapshot) || input.priceVersion === undefined || input.quotedUnits !== undefined ||
            input.billingUnitSnapshot !== undefined || input.creditsPerUnitSnapshot !== undefined) {
            throw new GenerationTaskError("invalid_input", "文本预算和价格快照必须完整且不能混入单项报价");
        }
        return;
    }
    const fields = [input.priceVersion, input.quotedUnits, input.billingUnitSnapshot, input.creditsPerUnitSnapshot];
    const present = fields.filter((value) => value !== undefined).length;
    if (present !== 0 && present !== fields.length) {
        throw new GenerationTaskError("invalid_input", "报价快照必须完整");
    }
    assertBillingUnit(input.billingUnitSnapshot, "计量单位");
    assertPositiveInteger(input.creditsPerUnitSnapshot, "单位价格");
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

function sameCreateIntent(row: typeof generationTask.$inferSelect, input: CreateGenerationTaskInput) {
    return row.modelId === input.modelId && row.spaceId === (input.spaceId ?? null) &&
        row.projectId === (input.projectId ?? null) && row.nodeId === (input.nodeId ?? null) &&
        row.priceVersion === (input.priceVersion ?? null) && row.quotedUnits === (input.quotedUnits ?? null) &&
        row.billingUnitSnapshot === (input.billingUnitSnapshot ?? null) &&
        row.creditsPerUnitSnapshot === (input.creditsPerUnitSnapshot ?? null) &&
        canonicalJson(row.textQuoteSnapshot) === canonicalJson(input.textQuoteSnapshot ?? null) &&
        canonicalJson(row.videoQuoteSnapshot) === canonicalJson(input.videoQuoteSnapshot ?? null) &&
        canonicalJson(row.inputSnapshot) === canonicalJson(input.inputSnapshot) &&
        canonicalJson(row.parameterSnapshot) === canonicalJson(input.parameterSnapshot);
}

function toView(row: typeof generationTask.$inferSelect): GenerationTaskView {
    return {
        id: row.id,
        ownerId: row.ownerId,
        spaceId: row.spaceId,
        projectId: row.projectId,
        nodeId: row.nodeId,
        inputSnapshot: row.inputSnapshot,
        modelId: row.modelId,
        parameterSnapshot: row.parameterSnapshot,
        priceVersion: row.priceVersion,
        quotedUnits: row.quotedUnits,
        billingUnitSnapshot: row.billingUnitSnapshot,
        creditsPerUnitSnapshot: row.creditsPerUnitSnapshot,
        textQuoteSnapshot: row.textQuoteSnapshot,
        videoQuoteSnapshot: parseVideoQuoteSnapshot(row.videoQuoteSnapshot),
        pricePublicationId: row.pricePublicationId,
        idempotencyKey: row.idempotencyKey,
        reservationId: row.reservationId,
        providerTaskId: row.providerTaskId,
        executionStatus: row.executionStatus,
        deliveryStatus: row.deliveryStatus,
        billingStatus: row.billingStatus,
        unknownReason: row.unknownReason,
        requestId: row.requestId,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function assertExecutionTransition(current: GenerationExecutionStatus, next: GenerationExecutionStatus) {
    if (current !== next && !executionTransitions[current].includes(next)) {
        throw new GenerationTaskError("invalid_transition", `执行状态不能从 ${current} 变为 ${next}`);
    }
}

function assertDeliveryTransition(current: GenerationDeliveryStatus, next: GenerationDeliveryStatus) {
    if (current !== next && !deliveryTransitions[current].includes(next)) {
        throw new GenerationTaskError("invalid_transition", `交付状态不能从 ${current} 变为 ${next}`);
    }
}

function assertBillingTransition(current: GenerationBillingStatus, next: GenerationBillingStatus) {
    if (current !== next && !billingTransitions[current].includes(next)) {
        throw new GenerationTaskError("invalid_transition", `账务状态不能从 ${current} 变为 ${next}`);
    }
}

export function createGenerationTaskRepository(db: Database) {
    return {
        async create(input: CreateGenerationTaskInput): Promise<{ task: GenerationTaskView; created: boolean }> {
            assertIdentifier(input.ownerId, "账号");
            assertIdentifier(input.modelId, "模型");
            assertIdentifier(input.idempotencyKey, "幂等键");
            assertIdentifier(input.requestId, "请求 ID");
            assertSnapshot(input.inputSnapshot, "输入快照");
            assertSnapshot(input.parameterSnapshot, "参数快照");
            assertPricingSnapshot(input);
            assertPositiveInteger(input.priceVersion, "价格版本");
            assertNonNegativeInteger(input.quotedUnits, "报价额度");
            for (const [value, label] of [[input.spaceId, "工作区"], [input.projectId, "项目"], [input.nodeId, "节点"]] as const) {
                if (value !== undefined) assertIdentifier(value, label);
            }
            return db.transaction(async tx => {
                const [replay] = await tx.select().from(generationTask).where(and(
                    eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey),
                ));
                if (replay) {
                    if (!sameCreateIntent(replay, input)) throw new GenerationTaskError("idempotency_conflict", "幂等键已用于其他生成请求");
                    return { task: toView(replay), created: false };
                }
                // Match deletion's locks: either admission commits first and blocks deletion,
                // or deletion commits first and this new task cannot reserve any credits.
                const [catalog] = await tx.select({ providerId: modelCatalog.providerId, deletedAt: modelCatalog.deletedAt })
                    .from(modelCatalog).where(eq(modelCatalog.publicId, input.modelId)).for("share");
                if (catalog) {
                    const [provider] = await tx.select({ deletedAt: modelProvider.deletedAt }).from(modelProvider)
                        .where(eq(modelProvider.id, catalog.providerId)).for("share");
                    if (catalog.deletedAt || !provider || provider.deletedAt) throw new GenerationTaskError("model_unavailable", "模型或渠道已删除，请重新选择模型");
                }
                const id = crypto.randomUUID();
                const [inserted] = await tx.insert(generationTask).values({
                    id,
                    ownerId: input.ownerId,
                    spaceId: input.spaceId,
                    projectId: input.projectId,
                    nodeId: input.nodeId,
                    inputSnapshot: input.inputSnapshot,
                    modelId: input.modelId,
                    parameterSnapshot: input.parameterSnapshot,
                    priceVersion: input.priceVersion,
                    quotedUnits: input.quotedUnits,
                    billingUnitSnapshot: input.billingUnitSnapshot,
                    creditsPerUnitSnapshot: input.creditsPerUnitSnapshot,
                    textQuoteSnapshot: input.textQuoteSnapshot,
                    videoQuoteSnapshot: input.videoQuoteSnapshot,
                    idempotencyKey: input.idempotencyKey,
                    requestId: input.requestId,
                }).onConflictDoNothing({ target: [generationTask.ownerId, generationTask.idempotencyKey] }).returning();
                if (inserted) return { task: toView(inserted), created: true };
                const [existing] = await tx.select().from(generationTask)
                    .where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey)));
                if (!existing) throw new GenerationTaskError("not_found", "生成任务幂等记录不存在");
                if (!sameCreateIntent(existing, input)) throw new GenerationTaskError("idempotency_conflict", "幂等键已用于其他生成请求");
                return { task: toView(existing), created: false };
            });
        },

        async get(ownerId: string, taskId: string): Promise<GenerationTaskView | null> {
            assertIdentifier(ownerId, "账号");
            assertIdentifier(taskId, "任务");
            const [row] = await db.select().from(generationTask)
                .where(and(eq(generationTask.ownerId, ownerId), eq(generationTask.id, taskId)));
            return row ? toView(row) : null;
        },

        /** Owner-scoped review queue; this is a read boundary, not an automatic retry. */
        async listForReview(ownerId: string, limit = 50): Promise<GenerationTaskView[]> {
            assertIdentifier(ownerId, "账号");
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GenerationTaskError("invalid_input", "核对查询数量无效");
            const rows = await db.select().from(generationTask)
                .where(and(eq(generationTask.ownerId, ownerId), or(eq(generationTask.executionStatus, "unknown"), eq(generationTask.billingStatus, "pending_review"))))
                .orderBy(desc(generationTask.updatedAt), desc(generationTask.id))
                .limit(limit);
            return rows.map(toView);
        },

        async setReservationId(input: { ownerId: string; taskId: string; reservationId: string }): Promise<GenerationTaskView> {
            assertIdentifier(input.ownerId, "账号");
            assertIdentifier(input.taskId, "任务");
            assertIdentifier(input.reservationId, "余额预留");
            return db.transaction(async (tx) => {
                const [current] = await tx.select().from(generationTask)
                    .where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.id, input.taskId))).for("update");
                if (!current) throw new GenerationTaskError("not_found", "生成任务不存在");
                if (current.reservationId && current.reservationId !== input.reservationId) {
                    throw new GenerationTaskError("idempotency_conflict", "生成任务已绑定其他余额预留");
                }
                if (current.reservationId === input.reservationId) return toView(current);
                const [updated] = await tx.update(generationTask).set({ reservationId: input.reservationId, updatedAt: new Date() })
                    .where(eq(generationTask.id, current.id)).returning();
                if (!updated) throw new GenerationTaskError("not_found", "生成任务更新失败");
                return toView(updated);
            });
        },

        /** Atomically claims a queued task. A null result means another worker won the claim. */
        async claimRunning(input: { ownerId: string; taskId: string }): Promise<GenerationTaskView | null> {
            assertIdentifier(input.ownerId, "账号");
            assertIdentifier(input.taskId, "任务");
            return db.transaction(async (tx) => {
                const [updated] = await tx.update(generationTask).set({
                    executionStatus: "running",
                    updatedAt: new Date(),
                }).where(and(
                    eq(generationTask.ownerId, input.ownerId),
                    eq(generationTask.id, input.taskId),
                    eq(generationTask.executionStatus, "queued"),
                )).returning();
                return updated ? toView(updated) : null;
            });
        },

        async transitionExecution(input: { ownerId: string; taskId: string; status: GenerationExecutionStatus; providerTaskId?: string; unknownReason?: string }): Promise<GenerationTaskView> {
            assertIdentifier(input.ownerId, "账号");
            assertIdentifier(input.taskId, "任务");
            if (input.status === "unknown" && !input.unknownReason?.trim()) throw new GenerationTaskError("invalid_input", "未知结果必须记录原因");
            if (input.providerTaskId !== undefined) assertIdentifier(input.providerTaskId, "供应商任务 ID");
            return db.transaction(async (tx) => {
                const [current] = await tx.select().from(generationTask)
                    .where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.id, input.taskId))).for("update");
                if (!current) throw new GenerationTaskError("not_found", "生成任务不存在");
                assertExecutionTransition(current.executionStatus, input.status);
                if (current.videoQuoteSnapshot != null && current.providerTaskId !== null && input.providerTaskId !== undefined && input.providerTaskId !== current.providerTaskId) {
                    throw new GenerationTaskError("idempotency_conflict", "视频上游任务身份不可覆写");
                }
                const finished = ["succeeded", "failed", "unknown", "cancelled", "timeout"].includes(input.status);
                const [updated] = await tx.update(generationTask).set({
                    executionStatus: input.status,
                    providerTaskId: input.providerTaskId ?? current.providerTaskId,
                    unknownReason: input.status === "unknown" ? input.unknownReason!.trim() : null,
                    finishedAt: finished ? new Date() : current.finishedAt,
                    updatedAt: new Date(),
                }).where(eq(generationTask.id, current.id)).returning();
                if (!updated) throw new GenerationTaskError("not_found", "生成任务更新失败");
                return toView(updated);
            });
        },

        async transitionDelivery(input: { ownerId: string; taskId: string; status: GenerationDeliveryStatus }): Promise<GenerationTaskView> {
            assertIdentifier(input.ownerId, "账号");
            assertIdentifier(input.taskId, "任务");
            return db.transaction(async (tx) => {
                const [current] = await tx.select().from(generationTask)
                    .where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.id, input.taskId))).for("update");
                if (!current) throw new GenerationTaskError("not_found", "生成任务不存在");
                assertDeliveryTransition(current.deliveryStatus, input.status);
                const [updated] = await tx.update(generationTask).set({ deliveryStatus: input.status, updatedAt: new Date() })
                    .where(eq(generationTask.id, current.id)).returning();
                if (!updated) throw new GenerationTaskError("not_found", "生成任务更新失败");
                return toView(updated);
            });
        },

        async transitionBilling(input: { ownerId: string; taskId: string; status: GenerationBillingStatus }): Promise<GenerationTaskView> {
            assertIdentifier(input.ownerId, "账号");
            assertIdentifier(input.taskId, "任务");
            return db.transaction(async (tx) => {
                const [current] = await tx.select().from(generationTask)
                    .where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.id, input.taskId))).for("update");
                if (!current) throw new GenerationTaskError("not_found", "生成任务不存在");
                assertBillingTransition(current.billingStatus, input.status);
                const [updated] = await tx.update(generationTask).set({ billingStatus: input.status, updatedAt: new Date() })
                    .where(eq(generationTask.id, current.id)).returning();
                if (!updated) throw new GenerationTaskError("not_found", "生成任务更新失败");
                return toView(updated);
            });
        },
    };
}
