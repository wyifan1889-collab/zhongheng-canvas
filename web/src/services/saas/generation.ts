import { OPENAI_IMAGE_PROTOCOL, parseImageGenerationParameters, imageGenerationSpec, validImageGenerationCount, selectImageSpecPrice, type ImageSpecification, type ImageSpecParameters, type ImageGenerationParameters, type PublishedImageSpecPrice } from "../../../../packages/shared/src/model-price-publications";
import { parseModelPriceRules } from "../../../../packages/shared/src/model-pricing-drafts";
import { z } from "zod/v4";
import { parsePublishedMappingCatalog } from "./model-mapping-catalog";
import { GEMINI_IMAGE_PROTOCOL, GEMINI_IMAGE_USAGE, parseGeminiImageIntent, parseGeminiImageSpecification, type GeminiImageIntent } from "../../../../packages/shared/src/generation-gemini-image";
import { selectGeminiImageBand, type PublishedGeminiImagePrice } from "../../../../packages/shared/src/gemini-image-price-trial";

export type GenerationScope = { accountId: string; epoch: number; projectId: string };
export type GenerationImagePricing = (PublishedImageSpecPrice | PublishedGeminiImagePrice) & { priceVersion: number; priceNote?: string };
export type GenerationModel = { id: string; displayName: string; capability: "image"; group: { id: string; name: string; order: number } | null; imagePricing?: GenerationImagePricing; maxImages?: number; maxImagesPerRequest?: number };
export type GenerationParameters = Record<string, never> | ImageGenerationParameters | GeminiImageIntent;
export type GenerationIntent = { modelId: string; input: { prompt: string }; parameters: GenerationParameters; projectId: string; nodeId?: string };
export type GenerationQuote = { modelId: string; priceVersion: number; quotedUnits: number; creditsPerUnit: number; priceNote?: string } & (
    { billingUnit: "request"; imageSpec?: ImageSpecification & { maxImagesPerRequest?: number }; quoteFingerprint?: string; parameters?: never; usagePolicy?: never }
    | { billingUnit: "image"; parameters: GeminiImageIntent; usagePolicy: typeof GEMINI_IMAGE_USAGE; quoteFingerprint: string; imageSpec?: never });
export type GenerationMedia = { mediaId: string; kind: "image"; contentType: "image/png"; sizeBytes: number; etag: string };
export type GenerationImageSpecSnapshot = (ImageSpecification & { status: "recorded"; maxImagesPerRequest?: number }) | { status: "invalid" };
export type GenerationTaskView = {
    task: {
        id: string; projectId: string; nodeId?: string | null; modelId: string; priceVersion: number; quotedUnits: number;
        imageSpecSnapshot?: GenerationImageSpecSnapshot;
        geminiImage?: { protocol: typeof GEMINI_IMAGE_PROTOCOL; usagePolicy: typeof GEMINI_IMAGE_USAGE; parameters: GeminiImageIntent; creditsPerImage: number };
        billing?: { reservedCredits: string; capturedCredits: string; releasedCredits: string } | null;
        executionStatus: "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
        deliveryStatus: "pending" | "saved" | "visible" | "failed" | "unknown";
        billingStatus: "unbilled" | "reserved" | "captured" | "released" | "pending_review";
    };
    result: { taskId: string; status: "succeeded" | "failed" | "unknown"; consumedUnits?: number; resultSnapshot: { kind?: "image"; media?: GenerationMedia; imageMedia?: GenerationMedia[] } } | null;
};

