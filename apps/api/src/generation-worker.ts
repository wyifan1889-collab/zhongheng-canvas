import { isGenerationJobPayload, type GenerationJobPayload } from "@infinite-canvas/jobs";
import { and, eq } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import {
    createGenerationResultRepository,
    type GenerationMediaReference,
    type GenerationResultView,
} from "@infinite-canvas/database/generation-results";
import {
    createGenerationTaskRepository,
    type GenerationTaskView,
} from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { getImageSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { generationTask, type GenerationBillingStatus } from "@infinite-canvas/database/schema";
import { subtractCreditAmounts, compareCreditAmounts, evaluateTextCharge, parseTextQuoteSnapshot } from "@infinite-canvas/shared";
import { getTextTaskSettlementPolicy } from "../../../packages/database/src/model-price-publications";
import { resolveTextSettlement } from "../../../packages/shared/src/text-billing";
import { getAudioTaskSnapshot } from "./generation-audio-policy";
import { getVideoSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { parseVideoQuoteSnapshot } from "../../../packages/shared/src/generation-video";
import { settleGeminiImages } from "./generation-gemini-settlement";
import type { createGeminiImageDeliveryVerifier, createGenerationImageSpecMediaVerifier } from "./generation-delivery";

/**
 * A provider adapter must normalize its response before it reaches this
 * worker. Raw provider payloads and credentials are deliberately not accepted
 * by the persistence boundary.
 */
export type GenerationProviderResult =
    | {
        status: "succeeded";
        resultSnapshot: Record<string, unknown>;
        /** Provider meter units; settlement converts them with the task quote snapshot. */
        consumedUnits?: number;
        providerStatus?: number;
        providerTaskId?: string;
    }
    | {
        status: "failed";
        resultSnapshot?: Record<string, unknown>;
        errorCode: string;
        providerStatus?: number;
        providerTaskId?: string;
    }
    | {
        status: "unknown";
        resultSnapshot?: Record<string, unknown>;
        unknownReason: string;
        errorCode?: string;
        providerStatus?: number;
        providerTaskId?: string;
    };

export type GenerationDeliveryResult =
    | { status: "saved" | "visible"; media?: GenerationMediaReference; images?: GenerationMediaReference[]; resultSnapshot?: Record<string, unknown> }
    | { status: "failed"; errorCode?: string; media?: GenerationMediaReference; resultSnapshot?: Record<string, unknown> }
    | { status: "unknown"; unknownReason: string; media?: GenerationMediaReference; resultSnapshot?: Record<string, unknown> };

export type GenerationWorkerDependencies = {
    provider: (task: GenerationTaskView) => Promise<GenerationProviderResult>;
    processVideo?: (job: GenerationJobPayload) => Promise<GenerationWorkerResult | null>;
    /** How long a running task may be fresh before crash recovery can mark it unknown. */
    runningLeaseMs?: number;
    deliver?: (input: { task: GenerationTaskView; result: GenerationResultView }) => Promise<GenerationDeliveryResult>;
    settleBilling?: (input: {
        task: GenerationTaskView;
        result: GenerationResultView;
        delivery: GenerationDeliveryResult | null;
        videoClaimToken?: string;
    }) => Promise<GenerationBillingStatus | null>;
};

export type GenerationWorkerResult = {
    task: GenerationTaskView;
    result: GenerationResultView;
    delivery: GenerationDeliveryResult | null;
    replay: boolean;
};

export class GenerationWorkerError extends Error {
    constructor(public readonly code: "invalid_job" | "task_not_found" | "invalid_state", message: string) {
        super(message);
        this.name = "GenerationWorkerError";
    }
}

/** Convert provider meter units to wallet credits using the task's immutable quote snapshot. */
export function creditsForConsumedUnits(task: GenerationTaskView, consumedUnits: number): number | null {
    if (task.billingUnitSnapshot === null || task.creditsPerUnitSnapshot === null) return null;
    if (!Number.isSafeInteger(task.creditsPerUnitSnapshot) || task.creditsPerUnitSnapshot <= 0) return null;
    if (!Number.isSafeInteger(consumedUnits) || consumedUnits < 0) return null;
    const credits = consumedUnits * task.creditsPerUnitSnapshot;
    return Number.isSafeInteger(credits) ? credits : null;
}

export type GenerationWalletSettlementOptions = {
    /** Recheck the original image evidence against the owned, durable media bytes. */
    verifyImageSpecDelivery?: ReturnType<typeof createGenerationImageSpecMediaVerifier>;
    verifyGeminiImageDelivery?: ReturnType<typeof createGeminiImageDeliveryVerifier>;
    verifyAudioDelivery?: (input: { task: GenerationTaskView; result: GenerationResultView }) => Promise<boolean>;
    verifyVideoDelivery?: (input: { task: GenerationTaskView; result: GenerationResultView }) => Promise<boolean>;
    videoNow?: () => Date;
};

/**
 * Wallet settlement adapter for a real worker. It only captures usage after a
 * saved/visible result and explicit normalized usage, releases failed work,
 * and leaves every unknown or undelivered outcome in manual review.
 */
export function createGenerationWalletSettlement(db: Database, options: GenerationWalletSettlementOptions = {}): NonNullable<GenerationWorkerDependencies["settleBilling"]> {
    const wallet = createWalletRepository(db);
    return async ({ task, result, delivery, videoClaimToken }) => {
        if (task.billingStatus !== "reserved" && task.billingStatus !== "pending_review") return null;
        if (!task.reservationId) return "pending_review";
        if (task.billingUnitSnapshot === "image") {
            return settleGeminiImages(db, task, options.verifyGeminiImageDelivery);
        }
        const reservation = await wallet.getReservation(task.ownerId, task.reservationId);
        if (!reservation) return "pending_review";
        if (task.videoQuoteSnapshot != null || result.resultSnapshot.kind === "video") {
            try { return await db.transaction(async tx => {
            const wallet = createWalletRepository(tx), reservation = await wallet.getReservation(task.ownerId, task.reservationId!);
            const quote = parseVideoQuoteSnapshot(task.videoQuoteSnapshot), original = await getVideoSpecTaskSnapshot(tx, task);
            const stage = await createGenerationVideoStageRepository(tx).lock(task.ownerId, task.id);
            const leaseValid = () => !!stage && !!videoClaimToken && stage.claimToken === videoClaimToken && !!stage.leaseUntil && stage.leaseUntil > (options.videoNow?.() ?? new Date());
            if (!reservation || !leaseValid()) return "pending_review" as const;
            if (!quote || original.status !== "recorded" || !stage || result.ownerId !== task.ownerId || result.taskId !== task.id ||
                reservation.taskId !== task.id || stage.pricePublicationId !== quote.publicationId || task.quotedUnits !== quote.reservedCredits ||
                task.creditsPerUnitSnapshot !== original.creditsPerVideo || compareCreditAmounts(reservation.requestedUnits, String(quote.reservedCredits)) !== 0) return "pending_review";
            const credits = String(quote.reservedCredits);
            if (result.status === "failed") {
                const confirmedFailure = stage.phase === "failed" && !!stage.providerTaskId && stage.providerTaskId === task.providerTaskId && stage.providerTaskId === result.providerTaskId;
                const neverAuthorized = stage.phase === "rejected" && !stage.createAttemptToken && !stage.createStartedAt && !stage.providerTaskId && result.errorCode === "video_rejected_before_create";
                if ((!confirmedFailure && !neverAuthorized) || task.executionStatus !== "failed" || compareCreditAmounts(reservation.capturedUnits, "0") !== 0 ||
                    !["pending", "released"].includes(reservation.status) ||
                    (compareCreditAmounts(reservation.releasedUnits, "0") !== 0 && compareCreditAmounts(reservation.releasedUnits, credits) !== 0)) return "pending_review";
                    const released = await wallet.release({ userId: task.ownerId, reservationId: reservation.id, releasedUnits: credits,
                        idempotencyKey: `generation:${task.id}:release`, referenceType: "generation", referenceId: task.id });
                    if (!leaseValid()) throw new Error("Video release exceeded claim lease");
                    return released.status === "released" && compareCreditAmounts(released.releasedUnits, credits) === 0 && compareCreditAmounts(released.capturedUnits, "0") === 0 ? "released" : "pending_review";
            }
            if (result.status !== "succeeded" || task.executionStatus !== "succeeded" || stage.phase !== "completed" || result.consumedUnits !== 1 ||
                !["saved", "visible"].includes(task.deliveryStatus) || !["saved", "visible"].includes(delivery?.status ?? "") ||
                stage.providerTaskId !== task.providerTaskId || stage.providerTaskId !== result.providerTaskId ||
                compareCreditAmounts(reservation.releasedUnits, "0") !== 0 ||
                (compareCreditAmounts(reservation.capturedUnits, "0") === 0 ? reservation.status !== "pending" :
                    reservation.status !== "captured" || compareCreditAmounts(reservation.capturedUnits, credits) !== 0)) return "pending_review";
                if (!options.verifyVideoDelivery) return "pending_review";
                const remaining = stage.leaseUntil!.getTime() - (options.videoNow?.() ?? new Date()).getTime();
                if (remaining <= 0) return "pending_review";
                let timer: ReturnType<typeof setTimeout> | undefined;
                let verified: boolean;
                try { verified = await Promise.race([options.verifyVideoDelivery({ task, result }), new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Video settlement proof exceeded claim lease")), Math.min(remaining, 0x7fffffff));
                })]); } finally { if (timer) clearTimeout(timer); }
                if (!verified) return "pending_review";
                if (!leaseValid()) return "pending_review";
                const captured = await wallet.capture({ userId: task.ownerId, reservationId: reservation.id, capturedUnits: credits,
                    idempotencyKey: `generation:${task.id}:capture`, referenceType: "generation", referenceId: task.id });
                if (!leaseValid()) throw new Error("Video capture exceeded claim lease");
                return captured.status === "captured" && compareCreditAmounts(captured.capturedUnits, credits) === 0 && compareCreditAmounts(captured.releasedUnits, "0") === 0 ? "captured" : "pending_review";
            }); } catch { return "pending_review"; }
        }
        const audio = await getAudioTaskSnapshot(db, task);
        if (audio?.status === "invalid") return "pending_review";
        if (audio?.status === "recorded") {
            const credits = String(task.quotedUnits);
            if (result.ownerId !== task.ownerId || result.taskId !== task.id || reservation.taskId !== task.id ||
                compareCreditAmounts(reservation.requestedUnits, credits) !== 0) return "pending_review";
            if (result.status === "failed") {
                if (compareCreditAmounts(reservation.capturedUnits, "0") !== 0 ||
                    !["pending", "released"].includes(reservation.status) ||
                    (compareCreditAmounts(reservation.releasedUnits, "0") !== 0 && compareCreditAmounts(reservation.releasedUnits, credits) !== 0)) return "pending_review";
                try {
                    const released = await wallet.release({ userId: task.ownerId, reservationId: reservation.id,
                        releasedUnits: credits, idempotencyKey: `generation:${task.id}:release`, referenceType: "generation", referenceId: task.id });
                    return released.status === "released" && compareCreditAmounts(released.capturedUnits, "0") === 0 &&
                        compareCreditAmounts(released.releasedUnits, credits) === 0 ? "released" : "pending_review";
                } catch { return "pending_review"; }
            }
            const policy = result.resultSnapshot.billingPolicy as Record<string, unknown> | undefined;
            if (result.status !== "succeeded" || result.resultSnapshot.kind !== "audio" || result.consumedUnits !== 1 ||
                policy?.source !== "platform_successful_request" || policy.unit !== "request" ||
                !["saved", "visible"].includes(task.deliveryStatus) || !["saved", "visible"].includes(delivery?.status ?? "") ||
                compareCreditAmounts(reservation.releasedUnits, "0") !== 0 ||
                (compareCreditAmounts(reservation.capturedUnits, "0") === 0 ? reservation.status !== "pending"
                    : compareCreditAmounts(reservation.capturedUnits, credits) !== 0 || reservation.status !== "captured")) return "pending_review";
            try {
                if (!options.verifyAudioDelivery || !await options.verifyAudioDelivery({ task, result })) return "pending_review";
                const captured = await wallet.capture({ userId: task.ownerId, reservationId: reservation.id,
                    capturedUnits: credits, idempotencyKey: `generation:${task.id}:capture`, referenceType: "generation", referenceId: task.id });
                return captured.status === "captured" && compareCreditAmounts(captured.capturedUnits, credits) === 0 &&
                    compareCreditAmounts(captured.releasedUnits, "0") === 0 ? "captured" : "pending_review";
            } catch { return "pending_review"; }
        }
        const imageSpec = await getImageSpecTaskSnapshot(db, task);
        if (imageSpec.status === "invalid" || imageSpec.status === "gemini") return "pending_review";
        if (imageSpec.status === "recorded") {
            const credits = String(imageSpec.creditsPerRequest * (imageSpec.parameters.n ?? 1));
            if (result.ownerId !== task.ownerId || result.taskId !== task.id || task.billingUnitSnapshot !== "request" ||
                task.creditsPerUnitSnapshot !== imageSpec.creditsPerRequest || task.quotedUnits !== Number(credits)) return "pending_review";
            try {
                return await db.transaction(async tx => {
                    // Lock order matches batch delivery: task first, then the media set.
                    const [current] = await tx.select({ execution: generationTask.executionStatus, delivery: generationTask.deliveryStatus,
                        billing: generationTask.billingStatus, reservationId: generationTask.reservationId }).from(generationTask)
                        .where(and(eq(generationTask.id, task.id), eq(generationTask.ownerId, task.ownerId))).for("update");
                    if (!current?.reservationId || current.reservationId !== task.reservationId) return "pending_review";
                    if (current.billing === "captured" || current.billing === "released") return current.billing;
                    if (current.billing !== "reserved" && current.billing !== "pending_review") return "pending_review";
                    const original = await createGenerationResultRepository(tx).get(task.ownerId, task.id);
                    const wallet = createWalletRepository(tx), reservation = await wallet.getReservation(task.ownerId, current.reservationId);
                    if (original?.id !== result.id || !reservation || reservation.taskId !== task.id ||
                        compareCreditAmounts(reservation.requestedUnits, credits) !== 0) return "pending_review";
                    const reference = { userId: task.ownerId, reservationId: reservation.id, referenceType: "generation", referenceId: task.id };
                    const neverCaptured = compareCreditAmounts(reservation.capturedUnits, "0") === 0;
                    const neverReleased = compareCreditAmounts(reservation.releasedUnits, "0") === 0;
                    let status: "released" | "captured";
                    if (original.status === "failed" && current.execution === "failed" && current.delivery === "failed") {
                        if (!neverCaptured || !(neverReleased && reservation.status === "pending" ||
                            compareCreditAmounts(reservation.releasedUnits, credits) === 0 && reservation.status === "released")) return "pending_review";
                        const released = await wallet.release({ ...reference, releasedUnits: credits, idempotencyKey: `generation:${task.id}:release` });
                        if (released.status !== "released" || compareCreditAmounts(released.capturedUnits, "0") !== 0 ||
                            compareCreditAmounts(released.releasedUnits, credits) !== 0) throw new Error("Image release conflict");
                        status = "released";
                    } else {
                        if (original.status !== "succeeded" || current.execution !== "succeeded" ||
                            (delivery?.status !== "saved" && delivery?.status !== "visible") || (current.delivery !== "saved" && current.delivery !== "visible") ||
                            !neverReleased || (neverCaptured ? reservation.status !== "pending" :
                                compareCreditAmounts(reservation.capturedUnits, credits) !== 0 || reservation.status !== "captured")) return "pending_review";
                        if (!options.verifyImageSpecDelivery || !await options.verifyImageSpecDelivery(tx, { task, result: original })) return "pending_review";
                        const captured = await wallet.capture({ ...reference, capturedUnits: credits, idempotencyKey: `generation:${task.id}:capture` });
                        if (captured.status !== "captured" || compareCreditAmounts(captured.capturedUnits, credits) !== 0 ||
                            compareCreditAmounts(captured.releasedUnits, "0") !== 0) throw new Error("Image capture conflict");
                        status = "captured";
                    }
                    await tx.update(generationTask).set({ billingStatus: status, updatedAt: new Date() }).where(eq(generationTask.id, task.id));
                    return status;
                });
            } catch {
                return "pending_review";
            }
        }
        if (reservation.status === "captured") return "captured";
        if (reservation.status === "released") return "released";
        if (reservation.status !== "pending") return "pending_review";

        if (result.status === "failed") {
            await wallet.release({
                userId: task.ownerId,
                reservationId: reservation.id,
                idempotencyKey: `generation:${task.id}:release`,
                referenceType: "generation",
                referenceId: task.id,
            });
            return "released";
        }
        if (result.status !== "succeeded" || (delivery?.status !== "saved" && delivery?.status !== "visible")) {
            return "pending_review";
        }
        const consumedUnits = result.consumedUnits;
        const remaining = subtractCreditAmounts(subtractCreditAmounts(reservation.requestedUnits, reservation.capturedUnits), reservation.releasedUnits);
        const textQuote = task.textQuoteSnapshot == null ? null : parseTextQuoteSnapshot(task.textQuoteSnapshot);
        if (task.textQuoteSnapshot != null && (!textQuote || compareCreditAmounts(textQuote.budgetCredits, reservation.requestedUnits) !== 0)) return "pending_review";
        const consumedCredits = textQuote ? resolveTextSettlement(textQuote, result.resultSnapshot.usageEvidence, await getTextTaskSettlementPolicy(db, task))?.expectedCredits ?? null
            : consumedUnits === null ? null : creditsForConsumedUnits(task, consumedUnits);
        if (consumedCredits === null) return "pending_review";
        const alreadyCaptured = compareCreditAmounts(reservation.capturedUnits, "0") > 0;
        // A crash may leave capture committed and the unused reservation pending.
        // Resume that release only when the saved capture equals this same result.
        if (alreadyCaptured ? compareCreditAmounts(reservation.capturedUnits, String(consumedCredits)) !== 0
            : compareCreditAmounts(String(consumedCredits), remaining) > 0) return "pending_review";
        if (compareCreditAmounts(String(consumedCredits), "0") > 0 && !alreadyCaptured) {
            await wallet.capture({
                userId: task.ownerId,
                reservationId: reservation.id,
                capturedUnits: consumedCredits,
                idempotencyKey: `generation:${task.id}:capture`,
                referenceType: "generation",
                referenceId: task.id,
            });
        }
        const afterCapture = await wallet.getReservation(task.ownerId, reservation.id);
        if (!afterCapture) return "pending_review";
        const unused = subtractCreditAmounts(subtractCreditAmounts(afterCapture.requestedUnits, afterCapture.capturedUnits), afterCapture.releasedUnits);
        if (compareCreditAmounts(unused, "0") > 0) {
            await wallet.release({
                userId: task.ownerId,
                reservationId: reservation.id,
                releasedUnits: unused,
                idempotencyKey: `generation:${task.id}:release`,
                referenceType: "generation",
                referenceId: task.id,
            });
        }
        return compareCreditAmounts(String(consumedCredits), "0") > 0 ? "captured" : "released";
    };
}

