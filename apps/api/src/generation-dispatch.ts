import { and, eq, sql } from "drizzle-orm";
import { createGenerationJobPayload, fromDrizzle, GENERATION_QUEUE_NAME, type GenerationJobPayload } from "@infinite-canvas/jobs";
import { createGenerationTaskRepository, GenerationTaskError, type CreateGenerationTaskInput, type GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository, type WalletReservationView } from "@infinite-canvas/database/wallet";
import type { Database } from "@infinite-canvas/database";
import { generationTask, type ScalarBillingUnit, type TaskBillingUnit } from "@infinite-canvas/database/schema";
import { resolveActiveGenerationPricing } from "@infinite-canvas/database/pricing";
import { getImageSpecTaskSnapshot, type GeminiTaskSource } from "@infinite-canvas/database/model-price-publications";
import { OPENAI_IMAGE_PROTOCOL, canonicalImageSpecTaskParameters, compareCreditAmounts, imageSpecParametersFromTask, parseImageGenerationParameters, type ImageSpecification } from "@infinite-canvas/shared";
import { GenerationContractError } from "./generation-contract";
import { assertGenerationImageIntent, resolveExecutableImageQuote } from "./generation-image-policy";
import { geminiQuoteFingerprint, imageQuoteFingerprint } from "./generation-image-quote";
import { assertGenerationSubmissionActor, recordConfirmedGenerationRequest, runConfirmedGenerationAdmission, type GenerationSubmissionSafety } from "./generation-admission";

export type GenerationQueueSender = {
    send(name: string, payload: GenerationJobPayload, options?: { db?: ReturnType<typeof fromDrizzle>; startAfter?: Date }): Promise<string | null | undefined>;
};

export type GenerationDispatchResult = {
    task: GenerationTaskView;
    created: boolean;
    jobId: string | null;
};

export type GenerationQuote = {
    modelId: string;
    priceVersion: number;
    quotedUnits: number;
    billingUnit: TaskBillingUnit;
    gemini?: GeminiTaskSource;
    creditsPerUnit: number;
    /** Separately approved public text; never the administrator's private draft note. */
    priceNote?: string;
    imageSpec?: ImageSpecification & { maxImagesPerRequest?: number };
    quoteFingerprint?: string;
    /** Server-only source identity. It must never be spread into the public quote. */
    pricePublicationId?: string;
};

export type ServerGenerationQuoteInput = {
    modelId: string;
    inputSnapshot: Record<string, unknown>;
    parameterSnapshot: Record<string, unknown>;
    priceVersion?: number;
    now?: Date;
};

export type ReservedGenerationDispatchResult = GenerationDispatchResult & {
    reservation: WalletReservationView;
};

function assertQuote(quote: GenerationQuote) {
    if (!quote.modelId.trim() || quote.modelId.length > 200) throw new Error("模型 ID 无效");
    if (!Number.isSafeInteger(quote.priceVersion) || quote.priceVersion <= 0) throw new Error("价格版本无效");
    if (!Number.isSafeInteger(quote.quotedUnits) || quote.quotedUnits <= 0) throw new Error("生成报价必须是正整数");
    if (quote.gemini) {
        if (quote.imageSpec || quote.billingUnit !== "image" || quote.creditsPerUnit !== quote.gemini.creditsPerImage ||
            quote.quotedUnits !== quote.gemini.parameters.budgetCredits || quote.quotedUnits < quote.creditsPerUnit || !/^[0-9a-f]{64}$/.test(quote.quoteFingerprint ?? ""))
            throw new Error("Gemini 按张报价快照不完整");
        return;
    }
    if (!["request", "input_token", "output_token", "second", "megapixel"].includes(quote.billingUnit)) throw new Error("计量单位无效");
    if (!Number.isSafeInteger(quote.creditsPerUnit) || quote.creditsPerUnit <= 0) throw new Error("单位价格必须是正整数");
    if (quote.imageSpec && (quote.imageSpec.protocol !== OPENAI_IMAGE_PROTOCOL || !parseImageGenerationParameters(quote.imageSpec.parameters) || quote.billingUnit !== "request" ||
        quote.quotedUnits !== quote.creditsPerUnit * (quote.imageSpec.parameters.n ?? 1) || !quote.pricePublicationId ||
        !/^[0-9a-f]{64}$/.test(quote.quoteFingerprint ?? ""))) throw new Error("图片规格报价快照不完整");
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
        throw new Error(`${label}必须是 1-${maximum} 的整数`);
    }
    return value as number;
}

