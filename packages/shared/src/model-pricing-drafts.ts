import { normalizeCnyAmount } from "./model-cny-pricing";
import { parseModelPriceDerivation, sameDerivedPriceRules, type ModelPriceDerivation } from "./model-price-derivation";
import { parseVideoPricePolicy, type VideoPricePolicy } from "./generation-video";
import { parseImagePricePolicy, type ImagePricePolicy } from "./generation-image-protocol";
import { geminiImageBindingOptions, parseGeminiImageSpecification } from "./generation-gemini-image";

/** Administrator configuration only: none of these drafts authorize generation or billing. */
export type PricingCapability = "text" | "image" | "video" | "audio";
export type PriceMeter = "input_token" | "cached_input_token" | "output_token" | "image_input_token" | "image_output_token" | "request" | "image" | "second" | "video";
export type PriceTemplate = "text_tokens" | "text_cached_tokens" | "image_tokens" | "image_request" | "image_count" | "video_second" | "video_count" | "audio_request";
export type PriceCurrency = "CNY" | "USD" | "credit";
export type ModelPriceBinding = { providerId: string; providerModel: string; adapter: "openai-compatible" | "sub2api"; endpoint: string; capability: PricingCapability };
export type PriceDraftModel = { modelId: string; displayName: string; providerDisplayName: string; binding: ModelPriceBinding };
export type PriceBand = { parameters: Record<string, string>; rates: Partial<Record<PriceMeter, string | null>> };
export type ModelPriceRule = { template: PriceTemplate; currency: PriceCurrency; bands: PriceBand[] };
export type ModelPriceRules = { schemaVersion: 1; cost: ModelPriceRule | null; sale: ModelPriceRule; derivation?: ModelPriceDerivation; video?: VideoPricePolicy; image?: ImagePricePolicy };
export type ModelPriceDraftWrite = { modelId: string; expectedVersion: number; binding: ModelPriceBinding; rules: ModelPriceRules; priceNote: string };
export type AdminModelPriceDraft = Omit<ModelPriceDraftWrite, "expectedVersion"> & { id: string; version: number; bindingMatchesCurrent: boolean; createdAt: string };
export type AdminModelPriceDraftCatalog = { models: PriceDraftModel[]; items: AdminModelPriceDraft[] };

export const PRICE_METERS: Record<PriceMeter, { label: string; unit: string; base: number }> = {
    input_token: { label: "文本输入", unit: "百万 Token", base: 1_000_000 },
    cached_input_token: { label: "缓存读取", unit: "百万 Token", base: 1_000_000 },
    output_token: { label: "文本输出", unit: "百万 Token", base: 1_000_000 },
    image_input_token: { label: "图片输入", unit: "百万 Token", base: 1_000_000 },
    image_output_token: { label: "图片输出", unit: "百万 Token", base: 1_000_000 },
    request: { label: "成功任务", unit: "次", base: 1 }, image: { label: "成功交付图片", unit: "张", base: 1 },
    second: { label: "视频计费时长", unit: "秒", base: 1 }, video: { label: "成功交付视频", unit: "条", base: 1 },
};
export const PRICE_TEMPLATES: Record<PriceTemplate, { label: string; capability: PricingCapability; meters: PriceMeter[] }> = {
    text_tokens: { label: "输入 / 输出 Token", capability: "text", meters: ["input_token", "output_token"] },
    text_cached_tokens: { label: "非缓存输入 / 缓存读取 / 输出 Token", capability: "text", meters: ["input_token", "cached_input_token", "output_token"] },
    image_tokens: { label: "文本与图片 Token（分项）", capability: "image", meters: ["input_token", "output_token", "image_input_token", "image_output_token"] },
    image_request: { label: "按次（单张任务）", capability: "image", meters: ["request"] },
    image_count: { label: "按成功交付张数", capability: "image", meters: ["image"] },
    video_second: { label: "按计费秒数", capability: "video", meters: ["second"] },
    video_count: { label: "按成功交付条数", capability: "video", meters: ["video"] },
    audio_request: { label: "语音合成按成功任务", capability: "audio", meters: ["request"] },
};
export const PRICE_PARAMETERS: Record<PricingCapability, string[]> = { text: [], image: ["size", "quality", "mode"], video: ["resolution", "durationSeconds", "mode", "generateAudio", "aspectRatio"], audio: [] };
export const GEMINI_IMAGE_PRICE_PARAMETERS = ["aspectRatio", "imageSize"] as const;
const priceParameters = (template: PriceTemplate) => template === "image_count"
    ? [...PRICE_PARAMETERS.image, ...GEMINI_IMAGE_PRICE_PARAMETERS] : PRICE_PARAMETERS[PRICE_TEMPLATES[template].capability];
