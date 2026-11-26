import type { DraftAccountScope, DraftClientOptions } from "./drafts";

export type CanvasShareRole = "viewer" | "editor";
export type CanvasMemberRole = CanvasShareRole | "owner";
export type CanvasShare = {
    id: string; canvasId: string; token: string; role: CanvasShareRole;
    createdBy: string; expiresAt: string | null; createdAt: string;
};
export type CanvasMember = {
    canvasId: string; userId: string; role: CanvasMemberRole; invitedBy: string | null; joinedAt: string | null;
};
export type CanvasSharingState = { share: CanvasShare | null; members: CanvasMember[] };

/** An unknown mutation result must be checked by reading, never automatically resent. */
export class CanvasSharingError extends Error {
    constructor(public code: string, message: string, public status = 0,
        public outcome: "not-sent" | "rejected" | "unknown" = "unknown", public retryAfter?: number) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const role = (value: unknown): value is CanvasShareRole => value === "viewer" || value === "editor";
const invalid = () => new CanvasSharingError("invalid_input", "分享参数不正确，请检查画布、用户编号和角色后再操作。", 0, "not-sent");
const unconfirmed = (writing: boolean, status = 0) => new CanvasSharingError("unavailable", writing
    ? "操作结果尚未确认，请先读取核对分享和成员状态，不要直接重复提交。"
    : "分享状态读取未完成，请检查连接后手动重新读取。", status);

// Reject unknown fields, accessors and non-JSON objects before sending a command.
function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
    if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Reflect.ownKeys(value);
    return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => {
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        return typeof key === "string" && [...required, ...optional].includes(key) && property.enumerable && "value" in property;
    });
}