/**
 * Calculate a metered-unit upper bound from server-validated task parameters.
 * This is deliberately conservative: an input-token price is rejected until
 * the platform has a server-side tokenizer, so a client cannot self-report
 * cheap usage and reserve too few credits.
 */
export function computeServerGenerationQuotedUnits(
    billingUnit: ScalarBillingUnit,
    parameterSnapshot: Record<string, unknown>,
): number {
    switch (billingUnit) {
        case "request":
            return 1;
        case "output_token": {
            const maxTokens = [parameterSnapshot.max_tokens, parameterSnapshot.max_completion_tokens]
                .filter((value) => value !== undefined);
            if (maxTokens.length !== 1) throw new Error("输出 token 报价需要唯一的最大输出 token 参数");
            return positiveInteger(maxTokens[0], "最大输出 token", 100_000);
        }
        case "second":
            return positiveInteger(parameterSnapshot.durationSeconds ?? parameterSnapshot.duration_seconds, "时长", 86_400);
        case "megapixel": {
            const width = positiveInteger(parameterSnapshot.width, "宽度", 16_384);
            const height = positiveInteger(parameterSnapshot.height, "高度", 16_384);
            const pixels = width * height;
            if (!Number.isSafeInteger(pixels)) throw new Error("像素总量溢出");
            return Math.max(1, Math.ceil(pixels / 1_000_000));
        }
        case "input_token":
            throw new Error("输入 token 报价尚未配置服务端 tokenizer");
        default:
            throw new Error("计量单位不受支持");
    }
}

/** Build a quote from the server-side active price projection. */
export async function resolveGenerationQuote(
    db: Database,
    input: { modelId: string; quotedUnits: number; priceVersion?: number; now?: Date },
): Promise<GenerationQuote> {
    if (!Number.isSafeInteger(input.quotedUnits) || input.quotedUnits <= 0) throw new Error("生成报价必须是正整数");
    const pricing = await resolveActiveGenerationPricing(db, input);
    if (!pricing) throw new Error("模型价格不可用");
    return { ...pricing, quotedUnits: input.quotedUnits };
}

/** Build a quote without accepting a client-supplied total or unit count. */
export async function resolveServerGenerationQuote(
    db: Database,
    input: ServerGenerationQuoteInput,
): Promise<GenerationQuote> {
    if (!input.inputSnapshot || Array.isArray(input.inputSnapshot) || typeof input.inputSnapshot !== "object") {
        throw new Error("生成输入快照必须是对象");
    }
    if (!input.parameterSnapshot || Array.isArray(input.parameterSnapshot) || typeof input.parameterSnapshot !== "object") {
        throw new Error("生成参数快照必须是对象");
    }
    const pricing = await resolveActiveGenerationPricing(db, input);
    if (!pricing) throw new Error("模型价格不可用");
    const quotedUnits = computeServerGenerationQuotedUnits(pricing.billingUnit, input.parameterSnapshot) * pricing.creditsPerUnit;
    if (!Number.isSafeInteger(quotedUnits) || quotedUnits <= 0) throw new Error("生成报价积分溢出");
    return { ...pricing, quotedUnits };
}

/**
 * Server-only dispatch seam for a future public route. The caller supplies
 * task intent, never a total quote; pricing is resolved from that intent and
 * revalidated inside the reservation transaction before enqueueing.
 */
export async function quoteReserveAndEnqueueServerGenerationTask(
    db: Database,
    queue: GenerationQueueSender,
    input: Omit<CreateGenerationTaskInput, "priceVersion" | "quotedUnits" | "billingUnitSnapshot" | "creditsPerUnitSnapshot">,
    options: { priceVersion?: number; now?: Date } = {},
): Promise<ReservedGenerationDispatchResult> {
    const quote = await resolveServerGenerationQuote(db, {
        modelId: input.modelId,
        inputSnapshot: input.inputSnapshot,
        parameterSnapshot: input.parameterSnapshot,
        priceVersion: options.priceVersion,
        now: options.now,
    });
    return quoteReserveAndEnqueueGenerationTask(db, queue, input, quote);
}

