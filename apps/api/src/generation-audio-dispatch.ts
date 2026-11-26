import { and, eq } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import { generationTask } from "@infinite-canvas/database/schema";
import { GenerationTaskError } from "@infinite-canvas/database/generation-tasks";
import { GenerationContractError, type GenerationIntent } from "./generation-contract";
import { quoteReserveAndEnqueueGenerationTask, type GenerationQueueSender, type GenerationQuote } from "./generation-dispatch";
import { assertGenerationAudioIntent, audioQuoteFingerprint, getAudioTaskSnapshot, resolveExecutableAudioQuote } from "./generation-audio-policy";
import { assertGenerationSubmissionActor, recordConfirmedGenerationRequest, type GenerationSubmissionSafety } from "./generation-admission";

export async function quoteReserveAndEnqueueConfirmedAudioTask(db: Database, queue: GenerationQueueSender,
    input: GenerationIntent & { ownerId: string; requestId: string; idempotencyKey: string }, confirmedPriceVersion: number, confirmedQuoteFingerprint: string,
    options: { admission?: GenerationSubmissionSafety } = {}) {
    assertGenerationAudioIntent(input);
    if (!Number.isSafeInteger(confirmedPriceVersion) || confirmedPriceVersion <= 0 || !/^[0-9a-f]{64}$/.test(confirmedQuoteFingerprint ?? "")) {
        throw new GenerationContractError("invalid_input", "请先确认本次语音内容和有效报价");
    }
    if (options.admission) {
        const [existing] = await db.select({ id: generationTask.id }).from(generationTask).where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey))).limit(1);
        if (!existing) {
            const checked = await resolveExecutableAudioQuote(db, input, input.ownerId);
            if (checked.priceVersion !== confirmedPriceVersion || checked.quoteFingerprint !== confirmedQuoteFingerprint) throw new GenerationContractError("price_changed", "语音内容或报价已变化，请重新确认");
            await recordConfirmedGenerationRequest(db, options.admission, { ...input, modelId: checked.modelId, capability: "audio" });
        }
    }
    return db.transaction(async tx => {
        await assertGenerationSubmissionActor(tx, options.admission, { ...input, capability: "audio" });
        const [existing] = await tx.select().from(generationTask).where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey))).limit(1);
        let quote: GenerationQuote;
        if (existing) {
            const snapshot = await getAudioTaskSnapshot(tx, existing);
            if (snapshot?.status !== "recorded" || existing.modelId !== input.modelId || existing.priceVersion !== confirmedPriceVersion ||
                existing.quotedUnits === null || existing.creditsPerUnitSnapshot === null || !existing.pricePublicationId) {
                throw new GenerationTaskError("idempotency_conflict", "该幂等键已用于其他生成请求");
            }
            quote = { modelId: existing.modelId, priceVersion: existing.priceVersion!, quotedUnits: existing.quotedUnits, billingUnit: "request",
                creditsPerUnit: existing.creditsPerUnitSnapshot, pricePublicationId: existing.pricePublicationId };
            const original = audioQuoteFingerprint(input.ownerId, { modelId: existing.modelId, inputSnapshot: existing.inputSnapshot,
                parameterSnapshot: existing.parameterSnapshot, ...(existing.projectId ? { projectId: existing.projectId } : {}),
                ...(existing.spaceId ? { spaceId: existing.spaceId } : {}), ...(existing.nodeId ? { nodeId: existing.nodeId } : {}) }, quote);
            if (original !== confirmedQuoteFingerprint || audioQuoteFingerprint(input.ownerId, input, quote) !== original) {
                throw new GenerationTaskError("idempotency_conflict", "幂等键的原语音内容与报价确认不匹配");
            }
        } else {
            quote = await resolveExecutableAudioQuote(tx, input, input.ownerId, true);
            if (quote.priceVersion !== confirmedPriceVersion || quote.quoteFingerprint !== confirmedQuoteFingerprint) {
                throw new GenerationContractError("price_changed", "语音内容、参数或价格已变化，请重新查看并确认费用");
            }
        }
        return quoteReserveAndEnqueueGenerationTask(tx, queue, input, quote, { ...options, capability: "audio" });
    });
}
