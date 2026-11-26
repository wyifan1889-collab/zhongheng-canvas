import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import { generationTask } from "@infinite-canvas/database/schema";
import { createGenerationTaskRepository, GenerationTaskError, type CreateGenerationTaskInput } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { getVideoSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { createGenerationJobPayload, fromDrizzle, GENERATION_QUEUE_NAME } from "@infinite-canvas/jobs";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { parseVideoQuoteSnapshot, sameVideoParameters } from "../../../packages/shared/src/generation-video";
import type { GenerationQueueSender, ReservedGenerationDispatchResult } from "./generation-dispatch";
import { GenerationContractError } from "./generation-contract";
import { resolveExecutableVideoQuote, videoQuoteFingerprint, type VideoReferenceResources } from "./generation-video-policy";
import type { VideoRuntimePolicy } from "./generation-video-config";
import { parseGenerationVideoRequest } from "./generation-video-request";
import { assertGenerationSubmissionActor, recordConfirmedGenerationRequest, runConfirmedGenerationAdmission, type GenerationSubmissionSafety } from "./generation-admission";
import { videoQueueTransaction } from "./generation-video-queue";

export type VideoTaskIntent = Omit<CreateGenerationTaskInput, "priceVersion" | "quotedUnits" | "billingUnitSnapshot" | "creditsPerUnitSnapshot" | "textQuoteSnapshot" | "videoQuoteSnapshot">;
export type VideoSubmissionOptions = { admission?: GenerationSubmissionSafety; resources?: VideoReferenceResources };

export async function quoteReserveAndEnqueueConfirmedVideoTask(db: Database, queue: GenerationQueueSender, input: VideoTaskIntent,
    confirmedPriceVersion: number, confirmedQuoteFingerprint: string, policy: VideoRuntimePolicy, options: VideoSubmissionOptions = {}): Promise<ReservedGenerationDispatchResult> {
    const request = parseGenerationVideoRequest(input);
    if (!Number.isSafeInteger(confirmedPriceVersion) || confirmedPriceVersion < 1 || !/^[0-9a-f]{64}$/.test(confirmedQuoteFingerprint)) {
        throw new GenerationContractError("invalid_input", "请先确认完整视频规格和正式费用");
    }
    const replay = async (database: Database): Promise<ReservedGenerationDispatchResult | null> => {
        const [row] = await database.select().from(generationTask).where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey))).limit(1);
        if (!row) return null;
        const task = await createGenerationTaskRepository(database).get(input.ownerId, row.id), snapshot = parseVideoQuoteSnapshot(row.videoQuoteSnapshot);
        if (!task || !snapshot || (await getVideoSpecTaskSnapshot(database, task)).status !== "recorded" || task.priceVersion !== confirmedPriceVersion ||
            !sameVideoParameters(request.parameters, snapshot.selectedBand.parameters) || request.input.referenceMediaId !== snapshot.referenceSnapshot?.mediaId ||
            task.modelId !== input.modelId || videoQuoteFingerprint(input.ownerId, input, snapshot) !== confirmedQuoteFingerprint ||
            videoQuoteFingerprint(input.ownerId, { ...task, inputSnapshot: task.inputSnapshot, parameterSnapshot: task.parameterSnapshot,
                spaceId: task.spaceId ?? undefined, projectId: task.projectId ?? undefined, nodeId: task.nodeId ?? undefined }, snapshot) !== confirmedQuoteFingerprint) {
            throw new GenerationTaskError("idempotency_conflict", "该幂等键的原视频意图或报价不一致");
        }
        const reservation = task.reservationId ? await createWalletRepository(database).getReservation(input.ownerId, task.reservationId) : null;
        if (!reservation || reservation.taskId !== task.id) throw new GenerationTaskError("idempotency_conflict", "原视频冻结回执不完整，请核对原任务");
        return { task, reservation, created: false, jobId: null };
    };
    const original = options.admission ? await db.transaction(async tx => {
        await assertGenerationSubmissionActor(tx, options.admission, { ...input, capability: "video" });
        return replay(tx);
    }) : await replay(db);
    if (original) return original;
    const preliminary = await resolveExecutableVideoQuote(db, input, input.ownerId, policy, false, options.resources);
    if (preliminary.priceVersion !== confirmedPriceVersion || preliminary.quoteFingerprint !== confirmedQuoteFingerprint) throw new GenerationContractError("price_changed", "视频内容、规格或费用已变化，请重新确认");
    await recordConfirmedGenerationRequest(db, options.admission, { ...input, modelId: preliminary.modelId, capability: "video" });
    return db.transaction(async tx => {
        await assertGenerationSubmissionActor(tx, options.admission, { ...input, capability: "video" });
        const existing = await replay(tx); if (existing) return existing;
        const quote = await resolveExecutableVideoQuote(tx, input, input.ownerId, policy, true, options.resources);
        if (quote.priceVersion !== confirmedPriceVersion || quote.quoteFingerprint !== confirmedQuoteFingerprint) throw new GenerationContractError("price_changed", "视频内容、规格或费用已变化，请重新确认");
        const tasks = createGenerationTaskRepository(tx), wallet = createWalletRepository(tx);
        const created = await tasks.create({ ...input, parameterSnapshot: { ...quote.parameters }, priceVersion: quote.priceVersion,
            billingUnitSnapshot: "request", creditsPerUnitSnapshot: quote.reservedCredits, quotedUnits: quote.reservedCredits, videoQuoteSnapshot: quote.videoQuoteSnapshot });
        if (!created.created) { const recovered = await replay(tx); if (recovered) return recovered; throw new Error("Video replay disappeared"); }
        await runConfirmedGenerationAdmission(tx, options.admission, { ...input, modelId: quote.modelId, capability: "video" });
        const reservation = await wallet.reserve({ userId: input.ownerId, requestedUnits: quote.reservedCredits, idempotencyKey: `g:${input.idempotencyKey}`,
            providerRequestId: input.requestId, taskId: created.task.id, referenceType: "generation", referenceId: created.task.id });
        let task = await tasks.setReservationId({ ownerId: input.ownerId, taskId: created.task.id, reservationId: reservation.id });
        task = await tasks.transitionBilling({ ownerId: input.ownerId, taskId: task.id, status: "reserved" });
        await createGenerationVideoStageRepository(tx).initialize(task, quote.binding);
        const jobId = await queue.send(GENERATION_QUEUE_NAME, createGenerationJobPayload({ taskId: task.id, ownerId: task.ownerId, requestId: task.requestId }), { db: videoQueueTransaction(tx) });
        if (!jobId) throw new Error("Video initial enqueue failed");
        task = await tasks.transitionExecution({ ownerId: input.ownerId, taskId: task.id, status: "queued" });
        return { task, reservation, created: true, jobId };
    });
}
