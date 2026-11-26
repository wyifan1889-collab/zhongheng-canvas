import { z } from "zod";
import { AccountModerationError } from "../../../packages/database/src/account-moderation";
import { GenerationRateSettingsError, isGenerationRatePoints } from "../../../packages/database/src/generation-rate-settings";
import { HttpError } from "./http";

const dimension = z.strictObject({ enabled: z.boolean(), points: z.number().refine(isGenerationRatePoints) });
export const generationRatePolicyWriteSchema = z.strictObject({
    operationId: z.uuid(), expectedRevision: z.number().int().min(0).max(2_147_483_647),
    policy: z.strictObject({ ip: dimension, user: dimension }),
});
export function rethrowGenerationRateSettingsError(error: unknown): never {
    if (error instanceof AccountModerationError) throw new HttpError(409, error.code, error.message);
    if (error instanceof GenerationRateSettingsError) {
        const status = error.code === "rate_settings_invalid" ? 400 : error.code === "rate_settings_conflict" || error.code === "account_changed" ? 409 : 503;
        throw new HttpError(status, error.code, error.message);
    }
    if (error instanceof HttpError) throw error;
    // A missing table, invalid publication or database failure must not look like an empty/default policy.
    throw new HttpError(503, "rate_settings_unavailable", "生成次数设置暂不可用，请保留输入并稍后核对");
}
