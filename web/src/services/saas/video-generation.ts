import { z } from "zod/v4";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, parseVideoParameters, sameVideoParameters, type PublicVideoQuote, type VideoGenerationModel, type VideoParameters } from "../../../../packages/shared/src/generation-video";
export { sameVideoParameters } from "../../../../packages/shared/src/generation-video";
import { GenerationError } from "./generation";
import { normalizeCreditAmount } from "../../../../packages/shared/src/credit-amounts";
import { parsePublishedMappingCatalog } from "./model-mapping-catalog";

export type VideoGenerationScope = { accountId: string; epoch: number };
export type VideoGenerationIntent = { modelId: string; input: { prompt: string; referenceMediaId?: string }; parameters: VideoParameters };
const identifier = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const creditAmount = z.string().refine(value => !value.startsWith("-") && normalizeCreditAmount(value) === value);
const parameters = z.unknown().transform((value, ctx) => {
    const parsed = parseVideoParameters(value);
    if (!parsed) { ctx.addIssue({ code: "custom", message: "Invalid video parameters" }); return z.NEVER; }
    return parsed;
});
const intentSchema = z.strictObject({ modelId, input: z.strictObject({ prompt: z.string().refine(value => !!value.trim()), referenceMediaId: z.uuid().optional() }), parameters })
    .refine(value => value.parameters.mode === "first_frame" ? !!value.input.referenceMediaId : value.input.referenceMediaId === undefined);
const quoteSchema = z.strictObject({ modelId, priceVersion: positive, parameters, quotedVideoUnits: z.literal(1), maxVideoUnits: z.literal(1),
    reservedCredits: positive, usagePolicy: z.literal("delivered_video"), quoteFingerprint: z.string().regex(/^[0-9a-f]{64}$/), priceNote: z.string().optional() });
const modelSchema = z.strictObject({ id: modelId, displayName: identifier, capability: z.literal("video"),
    group: z.strictObject({ id: z.uuid(), name: identifier, order: z.number().int().nonnegative() }).nullable(),
    videoPricing: z.strictObject({ priceVersion: positive, billingUnit: z.literal("video_specs"), creditsPerUnit: z.null(), protocol: z.literal("yunfei-grok-video-v1"),
        usagePolicy: z.literal("delivered_video"), videoSpecs: z.array(z.strictObject({ parameters, creditsPerVideo: positive })).min(1), priceNote: z.string().optional() }) });
const mediaSchema = z.strictObject({ mediaId: z.uuid(), kind: z.literal("video"), contentType: z.literal("video/mp4"), sizeBytes: positive, etag: z.string().regex(/^[0-9a-f]{64}$/) });
const taskSchema = z.object({
    task: z.object({ id: z.uuid(), projectId: z.null(), nodeId: z.null().optional(), modelId, priceVersion: positive, quotedUnits: positive,
        billingUnitSnapshot: z.literal("request"), creditsPerUnitSnapshot: positive,
        executionStatus: z.enum(["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"]),
        deliveryStatus: z.enum(["pending", "saved", "visible", "failed", "unknown"]), billingStatus: z.enum(["unbilled", "reserved", "captured", "released", "pending_review"]),
        video: z.strictObject({ parameters, usagePolicy: z.literal("delivered_video"), quotedVideoUnits: z.literal(1), reservedCredits: positive,
            phase: z.enum(["ready", "rejected", "create_started", "accepted", "polling", "completed", "failed", "unknown"]) }),
        billing: z.object({ reservedCredits: creditAmount, capturedCredits: creditAmount, releasedCredits: creditAmount }).nullable().optional(),
    }),
    result: z.object({ taskId: z.uuid(), status: z.enum(["succeeded", "failed", "unknown"]),
        resultSnapshot: z.object({ kind: z.literal("video").optional(), media: mediaSchema.optional() }) }).nullable(),
});
export type VideoGenerationTaskView = z.infer<typeof taskSchema>;
export const videoParametersKey = (value: VideoParameters) => JSON.stringify([value.mode, value.resolution, value.durationSeconds, value.generateAudio, value.aspectRatio ?? null]);
export const videoIntentKey = (value: VideoGenerationIntent) => JSON.stringify([value.modelId, value.input.prompt, value.input.referenceMediaId ?? null, videoParametersKey(value.parameters)]);
export function parseVideoIntent(value: unknown): VideoGenerationIntent | null { return intentSchema.safeParse(value).data ?? null; }
export function parsePublicVideoQuote(value: unknown): PublicVideoQuote | null { return quoteSchema.safeParse(value).data ?? null; }
export function parseVideoTaskView(value: unknown): VideoGenerationTaskView | null {
    const result = taskSchema.safeParse(value);
    if (!result.success) return null;
    const { task, result: generated } = result.data;
    if (task.quotedUnits !== task.video.reservedCredits || task.creditsPerUnitSnapshot !== task.quotedUnits || generated && generated.taskId !== task.id) return null;
    return result.data;
}
const unconfirmed = (writing: boolean, status?: number) => new GenerationError("unconfirmed", writing
    ? "视频提交结果待核对，请保留回执并查询原任务，不要再次生成。" : "视频读取尚未确认，请保留回执后查询原任务。", writing ? "unknown" : "not-sent", status);
