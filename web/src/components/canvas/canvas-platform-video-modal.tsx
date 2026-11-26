import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Select, Space, Tag, Typography } from "antd";
import { Download, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useStore } from "zustand";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useAccountStore } from "@/stores/use-account-store";
import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import { createCreationMediaLaunchStore } from "@/stores/use-creation-media-launch";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { usePlatformVideoWorkbench, videoReferenceIssue } from "@/pages/video/use-platform-video-workbench";
import { describeVideoParameters, emptyVideoParameters, type VideoDraftParameters } from "@/pages/video/video-parameters";
import { selectedVideoMapping } from "@/pages/video/mapped-video-settings";
import { videoMappingChoiceKey } from "@/services/saas/mapped-video-generation";
import type { VideoGenerationScope } from "@/services/saas/video-generation";
import type { VideoReceipt } from "@/pages/video/platform-video-workbench";
import { generationTrackingPresentation } from "@/stores/use-generation-tracker";
import { ModelBrandIcon } from "@/components/model-brand-icon";

type Props = { projectId: string; isProjectCurrent: () => boolean; onClose: () => void;
    onApply: (blob: Blob, receipt: VideoReceipt, isCurrent: () => boolean) => Promise<void> };
const drafts = new Map<string, ReturnType<typeof createCreationMediaLaunchStore>>();
function videoDraft(projectId: string, accountId: string) {
    const key = JSON.stringify([accountId, projectId]);
    if (!drafts.has(key)) drafts.set(key, createCreationMediaLaunchStore({ getScope: () => useAccountStore.getState().getDraftScope(),
        storage: scope => {
            const storage = localforage.createInstance({ name: "infinite-canvas", storeName: accountScopedStoreName("canvas_video_drafts", scope) });
            return { getItem: kind => storage.getItem(`${projectId}:${kind}`), setItem: (kind, value) => storage.setItem(`${projectId}:${kind}`, value) };
        }, resolveReferences: references => Promise.all(references.map(async reference => ({ ...reference, dataUrl: await resolveImageUrl(reference.storageKey, reference.dataUrl) }))) }));
    return drafts.get(key)!;
}

export function CanvasPlatformVideoModal(props: Props) {
    const account = useAccountStore(), scope = account.getDraftScope();
    return scope && account.site?.cloudMedia ? <VideoDialog key={`${scope.accountId}:${scope.epoch}:${props.projectId}`} {...props} scope={scope} />
        : <Modal open title="平台生成视频" onCancel={props.onClose} footer={<Button onClick={props.onClose}>返回画布</Button>}><Alert type="warning" showIcon title="请先登录并确认平台素材服务已开放。" /></Modal>;
}