export const normalizePriceAmount = normalizeCnyAmount;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export function parseModelPriceBinding(value: unknown): ModelPriceBinding | null {
    if (!object(value) || !keys(value, ["providerId", "providerModel", "adapter", "endpoint", "capability"]) || !text(value.providerId) || !text(value.providerModel) || !text(value.endpoint) ||
        !["openai-compatible", "sub2api"].includes(value.adapter as string) || !["text", "image", "video", "audio"].includes(value.capability as string)) return null;
    try { const url = new URL(value.endpoint); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null; } catch { return null; }
    return { providerId: value.providerId, providerModel: value.providerModel, adapter: value.adapter as ModelPriceBinding["adapter"], endpoint: value.endpoint, capability: value.capability as PricingCapability };
}
export function sameModelPriceBinding(left: ModelPriceBinding, right: ModelPriceBinding): boolean {
    return left.providerId === right.providerId && left.providerModel === right.providerModel && left.adapter === right.adapter && left.endpoint === right.endpoint && left.capability === right.capability;
}

/** Conjunctions overlap unless at least one shared condition has a different value. */
function overlaps(left: PriceBand, right: PriceBand): boolean {
    return !Object.keys(left.parameters).some((key) => Object.hasOwn(right.parameters, key) && left.parameters[key] !== right.parameters[key]);
}
export function parseModelPriceRule(value: unknown, capability: PricingCapability, side: "cost" | "sale"): ModelPriceRule | null {
    if (!object(value) || !keys(value, ["template", "currency", "bands"]) || typeof value.template !== "string" || !Object.hasOwn(PRICE_TEMPLATES, value.template)) return null;
    const template = value.template as PriceTemplate, spec = PRICE_TEMPLATES[template];
    if (spec.capability !== capability || (side === "sale" ? value.currency !== "credit" : !["CNY", "USD"].includes(value.currency as string)) || !Array.isArray(value.bands) || !value.bands.length) return null;
    const allowedParameters = priceParameters(template);
    const bands: PriceBand[] = [];
    for (const row of value.bands) {
        if (!object(row) || !keys(row, ["parameters", "rates"]) || !object(row.parameters) || !object(row.rates) || !keys(row.rates, spec.meters)) return null;
        const parameters: Record<string, string> = {}, rates: PriceBand["rates"] = {};
        for (const [key, item] of Object.entries(row.parameters)) {
            if (!allowedParameters.includes(key) || !text(item)) return null;
            if (key === "durationSeconds" && (normalizePriceAmount(item) === null || normalizePriceAmount(item) === "0")) return null;
            parameters[key] = key === "durationSeconds" ? normalizePriceAmount(item)! : item;
        }
        for (const meter of spec.meters) {
            const item = row.rates[meter];
            if (item === null && side === "cost") rates[meter] = null;
            else { const normalized = normalizePriceAmount(item); if (normalized === null) return null; rates[meter] = normalized; }
        }
        const band = { parameters, rates };
        if (bands.some((prior) => overlaps(prior, band))) return null;
        bands.push(band);
    }
    return { template, currency: value.currency as PriceCurrency, bands };
}
export function parseModelPriceRules(value: unknown, capability: PricingCapability): ModelPriceRules | null {
    if (!object(value) || !keys(value, ["schemaVersion", "cost", "sale", ...(Object.hasOwn(value, "derivation") ? ["derivation"] : []), ...(Object.hasOwn(value, "video") ? ["video"] : []), ...(Object.hasOwn(value, "image") ? ["image"] : [])]) || value.schemaVersion !== 1) return null;
    const cost = value.cost === null ? null : parseModelPriceRule(value.cost, capability, "cost"), sale = parseModelPriceRule(value.sale, capability, "sale");
    if (!sale || (value.cost !== null && !cost)) return null;
    const rules: ModelPriceRules = { schemaVersion: 1, cost, sale };
    if (Object.hasOwn(value, "image")) {
        const policy = capability === "image" && parseImagePricePolicy(value.image);
        if (!policy || sale.template !== "image_request") return null;
        rules.image = policy;
    }
    if (Object.hasOwn(value, "video")) {
        const policy = capability === "video" && parseVideoPricePolicy(value.video);
        if (!policy) return null;
        rules.video = policy;
    }
    if (!Object.hasOwn(value, "derivation")) return rules;
    const derivation = parseModelPriceDerivation(value.derivation, capability);
    return derivation && sameDerivedPriceRules(rules, derivation) ? { ...rules, derivation } : null;
}
export function geminiImagePriceDraftMatchesBinding(binding: ModelPriceBinding, rules: ModelPriceRules): boolean {
    if (binding.capability !== "image") return true;
    return [rules.sale, rules.cost].every(side => !side?.bands.some(({ parameters }) =>
        GEMINI_IMAGE_PRICE_PARAMETERS.some(key => Object.hasOwn(parameters, key))) ||
        side.template === "image_count" && !!geminiImageBindingOptions(binding) &&
        side.bands.every(({ parameters }) => parseGeminiImageSpecification(binding.providerModel, parameters) !== null));
}

export function parseModelPriceDraftWrite(value: unknown): ModelPriceDraftWrite | null {
    if (!object(value) || !keys(value, ["modelId", "expectedVersion", "binding", "rules", "priceNote"]) || !text(value.modelId) || !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0 || typeof value.priceNote !== "string") return null;
    const binding = parseModelPriceBinding(value.binding), rules = binding && parseModelPriceRules(value.rules, binding.capability);
    return binding && rules && geminiImagePriceDraftMatchesBinding(binding, rules) && (!rules.derivation || sameModelPriceBinding(rules.derivation.binding, binding))
        ? { modelId: value.modelId, expectedVersion: value.expectedVersion as number, binding, rules, priceNote: value.priceNote } : null;
}