export class GenerationError extends Error {
    constructor(public readonly code: string, message: string, public readonly outcome: "not-sent" | "rejected" | "unknown", public readonly status?: number) {
        super(message);
        this.name = "GenerationError";
    }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const modelId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(value);
const modelGroup = (value: unknown): value is GenerationModel["group"] => value === null || (record(value) && uuid(value.id) &&
    typeof value.name === "string" && !!value.name && value.name.trim() === value.name && value.name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value.name) &&
    Number.isSafeInteger(value.order) && (value.order as number) >= 0);
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,197}$/.test(value);
const unknownResult = (writing: boolean, status?: number) => new GenerationError("unconfirmed", writing ? "提交结果尚未确认，请保留回执并主动核对，不要重复提交。" : "任务读取未完成，请稍后主动核对。", writing ? "unknown" : "not-sent", status);
const invalid = () => new GenerationError("invalid_input", "生成请求格式不正确，请重新检查。", "not-sent");
const catalogError = () => new GenerationError("catalog_changed", "请重新读取可执行图片目录，并明确选择当前版本的一种完整规格后查看费用。", "not-sent");
const nodeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export function normalizeGenerationParameters(value: unknown): GenerationParameters {
    if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) throw invalid();
    if (!Reflect.ownKeys(value).length) return {};
    const parameters = value.protocol === GEMINI_IMAGE_PROTOCOL ? parseGeminiImageIntent(value) : parseImageGenerationParameters(value);
    if (!parameters) throw invalid();
    return parameters;
}
export function isGeminiGenerationParameters(value: GenerationParameters): value is GeminiImageIntent {
    return "protocol" in value && value.protocol === GEMINI_IMAGE_PROTOCOL;
}
export function sameGenerationParameters(left: object, right: object): boolean {
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key =>
        Object.hasOwn(right, key) && (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]);
}
function imagePricing(value: unknown): GenerationImagePricing {
    if (!record(value) || !positive(value.priceVersion) || value.billingUnit !== "image_specs" || value.creditsPerUnit !== null || ![OPENAI_IMAGE_PROTOCOL, GEMINI_IMAGE_PROTOCOL].includes(String(value.protocol)) ||
        !Array.isArray(value.imageSpecs) || !value.imageSpecs.length || value.priceNote !== undefined && typeof value.priceNote !== "string" ||
        ["inputCreditsPerMillion", "outputCreditsPerMillion", "cachedInputCreditsPerMillion"].some(key => Object.hasOwn(value, key))) throw unknownResult(false);
    if (value.protocol === GEMINI_IMAGE_PROTOCOL) {
        if (value.usagePolicy !== GEMINI_IMAGE_USAGE) throw unknownResult(false);
        const seen = new Set<string>();
        const imageSpecs = value.imageSpecs.map(item => {
            const parameters = record(item) && parseGeminiImageSpecification(undefined, item.parameters);
            if (!record(item) || Object.keys(item).length !== 2 || !parameters || !positive(item.creditsPerImage)) throw unknownResult(false);
            const key = JSON.stringify(parameters);
            if (seen.has(key)) throw unknownResult(false); seen.add(key);
            return { parameters, creditsPerImage: item.creditsPerImage };
        });
        return { priceVersion: value.priceVersion, billingUnit: "image_specs", creditsPerUnit: null, protocol: GEMINI_IMAGE_PROTOCOL,
            usagePolicy: GEMINI_IMAGE_USAGE, imageSpecs, ...(value.priceNote === undefined ? {} : { priceNote: value.priceNote }) };
    }
    const imageSpecs = value.imageSpecs.map(item => {
        if (!record(item) || Reflect.ownKeys(item).length !== 2 || !["parameters", "creditsPerRequest"].every(key => Object.hasOwn(item, key)) ||
            Reflect.ownKeys(item).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key)!, "value")) || !positive(item.creditsPerRequest)) throw unknownResult(false);
        let parameters: GenerationParameters;
        try { parameters = normalizeGenerationParameters(item.parameters); } catch { throw unknownResult(false); }
        if (!Object.keys(parameters).length || isGeminiGenerationParameters(parameters)) throw unknownResult(false);
        return { parameters: parameters as ImageSpecParameters, creditsPerRequest: item.creditsPerRequest };
    });
    const price: PublishedImageSpecPrice = { billingUnit: "image_specs", creditsPerUnit: null, protocol: OPENAI_IMAGE_PROTOCOL, imageSpecs };
    if (!parseModelPriceRules({ schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands:
        imageSpecs.map(item => ({ parameters: item.parameters, rates: { request: String(item.creditsPerRequest) } })) } }, "image") ||
        imageSpecs.some(item => selectImageSpecPrice(price, item.parameters)?.creditsPerRequest !== item.creditsPerRequest)) throw unknownResult(false);
    return { priceVersion: value.priceVersion, ...price, ...(value.priceNote === undefined ? {} : { priceNote: value.priceNote }) };
}

