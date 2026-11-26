import { evaluatePriceRule, normalizePriceAmount, type ModelPriceRule, type PriceMeter, type PriceSampleResult } from "@/services/saas/platform";

/** Hand-entered planning only. Input is a total; each side keeps its own template's scope. */
export function manualPriceSample(rule: ModelPriceRule, parameters: Record<string, string>, usage: Partial<Record<PriceMeter, string>>): PriceSampleResult {
    if (rule.template !== "text_cached_tokens") return evaluatePriceRule(rule, parameters, usage);
    const missing = (["input_token", "cached_input_token"] as const).filter(meter => usage[meter] === undefined || usage[meter] === "");
    if (missing.length) return { status: "missing_usage", fields: missing };
    const input = normalizePriceAmount(usage.input_token), cached = normalizePriceAmount(usage.cached_input_token);
    if (input === null || input.includes(".")) return { status: "invalid_sample", fields: ["input_token"] };
    if (cached === null || cached.includes(".") || BigInt(cached) > BigInt(input)) return { status: "invalid_sample", fields: ["cached_input_token"] };
    return evaluatePriceRule(rule, parameters, { ...usage, input_token: (BigInt(input) - BigInt(cached)).toString() });
}
