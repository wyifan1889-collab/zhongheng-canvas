import { ArrowLeft, ArrowRight, ArrowUp, BookOpen, ClipboardPaste, Download, FolderPlus, History, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, App, Button, Drawer, Empty, Input, Modal, Select, Spin, Tag } from "@/components/creation/ui";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useLocation } from "react-router-dom";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { reindexCreationReferences } from "@/components/creation/creation-reference-prompt";
import { CreationHint, CreationParameters, CreationToolbar, CreationToolsMenu, CreationWorkbench } from "@/components/creation/creation-workbench";
import { useCreationShortcutTarget } from "@/components/creation/creation-shortcut-target-context";
import { formatBytes } from "@/lib/image-utils";
import { uploadMediaFile } from "@/services/file-storage";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import { useAccountStore } from "@/stores/use-account-store";
import { useCreationMediaLaunch, type CreationMediaScope } from "@/stores/use-creation-media-launch";
import { CREATION_DRAFT_REFERENCE_LIMIT } from "@/lib/creation-reference-limits";
import { isCreationMediaTarget } from "@/lib/creation-routes";
import { generationTrackingPresentation, isGenerationTrackingUncertain } from "@/stores/use-generation-tracker";
import { VideoParametersForm, describeVideoParameters, emptyVideoParameters, type VideoDraftParameters } from "./video-parameters";
import { selectedVideoMapping } from "./mapped-video-settings";
import { usePlatformVideoWorkbench, videoReferenceIssue } from "./use-platform-video-workbench";
import type { VideoReceipt } from "./platform-video-workbench";

