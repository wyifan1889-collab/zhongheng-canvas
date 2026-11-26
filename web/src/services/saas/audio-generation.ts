import { addCreditAmounts, compareCreditAmounts, normalizeCreditAmount } from "../../../../packages/shared/src/credit-amounts";
import { GenerationError } from "./generation";

export type AudioGenerationScope = { accountId: string; epoch: number };
export type AudioGenerationFormat = "mp3" | "wav";
export type AudioGenerationParameters = { voice: string; format: AudioGenerationFormat; style?: string; language?: string };
export type AudioGenerationIntent = { modelId: string; input: { text: string }; parameters: AudioGenerationParameters };
export type AudioGenerationModel = {
    id: string; displayName: string; capability: "audio";
    group: { id: string; name: string; order: number } | null;
    audio: { formats: AudioGenerationFormat[]; voices: string[]; instructions: boolean };
    audioPricing: { priceVersion: number; billingUnit: "request"; creditsPerUnit: number; priceNote?: string };
};
export type AudioGenerationQuote = AudioGenerationModel["audioPricing"] & { modelId: string; quotedUnits: number; quoteFingerprint: string };
export type AudioGenerationSnapshot = { status: "recorded"; input: { text: string }; parameters: AudioGenerationParameters } | { status: "invalid" };
export type AudioGenerationMedia = { mediaId: string; kind: "audio"; contentType: "audio/mpeg" | "audio/wav"; sizeBytes: number; etag: string };
export type AudioGenerationTaskView = {
    task: {
        id: string; projectId: null; nodeId: null; modelId: string; priceVersion: number; quotedUnits: number;
        billingUnitSnapshot: "request"; creditsPerUnitSnapshot: number; audioSnapshot: AudioGenerationSnapshot;
        executionStatus: "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
        deliveryStatus: "pending" | "saved" | "visible" | "failed" | "unknown";
        billingStatus: "unbilled" | "reserved" | "captured" | "released" | "pending_review";
        billing?: { reservedCredits: string; capturedCredits: string; releasedCredits: string } | null;
    };
    result: {
        taskId: string; status: "succeeded" | "failed" | "unknown";
        resultSnapshot: {
            kind?: "audio"; media?: AudioGenerationMedia;
            usageEvidence?: { status: "missing"; source: "audio_speech_binary" | "audio_chat_data_uri" };
            technicalAudio?: { source: "decoded_samples"; samplesPerChannel: number; sampleRate: number; channels: number; durationSeconds: number };
        };
    } | null;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const modelId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(value);
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,197}$/.test(value);
const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const name = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const amount = (value: unknown): value is string => typeof value === "string" && normalizeCreditAmount(value) === value && compareCreditAmounts(value, "0") >= 0;
const unknownResult = (writing: boolean, status?: number) => new GenerationError("unconfirmed", writing ? "提交结果尚未确认，请保留回执并主动核对，不要重复提交。" : "音频任务读取未完成，请保留回执稍后核对。", writing ? "unknown" : "not-sent", status);
const invalid = () => new GenerationError("invalid_input", "请检查朗读文本、音色和音频格式；音乐参数暂不可用。", "not-sent");
const catalogError = () => new GenerationError("catalog_changed", "平台音频模型或价格已变化，请重新选择模型并查看费用。", "not-sent");
const confirmationError = () => new GenerationError("confirmation_changed", "朗读内容、参数或报价已变化，请重新查看并确认费用。", "not-sent");

function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
    return record(value) && required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === "string" &&
        (required.includes(key) || optional.includes(key)) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
