import { z } from "zod";
import { AbuseReportError, getAdminAbuseReport, getOwnAbuseReport, listAbuseReports, receiveAbuseReport, submitAbuseReport } from "../../../packages/database/src/abuse-reports";
import { HttpError, readJson } from "./http";
import { rethrowModerationError, safetyActor, safetyInput, safetyPathId, type SafetyRouteContext, type SafetyRouteResult } from "./account-moderation-contract";
import { abuseReportListSchema, abuseReportReceiptSchema, abuseReportWriteSchema } from "./abuse-report-contract";

/** No caller-supplied reporter or action identity reaches the repository. */
export async function handleAbuseReport(request: Request, context: SafetyRouteContext): Promise<SafetyRouteResult | null> {
    const url = new URL(request.url), path = url.pathname;
    const admin = path === "/api/v1/admin/abuse-reports" || /^\/api\/v1\/admin\/abuse-reports\/[^/]+(?:\/receipt)?$/.test(path);
    const collection = path === "/api/v1/abuse-reports" || path === "/api/v1/admin/abuse-reports";
    const own = path.match(/^\/api\/v1\/abuse-reports\/([^/]+)$/);
    const detail = path.match(/^\/api\/v1\/admin\/abuse-reports\/([^/]+)(\/receipt)?$/);
    if (!collection && !own && !detail) return null;
    safetyActor(context, admin);
    if (!context.config.reportsEnabled) throw new HttpError(503, "abuse_reports_unavailable", "投诉受理功能尚未开放");
    try {
        if (admin && collection) {
            if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
            for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "invalid_input", "查询参数重复");
            const input = safetyInput(abuseReportListSchema, Object.fromEntries(url.searchParams));
            return { data: { ...await listAbuseReports(context.database, input, context.actor, context.policy.pageSize) } };
        }
        if (url.search) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
        if (collection) {
            if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
            const input = safetyInput(abuseReportWriteSchema, await readJson(request, context.policy.documentBytes));
            return { data: { item: await submitAbuseReport(context.database, input, context.actor) } };
        }
        const id = safetyInput(z.uuid(), safetyPathId((own ?? detail)![1]));
        if (detail?.[2]) {
            if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "不支持此操作");
            const input = safetyInput(abuseReportReceiptSchema, await readJson(request, context.policy.documentBytes));
            return { data: { item: await receiveAbuseReport(context.database, id, input.expectedVersion, context.actor) } };
        }
        if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
        const item = await (admin ? getAdminAbuseReport : getOwnAbuseReport)(context.database, id, context.actor);
        if (!item) throw new HttpError(404, "report_not_found", "投诉回执不存在");
        return { data: { item } };
    } catch (error) {
        if (error instanceof AbuseReportError) throw new HttpError(error.code === "report_not_found" ? 404 : error.code === "report_invalid" ? 400 : 409, error.code, error.message);
        rethrowModerationError(error);
    }
}
