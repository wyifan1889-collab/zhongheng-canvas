import { z } from "zod";
import type { RateRule } from "@infinite-canvas/database/rate-limit";
import { isGenerationRateDuration, isGenerationRatePoints, type GenerationRatePolicy, type GenerationSafetyDefaults } from "../../../packages/database/src/generation-rate-settings";

export type ContentSafetyMode = "off" | "record";
export type GenerationRateConfig = { ip: RateRule | null; user: RateRule | null; models: Array<RateRule & { modelId: string }> };
export type ContentSafetyConfig = {
    moderationEnabled: boolean;
    reportsEnabled: boolean;
    checkpointMode: ContentSafetyMode;
    generationPolicyDefaults: GenerationRatePolicy;
    generationRates: GenerationRateConfig;
};

const modelRates = z.array(z.strictObject({
    modelId: z.string().min(1).refine(value => value.trim() === value && !/\s|[\x00-\x1f\x7f]/.test(value)),
    points: z.number().refine(isGenerationRatePoints),
    duration: z.number().refine(isGenerationRateDuration),
}));

/** Shared conversion keeps the disabled policy's configured values available for publication. */
export function generationRatesFromPolicy(policy: GenerationRatePolicy, models: GenerationRateConfig["models"]): GenerationRateConfig {
    const rule = ({ enabled, points, duration }: GenerationRatePolicy["ip"]): RateRule | null => enabled ? { points, duration } : null;
    return { ip: rule(policy.ip), user: rule(policy.user), models };
}
export function generationSafetyDefaults(config: ContentSafetyConfig): GenerationSafetyDefaults {
    return { policy: config.generationPolicyDefaults, modelRates: config.generationRates.models, checkpointMode: config.checkpointMode };
}

/** D04 approved defaults; explicit overrides are validated even while their bucket is disabled. */
export function readContentSafetyConfig(env: Record<string, string | undefined>): ContentSafetyConfig {
    const enabled = (name: string, fallback = false) => {
        if (env[name] === undefined) return fallback;
        if (env[name] === "false") return false;
        if (env[name] !== "true") throw new Error(`${name} 只能是 true 或 false`);
        return true;
    };
    const integer = (name: string, fallback: number, valid: (value: unknown) => boolean) => {
        const value = env[name];
        if (value === undefined) return fallback;
        if (!/^[1-9]\d*$/.test(value) || !valid(Number(value))) {
            throw new Error(`${name} 必须为可存储的正整数`);
        }
        return Number(value);
    };
    const moderationEnabled = enabled("SAAS_ACCOUNT_MODERATION_ENABLED");
    const reportsEnabled = enabled("SAAS_ABUSE_REPORTS_ENABLED");
    const checkpointMode = env.SAAS_CONTENT_SAFETY_MODE ?? "record";
    if (checkpointMode !== "off" && checkpointMode !== "record") throw new Error("SAAS_CONTENT_SAFETY_MODE 只能是 off 或 record");
    const dimension = (name: "IP" | "USER", points: number, duration: number) => ({
        enabled: enabled(`SAAS_GENERATION_${name}_RATE_ENABLED`, true),
        points: integer(`SAAS_GENERATION_${name}_RATE_POINTS`, points, isGenerationRatePoints),
        duration: integer(`SAAS_GENERATION_${name}_RATE_DURATION_SECONDS`, duration, isGenerationRateDuration),
    });
    const generationPolicyDefaults: GenerationRatePolicy = { ip: dimension("IP", 10, 3600), user: dimension("USER", 50, 86400) };
    let input: unknown = [];
    if (env.SAAS_GENERATION_MODEL_RATES !== undefined) {
        try { input = JSON.parse(env.SAAS_GENERATION_MODEL_RATES); }
        catch { throw new Error("SAAS_GENERATION_MODEL_RATES 必须是有效 JSON 数组"); }
    }
    const parsed = modelRates.safeParse(input);
    if (!parsed.success || new Set(parsed.data.map(rule => rule.modelId)).size !== parsed.data.length) {
        throw new Error("SAAS_GENERATION_MODEL_RATES 格式无效或模型编号重复");
    }
    return { moderationEnabled, reportsEnabled, checkpointMode, generationPolicyDefaults,
        generationRates: generationRatesFromPolicy(generationPolicyDefaults, parsed.data) };
}