type LegacyLog = { id: string; title?: string; prompt?: string; createdAt?: number; status?: string; task?: { id?: string } };
function receiptTitle(receipt: VideoReceipt) {
    if (receipt.state === "rejected") return "未受理";
    if (!receipt.view) return "提交结果待核对";
    return generationTrackingPresentation(receipt.view.task).title;
}
export default function VideoPage({ modeTabs }: { modeTabs?: ReactNode } = {}) {
    const account = useAccountStore(), scope = account.getDraftScope();
    if (account.busy) return <div role="status" className="flex min-h-48 items-center justify-center gap-3 p-4"><Spin />正在核对当前账号…</div>;
    return scope ? <VideoWorkbench key={`${scope.accountId}:${scope.epoch}`} scope={scope} modeTabs={modeTabs} /> : <Empty description="请登录后使用视频生成" />;
}
function VideoWorkbench({ scope, modeTabs }: { scope: CreationMediaScope; modeTabs?: ReactNode }) {
    const { message } = App.useApp(), location = useLocation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const creation = useCreationMediaLaunch(), restored = useRef(false), consumedLaunch = useRef(""), historyReturn = useRef("");
    const [prompt, setPrompt] = useState(""), [references, setReferences] = useState<ReferenceImage[]>([]), refs = useRef(references); refs.current = references;
    const [selection, setSelection] = useState<VideoDraftParameters>(emptyVideoParameters), [draftReady, setDraftReady] = useState(false);
    const [error, setError] = useState(""), [legacyLogs, setLegacyLogs] = useState<LegacyLog[]>([]), [legacyNotice, setLegacyNotice] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false), [promptOpen, setPromptOpen] = useState(false), [assetsOpen, setAssetsOpen] = useState(false), [dragging, setDragging] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null), uploads = useRef(false), live = useRef(false), agentNonce = useRef(0);
    const [uploading, setUploading] = useState(false), videoCommand = useWorkbenchAgentStore(state => state.videoCommand);
    const platform = usePlatformVideoWorkbench(scope, { prompt, references, selection }, draftReady);
    const busy = uploading || platform.preparing || !!platform.state?.busy;
    const issue = videoReferenceIssue(references.length, selection), model = platform.models.find(item => item.id === selection.mappingModelId);
    const selectedBand = selectedVideoMapping(platform.models, selection);
    const current = () => { const actual = useAccountStore.getState().getDraftScope(); return live.current && actual?.accountId === scope.accountId && actual.epoch === scope.epoch; };
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    useCreationShortcutTarget({ kind: "video", scope, ready: draftReady && !busy, watch: [prompt, references, selection], onApply: setPrompt });
    useEffect(() => {
        if (restored.current || !creation.ready || creation.scope?.accountId !== scope.accountId || creation.scope.epoch !== scope.epoch) return;
        restored.current = true; const draft = creation.drafts.video;
        if (draft) {
            setPrompt(draft.prompt); setReferences(draft.references);
            if ("source" in draft.parameters && draft.parameters.source === "platform-video") setSelection(draft.parameters as VideoDraftParameters);
            else if (Object.keys(draft.parameters).length) { setLegacyNotice(true); setSelection({ ...emptyVideoParameters(), legacy: draft.parameters as Record<string, string> }); }
        }
        setDraftReady(true);
    }, [creation.ready, creation.scope, scope.accountId, scope.epoch]);
    useEffect(() => {
        if (!draftReady || busy || !current() || !isCreationMediaTarget(location.pathname, location.search, "video") || creation.pending?.draft.kind !== "video" || consumedLaunch.current === creation.pending.nonce) return;
        const launch = useCreationMediaLaunch.getState().take("video"); if (!launch) return;
        consumedLaunch.current = launch.nonce; setPrompt(launch.draft.prompt); setReferences(launch.draft.references);
        if ("source" in launch.draft.parameters && launch.draft.parameters.source === "platform-video") setSelection(launch.draft.parameters as VideoDraftParameters);
        else { setSelection({ ...emptyVideoParameters(), legacy: launch.draft.parameters as Record<string, string> }); setLegacyNotice(true); }
        setError("已带入视频草稿；请主动核对平台模型和完整规格，再查看费用。不会自动发送生成。");
    }, [draftReady, creation.pending?.nonce, busy, location.pathname, location.search]);
    useEffect(() => {
        if (!draftReady || !current() || creation.pending?.draft.kind === "video") return;
        const next = { kind: "video" as const, prompt, references, parameters: selection }, previous = useCreationMediaLaunch.getState().drafts.video;
        if (!previous || JSON.stringify({ ...previous, revision: undefined }) !== JSON.stringify(next)) void useCreationMediaLaunch.getState().edit(next);
    }, [draftReady, prompt, references, selection, creation.pending?.nonce]);
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === agentNonce.current || !current()) return;
        agentNonce.current = videoCommand.nonce; useWorkbenchAgentStore.getState().clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run) {
            setError("助手已填写视频描述；请核对完整平台规格并手动确认正式费用后生成。");
            if (videoCommand.taskId) useWorkbenchAgentStore.getState().updateTask(videoCommand.taskId, { status: "failed", error: "视频需要本人确认正式费用；草稿已保留。" });
        }
    }, [videoCommand]);
    useEffect(() => {
        const hint = (location.state as { fromGenerationHistory?: { type?: string; taskId?: string } } | null)?.fromGenerationHistory;
        if (!platform.recordsReady || busy || hint?.type !== "video" || !hint.taskId || !/^[0-9a-f-]{36}$/i.test(hint.taskId)) return;
        const identity = `${location.key}:${hint.taskId}`; if (historyReturn.current === identity) return;
        historyReturn.current = identity;
        const record = platform.records.find(item => item.taskId === hint.taskId);
        if (record) void platform.restore(record);
        else { setLogsOpen(true); setError("此任务没有本机视频回执；请在创作历史中查询原任务。不会新建生成。"); }
    }, [location.key, platform.recordsReady, platform.records, busy]);
    useEffect(() => {
        const storage = localforage.createInstance({ name: "infinite-canvas", storeName: accountScopedStoreName("video_generation_logs", scope) });
        void (async () => { const logs: LegacyLog[] = []; await storage.iterate<LegacyLog, void>(value => { if (value && typeof value.id === "string") logs.push({ id: value.id, title: value.title, prompt: value.prompt, createdAt: value.createdAt, status: value.status, task: value.task?.id ? { id: value.task.id } : undefined }); }); if (current()) setLegacyLogs(logs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))); })().catch(() => { if (current()) setError("旧本机视频日志读取失败，原记录已保留。"); });
    }, [scope.accountId, scope.epoch]);
    const append = (items: ReferenceImage[]) => {
        if (!current()) return;
        if (refs.current.length + items.length > CREATION_DRAFT_REFERENCE_LIMIT) { message.warning("草稿最多保留14张参考图片，已有图片全部保留。"); return; }
        const next = [...refs.current, ...items]; refs.current = next; setReferences(next);
    };
    const addFiles = async (files: Blob[]) => {
        if (!current() || uploads.current || !files.length) return;
        if (files.some(file => !file.type.startsWith("image/"))) { message.warning("参考素材请选择图片，草稿已保留。"); return; }
        if (files.length + refs.current.length > CREATION_DRAFT_REFERENCE_LIMIT) { message.warning("草稿最多保留14张参考图片，这批未添加，已有图片全部保留。"); return; }
        uploads.current = true; setUploading(true);
        try { const items = await Promise.all(files.map(async (file, index) => { const stored = await uploadImage(file); return { id: nanoid(), name: file instanceof File ? file.name : `clipboard-${index + 1}`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }; })); append(items); }
        catch (cause) { if (current()) message.error(cause instanceof Error ? cause.message : "图片添加失败。"); }
        finally { uploads.current = false; if (current()) setUploading(false); }
    };
    const clipboard = async () => { try { const items = await navigator.clipboard.read(); if (!current()) return; const blobs = await Promise.all(items.flatMap(item => item.types.filter(type => type.startsWith("image/")).map(type => item.getType(type)))); if (current()) await addFiles(blobs); } catch { if (current()) message.warning("剪贴板图片未读取，请保留草稿并手动上传。"); } };
    const reorder = (update: (items: ReferenceImage[]) => ReferenceImage[]) => { const next = reindexCreationReferences(prompt, refs.current, update(refs.current)); refs.current = next.references; setPrompt(next.prompt); setReferences(next.references); };
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (!current()) return;
        try {
            if (payload.kind === "text") setPrompt(payload.content);
            else if (payload.kind === "image") {
                if (refs.current.length >= CREATION_DRAFT_REFERENCE_LIMIT) { message.warning("草稿最多保留14张参考图片，已有图片全部保留。"); return; }
                const stored = await uploadImage(payload.dataUrl); if (current()) append([{ id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
            }
            if (current()) setAssetsOpen(false);
        } catch (cause) { if (current()) message.error(cause instanceof Error ? cause.message : "素材未能加入，草稿已保留。"); }
    };
    const addVideoAsset = async () => {
        const result = platform.video; if (!result || !current()) return;
        try {
            const originalPrompt = platform.state?.receipt?.taskId === result.taskId ? platform.state.receipt.intent.input.prompt : "";
            const stored = await uploadMediaFile(result.blob, "video"); if (!current() || !platform.isVideoCurrent(result.taskId)) return;
            if (typeof stored.width !== "number" || stored.width <= 0 || typeof stored.height !== "number" || stored.height <= 0) throw new Error("视频尺寸未能读取，未加入素材；请先下载成片。");
            useAssetStore.getState().addAsset({ kind: "video", title: "平台视频", coverUrl: "", tags: [], source: "平台视频生成", data: { url: stored.url, storageKey: stored.storageKey, bytes: stored.bytes, mimeType: stored.mimeType, width: stored.width, height: stored.height }, metadata: { source: "video-page", taskId: result.taskId, prompt: originalPrompt } });
            message.success("已加入本人素材");
        } catch (cause) { if (current()) message.error(cause instanceof Error ? cause.message : "保存本人素材失败，请先下载视频。"); }
    };
    const task = platform.state?.view?.task, receipt = platform.state?.receipt;
    const uncertain = task && isGenerationTrackingUncertain(task);
    if (!draftReady) return creation.error ? <Alert className="m-4" type="error" title={creation.error} /> : <div role="status" className="flex min-h-48 items-center justify-center gap-3 p-4"><Spin />正在读取当前账号的视频草稿…</div>;
    return <div className="flex h-full min-h-0 min-w-0 flex-col">
        <CreationWorkbench kind="video" hasContent={!!receipt || !!error || !!platform.error || !!platform.state?.error || !!creation.error || !platform.loading && !platform.models.length} composer={<div className={`min-w-0 space-y-3 rounded-2xl border bg-card p-3 sm:p-4 ${dragging ? "border-ring" : "border-border"}`}
            onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files)); }}>
            <div className="flex min-w-0 items-center gap-2"><CreationToolsMenu items={[
                { key: "upload", label: "上传图片", icon: <Upload className="size-4" />, onSelect: () => fileInput.current?.click() },
                { key: "clipboard", label: "从剪贴板添加", icon: <ClipboardPaste className="size-4" />, onSelect: () => { void clipboard(); } },
                { key: "assets", label: "我的素材", icon: <FolderPlus className="size-4" />, onSelect: () => setAssetsOpen(true) },
                { key: "prompts", label: "提示词", icon: <BookOpen className="size-4" />, onSelect: () => setPromptOpen(true) },
                { key: "records", label: "生成记录", icon: <History className="size-4" />, onSelect: () => setLogsOpen(true) },
            ]} /><span role="status" className="ml-auto text-xs text-muted-foreground">参考图 {references.length}/{CREATION_DRAFT_REFERENCE_LIMIT} 张</span></div>
            <div className="hover-scrollbar flex min-w-0 gap-2 overflow-x-auto pb-1" aria-label="视频参考图片"><button type="button" className="flex size-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-muted-foreground" aria-label="上传图片" disabled={busy} onClick={() => fileInput.current?.click()}><Plus className="size-5" /><span className="text-[10px]">上传图片</span></button>
                {references.map((item, index) => <div key={item.id} className="group relative size-16 shrink-0 overflow-hidden rounded-md border border-border"><img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" onLoad={() => { void ensureImagePreview(item.storageKey); }} /><span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{index + 1}</span>
                    <button type="button" className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white" aria-label={`移除${item.name}`} disabled={busy} onClick={() => reorder(items => items.filter(value => value.id !== item.id))}><Trash2 className="size-3" /></button>
                    {references.length > 1 && <div className="absolute inset-x-1 bottom-1 flex justify-between"><Button size="small" icon={<ArrowLeft className="size-3" />} disabled={busy || index === 0} onClick={() => reorder(items => move(items, index, -1))} /><Button size="small" icon={<ArrowRight className="size-3" />} disabled={busy || index === references.length - 1} onClick={() => reorder(items => move(items, index, 1))} /></div>}</div>)}
            </div>
            <Input.TextArea aria-label="视频创作描述" value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} rows={3} className="min-h-20 max-h-44 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0" placeholder="描述视频画面、动作与镜头…" />
            {issue && <p role="alert" className="text-xs text-muted-foreground">{issue}</p>}
            <CreationToolbar mode={modeTabs} model={<Select showSearch className="w-full min-w-0" aria-label="视频模型" value={selection.mappingModelId || undefined} loading={platform.loading} disabled={busy || platform.loading} placeholder="选择平台视频模型" options={platform.models.map(item => ({ value: item.id, label: `${item.group || "其他模型"} · ${item.displayName}` }))} onChange={value => setSelection({ ...selection, mappingModelId: String(value), modelId: "", specification: undefined, parameters: null })} />}
                parameters={<CreationParameters label="视频生成设置" summary={selection.parameters ? describeVideoParameters(selection.parameters) : "选择视频规格"}><VideoParametersForm value={selection} models={platform.models} disabled={busy} loading={platform.loading} onChange={setSelection} onReload={() => void platform.reloadModels()} /></CreationParameters>}
                estimate={<CreationHint summary={<span>预计 {selectedBand ? selectedBand.credits : "—"} 积分</span>}>目录参考价；确认正式报价后才冻结积分。仅私有成片完整交付后按1条结算，未知结果保留冻结待核对。</CreationHint>}
                action={<Button type="primary" shape="circle" className="!size-10 !min-w-10" aria-label="查看视频费用" title="查看视频费用" icon={<ArrowUp className="size-4" />} loading={busy} disabled={busy || platform.loading || !prompt.trim() || !!issue || !selectedBand || !platform.recordsReady} onClick={() => void platform.prepare()} />} />
        </div>}>
            <div className="space-y-4">
                {(creation.error || error || platform.error || platform.state?.error) && <Alert type="warning" showIcon title={creation.error || error || platform.error || platform.state?.error} />}
                {legacyNotice && <Alert type="info" title="原个人视频参数已保存在草稿；平台只使用主动选择的已发布规格。" />}
                {!platform.loading && !platform.models.length && <Alert type="info" title="暂无可用平台视频模型；草稿已保留，待管理员发布价目并配置必要能力后继续。" />}
                {receipt && <section aria-label="视频任务回执" className="min-w-0 space-y-3 rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">平台视频</h2><Tag>{receiptTitle(receipt)}</Tag></div>
                    <p className="break-all text-xs text-muted-foreground">回执：{receipt.taskId || receipt.id}</p>
                    <p className="text-sm">{describeVideoParameters(receipt.intent.parameters)}</p>
                    <p className="text-xs text-muted-foreground">原报价预留 {receipt.quote.reservedCredits} 积分 · 按成功交付1条视频结算{task ? ` · 费用状态：${task.billingStatus === "captured" ? "已结算" : task.billingStatus === "released" ? "冻结已释放" : "冻结保留或待核对"}` : ""}</p>
                    {task?.executionStatus === "succeeded" && !platform.video && <p role="status" className="text-sm text-muted-foreground">{task.billingStatus === "captured" ? "正在读取本人私有视频…" : "视频交付或费用处理中；完成状态不代表已经交付。"}</p>}
                    {uncertain && <Alert type="warning" title="结果、交付或费用待核对；自动查询已暂停，请保留原任务，不要重复生成。" />}
                    <div className="flex flex-wrap gap-2"><Button loading={platform.state?.busy} disabled={busy || receipt.state === "rejected"} onClick={() => void platform.refresh()}>查询原任务</Button><Button disabled={busy} onClick={() => setLogsOpen(true)}>生成记录</Button></div>
                    {platform.video && <div className="overflow-hidden rounded-lg border border-border"><video src={platform.video.url} controls className="aspect-video w-full bg-black object-contain" /><div className="flex flex-wrap items-center justify-between gap-2 p-3"><span className="text-xs text-muted-foreground">{formatBytes(platform.video.blob.size)} · 本人私有成片</span><div className="flex gap-1"><Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void addVideoAsset()}>加入素材</Button><Button size="small" icon={<Download className="size-3.5" />} onClick={() => { if (current() && platform.video) saveAs(platform.video.blob, `${platform.video.taskId}.mp4`); }}>下载视频</Button></div></div></div>}
                    {task?.billingStatus === "captured" && !platform.video && <Button loading={platform.mediaBusy} disabled={platform.mediaBusy} onClick={() => void platform.loadVideo()}>读取私有成片</Button>}
                </section>}
            </div>
        </CreationWorkbench>
        <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <Drawer title="视频生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
            <div className="space-y-3"><Button icon={<Plus className="size-4" />} disabled={busy} onClick={() => { if (platform.clear()) { setPrompt(""); setReferences([]); setLogsOpen(false); } }}>新建描述</Button>
                {platform.records.map(item => <button type="button" key={item.id} disabled={busy} className="block w-full min-w-0 space-y-2 rounded-lg border border-border p-3 text-left hover:bg-accent" onClick={() => { setLogsOpen(false); void platform.restore(item); }}><div className="flex flex-wrap items-center justify-between gap-2"><span className="truncate text-sm font-medium">{item.intent.input.prompt.slice(0, 60)}</span><Tag>{receiptTitle(item)}</Tag></div><p className="break-all text-xs text-muted-foreground">{item.taskId || item.id}</p><p className="text-xs text-muted-foreground">{describeVideoParameters(item.intent.parameters)}</p></button>)}
                {!platform.records.length && <Empty description="暂无平台视频回执" />}
                {legacyLogs.length > 0 && <details className="rounded-lg border border-border p-3"><summary className="text-sm">旧个人视频记录（{legacyLogs.length}）</summary><p className="my-3 text-xs text-muted-foreground">原记录保留，只读查看；不会读取个人Key、续查供应商或重发旧任务。</p>{legacyLogs.map(log => <div key={log.id} className="space-y-1 border-t border-border py-3"><p className="text-sm">{log.title || log.prompt || "旧视频记录"}</p><p className="break-all text-xs text-muted-foreground">{log.task?.id || log.id}</p><Button size="small" disabled={busy} onClick={() => { if (log.prompt) setPrompt(log.prompt); setLogsOpen(false); }}>带入描述</Button></div>)}</details>}
            </div>
        </Drawer>
        <PromptSelectDialog open={promptOpen} onOpenChange={setPromptOpen} onSelect={setPrompt} />
        <AssetPickerModal open={assetsOpen} defaultTab="my-assets" onInsert={payload => void insertAsset(payload)} onClose={() => setAssetsOpen(false)} />
        <Modal title="确认视频正式费用" open={platform.state?.phase === "ready"} onCancel={() => platform.cancelQuote()} onOk={() => void platform.confirm()} confirmLoading={platform.state?.busy} okText="确认并生成视频" cancelText="取消">
            {platform.state?.quote && <div className="space-y-3"><p>模型：{model?.displayName || selection.modelId}</p><p>{describeVideoParameters(platform.state.quote.parameters)}</p><p>本次预留 {platform.state.quote.reservedCredits} 积分，成功交付1条本人私有视频后结算。</p>{platform.state.quote.priceNote && <p>{platform.state.quote.priceNote}</p>}<p className="text-xs text-muted-foreground">明确生成失败释放原冻结；提交、生成或交付结果未知时保留冻结待核对。停止等待和离开页面不会取消上游任务。</p></div>}
        </Modal>
    </div>;
}
function move<T>(items: T[], index: number, offset: number) { const next = [...items]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next; }