/** Public image submissions bind the displayed version; an accepted replay keeps its original quote. */
export async function quoteReserveAndEnqueueConfirmedImageTask(
    db: Database,
    queue: GenerationQueueSender,
    input: Omit<CreateGenerationTaskInput, "priceVersion" | "quotedUnits" | "billingUnitSnapshot" | "creditsPerUnitSnapshot">,
    confirmedPriceVersion: number,
    confirmedQuoteFingerprint?: string,
    options: { admission?: GenerationSubmissionSafety } = {},
): Promise<ReservedGenerationDispatchResult> {
    if (!Number.isSafeInteger(confirmedPriceVersion) || confirmedPriceVersion <= 0) {
        throw new GenerationContractError("invalid_input", "请先确认有效的价格版本");
    }
    assertGenerationImageIntent(input);
    if (options.admission) {
        const [existing] = await db.select({ id: generationTask.id }).from(generationTask).where(and(eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey))).limit(1);
        if (!existing) {
            const checked = await resolveExecutableImageQuote(db, input, false, input.ownerId);
            if (checked.priceVersion !== confirmedPriceVersion || (checked.imageSpec || checked.gemini) && checked.quoteFingerprint !== confirmedQuoteFingerprint) throw new GenerationContractError("price_changed", "图片规格或报价已变化，请重新确认");
            await recordConfirmedGenerationRequest(db, options.admission, { ...input, modelId: checked.modelId, capability: "image" });
        }
    }
    return db.transaction(async (tx) => {
        await assertGenerationSubmissionActor(tx, options.admission, { ...input, capability: "image" });
        const [existing] = await tx.select().from(generationTask).where(and(
            eq(generationTask.ownerId, input.ownerId), eq(generationTask.idempotencyKey, input.idempotencyKey),
        )).limit(1);
        if (existing) {
            if (existing.modelId !== input.modelId || existing.priceVersion !== confirmedPriceVersion || existing.quotedUnits === null ||
                (existing.billingUnitSnapshot !== "request" && existing.billingUnitSnapshot !== "image") || existing.creditsPerUnitSnapshot === null) {
                throw new GenerationTaskError("idempotency_conflict", "该幂等键已用于其他生成请求");
            }
            const specification = await getImageSpecTaskSnapshot(tx, existing);
            if (specification.status === "invalid") throw new GenerationTaskError("idempotency_conflict", "原图片规格来源无效，不能重放");
            if (specification.status === "gemini") {
                const fingerprint = geminiQuoteFingerprint(existing.ownerId, input, existing.priceVersion, specification);
                if (fingerprint !== confirmedQuoteFingerprint) throw new GenerationTaskError("idempotency_conflict", "原任务的预算、规格或报价确认不匹配");
                return quoteReserveAndEnqueueGenerationTask(tx, queue, input, { modelId: existing.modelId, priceVersion: existing.priceVersion,
                    billingUnit: "image", creditsPerUnit: specification.creditsPerImage, quotedUnits: existing.quotedUnits, gemini: specification,
                    quoteFingerprint: fingerprint }, { ...options, capability: "image" });
            }
            if (specification.status === "recorded") {
                const selected = parseImageGenerationParameters(input.parameterSnapshot);
                const originalFingerprint = imageQuoteFingerprint(existing.ownerId, {
                    modelId: existing.modelId, inputSnapshot: existing.inputSnapshot, parameterSnapshot: existing.parameterSnapshot,
                    ...(existing.spaceId === null ? {} : { spaceId: existing.spaceId }),
                    ...(existing.projectId === null ? {} : { projectId: existing.projectId }),
                    ...(existing.nodeId === null ? {} : { nodeId: existing.nodeId }),
                }, { pricePublicationId: specification.publicationId, priceVersion: existing.priceVersion,
                    creditsPerUnit: existing.creditsPerUnitSnapshot, quotedUnits: existing.quotedUnits });
                if (!selected || selected.size !== specification.parameters.size || selected.quality !== specification.parameters.quality ||
                    (selected.n ?? 1) !== (specification.parameters.n ?? 1) ||
                    originalFingerprint !== confirmedQuoteFingerprint) {
                    throw new GenerationTaskError("idempotency_conflict", "幂等键的原图片报价确认不匹配");
                }
                return quoteReserveAndEnqueueGenerationTask(tx, queue, { ...input,
                    parameterSnapshot: existing.parameterSnapshot }, {
                    modelId: existing.modelId, priceVersion: existing.priceVersion, quotedUnits: existing.quotedUnits,
                    billingUnit: "request", creditsPerUnit: existing.creditsPerUnitSnapshot,
                    imageSpec: { protocol: specification.protocol, parameters: specification.parameters, ...(specification.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: specification.maxImagesPerRequest }),
                        ...(specification.responseFormat === undefined ? {} : { responseFormat: specification.responseFormat }) }, quoteFingerprint: originalFingerprint,
                    pricePublicationId: specification.publicationId,
                }, { ...options, capability: "image" });
            }
            // Repository intent comparison includes model, parameters, project and the immutable quote.
            return quoteReserveAndEnqueueGenerationTask(tx, queue, input, {
                modelId: existing.modelId, priceVersion: existing.priceVersion,
                quotedUnits: existing.quotedUnits, billingUnit: existing.billingUnitSnapshot,
                creditsPerUnit: existing.creditsPerUnitSnapshot,
            }, { ...options, capability: "image" });
        }
        const quote = await resolveExecutableImageQuote(tx, input, true, input.ownerId);
        if (quote.priceVersion !== confirmedPriceVersion) {
            throw new GenerationContractError("price_changed", "模型价格已变化，请重新查看并确认费用");
        }
        if (quote.gemini) {
            if (!confirmedQuoteFingerprint || confirmedQuoteFingerprint !== quote.quoteFingerprint)
                throw new GenerationContractError("price_changed", "图片规格、预算或报价已变化，请重新确认");
            return quoteReserveAndEnqueueGenerationTask(tx, queue, input, quote, { ...options, capability: "image" });
        }
        if (quote.imageSpec) {
            if (!/^[0-9a-f]{64}$/.test(confirmedQuoteFingerprint ?? "")) throw new GenerationContractError("invalid_input", "请先确认图片规格报价");
            if (confirmedQuoteFingerprint !== quote.quoteFingerprint) {
                throw new GenerationContractError("price_changed", "图片规格或报价已变化，请重新查看并确认费用");
            }
            return quoteReserveAndEnqueueGenerationTask(tx, queue, { ...input,
                parameterSnapshot: canonicalImageSpecTaskParameters(quote.imageSpec.parameters, quote.imageSpec.responseFormat) }, quote, { ...options, capability: "image" });
        }
        return quoteReserveAndEnqueueGenerationTask(tx, queue, input, quote, { ...options, capability: "image" });
    });
}

