import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import { generationTask } from "@infinite-canvas/database/schema";
import { createGenerationTaskRepository, GenerationTaskError } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { parseTextQuoteSnapshot } from "@infinite-canvas/shared";
import { createGenerationJobPayload, fromDrizzle, GENERATION_QUEUE_NAME } from "@infinite-canvas/jobs";
import { GenerationContractError } from "./generation-contract";
import { assertTextGenerationIntent, resolveExecutableTextQuote, type TextGenerationIntent } from "./generation-text-policy";
import type { GenerationQueueSender, ReservedGenerationDispatchResult } from "./generation-dispatch";
import { assertGenerationSubmissionActor, recordConfirmedGenerationRequest, runConfirmedGenerationAdmission, type GenerationSubmissionSafety } from "./generation-admission";

export async function quoteReserveAndEnqueueConfirmedTextTask(db: Database, queue: GenerationQueueSender,
    input: TextGenerationIntent & { ownerId: string; idempotencyKey: string; requestId: string },
    confirmedPriceVersion: number, options: { admission?: GenerationSubmissionSafety } = {}): Promise<ReservedGenerationDispatchResult> {
    if (!Number.isSafeInteger(confirmedPriceVersion) || confirmedPriceVersion <= 0) throw new GenerationContractError("invalid_input", "请先确认有效的价格版本");
    assertTextGenerationIntent(input);
    if (options.admission) {
        const [existing] = await db.select({ id: generationTask.id }).from(generationTask).where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey))).limit(1);
        if (!existing) {
            const checked = await resolveExecutableTextQuote(db, input);
            if (checked.priceVersion !== confirmedPriceVersion) throw new GenerationContractError("price_changed", "文本报价已变化，请重新确认");
            await recordConfirmedGenerationRequest(db, options.admission, { ...input, modelId: checked.modelId, capability: "text" });
        }
    }
    return db.transaction(async tx => {
        await assertGenerationSubmissionActor(tx, options.admission, { ...input, capability: "text" });
        const [existing] = await tx.select().from(generationTask).where(and(eq(generationTask.ownerId, input.ownerId),
            eq(generationTask.idempotencyKey, input.idempotencyKey))).limit(1);
        let textQuoteSnapshot = existing ? parseTextQuoteSnapshot(existing.textQuoteSnapshot) : null;
        if (existing) {
            if (!textQuoteSnapshot || existing.modelId !== input.modelId || existing.priceVersion !== confirmedPriceVersion ||
                textQuoteSnapshot.budgetCredits !== input.budgetCredits) throw new GenerationTaskError("idempotency_conflict", "该幂等键已用于其他生成请求");
        } else {
            const quote = await resolveExecutableTextQuote(tx, input, true);
            if (quote.priceVersion !== confirmedPriceVersion) throw new GenerationContractError("price_changed", "模型价格已变化，请重新查看并确认费用");
            textQuoteSnapshot = { schemaVersion: 1, budgetCredits: quote.budgetCredits, inputCreditsPerMillion: quote.inputCreditsPerMillion,
                outputCreditsPerMillion: quote.outputCreditsPerMillion, usageSource: quote.usageSource,
                ...(quote.cachedInputCreditsPerMillion === undefined ? {} : { cachedInputCreditsPerMillion: quote.cachedInputCreditsPerMillion }) };
        }
        if (!textQuoteSnapshot) throw new GenerationContractError("invalid_input", "文本报价快照无效");
        const tasks = createGenerationTaskRepository(tx), wallet = createWalletRepository(tx);
        const { budgetCredits: _budget, ...intent } = input;
        const created = await tasks.create({ ...intent, priceVersion: confirmedPriceVersion, textQuoteSnapshot });
        if (created.created) await runConfirmedGenerationAdmission(tx, options.admission, { ...input, modelId: created.task.modelId, capability: "text" });
        const reservation = await wallet.reserve({ userId: input.ownerId, requestedUnits: textQuoteSnapshot.budgetCredits,
            idempotencyKey: `g:${input.idempotencyKey}`, providerRequestId: created.created ? input.requestId : undefined,
            taskId: created.task.id, referenceType: "generation", referenceId: created.task.id });
        let task = created.task;
        if (task.reservationId && task.reservationId !== reservation.id) throw new Error("文本任务预算预留不匹配");
        if (!task.reservationId) task = await tasks.setReservationId({ ownerId: input.ownerId, taskId: task.id, reservationId: reservation.id });
        if (task.billingStatus === "unbilled") task = await tasks.transitionBilling({ ownerId: input.ownerId, taskId: task.id, status: "reserved" });
        if (!created.created) return { task, reservation, created: false, jobId: null };
        const payload = createGenerationJobPayload({ taskId: task.id, ownerId: task.ownerId, requestId: task.requestId });
        const jobId = await queue.send(GENERATION_QUEUE_NAME, payload, { db: fromDrizzle(tx, sql) });
        if (!jobId) throw new Error("文本生成任务入队失败");
        task = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id, status: "queued" });
        return { task, reservation, created: true, jobId };
    });
}
