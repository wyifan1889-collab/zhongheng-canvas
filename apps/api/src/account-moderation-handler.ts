import { z } from "zod";
import { getAccountModeration, getAccountModerationOperation, setAccountModeration } from "../../../packages/database/src/account-moderation";
import { HttpError, readJson } from "./http";
import { moderationWriteSchema, rethrowModerationError, safetyActor, safetyInput, safetyPathId, type SafetyRouteContext, type SafetyRouteResult } from "./account-moderation-contract";

/** Mounted only after the existing origin, account context and authenticated principal checks. */
export async function handleAccountModeration(request: Request, context: SafetyRouteContext): Promise<SafetyRouteResult | null> {
    const url = new URL(request.url);
    const target = url.pathname.match(/^\/api\/v1\/admin\/users\/([^/]+)\/moderation$/);
    const operation = url.pathname.match(/^\/api\/v1\/admin\/moderation\/operations\/([^/]+)$/);
    if (!target && !operation) return null;
    safetyActor(context, true);
    if (!context.config.moderationEnabled) throw new HttpError(503, "moderation_unavailable", "账户处置功能尚未开放");
    if (url.search) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
    try {
        if (operation) {
            if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
            const id = safetyInput(z.uuid(), safetyPathId(operation[1]));
            const item = await getAccountModerationOperation(context.database, id, context.actor);
            if (!item) throw new HttpError(404, "moderation_not_found", "操作回执不存在");
            return { data: { item } };
        }
        const id = safetyPathId(target![1]);
        if (request.method === "GET") {
            const item = await getAccountModeration(context.database, id, context.actor);
            if (!item) throw new HttpError(404, "moderation_not_found", "账户不存在");
            return { data: { item } };
        }
        if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "不支持此操作");
        const input = safetyInput(moderationWriteSchema, await readJson(request, context.policy.documentBytes));
        return { data: { item: await setAccountModeration(context.database, id, input, context.actor) } };
    } catch (error) { rethrowModerationError(error); }
}
