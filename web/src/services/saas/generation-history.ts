import { z } from "zod/v4";
import { normalizeCreditAmount } from "../../../../packages/shared/src/credit-amounts";
import { GenerationError, type GenerationTrackingScope } from "./generation";
import { historyTitleSchema, parseHistoryDetail } from "./generation-history-detail";

export type GenerationHistoryType = "text" | "image" | "audio" | "video";
export type GenerationHistoryScope = GenerationTrackingScope;
export type GenerationHistoryQuery = {
    pageNumber?: number;
    pageSize?: 50;
    type?: GenerationHistoryType;
    status?: "succeeded" | "failed" | "running" | "queued" | "pending";
    search?: string;
};
export type GenerationHistoryItem = {
    taskId: string;
    type: GenerationHistoryType | null;
    displayModel: string;
    title?: string;
    executionStatus: "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
    deliveryStatus: "pending" | "saved" | "visible" | "failed" | "unknown";
    billingStatus: "unbilled" | "reserved" | "captured" | "released" | "pending_review";
    credits: string | null;
    createdAt: string;
    updatedAt: string;
    result: { url: string; thumbnailUrl?: string } | null;
};
export type GenerationHistoryResponse = { items: GenerationHistoryItem[]; total: number; pageNumber: number; pageSize: number; requestId?: string };