function parameters(value: unknown): AudioGenerationParameters | null {
    if (!fields(value, ["voice", "format"], ["style", "language"]) || !name(value.voice) || (value.format !== "mp3" && value.format !== "wav") ||
        ["style", "language"].some(key => Object.hasOwn(value, key) && (typeof value[key] !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value[key] as string)))) return null;
    return { voice: value.voice, format: value.format, ...(Object.hasOwn(value, "style") ? { style: value.style as string } : {}),
        ...(Object.hasOwn(value, "language") ? { language: value.language as string } : {}) };
}
function input(value: unknown): { text: string } | null {
    return fields(value, ["text"]) && typeof value.text === "string" && !!value.text.trim() ? { text: value.text } : null;
}
function intent(value: unknown): AudioGenerationIntent {
    if (!fields(value, ["modelId", "input", "parameters"]) || !modelId(value.modelId)) throw invalid();
    const text = input(value.input), audio = parameters(value.parameters);
    if (!text || !audio) throw invalid();
    return { modelId: value.modelId, input: text, parameters: audio };
}
function history(value: unknown): AudioGenerationSnapshot | null {
    if (fields(value, ["status"]) && value.status === "invalid") return { status: "invalid" };
    if (!fields(value, ["status", "input", "parameters"]) || value.status !== "recorded") return null;
    const text = input(value.input), audio = parameters(value.parameters);
    return text && audio ? { status: "recorded", input: text, parameters: audio } : null;
}
const intentKey = (value: AudioGenerationIntent) => JSON.stringify(value);