function emptySnapshot() {
    return {} as Record<string, unknown>;
}

function usesImageBatchDelivery(task: GenerationTaskView, result: GenerationResultView) {
    const snapshot = result.resultSnapshot;
    return task.billingUnitSnapshot === "image" || snapshot.kind === "image" && snapshot.imageSpecEvidence !== undefined &&
        Array.isArray(snapshot.images) && snapshot.images.length > 1;
}

async function attachDeliveryMedia(
    results: ReturnType<typeof createGenerationResultRepository>,
    task: GenerationTaskView,
    result: GenerationResultView,
    delivery: GenerationDeliveryResult,
): Promise<{ result: GenerationResultView; delivery: GenerationDeliveryResult }> {
    if (usesImageBatchDelivery(task, result) && (delivery.status === "saved" || delivery.status === "visible")) {
        // The batch transaction already committed the references and the usage count.
        const stored = await results.get(task.ownerId, task.id);
        if (stored?.id === result.id && stored.consumedUnits && stored.resultSnapshot.media) return { result: stored, delivery };
        return { result, delivery: { status: "unknown", unknownReason: "delivery_reference_persistence_unknown" } };
    }
    if (!delivery.media || (delivery.status !== "saved" && delivery.status !== "visible")) return { result, delivery };
    try {
        return {
            result: await results.attachMedia({ ownerId: task.ownerId, taskId: task.id, media: delivery.media,
                ...(delivery.status === "saved" || delivery.status === "visible" ? { images: delivery.images } : {}),
                ...(result.resultSnapshot.kind === "audio" ? { audioRequestDelivered: true as const } : {}) }),
            delivery,
        };
    } catch {
        return { result, delivery: { status: "unknown", unknownReason: "delivery_reference_persistence_unknown" } };
    }
}

