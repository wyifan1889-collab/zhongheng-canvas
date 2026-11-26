import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { type VideoGenerationIntent, type VideoGenerationScope } from "@/services/saas/video-generation";
import { createMappedVideoGenerationClient, type VideoMappingModel } from "@/services/saas/mapped-video-generation";
import { selectedVideoMapping } from "./mapped-video-settings";
import { createMediaClient } from "@/services/api/media";
import { getImageBlob } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import { generationTracker, generationTrackingPresentation, type GenerationTrackerEntry } from "@/stores/use-generation-tracker";
import { useAccountStore } from "@/stores/use-account-store";
import { invalidatePlatformWallet } from "@/services/saas/platform-wallet-refresh";
import { creationReferenceSendIssue } from "@/lib/creation-reference-limits";
import { createVideoReceiptStore, createVideoWorkbenchSession, readPrivateVideo, type VideoReceipt, type VideoWorkbenchSession, type VideoWorkbenchState } from "./platform-video-workbench";
import { registerVideoTask, videoTaskResponseIsStale, videoTaskStatusSignature } from "./video-task-tracking";
import type { VideoDraftParameters } from "./video-parameters";
export type PlatformVideoInput = { prompt: string; references: ReferenceImage[]; selection: VideoDraftParameters };
// Display families may be renamed or regrouped while the same execution is still pending.
export const draftIdentity = (input: PlatformVideoInput) => JSON.stringify([input.prompt, input.selection.modelId, input.selection.parameters,
    input.references.map(reference => [reference.id, reference.storageKey ?? null, reference.type])]);
