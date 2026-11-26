import { and, eq } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { getImageSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { generationTask, type GenerationBillingStatus } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { compareCreditAmounts, validImageGenerationCount } from "@infinite-canvas/shared";
import type { createGeminiImageDeliveryVerifier } from "./generation-delivery";

/** The ledger keys identify the same two operations even if only the first committed before recovery. */
export async function settleGeminiImages(db: Database, task: GenerationTaskView,
    verify: ReturnType<typeof createGeminiImageDeliveryVerifier> | undefined): Promise<GenerationBillingStatus> {
    try {
        return await db.transaction(async tx => {
            const [current] = await tx.select({ execution: generationTask.executionStatus, delivery: generationTask.deliveryStatus,
                billing: generationTask.billingStatus, reservationId: generationTask.reservationId }).from(generationTask)
                .where(and(eq(generationTask.ownerId, task.ownerId), eq(generationTask.id, task.id))).for("update");
            if (!current || !current.reservationId || current.reservationId !== task.reservationId) return "pending_review";
            if (current.billing === "captured" || current.billing === "released") return current.billing;
            if (current.billing !== "reserved" && current.billing !== "pending_review") return "pending_review";
            const source = await getImageSpecTaskSnapshot(tx, task);
            if (source.status !== "gemini") return "pending_review";
            const result = await createGenerationResultRepository(tx).get(task.ownerId, task.id);
            const wallet = createWalletRepository(tx), reservation = await wallet.getReservation(task.ownerId, current.reservationId);
            const budget = source.parameters.budgetCredits;
            if (!result || !reservation || reservation.taskId !== task.id || reservation.providerRequestId !== task.requestId ||
                compareCreditAmounts(reservation.requestedUnits, String(budget)) !== 0) return "pending_review";
            const amountIs = (field: string, amount: number) => compareCreditAmounts(field, String(amount)) === 0;
            const reference = { userId: task.ownerId, reservationId: reservation.id, referenceType: "generation", referenceId: task.id };
            const captureKey = `generation:${task.id}:capture`;
            const releaseKey = `generation:${task.id}:release`;
            const neverCaptured = amountIs(reservation.capturedUnits, 0), neverReleased = amountIs(reservation.releasedUnits, 0);
            if (result.status === "failed" && current.execution === "failed" && current.delivery === "failed") {
                if (!neverCaptured || !(neverReleased && reservation.status === "pending" || amountIs(reservation.releasedUnits, budget) && reservation.status === "released")) return "pending_review";
                const released = await wallet.release({ ...reference, releasedUnits: budget, idempotencyKey: releaseKey });
                if (released.status !== "released" || !amountIs(released.capturedUnits, 0) || !amountIs(released.releasedUnits, budget)) throw new Error("Gemini release conflict");
                return "released";
            }
            if (!verify || result.status !== "succeeded" || current.execution !== "succeeded" ||
                (current.delivery !== "saved" && current.delivery !== "visible")) return "pending_review";
            const count = await verify(tx, task, result, source);
            if (!validImageGenerationCount(count) || count !== result.consumedUnits) return "pending_review";
            const charge = count * source.creditsPerImage, refund = budget - charge;
            if (!Number.isSafeInteger(charge) || refund < 0) return "pending_review";
            if (neverCaptured) {
                if (!neverReleased || reservation.status !== "pending") return "pending_review";
            } else if (!amountIs(reservation.capturedUnits, charge) ||
                !(neverReleased && refund > 0 && reservation.status === "pending" || amountIs(reservation.releasedUnits, refund) && reservation.status === "captured")) return "pending_review";

            const captured = await wallet.capture({ ...reference, capturedUnits: charge, idempotencyKey: captureKey });
            if (!amountIs(captured.capturedUnits, charge)) throw new Error("Gemini capture conflict");
            const settled = refund > 0 ? await wallet.release({ ...reference, releasedUnits: refund, idempotencyKey: releaseKey }) : captured;
            if (settled.status !== "captured" || !amountIs(settled.capturedUnits, charge) || !amountIs(settled.releasedUnits, refund)) throw new Error("Gemini settlement conflict");
            return "captured";
        });
    } catch { return "pending_review"; }
}
