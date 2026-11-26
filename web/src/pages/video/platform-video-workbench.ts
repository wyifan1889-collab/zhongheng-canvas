import localforage from "localforage";
import { GenerationError } from "@/services/saas/generation";
import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import { parsePublicVideoQuote, parseVideoIntent, parseVideoTaskView, sameVideoParameters, videoIntentKey, videoTaskMatches, type VideoGenerationClient, type VideoGenerationIntent, type VideoGenerationScope, type VideoGenerationTaskView } from "@/services/saas/video-generation";
import type { PublicVideoQuote } from "../../../../packages/shared/src/generation-video";
import { generationTrackingPresentation } from "@/stores/use-generation-tracker";

export type VideoReceipt = { id: string; accountId: string; createdAt: number; intent: VideoGenerationIntent; quote: PublicVideoQuote; draftIdentity?: string;
    taskId?: string; state: "submitting" | "accepted" | "unconfirmed" | "rejected"; view?: VideoGenerationTaskView; error?: string };
export type VideoReceiptStore = { put(value: VideoReceipt): Promise<unknown>; list(accountId: string): Promise<VideoReceipt[]> };
export function parseVideoReceipt(value: unknown): VideoReceipt | null {
    if (!value || typeof value !== "object") return null;
    const row = value as VideoReceipt, intent = parseVideoIntent(row.intent), quote = parsePublicVideoQuote(row.quote);
    const view = row.view === undefined ? undefined : parseVideoTaskView(row.view);
    if (!/^video:[0-9a-f-]{36}$/i.test(row.id) || typeof row.accountId !== "string" || !row.accountId || !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0 ||
        !intent || !quote || quote.modelId !== intent.modelId || !sameVideoParameters(quote.parameters, intent.parameters) || !["submitting", "accepted", "unconfirmed", "rejected"].includes(row.state) || view === null ||
        row.taskId !== undefined && !/^[0-9a-f-]{36}$/i.test(row.taskId) || row.error !== undefined && typeof row.error !== "string" || row.draftIdentity !== undefined && typeof row.draftIdentity !== "string" ||
        view && (!videoTaskMatches(view, intent, quote) || view.task.id !== row.taskId)) return null;
    return { id: row.id, accountId: row.accountId, createdAt: row.createdAt, intent, quote, state: row.state,
        ...(row.taskId ? { taskId: row.taskId } : {}), ...(view ? { view } : {}), ...(row.error ? { error: row.error } : {}), ...(row.draftIdentity ? { draftIdentity: row.draftIdentity } : {}) };
}
const stores = new Map<string, ReturnType<typeof localforage.createInstance>>();
export function createVideoReceiptStore(scope: VideoGenerationScope): VideoReceiptStore {
    const name = accountScopedStoreName("platform_video_receipts", scope);
    let storage = stores.get(name);
    if (!storage) { storage = localforage.createInstance({ name: "infinite-canvas", storeName: name }); stores.set(name, storage); }
    const fixed = storage;
    return {
        async put(value) { const parsed = parseVideoReceipt(value); if (!parsed || parsed.accountId !== scope.accountId) throw new Error("视频回执无法安全保存。"); await fixed.setItem(parsed.id, parsed); },
        async list(accountId) {
            if (accountId !== scope.accountId) throw new Error("视频回执账号不匹配。");
            const result: VideoReceipt[] = [];
            await fixed.iterate(value => { const receipt = parseVideoReceipt(value); if (!receipt || receipt.accountId !== accountId) throw new Error("视频回执损坏，请保留本机数据。"); result.push(receipt); });
            return result.sort((a, b) => b.createdAt - a.createdAt);
        },
    };
}
export type VideoWorkbenchState = { phase: "idle" | "quoting" | "ready" | "submitting" | "tracking" | "uncertain" | "rejected";
    busy: boolean; quote: PublicVideoQuote | null; receipt: VideoReceipt | null; view: VideoGenerationTaskView | null; error: string };