export function videoReferenceIssue(count: number, selection: VideoDraftParameters) {
    const existing = creationReferenceSendIssue(count, "video");
    if (existing) return existing;
    if (!selection.parameters) return "请主动选择已发布的完整视频规格。";
    const supported = selection.parameters.mode === "text" ? 0 : 1;
    return count === supported ? "" : `当前${supported ? "首帧规格仅支持1张本人图片" : "文生规格不支持参考图片"}；全部草稿已保留，请自行调整后查看费用。`;
}
export function usePlatformVideoWorkbench(scope: VideoGenerationScope, input: PlatformVideoInput, ready: boolean, isContextCurrent?: () => boolean) {
    const live = useRef(false), props = useRef({ input, ready, isContextCurrent }); props.current = { input, ready, isContextCurrent };
    const session = useRef<VideoWorkbenchSession | null>(null), client = useRef<ReturnType<typeof createMappedVideoGenerationClient> | null>(null);
    const receipts = useRef(createVideoReceiptStore(scope));
    const [state, setState] = useState<VideoWorkbenchState | null>(null), [models, setModels] = useState<VideoMappingModel[]>([]);
    const [loading, setLoading] = useState(true), [records, setRecords] = useState<VideoReceipt[]>([]), [recordsReady, setRecordsReady] = useState(false);
    const [error, setError] = useState(""), [preparing, setPreparing] = useState(false), [mediaBusy, setMediaBusy] = useState(false);
    const [video, setVideo] = useState<{ url: string; blob: Blob; taskId: string } | null>(null), videoRef = useRef(video); videoRef.current = video;
    const prepareLock = useRef(false), mediaLock = useRef(false), quotedInput = useRef(""), beforeRead = useRef<GenerationTrackerEntry | undefined>(undefined);
    const catalogRequest = useRef(0), catalogLoading = useRef(false);
    const inputKey = JSON.stringify(input), lastInput = useRef(inputKey), lastRead = useRef("");
    const tracked = useSyncExternalStore(generationTracker.subscribe, generationTracker.getState);
    const getScope = () => live.current && props.current.isContextCurrent?.() !== false ? useAccountStore.getState().getDraftScope() : null;
    const current = () => { const next = getScope(); return next?.accountId === scope.accountId && next.epoch === scope.epoch; };
    const trackedEntry = (taskId: string) => Object.values(generationTracker.getState().entries).find(item => item.accountId === scope.accountId && item.epoch === scope.epoch && item.taskId === taskId);
    const clearVideo = () => { if (videoRef.current) URL.revokeObjectURL(videoRef.current.url); videoRef.current = null; setVideo(null); };
    const readRecords = async (expected = session.current) => { const items = await receipts.current.list(scope.accountId); if (current() && session.current === expected) { setRecords(items); setRecordsReady(true); } return items; };
    const replace = () => {
        session.current?.close(); clearVideo(); beforeRead.current = undefined; lastRead.current = "";
        const owner = createVideoWorkbenchSession({ scope, getScope, client: client.current!, receipts: receipts.current,
            isIntentCurrent: () => quotedInput.current === JSON.stringify(props.current.input), getDraftIdentity: () => draftIdentity(props.current.input),
            validateView: view => !videoTaskResponseIsStale(beforeRead.current, trackedEntry(view.task.id), scope, view),
            onAccepted: view => { if (current()) { registerVideoTask(scope, view); invalidatePlatformWallet(scope); void readRecords().catch(() => {}); } } });
        owner.subscribe(() => { if (session.current === owner && owner.isCurrent()) setState(owner.getState()); });
        session.current = owner; setState(owner.getState()); return owner;
    };
    const reloadModels = async (signal?: AbortSignal) => {
        const api = client.current;
        if (!api || !current() || catalogLoading.current || prepareLock.current || session.current?.getState().busy) return;
        const request = ++catalogRequest.current; catalogLoading.current = true;
        session.current?.invalidateQuote(); setModels([]); setLoading(true); setError("");
        try { const items = await api.mappedModels(signal); if (current() && client.current === api && request === catalogRequest.current) setModels(items); }
        catch (cause) { if (current() && client.current === api && request === catalogRequest.current) setError(cause instanceof Error ? cause.message : "平台视频目录读取失败。"); }
        finally { if (current() && client.current === api && request === catalogRequest.current) { catalogLoading.current = false; setLoading(false); } }
    };
    useLayoutEffect(() => { if (lastInput.current !== inputKey) { lastInput.current = inputKey; session.current?.invalidateQuote(); } }, [inputKey]);
    useEffect(() => {
        live.current = true; const api = createMappedVideoGenerationClient({ scope, getScope }); client.current = api; const owner = replace();
        const abort = new AbortController();
        catalogLoading.current = false; void reloadModels(abort.signal);
        void readRecords(owner).then(async items => { if (!owner.isCurrent() || !items[0]) return; beforeRead.current = items[0].taskId ? trackedEntry(items[0].taskId) : undefined; await owner.restore(items[0]); }).catch(cause => { if (owner.isCurrent()) setError(cause instanceof Error ? cause.message : "视频回执读取失败，请保留本机数据。"); });
        return () => { live.current = false; ++catalogRequest.current; abort.abort(); owner.close(); session.current?.close(); if (videoRef.current) URL.revokeObjectURL(videoRef.current.url); videoRef.current = null; };
    }, [scope.accountId, scope.epoch]);
    useEffect(() => {
        const owner = session.current, task = state?.view?.task; if (!owner?.isCurrent() || !task || state?.busy) return;
        const entry = trackedEntry(task.id); if (!entry || entry.readStatus !== "ready") return;
        const signature = `${task.id}:${videoTaskStatusSignature(entry)}`;
        if (videoTaskStatusSignature(task) !== videoTaskStatusSignature(entry) && signature !== lastRead.current) { lastRead.current = signature; beforeRead.current = entry; void owner.refresh(); }
    }, [tracked, state]);
    const loadVideo = async () => {
        const owner = session.current, view = owner?.getState().view; if (!owner?.isCurrent() || !view || mediaLock.current) return;
        mediaLock.current = true; attemptedMedia.current = view.task.id; setMediaBusy(true); setError("");
        try {
            const blob = await readPrivateVideo(view, createMediaClient(() => current() ? scope.accountId : null), () => owner === session.current && owner.isCurrent());
            if (owner !== session.current || !owner.isCurrent()) return;
            clearVideo(); const next = { blob, url: URL.createObjectURL(blob), taskId: view.task.id }; videoRef.current = next; setVideo(next);
        } catch (cause) { if (owner === session.current && owner.isCurrent()) setError(cause instanceof Error ? cause.message : "视频读取待核对。"); }
        finally { mediaLock.current = false; if (current()) setMediaBusy(false); }
    };
    const attemptedMedia = useRef("");
    useEffect(() => { const view = state?.view; if (!mediaBusy && view?.task.executionStatus === "succeeded" && view.task.billingStatus === "captured" && ["saved", "visible"].includes(view.task.deliveryStatus) && attemptedMedia.current !== view.task.id) void loadVideo(); }, [state?.view, mediaBusy]);
    return { state, models, loading, records, recordsReady, error, preparing, video, mediaBusy, loadVideo, reloadModels: () => reloadModels(), isCurrent: current,
        isVideoCurrent: (taskId: string) => current() && videoRef.current?.taskId === taskId,
        async prepare() {
            if (!ready || loading || catalogLoading.current || !recordsReady || !current() || prepareLock.current || session.current?.getState().busy) return;
            prepareLock.current = true; setPreparing(true); setError("");
            try {
                const fixed = structuredClone(props.current.input), parameters = fixed.selection.parameters;
                const issue = videoReferenceIssue(fixed.references.length, fixed.selection); if (issue || !parameters || !fixed.prompt.trim()) throw new Error(issue || "请填写视频描述。");
                if (!selectedVideoMapping(models, fixed.selection)) throw new Error("原规格尚未发布，请重新选择平台视频规格。");
                const previous = await receipts.current.list(scope.accountId);
                if (!current()) return;
                if (previous.some(receipt => receipt.draftIdentity === draftIdentity(fixed) && receipt.state !== "rejected" && (!receipt.view || !generationTrackingPresentation(receipt.view.task).terminal))) throw new Error("此视频草稿已有未结束回执，请从生成记录查询原任务，不要重复生成。");
                quotedInput.current = JSON.stringify(fixed); const owner = replace();
                let referenceMediaId: string | undefined;
                if (parameters.mode === "first_frame") {
                    const reference = fixed.references[0]; if (!reference.storageKey) throw new Error("首帧缺少本人本机图片，请重新选择图片；不读取外部URL。");
                    const blob = await getImageBlob(reference.storageKey); if (!owner.isCurrent() || quotedInput.current !== JSON.stringify(props.current.input)) throw new Error("输入已变化，本次没有查看费用。");
                    if (!blob) throw new Error("首帧原图片不可读取，草稿已保留。");
                    const uploaded = await createMediaClient(() => owner.isCurrent() ? scope.accountId : null).upload(blob);
                    if (!owner.isCurrent() || quotedInput.current !== JSON.stringify(props.current.input)) throw new Error("输入已变化，本次没有查看费用。");
                    if (uploaded.media.kind !== "image") throw new Error("首帧归属返回无效。"); referenceMediaId = uploaded.media.id;
                }
                const intent: VideoGenerationIntent = { modelId: fixed.selection.modelId, input: { prompt: fixed.prompt, ...(referenceMediaId ? { referenceMediaId } : {}) }, parameters };
                await owner.prepare(intent);
            } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "视频费用读取失败。"); }
            finally { prepareLock.current = false; if (current()) setPreparing(false); }
        },
        async confirm() { await session.current?.confirm(); if (current()) await readRecords().catch(cause => setError(String(cause))); },
        cancelQuote() { session.current?.invalidateQuote(); },
        async refresh() { const id = session.current?.getState().receipt?.taskId; beforeRead.current = id ? trackedEntry(id) : undefined; await session.current?.refresh(); },
        async restore(receipt: VideoReceipt) { if (session.current?.getState().busy || prepareLock.current) return; const owner = replace(); beforeRead.current = receipt.taskId ? trackedEntry(receipt.taskId) : undefined; await owner.restore(receipt); },
        clear() { if (session.current?.getState().busy || prepareLock.current) return false; replace(); return true; },
    };
}
