import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, App, Button, Drawer, Empty, Input, Modal, Select, Spin, Tag, Typography } from "@/components/creation/ui";
import { ArrowUp, AudioLines, Download, History, Plus, RefreshCw, Trash2 } from "lucide-react";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useLocation } from "react-router-dom";

import { useAccountStore } from "@/stores/use-account-store";
import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import { createMediaClient } from "@/services/api/media";
import { GenerationError } from "@/services/saas/generation";
import { invalidatePlatformWallet } from "@/services/saas/platform-wallet-refresh";
import { createAudioGenerationClient, type AudioGenerationIntent, type AudioGenerationModel, type AudioGenerationQuote, type AudioGenerationTaskView, type AudioGenerationScope } from "@/services/saas/audio-generation";
import { AudioParametersForm, DEFAULT_AUDIO_PARAMETERS, audioVoiceLabel, selectAudioModelParameters, type AudioParameters } from "./audio-parameters";
import { useCreationMediaLaunch, type CreationMediaDraft, type CreationMediaLaunch } from "@/stores/use-creation-media-launch";
import { generationTracker, isGenerationTrackingUncertain, type GenerationTrackerEntry } from "@/stores/use-generation-tracker";
import { audioTaskReadIssue, audioTaskResponseIsStale, audioTaskStatusSignature, createAudioTaskRegistration } from "./audio-task-tracking";
import { isCreationMediaTarget } from "@/lib/creation-routes";
import { CreationHint, CreationParameters, CreationToolbar, CreationToolsMenu, CreationWorkbench } from "@/components/creation/creation-workbench";
import { firstPlatformDefault } from "@/components/creation/creation-platform-default";
import { useCreationShortcutTarget } from "@/components/creation/creation-shortcut-target-context";
import { AudioPlayer } from "./audio-player";

type Receipt = {
    id: string;
    createdAt: number;
    parameters: AudioParameters;
    taskId?: string;
    view?: AudioGenerationTaskView;
    state: "submitting" | "accepted" | "unconfirmed" | "rejected";
    paused?: boolean;
    error?: string;
};

function finished(view?: AudioGenerationTaskView) {
    const task = view?.task;
    return !!task && (task.executionStatus === "succeeded" && ["saved", "visible"].includes(task.deliveryStatus) && task.billingStatus === "captured"
        || ["failed", "cancelled"].includes(task.executionStatus) && task.deliveryStatus === "failed" && ["released", "unbilled"].includes(task.billingStatus));
}

function receiptStatus(receipt: Receipt) {
    if (receipt.state === "rejected") return "未受理";
    if (!receipt.view) return receipt.state === "submitting" ? "提交中" : "提交待核对";
    const task = receipt.view.task;
    if (task.executionStatus === "succeeded" && ["saved", "visible"].includes(task.deliveryStatus)) return task.billingStatus === "captured" ? "已完成" : "音频已保存，费用待核对";
    if (finished(receipt.view)) return task.executionStatus === "cancelled" ? "已取消" : "生成失败";
    if (["unknown", "timeout"].includes(task.executionStatus) || task.billingStatus === "pending_review" || ["unknown", "failed"].includes(task.deliveryStatus)) return "结果待核对";
    return receipt.paused ? "查询已暂停" : "生成中";
}

function withView(receipt: Receipt, view: AudioGenerationTaskView): Receipt {
    const snapshot = view.task.audioSnapshot;
    return { ...receipt, taskId: view.task.id, view, state: "accepted", paused: isGenerationTrackingUncertain(view.task), error: undefined,
        ...(snapshot.status === "recorded" ? { parameters: { ...DEFAULT_AUDIO_PARAMETERS, prompt: snapshot.input.text,
            model: view.task.modelId, voice: snapshot.parameters.voice, format: snapshot.parameters.format,
            style: snapshot.parameters.style ?? "", language: snapshot.parameters.language ?? "" } } : {}) };
}

function intent(parameters: AudioParameters): AudioGenerationIntent {
    return { modelId: parameters.model, input: { text: parameters.prompt }, parameters: {
        voice: parameters.voice, format: parameters.format,
        ...(parameters.style ? { style: parameters.style } : {}), ...(parameters.language ? { language: parameters.language } : {}),
    } };
}

function validReceipt(value: unknown): value is Receipt {
    if (!value || typeof value !== "object") return false;
    const receipt = value as Receipt, parameters = receipt.parameters;
    return typeof receipt.id === "string" && /^audio:[0-9a-f-]{36}$/.test(receipt.id)
        && Number.isSafeInteger(receipt.createdAt) && receipt.createdAt > 0 && !!parameters
        && ["prompt", "model", "voice", "style", "language"].every(key => typeof parameters[key as keyof AudioParameters] === "string")
        && ["mp3", "wav"].includes(parameters.format) && parameters.loop === false && parameters.instrumental === false && parameters.seconds === undefined
        && ["submitting", "accepted", "unconfirmed", "rejected"].includes(receipt.state)
        && (receipt.taskId === undefined || /^[0-9a-f-]{36}$/i.test(receipt.taskId));
}