export type PriceSampleLine = { meter: PriceMeter; quantity: string; rate: string | null; base: number; total: string | null };
export type PriceSampleResult = { status: "calculated"; currency: PriceCurrency; total: string | null; lines: PriceSampleLine[]; bandIndex: number } |
    { status: "missing_parameters" | "no_matching_band" | "ambiguous" | "missing_usage" | "invalid_sample"; fields: string[] };

// Prices use only base 1 or 10^6. Integer coefficients and decimal scales keep the
// draft example exact; this is not a wallet quantizer or a generic division API.
function parts(value: string) { const [whole, fraction = ""] = value.split("."); return { coefficient: BigInt(whole + fraction), scale: fraction.length }; }
function decimal(coefficient: bigint, scale: number): string {
    const digits = coefficient.toString().padStart(scale + 1, "0");
    const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
    return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
function product(quantity: string, rate: string, base: number): string {
    const a = parts(quantity), b = parts(rate);
    return decimal(a.coefficient * b.coefficient, a.scale + b.scale + (base === 1_000_000 ? 6 : 0));
}
function sum(values: string[]): string {
    const items = values.map(parts), scale = Math.max(0, ...items.map((item) => item.scale));
    return decimal(items.reduce((total, item) => total + item.coefficient * BigInt(10) ** BigInt(scale - item.scale), BigInt(0)), scale);
}
export function evaluatePriceRule(rule: ModelPriceRule, parameters: Record<string, string>, usage: Partial<Record<PriceMeter, string>>): PriceSampleResult {
    const spec = PRICE_TEMPLATES[rule.template];
    const normalizedRule = spec && parseModelPriceRule(rule, spec.capability, rule.currency === "credit" ? "sale" : "cost");
    if (!normalizedRule || !object(parameters) || !object(usage)) return { status: "invalid_sample", fields: [] };
    rule = normalizedRule;
    const normalizedParameters: Record<string, string> = {};
    const allowedParameters = priceParameters(rule.template);
    for (const [key, item] of Object.entries(parameters)) {
        if (!allowedParameters.includes(key) || !text(item) || (key === "durationSeconds" && (normalizePriceAmount(item) === null || normalizePriceAmount(item) === "0"))) return { status: "invalid_sample", fields: [key] };
        normalizedParameters[key] = key === "durationSeconds" ? normalizePriceAmount(item)! : item;
    }
    const candidates = rule.bands.map((band, index) => ({ band, index })).filter(({ band }) => Object.entries(band.parameters).every(([key, value]) => normalizedParameters[key] === undefined || normalizedParameters[key] === value));
    if (!candidates.length) return { status: "no_matching_band", fields: [] };
    const missing = [...new Set(candidates.flatMap(({ band }) => Object.keys(band.parameters).filter((key) => normalizedParameters[key] === undefined)))];
    if (missing.length) return { status: "missing_parameters", fields: missing };
    if (candidates.length !== 1) return { status: "ambiguous", fields: [] };
    if (Object.keys(usage).some((key) => !Object.hasOwn(PRICE_METERS, key))) return { status: "invalid_sample", fields: [] };
    const missingUsage = spec.meters.filter((meter) => usage[meter] === undefined || usage[meter] === "");
    if (missingUsage.length) return { status: "missing_usage", fields: missingUsage };
    const { band, index } = candidates[0], lines: PriceSampleLine[] = [];
    for (const meter of spec.meters) {
        const quantity = normalizePriceAmount(usage[meter]);
        if (quantity === null || (meter !== "second" && quantity.includes("."))) return { status: "invalid_sample", fields: [meter] };
        const rate = band.rates[meter] ?? null, base = PRICE_METERS[meter].base;
        lines.push({ meter, quantity, rate, base, total: rate === null ? null : product(quantity, rate, base) });
    }
    return { status: "calculated", currency: rule.currency, total: lines.some((line) => line.total === null) ? null : sum(lines.map((line) => line.total!)), lines, bandIndex: index };
}

export function describePriceDraftSupport(binding: ModelPriceBinding, sale: ModelPriceRule): string {
    if (binding.adapter === "openai-compatible" && binding.capability === "audio" && sale.template === "audio_request" && sale.bands.length === 1 && !Object.keys(sale.bands[0].parameters).length) {
        return "语音合成支持完整校验并私有交付成功后按次收固定积分；保存草稿不改变当前价格，须另行发布。供应商成本与用量保持独立。";
    }
    if (binding.adapter === "openai-compatible" && binding.capability === "image" && sale.template === "image_request" && sale.bands.length === 1 && !Object.keys(sale.bands[0].parameters).length) {
        return "现有流程支持单张图片按次生成；本价目仍是草稿，尚未接入实际扣费。";
    }
    return "待适配：此计量或规格尚未接入平台实际生成与结算。草稿可以保存，不代表可发布使用。";
}
