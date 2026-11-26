import { isCloudMediaId } from "../saas/cloud-media-reference";

export type CloudMediaKind = "image" | "video" | "audio";
export type CloudMedia = {
    id: string;
    kind: CloudMediaKind;
    contentType: string;
    sizeBytes: number;
    createdAt: string;
    url: string;
};
export type CloudMediaQuota = { quotaBytes: number; usedBytes: number; availableBytes: number };
export type CloudMediaPage = { items: CloudMedia[]; quota: CloudMediaQuota };
export type CloudMediaResolve = { items: CloudMedia[]; missing: string[] };
type MediaFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type CloudMediaClientOptions = { canvasId?: string; isCurrent?: () => boolean };

export class CloudMediaError extends Error {
    constructor(public code: string, message: string, public status = 0, public retryAfter?: number) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseMedia(value: unknown): CloudMedia | null {
    if (!record(value) || !isCloudMediaId(value.id) ||
        (value.kind !== "image" && value.kind !== "video" && value.kind !== "audio") || typeof value.contentType !== "string" ||
        !positive(value.sizeBytes) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
        typeof value.url !== "string" || !value.url.startsWith("/api/v1/media/")) return null;
    return { id: value.id, kind: value.kind, contentType: value.contentType, sizeBytes: value.sizeBytes, createdAt: value.createdAt, url: value.url };
}

function parseQuota(value: unknown): CloudMediaQuota | null {
    if (!record(value) || !positive(value.quotaBytes) || !positive(value.usedBytes) || !positive(value.availableBytes) || value.usedBytes > value.quotaBytes || value.availableBytes !== value.quotaBytes - value.usedBytes) return null;
    return { quotaBytes: value.quotaBytes, usedBytes: value.usedBytes, availableBytes: value.availableBytes };
}

/** Same-origin media client. The server owns provider credentials and object keys. */
export function createMediaClient(getAccountId: () => string | null, fetcher: MediaFetcher = fetch, options: CloudMediaClientOptions = {}) {
    const canvasId = options.canvasId?.toLowerCase();
    if (canvasId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(canvasId)) {
        throw new CloudMediaError("invalid_input", "画布素材读取范围不正确。", 400);
    }
    function checkCurrent(accountId: string | null): asserts accountId is string {
        if (!accountId || getAccountId() !== accountId || options.isCurrent?.() === false) {
            throw new CloudMediaError("account_changed", "账号或画布权限已变化，本次素材返回未采用。", 0);
        }
    }
    async function request(path: string, init: RequestInit = {}, expectJson = true): Promise<unknown> {
        const accountId = getAccountId();
        checkCurrent(accountId);
        let response: Response;
        try {
            response = await fetcher(path, {
                ...init, credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
                headers: { accept: "application/json", "x-canvas-account-id": accountId, ...(init.headers || {}) },
            });
        } catch { throw new CloudMediaError("unavailable", "云端素材服务暂时不可用，请保留本机素材后手动重试。", 0); }
        checkCurrent(accountId);
        if (!expectJson) {
            if (!response.ok) throw new CloudMediaError("unavailable", "云端素材读取未完成，请保留本机素材后再试。", response.status);
            return response;
        }
        let data: unknown = null;
        if (response.headers.get("content-type")?.includes("application/json")) {
            try { data = await response.json(); } catch { /* handled below */ }
        }
        checkCurrent(accountId);
        if (!response.ok) {
            const code = record(data) && record(data.error) && typeof data.error.code === "string" ? data.error.code : "unavailable";
            const seconds = Number(response.headers.get("retry-after"));
            const retryAfter = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
            const messages: Record<string, string> = {
                unauthorized: "登录已失效，请保留本机素材后重新登录。",
                account_changed: "登录账号已变化，本次素材操作未执行。",
                payload_too_large: "文件超过当前大小限制，未上传。",
                quota_exceeded: "云端容量不足，请购买扩容后再上传。",
                unsupported_media_type: "只支持图片、视频或音频文件。",
                not_found: "云端素材不存在或当前账户无权访问。",
                media_referenced: "该素材仍被云端画布引用，请先解除引用后再删除。",
                cloud_unavailable: "云端素材尚未开启，请保留本机素材。",
                rate_limited: "操作过于频繁，请稍后手动重试。",
            };
            throw new CloudMediaError(code, messages[code] || "云端素材操作未完成，请保留本机素材后再试。", response.status, retryAfter);
        }
        return data;
    }

    return {
        async list(): Promise<CloudMediaPage> {
            const data = await request("/api/v1/media");
            if (!record(data) || !Array.isArray(data.items) || !data.items.every((item) => parseMedia(item)) || !parseQuota(data.quota)) throw new CloudMediaError("invalid_response", "云端素材返回内容无效，请保留本机素材。", 0);
            return { items: data.items.map((item) => parseMedia(item)!), quota: parseQuota(data.quota)! };
        },
        async resolve(ids: string[]): Promise<CloudMediaResolve> {
            if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => !isCloudMediaId(id))) {
                throw new CloudMediaError("invalid_input", "云端素材引用无效，请保留本机素材。", 400);
            }
            const data = await request(`/api/v1/media/resolve${canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
            if (!record(data) || !Array.isArray(data.items) || !data.items.every((item) => parseMedia(item)) || !Array.isArray(data.missing) || !data.missing.every((id) => typeof id === "string")) throw new CloudMediaError("invalid_response", "云端素材归属返回内容无效，请保留本机素材。", 0);
            return { items: data.items.map((item) => parseMedia(item)!), missing: data.missing };
        },
        async upload(blob: Blob): Promise<{ media: CloudMedia; quota: CloudMediaQuota }> {
            const type = blob.type.toLowerCase();
            if (!(type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/"))) throw new CloudMediaError("unsupported_media_type", "只支持图片、视频或音频文件。", 415);
            const data = await request("/api/v1/media", { method: "POST", headers: { "content-type": type }, body: blob });
            const media = record(data) ? parseMedia(data.media) : null;
            const quota = record(data) ? parseQuota(data.quota) : null;
            if (!media || !quota) throw new CloudMediaError("invalid_response", "云端素材返回内容无效，请保留本机素材。", 0);
            return { media, quota };
        },
        async download(id: string): Promise<Blob> {
            const accountId = getAccountId();
            const data = await request(`/api/v1/media/${encodeURIComponent(id)}${canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : ""}`, {}, false);
            if (!(data instanceof Response)) throw new CloudMediaError("invalid_response", "云端素材返回内容无效，请保留本机素材。", 0);
            const blob = await data.blob();
            checkCurrent(accountId);
            return blob;
        },
        async remove(id: string): Promise<CloudMediaQuota> {
            const data = await request(`/api/v1/media/${encodeURIComponent(id)}`, { method: "DELETE" });
            const quota = record(data) ? parseQuota(data.quota) : null;
            if (!quota) throw new CloudMediaError("invalid_response", "云端素材返回内容无效，请保留本机素材。", 0);
            return quota;
        },
    };
}