async function settleBilling(
    db: Database,
    tasks: ReturnType<typeof createGenerationTaskRepository>,
    task: GenerationTaskView,
    result: GenerationResultView,
    delivery: GenerationDeliveryResult | null,
    callback: GenerationWorkerDependencies["settleBilling"],
) {
    // Without the wallet adapter, keep a reservation pending rather than
    // claiming that credits were released or captured in task state only.
    const next = callback
        ? await callback({ task, result, delivery })
        : task.billingStatus === "reserved" ? "pending_review" as const : null;
    if (!next || next === task.billingStatus) return task;
    if (usesImageBatchDelivery(task, result) && next === "pending_review") {
        // A duplicate worker may have finished after this callback observed incomplete evidence.
        await db.update(generationTask).set({ billingStatus: next, updatedAt: new Date() }).where(and(
            eq(generationTask.id, task.id), eq(generationTask.ownerId, task.ownerId), eq(generationTask.billingStatus, "reserved")));
        return await tasks.get(task.ownerId, task.id) ?? task;
    }
    return tasks.transitionBilling({ ownerId: task.ownerId, taskId: task.id, status: next });
}

async function readImageBatchDeliveryState(db: Database, tasks: ReturnType<typeof createGenerationTaskRepository>, task: GenerationTaskView, delivery: GenerationDeliveryResult) {
    // On success the gallery transaction set visible. A failed replay cannot downgrade that commit.
    if (delivery.status !== "visible") await db.update(generationTask).set({ deliveryStatus: "unknown", updatedAt: new Date() })
        .where(and(eq(generationTask.id, task.id), eq(generationTask.ownerId, task.ownerId), eq(generationTask.deliveryStatus, "pending")));
    return await tasks.get(task.ownerId, task.id) ?? task;
}