/** Owner history only. Absence is legacy; an explicit invalid source never gains parameters. */
export function parseGenerationImageSpecSnapshot(value: unknown): GenerationImageSpecSnapshot | null {
    if (!record(value)) return null;
    const fields = Object.keys(value);
    if (value.status === "invalid") return fields.length === 1 && Object.hasOwn(value, "status") ? { status: "invalid" } : null;
    if (value.status !== "recorded" || value.protocol !== OPENAI_IMAGE_PROTOCOL || fields.some(key => !["status", "protocol", "parameters", "maxImagesPerRequest"].includes(key)) || !Object.hasOwn(value, "parameters") ||
        Object.hasOwn(value, "maxImagesPerRequest") && !validImageGenerationCount(value.maxImagesPerRequest)) return null;
    const parameters = parseImageGenerationParameters(value.parameters);
    return parameters ? { status: "recorded", protocol: OPENAI_IMAGE_PROTOCOL, parameters, ...(value.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: value.maxImagesPerRequest as number }) } : null;
}

export function sameGenerationScope(left: GenerationScope | null, right: GenerationScope): boolean {
    return !!left && left.accountId === right.accountId && left.epoch === right.epoch && left.projectId === right.projectId;
}

/** Same-origin requests bound to one account epoch and one original canvas. No retries or polling. */
export function createGenerationClient(options: { scope: GenerationScope; getScope: () => GenerationScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ ...options.scope }), fetcher = options.fetcher ?? fetch;
    const catalog = new Map<string, GenerationModel>();
    let invalidated = false, catalogSequence = 0;
    function check(outcome: "not-sent" | "unknown") {
        if (invalidated || !sameGenerationScope(options.getScope(), scope)) {
            invalidated = true;
            throw new GenerationError("context_changed", "账号或画布已变化，请在原账号和画布中重新打开回执核对。", outcome);
        }
    }
    async function request(path: string, body?: object, idempotencyKey?: string): Promise<unknown> {
        const writing = idempotencyKey !== undefined;
        check("not-sent");
        let response: Response, data: unknown;
        try {
            response = await fetcher(path, {
                method: body ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            check(writing ? "unknown" : "not-sent");
            data = await response.json();
            check(writing ? "unknown" : "not-sent");
        } catch (error) {
            check(writing ? "unknown" : "not-sent");
            if (error instanceof GenerationError) throw error;
            throw unknownResult(writing);
        }
        if (!response.ok) {
            const code = record(data) && record(data.error) ? data.error.code : undefined;
            const errors: Record<string, [number, string]> = {
                invalid_input: [400, "生成请求格式不正确。"], unsupported_generation: [400, "当前模型或参数尚不支持平台图片生成。"],
                idempotency_required: [400, "缺少生成回执编号。"], idempotency_invalid: [400, "生成回执编号无效。"],
                account_context_required: [400, "页面账号与登录状态不一致，请重新确认账号。"], account_changed: [409, "页面账号与登录状态不一致，请重新确认账号。"],
                unauthorized: [401, "登录已失效，请重新登录后核对回执。"], forbidden: [403, "当前账号无权执行此操作。"],
                invalid_origin: [403, "请求来源不匹配，请联系管理员。"], not_found: [404, "尚未查到任务；提交可能仍在处理，请保留回执稍后核对。"],
                insufficient_balance: [402, "可用积分不足，本次未创建任务。"], price_changed: [409, "价格已变化，本次未创建任务，请重新获取并确认报价。"],
                idempotency_conflict: [409, "此回执已用于另一请求，请保留回执核对。"], generation_unavailable: [503, "平台图片生成暂未开放或当前模型不可用。"],
            };
            const known = typeof code === "string" ? errors[code] : undefined;
            if (known && known[0] === response.status) {
                if (["account_changed", "account_context_required", "unauthorized"].includes(code as string)) invalidated = true;
                throw new GenerationError(code as string, known[1], code === "idempotency_conflict" ? "unknown" : "rejected", response.status);
            }
            throw unknownResult(writing, response.status);
        }
        return data;
    }
    function intent(value: GenerationIntent): GenerationIntent {
        if (!modelId(value.modelId) || !record(value.input) || Object.keys(value.input).length !== 1 || typeof value.input.prompt !== "string" || !value.input.prompt.trim() ||
            value.projectId !== scope.projectId || Object.hasOwn(value, "nodeId") && !nodeId(value.nodeId)) throw invalid();
        return { modelId: value.modelId, input: { prompt: value.input.prompt }, parameters: normalizeGenerationParameters(value.parameters), projectId: scope.projectId,
            ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }) };
    }
    function view(data: unknown, writing: boolean, taskId?: string): GenerationTaskView {
        const task = record(data) ? data.task : undefined, result = record(data) ? data.result : undefined;
        if (!record(task) || !uuid(task.id) || (taskId !== undefined && task.id !== taskId) || task.projectId !== scope.projectId || !modelId(task.modelId) || !positive(task.priceVersion) || !positive(task.quotedUnits) ||
            Object.hasOwn(task, "nodeId") && task.nodeId !== null && !nodeId(task.nodeId) ||
            !["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"].includes(String(task.executionStatus)) ||
            !["pending", "saved", "visible", "failed", "unknown"].includes(String(task.deliveryStatus)) || !["unbilled", "reserved", "captured", "released", "pending_review"].includes(String(task.billingStatus))) throw unknownResult(writing);
        const imageSpecSnapshot = Object.hasOwn(task, "imageSpecSnapshot") ? parseGenerationImageSpecSnapshot(task.imageSpecSnapshot) : undefined;
        if (imageSpecSnapshot === null) throw unknownResult(writing);
        let geminiImage: GenerationTaskView["task"]["geminiImage"], billing: GenerationTaskView["task"]["billing"];
        if (Object.hasOwn(task, "geminiImage")) {
            const native = task.geminiImage, parameters = record(native) && parseGeminiImageIntent(native.parameters);
            if (imageSpecSnapshot || !record(native) || Object.keys(native).length !== 4 || native.protocol !== GEMINI_IMAGE_PROTOCOL || native.usagePolicy !== GEMINI_IMAGE_USAGE ||
                !parameters || !positive(native.creditsPerImage) || parameters.budgetCredits !== task.quotedUnits || native.creditsPerImage > parameters.budgetCredits ||
                task.billingUnitSnapshot !== "image" || task.creditsPerUnitSnapshot !== native.creditsPerImage) throw unknownResult(writing);
            const ledger = task.billing;
            if (!record(ledger) || !["reservedCredits", "capturedCredits", "releasedCredits"].every(key => typeof ledger[key] === "string" && /^(0|[1-9]\d*)$/.test(ledger[key] as string))) throw unknownResult(writing);
            billing = { reservedCredits: ledger.reservedCredits as string, capturedCredits: ledger.capturedCredits as string, releasedCredits: ledger.releasedCredits as string };
            if (BigInt(billing.reservedCredits) !== BigInt(parameters.budgetCredits) || BigInt(billing.capturedCredits) + BigInt(billing.releasedCredits) > BigInt(parameters.budgetCredits) ||
                task.billingStatus === "released" && (billing.capturedCredits !== "0" || billing.releasedCredits !== billing.reservedCredits)) throw unknownResult(writing);
            geminiImage = { protocol: GEMINI_IMAGE_PROTOCOL, usagePolicy: GEMINI_IMAGE_USAGE, parameters, creditsPerImage: native.creditsPerImage };
        } else if (task.billingUnitSnapshot === "image") throw unknownResult(writing);
        let safeResult: GenerationTaskView["result"] = null;
        if (result !== null) {
            if (!record(result) || result.taskId !== task.id || !["succeeded", "failed", "unknown"].includes(String(result.status)) || !record(result.resultSnapshot)) throw unknownResult(writing);
            const snapshot: NonNullable<GenerationTaskView["result"]>["resultSnapshot"] = {};
            if (result.resultSnapshot.kind === "image") snapshot.kind = "image";
            const media = result.resultSnapshot.media;
            if (media !== undefined) {
                if (!record(media) || !uuid(media.mediaId) || media.kind !== "image" || media.contentType !== "image/png" || !positive(media.sizeBytes) || typeof media.etag !== "string" || !media.etag) throw unknownResult(writing);
                snapshot.media = { mediaId: media.mediaId, kind: "image", contentType: "image/png", sizeBytes: media.sizeBytes, etag: media.etag };
            }
            const images = result.resultSnapshot.imageMedia;
            if (images !== undefined) {
                const count = geminiImage ? result.consumedUnits : imageSpecSnapshot?.status === "recorded" ? imageSpecSnapshot.parameters.n ?? 1 : 1;
                if (!validImageGenerationCount(count) || !Array.isArray(images) || images.length !== count || count < 2 || !snapshot.media ||
                    new Set(images.map(item => record(item) ? item.mediaId : null)).size !== count) throw unknownResult(writing);
                snapshot.imageMedia = images.map(item => {
                    if (!record(item) || !uuid(item.mediaId) || item.kind !== "image" || item.contentType !== "image/png" || !positive(item.sizeBytes) || typeof item.etag !== "string" || !item.etag) throw unknownResult(writing);
                    return { mediaId: item.mediaId, kind: "image" as const, contentType: "image/png" as const, sizeBytes: item.sizeBytes, etag: item.etag };
                });
                if (Object.keys(snapshot.media).some(key => snapshot.media![key as keyof GenerationMedia] !== snapshot.imageMedia![0]![key as keyof GenerationMedia])) throw unknownResult(writing);
            }
            if (media && imageSpecSnapshot?.status === "recorded" && (imageSpecSnapshot.parameters.n ?? 1) > 1 && !snapshot.imageMedia) throw unknownResult(writing);
            if (geminiImage && media) {
                const count = snapshot.imageMedia?.length ?? 1, cost = BigInt(count) * BigInt(geminiImage.creditsPerImage);
                if (result.consumedUnits !== count || result.status !== "succeeded" || task.executionStatus !== "succeeded" ||
                    cost > BigInt(geminiImage.parameters.budgetCredits) || task.billingStatus === "captured" &&
                    (BigInt(billing!.capturedCredits) !== cost || BigInt(billing!.releasedCredits) + cost !== BigInt(billing!.reservedCredits))) throw unknownResult(writing);
            }
            safeResult = { taskId: task.id, status: result.status as NonNullable<GenerationTaskView["result"]>["status"], resultSnapshot: snapshot,
                ...(geminiImage && positive(result.consumedUnits) ? { consumedUnits: result.consumedUnits } : {}) };
        }
        if (geminiImage && task.billingStatus === "captured" && !safeResult?.resultSnapshot.media) throw unknownResult(writing);
        return { task: { id: task.id, projectId: task.projectId, modelId: task.modelId, priceVersion: task.priceVersion, quotedUnits: task.quotedUnits,
            ...(Object.hasOwn(task, "nodeId") ? { nodeId: task.nodeId as string | null } : {}),
            ...(imageSpecSnapshot ? { imageSpecSnapshot } : {}),
            ...(geminiImage ? { geminiImage, billing } : {}),
            executionStatus: task.executionStatus as GenerationTaskView["task"]["executionStatus"], deliveryStatus: task.deliveryStatus as GenerationTaskView["task"]["deliveryStatus"], billingStatus: task.billingStatus as GenerationTaskView["task"]["billingStatus"] }, result: safeResult };
    }
    return Object.freeze({
        async mappingCatalog() {
            const data = await request("/api/v1/model-mapping-catalog");
            check("not-sent");
            const result = record(data) ? parsePublishedMappingCatalog(data.catalog) : null;
            if (!result) throw catalogError();
            return result;
        },
        async models(): Promise<GenerationModel[]> {
            const sequence = ++catalogSequence; catalog.clear();
            const data = await request("/api/v1/generation/models");
            check("not-sent");
            if (!record(data) || !Array.isArray(data.items) || data.items.some((item) => !record(item) || !modelId(item.id) || typeof item.displayName !== "string" || item.capability !== "image" || !modelGroup(item.group))) throw unknownResult(false);
            const seen = new Set<string>();
            const models: GenerationModel[] = data.items.map((item) => {
                if (seen.has(item.id)) throw unknownResult(false); seen.add(item.id);
                if (item.maxImages !== undefined && !validImageGenerationCount(item.maxImages)) throw unknownResult(false);
                if (Object.hasOwn(item, "maxImagesPerRequest") && (!validImageGenerationCount(item.maxImagesPerRequest) ||
                    !Object.hasOwn(item, "imagePricing") || !validImageGenerationCount(item.maxImages) || Number(item.maxImagesPerRequest) > Number(item.maxImages))) throw unknownResult(false);
                const pricing = Object.hasOwn(item, "imagePricing") ? imagePricing(item.imagePricing) : undefined;
                if (pricing?.protocol === GEMINI_IMAGE_PROTOCOL && (Object.hasOwn(item, "maxImages") || Object.hasOwn(item, "maxImagesPerRequest"))) throw unknownResult(false);
                return { id: item.id, displayName: item.displayName, capability: "image", ...(item.maxImages === undefined ? {} : { maxImages: item.maxImages as number }),
                    ...(item.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: item.maxImagesPerRequest as number }),
                    group: item.group === null ? null : { id: item.group.id, name: item.group.name, order: item.group.order },
                    ...(pricing ? { imagePricing: pricing } : {}) };
            });
            if (sequence !== catalogSequence) throw catalogError();
            for (const model of models) catalog.set(model.id, structuredClone(model));
            return models;
        },
        async quote(value: GenerationIntent): Promise<GenerationQuote> {
            const input = intent(value), hasSpec = Object.keys(input.parameters).length > 0, model = catalog.get(input.modelId), pricing = model?.imagePricing;
            if (isGeminiGenerationParameters(input.parameters)) {
                const parameters = input.parameters;
                const selected = pricing?.protocol === GEMINI_IMAGE_PROTOCOL && selectGeminiImageBand(pricing, parameters);
                if (!selected || parameters.budgetCredits < selected.creditsPerImage) throw catalogError();
                const data = await request("/api/v1/generation/quote", input);
                check("not-sent");
                const quote = record(data) ? data.quote : undefined, current = catalog.get(input.modelId)?.imagePricing;
                if (!record(quote) || quote.modelId !== input.modelId || quote.billingUnit !== "image" || quote.usagePolicy !== GEMINI_IMAGE_USAGE ||
                    Object.hasOwn(quote, "imageSpec") || !fingerprint(quote.quoteFingerprint) || !parseGeminiImageIntent(quote.parameters) ||
                    !sameGenerationParameters(quote.parameters as object, parameters) || quote.quotedUnits !== parameters.budgetCredits ||
                    quote.creditsPerUnit !== selected.creditsPerImage || quote.priceVersion !== pricing!.priceVersion ||
                    current?.protocol !== GEMINI_IMAGE_PROTOCOL || current.priceVersion !== quote.priceVersion ||
                    selectGeminiImageBand(current, parameters)?.creditsPerImage !== selected.creditsPerImage ||
                    quote.priceNote !== undefined && typeof quote.priceNote !== "string") throw catalogError();
                return { modelId: input.modelId, priceVersion: current.priceVersion, billingUnit: "image", creditsPerUnit: selected.creditsPerImage,
                    quotedUnits: parameters.budgetCredits, parameters: { ...parameters }, usagePolicy: GEMINI_IMAGE_USAGE,
                    quoteFingerprint: quote.quoteFingerprint, ...(quote.priceNote === undefined ? {} : { priceNote: quote.priceNote }) };
            }
            if (pricing?.protocol === GEMINI_IMAGE_PROTOCOL) throw catalogError();
            const count = input.parameters.n ?? 1;
            const selected = pricing && selectImageSpecPrice(pricing, imageGenerationSpec(input.parameters));
            if (count > (catalog.get(input.modelId)?.maxImages ?? 1) || hasSpec && !selected || !hasSpec && pricing) throw catalogError();
            const data = await request("/api/v1/generation/quote", input);
            check("not-sent");
            const quote = record(data) ? data.quote : undefined;
            if (!record(quote) || quote.modelId !== input.modelId || !positive(quote.priceVersion) || !positive(quote.quotedUnits) || quote.billingUnit !== "request" || !positive(quote.creditsPerUnit) || quote.quotedUnits !== quote.creditsPerUnit * count || (quote.priceNote !== undefined && typeof quote.priceNote !== "string")) throw unknownResult(false);
            let imageSpec: GenerationQuote["imageSpec"];
            if (hasSpec) {
                if (!record(quote.imageSpec) || quote.imageSpec.protocol !== pricing?.protocol || quote.imageSpec.protocol !== OPENAI_IMAGE_PROTOCOL ||
                    Reflect.ownKeys(quote.imageSpec).some(key => key !== "protocol" && key !== "parameters" && key !== "maxImagesPerRequest") ||
                    !Object.hasOwn(quote.imageSpec, "parameters") || !fingerprint(quote.quoteFingerprint) ||
                    Object.hasOwn(quote.imageSpec, "maxImagesPerRequest") && !validImageGenerationCount(quote.imageSpec.maxImagesPerRequest)) throw unknownResult(false);
                let parameters: GenerationParameters;
                try { parameters = normalizeGenerationParameters(quote.imageSpec.parameters); } catch { throw unknownResult(false); }
                const current = catalog.get(input.modelId)?.imagePricing;
                if (!sameGenerationParameters(parameters, input.parameters) || quote.imageSpec.maxImagesPerRequest !== model?.maxImagesPerRequest ||
                    catalog.get(input.modelId)?.maxImagesPerRequest !== model?.maxImagesPerRequest || !pricing || !selected || !current || current.protocol !== OPENAI_IMAGE_PROTOCOL || current.priceVersion !== pricing.priceVersion ||
                    quote.priceVersion !== pricing.priceVersion || quote.creditsPerUnit !== selected.creditsPerRequest || selectImageSpecPrice(current, imageGenerationSpec(input.parameters))?.creditsPerRequest !== selected.creditsPerRequest) throw catalogError();
                imageSpec = { protocol: OPENAI_IMAGE_PROTOCOL, parameters: parameters as ImageGenerationParameters,
                    ...(quote.imageSpec.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: quote.imageSpec.maxImagesPerRequest as number }) };
            } else if (Object.hasOwn(quote, "imageSpec") || Object.hasOwn(quote, "quoteFingerprint")) throw unknownResult(false);
            else if (catalog.get(input.modelId)?.imagePricing) throw catalogError();
            return { modelId: quote.modelId, priceVersion: quote.priceVersion, quotedUnits: quote.quotedUnits, billingUnit: "request", creditsPerUnit: quote.creditsPerUnit,
                ...(imageSpec ? { imageSpec, quoteFingerprint: quote.quoteFingerprint as string } : {}),
                ...(quote.priceNote !== undefined ? { priceNote: quote.priceNote } : {}) };
        },
        async submit(value: GenerationIntent, confirmedPriceVersion: number, idempotencyKey: string, confirmedQuoteFingerprint?: string): Promise<GenerationTaskView> {
            if (!positive(confirmedPriceVersion) || !key(idempotencyKey)) throw invalid();
            const input = intent(value), hasSpec = Object.keys(input.parameters).length > 0;
            if (hasSpec ? !fingerprint(confirmedQuoteFingerprint) : confirmedQuoteFingerprint !== undefined) throw invalid();
            const result = view(await request("/api/v1/generation/tasks", { ...input, confirmedPriceVersion,
                ...(confirmedQuoteFingerprint === undefined ? {} : { confirmedQuoteFingerprint }) }, idempotencyKey), true);
            check("unknown");
            if (result.task.modelId !== input.modelId || result.task.priceVersion !== confirmedPriceVersion || (result.task.nodeId ?? null) !== (input.nodeId ?? null) ||
                (isGeminiGenerationParameters(input.parameters) ? !result.task.geminiImage || !sameGenerationParameters(result.task.geminiImage.parameters, input.parameters)
                    : hasSpec && (result.task.imageSpecSnapshot?.status !== "recorded" || !sameGenerationParameters(result.task.imageSpecSnapshot.parameters, input.parameters)))) throw unknownResult(true);
            return result;
        },
        async get(taskId: string): Promise<GenerationTaskView> {
            if (!uuid(taskId)) throw invalid();
            const result = view(await request(`/api/v1/generation/tasks/${taskId}`), false, taskId);
            check("not-sent");
            return result;
        },
        async getByKey(idempotencyKey: string): Promise<GenerationTaskView> {
            if (!key(idempotencyKey)) throw invalid();
            const result = view(await request(`/api/v1/generation/tasks/by-key/${encodeURIComponent(idempotencyKey)}`), false);
            check("not-sent");
            return result;
        },
    });
}

