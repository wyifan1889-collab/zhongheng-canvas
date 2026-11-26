import { CloudMediaError, createMediaClient } from "@/services/api/media";
import { GenerationError } from "@/services/saas/generation";
import { createGenerationHistoryClient, type GenerationHistoryItem, type GenerationHistoryQuery, type GenerationHistoryResponse, type GenerationHistoryScope } from "@/services/saas/generation-history";
import type { HistoryDetail } from "@/services/saas/generation-history-detail";
import { isCloudMediaId } from "@/services/saas/cloud-media-reference";

export type HistoryPreview = { status: "loading" | "ready" | "error"; url?: string; imageExtension?: string; imageId?: string };
const rasterExtensions = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"], ["image/avif", "avif"]]);
export type HistoryState = {
    query: GenerationHistoryQuery; phase: "loading" | "ready" | "error";
    items: GenerationHistoryItem[]; total: number; previews: Record<string, HistoryPreview>;
    error?: "serviceUnavailable" | "accountChanged" | "readFailed";
    detail?: { taskId: string; status: "loading" | "ready" | "error"; value?: HistoryDetail };
};
export const initialHistoryState = (): HistoryState => ({ query: { pageNumber: 1, pageSize: 50 }, phase: "loading", items: [], total: 0, previews: {} });

/** Only the precise private-media path returned by the history API is accepted. */
export function historyMediaId(path: string) {
    const id = /^\/api\/v1\/media\/([^/]+)$/.exec(path)?.[1];
    return isCloudMediaId(id) ? id : null;
}

export function historyImageIds(row?: GenerationHistoryItem, detail?: HistoryDetail): string[] {
    if (row?.type !== "image" || !row.result) return [];
    const first = historyMediaId(row.result.url);
    if (!first) return [];
    const result = detail?.result, images = result?.resultSnapshot.imageMedia;
    if (detail?.task.id !== row.taskId || detail.task.executionStatus !== "succeeded" || !["saved", "visible"].includes(detail.task.deliveryStatus) ||
        result?.taskId !== row.taskId || result.status !== "succeeded" || result.resultSnapshot.kind !== "image" || result.resultSnapshot.media?.mediaId !== first || !images ||
        images[0]?.mediaId !== first || images.some(image => image.kind !== "image" || !isCloudMediaId(image.mediaId) || !rasterExtensions.has(image.contentType))) return [first];
    const ids = new Set(images.map(image => image.mediaId));
    return ids.size === images.length ? [...ids] : [first];
}