function VideoDialog({ scope, ...props }: Props & { scope: VideoGenerationScope }) {
    const draftStore = videoDraft(props.projectId, scope.accountId), data = useStore(draftStore), draft = data.drafts.video;
    const selection = draft?.parameters && "source" in draft.parameters && draft.parameters.source === "platform-video" ? draft.parameters as VideoDraftParameters : emptyVideoParameters();
    const input = { prompt: draft?.prompt ?? "", references: draft?.references ?? [], selection };
    const platform = usePlatformVideoWorkbench(scope, input, data.ready, props.isProjectCurrent);
    const fileInput = useRef<HTMLInputElement>(null), live = useRef(true), addLock = useRef(false);
    const [error, setError] = useState(""), [uploading, setUploading] = useState(false), [adding, setAdding] = useState(false), [added, setAdded] = useState("");
    const propsRef = useRef(props); propsRef.current = props;
    const current = () => { const now = useAccountStore.getState().getDraftScope(); return live.current && propsRef.current.isProjectCurrent() && now?.accountId === scope.accountId && now.epoch === scope.epoch; };
    useEffect(() => { live.current = true; void draftStore.getState().load(); return () => { live.current = false; }; }, [draftStore]);
    const busy = uploading || adding || platform.preparing || !!platform.state?.busy;
    const model = platform.models.find(item => item.id === selection.mappingModelId), selected = selectedVideoMapping(platform.models, selection);
    const choices = model?.combinations.filter(item => item.specification === selection.specification) ?? [];
    const referenceIssue = videoReferenceIssue(input.references.length, selection);
    const change = (values: Partial<typeof input>) => { if (current()) { platform.cancelQuote(); void draftStore.getState().edit({ kind: "video", parameters: values.selection ?? selection, prompt: values.prompt ?? input.prompt, references: values.references ?? input.references }); } };
    const state = platform.state, receipt = state?.receipt, task = state?.view?.task;
    const addFrame = async (file?: File) => {
        if (!file || !current() || busy) return;
        setUploading(true); setError("");
        try {
            if (!file.type.startsWith("image/")) throw new Error("请选择本人首帧图片。");
            const stored = await uploadImage(file);
            if (current()) change({ references: [{ id: crypto.randomUUID(), name: file.name, type: stored.mimeType, storageKey: stored.storageKey, dataUrl: stored.url }] });
        } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "首帧读取失败，原草稿已保留。"); }
        finally { if (current()) setUploading(false); }
    };
    const addResult = async () => {
        const video = platform.video, original = platform.state?.receipt;
        if (!video || !original || !current() || addLock.current) return;
        addLock.current = true; setAdding(true); setError("");
        const valid = () => current() && platform.isVideoCurrent(video.taskId);
        try { await props.onApply(video.blob, original, valid); if (valid()) setAdded(video.taskId); }
        catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "画布保存未确认，请保留原任务核对。"); }
        finally { addLock.current = false; if (current()) setAdding(false); }
    };
    return <Modal open title="平台生成视频" width={720} style={{ top: 24 }} onCancel={props.onClose}
        styles={{ body: { maxHeight: "calc(100dvh - 190px)", overflowY: "auto", overflowX: "hidden" } }} footer={<Space wrap><Button onClick={props.onClose}>返回画布</Button>
            {state?.phase === "ready" && state.quote && <><Button onClick={platform.cancelQuote}>取消</Button><Button type="primary" disabled={busy} onClick={() => { if (current()) void platform.confirm(); }}>确认并生成视频</Button></>}</Space>}>
        <div className="min-w-0 space-y-4" data-canvas-shortcuts-ignore>
            {[data.error, error, platform.error, state?.error].filter(Boolean).map((value, i) => <Alert key={i} type="warning" showIcon title={value} />)}
            <Space wrap><Button icon={<Plus size={14} />} disabled={busy || !data.ready} onClick={() => { if (current() && platform.clear()) { setAdded(""); setError(""); } }}>新建视频请求</Button>
                <Button icon={<RefreshCw size={14} />} disabled={busy || platform.loading} onClick={() => { change({ selection: { ...selection, modelId: "", parameters: null } }); void platform.reloadModels(); }}>更新模型列表</Button></Space>
            {!receipt && <><Input.TextArea aria-label="平台视频描述" value={input.prompt} rows={3} disabled={!data.ready || busy} onChange={event => change({ prompt: event.target.value })} placeholder="描述视频画面、动作与镜头" />
            <label className="block space-y-2"><span>视频模型</span><Select className="w-full" showSearch aria-label="平台视频模型" value={selection.mappingModelId} loading={platform.loading} disabled={!data.ready || busy || !!receipt || platform.loading}
                options={platform.models.map(item => ({ value: item.id, label: <span className="flex min-w-0 items-center gap-2"><ModelBrandIcon model={item.id} label={item.displayName} brand={item.group} /><span className="min-w-0 truncate">{item.group || "其他模型"} · {item.displayName}</span></span> }))} onChange={mappingModelId => change({ selection: { ...emptyVideoParameters(), mappingModelId } })} /></label>
            {model && <div role="group" aria-label="平台视频清晰度" className="flex flex-wrap gap-1">{model.specifications.map(spec => <Button key={spec} size="small" type={selection.specification === spec ? "primary" : "default"}
                aria-pressed={selection.specification === spec} disabled={busy || !!receipt || platform.loading || !model.combinations.some(item => item.available && item.specification === spec)}
                onClick={() => change({ selection: { ...selection, specification: spec, modelId: "", parameters: null } })}>{spec}</Button>)}</div>}
            {model && selection.specification && <Select className="w-full" aria-label="平台视频完整规格" placeholder="选择模式、时长与声音" value={selected ? videoMappingChoiceKey(selected) : undefined} disabled={busy || !!receipt || platform.loading}
                options={choices.map(item => ({ value: videoMappingChoiceKey(item), label: describeVideoParameters(item.execution.parameters), disabled: !item.available }))}
                onChange={key => { const item = choices.find(item => videoMappingChoiceKey(item) === key); if (item?.available) change({ selection: { ...selection, modelId: item.nodeModelId!, parameters: { ...item.execution.parameters } } }); }} />}
            <Space wrap><Button icon={<Upload size={14} />} disabled={!data.ready || busy || !!receipt} loading={uploading} onClick={() => fileInput.current?.click()}>选择首帧图片</Button>
                {input.references.map(reference => <Tag key={reference.id} className="max-w-full whitespace-normal break-all">{reference.name}</Tag>)}
                {!!input.references.length && <Button aria-label="移除视频首帧" icon={<Trash2 size={14} />} disabled={busy || !!receipt} onClick={() => change({ references: [] })} />}</Space>
            {input.references[0]?.dataUrl && <img src={input.references[0].dataUrl} alt="视频首帧" className="max-h-32 max-w-full object-contain" />}
            {selection.parameters?.mode === "first_frame" && <Typography.Paragraph type="secondary">选择图片先保存在本机；查看费用时会上传为本人私有素材，确认费用后才生成视频。</Typography.Paragraph>}
            {referenceIssue && <Typography.Paragraph type="secondary" role="status">{referenceIssue}</Typography.Paragraph>}
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={event => { void addFrame(event.target.files?.[0]); event.target.value = ""; }} />
            </>}
            {state?.phase === "ready" && state.quote ? <section className="space-y-3 border-y border-border py-3" aria-label="视频费用确认">
                <Typography.Text strong>本次预留 {state.quote.reservedCredits} 积分</Typography.Text><p>{describeVideoParameters(state.quote.parameters)}</p>
                {state.quote.priceNote && <p>{state.quote.priceNote}</p>}<p>成功交付1条本人私有视频后结算；结果未知时保留原冻结待核对。</p>
            </section> : !receipt && <Button type="primary" loading={platform.preparing || state?.phase === "quoting"} disabled={busy || !data.ready || !!data.error || !platform.recordsReady || !selected || !input.prompt.trim() ||
                !!referenceIssue} onClick={() => { if (current()) void platform.prepare(); }}>查看视频费用（不扣费）</Button>}
            {!platform.loading && !platform.models.length && <Empty description="暂无已生效的平台视频模型" />}
            {receipt && <section aria-label="原视频任务" className="space-y-3 border-t border-border pt-3"><Tag>{task ? generationTrackingPresentation(task).title : receipt.state === "rejected" ? "未受理" : "原视频任务待核对"}</Tag>
                <p className="break-all">{receipt.taskId || receipt.id}</p><p>{describeVideoParameters(receipt.intent.parameters)}</p>
                <Button disabled={busy || receipt.state === "rejected"} loading={state?.busy} onClick={() => { if (current()) void platform.refresh(); }}>查询原视频任务</Button>
                {platform.video && <><video src={platform.video.url} controls playsInline className="max-h-72 w-full bg-black object-contain" />
                    <Space wrap><Button type="primary" loading={adding} disabled={busy || added === platform.video.taskId} onClick={() => void addResult()}>{added === platform.video.taskId ? "已添加到当前画布" : "添加为新视频节点"}</Button>
                        <Button icon={<Download size={14} />} onClick={() => { if (current() && platform.video) saveAs(platform.video.blob, `${platform.video.taskId}.mp4`); }}>下载视频</Button></Space></>}
                {task?.billingStatus === "captured" && !platform.video && <Button loading={platform.mediaBusy} disabled={platform.mediaBusy} onClick={() => { if (current()) void platform.loadVideo(); }}>读取私有成片</Button>}
            </section>}
            {!!platform.records.length && <label className="block space-y-2"><span>本人视频回执</span><Select className="w-full" aria-label="本人视频回执" value={receipt?.id} disabled={busy} options={platform.records.map(record => ({ value: record.id, label: `${record.intent.input.prompt.slice(0, 40)} · ${record.taskId || record.id}` }))}
                onChange={id => { const record = platform.records.find(item => item.id === id); if (record && current()) { setAdded(""); void platform.restore(record); } }} /></label>}
        </div>
    </Modal>;
}