/**
 * Creates a task and its queue message in one database transaction. A replay
 * of the same task identity returns the existing row without sending a second
 * job; a queue failure rolls the task back with the transaction.
 */
export async function createAndEnqueueGenerationTask(
    db: Database,
    queue: GenerationQueueSender,
    input: CreateGenerationTaskInput,
): Promise<GenerationDispatchResult> {
    return db.transaction(async (tx) => {
        const tasks = createGenerationTaskRepository(tx);
        const created = await tasks.create(input);
        if (!created.created) return { task: created.task, created: false, jobId: null };

        const payload = createGenerationJobPayload({
            taskId: created.task.id,
            ownerId: created.task.ownerId,
            requestId: created.task.requestId,
        });
        const jobId = await queue.send(GENERATION_QUEUE_NAME, payload, { db: fromDrizzle(tx, sql) });
        if (!jobId) throw new Error("生成任务入队失败");
        const queued = await tasks.transitionExecution({ ownerId: input.ownerId, taskId: created.task.id, status: "queued" });
        return { task: queued, created: true, jobId };
    });
}

/**
 * Quote, reserve credits, bind the reservation to a task, and enqueue in one
 * database transaction. This is a server-only seam; it is intentionally not
 * mounted as a public generation route until staging policy is approved.
 */