/**
 * Process one generation message without opening a provider connection. The
 * caller injects the normalized provider and delivery adapters, which makes
 * this seam safe to test before a real worker is enabled in staging.
 */
export async function processGenerationJob(
    db: Database,
    payload: GenerationJobPayload,
    dependencies: GenerationWorkerDependencies,
): Promise<GenerationWorkerResult> {
    if (!isGenerationJobPayload(payload)) throw new GenerationWorkerError("invalid_job", "生成任务消息无效");
    const tasks = createGenerationTaskRepository(db);
    const results = createGenerationResultRepository(db);
    const task = await tasks.get(payload.ownerId, payload.taskId);
    if (task?.videoQuoteSnapshot != null) throw new GenerationWorkerError("invalid_state", "视频任务只能由持久阶段驱动处理");
    if (!task) throw new GenerationWorkerError("task_not_found", "生成任务不存在");
    if (task.requestId !== payload.requestId) throw new GenerationWorkerError("invalid_job", "生成任务请求 ID 不匹配");

    const existing = await results.get(task.ownerId, task.id);
    if (existing) {
        const imageSpec = existing.status === "succeeded" ? await getImageSpecTaskSnapshot(db, task) : null;
        const reverifyImageSpec = imageSpec !== null && imageSpec.status !== "legacy";
        const reverifyLegacyImage = imageSpec?.status === "legacy" && existing.resultSnapshot.kind === "image" &&
            (task.billingStatus === "reserved" || task.billingStatus === "pending_review") &&
            (task.deliveryStatus === "saved" || task.deliveryStatus === "visible");
        let reconciled = task;
        if (task.executionStatus === "running") {
            reconciled = await tasks.transitionExecution({
                ownerId: task.ownerId,
                taskId: task.id,
                status: existing.status,
                providerTaskId: existing.providerTaskId ?? undefined,
                unknownReason: existing.status === "unknown" ? existing.unknownReason ?? undefined : undefined,
            });
        }
        let replayResult = existing;
        let delivery: GenerationDeliveryResult | null = existing.status === "failed"
            ? { status: "failed" as const, errorCode: existing.errorCode ?? undefined }
            : existing.status === "unknown"
                ? { status: "unknown" as const, unknownReason: existing.unknownReason ?? "result_requires_review" }
                : reverifyImageSpec || reverifyLegacyImage ? null
                : reconciled.deliveryStatus === "visible"
                    ? { status: "visible" as const }
                    : reconciled.deliveryStatus === "saved"
                        ? { status: "saved" as const }
                        : null;
        if (existing.status === "succeeded" && (reverifyImageSpec || reverifyLegacyImage || reconciled.deliveryStatus === "pending")) {
            if (reverifyImageSpec && (existing.resultSnapshot.kind !== "image" || imageSpec?.status !== "gemini" && existing.consumedUnits !== 1)) {
                delivery = { status: "unknown", unknownReason: "image_spec_evidence_conflicting" };
            } else if (dependencies.deliver) {
                try {
                    delivery = await dependencies.deliver({ task: reconciled, result: existing });
                } catch {
                    delivery = { status: "unknown", unknownReason: "delivery_adapter_exception" };
                }
            } else if (reverifyImageSpec || reverifyLegacyImage) delivery = { status: "unknown", unknownReason: "delivery_adapter_not_configured" };
        }
        if (delivery) {
            const attached = await attachDeliveryMedia(results, reconciled, replayResult, delivery);
            replayResult = attached.result;
            delivery = attached.delivery;
        }
        // Reverification may report unknown for an already saved/visible asset. Preserve
        // terminal delivery history and put its unsettled reservation into review below.
        if (delivery && usesImageBatchDelivery(reconciled, replayResult)) {
            reconciled = await readImageBatchDeliveryState(db, tasks, reconciled, delivery);
        } else if (delivery && (reconciled.deliveryStatus === "pending" || reverifyImageSpec && reconciled.deliveryStatus === "unknown")) {
            if (delivery.status === "visible") {
                reconciled = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: "saved" });
                reconciled = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: "visible" });
            } else {
                reconciled = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: delivery.status });
            }
        }
        reconciled = await settleBilling(db, tasks, reconciled, replayResult, delivery, dependencies.settleBilling);
        return { task: reconciled, result: replayResult, delivery, replay: true };
    }
    if (task.executionStatus === "running") {
        const runningLeaseMs = dependencies.runningLeaseMs ?? 60_000;
        if (!Number.isSafeInteger(runningLeaseMs) || runningLeaseMs < 0) {
            throw new GenerationWorkerError("invalid_job", "worker 运行租约无效");
        }
        if (Date.now() - new Date(task.updatedAt).getTime() < runningLeaseMs) {
            throw new GenerationWorkerError("invalid_state", "生成任务正在其他 worker 中执行");
        }
        // A process may have exited after the provider call started but before
        // the normalized result committed. Never call the provider again: mark
        // the outcome unknown and leave billing for reconciliation.
        const unknownReason = "worker_replayed_after_running";
        const stored = await results.create({
            taskId: task.id,
            ownerId: task.ownerId,
            status: "unknown",
            resultSnapshot: emptySnapshot(),
            errorCode: "worker_recovery_required",
            unknownReason,
        });
        let recovered = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id, status: "unknown", unknownReason });
        const delivery: GenerationDeliveryResult = { status: "unknown", unknownReason };
        recovered = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: "unknown" });
        recovered = await settleBilling(db, tasks, recovered, stored.result, delivery, dependencies.settleBilling);
        return { task: recovered, result: stored.result, delivery, replay: true };
    }
    if (task.executionStatus !== "queued") {
        throw new GenerationWorkerError("invalid_state", `生成任务不能从 ${task.executionStatus} 开始执行`);
    }

    let running = await tasks.claimRunning({ ownerId: task.ownerId, taskId: task.id });
    if (!running) throw new GenerationWorkerError("invalid_state", "生成任务已被其他 worker 领取");
    let providerResult: GenerationProviderResult;
    try {
        providerResult = await dependencies.provider(running);
    } catch {
        providerResult = { status: "unknown", unknownReason: "worker_provider_exception", resultSnapshot: emptySnapshot() };
    }
    if (providerResult.status === "succeeded" && (running.billingUnitSnapshot === "image"
        ? providerResult.resultSnapshot.kind !== "image" || !providerResult.resultSnapshot.geminiBatch || providerResult.consumedUnits !== undefined
        : (providerResult.resultSnapshot.kind !== "image" || providerResult.consumedUnits !== 1) &&
            (await getImageSpecTaskSnapshot(db, running)).status !== "legacy")) {
        providerResult = { status: "unknown", unknownReason: "image_spec_evidence_conflicting",
            resultSnapshot: providerResult.resultSnapshot, providerStatus: providerResult.providerStatus, providerTaskId: providerResult.providerTaskId };
    }

    const stored = await results.create({
        taskId: running.id,
        ownerId: running.ownerId,
        status: providerResult.status,
        providerStatus: providerResult.providerStatus,
        providerTaskId: providerResult.providerTaskId,
        consumedUnits: providerResult.status === "succeeded" ? providerResult.consumedUnits : undefined,
        resultSnapshot: providerResult.resultSnapshot ?? emptySnapshot(),
        errorCode: providerResult.status === "failed" ? providerResult.errorCode : providerResult.status === "unknown" ? providerResult.errorCode : undefined,
        unknownReason: providerResult.status === "unknown" ? providerResult.unknownReason : undefined,
    });
    let result = stored.result;
    running = await tasks.transitionExecution({
        ownerId: running.ownerId,
        taskId: running.id,
        status: providerResult.status,
        providerTaskId: providerResult.providerTaskId,
        unknownReason: providerResult.status === "unknown" ? providerResult.unknownReason : undefined,
    });

    let delivery: GenerationDeliveryResult | null = null;
    if (providerResult.status === "succeeded") {
        if (dependencies.deliver) {
            try {
                delivery = await dependencies.deliver({ task: running, result });
            } catch {
                delivery = { status: "unknown", unknownReason: "delivery_adapter_exception" };
            }
        } else {
            delivery = { status: "unknown", unknownReason: "delivery_adapter_not_configured" };
        }
        const attached = await attachDeliveryMedia(results, running, result, delivery);
        result = attached.result;
        delivery = attached.delivery;
        if (usesImageBatchDelivery(running, result)) {
            running = await readImageBatchDeliveryState(db, tasks, running, delivery);
        } else if (delivery.status === "saved") {
            running = await tasks.transitionDelivery({ ownerId: running.ownerId, taskId: running.id, status: "saved" });
        } else if (delivery.status === "visible") {
            await tasks.transitionDelivery({ ownerId: running.ownerId, taskId: running.id, status: "saved" });
            running = await tasks.transitionDelivery({ ownerId: running.ownerId, taskId: running.id, status: "visible" });
        } else if (delivery.status === "failed") {
            running = await tasks.transitionDelivery({ ownerId: running.ownerId, taskId: running.id, status: "failed" });
        } else {
            running = await tasks.transitionDelivery({ ownerId: running.ownerId, taskId: running.id, status: "unknown" });
        }
    } else if (providerResult.status === "failed") {
        delivery = { status: "failed", errorCode: providerResult.errorCode };
        running = await tasks.transitionDelivery({ ownerId: running.ownerId, taskId: running.id, status: "failed" });
    } else {
        delivery = { status: "unknown", unknownReason: providerResult.unknownReason };
        running = await tasks.transitionDelivery({ ownerId: running.ownerId, taskId: running.id, status: "unknown" });
    }

    running = await settleBilling(db, tasks, running, result, delivery, dependencies.settleBilling);
    return { task: running, result, delivery, replay: false };
}