export default function AudioPage({ modeTabs, music = false }: { modeTabs?: ReactNode; music?: boolean } = {}) {
    const account = useAccountStore(), scope = account.getDraftScope();
    return scope ? <AudioWorkbench key={`${scope.accountId}:${scope.epoch}`} scope={scope} modeTabs={modeTabs} music={music} /> : <Empty description="请登录后使用音频生成" />;
}

function AudioWorkbench({ scope, modeTabs, music }: { scope: AudioGenerationScope; modeTabs?: ReactNode; music: boolean }) {
    const { message, modal } = App.useApp();
    const location = useLocation();
    const [parameters, setParameters] = useState<AudioParameters>({ ...DEFAULT_AUDIO_PARAMETERS });
    const [models, setModels] = useState<AudioGenerationModel[]>([]);
    const [modelsLoading, setModelsLoading] = useState(true);
    const [logs, setLogs] = useState<Receipt[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [selectedId, setSelectedId] = useState<string>();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [draftSaveNotice, setDraftSaveNotice] = useState("");
    const [historyError, setHistoryError] = useState("");
    const [confirmation, setConfirmation] = useState<{ quote: AudioGenerationQuote; parameters: AudioParameters } | null>(null);
    const [playback, setPlayback] = useState<{ id: string; url: string; blob: Blob } | null>(null);
    const creation = useCreationMediaLaunch(), restored = useRef(false), consumedLaunch = useRef(""), handledLaunch = useRef("");
    const [draftReady, setDraftReady] = useState(false), [creationLaunch, setCreationLaunch] = useState<CreationMediaLaunch | null>(null);
    const logsRef = useRef<Receipt[]>([]), live = useRef(false), controller = useRef(new AbortController());
    const tracked = useSyncExternalStore(generationTracker.subscribe, generationTracker.getState);
    const polling = useRef<AbortController | null>(null), submissionLock = useRef(false), editRevision = useRef(0), previewRevision = useRef(0);
    const quoteLock = useRef(false);
    const defaultModel = useRef<{ routeKey: string; editRevision: number; parameters: AudioParameters; draft?: CreationMediaDraft } | null>(null);
    const draftOwner = useRef<CreationMediaDraft | undefined>(undefined);
    const applyShortcutPrompt = (prompt: string) => {
        draftOwner.current = useCreationMediaLaunch.getState().drafts.audio;
        setDraftSaveNotice("");
        editRevision.current++; setConfirmation(null); setParameters(value => ({ ...value, prompt }));
    };
    useCreationShortcutTarget({ kind: "audio", scope, enabled: !music, ready: draftReady && !busy && !submissionLock.current && !quoteLock.current,
        watch: [parameters], onApply: applyShortcutPrompt });
    const playbackUrl = useRef<string | null>(null);
    const selection = useRef<string | undefined>(undefined);
    const removed = useRef(new Set<string>()), readVersions = useRef(new Map<string, number>()), writes = useRef(Promise.resolve());
    const trackingReads = useRef(new Map<string, string>());
    const client = useMemo(() => createAudioGenerationClient({ scope, getScope: () => useAccountStore.getState().getDraftScope() }), [scope.accountId, scope.epoch]);
    const storage = useMemo(() => localforage.createInstance({ name: "infinite-canvas", storeName: accountScopedStoreName("audio_generation_logs", scope) }), [scope.accountId]);
    const current = () => {
        const next = useAccountStore.getState().getDraftScope();
        return live.current && next?.accountId === scope.accountId && next.epoch === scope.epoch;
    };
    const check = () => { if (!current()) throw new Error("账号或页面已变化，请在原账号中查看任务记录。"); };
    const registerTask = useMemo(() => createAudioTaskRegistration({ scope,
        getScope: () => useAccountStore.getState().getDraftScope(), isCurrent: () => current() }), [scope.accountId, scope.epoch]);
    const selected = logs.find(log => log.id === selectedId);
    const selectedReadIssue = audioTaskReadIssue(Object.values(tracked.entries).find(entry => entry.accountId === scope.accountId && entry.epoch === scope.epoch && entry.taskId === selected?.taskId), scope, selected?.taskId);
    const selectReceipt = (id: string | undefined) => { selection.current = id; setSelectedId(id); };
    const selectedModel = models.find(model => model.id === parameters.model);

    const publish = (items: Receipt[]) => { logsRef.current = items; setLogs(items); };
    const queueWrite = (operation: () => Promise<void>) => {
        const pending = writes.current.then(operation);
        writes.current = pending.catch(() => {});
        return pending;
    };
    const save = (receipt: Receipt, version?: number, verified = false, before: GenerationTrackerEntry | undefined = Object.values(generationTracker.getState().entries).find(entry => entry.accountId === scope.accountId && entry.epoch === scope.epoch && entry.taskId === receipt.taskId)) => queueWrite(async () => {
        check();
        const stale = () => removed.current.has(receipt.id) || version !== undefined && readVersions.current.get(receipt.id) !== version;
        if (stale()) return;
        await storage.setItem(receipt.id, receipt);
        check(); if (stale()) return;
        if (verified && receipt.state === "accepted" && receipt.taskId && receipt.view) {
            const after = Object.values(generationTracker.getState().entries).find(entry => entry.accountId === scope.accountId && entry.epoch === scope.epoch && entry.taskId === receipt.taskId);
            if (audioTaskResponseIsStale(before, after, scope, receipt.view)) {
                trackingReads.current.delete(receipt.id);
                receipt = { ...receipt, paused: true, error: "任务状态已更新，详情待核对，请主动查询原任务" }; verified = false;
                await storage.setItem(receipt.id, receipt);
                check(); if (stale()) return;
            }
        }
        if (verified && receipt.state === "accepted" && receipt.taskId && receipt.view) registerTask(receipt.taskId, receipt.view);
        publish([receipt, ...logsRef.current.filter(item => item.id !== receipt.id)].sort((a, b) => b.createdAt - a.createdAt));
    });
    const beginRead = (id: string) => { const version = (readVersions.current.get(id) ?? 0) + 1; readVersions.current.set(id, version); return version; };
    // T4 owns the 2500ms timer across routes. Fetch full details only for a fresh
    // receipt or a newly observed three-state change; never start a second timer.
    const pollLogs = async () => {
        const operation = controller.current;
        if (polling.current || !current() || operation.signal.aborted) return;
        polling.current = operation;
        const active = () => current() && !operation.signal.aborted;
        try {
            while (active()) {
                const entries = Object.values(generationTracker.getState().entries);
                const receipt = logsRef.current.find(log => {
                    if (!log.taskId || log.paused || finished(log.view)) return false;
                    if (!log.view) return true;
                    const entry = entries.find(item => item.accountId === scope.accountId && item.epoch === scope.epoch && item.taskId === log.taskId);
                    return !!entry && entry.readStatus === "ready" && audioTaskStatusSignature(entry) !== audioTaskStatusSignature(log.view.task)
                        && trackingReads.current.get(log.id) !== audioTaskStatusSignature(entry);
                });
                if (!receipt) break;
                const entry = entries.find(item => item.accountId === scope.accountId && item.epoch === scope.epoch && item.taskId === receipt.taskId);
                const before = entry && { ...entry };
                if (entry) trackingReads.current.set(receipt.id, audioTaskStatusSignature(entry));
                const version = beginRead(receipt.id);
                try {
                    const view = await client.get(receipt.taskId!, operation.signal);
                    if (!active() || removed.current.has(receipt.id) || readVersions.current.get(receipt.id) !== version) break;
                    const after = Object.values(generationTracker.getState().entries).find(item => item.accountId === scope.accountId && item.epoch === scope.epoch && item.taskId === receipt.taskId);
                    if (audioTaskResponseIsStale(before, after, scope, view)) {
                        trackingReads.current.delete(receipt.id);
                        throw new Error("任务状态已更新，详情待核对，请主动查询原任务");
                    }
                    invalidatePlatformWallet(scope);
                    await save(withView(receipt, view), version, true, before);
                } catch (cause) {
                    if (!active() || removed.current.has(receipt.id) || readVersions.current.get(receipt.id) !== version) break;
                    const next = { ...receipt, paused: true, error: cause instanceof Error ? cause.message : "读取未完成，请保留任务记录并稍后核对。" };
                    try { await save(next, version); } catch { if (active() && !removed.current.has(receipt.id) && readVersions.current.get(receipt.id) === version) { publish(logsRef.current.map(log => log.id === receipt.id ? next : log)); setError("任务记录保存失败，请保留当前页面和任务编号。"); } }
                }
            }
        } finally { polling.current = null; if (current() && controller.current !== operation) void pollLogs(); }
    };
    const loadModels = async () => {
        const operation = controller.current;
        setModelsLoading(true);
        try { const items = await client.models(operation.signal); check(); if (!operation.signal.aborted) { setModels(items); setError(""); } }
        catch (cause) { if (current() && !operation.signal.aborted) { setModels([]); setError(cause instanceof Error ? cause.message : "音频模型读取失败。"); } }
        finally { if (current() && !operation.signal.aborted) setModelsLoading(false); }
    };

    useEffect(() => {
        live.current = true;
        const operation = new AbortController(); controller.current = operation;
        void loadModels();
        void (async () => {
            try {
                const items: Receipt[] = [];
                await storage.iterate<unknown, void>((value, key) => {
                    if (!validReceipt(value) || key !== value.id) throw new Error("音频日志无法读取，请保留本机数据，不要重新提交原任务。");
                    // Disk snapshots are not a fresh server acknowledgement. Read the original task again.
                    items.push({ ...value, view: undefined, paused: false, state: value.state === "submitting" ? "unconfirmed" : value.state });
                });
                if (operation.signal.aborted) return;
                check(); publish(items.sort((a, b) => b.createdAt - a.createdAt)); setLoaded(true); void pollLogs();
            } catch (cause) { if (!operation.signal.aborted && current()) setHistoryError(cause instanceof Error ? cause.message : "音频日志读取失败。"); }
        })();
        return () => { live.current = false; operation.abort(); previewRevision.current++; if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current); playbackUrl.current = null; };
    }, [client, storage]);
    useEffect(() => { if (loaded) void pollLogs(); }, [tracked, loaded]);
    const clearPlayback = () => { if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current); playbackUrl.current = null; setPlayback(null); };

    const showQuote = async () => {
        if (submissionLock.current || quoteLock.current || !loaded) return;
        quoteLock.current = true;
        const revision = editRevision.current, snapshot = { ...parameters };
        setBusy(true); setError("");
        try {
            const quote = await client.quote(intent(snapshot), controller.current.signal);
            check(); if (revision === editRevision.current) setConfirmation({ quote, parameters: snapshot });
        } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "报价读取失败。"); }
        finally { quoteLock.current = false; if (current()) setBusy(false); }
    };
    useEffect(() => {
        if (restored.current || !creation.ready || creation.scope?.accountId !== scope.accountId || creation.scope.epoch !== scope.epoch) return;
        restored.current = true;
        const draft = creation.drafts.audio;
        draftOwner.current = draft;
        if (!music && !draft && !creation.error && !creation.pending) defaultModel.current = { routeKey: location.key, editRevision: editRevision.current, parameters };
        if (draft) setParameters({ ...draft.parameters as AudioParameters, prompt: draft.prompt });
        setDraftReady(true);
    }, [creation.ready, creation.scope, scope.accountId, scope.epoch]);
    useEffect(() => {
        if (!draftReady || busy || !current() || !isCreationMediaTarget(location.pathname, location.search, "audio") || creation.pending?.draft.kind !== "audio" || consumedLaunch.current === creation.pending.nonce) return;
        const launch = useCreationMediaLaunch.getState().take("audio");
        if (!launch) return;
        draftOwner.current = useCreationMediaLaunch.getState().drafts.audio;
        setDraftSaveNotice("");
        consumedLaunch.current = launch.nonce; editRevision.current++; setConfirmation(null);
        setParameters({ ...launch.draft.parameters as AudioParameters, prompt: launch.draft.prompt }); setCreationLaunch(launch);
    }, [draftReady, creation.pending?.nonce, busy, scope.accountId, scope.epoch, location.pathname, location.search]);
    useEffect(() => {
        if (!draftReady || !creationLaunch || modelsLoading || !loaded && !historyError || handledLaunch.current === creationLaunch.nonce) return;
        handledLaunch.current = creationLaunch.nonce;
        if (!useCreationMediaLaunch.getState().isCurrent(creationLaunch) || JSON.stringify(parameters) !== JSON.stringify(creationLaunch.draft.parameters)) { setError("自动查看费用已取消：草稿或账号发生变化，当前输入已保留。"); return; }
        if (!loaded) { setError("尚未查看费用：原音频日志尚未可靠读取，朗读草稿已保留。"); return; }
        if (!selectedModel || !selectedModel.audio.voices.includes(parameters.voice) || !selectedModel.audio.formats.includes(parameters.format) || !selectedModel.audio.instructions && !!(parameters.style || parameters.language)) { setError("尚未查看费用：所选平台音频模型或参数当前不可用，朗读草稿已保留；请选择有效模型和音色后继续。"); return; }
        void showQuote();
    }, [draftReady, creationLaunch, modelsLoading, loaded, historyError, models, parameters]);
    const persistDraft = () => {
        if (!draftReady || !current() || creation.pending?.draft.kind === "audio") return;
        const next = { kind: "audio" as const, prompt: parameters.prompt, references: [], parameters }, previous = useCreationMediaLaunch.getState().drafts.audio;
        if (!music && previous !== draftOwner.current) {
            defaultModel.current = null;
            setDraftSaveNotice("音频草稿已由其他入口更新；当前输入已保留，未覆盖其他入口的草稿。请重新打开音频页核对后继续编辑。");
            return;
        }
        if (!previous || JSON.stringify({ ...previous, revision: undefined }) !== JSON.stringify(next)) {
            const ticket = defaultModel.current, write = useCreationMediaLaunch.getState().edit(next), saved = useCreationMediaLaunch.getState().drafts.audio;
            const savedOwn = saved?.revision === (previous?.revision ?? 0) + 1 && saved.prompt === next.prompt && JSON.stringify(saved.parameters) === JSON.stringify(parameters);
            if (!music && savedOwn) draftOwner.current = saved;
            // Only this page's own unchanged blank save may advance its initialization ticket.
            if (ticket && ticket.draft === previous && ticket.parameters === parameters && ticket.editRevision === editRevision.current
                && savedOwn) ticket.draft = saved;
            else defaultModel.current = null;
            void write;
        }
    };
    useEffect(persistDraft, [draftReady, parameters, creation.pending?.nonce]);
    const applyDefaultModel = () => {
        const ticket = defaultModel.current, store = useCreationMediaLaunch.getState();
        const scopeCurrent = current() && store.scope?.accountId === scope.accountId && store.scope.epoch === scope.epoch;
        const unchanged = !!ticket && ticket.routeKey === location.key && ticket.editRevision === editRevision.current && ticket.parameters === parameters
            && ticket.draft === store.drafts.audio && !parameters.model && !selectedId;
        if (ticket && (!scopeCurrent || !unchanged || store.pending || creationLaunch)) { defaultModel.current = null; return; }
        const model = firstPlatformDefault(models, {
            fresh: !music && !!ticket,
            current: scopeCurrent,
            ready: draftReady && store.ready && loaded,
            loading: modelsLoading,
            unchanged,
            busy: busy || submissionLock.current || quoteLock.current || !!confirmation,
            pending: !!store.pending || !!creationLaunch,
            error: !!store.error || !!error || !!historyError,
        });
        if (!model || !ticket) return;
        defaultModel.current = null; editRevision.current++; setConfirmation(null);
        setParameters(value => value === ticket.parameters && !value.model ? selectAudioModelParameters({ ...value, model: model.id }, model.audio) : value);
    };
    useEffect(() => { applyDefaultModel(); }, [draftReady, models, modelsLoading, loaded, busy, confirmation, parameters, creation.pending?.nonce, creation.error, error, historyError, selectedId, location.key, creationLaunch]);
    const submit = async () => {
        if (!confirmation || submissionLock.current) return;
        submissionLock.current = true; setBusy(true);
        const receipt: Receipt = { id: `audio:${crypto.randomUUID()}`, createdAt: Date.now(), parameters: confirmation.parameters, state: "submitting" };
        let persisted = false, sent = false;
        try {
            await save(receipt); persisted = true; check(); selectReceipt(receipt.id);
            sent = true;
            const view = await client.submit(intent(confirmation.parameters), confirmation.quote, receipt.id, controller.current.signal);
            check();
            invalidatePlatformWallet(scope);
            await save(withView(receipt, view), undefined, true);
            setConfirmation(null); void pollLogs();
        } catch (cause) {
            if (!current()) return;
            const detail = cause instanceof Error ? cause.message : "提交结果待核对，请勿重复生成。";
            setError(detail);
            if (persisted) {
                const rejected = !sent || cause instanceof GenerationError && cause.outcome !== "unknown";
                try { await save({ ...receipt, state: rejected ? "rejected" : "unconfirmed", error: detail }); }
                catch { setError("任务记录写入失败，请保留回执编号，使用“查询原任务”核对。"); }
            }
            setConfirmation(null);
        } finally { submissionLock.current = false; if (current()) setBusy(false); }
    };
    const recover = async (receipt: Receipt) => {
        const entry = Object.values(generationTracker.getState().entries).find(item => item.accountId === scope.accountId && item.epoch === scope.epoch && item.taskId === receipt.taskId);
        const before = entry && { ...entry };
        const version = beginRead(receipt.id);
        setBusy(true);
        try {
            const view = receipt.taskId ? await client.get(receipt.taskId, controller.current.signal) : await client.recover(receipt.id, controller.current.signal);
            check();
            if (removed.current.has(receipt.id) || readVersions.current.get(receipt.id) !== version) return;
            const after = Object.values(generationTracker.getState().entries).find(item => item.accountId === scope.accountId && item.epoch === scope.epoch && item.taskId === view.task.id);
            if (audioTaskResponseIsStale(before, after, scope, view)) throw new Error("任务状态已更新，详情待核对，请主动查询原任务");
            invalidatePlatformWallet(scope); trackingReads.current.delete(receipt.id);
            await save(withView(receipt, view), version, true, before); void pollLogs();
        } catch (cause) {
            if (!current() || removed.current.has(receipt.id) || readVersions.current.get(receipt.id) !== version) return;
            trackingReads.current.delete(receipt.id);
            const detail = cause instanceof Error ? cause.message : "原任务暂时无法核对；没有重新生成。";
            const next = { ...receipt, paused: true, error: detail };
            setError(detail);
            try { await save(next, version); } catch { if (current() && !removed.current.has(receipt.id) && readVersions.current.get(receipt.id) === version) { publish(logsRef.current.map(log => log.id === receipt.id ? next : log)); setError("任务记录保存失败，请保留当前页面和任务编号。"); } }
        }
        finally { if (current()) setBusy(false); }
    };
    const loadAudio = async (receipt: Receipt) => {
        const revision = ++previewRevision.current;
        setBusy(true); setError("");
        try {
            check(); const view = receipt.view;
            if (!view || view.task.audioSnapshot.status !== "recorded") throw new Error("原任务语音信息待核对，请保留回执。");
            const media = view.result?.resultSnapshot.media;
            if (view.task.executionStatus !== "succeeded" || !["saved", "visible"].includes(view.task.deliveryStatus) || view.result?.status !== "succeeded" || !media) throw new Error("音频尚未保存完成，请查询原任务。");
            const mediaClient = createMediaClient(() => current() ? scope.accountId : null);
            const resolved = await mediaClient.resolve([media.mediaId]); check();
            const owned = resolved.items.find(item => item.id === media.mediaId);
            if (resolved.missing.length || !owned || owned.kind !== "audio" || owned.contentType !== media.contentType || owned.sizeBytes !== media.sizeBytes) throw new Error("音频素材归属或内容信息不一致，请保留任务记录。");
            const blob = await mediaClient.download(media.mediaId); check();
            if (blob.type !== media.contentType || blob.size !== media.sizeBytes) throw new Error("音频文件不完整，请保留任务记录。");
            if (revision !== previewRevision.current) return;
            clearPlayback(); const url = URL.createObjectURL(blob); playbackUrl.current = url;
            setPlayback({ id: receipt.id, url, blob });
        } catch (cause) { if (current() && revision === previewRevision.current) setError(cause instanceof Error ? cause.message : "音频读取失败。"); }
        finally { if (current()) setBusy(false); }
    };
    const choose = (receipt: Receipt) => { previewRevision.current++; clearPlayback(); selectReceipt(receipt.id); setDrawerOpen(false); };
    const newSession = () => { editRevision.current++; previewRevision.current++; setParameters({ ...DEFAULT_AUDIO_PARAMETERS }); setConfirmation(null); selectReceipt(undefined); clearPlayback(); };
    const deleteLog = async (receipt: Receipt) => {
        removed.current.add(receipt.id); beginRead(receipt.id);
        try { await queueWrite(async () => { check(); await storage.removeItem(receipt.id); check(); publish(logsRef.current.filter(log => log.id !== receipt.id)); }); if (current() && selection.current === receipt.id) { previewRevision.current++; selectReceipt(undefined); clearPlayback(); } }
        catch { removed.current.delete(receipt.id); if (current()) message.error("日志删除失败；云端音频未删除。"); }
    };
    const logPanel = <div className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="font-semibold">生成日志</h2><Tag>{logs.length}</Tag></div>
        <Button icon={<Plus size={15} />} onClick={newSession} disabled={busy}>新建</Button>
        {!loaded && !historyError ? <div role="status" className="flex items-center gap-2"><Spin size="small" />正在读取日志…</div> : !logs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无音频生成记录" />}
        {logs.map(receipt => <div key={receipt.id} className={`rounded-lg border p-3 ${selectedId === receipt.id ? "border-primary bg-muted" : "border-border"}`}>
            <button type="button" className="w-full cursor-pointer space-y-2 text-left" onClick={() => choose(receipt)}>
                <div className="truncate font-medium">{receipt.parameters.prompt.slice(0, 40) || "语音任务"}</div>
                <div className="text-xs text-muted-foreground">{new Date(receipt.createdAt).toLocaleString()}</div>
                <Tag>{receiptStatus(receipt)}</Tag><Tag>{receipt.parameters.format.toUpperCase()}</Tag>
            </button>
            {(receipt.state === "rejected" || finished(receipt.view)) && <Button type="text" size="small" danger icon={<Trash2 size={13} />} onClick={() => modal.confirm({ title: "删除这条本机日志？", content: "云端任务和音频文件会保留。", okText: "删除日志", cancelText: "取消", onOk: () => deleteLog(receipt) })}>删除日志</Button>}
        </div>)}
    </div>;
    const changeParameters = (next: AudioParameters) => {
        editRevision.current++; setConfirmation(null);
        const model = models.find(item => item.id === next.model);
        setParameters(next.model !== parameters.model && model ? selectAudioModelParameters(next, model.audio) : next);
    };
    const result = <>
        {error && <Alert type="warning" showIcon title={error} />}
        {!music && draftSaveNotice && <Alert type="warning" showIcon title={draftSaveNotice} />}
        {historyError && <Alert type="error" showIcon title={historyError} />}
        {!selected ? music && loaded && <div className="flex min-h-64 flex-col items-center justify-center gap-4"><AudioLines className="size-10 text-muted-foreground" /><Empty description={logs.length ? "选择一条音频记录，查看任务或试听语音" : "生成后在这里播放和下载语音"} /></div> : <>
            <h2 className="text-lg font-semibold">{selectedReadIssue ? "任务状态待核对" : receiptStatus(selected)}</h2>
            {selectedReadIssue && <Alert type="warning" showIcon title="任务读取待核对" description={selectedReadIssue} />}
            <Typography.Paragraph className="break-all" copyable={{ text: selected.taskId || selected.id }}>回执：{selected.taskId || selected.id}</Typography.Paragraph>
            <Typography.Paragraph className="whitespace-pre-wrap break-words">{selected.parameters.prompt}</Typography.Paragraph>
            <Typography.Paragraph type="secondary" className="break-words">模型：{selected.parameters.model} · 音色：{audioVoiceLabel(selected.parameters.voice)} · {selected.parameters.format.toUpperCase()}</Typography.Paragraph>
            {selected.error && <Alert type="warning" title={selected.error} />}
            <Button loading={busy} disabled={busy || selected.state === "submitting" || selected.state === "rejected" || !!selected.taskId && !selected.paused && !finished(selected.view) && !selectedReadIssue} onClick={() => void recover(selected)}>查询原任务</Button>
            {selected.view?.task.executionStatus === "succeeded" && ["saved", "visible"].includes(selected.view.task.deliveryStatus) && <Button disabled={busy} onClick={() => void loadAudio(selected)}>读取音频</Button>}
            {!music && playback?.id === selected.id && <div className="space-y-3"><audio src={playback.url} controls className="w-full" /><Button icon={<Download size={15} />} onClick={() => { if (current()) saveAs(playback.blob, `${selected.taskId || selected.id}.${playback.blob.type === "audio/wav" ? "wav" : "mp3"}`); }}>下载音频</Button></div>}
        </>}
    </>;

    const playable = logs.filter(receipt => receipt.view?.task.executionStatus === "succeeded" && ["saved", "visible"].includes(receipt.view.task.deliveryStatus) && receipt.view.result?.status === "succeeded");
    const playbackIndex = playable.findIndex(receipt => receipt.id === selectedId);
    const playNeighbor = (offset: number) => {
        const receipt = playable[playbackIndex + offset];
        if (!current() || busy || playbackIndex < 0 || !receipt) return;
        choose(receipt); void loadAudio(receipt);
    };
    if (!draftReady) return <Alert className="m-4" type={creation.error ? "error" : "info"} title={creation.error || <span role="status" className="flex items-center gap-2"><Spin size="small" />正在读取当前账号的音频草稿…</span>} />;
    return <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
        {music ? <main aria-label="语音创作工作台" className="mx-auto grid w-full max-w-[1220px] min-h-0 min-w-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:overflow-hidden">
                <section aria-labelledby="music-heading" className="min-w-0 border-b border-border p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0">
                    <header className="mb-5"><h1 id="music-heading" className="flex items-center gap-2 text-xl font-semibold"><AudioLines className="size-5 text-primary" />音乐</h1><p className="mt-1 text-[13px] text-muted-foreground">把文字变成自然的表达</p><p className="mt-2 text-xs text-muted-foreground">当前支持文字转语音（TTS），音乐生成尚未开放。</p></header>
                    {creation.error && <Alert className="mb-4" type="error" title={creation.error} />}
                    {!modelsLoading && !models.length && !error && <Alert className="mb-4" type="info" title="暂无可用音频模型，请联系管理员配置。" />}
                    <AudioParametersForm variant="music" value={parameters} modelOptions={models.map(model => ({ value: model.id, label: model.displayName }))} voiceOptions={selectedModel?.audio.voices} formatOptions={selectedModel?.audio.formats ?? []} loading={modelsLoading} disabled={busy}
                        instructionsDisabled={!selectedModel?.audio.instructions} instructionsNote={selectedModel?.audio.instructions ? "风格和语言会作为朗读指令发给所选模型" : selectedModel?.audio.voices.length === 1 && selectedModel.audio.voices[0] === "default" ? "此模型默认按中文清晰朗读，使用默认音色并输出 WAV，暂不支持自选语言和风格，已有指令请先清空" : "所选模型不支持风格和语言指令，已有填写请换用支持的模型或清空字段"}
                        onChange={next => { editRevision.current++; setConfirmation(null); const model = models.find(item => item.id === next.model); setParameters(next.model !== parameters.model && model ? selectAudioModelParameters(next, model.audio) : next); }} />
                    {!selectedModel?.audio.instructions && (parameters.style || parameters.language) && <Button type="link" disabled={busy} onClick={() => { editRevision.current++; setConfirmation(null); setParameters(value => ({ ...value, style: "", language: "" })); }}>清除不支持的风格和语言指令</Button>}
                    <div className="mt-4 flex items-center gap-2"><Button className="flex-1" type="primary" loading={busy} disabled={!loaded || !selectedModel || !parameters.prompt.trim() || !parameters.voice.trim()} onClick={() => void showQuote()}>查看正式报价{selectedModel ? ` · 预计 ${selectedModel.audioPricing.creditsPerUnit} 积分` : ""}</Button><Button type="text" aria-label="刷新模型" icon={<RefreshCw size={15} />} disabled={busy || modelsLoading} onClick={() => void loadModels()} /></div>
                </section>
                <section aria-label="我的音频" className="min-w-0 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto">
                    <header className="mb-5 flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">我的音频</h2><Button type="text" icon={<History size={16} />} onClick={() => setDrawerOpen(true)}>本机记录</Button></header>
                    {!loaded && !historyError ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spin size="small" />正在读取音频记录…</p> : null}
                    {logs.length > 0 ? <div className="mb-5 grid min-w-0 grid-cols-1 gap-2">{logs.map(receipt => <button type="button" key={receipt.id} aria-pressed={selectedId === receipt.id} disabled={busy}
                        className={`min-w-0 rounded-lg border p-3 text-left transition-colors hover:bg-accent disabled:opacity-50 ${selectedId === receipt.id ? "border-primary bg-muted" : "border-border"}`} onClick={() => choose(receipt)}>
                        <span className="block truncate text-sm font-medium">{receipt.parameters.prompt.slice(0, 40) || "语音任务"}</span><span className="mt-2 block text-xs text-muted-foreground">{receiptStatus(receipt)} · {receipt.parameters.format.toUpperCase()}</span>
                    </button>)}</div> : null}
                    <div className="space-y-3 break-words">{result}</div>
                </section>
        </main> : <CreationWorkbench kind="audio" hasContent={Boolean(selected || error || draftSaveNotice || historyError || creation.error || !modelsLoading && !models.length)} composer={
            <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
                <div className="mb-2 flex items-center"><CreationToolsMenu items={[
                    { key: "records", label: "本机音频记录", icon: <History className="size-4" />, onSelect: () => setDrawerOpen(true) },
                    { key: "refresh-models", label: "刷新模型", icon: <RefreshCw className="size-4" />, onSelect: () => { void loadModels(); }, disabled: busy || modelsLoading },
                ]} /></div>
                <Input.TextArea aria-label="朗读文本" value={parameters.prompt} onChange={event => changeParameters({ ...parameters, prompt: event.target.value })} disabled={busy} rows={3}
                    className="!min-h-20 !max-h-48 !resize-none !overflow-y-auto !border-0 !bg-transparent !p-0 !shadow-none" placeholder="输入要朗读的正文，语气和节奏请在语音参数中设置…" />
                <div className="mt-3"><CreationToolbar mode={modeTabs} model={
                    <Select<string> aria-label="音频模型" className="w-full min-w-0" value={parameters.model || undefined} options={models.map(model => ({ value: model.id, label: model.displayName }))}
                        loading={modelsLoading} disabled={busy || modelsLoading} showSearch={{ optionFilterProp: "label" }} placeholder={modelsLoading ? "正在加载平台音频模型" : "选择平台音频模型"}
                        notFoundContent={modelsLoading ? "正在加载" : "暂无可用平台音频模型"} onChange={model => changeParameters({ ...parameters, model })} />
                } parameters={
                    <CreationParameters label="音频生成设置" presentation="centered" summary={`${parameters.voice ? audioVoiceLabel(parameters.voice) : "语音"} · ${parameters.format.toUpperCase()}`} disabled={busy}>
                        <div className="space-y-3">
                            <AudioParametersForm variant="creation" hidePrompt value={parameters} modelOptions={models.map(model => ({ value: model.id, label: model.displayName }))}
                                voiceOptions={selectedModel?.audio.voices} formatOptions={selectedModel?.audio.formats} loading={modelsLoading} disabled={busy}
                                instructionsDisabled={!selectedModel?.audio.instructions} instructionsNote={selectedModel?.audio.instructions ? "风格和语言会作为朗读指令发给所选模型。" : selectedModel?.audio.voices.length === 1 && selectedModel.audio.voices[0] === "default" ? "此模型默认按中文清晰朗读，使用默认音色并输出 WAV；暂不支持自选语言和风格。已有指令请先清空。" : "所选模型不支持风格和语言指令；如已有填写，请换用支持的模型或清空这些字段。"}
                                onChange={changeParameters} />
                            {!selectedModel?.audio.instructions && (parameters.style || parameters.language) && <Button type="link" disabled={busy} onClick={() => changeParameters({ ...parameters, style: "", language: "" })}>清除不支持的风格和语言指令</Button>}
                        </div>
                    </CreationParameters>
                } estimate={
                    <CreationHint summary={<span>预计 {selectedModel?.audioPricing.creditsPerUnit ?? "—"} 积分</span>}>{selectedModel ? "按当前所选模型的已发布单次价格预估，提交前仍须确认正式报价。" : "请选择平台音频模型后查看已发布价格预估；不会自动报价或生成。"}</CreationHint>
                } action={
                    <Button type="primary" shape="circle" aria-label="查看语音生成费用" title="查看费用" icon={<ArrowUp className="size-5" />} loading={busy}
                        disabled={!loaded || !selectedModel || !parameters.prompt.trim() || !parameters.voice.trim()} onClick={() => void showQuote()} />
                } /></div>
                <div className="mt-2"><CreationHint>生成的是 AI 合成语音；日志保存在当前浏览器账号下，音频保存在平台私有素材中。</CreationHint></div>
            </div>
        }>
            <div className="space-y-3 break-words">
                {creation.error && <Alert type="error" title={creation.error} />}
                {!modelsLoading && !models.length && !error && <Alert type="info" title="暂无可用音频模型，请联系管理员配置。" />}
                {result}
            </div>
        </CreationWorkbench>}
        {music && <AudioPlayer url={playback && playback.id === selectedId ? playback.url : undefined} title={selected?.parameters.prompt.slice(0, 40)} disabled={busy} isCurrent={current}
            onPrevious={playbackIndex > 0 ? () => playNeighbor(-1) : undefined} onNext={playbackIndex >= 0 && playbackIndex < playable.length - 1 ? () => playNeighbor(1) : undefined}
            onDownload={() => { if (current() && playback && selected && playback.id === selected.id) saveAs(playback.blob, `${selected.taskId || selected.id}.${playback.blob.type === "audio/wav" ? "wav" : "mp3"}`); }} />}
        <Drawer title="音频生成日志" placement="bottom" size="large" open={drawerOpen} onClose={() => setDrawerOpen(false)}>{logPanel}</Drawer>
        <Modal title="确认语音生成费用" open={!!confirmation} confirmLoading={busy} onCancel={() => { if (!busy) setConfirmation(null); }} onOk={() => void submit()} okText={confirmation ? `确认生成（${confirmation.quote.quotedUnits} 积分）` : "确认生成"} cancelText="取消" cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy}>
            {confirmation && <div className="space-y-2"><p>每次成功生成 {confirmation.quote.quotedUnits} 积分。提交时冻结，音频保存成功后结算；明确失败释放，结果不明保留回执待核对。</p><p>模型：{models.find(model => model.id === confirmation.parameters.model)?.displayName || confirmation.parameters.model}</p><p>格式：{confirmation.parameters.format.toUpperCase()} · 音色：{audioVoiceLabel(confirmation.parameters.voice)}</p>{confirmation.parameters.style && <p>风格：{confirmation.parameters.style}</p>}{confirmation.parameters.language && <p>语言：{confirmation.parameters.language}</p>}<Typography.Paragraph className="max-h-48 overflow-y-auto whitespace-pre-wrap">{confirmation.parameters.prompt}</Typography.Paragraph>{confirmation.quote.priceNote && <p>{confirmation.quote.priceNote}</p>}</div>}
        </Modal>
    </div>;
}
