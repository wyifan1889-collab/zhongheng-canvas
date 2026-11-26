import { publishedGeminiImagePrice, type PublishedGeminiImagePrice } from "./gemini-image-price-trial";
export { publishedGeminiImagePrice, type PublishedGeminiImagePrice } from "./gemini-image-price-trial";
import { evaluatePriceRule, normalizePriceAmount, parseModelPriceBinding, parseModelPriceRule, parseModelPriceRules, sameModelPriceBinding, type AdminModelPriceDraft, type ModelPriceBinding, type ModelPriceRules } from "./model-pricing-drafts";
import { parseVideoParameters, sameVideoParameters, VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoParameters } from "./generation-video";
import { contextTierRates } from "./model-price-derivation";
import { parseImageRequestPolicy } from "./generation-image-batch";
import { OPENAI_IMAGE_PROTOCOL, MAX_IMAGE_GENERATION_COUNT, parseImageSpecParameters, type ImageProtocol, type ImageSpecParameters } from "./generation-image-protocol";
export * from "./generation-image-protocol";

/** Publication uses an immutable saved draft; no submitted amount is accepted. */
export type ModelPricePublishWrite = {
    modelId: string; draftId: string; expectedDraftVersion: number; expectedPriceVersion: number;
    binding: ModelPriceBinding; publicPriceNote: string;
};
/** A single historical version owns all text rates; it has no scalar unit price. */
export type PublishedTextRates = {
    billingUnit: "text_tokens"; creditsPerUnit: null;
    inputCreditsPerMillion: string; outputCreditsPerMillion: string;
    /** When present, inputCreditsPerMillion applies only to non-cached input. */
    cachedInputCreditsPerMillion?: string;
};
export type PublishedScalarPrice = {
    billingUnit: "request" | "input_token" | "output_token" | "second" | "megapixel"; creditsPerUnit: number;
};
export type PublishedImageSpec = { parameters: ImageSpecParameters; creditsPerRequest: number };
/** The model has enumerated prices, while each accepted task keeps one request price. */
export type PublishedImageSpecPrice = { billingUnit: "image_specs"; creditsPerUnit: null; protocol: ImageProtocol; imageSpecs: PublishedImageSpec[] };
export type PublishedVideoSpec = { parameters: VideoParameters; creditsPerVideo: number };
export type PublishedVideoSpecPrice = { billingUnit: "video_specs"; creditsPerUnit: null; protocol: typeof VIDEO_PROTOCOL; usagePolicy: typeof VIDEO_USAGE_POLICY; videoSpecs: PublishedVideoSpec[] };
export type PublishedPrice = { billingUnit: "request"; creditsPerUnit: number } | PublishedTextRates | PublishedImageSpecPrice | PublishedGeminiImagePrice | PublishedVideoSpecPrice;
export type AdminModelPricePublication = {
    id: string; modelId: string; draftId: string; draftVersion: number; priceVersion: number;
    publicPriceNote: string;
    /** Private configuration snapshot, not actual supplier usage or a profit record. */
    rules: ModelPriceRules; binding: ModelPriceBinding; bindingMatchesCurrent: boolean; createdAt: string;
} & PublishedPrice;
export type PricePublicationUnavailableReason = "draft_missing" | "model_binding_changed" | "model_not_publishable" | "unsupported_price_rule";
export type ModelPricePublicationPreview = {
    modelId: string; draft: AdminModelPriceDraft | null; latestPriceVersion: number;
    currentPrice: ({ version: number; enabled: boolean } & (PublishedScalarPrice | PublishedTextRates | PublishedImageSpecPrice | PublishedGeminiImagePrice | PublishedVideoSpecPrice)) | null;
    publication: AdminModelPricePublication | null; unavailableReason: PricePublicationUnavailableReason | null;
};

