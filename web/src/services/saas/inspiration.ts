import { z } from "zod/v4";
import { isBlockedProviderHostname } from "@/lib/public-image-host";
import type { DraftAccountScope, DraftClientOptions } from "./drafts";

// DTO frozen in docs/coordination/inspiration-api-contract.md (a8258d4).
const text = z.string().refine(value => Boolean(value.trim()));
const revision = z.number().int().nonnegative().refine(Number.isSafeInteger);
const imageUrl = z.string().refine(value => {
    if (value.startsWith("/inspiration-assets/")) return /^\/inspiration-assets\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value);
    try {
        if (!/^https:\/\/[^/]/i.test(value) || value !== value.trim() || /[\s\\]/.test(value)) return false;
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !isBlockedProviderHostname(url.hostname) && !/^\/api\/v1\/media(?:\/|$)/i.test(url.pathname);
    } catch { return false; }
});
const itemSchema = z.strictObject({ id: text.refine(value => value === value.trim()), type: z.enum(["image", "video", "audio"]), title: text, prompt: text, imageUrl, tags: z.array(text) });
const itemsSchema = z.array(itemSchema).refine(items => new Set(items.map(item => item.id)).size === items.length);
const catalogSchema = z.object({ revision, items: itemsSchema });
const writeSchema = z.strictObject({ expectedRevision: revision, items: itemsSchema });
export type InspirationItem = z.infer<typeof itemSchema>;
export type InspirationCatalog = z.infer<typeof catalogSchema>;
export type InspirationWrite = z.infer<typeof writeSchema>;

export class InspirationServiceError extends Error {
    constructor(public code: string, message: string, public status = 0, public outcome: "not-sent" | "rejected" | "unknown" = "not-sent") {
        super(message); this.name = "InspirationServiceError";
    }
}
const unconfirmed = (writing: boolean, status = 0) => new InspirationServiceError("unconfirmed", writing
    ? "发布结果尚未确认，请先读取服务器列表核对，不要直接重复保存。"
    : "灵感列表读取未完成，请稍后手动重试。", status, writing ? "unknown" : "not-sent");
const invalid = () => new InspirationServiceError("invalid_input", "请核对灵感的唯一编号、类型、标题、提示词、公开封面地址和标签。", 0, "not-sent");
const sameScope = (a: DraftAccountScope | null, b: DraftAccountScope | null) => !!a && !!b && a.accountId === b.accountId && a.epoch === b.epoch;
const failures: Record<string, [number, string]> = {
    invalid_input: [400, "灵感条目格式无效，请检查字段和公开图片地址。"],
    account_context_required: [400, "请重新确认当前管理员账号。"],
    account_changed: [409, "账号状态已变化，请重新确认后读取列表。"],
    unauthorized: [401, "登录已失效，请重新登录。"],
    forbidden: [403, "当前账户没有管理灵感的权限。"],
    invalid_origin: [403, "请求来源不匹配，请联系管理员检查配置。"],
    inspiration_revision_conflict: [409, "服务器列表已更新，当前编辑已保留；请读取核对后再决定。"],
    inspiration_busy: [409, "灵感列表正在保存，请先读取核对后再决定。"],
    inspiration_unavailable: [503, "管理员灵感存储尚未配置。"],
    rate_limited: [429, "操作过于频繁，请稍后手动读取核对。"],
    payload_too_large: [413, "发布内容超过服务端请求大小限制，请精简后再保存。"],
};

async function exchange(path: string, fetcher: typeof fetch, options: { body?: InspirationWrite; accountId?: string; signal?: AbortSignal; requestTimeoutMs?: number }) {
    const writing = options.body !== undefined, controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const operation = async () => {
        const response = await fetcher(path, { method: writing ? "PUT" : "GET", credentials: options.accountId ? "same-origin" : "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
            headers: { accept: "application/json", ...(options.accountId ? { "x-canvas-account-id": options.accountId } : {}), ...(writing ? { "content-type": "application/json" } : {}) },
            ...(writing ? { body: JSON.stringify(options.body) } : {}) });
        if (!response.headers.get("content-type")?.includes("application/json")) throw unconfirmed(writing, response.status);
        let data: unknown;
        try { data = await response.json(); } catch { throw unconfirmed(writing, response.status); }
        if (!response.ok) {
            const code = data && typeof data === "object" && "error" in data && data.error && typeof data.error === "object" && "code" in data.error ? data.error.code : undefined;
            const failure = typeof code === "string" && Object.hasOwn(failures, code) ? failures[code] : undefined;
            if (failure?.[0] === response.status) throw new InspirationServiceError(code as string, failure[1], response.status, "rejected");
            throw unconfirmed(writing, response.status);
        }
        return { data, status: response.status };
    };
    try {
        const timeout = options.requestTimeoutMs ?? 15_000;
        return await Promise.race([operation(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(unconfirmed(writing)); }, timeout);
        })]);
    } catch (error) {
        throw error instanceof InspirationServiceError ? error : unconfirmed(writing);
    } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
    }
}

/** Public templates never send an account header or cookie. No read retries. */
export async function fetchPublicInspirations(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<InspirationItem[]> {
    const { data, status } = await exchange("/api/v1/inspiration/items", fetcher, { signal });
    const parsed = z.object({ items: itemsSchema }).safeParse(data);
    if (!parsed.success) throw unconfirmed(false, status);
    return parsed.data.items;
}

/** Bind each editor lifetime to an already-confirmed administrator account/epoch. */
export function createAdminInspirationClient(getScope: () => DraftAccountScope | null, fetcher: typeof fetch = fetch, options: DraftClientOptions = {}) {
    const initial = getScope(), bound = initial ? { ...initial } : null;
    let invalidated = false;
    const check = (outcome: "not-sent" | "unknown") => {
        if (invalidated || !sameScope(bound, getScope()) || !bound?.accountId.trim() || !Number.isSafeInteger(bound.epoch) || bound.epoch < 0) {
            invalidated = true;
            throw new InspirationServiceError("account_changed", "管理员账号状态已变化，本次结果未应用；请重新确认账户后读取列表。", 0, outcome);
        }
    };
    const request = async (body?: InspirationWrite) => {
        check("not-sent");
        try {
            const result = await exchange("/api/v1/admin/inspiration/items", fetcher, { body, accountId: bound!.accountId, requestTimeoutMs: options.requestTimeoutMs });
            check(body ? "unknown" : "not-sent");
            const parsed = catalogSchema.safeParse(result.data);
            if (!parsed.success || body && (parsed.data.revision !== body.expectedRevision + 1 || JSON.stringify(parsed.data.items) !== JSON.stringify(body.items))) throw unconfirmed(Boolean(body), result.status);
            return parsed.data;
        } catch (error) {
            check(body ? "unknown" : "not-sent");
            if (error instanceof InspirationServiceError && ["account_changed", "account_context_required", "unauthorized", "forbidden"].includes(error.code)) invalidated = true;
            throw error;
        }
    };
    return {
        read: () => request(),
        save(input: InspirationWrite) {
            const parsed = writeSchema.safeParse(input);
            if (!parsed.success) return Promise.reject(invalid());
            return request(parsed.data);
        },
    };
}
