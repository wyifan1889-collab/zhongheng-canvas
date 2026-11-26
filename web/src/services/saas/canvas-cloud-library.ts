import type { CanvasFirstSaveContext } from "./canvas-first-save";
import { createDraftClient, DraftError, type DraftAccountScope, type DraftPage } from "./drafts";

export type CanvasCloudLibraryState = Readonly<{
    phase: "idle" | "loading" | "ready" | "error" | "blocked" | "closed";
    page: DraftPage | null;
}>;
type LibraryClient = Pick<ReturnType<typeof createDraftClient>, "list">;
const messages = {
    account_changed: "账户状态已变化，目录内容已清空。请重新确认账户后打开云稿目录。",
    context_changed: "画布或窗口状态已变化，本次目录结果未采用。请重新打开云稿目录。",
    cloud_unavailable: "云画布尚未开放或已关闭，本次不读取目录。请继续保留本机作品。",
    superseded: "已有新的目录读取操作，本次较早返回未采用。",
    busy: "本次目录读取尚未结束，请等待后再主动翻页。",
    no_next_page: "当前没有可读取的下一页，请先主动读取或刷新第一页。",
    unavailable: "云稿目录读取未完成，不能据此判断云端没有作品。请稍后主动重试。",
    rate_limited: "目录读取过于频繁，请等待后主动重试。",
} as const;
type ErrorCode = keyof typeof messages;

export class CanvasCloudLibraryError extends Error {
    readonly retryAfter?: number;
    constructor(public readonly code: ErrorCode, retryAfter?: number) {
        super(messages[code]);
        this.name = "CanvasCloudLibraryError";
        if (code === "rate_limited" && Number.isSafeInteger(retryAfter) && retryAfter! > 0) this.retryAfter = retryAfter;
    }
}

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const copyPage = (page: DraftPage): DraftPage => ({ items: page.items.map((item) => ({ ...item })), nextCursor: page.nextCursor });

/** Window-scoped, explicit summary reads only. No document GET, storage, writes or automatic pagination. */
export function createCanvasCloudLibrary(
    getContext: () => CanvasFirstSaveContext | null,
    clientFactory: (getScope: () => DraftAccountScope | null) => LibraryClient = createDraftClient,
) {
    function context() { try { return getContext(); } catch { return null; } }
    const initial = context();
    const bound = initial ? { accountId: initial.accountId, epoch: initial.epoch, localProjectId: initial.localProjectId, cloudCanvas: initial.cloudCanvas } : null;
    let phase: CanvasCloudLibraryState["phase"] = "idle", page: DraftPage | null = null, previous: DraftPage | null = null;
    let client: LibraryClient | undefined, invalidated: "account_changed" | "context_changed" | "cloud_unavailable" | undefined;
    let disposed = false, operation = 0;
    function invalidate(code: NonNullable<typeof invalidated>) {
        invalidated ??= code;
        page = previous = null;
        client = undefined;
        phase = disposed ? "closed" : "blocked";
    }
    function assertCurrent(expectedOperation?: number) {
        const current = context();
        if (!bound || !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) invalidate("account_changed");
        else if (current.localProjectId !== bound.localProjectId) invalidate("context_changed");
        else if (bound.cloudCanvas !== true || current.cloudCanvas !== true) invalidate("cloud_unavailable");
        if (invalidated) throw new CanvasCloudLibraryError(invalidated);
        if (expectedOperation !== undefined && expectedOperation !== operation) throw new CanvasCloudLibraryError("superseded");
    }
    function guardedScope(): DraftAccountScope | null {
        try { assertCurrent(); return { accountId: bound!.accountId, epoch: bound!.epoch }; }
        catch { return null; }
    }
    function project(found: DraftPage, cursor?: string): DraftPage {
        if (!found || !Array.isArray(found.items) || !(found.nextCursor === null || (typeof found.nextCursor === "string" && !!found.nextCursor)) ||
            (cursor !== undefined && found.nextCursor === cursor)) throw new CanvasCloudLibraryError("unavailable");
        const ids = new Set<string>();
        const items = found.items.map((item) => {
            if (!item || !uuid(item.id) || ids.has(item.id.toLowerCase()) || typeof item.title !== "string" || !Number.isSafeInteger(item.revision) || item.revision <= 0 ||
                typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
                typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) throw new CanvasCloudLibraryError("unavailable");
            ids.add(item.id.toLowerCase());
            return { id: item.id, title: item.title, revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt };
        });
        return { items, nextCursor: found.nextCursor };
    }
    async function load(first: boolean): Promise<DraftPage> {
        assertCurrent();
        if (!first && phase === "loading") throw new CanvasCloudLibraryError("busy");
        if (!first && !previous?.nextCursor) throw new CanvasCloudLibraryError("no_next_page");
        const currentOperation = ++operation, cursor = first ? undefined : previous!.nextCursor!;
        page = null;
        if (first) previous = null;
        phase = "loading";
        try {
            const currentClient = client ?? clientFactory(guardedScope);
            assertCurrent(currentOperation);
            client = currentClient;
            // Omit limit to follow the existing backend's configured default and maximum.
            const found = await currentClient.list(cursor === undefined ? {} : { cursor });
            assertCurrent(currentOperation);
            const next = project(found, cursor);
            assertCurrent(currentOperation);
            page = previous = next;
            phase = "ready";
            return copyPage(next);
        } catch (caught) {
            assertCurrent();
            // Even a malformed or superseded 401 cannot leave an authenticated directory usable.
            if (caught instanceof DraftError && (caught.status === 401 || ["account_changed", "account_context_required", "unauthorized"].includes(caught.code))) {
                invalidate("account_changed");
                throw new CanvasCloudLibraryError("account_changed");
            }
            assertCurrent(currentOperation);
            page = null;
            phase = "error";
            if (caught instanceof DraftError && caught.code === "rate_limited") throw new CanvasCloudLibraryError("rate_limited", caught.retryAfter);
            if (caught instanceof CanvasCloudLibraryError) throw new CanvasCloudLibraryError(caught.code, caught.retryAfter);
            throw new CanvasCloudLibraryError("unavailable");
        }
    }
    return Object.freeze({
        loadFirst: () => load(true),
        loadNext: () => load(false),
        getState(): CanvasCloudLibraryState {
            try { assertCurrent(); } catch { /* Never expose identifiers or titles after context invalidation. */ }
            return Object.freeze({ phase, page: page ? copyPage(page) : null });
        },
        dispose() { disposed = true; invalidate("context_changed"); },
    });
}