export type GenerationClient = ReturnType<typeof createGenerationClient>;

export type GenerationTrackingScope = { accountId: string; epoch: number };
export type GenerationTrackingItem = {
    taskId: string; projectId: string | null; nodeId: string | null; modelId: string;
    executionStatus: GenerationTaskView["task"]["executionStatus"];
    deliveryStatus: GenerationTaskView["task"]["deliveryStatus"];
    billingStatus: GenerationTaskView["task"]["billingStatus"];
    updatedAt: string;
};
export type GenerationTrackingResponse = { items: GenerationTrackingItem[]; missingTaskIds: string[]; requestId: string };

export class GenerationTrackingError extends Error {
    constructor(public readonly code: string, message: string, public readonly status?: number, public readonly retryAfterMs?: number) {
        super(message);
        this.name = "GenerationTrackingError";
    }
}

const trackingUuid = z.uuid();
const trackingIds = z.array(trackingUuid);
const trackingText = z.string().refine(value => value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const trackingResponse = z.object({
    items: z.array(z.object({
        taskId: trackingUuid, projectId: trackingText.nullable(), nodeId: trackingText.nullable(), modelId: trackingText,
        executionStatus: z.enum(["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"]),
        deliveryStatus: z.enum(["pending", "saved", "visible", "failed", "unknown"]),
        billingStatus: z.enum(["unbilled", "reserved", "captured", "released", "pending_review"]),
        updatedAt: z.iso.datetime({ offset: true }),
    })),
    missingTaskIds: z.array(trackingUuid), requestId: trackingText,
});
const trackingUnconfirmed = (status?: number) => new GenerationTrackingError("read_unconfirmed", "任务状态读取待核对，请保留原回执。", status);
function trackingRetryAfter(value: string | null, now: () => number): number | undefined {
    if (value === null || !value.trim()) return undefined;
    const text = value.trim(), delay = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now();
    return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

/** Account-only, read-only status batches. The original project-scoped client above is unchanged. */
export function createGenerationTrackingClient(options: {
    scope: GenerationTrackingScope; getScope: () => GenerationTrackingScope | null; fetcher?: typeof fetch; now?: () => number;
}) {
    const scope = Object.freeze({ accountId: options.scope.accountId, epoch: options.scope.epoch });
    const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
    let invalidated = false;
    function check(signal?: AbortSignal) {
        const current = options.getScope();
        if (invalidated || !current || current.accountId !== scope.accountId || current.epoch !== scope.epoch) {
            invalidated = true;
            throw new GenerationTrackingError("context_changed", "账号状态已变化，已停止原任务状态读取。");
        }
        if (signal?.aborted) throw new GenerationTrackingError("aborted", "任务状态读取已停止。");
    }
    return Object.freeze({
        async read(taskIds: readonly string[], signal?: AbortSignal): Promise<GenerationTrackingResponse> {
            check(signal);
            if (!Array.isArray(taskIds) || taskIds.length > 50) {
                throw new GenerationTrackingError("invalid_input", "任务状态批量读取参数不正确。", 400);
            }
            const parsedIds = trackingIds.safeParse(taskIds);
            if (!parsedIds.success) throw new GenerationTrackingError("invalid_input", "任务状态批量读取参数不正确。", 400);
            const requested = [...new Set(parsedIds.data.map(value => value.toLowerCase()))];
            // No HTTP request means there is no server request ID.
            if (!requested.length) return { items: [], missingTaskIds: [], requestId: "" };
            let response: Response | undefined, data: unknown;
            try {
                check(signal);
                response = await fetcher("/api/v1/generation/tasks/batch", {
                    method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal,
                    headers: { accept: "application/json", "content-type": "application/json", "x-canvas-account-id": scope.accountId },
                    body: JSON.stringify({ taskIds: requested }),
                });
                check(signal);
                if (response.status === 401) {
                    throw new GenerationTrackingError("unauthorized", "登录已失效，已停止原任务状态读取。", 401);
                }
                if (response.status === 429) throw new GenerationTrackingError("rate_limited", "任务状态读取受限，稍后继续核对。", 429, trackingRetryAfter(response.headers.get("Retry-After"), now));
                data = await response.json();
                check(signal);
            } catch (error) {
                check(signal);
                if (error instanceof GenerationTrackingError) {
                    if (error.code === "unauthorized") invalidated = true;
                    throw error;
                }
                throw trackingUnconfirmed(response?.status);
            }
            if (!response.ok) {
                const code = record(data) && record(data.error) ? data.error.code : undefined;
                if (code === "account_context_required" && response.status === 400 || code === "account_changed" && response.status === 409) {
                    invalidated = true;
                    throw new GenerationTrackingError(code, "账号状态不一致，已停止原任务状态读取。", response.status);
                }
                throw trackingUnconfirmed(response.status);
            }
            const parsed = trackingResponse.safeParse(data);
            check(signal);
            if (!parsed.success) throw trackingUnconfirmed(response.status);
            const expected = new Set(requested), seen = new Set<string>();
            const items = parsed.data.items.map(item => ({ ...item, taskId: item.taskId.toLowerCase() }));
            const missingTaskIds = parsed.data.missingTaskIds.map(taskId => taskId.toLowerCase());
            for (const taskId of [...items.map(item => item.taskId), ...missingTaskIds]) {
                if (!expected.has(taskId) || seen.has(taskId)) throw trackingUnconfirmed(response.status);
                seen.add(taskId);
            }
            if (seen.size !== expected.size) throw trackingUnconfirmed(response.status);
            const byId = new Map(items.map(item => [item.taskId, item]));
            return { items: requested.flatMap(taskId => byId.has(taskId) ? [byId.get(taskId)!] : []),
                missingTaskIds: requested.filter(taskId => !byId.has(taskId)), requestId: parsed.data.requestId };
        },
    });
}

export type GenerationTrackingClient = ReturnType<typeof createGenerationTrackingClient>;