/** One confirmed intent. Recovered/uncertain receipts never expose a submit operation. */
export function createVideoWorkbenchSession(options: { scope: VideoGenerationScope; getScope: () => VideoGenerationScope | null;
    client: VideoGenerationClient; receipts: VideoReceiptStore; isIntentCurrent: () => boolean;
    onAccepted?: (view: VideoGenerationTaskView) => void; validateView?: (view: VideoGenerationTaskView) => boolean; createKey?: () => string; getDraftIdentity?: () => string }) {
    let active = true, attempted = false, sequence = 0, intent: VideoGenerationIntent | null = null;
    let state: VideoWorkbenchState = { phase: "idle", busy: false, quote: null, receipt: null, view: null, error: "" };
    const listeners = new Set<() => void>();
    const current = () => { const now = options.getScope(); return active && now?.accountId === options.scope.accountId && now.epoch === options.scope.epoch; };
    const check = () => { if (!current()) throw new Error("账号或页面已变化，请在原账号核对视频回执。"); };
    const publish = (patch: Partial<VideoWorkbenchState>) => { if (current()) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); } };
    async function persist(receipt: VideoReceipt) { check(); await options.receipts.put(receipt); check(); }
    async function accept(receipt: VideoReceipt, view: VideoGenerationTaskView) {
        check(); if (!videoTaskMatches(view, receipt.intent, receipt.quote) || receipt.taskId && receipt.taskId !== view.task.id) throw new Error("原视频任务与确认回执不一致，请保留回执核对。");
        const next: VideoReceipt = { ...receipt, taskId: view.task.id, view, state: "accepted", error: undefined };
        if (options.validateView?.(view) === false) throw new Error("任务状态已更新，请主动查询原视频任务。");
        await persist(next);
        if (options.validateView?.(view) === false) throw new Error("任务状态已更新，请主动查询原视频任务。");
        publish({ phase: "tracking", busy: false, receipt: next, view, quote: null, error: "" }); options.onAccepted?.(view);
    }
    async function refresh() {
        if (state.busy || !state.receipt || state.receipt.state === "rejected") return;
        const receipt = state.receipt; publish({ busy: true, error: "" });
        try { check(); const view = receipt.taskId ? await options.client.get(receipt.taskId) : await options.client.recover(receipt.id); await accept(receipt, view); }
        catch (cause) { publish({ busy: false, phase: "uncertain", error: cause instanceof Error ? cause.message : "原视频任务读取待核对。" }); }
    }
    return {
        getState: () => state, isCurrent: current, close() { active = false; ++sequence; listeners.clear(); },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        invalidateQuote() { if (attempted || state.receipt) return; ++sequence; intent = null; publish({ phase: "idle", quote: null, busy: false, error: "" }); },
        async listReceipts() { check(); const result = await options.receipts.list(options.scope.accountId); check(); return result; },
        async prepare(value: VideoGenerationIntent) {
            if (state.busy || attempted || state.receipt) return;
            const version = ++sequence; publish({ phase: "quoting", busy: true, quote: null, error: "" });
            try {
                check(); const parsed = parseVideoIntent(value); if (!parsed || !options.isIntentCurrent()) throw new Error("视频输入已变化，请重新选择完整规格。");
                const receipts = await options.receipts.list(options.scope.accountId); check();
                if (receipts.some(receipt => videoIntentKey(receipt.intent) === videoIntentKey(parsed) && receipt.state !== "rejected" && (!receipt.view || !generationTrackingPresentation(receipt.view.task).terminal))) throw new Error("相同视频意图已有未结束回执，请从生成记录查询原任务；不会再次提交。");
                const quote = await options.client.quote(parsed); check(); if (version !== sequence) return;
                if (!options.isIntentCurrent()) throw new Error("视频输入已变化，请重新查看费用。");
                intent = structuredClone(parsed); publish({ phase: "ready", busy: false, quote });
            } catch (cause) { if (version === sequence) publish({ phase: "idle", busy: false, error: cause instanceof Error ? cause.message : "视频费用读取失败，草稿已保留。" }); }
        },
        async confirm() {
            if (attempted || state.busy || state.phase !== "ready" || !intent || !state.quote) return;
            let receipt: VideoReceipt | undefined, sent = false;
            try {
                check(); if (!options.isIntentCurrent()) throw new Error("视频输入已变化，本次没有提交。");
                attempted = true;
                receipt = { id: options.createKey?.() ?? `video:${crypto.randomUUID()}`, accountId: options.scope.accountId, createdAt: Date.now(), intent, quote: state.quote, state: "submitting",
                    ...(options.getDraftIdentity ? { draftIdentity: options.getDraftIdentity() } : {}) };
                publish({ phase: "submitting", busy: true, receipt });
                await persist(receipt); check(); if (!options.isIntentCurrent()) throw new Error("视频输入已变化，本次没有发送；请保留回执。");
                sent = true; const view = await options.client.submit(intent, state.quote!, receipt.id); await accept(receipt, view);
            } catch (cause) {
                const error = cause instanceof Error ? cause.message : "提交结果待核对，请保留回执。";
                const rejected = sent && cause instanceof GenerationError && cause.outcome === "rejected";
                if (receipt && current()) {
                    const next: VideoReceipt = { ...receipt, state: rejected || !sent ? "rejected" : "unconfirmed", error };
                    try { await persist(next); } catch { publish({ error: `${error} 回执保存尚未确认，请保留此页面。` }); }
                    publish({ receipt: next });
                }
                publish({ busy: false, phase: rejected || !sent ? "rejected" : "uncertain", quote: null, error });
            } finally { intent = null; }
        },
        async restore(value: VideoReceipt) {
            if (state.busy || attempted) return;
            check(); const receipt = parseVideoReceipt(value); if (!receipt || receipt.accountId !== options.scope.accountId) throw new Error("视频回执账号或内容不匹配。");
            attempted = true; intent = null; publish({ receipt, view: null, quote: null, phase: receipt.state === "rejected" ? "rejected" : "uncertain", error: receipt.error ?? "" });
            if (receipt.state !== "rejected") await refresh();
        }, refresh,
    };
}
export type VideoWorkbenchSession = ReturnType<typeof createVideoWorkbenchSession>;

export async function readPrivateVideo(view: VideoGenerationTaskView, media: { download(id: string): Promise<Blob> }, isCurrent: () => boolean): Promise<Blob> {
    const task = view.task, ref = view.result?.resultSnapshot.media;
    if (!isCurrent() || task.executionStatus !== "succeeded" || !["saved", "visible"].includes(task.deliveryStatus) || task.billingStatus !== "captured" ||
        task.video.phase !== "completed" || view.result?.status !== "succeeded" || !ref || ref.mediaId !== task.id) throw new Error("视频尚未完成私有交付或费用核对，请查询原任务。");
    const blob = await media.download(ref.mediaId);
    if (!isCurrent()) throw new Error("账号已变化，未采用视频内容。");
    if (blob.type !== ref.contentType || blob.size !== ref.sizeBytes) throw new Error("视频内容与原媒体记录不一致，请保留回执核对。");
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    if (!isCurrent()) throw new Error("账号已变化，未采用视频内容。");
    if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") !== ref.etag) throw new Error("视频完整性核对失败，请保留回执。");
    return blob;
}