/** Page-owned cancellation and Blob lifetime; this has no timers or persistence. */
export function createHistoryReader(options: {
    scope: GenerationHistoryScope; getScope: () => GenerationHistoryScope | null; onState: (state: HistoryState) => void;
    client?: Pick<ReturnType<typeof createGenerationHistoryClient>, "read"> & Partial<Pick<ReturnType<typeof createGenerationHistoryClient>, "detail" | "rename">>;
    mediaClient?: (signal: AbortSignal) => Pick<ReturnType<typeof createMediaClient>, "resolve" | "download">;
    createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void;
}) {
    let state = initialHistoryState(), sequence = 0, stopped = false, blocked = false;
    let listRead: AbortController | null = null;
    let detailRead: AbortController | null = null;
    let renameWrite: AbortController | null = null;
    const imageReads = new Map<string, AbortController>();
    const createUrl = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
    const revokeUrl = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
    const client = options.client ?? createGenerationHistoryClient({ scope: options.scope, getScope: options.getScope });
    const sameScope = () => {
        const scope = options.getScope();
        return scope?.accountId === options.scope.accountId && scope.epoch === options.scope.epoch;
    };
    const current = () => !stopped && !blocked && sameScope();
    const publish = (next: HistoryState) => { state = next; options.onState(next); };
    const clearReads = () => {
        sequence++;
        listRead?.abort(); listRead = null;
        detailRead?.abort(); detailRead = null;
        renameWrite?.abort(); renameWrite = null;
        imageReads.forEach((read) => read.abort()); imageReads.clear();
        Object.values(state.previews).forEach((preview) => { if (preview.url) revokeUrl(preview.url); });
    };
    const invalidate = () => { clearReads(); stopped = true; state = initialHistoryState(); };
    const accountFailure = (cause: unknown) => (cause instanceof GenerationError || cause instanceof CloudMediaError)
        && (cause.status === 401 || ["unauthorized", "account_changed", "account_context_required", "context_changed"].includes(cause.code));
    const blockAccount = () => {
        clearReads(); blocked = true;
        publish({ ...state, phase: "error", items: [], total: 0, previews: {}, detail: undefined, error: "accountChanged" });
    };
    const reader = {
        snapshot: () => !stopped && sameScope() ? state : initialHistoryState(),
        syncScope() {
            if (sameScope() || stopped) return;
            invalidate(); options.onState(state);
        },
        dispose: invalidate,
        closeDetail() {
            detailRead?.abort(); detailRead = null;
            const id = state.detail?.taskId;
            if (id) {
                imageReads.get(id)?.abort(); imageReads.delete(id);
                const preview = state.previews[id];
                if (preview?.url) revokeUrl(preview.url);
                const previews = { ...state.previews }; delete previews[id];
                if (current()) publish({ ...state, detail: undefined, previews });
            }
        },
        async detail(taskId: string) {
            if (!current() || state.phase === "loading" || !state.items.some(row => row.taskId === taskId) || !client.detail) return;
            if (detailRead && state.detail?.taskId === taskId) return;
            detailRead?.abort();
            const operation = new AbortController(), version = sequence; detailRead = operation;
            publish({ ...state, detail: { taskId, status: "loading" } });
            const active = () => current() && version === sequence && detailRead === operation && !operation.signal.aborted;
            try {
                const value = await client.detail(taskId, operation.signal);
                if (!active()) return;
                if (value.task.id !== taskId || value.task.modelId !== state.items.find(row => row.taskId === taskId)?.displayModel) throw new Error("Unconfirmed detail");
                publish({ ...state, detail: { taskId, status: "ready", value } });
            } catch (cause) {
                if (!active()) return;
                if (accountFailure(cause)) { blockAccount(); return; }
                publish({ ...state, detail: { taskId, status: "error" } });
            } finally { if (detailRead === operation) detailRead = null; }
        },
        async read(query: GenerationHistoryQuery = state.query) {
            if (!current()) return;
            const retain = (query.pageNumber ?? 1) === (state.query.pageNumber ?? 1) && query.type === state.query.type && query.status === state.query.status && query.search === state.query.search;
            if (listRead && retain) return;
            clearReads();
            const version = sequence, operation = new AbortController(); listRead = operation;
            publish({ query: { ...query, pageSize: 50 }, phase: "loading", items: retain ? state.items : [], total: retain ? state.total : 0, previews: {}, error: retain ? state.error : undefined });
            const active = () => current() && version === sequence && !operation.signal.aborted;
            try {
                const response: GenerationHistoryResponse = await client.read(state.query, operation.signal);
                if (active()) publish({ ...state, phase: "ready", items: response.items, total: response.total, error: undefined });
            } catch (cause) {
                if (!active()) return;
                const code = cause instanceof GenerationError ? cause.code : "";
                if (accountFailure(cause)) { blockAccount(); return; }
                publish({ ...state, phase: "error", error: code === "generation_unavailable" ? "serviceUnavailable" : "readFailed" });
            } finally { if (listRead === operation) listRead = null; }
        },
        async rename(taskId: string, title: string): Promise<boolean> {
            if (!current() || renameWrite || state.phase !== "ready" || !state.items.some(row => row.taskId === taskId) || !client.rename) return false;
            const operation = new AbortController(); renameWrite = operation;
            const active = () => current() && renameWrite === operation && !operation.signal.aborted;
            try {
                const saved = await client.rename(taskId, title, operation.signal);
                if (!active()) return false;
                publish({ ...state, items: state.items.map(row => row.taskId === taskId ? { ...row, title: saved } : row) });
                if (state.query.search) void reader.read({ ...state.query, pageNumber: 1 });
                return true;
            } catch (cause) {
                if (active() && accountFailure(cause)) blockAccount();
                return false;
            } finally { if (renameWrite === operation) renameWrite = null; }
        },
        async preview(taskId: string, imageId?: string) {
            if (!current() || state.phase === "loading") return;
            const item = state.items.find((row) => row.taskId === taskId);
            if (!item || !item.type || item.type === "text" || !item.result) return;
            const previous = state.previews[taskId];
            if (imageId !== undefined && (state.detail?.taskId !== taskId || !historyImageIds(item, state.detail.value).includes(imageId))) return;
            const mediaId = imageId ?? historyMediaId(item.result.url);
            const selected = item.type === "image" && mediaId ? { imageId: mediaId } : {};
            if (previous?.imageId === selected.imageId && (imageReads.has(taskId) || previous?.status === "ready")) return;
            if (!mediaId) {
                publish({ ...state, previews: { ...state.previews, [taskId]: { status: "error" } } }); return;
            }
            imageReads.get(taskId)?.abort();
            if (previous?.url) revokeUrl(previous.url);
            const operation = new AbortController(), version = sequence;
            imageReads.set(taskId, operation);
            publish({ ...state, previews: { ...state.previews, [taskId]: { status: "loading", ...selected } } });
            const active = () => current() && version === sequence && imageReads.get(taskId) === operation && !operation.signal.aborted;
            const media = options.mediaClient?.(operation.signal) ?? createMediaClient(() => active() ? options.scope.accountId : null,
                (input, init) => fetch(input, { ...init, signal: operation.signal }));
            try {
                const resolved = await media.resolve([mediaId]);
                if (!active()) return;
                const owned = resolved.items.find((row) => row.id === mediaId);
                if (resolved.missing.length || resolved.items.length !== 1 || !owned || owned.kind !== item.type || !owned.contentType.startsWith(`${item.type}/`) || historyMediaId(owned.url) !== mediaId) throw new Error("Unconfirmed media");
                const imageExtension = item.type === "image" ? rasterExtensions.get(owned.contentType) : undefined;
                if (item.type === "image" && !imageExtension) throw new Error("Unconfirmed raster image");
                const blob = await media.download(mediaId);
                if (!active()) return;
                if (blob.type !== owned.contentType || blob.size !== owned.sizeBytes) throw new Error("Unconfirmed media content");
                const url = createUrl(blob);
                if (!active()) { revokeUrl(url); return; }
                publish({ ...state, previews: { ...state.previews, [taskId]: { status: "ready", url, ...selected, ...(imageExtension ? { imageExtension } : {}) } } });
            } catch (cause) {
                if (!active()) return;
                if (accountFailure(cause)) { blockAccount(); return; }
                publish({ ...state, previews: { ...state.previews, [taskId]: { status: "error", ...selected } } });
            } finally { if (imageReads.get(taskId) === operation) imageReads.delete(taskId); }
        },
        previewFailed(taskId: string, url?: string) {
            if (!current()) return;
            const preview = state.previews[taskId];
            if (!preview || preview.status !== "ready" || (url !== undefined && preview.url !== url)) return;
            if (preview.url) revokeUrl(preview.url);
            publish({ ...state, previews: { ...state.previews, [taskId]: { status: "error", ...(preview.imageId ? { imageId: preview.imageId } : {}) } } });
        },
    };
    return reader;
}
