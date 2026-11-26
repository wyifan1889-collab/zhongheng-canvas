import type { Database } from "@infinite-canvas/database";
import { eq } from "drizzle-orm";
import { modelCatalog } from "@infinite-canvas/database/schema";
import {
    createGenerationResultRepository,
    type GenerationResultView,
} from "@infinite-canvas/database/generation-results";
import {
    createGenerationTaskRepository,
    type GenerationTaskView,
} from "@infinite-canvas/database/generation-tasks";
import { createGenerationWalletSettlement } from "./generation-worker";
import { getImageSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";

export type GenerationReviewDecision =
    | {
        resolution: "succeeded";
        resultSnapshot: Record<string, unknown>;
        consumedUnits: number;
        delivery: "saved" | "visible";
        providerStatus?: number;
        providerTaskId?: string;
    }
    | {
        resolution: "failed";
        resultSnapshot?: Record<string, unknown>;
        errorCode: string;
        providerStatus?: number;
        providerTaskId?: string;
    };

export class GenerationReconciliationError extends Error {
    constructor(public readonly code: "invalid_input" | "not_found" | "not_reviewable" | "invalid_resolution", message: string) {
        super(message);
        this.name = "GenerationReconciliationError";
    }
}

function assertReviewId(value: string, label: string) {
    if (!value.trim() || value.length > 200) throw new GenerationReconciliationError("invalid_input", `${label}无效`);
}

function assertSnapshot(value: Record<string, unknown>, label: string) {
    if (!value || Array.isArray(value) || typeof value !== "object") {
        throw new GenerationReconciliationError("invalid_input", `${label}必须是对象`);
    }
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/** Read-only owner boundary for manual unknown-result review. It never retries a provider. */
export async function listGenerationReviewTasks(db: Database, ownerId: string, limit = 50): Promise<GenerationTaskView[]> {
    return createGenerationTaskRepository(db).listForReview(ownerId, limit);
}

/**
 * Apply an explicit provider/operator decision to an unknown task. The
 * decision is idempotent, never calls a provider, and settles the wallet only
 * after the result and delivery state are known.
 */
export async function reconcileGenerationTask(
    db: Database,
    input: { ownerId: string; taskId: string; decision: GenerationReviewDecision },
): Promise<{ task: GenerationTaskView; result: GenerationResultView }> {
    assertReviewId(input.ownerId, "账号");
    assertReviewId(input.taskId, "任务");
    const tasks = createGenerationTaskRepository(db);
    const results = createGenerationResultRepository(db);
    const current = await tasks.get(input.ownerId, input.taskId);
    if (!current) throw new GenerationReconciliationError("not_found", "生成任务不存在");
    if (current.billingUnitSnapshot === "image") throw new GenerationReconciliationError("invalid_resolution", "Gemini 图片须按原任务的交付和账务证据核对");
    if (current.videoQuoteSnapshot != null) {
        // This generic operator endpoint has neither the original inspect claim
        // nor the private video/tool verifier. Neither decision may bypass them.
        throw new GenerationReconciliationError("invalid_resolution", "视频必须通过原任务阶段和私有交付证据核对，不能手填成功或失败结算");
    }
    const existing = await results.get(input.ownerId, input.taskId);
    if (!existing) throw new GenerationReconciliationError("not_reviewable", "生成任务没有待核对的结果");
    if (input.decision.resolution === "succeeded") {
        const [model] = await db.select({ capability: modelCatalog.capability }).from(modelCatalog)
            .where(eq(modelCatalog.publicId, current.modelId));
        // Use the original model identity, including retired models. This helper
        // has no object verifier and cannot treat operator input as delivery proof.
        if (!model || model.capability === "image" || existing.resultSnapshot.kind === "image" ||
            input.decision.resultSnapshot?.kind === "image" || (await getImageSpecTaskSnapshot(db, current)).status !== "legacy") {
            throw new GenerationReconciliationError("invalid_resolution", "图片或无法核实模型类型的任务不能手填成功；图片需要原交付证据");
        }
    }
    const hasReviewState = current.executionStatus === "unknown" || current.billingStatus === "pending_review" || current.deliveryStatus === "pending" || current.deliveryStatus === "unknown";
    if (existing.status === "unknown" && !hasReviewState) {
        throw new GenerationReconciliationError("not_reviewable", "生成任务当前不在人工核对状态");
    }

    if (input.decision.resolution === "succeeded") {
        assertSnapshot(input.decision.resultSnapshot, "结果");
        if (!Number.isSafeInteger(input.decision.consumedUnits) || input.decision.consumedUnits < 0) {
            throw new GenerationReconciliationError("invalid_input", "实际用量必须是非负整数");
        }
        if (existing.status === "succeeded" && (existing.consumedUnits !== input.decision.consumedUnits ||
            canonicalJson(existing.resultSnapshot) !== canonicalJson(input.decision.resultSnapshot) ||
            (input.decision.providerStatus !== undefined && existing.providerStatus !== input.decision.providerStatus) ||
            (input.decision.providerTaskId !== undefined && existing.providerTaskId !== input.decision.providerTaskId))) {
            throw new GenerationReconciliationError("invalid_resolution", "重复核对的实际用量不一致");
        }
        if (existing.status === "failed") throw new GenerationReconciliationError("invalid_resolution", "生成结果已经判定失败");
        const result = existing.status === "unknown"
            ? await results.resolveUnknown({
                taskId: input.taskId,
                ownerId: input.ownerId,
                status: "succeeded",
                resultSnapshot: input.decision.resultSnapshot,
                consumedUnits: input.decision.consumedUnits,
                providerStatus: input.decision.providerStatus,
                providerTaskId: input.decision.providerTaskId,
            })
            : existing;
        let task = current;
        if (task.executionStatus === "unknown") {
            task = await tasks.transitionExecution({ ownerId: input.ownerId, taskId: input.taskId, status: "succeeded", providerTaskId: input.decision.providerTaskId });
        }
        if (task.executionStatus !== "succeeded") throw new GenerationReconciliationError("not_reviewable", "成功核对与执行状态不一致");
        if (task.deliveryStatus === "pending" || task.deliveryStatus === "unknown") {
            task = await tasks.transitionDelivery({ ownerId: input.ownerId, taskId: input.taskId, status: "saved" });
            if (input.decision.delivery === "visible") task = await tasks.transitionDelivery({ ownerId: input.ownerId, taskId: input.taskId, status: "visible" });
        } else if (input.decision.delivery === "visible" && task.deliveryStatus === "saved") {
            task = await tasks.transitionDelivery({ ownerId: input.ownerId, taskId: input.taskId, status: "visible" });
        } else if (task.deliveryStatus !== "saved" && task.deliveryStatus !== "visible") {
            throw new GenerationReconciliationError("not_reviewable", "成功核对与交付状态不一致");
        }
        const settled = await createGenerationWalletSettlement(db)({
            task,
            result,
            delivery: { status: input.decision.delivery },
        });
        if (settled && task.billingStatus !== settled) task = await tasks.transitionBilling({ ownerId: input.ownerId, taskId: input.taskId, status: settled });
        return { task, result };
    }

    assertReviewId(input.decision.errorCode, "错误码");
    if (existing.status === "succeeded") throw new GenerationReconciliationError("invalid_resolution", "生成结果已经判定成功");
    if (existing.status === "failed" && (existing.errorCode !== input.decision.errorCode ||
        (input.decision.resultSnapshot !== undefined && canonicalJson(existing.resultSnapshot) !== canonicalJson(input.decision.resultSnapshot)) ||
        (input.decision.providerStatus !== undefined && existing.providerStatus !== input.decision.providerStatus) ||
        (input.decision.providerTaskId !== undefined && existing.providerTaskId !== input.decision.providerTaskId))) {
        throw new GenerationReconciliationError("invalid_resolution", "重复核对的错误码不一致");
    }
    const result = existing.status === "unknown"
        ? await results.resolveUnknown({
            taskId: input.taskId,
            ownerId: input.ownerId,
            status: "failed",
            resultSnapshot: input.decision.resultSnapshot ?? {},
            errorCode: input.decision.errorCode,
            providerStatus: input.decision.providerStatus,
            providerTaskId: input.decision.providerTaskId,
        })
        : existing;
    let task = current;
    if (task.executionStatus === "unknown") task = await tasks.transitionExecution({ ownerId: input.ownerId, taskId: input.taskId, status: "failed", providerTaskId: input.decision.providerTaskId });
    if (task.executionStatus !== "failed") throw new GenerationReconciliationError("not_reviewable", "失败核对与执行状态不一致");
    if (task.deliveryStatus === "pending" || task.deliveryStatus === "unknown") task = await tasks.transitionDelivery({ ownerId: input.ownerId, taskId: input.taskId, status: "failed" });
    else if (task.deliveryStatus !== "failed") throw new GenerationReconciliationError("not_reviewable", "失败核对与交付状态不一致");
    const settled = await createGenerationWalletSettlement(db)({ task, result, delivery: { status: "failed", errorCode: input.decision.errorCode } });
    if (settled && task.billingStatus !== settled) task = await tasks.transitionBilling({ ownerId: input.ownerId, taskId: input.taskId, status: settled });
    return { task, result };
}
