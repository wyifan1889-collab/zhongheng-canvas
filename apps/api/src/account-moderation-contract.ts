import { z } from "zod";
import type { Database } from "@infinite-canvas/database";
import { AccountModerationError, type SafetyActor } from "../../../packages/database/src/account-moderation";
import type { ContentSafetyConfig } from "./content-safety-config";
import type { AccountPolicy } from "./policy";
import { HttpError } from "./http";

export type SafetyRouteContext = { database: Database; actor: SafetyActor; role: "user" | "admin"; config: ContentSafetyConfig; policy: Pick<AccountPolicy, "documentBytes" | "pageSize"> };
export type SafetyRouteResult = { data: Record<string, unknown>; status?: number };
export const moderationWriteSchema = z.strictObject({ operationId: z.uuid(), disabled: z.boolean(), expectedVersion: z.number().int().min(0).max(2_147_483_647), reason: z.string().trim().min(1) });
export function safetyInput<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "invalid_input", "请核对内容、提交编号与当前版本");
    return parsed.data;
}
export function safetyActor(context: SafetyRouteContext, admin = false) {
    if (!context.actor?.actorId || !context.actor.sessionId) throw new HttpError(401, "unauthorized", "请重新登录");
    if (admin && context.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
}
export function safetyPathId(value: string) {
    try { return safetyInput(z.string().min(1), decodeURIComponent(value)); }
    catch { throw new HttpError(400, "invalid_input", "编号无效"); }
}
export function rethrowModerationError(error: unknown): never {
    if (error instanceof AccountModerationError) {
        throw new HttpError(error.code === "moderation_not_found" ? 404 : error.code === "moderation_invalid" ? 400 : 409, error.code, error.message);
    }
    throw error;
}