/** Public price DTO only. Model/publication metadata is discarded without inventing a private binding. */
export function parsePublishedVideoSpecPrice(value: unknown): PublishedVideoSpecPrice | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>, fields = ["billingUnit", "creditsPerUnit", "protocol", "usagePolicy", "videoSpecs"];
    if (!fields.every(key => Object.hasOwn(row, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, "value")) ||
        row.billingUnit !== "video_specs" || row.creditsPerUnit !== null || row.protocol !== VIDEO_PROTOCOL || row.usagePolicy !== VIDEO_USAGE_POLICY ||
        !Array.isArray(row.videoSpecs) || !row.videoSpecs.length ||
        ["imageSpecs", "inputCreditsPerMillion", "outputCreditsPerMillion", "cachedInputCreditsPerMillion"].some(key => Object.hasOwn(row, key))) return null;
    const dataObject = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item) &&
        Reflect.ownKeys(item).every(key => typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(item, key)!, "value"));
    const videoSpecs: PublishedVideoSpec[] = [];
    for (const item of row.videoSpecs) {
        if (!dataObject(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, "parameters") || !Object.hasOwn(item, "creditsPerVideo") ||
            !Number.isSafeInteger(item.creditsPerVideo) || (item.creditsPerVideo as number) <= 0) return null;
        const rawParameters = item.parameters;
        if (!dataObject(rawParameters) || !["mode", "resolution", "durationSeconds", "generateAudio"].every(key => Object.hasOwn(rawParameters, key))) return null;
        const parameters = parseVideoParameters(rawParameters);
        if (!parameters) return null;
        videoSpecs.push({ parameters, creditsPerVideo: item.creditsPerVideo as number });
    }
    // Reuse the original predicate parser's complete all-band non-overlap rule, without cost or channel assumptions.
    const rule = parseModelPriceRule({ template: "video_count", currency: "credit", bands: videoSpecs.map(item => ({
        parameters: Object.fromEntries(Object.entries(item.parameters).map(([key, value]) => [key, String(value)])),
        rates: { video: String(item.creditsPerVideo) },
    })) }, "video", "sale");
    return rule ? { billingUnit: "video_specs", creditsPerUnit: null, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, videoSpecs } : null;
}

/** Band order and metadata do not change a price; every complete specification and its amount must match. */
export function samePublishedVideoSpecPrice(left: unknown, right: unknown): boolean {
    const a = parsePublishedVideoSpecPrice(left), b = parsePublishedVideoSpecPrice(right);
    return !!a && !!b && a.protocol === b.protocol && a.usagePolicy === b.usagePolicy && a.videoSpecs.length === b.videoSpecs.length &&
        a.videoSpecs.every(item => b.videoSpecs.some(other => sameVideoParameters(item.parameters, other.parameters) && item.creditsPerVideo === other.creditsPerVideo));
}

export function parseModelPricePublishWrite(value: unknown): ModelPricePublishWrite | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const fields = ["modelId", "draftId", "expectedDraftVersion", "expectedPriceVersion", "binding", "publicPriceNote"];
    if (Object.keys(row).length !== fields.length || !fields.every((key) => Object.hasOwn(row, key)) ||
        typeof row.modelId !== "string" || !row.modelId || row.modelId.trim() !== row.modelId || /[\u0000-\u001f\u007f]/.test(row.modelId) ||
        typeof row.draftId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.draftId) ||
        !Number.isSafeInteger(row.expectedDraftVersion) || (row.expectedDraftVersion as number) <= 0 ||
        !Number.isSafeInteger(row.expectedPriceVersion) || (row.expectedPriceVersion as number) < 0 || typeof row.publicPriceNote !== "string") return null;
    const binding = parseModelPriceBinding(row.binding);
    return binding ? { modelId: row.modelId, draftId: row.draftId, expectedDraftVersion: row.expectedDraftVersion as number,
        expectedPriceVersion: row.expectedPriceVersion as number, binding, publicPriceNote: row.publicPriceNote } : null;
}

/** Exact acceptance into the existing positive-integer request ledger. Never rounds a draft price. */
export function executableImageDraftCredits(binding: ModelPriceBinding, value: unknown): number | null {
    const rules = parseModelPriceRules(value, binding.capability);
    if (binding.capability !== "image" || binding.adapter !== "openai-compatible" || !rules || rules.sale.template !== "image_request" ||
        rules.sale.currency !== "credit" || rules.sale.bands.length !== 1 || Object.keys(rules.sale.bands[0].parameters).length !== 0 || rules.derivation && !sameModelPriceBinding(rules.derivation.binding, binding)) return null;
    const amount = rules.sale.bands[0].rates.request;
    if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) return null;
    const credits = Number(amount);
    return Number.isSafeInteger(credits) && credits > 0 ? credits : null;
}