export async function quoteReserveAndEnqueueGenerationTask(
    db: Database,
    queue: GenerationQueueSender,
    input: Omit<CreateGenerationTaskInput, "priceVersion" | "quotedUnits" | "billingUnitSnapshot" | "creditsPerUnitSnapshot">,
    quote: GenerationQuote,
    options: { admission?: GenerationSubmissionSafety; capability?: "image" | "audio" } = {},
): Promise<ReservedGenerationDispatchResult> {
    assertQuote(quote);
    if (quote.modelId !== input.modelId) throw new Error("生成报价模型不匹配");
    if (input.idempotencyKey.length > 198) throw new Error("生成幂等键过长");
    const reservationKey = `g:${input.idempotencyKey}`;
    return db.transaction(async (tx) => {
        const tasks = createGenerationTaskRepository(tx);
        const wallet = createWalletRepository(tx);
        const created = await tasks.create({
            ...input,
            priceVersion: quote.priceVersion,
            quotedUnits: quote.quotedUnits,
            billingUnitSnapshot: quote.billingUnit,
            creditsPerUnitSnapshot: quote.creditsPerUnit,
        });
        // New tasks must match the active server price. Replays use the
        // immutable snapshot already stored on the task, so a price rotation
        // cannot break an idempotent retry.
        if (created.created) {
            if (quote.gemini) {
                const original = await getImageSpecTaskSnapshot(tx, created.task);
                const active = await resolveExecutableImageQuote(tx, input, true, input.ownerId);
                if (original.status !== "gemini" || !active.gemini || active.quoteFingerprint !== quote.quoteFingerprint ||
                    geminiQuoteFingerprint(input.ownerId, input, quote.priceVersion, original) !== quote.quoteFingerprint)
                    throw new GenerationContractError("price_changed", "按张报价的发布来源已变化");
            } else if (quote.imageSpec) {
                const selected = imageSpecParametersFromTask(input.parameterSnapshot);
                const historical = await getImageSpecTaskSnapshot(tx, created.task);
                if (!selected || historical.status !== "recorded" || historical.protocol !== quote.imageSpec.protocol || historical.publicationId !== quote.pricePublicationId ||
                    historical.responseFormat !== quote.imageSpec.responseFormat ||
                    historical.creditsPerRequest !== quote.creditsPerUnit ||
                    selected.size !== quote.imageSpec.parameters.size || selected.quality !== quote.imageSpec.parameters.quality ||
                    historical.parameters.size !== selected.size || historical.parameters.quality !== selected.quality) {
                    throw new Error("图片规格报价与任务原来源不匹配");
                }
                const active = await resolveExecutableImageQuote(tx, { ...input, parameterSnapshot: selected }, true, input.ownerId);
                if (!active.imageSpec || active.imageSpec.protocol !== quote.imageSpec.protocol || active.imageSpec.responseFormat !== quote.imageSpec.responseFormat || active.priceVersion !== quote.priceVersion || active.pricePublicationId !== quote.pricePublicationId ||
                    active.creditsPerUnit !== quote.creditsPerUnit || active.quotedUnits !== quote.quotedUnits || active.quoteFingerprint !== quote.quoteFingerprint) {
                    throw new Error("图片规格报价与当前价格不匹配");
                }
            } else {
                const pricing = await resolveActiveGenerationPricing(tx, { modelId: input.modelId, priceVersion: quote.priceVersion });
                if (!pricing || pricing.billingUnit !== quote.billingUnit || pricing.creditsPerUnit !== quote.creditsPerUnit) {
                    throw new Error("生成报价与当前价格不匹配");
                }
            }
            if (options.admission) {
                if (!options.capability) throw new GenerationContractError("invalid_input", "生成准入能力未确认");
                await runConfirmedGenerationAdmission(tx, options.admission, { ...input, modelId: created.task.modelId, capability: options.capability });
            }
        }
        if (!created.created && quote.gemini) {
            const task = created.task;
            const original = task.reservationId && await wallet.getReservation(task.ownerId, task.reservationId);
            if (!original || original.taskId !== task.id || original.providerRequestId !== task.requestId ||
                compareCreditAmounts(original.requestedUnits, String(quote.quotedUnits)) !== 0)
                throw new GenerationTaskError("idempotency_conflict", "原图片任务的积分预留无法核对");
            return { task, reservation: original, created: false, jobId: null };
        }
        const reservation = await wallet.reserve({
            userId: input.ownerId,
            requestedUnits: quote.quotedUnits,
            idempotencyKey: reservationKey,
            // A replay may carry a new HTTP request ID; the stable generation
            // idempotency key must still reuse the original provider request.
            providerRequestId: created.created ? input.requestId : undefined,
            taskId: created.task.id,
            referenceType: "generation",
            referenceId: created.task.id,
        });
        let task = created.task;
        if (task.reservationId && task.reservationId !== reservation.id) throw new Error("生成任务余额预留不匹配");
        if (!task.reservationId) task = await tasks.setReservationId({ ownerId: input.ownerId, taskId: task.id, reservationId: reservation.id });
        if (task.billingStatus === "unbilled") task = await tasks.transitionBilling({ ownerId: input.ownerId, taskId: task.id, status: "reserved" });
        if (!created.created) return { task, reservation, created: false, jobId: null };

        const payload = createGenerationJobPayload({ taskId: task.id, ownerId: task.ownerId, requestId: task.requestId });
        const jobId = await queue.send(GENERATION_QUEUE_NAME, payload, { db: fromDrizzle(tx, sql) });
        if (!jobId) throw new Error("生成任务入队失败");
        task = await tasks.transitionExecution({ ownerId: input.ownerId, taskId: task.id, status: "queued" });
        return { task, reservation, created: true, jobId };
    });
}
