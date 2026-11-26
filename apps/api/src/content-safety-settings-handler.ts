import { z } from "zod";
import { getAdminGenerationRates, getGenerationRateOperation, publishGenerationRates } from "../../../packages/database/src/generation-rate-settings";
import { safetyActor, safetyPathId, type SafetyRouteContext, type SafetyRouteResult } from "./account-moderation-contract";
import { generationSafetyDefaults } from "./content-safety-config";
import { generationRatePolicyWriteSchema, rethrowGenerationRateSettingsError } from "./content-safety-settings-contract";
import { HttpError, readJson } from "./http";

/** Register after the existing same-origin, account context and authenticated principal checks. */
export async function handleContentSafetySettings(request: Request, context: SafetyRouteContext): Promise<SafetyRouteResult | null> {
    const url = new URL(request.url);
    const settings = url.pathname === "/api/v1/admin/content-safety/settings";
    const operation = url.pathname.match(/^\/api\/v1\/admin\/content-safety\/settings\/operations\/([^/]+)$/);
    if (!settings && !operation) return null;
    safetyActor(context, true);
    if (url.search) throw new HttpError(400, "rate_settings_invalid", "此接口不接受查询参数");
    try {
        if (operation) {
            if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
            const id = z.uuid().safeParse(safetyPathId(operation[1]));
            if (!id.success) throw new HttpError(400, "rate_settings_invalid", "操作编号无效");
            const receipt = await getGenerationRateOperation(context.database, id.data, context.actor);
            if (!receipt) throw new HttpError(404, "rate_settings_not_found", "操作回执暂未查到，请保留原编号稍后核对");
            return { data: { receipt } };
        }
        const defaults = generationSafetyDefaults(context.config);
        if (request.method === "GET") return { data: { config: await getAdminGenerationRates(context.database, context.actor, defaults) } };
        if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "不支持此操作");
        const parsed = generationRatePolicyWriteSchema.safeParse(await readJson(request, context.policy.documentBytes));
        if (!parsed.success) throw new HttpError(400, "rate_settings_invalid", "请核对次数、启用状态与当前版本");
        return { data: { receipt: await publishGenerationRates(context.database, parsed.data, context.actor, defaults) } };
    } catch (error) { rethrowGenerationRateSettingsError(error); }
}