/** Platform fixed sale per delivered TTS task; this is not provider-reported usage. */
export function executableAudioDraftCredits(binding: ModelPriceBinding, value: unknown): number | null {
    const rules = parseModelPriceRules(value, binding.capability);
    if (binding.capability !== "audio" || binding.adapter !== "openai-compatible" || !rules || rules.sale.template !== "audio_request" ||
        rules.sale.currency !== "credit" || rules.sale.bands.length !== 1 || Object.keys(rules.sale.bands[0].parameters).length !== 0 ||
        rules.derivation && !sameModelPriceBinding(rules.derivation.binding, binding)) return null;
    const amount = rules.sale.bands[0].rates.request;
    if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) return null;
    const credits = Number(amount);
    return Number.isSafeInteger(credits) && credits > 0 ? credits : null;
}

/** Official Images API counts; unverified model aliases retain single-image execution. */
export function imageModelMaxCount(providerModel: string, policy?: unknown): number {
    if (parseImageRequestPolicy(policy)) return MAX_IMAGE_GENERATION_COUNT;
    return /^(?:gpt-image-(?:1-mini|1\.5|2(?:-2026-04-21)?|2\.[56]-(?:sunburst|flare)(?:-\d{4}-\d{2}-\d{2})?)|chatgpt-image-latest)$/.test(providerModel)
        ? MAX_IMAGE_GENERATION_COUNT : 1;
}

/** Public projection of every saved sale band, or no rule publication at all. */
export function publishedImageSpecDraftPrice(binding: ModelPriceBinding, value: unknown): PublishedImageSpecPrice | null {
    const rules = parseModelPriceRules(value, binding.capability);
    if (binding.capability !== "image" || binding.adapter !== "openai-compatible" || !rules || rules.sale.template !== "image_request" ||
        rules.sale.currency !== "credit" || rules.derivation && !sameModelPriceBinding(rules.derivation.binding, binding)) return null;
    const imageSpecs: PublishedImageSpec[] = [];
    for (const band of rules.sale.bands) {
        const parameters = parseImageSpecParameters(band.parameters), amount = band.rates.request;
        if (!parameters || typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) return null;
        const creditsPerRequest = Number(amount);
        if (!Number.isSafeInteger(creditsPerRequest) || creditsPerRequest <= 0) return null;
        imageSpecs.push({ parameters, creditsPerRequest });
    }
    return { billingUnit: "image_specs", creditsPerUnit: null, protocol: OPENAI_IMAGE_PROTOCOL, imageSpecs };
}