const invalid = () => new GenerationError("invalid_input", "请明确选择平台视频模型及完整规格，当前草稿已保留。", "not-sent");
const sameScope = (a: VideoGenerationScope | null, b: VideoGenerationScope) => a?.accountId === b.accountId && a.epoch === b.epoch;

/** Same-origin, account-bound client. Every submit consumes one exact server quote once. */
export function createVideoGenerationClient(options: { scope: VideoGenerationScope; getScope: () => VideoGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ ...options.scope }), fetcher = options.fetcher ?? fetch;
    const issued = new WeakMap<PublicVideoQuote, { intent: VideoGenerationIntent; sequence: number }>();
    const catalog = new Map<string, VideoGenerationModel>();
    let invalidated = false, sequence = 0;
    function check(writing = false) {
        if (invalidated || !sameScope(options.getScope(), scope)) {
            invalidated = true; throw new GenerationError("context_changed", "账号已变化，请在原账号核对视频回执。", writing ? "unknown" : "not-sent");
        }
    }
    async function request(path: string, signal?: AbortSignal, body?: unknown, key?: string) {
        const writing = key !== undefined; check();
        if (signal?.aborted) throw unconfirmed(false);
        let response: Response, data: unknown;
        try {
            response = await fetcher(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "Idempotency-Key": key } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            check(writing); data = await response.json(); check(writing);
        } catch (cause) { check(writing); if (cause instanceof GenerationError) throw cause; throw unconfirmed(writing); }
        if (!response.ok) {
            const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(data);
            const code = error.success ? error.data.error.code : "unconfirmed";
            const known: Record<string, [number, string]> = {
                invalid_input: [400, "视频参数无效，草稿已保留。"], unsupported_generation: [400, "当前平台尚不支持这些视频参数。"],
                unauthorized: [401, "登录已失效，请重新登录后核对原回执。"], forbidden: [403, "当前账号无权访问。"], invalid_origin: [403, "请求来源不匹配。"],
                account_context_required: [400, "页面账号尚未确认。"], account_changed: [409, "登录账号已变化，请核对原回执。"],
                not_found: [404, "暂未查到原任务，请保留回执；不能据此再次生成。"], price_changed: [409, "报价已变化，本次未受理，请重新查看费用。"],
                insufficient_balance: [402, "可用积分不足，本次未受理。"], idempotency_conflict: [409, "回执与原请求不一致，请保留回执核对。"],
                generation_unavailable: [503, "平台视频暂未开放或必要能力尚未配置。"], rate_limited: [429, "生成请求过于频繁，请按提示稍后查看费用。"],
            };
            if (known[code]?.[0] !== response.status) throw unconfirmed(writing, response.status);
            if (["unauthorized", "account_changed", "account_context_required"].includes(code)) invalidated = true;
            throw new GenerationError(code, known[code][1], code === "idempotency_conflict" ? "unknown" : "rejected", response.status);
        }
        return data;
    }
    function view(data: unknown, writing: boolean, id?: string) {
        const parsed = parseVideoTaskView(data);
        if (!parsed || id !== undefined && parsed.task.id !== id) throw unconfirmed(writing);
        return parsed;
    }
    return Object.freeze({
        async mappingCatalog(signal?: AbortSignal) {
            const data = z.object({ catalog: z.unknown() }).safeParse(await request("/api/v1/model-mapping-catalog", signal));
            const catalog = data.success ? parsePublishedMappingCatalog(data.data.catalog) : null;
            if (!catalog) throw unconfirmed(false);
            return catalog;
        },
        async models(signal?: AbortSignal): Promise<VideoGenerationModel[]> {
            const version = ++sequence; catalog.clear();
            const data = z.object({ items: z.array(modelSchema) }).safeParse(await request("/api/v1/generation/video/models", signal));
            if (!data.success || version !== sequence || new Set(data.data.items.map(item => item.id)).size !== data.data.items.length) throw unconfirmed(false);
            for (const item of data.data.items) {
                if (new Set(item.videoPricing.videoSpecs.map(spec => videoParametersKey(spec.parameters))).size !== item.videoPricing.videoSpecs.length || item.videoPricing.protocol !== VIDEO_PROTOCOL || item.videoPricing.usagePolicy !== VIDEO_USAGE_POLICY) throw unconfirmed(false);
            }
            for (const item of data.data.items) catalog.set(item.id, structuredClone(item));
            return data.data.items;
        },
        async quote(value: VideoGenerationIntent, signal?: AbortSignal): Promise<PublicVideoQuote> {
            const intent = parseVideoIntent(value); if (!intent) throw invalid();
            const model = catalog.get(intent.modelId), band = model?.videoPricing.videoSpecs.find(spec => sameVideoParameters(spec.parameters, intent.parameters));
            if (!model || !band) throw invalid();
            const version = sequence;
            const data = z.object({ quote: quoteSchema }).safeParse(await request("/api/v1/generation/video/quote", signal, intent));
            if (!data.success || version !== sequence || data.data.quote.modelId !== intent.modelId || data.data.quote.priceVersion !== model.videoPricing.priceVersion ||
                data.data.quote.reservedCredits !== band.creditsPerVideo || !sameVideoParameters(data.data.quote.parameters, intent.parameters)) throw unconfirmed(false);
            const quote = Object.freeze({ ...data.data.quote, parameters: Object.freeze(data.data.quote.parameters) }); issued.set(quote, { intent: structuredClone(intent), sequence: version }); return quote;
        },
        async submit(value: VideoGenerationIntent, quote: PublicVideoQuote, key: string, signal?: AbortSignal): Promise<VideoGenerationTaskView> {
            check(); const intent = parseVideoIntent(value), confirmation = issued.get(quote);
            if (!intent || !confirmation || confirmation.sequence !== sequence || videoIntentKey(intent) !== videoIntentKey(confirmation.intent) || !/^video:[0-9a-f-]{36}$/i.test(key)) throw invalid();
            issued.delete(quote);
            const result = view(await request("/api/v1/generation/video/tasks", signal, { ...intent, confirmedPriceVersion: quote.priceVersion, confirmedQuoteFingerprint: quote.quoteFingerprint }, key), true);
            if (!videoTaskMatches(result, intent, quote)) throw unconfirmed(true);
            return result;
        },
        async get(id: string, signal?: AbortSignal) { if (!z.uuid().safeParse(id).success) throw invalid(); return view(await request(`/api/v1/generation/tasks/${id}`, signal), false, id); },
        async recover(key: string, signal?: AbortSignal) { if (!/^video:[0-9a-f-]{36}$/i.test(key)) throw invalid(); return view(await request(`/api/v1/generation/tasks/by-key/${encodeURIComponent(key)}`, signal), false); },
    });
}
export function videoTaskMatches(view: VideoGenerationTaskView, intent: VideoGenerationIntent, quote: PublicVideoQuote) {
    return view.task.modelId === intent.modelId && view.task.priceVersion === quote.priceVersion && view.task.quotedUnits === quote.reservedCredits
        && sameVideoParameters(view.task.video.parameters, intent.parameters);
}
export type VideoGenerationClient = ReturnType<typeof createVideoGenerationClient>;
