import { CloudMediaError, type CloudMedia, type CloudMediaQuota, type createMediaClient } from "@/services/api/media";

export type CloudAssetState = {
    items: CloudMedia[]; quota: CloudMediaQuota | null; loading: boolean; uploading: boolean;
    error: string | null; previews: Record<string, { status: "loading" | "ready" | "error"; url?: string }>;
};
export const initialCloudAssetState = (): CloudAssetState => ({ items: [], quota: null, loading: false, uploading: false, error: null, previews: {} });

/** Assets-page request lifetime and owned Blob URLs. No timers or automatic retries. */
export function createCloudAssetReader(options: {
    client: Pick<ReturnType<typeof createMediaClient>, "list" | "download" | "upload" | "remove">;
    isCurrent: () => boolean; onState: (state: CloudAssetState) => void; loadFailed: string;
    createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void;
}) {
    let state = initialCloudAssetState(), stopped = false, generation = 0, listSequence = 0;
    let listBusy = false, mutationBusy = false;
    const pending = new Set<string>();
    const createUrl = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
    const revokeUrl = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
    const current = () => !stopped && options.isCurrent();
    const publish = (next: CloudAssetState) => { state = next; options.onState(next); };
    const clearPreviews = () => {
        generation += 1; pending.clear();
        Object.values(state.previews).forEach((preview) => { if (preview.url) revokeUrl(preview.url); });
    };
    async function preview(id: string) {
        if (!current() || pending.has(id) || state.previews[id]?.status === "ready" || !state.items.some((item) => item.id === id)) return;
        const version = generation;
        pending.add(id);
        publish({ ...state, previews: { ...state.previews, [id]: { status: "loading" } } });
        const active = () => current() && version === generation;
        try {
            const blob = await options.client.download(id);
            if (!active()) return;
            const url = createUrl(blob);
            if (!active()) { revokeUrl(url); return; }
            publish({ ...state, previews: { ...state.previews, [id]: { status: "ready", url } } });
        } catch {
            if (active()) publish({ ...state, previews: { ...state.previews, [id]: { status: "error" } } });
        } finally { if (version === generation) pending.delete(id); }
    }
    function replace(items: CloudMedia[], quota: CloudMediaQuota) {
        clearPreviews();
        publish({ ...state, items, quota, previews: {} });
        items.forEach((item) => { void preview(item.id); });
    }
    return {
        snapshot: () => current() ? state : initialCloudAssetState(),
        dispose() { clearPreviews(); stopped = true; state = initialCloudAssetState(); },
        preview,
        previewFailed(id: string) {
            if (!current() || state.previews[id]?.status !== "ready") return;
            const url = state.previews[id].url;
            if (url) revokeUrl(url);
            publish({ ...state, previews: { ...state.previews, [id]: { status: "error" } } });
        },
        async read() {
            if (!current() || listBusy || mutationBusy) return;
            const version = ++listSequence;
            listBusy = true;
            publish({ ...state, loading: true });
            const active = () => current() && version === listSequence;
            try {
                const result = await options.client.list();
                if (!active()) return;
                publish({ ...state, loading: false, error: null });
                replace(result.items, result.quota);
            } catch (error) {
                if (active()) publish({ ...state, loading: false, error: error instanceof CloudMediaError ? error.message : options.loadFailed });
            } finally { if (version === listSequence) listBusy = false; }
        },
        async upload(file: Blob) {
            if (!current() || mutationBusy) return false;
            mutationBusy = true;
            publish({ ...state, uploading: true });
            try {
                const result = await options.client.upload(file);
                if (!current()) return false;
                listSequence += 1; listBusy = false;
                publish({ ...state, loading: false });
                replace([result.media, ...state.items.filter((item) => item.id !== result.media.id)], result.quota);
                return true;
            } finally {
                mutationBusy = false;
                if (current()) publish({ ...state, uploading: false });
            }
        },
        async remove(id: string) {
            if (!current() || mutationBusy) return false;
            mutationBusy = true;
            try {
                const quota = await options.client.remove(id);
                if (!current()) return false;
                listSequence += 1; listBusy = false;
                publish({ ...state, loading: false });
                replace(state.items.filter((item) => item.id !== id), quota);
                return true;
            } finally { mutationBusy = false; }
        },
    };
}
