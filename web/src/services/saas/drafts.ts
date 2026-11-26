import type { CanvasDraft, JsonObject } from "../../../../packages/shared/src/index";

export type DraftInput = { title: string; documentVersion: 1; document: JsonObject };
export type DraftSummary = Omit<CanvasDraft, "document" | "documentVersion">;
export type DraftPage = { items: DraftSummary[]; nextCursor: string | null };
export type DraftAccountScope = { accountId: string; epoch: number };
export type CanvasDraftAccess = Readonly<{ role: "owner" | "editor" | "viewer"; ownerId: string; readOnly: boolean }>;
export type AccessibleCanvasDraft = Readonly<{ draft: CanvasDraft; access: CanvasDraftAccess }>;
export type DraftCreationCheck = { status: "found-current"; draft: CanvasDraft } | { status: "not-found-yet" };
export type DraftCreationReference = {
    readonly id: string;
    reconcile(): Promise<DraftCreationCheck>;
};
export type DraftClientOptions = { requestTimeoutMs?: number };
export type DraftCreationIntent = DraftCreationReference & { submit(): Promise<CanvasDraft> };

/** Unknown write outcomes must be reconciled by reading, never automatically resubmitted. */
export class DraftError extends Error {
    constructor(
        public code: string, message: string, public status = 0,
        public outcome: "not-sent" | "rejected" | "unknown" = "unknown",
        public currentRevision?: number, public retryAfter?: number,
        public creationId?: string,
    ) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const invalid = () => new DraftError("invalid_input", "草稿参数不正确，请保留当前内容并检查后再提交。", 0, "not-sent");
const unconfirmed = (writing: boolean, status = 0) => new DraftError("unavailable", writing
    ? "保存结果尚未确认，请保留当前内容，先核对云端记录，不要直接重复创建或覆盖。"
    : "草稿读取未完成，请保留当前内容，检查连接后手动重试。", status);

// Validate before JSON.stringify: do not silently turn Date/NaN/undefined or sparse arrays into different data.
function jsonValue(value: unknown, ancestors = new Set<object>()): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    ancestors.add(value);
    const keys = Reflect.ownKeys(value).filter((key) => !(Array.isArray(value) && key === "length"));
    const valid = (!Array.isArray(value) || keys.length === value.length) && keys.every((key, index) => {
        if (typeof key !== "string" || (Array.isArray(value) && key !== String(index))) return false;
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        return property.enumerable && "value" in property && jsonValue(property.value, ancestors);
    });
    ancestors.delete(value);
    return valid;
}