/** Same-origin sharing transport, bound permanently to one confirmed account + epoch. */
export function createCanvasSharingClient(getScope: () => DraftAccountScope | null, fetcher: typeof fetch = fetch, options: DraftClientOptions = {}) {
    const initial = getScope();
    const bound = initial ? { accountId: initial.accountId, epoch: initial.epoch } : null;
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    let invalidated = false;
    function checkScope(outcome: "not-sent" | "unknown") {
        const current = getScope();
        if (invalidated || !bound || !identity(bound.accountId) || !Number.isSafeInteger(bound.epoch) || bound.epoch < 0 ||
            !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) {
            invalidated = true;
            throw new CanvasSharingError("account_changed", outcome === "not-sent"
                ? "账户状态已变化，本次未发送。请重新确认账户后再操作。"
                : "请求期间账户状态已变化，返回结果未应用；请在原账户读取核对，不要自动重试。", 0, outcome);
        }
    }
    async function exchange(path: string, method: string, body?: object): Promise<unknown> {
        const writing = method !== "GET";
        const controller = typeof AbortController === "function" && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? new AbortController() : undefined;
        const timer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : undefined;
        let response: Response;
        try {
            response = await fetcher(path, {
                method, credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
                signal: controller?.signal,
                headers: { accept: "application/json", "x-canvas-account-id": bound!.accountId, ...(writing ? { "content-type": "application/json" } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch {
            if (timer) clearTimeout(timer);
            throw unconfirmed(writing);
        }
        let data: unknown;
        try {
            if (!response.headers.get("content-type")?.includes("application/json")) throw new Error();
            // Keep the existing deadline through the body, including a stalled JSON stream.
            data = await response.json();
        } catch { throw unconfirmed(writing, response.status); }
        finally { if (timer) clearTimeout(timer); }
        if (!response.ok) {
            const code = record(data) && record(data.error) ? data.error.code : undefined;
            const failures: Record<string, [number, string]> = {
                invalid_input: [400, "分享参数不正确，请检查后再操作。"],
                account_context_required: [400, "页面账户与当前登录状态不一致，请重新确认账户。"],
                account_changed: [409, "页面账户与当前登录状态不一致，本次操作已被拒绝。"],
                share_reset_required: [409, "当前链接的角色不同，请先读取核对，再明确确认重置链接以更改角色。"],
                unauthorized: [401, "登录已失效，请重新登录后再操作。"],
                invalid_origin: [403, "分享请求来源不匹配，请联系管理员检查配置。"],
                not_found: [404, "画布或邀请不存在、已失效，或当前账户无权访问。"],
                rate_limited: [429, "操作过于频繁，请等待后手动重新读取。"],
                cloud_unavailable: [503, "云端画布尚未开放，请稍后重新读取。"],
            };
            const failure = typeof code === "string" && Object.hasOwn(failures, code) ? failures[code] : undefined;
            if (failure && failure[0] === response.status) {
                const seconds = Number(response.headers.get("retry-after"));
                throw new CanvasSharingError(code as string, failure[1], response.status, "rejected",
                    response.status === 429 && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined);
            }
            // Proxy failures and unrecognized errors can follow a committed mutation.
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
            checkScope(error instanceof CanvasSharingError && error.outcome === "not-sent" ? "not-sent" : "unknown");
            if (error instanceof CanvasSharingError && ["account_changed", "account_context_required", "unauthorized"].includes(error.code)) invalidated = true;
            throw error;
        }
    }
    function path(canvasId: string) {
        if (!uuid(canvasId)) throw invalid();
        return `/api/v1/canvas/${canvasId.toLowerCase()}`;
    }
    function share(value: unknown, canvasId: string, writing: boolean): CanvasShare {
        if (!record(value) || !uuid(value.id) || !uuid(value.canvasId) || value.canvasId.toLowerCase() !== canvasId.toLowerCase() ||
            !uuid(value.token) || !role(value.role) || !identity(value.createdBy) || value.createdBy !== bound?.accountId ||
            !(value.expiresAt === null || date(value.expiresAt)) || !date(value.createdAt)) throw unconfirmed(writing);
        return { id: value.id.toLowerCase(), canvasId: value.canvasId.toLowerCase(), token: value.token.toLowerCase(), role: value.role,
            createdBy: value.createdBy, expiresAt: value.expiresAt, createdAt: value.createdAt };
    }
    function member(value: unknown, writing: boolean, canvasId?: string): CanvasMember {
        if (!record(value) || !uuid(value.canvasId) || (canvasId !== undefined && value.canvasId.toLowerCase() !== canvasId.toLowerCase()) ||
            !identity(value.userId) || !(role(value.role) || value.role === "owner") ||
            !(value.invitedBy === null || identity(value.invitedBy)) || !(value.joinedAt === null || date(value.joinedAt)) ||
            (value.role === "owner" && value.joinedAt === null)) throw unconfirmed(writing);
        return { canvasId: value.canvasId.toLowerCase(), userId: value.userId, role: value.role, invitedBy: value.invitedBy, joinedAt: value.joinedAt };
    }
    return {
        async read(canvasId: string): Promise<CanvasSharingState> {
            const data = await request(`${path(canvasId)}/share`);
            if (!record(data) || !Array.isArray(data.members)) throw unconfirmed(false);
            const currentShare = data.share === null ? null : share(data.share, canvasId, false);
            const members = data.members.map((value) => member(value, false, canvasId));
            const owners = members.filter((value) => value.role === "owner");
            if (new Set(members.map((value) => value.userId)).size !== members.length || owners.length !== 1 || owners[0].userId !== bound?.accountId) throw unconfirmed(false);
            checkScope("unknown");
            return { share: currentShare, members };
        },
        async createLink(canvasId: string, value: { role: CanvasShareRole; reset?: boolean }): Promise<CanvasShare> {
            const target = path(canvasId);
            if (!fields(value, ["role"], ["reset"]) || !role(value.role) || (Object.hasOwn(value, "reset") && typeof value.reset !== "boolean")) throw invalid();
            const selectedRole = value.role;
            const data = await request(`${target}/share-link`, "POST", { role: selectedRole, ...(value.reset === undefined ? {} : { reset: value.reset }) });
            const current = share(record(data) ? data.share : undefined, canvasId, true);
            if (current.role !== selectedRole) throw unconfirmed(true);
            checkScope("unknown");
            return current;
        },
        async join(token: string): Promise<CanvasMember> {
            if (!uuid(token)) throw invalid();
            const data = await request(`/api/v1/canvas/share/${token.toLowerCase()}/join`, "POST", {});
            const current = member(record(data) ? data.member : undefined, true);
            if (current.userId !== bound?.accountId || current.joinedAt === null) throw unconfirmed(true);
            checkScope("unknown");
            return current;
        },
        async addMember(canvasId: string, value: { userId: string; role: CanvasShareRole }): Promise<CanvasMember> {
            const target = path(canvasId);
            if (!fields(value, ["userId", "role"]) || !identity(value.userId) || !role(value.role) || value.userId === bound?.accountId) throw invalid();
            const targetUserId = value.userId, selectedRole = value.role;
            const data = await request(`${target}/members`, "POST", { userId: targetUserId, role: selectedRole });
            const current = member(record(data) ? data.member : undefined, true, canvasId);
            if (current.userId !== targetUserId || current.role !== selectedRole) throw unconfirmed(true);
            checkScope("unknown");
            return current;
        },
        async removeMember(canvasId: string, userId: string): Promise<void> {
            const target = path(canvasId);
            if (!identity(userId) || userId === bound?.accountId) throw invalid();
            const data = await request(`${target}/members/${encodeURIComponent(userId)}`, "DELETE");
            if (!record(data) || data.ok !== true) throw unconfirmed(true);
            checkScope("unknown");
        },
    };
}