/** Account-bound Speech requests. Quotes are single-use confirmations; recovery is GET only. */
export function createAudioGenerationClient(options: { scope: AudioGenerationScope; getScope: () => AudioGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ accountId: options.scope.accountId, epoch: options.scope.epoch }), fetcher = options.fetcher ?? fetch;
    if (!name(scope.accountId) || scope.accountId.length > 200 || !Number.isSafeInteger(scope.epoch) || scope.epoch < 0) throw invalid();
    const catalog = new Map<string, AudioGenerationModel>();
    const issued = new WeakMap<AudioGenerationQuote, { input: AudioGenerationIntent; sequence: number }>();
    const consumed = new WeakSet<AudioGenerationQuote>();
    const attempts = new Map<string, { input: AudioGenerationIntent; quote: AudioGenerationQuote }>();
    const knownTasks = new Map<string, { input: AudioGenerationIntent; quote: AudioGenerationQuote }>();
    let invalidated = false, catalogSequence = 0;
    function check(outcome: "not-sent" | "unknown") {
        const current = options.getScope();
        if (invalidated || !current || current.accountId !== scope.accountId || current.epoch !== scope.epoch) {
            invalidated = true;
            throw new GenerationError("context_changed", "账号或登录权限已变化，请在原账号中重新打开回执核对。", outcome);
        }
    }
    function checkSignal(signal: AbortSignal | undefined, writing: boolean) {
        if (signal?.aborted) throw new GenerationError("aborted", writing ? "提交已中断，请保留回执并主动核对。" : "读取已取消，请保留回执。", writing ? "unknown" : "not-sent");
    }
    async function request(path: string, body?: object, idempotencyKey?: string, signal?: AbortSignal): Promise<unknown> {
        const writing = idempotencyKey !== undefined;
        check("not-sent"); checkSignal(signal, false);
        let response: Response, data: unknown;
        try {
            response = await fetcher(path, {
                method: body ? "POST" : "GET", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}),
                    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            check(writing ? "unknown" : "not-sent"); checkSignal(signal, writing);
            data = await response.json();
            check(writing ? "unknown" : "not-sent"); checkSignal(signal, writing);
        } catch (error) {
            check(writing ? "unknown" : "not-sent"); checkSignal(signal, writing);
            if (error instanceof GenerationError) throw error;
            throw unknownResult(writing);
        }
        if (!response.ok) {
            const code = record(data) && record(data.error) ? data.error.code : undefined;
            const errors: Record<string, [number, string]> = {
                invalid_input: [400, "音频请求格式不正确。"], unsupported_generation: [400, "当前模型或参数尚不支持平台语音生成。"],
                idempotency_required: [400, "缺少音频生成回执编号。"], idempotency_invalid: [400, "音频生成回执编号无效。"],
                account_context_required: [400, "页面账号与登录状态不一致，请重新确认账号。"], account_changed: [409, "页面账号与登录状态不一致，请重新确认账号。"],
                unauthorized: [401, "登录已失效，请重新登录后核对回执。"], forbidden: [403, "当前账号无权执行此操作。"],
                invalid_origin: [403, "请求来源不匹配，请联系管理员。"], not_found: [404, "尚未查到任务；请保留回执稍后核对，勿重复提交。"],
                insufficient_balance: [402, "可用积分不足，本次未创建任务。"], price_changed: [409, "报价已变化，本次未创建任务，请重新查看并确认费用。"],
                idempotency_conflict: [409, "此回执已用于另一请求，请保留回执核对。"], generation_unavailable: [503, "平台语音生成暂未开放或当前模型不可用。"],
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
    function selected(value: AudioGenerationIntent): AudioGenerationModel {
        const model = catalog.get(value.modelId);
        if (!model) throw catalogError();
        if (!model.audio.formats.includes(value.parameters.format) || !model.audio.voices.includes(value.parameters.voice) ||
            !model.audio.instructions && !!(value.parameters.style?.trim() || value.parameters.language?.trim())) throw invalid();
        return model;
    }
    function matches(view: AudioGenerationTaskView, binding: { input: AudioGenerationIntent; quote: AudioGenerationQuote }, writing: boolean) {
        if (view.task.modelId !== binding.input.modelId || view.task.priceVersion !== binding.quote.priceVersion || view.task.quotedUnits !== binding.quote.quotedUnits ||
            view.task.creditsPerUnitSnapshot !== binding.quote.creditsPerUnit || view.task.audioSnapshot.status !== "recorded" ||
            intentKey({ modelId: view.task.modelId, input: view.task.audioSnapshot.input, parameters: view.task.audioSnapshot.parameters }) !== intentKey(binding.input)) throw unknownResult(writing);
    }
    function view(data: unknown, writing: boolean, taskId?: string): AudioGenerationTaskView {
        const task = record(data) ? data.task : undefined, result = record(data) ? data.result : undefined;
        if (!record(task) || !uuid(task.id) || taskId !== undefined && task.id !== taskId || task.projectId !== null || task.nodeId !== null || !modelId(task.modelId) ||
            !positive(task.priceVersion) || !positive(task.quotedUnits) || task.billingUnitSnapshot !== "request" || !positive(task.creditsPerUnitSnapshot) || task.quotedUnits !== task.creditsPerUnitSnapshot ||
            !["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"].includes(String(task.executionStatus)) ||
            !["pending", "saved", "visible", "failed", "unknown"].includes(String(task.deliveryStatus)) ||
            !["unbilled", "reserved", "captured", "released", "pending_review"].includes(String(task.billingStatus))) throw unknownResult(writing);
        const audioSnapshot = history(task.audioSnapshot);
        if (!audioSnapshot) throw unknownResult(writing);
        let billing: AudioGenerationTaskView["task"]["billing"];
        if (Object.hasOwn(task, "billing")) {
            if (task.billing === null) billing = null;
            else {
                const value = task.billing;
                if (!record(value) || !amount(value.reservedCredits) || !amount(value.capturedCredits) || !amount(value.releasedCredits) || value.reservedCredits !== String(task.quotedUnits)) throw unknownResult(writing);
                try { if (compareCreditAmounts(addCreditAmounts(value.capturedCredits, value.releasedCredits), value.reservedCredits) > 0) throw unknownResult(writing); }
                catch { throw unknownResult(writing); }
                billing = { reservedCredits: value.reservedCredits, capturedCredits: value.capturedCredits, releasedCredits: value.releasedCredits };
            }
        }
        let safeResult: AudioGenerationTaskView["result"] = null;
        if (result !== null) {
            if (!record(result) || result.taskId !== task.id || !["succeeded", "failed", "unknown"].includes(String(result.status)) || !record(result.resultSnapshot)) throw unknownResult(writing);
            const raw = result.resultSnapshot, safe: NonNullable<AudioGenerationTaskView["result"]>["resultSnapshot"] = {};
            if (raw.kind !== undefined && raw.kind !== "audio" || result.status === "succeeded" && (raw.kind !== "audio" || audioSnapshot.status !== "recorded")) throw unknownResult(writing);
            if (raw.kind === "audio") safe.kind = "audio";
            if (Object.hasOwn(raw, "media")) {
                const media = raw.media;
                if (!record(media) || !uuid(media.mediaId) || media.mediaId !== task.id || media.kind !== "audio" || raw.kind !== "audio" || !positive(media.sizeBytes) || !name(media.etag) || media.etag.length > 200 ||
                    audioSnapshot.status !== "recorded" || media.contentType !== (audioSnapshot.parameters.format === "mp3" ? "audio/mpeg" : "audio/wav")) throw unknownResult(writing);
                const contentType: AudioGenerationMedia["contentType"] = audioSnapshot.parameters.format === "mp3" ? "audio/mpeg" : "audio/wav";
                safe.media = { mediaId: media.mediaId, kind: "audio", contentType, sizeBytes: media.sizeBytes, etag: media.etag };
            }
            if (Object.hasOwn(raw, "usageEvidence")) {
                if (!fields(raw.usageEvidence, ["status", "source"]) || raw.usageEvidence.status !== "missing" ||
                    raw.usageEvidence.source !== "audio_speech_binary" && raw.usageEvidence.source !== "audio_chat_data_uri") throw unknownResult(writing);
                safe.usageEvidence = { status: "missing", source: raw.usageEvidence.source };
            }
            if (Object.hasOwn(raw, "technicalAudio")) {
                const technical = raw.technicalAudio;
                if (!record(technical) || technical.source !== "decoded_samples" || !positive(technical.samplesPerChannel) || !positive(technical.sampleRate) || !positive(technical.channels) ||
                    typeof technical.durationSeconds !== "number" || !Number.isFinite(technical.durationSeconds) || technical.durationSeconds <= 0 ||
                    technical.durationSeconds !== technical.samplesPerChannel / technical.sampleRate) throw unknownResult(writing);
                safe.technicalAudio = { source: "decoded_samples", samplesPerChannel: technical.samplesPerChannel, sampleRate: technical.sampleRate, channels: technical.channels, durationSeconds: technical.durationSeconds };
            }
            safeResult = { taskId: task.id, status: result.status as NonNullable<AudioGenerationTaskView["result"]>["status"], resultSnapshot: safe };
        }
        if ((task.deliveryStatus === "saved" || task.deliveryStatus === "visible") && !safeResult?.resultSnapshot.media) throw unknownResult(writing);
        return { task: { id: task.id, projectId: null, nodeId: null, modelId: task.modelId, priceVersion: task.priceVersion, quotedUnits: task.quotedUnits,
            billingUnitSnapshot: "request", creditsPerUnitSnapshot: task.creditsPerUnitSnapshot, audioSnapshot,
            executionStatus: task.executionStatus as AudioGenerationTaskView["task"]["executionStatus"], deliveryStatus: task.deliveryStatus as AudioGenerationTaskView["task"]["deliveryStatus"],
            billingStatus: task.billingStatus as AudioGenerationTaskView["task"]["billingStatus"], ...(Object.hasOwn(task, "billing") ? { billing } : {}) }, result: safeResult };
    }
    return Object.freeze({
        async models(signal?: AbortSignal): Promise<AudioGenerationModel[]> {
            const sequence = ++catalogSequence; catalog.clear();
            const data = await request("/api/v1/generation/audio/models", undefined, undefined, signal); check("not-sent");
            if (!record(data) || !Array.isArray(data.items)) throw unknownResult(false);
            const seen = new Set<string>();
            const models: AudioGenerationModel[] = data.items.map(item => {
                if (!record(item) || !modelId(item.id) || seen.has(item.id) || !name(item.displayName) || item.capability !== "audio") throw unknownResult(false);
                seen.add(item.id);
                const group = item.group, audio = item.audio, pricing = item.audioPricing;
                if (group !== null && (!record(group) || !uuid(group.id) || !name(group.name) || group.name.length > 120 || !Number.isSafeInteger(group.order) || (group.order as number) < 0) ||
                    !record(audio) || !Array.isArray(audio.formats) || !audio.formats.length || audio.formats.some(format => format !== "mp3" && format !== "wav") || new Set(audio.formats).size !== audio.formats.length ||
                    !Array.isArray(audio.voices) || !audio.voices.length || audio.voices.some(voice => !name(voice)) || new Set(audio.voices).size !== audio.voices.length || typeof audio.instructions !== "boolean" ||
                    !record(pricing) || !positive(pricing.priceVersion) || pricing.billingUnit !== "request" || !positive(pricing.creditsPerUnit) || pricing.priceNote !== undefined && typeof pricing.priceNote !== "string") throw unknownResult(false);
                return { id: item.id, displayName: item.displayName, capability: "audio", group: group === null ? null : { id: group.id as string, name: group.name as string, order: group.order as number },
                    audio: { formats: [...audio.formats] as AudioGenerationFormat[], voices: [...audio.voices] as string[], instructions: audio.instructions },
                    audioPricing: { priceVersion: pricing.priceVersion, billingUnit: "request", creditsPerUnit: pricing.creditsPerUnit, ...(pricing.priceNote === undefined ? {} : { priceNote: pricing.priceNote }) } };
            });
            if (sequence !== catalogSequence) throw catalogError();
            for (const model of models) catalog.set(model.id, structuredClone(model));
            return models;
        },
        async quote(value: AudioGenerationIntent, signal?: AbortSignal): Promise<AudioGenerationQuote> {
            check("not-sent");
            const confirmedInput = intent(value), model = selected(confirmedInput), sequence = catalogSequence;
            const data = await request("/api/v1/generation/audio/quote", confirmedInput, undefined, signal); check("not-sent");
            const quote = record(data) ? data.quote : undefined;
            if (!record(quote) || quote.modelId !== confirmedInput.modelId || !positive(quote.priceVersion) || !positive(quote.creditsPerUnit) || !positive(quote.quotedUnits) || quote.billingUnit !== "request" ||
                quote.quotedUnits !== quote.creditsPerUnit || !fingerprint(quote.quoteFingerprint) || quote.priceNote !== undefined && typeof quote.priceNote !== "string") throw unknownResult(false);
            if (sequence !== catalogSequence || !catalog.has(model.id) || quote.priceVersion !== model.audioPricing.priceVersion || quote.creditsPerUnit !== model.audioPricing.creditsPerUnit) throw catalogError();
            const safe: AudioGenerationQuote = Object.freeze({ modelId: quote.modelId, priceVersion: quote.priceVersion, billingUnit: "request", creditsPerUnit: quote.creditsPerUnit,
                quotedUnits: quote.quotedUnits, quoteFingerprint: quote.quoteFingerprint, ...(quote.priceNote === undefined ? {} : { priceNote: quote.priceNote }) });
            issued.set(safe, { input: confirmedInput, sequence });
            return safe;
        },
        async submit(value: AudioGenerationIntent, confirmedQuote: AudioGenerationQuote, idempotencyKey: string, signal?: AbortSignal): Promise<AudioGenerationTaskView> {
            check("not-sent"); checkSignal(signal, false);
            if (!key(idempotencyKey)) throw invalid();
            const confirmedInput = intent(value), confirmation = issued.get(confirmedQuote);
            if (!confirmation || intentKey(confirmation.input) !== intentKey(confirmedInput) || confirmation.sequence !== catalogSequence) throw confirmationError();
            selected(confirmedInput);
            if (attempts.has(idempotencyKey) || consumed.has(confirmedQuote)) throw new GenerationError("already_submitted", "这次确认已提交，请使用原回执主动核对，不要重复生成。", "unknown");
            const binding = { input: confirmedInput, quote: confirmedQuote };
            attempts.set(idempotencyKey, binding); consumed.add(confirmedQuote);
            const result = view(await request("/api/v1/generation/audio/tasks", { ...confirmedInput, confirmedPriceVersion: confirmedQuote.priceVersion,
                confirmedQuoteFingerprint: confirmedQuote.quoteFingerprint }, idempotencyKey, signal), true); check("unknown");
            matches(result, binding, true); knownTasks.set(result.task.id, binding);
            return result;
        },
        async get(taskId: string, signal?: AbortSignal): Promise<AudioGenerationTaskView> {
            if (!uuid(taskId)) throw invalid();
            const result = view(await request(`/api/v1/generation/tasks/${taskId}`, undefined, undefined, signal), false, taskId); check("not-sent");
            const binding = knownTasks.get(taskId); if (binding) matches(result, binding, false);
            return result;
        },
        async recover(idempotencyKey: string, signal?: AbortSignal): Promise<AudioGenerationTaskView> {
            if (!key(idempotencyKey)) throw invalid();
            const result = view(await request(`/api/v1/generation/tasks/by-key/${encodeURIComponent(idempotencyKey)}`, undefined, undefined, signal), false); check("not-sent");
            const binding = attempts.get(idempotencyKey);
            if (binding) { matches(result, binding, false); knownTasks.set(result.task.id, binding); }
            return result;
        },
    });
}

export type AudioGenerationClient = ReturnType<typeof createAudioGenerationClient>;