function summary(value: unknown): DraftSummary | null {
    if (!record(value) || !uuid(value.id) || typeof value.title !== "string" || !positive(value.revision) ||
        typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
        typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) return null;
    return { id: value.id, title: value.title, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

/** Bound to one confirmed account lifetime. No document storage, timers, retries or account auto-switching. */
export function createDraftClient(getScope: () => DraftAccountScope | null, fetcher: typeof fetch = fetch, options: DraftClientOptions = {}) {
    const initial = getScope();
    const bound = initial ? { accountId: initial.accountId, epoch: initial.epoch } : null;
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    let invalidated = false;
    function checkScope(outcome: "not-sent" | "unknown") {
        const current = getScope();
        if (invalidated || !bound || !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) {
            invalidated = true;
            throw new DraftError("account_changed", outcome === "not-sent"
                ? "账户状态已变化，本次未发送。请保留当前内容，重新确认账户后再操作。"
                : "请求期间账户状态已变化，返回结果未应用；保存结果可能尚未确认，请勿自动重试或转存到其他账户。", 0, outcome);
        }
    }
    async function exchange(path: string, method: string, body?: object): Promise<unknown> {
        const writing = method !== "GET";
        let serialized: string | undefined;
        try {
            if (body && !jsonValue(body)) throw invalid();
            serialized = body ? JSON.stringify(body) : undefined;
        } catch { throw invalid(); }
        let response: Response;
        const controller = typeof AbortController === "function" && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? new AbortController() : undefined;
        const timer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : undefined;
        try {
            response = await fetcher(path, {
                method, credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
                signal: controller?.signal,
                // An account condition, never a credential or an owner supplied in the document.
                headers: { accept: "application/json", "x-canvas-account-id": bound!.accountId, ...(writing ? { "content-type": "application/json" } : {}) },
                ...(serialized === undefined ? {} : { body: serialized }),
            });
        } catch {
            if (timer) clearTimeout(timer);
            throw unconfirmed(writing);
        }
        let data: unknown;
        try {
            if (!response.headers.get("content-type")?.includes("application/json")) throw new Error();
            // Receiving headers is not completion: keep the existing deadline
            // until the body is read so a broken stream cannot hang a save.
            data = await response.json();
        } catch { throw unconfirmed(writing, response.status); }
        finally { if (timer) clearTimeout(timer); }
        if (!response.ok) {
            const code = record(data) && record(data.error) ? data.error.code : null;
            if ((response.status === 400 && code === "account_context_required") || (response.status === 409 && code === "account_changed")) {
                throw new DraftError(code, "页面账户与当前登录状态不一致，本次操作已被拒绝。请保留当前内容，重新确认账户后再操作。", response.status, "rejected");
            }
            if (response.status === 409 && code === "revision_conflict" && record(data) && positive(data.currentRevision)) {
                throw new DraftError("revision_conflict", "云端已有新版本；本次保存被拒绝，请保留当前修改后处理冲突。", 409, "rejected", data.currentRevision);
            }
            if (response.status === 409 && code === "creation_exists") {
                throw new DraftError("creation_exists", "该保存编号已有云端记录，本次未创建或覆盖；请主动核对当前云端内容。", 409, "rejected");
            }
            if (response.status === 403 && (code === "forbidden" || code === "permission_denied")) {
                throw new DraftError("permission_denied", "当前画布权限已变化，本次操作被拒绝；请保留修改并重新核对权限。", 403, "rejected");
            }
            const failures: Record<number, [string, string]> = {
                400: ["invalid_input", "草稿格式或分页参数不正确，请保留当前内容并检查。"],
                401: ["unauthorized", "登录已失效，请保留当前内容，重新登录后再操作。"],
                403: ["invalid_origin", "草稿请求来源不匹配，请联系管理员检查配置。"],
                404: ["not_found", "草稿不存在或当前账户无权访问；请保留当前内容。"],
                413: ["payload_too_large", "草稿超过服务端大小限制，本次未保存；请保留当前内容。"],
                429: ["rate_limited", "操作过于频繁，请保留当前内容，等待后手动重试。"],
                503: ["cloud_unavailable", "云端画布尚未开放，本次没有读取或保存；请保留本机内容。"],
            };
            const failure = failures[response.status];
            // Only known API rejections count as definite; proxy/5xx failures may follow a committed write.
            if (failure && (code === failure[0] || (response.status === 400 && code === "invalid_cursor"))) {
                const seconds = Number(response.headers.get("retry-after"));
                throw new DraftError(failure[0], failure[1], response.status, "rejected", undefined,
                    response.status === 429 && positive(seconds) ? seconds : undefined);
            }
            throw unconfirmed(writing, response.status);
        }
        return data;
    }
    async function request(path: string, method = "GET", body?: object): Promise<unknown> {
        checkScope("not-sent");
        try {
            const data = await exchange(path, method, body);
            checkScope("unknown");
            return data;
        } catch (error) {
            // Cookie/session changes do not undo writes already accepted by the server.
            checkScope(error instanceof DraftError && error.outcome === "not-sent" ? "not-sent" : "unknown");
            if (error instanceof DraftError && ["account_changed", "account_context_required", "unauthorized"].includes(error.code)) invalidated = true;
            throw error;
        }
    }
    function input(value: DraftInput): DraftInput {
        if (!value || typeof value.title !== "string" || value.documentVersion !== 1 || !record(value.document)) throw invalid();
        return { title: value.title, documentVersion: 1, document: value.document };
    }
    function path(id: string) {
        if (!uuid(id)) throw invalid();
        return `/api/v1/canvases/${id.toLowerCase()}`;
    }
    function draft(data: unknown, writing: boolean, id?: string, revision?: number): CanvasDraft {
        const value = record(data) ? data.draft : undefined;
        const info = summary(value);
        if (!info || !record(value) || value.documentVersion !== 1 || !record(value.document) || !jsonValue(value.document) ||
            (id !== undefined && info.id.toLowerCase() !== id.toLowerCase()) || (revision !== undefined && info.revision !== revision)) throw unconfirmed(writing);
        checkScope("unknown");
        return { ...info, documentVersion: 1, document: value.document as JsonObject };
    }
    function recoverCreate(id: string): DraftCreationReference {
        checkScope("not-sent");
        if (!uuid(id)) throw invalid();
        const creationId = id.toLowerCase();
        return Object.freeze({
            id: creationId,
            async reconcile(): Promise<DraftCreationCheck> {
                try {
                    const current = draft(await request(path(creationId)), false, creationId);
                    // Existence is not proof that the original snapshot is still the current document.
                    return { status: "found-current", draft: current };
                } catch (error) {
                    // A write may still be in flight. Never auto-create or mint a new ID after this.
                    if (error instanceof DraftError && error.code === "not_found") return { status: "not-found-yet" };
                    throw error;
                }
            },
        });
    }
    function prepareCreate(value: DraftInput): DraftCreationIntent {
        checkScope("not-sent");
        let snapshot: DraftInput;
        try {
            const projected = input(value);
            if (!jsonValue(projected)) throw invalid();
            // Detached JSON lives only in this closure; subsequent editor changes are another intent.
            snapshot = JSON.parse(JSON.stringify(projected));
        } catch { throw invalid(); }
        const reference = recoverCreate(crypto.randomUUID());
        const creationId = reference.id;
        return Object.freeze({
            ...reference,
            async submit() {
                try {
                    return draft(await request("/api/v1/canvases", "POST", { ...snapshot, creationId }), true, creationId, 1);
                } catch (error) {
                    if (error instanceof DraftError) error.creationId = creationId;
                    throw error;
                }
            },
        });
    }
    return {
        // In-memory only. UI persistence/recovery across refresh must be designed before cloud rollout.
        prepareCreate,
        // An ID-only read reference, never a reconstructed submission or a persisted local record.
        recoverCreate,
        async list(options: { limit?: number; cursor?: string } = {}): Promise<DraftPage> {
            if (options.limit !== undefined && !positive(options.limit)) throw invalid();
            if (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor)) throw invalid();
            const query = new URLSearchParams();
            if (options.limit !== undefined) query.set("limit", String(options.limit));
            if (options.cursor !== undefined) query.set("cursor", options.cursor);
            const data = await request(`/api/v1/canvases${query.size ? `?${query}` : ""}`);
            if (!record(data) || !Array.isArray(data.items) || !(data.nextCursor === null || (typeof data.nextCursor === "string" && !!data.nextCursor))) throw unconfirmed(false);
            const items = data.items.map(summary);
            if (items.some((item) => !item)) throw unconfirmed(false);
            checkScope("unknown");
            return { items: items as DraftSummary[], nextCursor: data.nextCursor as string | null };
        },
        async get(id: string): Promise<CanvasDraft> {
            return draft(await request(path(id)), false, id);
        },
        /** Resource permission is required here; an old owner-only response cannot grant shared access. */
        async getWithAccess(id: string): Promise<AccessibleCanvasDraft> {
            const data = await request(path(id));
            const found = draft(data, false, id);
            const access = record(data) ? data.access : undefined;
            if (!record(access) || !["owner", "editor", "viewer"].includes(String(access.role)) ||
                typeof access.ownerId !== "string" || !access.ownerId.trim() || typeof access.readOnly !== "boolean" || access.readOnly !== (access.role === "viewer")) throw unconfirmed(false);
            return { draft: found, access: { role: access.role as CanvasDraftAccess["role"], ownerId: access.ownerId, readOnly: access.readOnly } };
        },
        async create(value: DraftInput): Promise<CanvasDraft> {
            return prepareCreate(value).submit();
        },
        async save(id: string, value: DraftInput & { expectedRevision: number }): Promise<CanvasDraft> {
            if (!positive(value.expectedRevision) || !Number.isSafeInteger(value.expectedRevision + 1)) throw invalid();
            return draft(await request(path(id), "PUT", { ...input(value), expectedRevision: value.expectedRevision }), true, id, value.expectedRevision + 1);
        },
    };
}