const typeSchema = z.enum(["text", "image", "audio", "video"]);
const filterStatus = z.enum(["succeeded", "failed", "running", "queued", "pending"]);
const text = z.string().refine(value => value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid();
const privateUrl = z.string().refine(value => {
    const match = /^\/api\/v1\/media\/([0-9a-f-]+)$/i.exec(value);
    return Boolean(match && value.startsWith("/api/v1/media/") && uuid.safeParse(match[1]).success);
});
const credits = z.string().refine(value => !value.startsWith("-") && normalizeCreditAmount(value) === value);
const querySchema = z.strictObject({ pageNumber: safeInteger.min(1).default(1), pageSize: z.literal(50).optional(), type: typeSchema.optional(), status: filterStatus.optional(), search: historyTitleSchema.optional() })
    .refine(value => Number.isSafeInteger((value.pageNumber - 1) * 50));
const responseSchema = z.strictObject({
    items: z.array(z.strictObject({
        taskId: uuid, type: typeSchema.nullable(), displayModel: text, title: historyTitleSchema.optional(),
        executionStatus: z.enum(["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"]),
        deliveryStatus: z.enum(["pending", "saved", "visible", "failed", "unknown"]),
        billingStatus: z.enum(["unbilled", "reserved", "captured", "released", "pending_review"]),
        credits: credits.nullable(), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
        result: z.strictObject({ url: privateUrl, thumbnailUrl: privateUrl.optional() }).nullable(),
    })).max(50),
    total: safeInteger, pageNumber: safeInteger.min(1), pageSize: z.literal(50), requestId: text.optional(),
});
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const unconfirmed = (status?: number) => new GenerationError("unconfirmed", "创作历史读取未完成，请手动刷新核对。", "not-sent", status);

/** Owner-scoped history and title updates; media URLs are identities, never direct img sources. */
export function createGenerationHistoryClient(options: {
    scope: GenerationTrackingScope; getScope: () => GenerationTrackingScope | null; fetcher?: typeof fetch;
}) {
    const scope = Object.freeze({ accountId: options.scope.accountId, epoch: options.scope.epoch }), fetcher = options.fetcher ?? fetch;
    let invalidated = false;
    function check(signal?: AbortSignal) {
        const current = options.getScope();
        if (invalidated || !current || current.accountId !== scope.accountId || current.epoch !== scope.epoch) {
            invalidated = true;
            throw new GenerationError("context_changed", "账号状态已变化，已停止读取原创作历史。", "not-sent");
        }
        if (signal?.aborted) throw new GenerationError("aborted", "创作历史读取已取消。", "not-sent");
    }
    async function request(path: string, signal?: AbortSignal, title?: string) {
            check(signal);
            let response: Response | undefined, data: unknown;
            try {
                check(signal);
                response = await fetcher(path, {
                    method: title === undefined ? "GET" : "PUT", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: title === undefined ? "no-referrer" : "strict-origin", signal,
                    headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(title === undefined ? {} : { "content-type": "application/json" }) },
                    ...(title === undefined ? {} : { body: JSON.stringify({ title }) }),
                });
                check(signal);
                if (response.status === 401) {
                    invalidated = true;
                    throw new GenerationError("unauthorized", "登录已失效，请重新登录后读取创作历史。", "not-sent", 401);
                }
                data = await response.json();
                check(signal);
            } catch (error) {
                if (error instanceof GenerationError && error.code === "unauthorized") throw error;
                check(signal);
                if (error instanceof GenerationError) throw error;
                throw unconfirmed(response?.status);
            }
            if (!response.ok) {
                const code = object(object(data)?.error)?.code;
                const known: Record<string, [number, string]> = {
                    account_context_required: [400, "账户上下文尚未确认，请重新登录后读取创作历史。"],
                    account_changed: [409, "登录账号已变化，已停止原创作历史读取。"],
                    generation_unavailable: [503, "平台生成服务尚未开放。"],
                    rate_limited: [429, "创作历史读取过于频繁，请稍后手动刷新。"],
                    invalid_input: [400, "创作历史筛选或页码无效。"],
                    forbidden: [403, "当前账户无权读取创作历史。"],
                    invalid_origin: [403, "创作历史请求来源不匹配。"],
                };
                const match = typeof code === "string" && Object.hasOwn(known, code) ? known[code] : undefined;
                if (match && match[0] === response.status) {
                    if (code === "account_context_required" || code === "account_changed") invalidated = true;
                    throw new GenerationError(code as string, match[1], "not-sent", response.status);
                }
                throw unconfirmed(response.status);
            }
            return { data, status: response.status };
    }
    return Object.freeze({
        async rename(taskId: string, value: string, signal?: AbortSignal) {
            check(signal);
            const title = historyTitleSchema.safeParse(value);
            if (!uuid.safeParse(taskId).success || !title.success) throw new GenerationError("invalid_input", "创作记录编号或名称无效。", "not-sent", 400);
            const { data, status } = await request(`/api/v1/generation/logs/${encodeURIComponent(taskId)}/title`, signal, title.data);
            const saved = object(data);
            if (saved?.taskId !== taskId || saved.title !== title.data) throw unconfirmed(status);
            return title.data;
        },
        async detail(taskId: string, signal?: AbortSignal) {
            check(signal);
            if (!uuid.safeParse(taskId).success) throw new GenerationError("invalid_input", "任务编号无效。", "not-sent", 400);
            const { data, status } = await request(`/api/v1/generation/tasks/${encodeURIComponent(taskId)}`, signal);
            check(signal);
            const detail = parseHistoryDetail(data, taskId);
            if (!detail) throw unconfirmed(status);
            return detail;
        },
        async read(query: GenerationHistoryQuery = {}, signal?: AbortSignal): Promise<GenerationHistoryResponse> {
            check(signal);
            const input = querySchema.safeParse(query);
            if (!input.success) throw new GenerationError("invalid_input", "创作历史筛选或页码无效。", "not-sent", 400);
            const { pageNumber, type, status, search } = input.data;
            const parameters = new URLSearchParams({ pageNumber: String(pageNumber), pageSize: "50" });
            if (type !== undefined) parameters.set("type", type);
            if (status !== undefined) parameters.set("status", status);
            if (search !== undefined) parameters.set("search", search);
            const response = await request(`/api/v1/generation/logs?${parameters}`, signal);
            const data = response.data;
            const parsed = responseSchema.safeParse(data);
            check(signal);
            if (!parsed.success) throw unconfirmed(response.status);
            const page = parsed.data, offset = (pageNumber - 1) * 50, seen = new Set<string>();
            if (page.pageNumber !== pageNumber || page.items.length > Math.max(0, page.total - offset)) throw unconfirmed(response.status);
            for (const item of page.items) {
                const id = item.taskId.toLowerCase();
                if (seen.has(id) || type !== undefined && item.type !== type || status !== undefined && item.executionStatus !== status
                    || item.result !== null && (item.type === null || item.type === "text" || item.executionStatus !== "succeeded" || !["saved", "visible"].includes(item.deliveryStatus))) throw unconfirmed(response.status);
                seen.add(id);
            }
            return page;
        },
    });
}