/** Exact selection is deliberately narrower than the saved draft's predicate semantics. */
export function selectImageSpecPrice(price: PublishedImageSpecPrice, parameters: unknown): PublishedImageSpec | null {
    const selected = parseImageSpecParameters(parameters);
    if (!selected || !price || price.billingUnit !== "image_specs" || price.creditsPerUnit !== null || price.protocol !== OPENAI_IMAGE_PROTOCOL ||
        !["billingUnit", "creditsPerUnit", "protocol", "imageSpecs"].every((key) => Object.hasOwn(price, key)) ||
        !Array.isArray(price.imageSpecs) || !price.imageSpecs.length) return null;
    const matches: PublishedImageSpec[] = [];
    for (const spec of price.imageSpecs) {
        if (!spec || typeof spec !== "object" || Object.keys(spec).length !== 2 ||
            !Object.hasOwn(spec, "parameters") || !Object.hasOwn(spec, "creditsPerRequest")) return null;
        const parsed = parseImageSpecParameters(spec.parameters);
        if (!parsed || !Number.isSafeInteger(spec.creditsPerRequest) || spec.creditsPerRequest <= 0) return null;
        if (Object.keys(parsed).length === Object.keys(selected).length &&
            Object.keys(parsed).every((key) => parsed[key as keyof ImageSpecParameters] === selected[key as keyof ImageSpecParameters])) {
            matches.push({ parameters: parsed, creditsPerRequest: spec.creditsPerRequest });
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

/** Revalidate exact selection using the actual immutable source rule and its original evaluator. */
export function resolveImageSpecDraftSelection(binding: ModelPriceBinding, value: unknown, parameters: unknown): PublishedImageSpec | null {
    const price = publishedImageSpecDraftPrice(binding, value), rules = parseModelPriceRules(value, binding.capability);
    const selected = price && selectImageSpecPrice(price, parameters);
    if (!rules || !selected) return null;
    const pricedParameters: Record<string, string> = {};
    if (selected.parameters.size !== undefined) pricedParameters.size = selected.parameters.size;
    if (selected.parameters.quality !== undefined) pricedParameters.quality = selected.parameters.quality;
    const result = evaluatePriceRule(rules.sale, pricedParameters, { request: "1" });
    return result.status === "calculated" && result.total === String(selected.creditsPerRequest) ? selected : null;
}

/** Draft predicates use strings; executable video specifications require every canonical field. */
function videoParametersFromBand(value: Record<string, string>): VideoParameters | null {
    if (value.generateAudio !== "true" && value.generateAudio !== "false" ||
        !/^[1-9][0-9]*$/.test(value.durationSeconds ?? "")) return null;
    return parseVideoParameters({ ...value, generateAudio: value.generateAudio === "true", durationSeconds: Number(value.durationSeconds) });
}

/** All bands must use the explicit video protocol and lossless, positive integer per-delivery sale. */
export function publishedVideoSpecDraftPrice(binding: ModelPriceBinding, value: unknown): PublishedVideoSpecPrice | null {
    const rules = parseModelPriceRules(value, binding.capability);
    if (binding.capability !== "video" || binding.adapter !== "openai-compatible" || !rules?.video ||
        rules.sale.template !== "video_count" || rules.sale.currency !== "credit" ||
        rules.derivation && !sameModelPriceBinding(rules.derivation.binding, binding)) return null;
    // This execution profile requires an administrator's explicit /v1 API root.
    if (!parseModelPriceBinding(binding)) return null;
    try { if (!/\/v1\/?$/.test(new URL(binding.endpoint).pathname)) return null; } catch { return null; }
    const videoSpecs: PublishedVideoSpec[] = [];
    for (const band of rules.sale.bands) {
        const parameters = videoParametersFromBand(band.parameters), amount = band.rates.video;
        if (!parameters || typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) return null;
        const creditsPerVideo = Number(amount);
        if (!Number.isSafeInteger(creditsPerVideo) || creditsPerVideo <= 0) return null;
        videoSpecs.push({ parameters, creditsPerVideo });
    }
    return { billingUnit: "video_specs", creditsPerUnit: null, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, videoSpecs };
}

export function selectVideoSpecPrice(price: PublishedVideoSpecPrice, parameters: unknown): PublishedVideoSpec | null {
    const selected = parseVideoParameters(parameters);
    if (!selected || !price || price.billingUnit !== "video_specs" || price.creditsPerUnit !== null ||
        price.protocol !== VIDEO_PROTOCOL || price.usagePolicy !== VIDEO_USAGE_POLICY ||
        !["billingUnit", "creditsPerUnit", "protocol", "usagePolicy", "videoSpecs"].every(key => Object.hasOwn(price, key)) ||
        !Array.isArray(price.videoSpecs) || !price.videoSpecs.length) return null;
    const matches: PublishedVideoSpec[] = [];
    for (const spec of price.videoSpecs) {
        if (!spec || typeof spec !== "object" || Object.keys(spec).length !== 2 ||
            !Object.hasOwn(spec, "parameters") || !Object.hasOwn(spec, "creditsPerVideo")) return null;
        const parsed = parseVideoParameters(spec.parameters);
        if (!parsed || !Number.isSafeInteger(spec.creditsPerVideo) || spec.creditsPerVideo <= 0) return null;
        if (Object.keys(parsed).length === Object.keys(selected).length && Object.entries(parsed).every(([key, item]) => selected[key as keyof VideoParameters] === item)) {
            matches.push({ parameters: parsed, creditsPerVideo: spec.creditsPerVideo });
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

/** Select again against the immutable rules; current catalog defaults never reconstruct an old price. */
export function resolveVideoSpecDraftSelection(binding: ModelPriceBinding, value: unknown, parameters: unknown): PublishedVideoSpec | null {
    const price = publishedVideoSpecDraftPrice(binding, value), rules = parseModelPriceRules(value, binding.capability);
    const selected = price && selectVideoSpecPrice(price, parameters);
    if (!rules || !selected) return null;
    const pricedParameters = Object.fromEntries(Object.entries(selected.parameters).map(([key, item]) => [key, String(item)]));
    const result = evaluatePriceRule(rules.sale, pricedParameters, { video: "1" });
    return result.status === "calculated" && result.total === String(selected.creditsPerVideo) ? selected : null;
}

/** Immutable text publication; execution also requires a confirmed reservation budget. */
export function publishedTextDraftRates(binding: ModelPriceBinding, value: unknown): PublishedTextRates | null {
    const rules = parseModelPriceRules(value, binding.capability);
    if (binding.capability !== "text" || !["openai-compatible", "sub2api"].includes(binding.adapter) || !rules ||
        !["text_tokens", "text_cached_tokens"].includes(rules.sale.template) || rules.sale.currency !== "credit" ||
        rules.sale.bands.length !== 1 || Object.keys(rules.sale.bands[0].parameters).length !== 0 || rules.derivation && !sameModelPriceBinding(rules.derivation.binding, binding)) return null;
    const { input_token: input, output_token: output, cached_input_token: cached } = rules.sale.bands[0].rates;
    // The draft parser canonicalizes exact nonnegative strings. Zero-priced components remain draft-only.
    if (typeof input !== "string" || input === "0" || typeof output !== "string" || output === "0") return null;
    if (rules.sale.template === "text_cached_tokens" && (typeof cached !== "string" || cached === "0")) return null;
    if (rules.derivation?.schemaVersion === 2 && !contextTierRates(rules.derivation)) return null;
    return { billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: input, outputCreditsPerMillion: output,
        ...(rules.sale.template === "text_cached_tokens" ? { cachedInputCreditsPerMillion: cached! } : {}) };
}

/** Public explanation of ONE frozen publication. Never put this in the strict v1 task quote. */
export type TextPriceDerivationMetadata = {
    priceVersion: number; saleMultiplier: string; creditsPerCurrency: "100";
    currency: "USD"; unit: "million_tokens"; sourceId: "openai" | "anthropic";
    sourceVersion: number; checkedAt: string; entryId: string;
    officialPrices: { input: string; cachedInput: string; output: string };
};
export type TextPriceEligibility = { status: "available"; rates: PublishedTextRates; metadata: TextPriceDerivationMetadata } |
    { status: "unavailable"; reason: "official_three_bucket_required" | "zero_rate_unsupported" };

/** New admissions only. Historical publication parsing and accepted task recovery stay unchanged. */
export function newTextPriceEligibility(binding: ModelPriceBinding, value: unknown, priceVersion: number): TextPriceEligibility {
    const unavailable = { status: "unavailable", reason: "official_three_bucket_required" } as const;
    const rules = parseModelPriceRules(value, binding.capability), origin = rules?.derivation;
    if (!rules || binding.capability !== "text" || !origin || origin.source.kind !== "official" ||
        rules.sale.template !== "text_cached_tokens" || origin.basis.template !== "text_cached_tokens" ||
        origin.basis.currency !== "USD" || origin.creditsPerCurrency !== "100" ||
        !sameModelPriceBinding(origin.binding, binding) || !Number.isSafeInteger(priceVersion) || priceVersion <= 0) return unavailable;
    const { input_token: input, cached_input_token: cachedInput, output_token: output } = origin.basis.bands[0].rates;
    if (input == null || cachedInput == null || output == null) return unavailable;
    if ([input, cachedInput, output].includes("0")) return { status: "unavailable", reason: "zero_rate_unsupported" };
    if (origin.schemaVersion === 2 && !contextTierRates(origin)) return { status: "unavailable", reason: "zero_rate_unsupported" };
    const rates = publishedTextDraftRates(binding, rules);
    if (!rates || rates.cachedInputCreditsPerMillion === undefined) return unavailable;
    return { status: "available", rates, metadata: {
        priceVersion, saleMultiplier: origin.saleMultiplier, creditsPerCurrency: "100", currency: "USD", unit: "million_tokens",
        sourceId: origin.source.sourceId, sourceVersion: origin.source.version, checkedAt: origin.source.checkedAt,
        entryId: origin.source.entry.id, officialPrices: { input, cachedInput, output },
    } };
}

/** Mandatory public explanation is deterministic from the saved contract, never a current price lookup. */
export function textContextTierNote(value: unknown, binding: ModelPriceBinding): string | null {
    const rules = parseModelPriceRules(value, binding.capability), origin = rules?.derivation;
    if (!origin || origin.schemaVersion !== 2 || !sameModelPriceBinding(origin.binding, binding)) return null;
    const rates = contextTierRates(origin);
    if (!rates) return null;
    const line = (name: string, rate: typeof rates.short) => `${name}：非缓存输入 ${rate.inputCreditsPerMillion}、缓存读取 ${rate.cachedInputCreditsPerMillion}、输出 ${rate.outputCreditsPerMillion} 积分 / 百万 Token。`;
    return ["超过272K按长档计价。本平台按本次输入与输出总量（T=I+O）判档：272000 Token及以下用短档，超过272000 Token整个用量用长档；缓存读取包含在输入，推理包含在输出，不重复累加。",
        line("短档", rates.short), line("长档", rates.long),
        "先按确认预算冻结积分；实际费用在预算内自动扣费并退回余款，超过预算不追加冻结或扣款，费用待核对。须明确缓存读取和写入计数且写入为0，否则费用待核对。"].join("\n");
}

/** Admin submits this complete string; server validates and stores it unchanged, including on replay. */
export function composeTextContextTierNote(value: unknown, binding: ModelPriceBinding, adminNote: string): string | null {
    const prefix = textContextTierNote(value, binding);
    if (prefix === null || typeof adminNote !== "string") return null;
    const manual = adminNote.trim();
    if (manual === prefix || manual.startsWith(prefix + "\n\n")) return manual;
    return prefix + (manual ? "\n\n" + manual : "");
}

export function validTextContextTierNote(value: unknown, binding: ModelPriceBinding, note: unknown): boolean {
    const prefix = textContextTierNote(value, binding);
    return prefix !== null && typeof note === "string" && (note === prefix || note.startsWith(prefix + "\n\n") && note.slice(prefix.length + 2).trim().length > 0);
}

/** Reconstruct a whitelist and require the surrounding price's version. No private fields survive. */
export function parseTextPriceDerivationMetadata(value: unknown, priceVersion: number): TextPriceDerivationMetadata | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>, base = row.officialPrices;
    const positive = (amount: unknown): amount is string => typeof amount === "string" && normalizePriceAmount(amount) === amount && amount !== "0";
    if (!Number.isSafeInteger(priceVersion) || priceVersion <= 0 || row.priceVersion !== priceVersion ||
        !positive(row.saleMultiplier) || row.creditsPerCurrency !== "100" || row.currency !== "USD" || row.unit !== "million_tokens" ||
        (row.sourceId !== "openai" && row.sourceId !== "anthropic") || !Number.isSafeInteger(row.sourceVersion) || Number(row.sourceVersion) <= 0 ||
        typeof row.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(row.checkedAt) || !Number.isFinite(Date.parse(row.checkedAt)) ||
        typeof row.entryId !== "string" || !row.entryId.startsWith(`${row.sourceId}:`) ||
        !base || typeof base !== "object" || Array.isArray(base)) return null;
    const prices = base as Record<string, unknown>;
    if (!positive(prices.input) || !positive(prices.cachedInput) || !positive(prices.output)) return null;
    return { priceVersion, saleMultiplier: row.saleMultiplier, creditsPerCurrency: "100", currency: "USD", unit: "million_tokens",
        sourceId: row.sourceId, sourceVersion: row.sourceVersion as number, checkedAt: row.checkedAt, entryId: row.entryId,
        officialPrices: { input: prices.input, cachedInput: prices.cachedInput, output: prices.output } };
}

export function publishedDraftPrice(binding: ModelPriceBinding, value: unknown): PublishedPrice | null {
    if (binding.capability === "video") return publishedVideoSpecDraftPrice(binding, value);
    const textRates = publishedTextDraftRates(binding, value);
    if (textRates) return textRates;
    const credits = binding.capability === "audio" ? executableAudioDraftCredits(binding, value) : executableImageDraftCredits(binding, value);
    return credits === null ? (publishedImageSpecDraftPrice(binding, value) ?? publishedGeminiImagePrice(binding, value)) : { billingUnit: "request", creditsPerUnit: credits };
}
