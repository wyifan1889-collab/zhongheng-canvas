import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Input, Tooltip } from "antd";
import { ArrowUp, ImagePlus, X } from "lucide-react";
import { useNavigate } from "react-router";
import { nanoid } from "nanoid";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { VideoSettingsPanel } from "@/components/video-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { CanvasPromptChipInput } from "@/components/canvas/canvas-prompt-chip-input";
import { AudioParametersForm, selectAudioModelParameters, type AudioParameters } from "@/pages/audio/audio-parameters";
import { canvasThemes } from "@/lib/canvas-theme";
import { CREATION_DRAFT_REFERENCE_LIMIT, creationReferenceSendIssue } from "@/lib/creation-reference-limits";
import { uploadImage } from "@/services/image-storage";
import { createAudioGenerationClient, type AudioGenerationModel } from "@/services/saas/audio-generation";
import { useAccountStore } from "@/stores/use-account-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { emptyAudioParameters, personalMediaParameters, useCreationMediaLaunch, type CreationMediaKind, type CreationMediaScope, type PersonalMediaParameters } from "@/stores/use-creation-media-launch";
import { creationReferenceCandidates, removeCreationReference } from "./creation-reference-prompt";
import { creationPath } from "@/lib/creation-routes";

const currentScope = (scope: CreationMediaScope | null) => {
    const current = useAccountStore.getState().getDraftScope();
    return !!scope && current?.accountId === scope.accountId && current.epoch === scope.epoch;
};

export function CreationMediaComposer({ kind, modeTabs }: { kind: CreationMediaKind; modeTabs?: ReactNode }) {
    const navigate = useNavigate(), { message } = App.useApp();
    const account = useAccountStore(), scope = account.getDraftScope();
    const state = useCreationMediaLaunch(), draft = state.drafts[kind];
    const config = useConfigStore(value => value.config), updateConfig = useConfigStore(value => value.updateConfig);
    const theme = canvasThemes[useThemeStore(value => value.theme)];
    const [models, setModels] = useState<AudioGenerationModel[]>([]), [modelsLoading, setModelsLoading] = useState(false), [modelError, setModelError] = useState("");
    const [submitting, setSubmitting] = useState(false), [uploading, setUploading] = useState(false);
    const uploadLock = useRef(false), submitLock = useRef(false), fileInput = useRef<HTMLInputElement>(null);
    const live = useRef(false), activeKind = useRef(kind); activeKind.current = kind;
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    const ready = state.ready && !!scope && state.scope?.accountId === scope.accountId && state.scope.epoch === scope.epoch;
    const parameters = { ...config, ...draft?.parameters } as AiConfig;
    const audio = { ...emptyAudioParameters(), ...draft?.parameters, prompt: draft?.prompt ?? "" } as AudioParameters;
    const selectedModel = models.find(model => model.id === audio.model);
    const referenceCandidates = creationReferenceCandidates(draft?.references ?? []);
    const referenceIssue = creationReferenceSendIssue(draft?.references.length ?? 0, kind);
    const canLaunch = ready && Boolean(draft?.prompt.trim()) && !uploading && !submitting && !referenceIssue;

    useEffect(() => {
        if (!ready || draft || useCreationMediaLaunch.getState().drafts[kind]) return;
        void useCreationMediaLaunch.getState().edit({ kind, prompt: "", references: [], parameters: kind === "audio" ? emptyAudioParameters() : personalMediaParameters(config) });
    }, [ready, kind, draft]);
    useEffect(() => {
        if (kind !== "audio" || !scope) return;
        const controller = new AbortController();
        setModels([]); setModelsLoading(true); setModelError("");
        const client = createAudioGenerationClient({ scope, getScope: () => useAccountStore.getState().getDraftScope() });
        void client.models(controller.signal).then(items => { if (!controller.signal.aborted && currentScope(scope)) setModels(items); })
            .catch(cause => { if (!controller.signal.aborted && currentScope(scope)) setModelError(cause instanceof Error ? cause.message : "音频模型读取失败，已保留草稿。"); })
            .finally(() => { if (!controller.signal.aborted && currentScope(scope)) setModelsLoading(false); });
        return () => controller.abort();
    }, [kind, scope?.accountId, scope?.epoch]);

    const edit = (patch: Partial<Pick<NonNullable<typeof draft>, "prompt" | "references" | "parameters">>) => {
        if (!ready || !currentScope(scope)) return;
        void state.edit({ kind, prompt: draft?.prompt ?? "", references: draft?.references ?? [], parameters: kind === "audio" ? audio : personalMediaParameters(parameters), ...patch });
    };
    const changeParameter = (key: keyof PersonalMediaParameters, value: string) => {
        if (!ready || submitting || kind === "audio" || !currentScope(scope)) return;
        updateConfig(key, value);
        void state.editPersonalParameter(kind, key, value, useConfigStore.getState().config);
    };
    const addFiles = async (files: FileList | null) => {
        const input = Array.from(files ?? []); if (!input.length || !ready || !draft || uploadLock.current) return;
        if (input.some(file => !file.type.startsWith("image/"))) { message.warning("参考素材请选择图片；草稿已保留。"); return; }
        if (input.length + draft.references.length > CREATION_DRAFT_REFERENCE_LIMIT) { message.warning("草稿最多保留14个参考素材，未添加这批图片；已有草稿已保留。"); return; }
        uploadLock.current = true; setUploading(true);
        const revision = draft.revision;
        try {
            const references = await Promise.all(input.map(async file => { const stored = await uploadImage(file); return { id: nanoid(), name: file.name, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }; }));
            if (!live.current || activeKind.current !== kind || !currentScope(scope)) return;
            const latest = useCreationMediaLaunch.getState().drafts[kind];
            if (latest?.revision !== revision) { message.warning("输入已变化，未加入迟到素材；请重新选择图片。"); return; }
            await state.edit({ ...latest, references: [...latest.references, ...references] });
        } catch (cause) { if (live.current && activeKind.current === kind && currentScope(scope)) message.error(cause instanceof Error ? cause.message : "素材添加失败，草稿已保留。"); }
        finally { uploadLock.current = false; setUploading(false); }
    };
    const launch = async () => {
        if (submitLock.current || !canLaunch) return;
        submitLock.current = true; setSubmitting(true);
        try {
            if (!draft || !await state.edit({ ...draft, parameters: kind === "audio" ? audio : personalMediaParameters(parameters) })) return;
            if (!live.current || activeKind.current !== kind || !currentScope(scope)) return;
            if (!await state.stage(kind)) { if (live.current && activeKind.current === kind && currentScope(scope)) message.warning("尚未发起：请检查草稿保存状态；当前输入已保留。"); return; }
            if (!live.current || activeKind.current !== kind || !currentScope(scope)) { state.cancel(); return; }
            navigate(creationPath(kind));
        } finally { submitLock.current = false; setSubmitting(false); }
    };

    return <div className="space-y-4" data-creation-media={kind}>
        {!scope && <Alert type="info" title="请先登录，媒体草稿按当前账号保存在此浏览器。" />}
        {state.loading && <div className="text-sm text-muted-foreground">正在读取当前账号草稿…</div>}
        {state.error && <Alert type="error" title={state.error} />}
        <div>
            <div className="rounded-2xl border border-border bg-card p-4">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                    <Tooltip title={kind === "audio" ? "文字转语音暂不支持参考素材。" : "添加参考素材"}><span><Button type="text" className="!size-14 !rounded-xl !border !border-dashed !border-border !text-primary" icon={<ImagePlus size={20} />} aria-label="添加参考素材" disabled={kind === "audio" || !ready || uploading || submitting || (draft?.references.length ?? 0) >= CREATION_DRAFT_REFERENCE_LIMIT} loading={uploading} onClick={() => fileInput.current?.click()} /></span></Tooltip>
                    <span role="status" className="text-xs text-muted-foreground">参考图 {kind === "audio" ? 0 : draft?.references.length ?? 0}/{CREATION_DRAFT_REFERENCE_LIMIT} 张</span>
                </div>
                {kind !== "audio" && draft?.references.length ? <div className="thin-scrollbar mb-3 flex gap-2 overflow-x-auto pb-1">{draft.references.map((reference, index) => <div key={reference.id} className="group relative size-14 shrink-0 overflow-hidden rounded-xl border border-border" title={reference.name}>
                    <img src={reference.dataUrl} alt={reference.name} className="size-full object-cover" /><span className="absolute inset-x-0 bottom-0 truncate bg-background/85 px-1 text-[10px] text-foreground">{referenceCandidates[index].label}</span>
                    <button type="button" className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-background/90 text-foreground" aria-label={`移除${reference.name}`} disabled={!ready || submitting} onClick={() => edit(removeCreationReference(draft.prompt, draft.references, reference.id))}><X size={12} /></button>
                </div>)}</div> : null}
                {kind === "audio" ? <Input.TextArea aria-label="朗读文本" value={draft?.prompt ?? ""} onChange={event => edit({ prompt: event.target.value })} disabled={!ready || submitting} autoSize={{ minRows: 3, maxRows: 12 }} className="!min-h-20 !border-0 !bg-transparent !p-0 !shadow-none" placeholder="描述你想生成的内容…" />
                    : <CanvasPromptChipInput key={`${scope?.accountId}:${scope?.epoch}:${kind}`} value={draft?.prompt ?? ""} references={referenceCandidates} onChange={prompt => edit({ prompt })} disabled={!ready || submitting} ariaLabel={kind === "image" ? "图片提示词" : "视频提示词"} className="min-h-20 max-h-72 text-sm leading-6 text-foreground" placeholderClassName="pointer-events-none absolute left-0 top-0 text-sm leading-6" placeholder={kind === "image" ? "描述你想要的画面，输入 @ 引用参考图…" : "描述你想生成的内容…"} />}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    {modeTabs}
                    <div className="ml-auto flex items-center gap-2"><Tooltip title={kind === "audio" && selectedModel ? "按平台模型目录的已发布单次价格预估，提交前仍须确认正式报价。" : "当前服务尚未提供可用的平台积分预估，生成前请核对实际费用。"}><span className="text-xs text-muted-foreground">预计 {kind === "audio" && selectedModel ? selectedModel.audioPricing.creditsPerUnit : "—"} 积分</span></Tooltip><Tooltip title={referenceIssue || (kind === "audio" ? "查看语音费用" : kind === "image" ? "生成图片" : "生成视频")}><Button type="primary" shape="circle" icon={<ArrowUp size={16} />} aria-label={kind === "audio" ? "查看语音费用" : kind === "image" ? "生成图片" : "生成视频"} disabled={!canLaunch} loading={submitting} onClick={() => void launch()} /></Tooltip></div>
                </div>
                {referenceIssue && <p role="alert" className="mt-2 text-xs text-muted-foreground">{referenceIssue}</p>}
            </div>
        </div>
        {kind === "audio" ? <>
            <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">语音参数</summary><div className="mt-4"><AudioParametersForm hidePrompt value={audio} onChange={next => { const model = models.find(item => item.id === next.model); edit({ prompt: next.prompt, parameters: next.model !== audio.model && model ? selectAudioModelParameters(next, model.audio) : next }); }} modelOptions={models.map(model => ({ value: model.id, label: model.displayName }))} voiceOptions={selectedModel?.audio.voices} formatOptions={selectedModel?.audio.formats} loading={modelsLoading} disabled={!ready || submitting}
                instructionsDisabled={!selectedModel?.audio.instructions} instructionsNote={selectedModel?.audio.instructions ? "风格和语言将随朗读文本提交给所选模型。" : selectedModel?.audio.voices.length === 1 && selectedModel.audio.voices[0] === "default" ? "此模型默认按中文清晰朗读，使用默认音色并输出 WAV；暂不支持自选语言和风格。已有指令请先清空。" : "所选模型尚不支持风格和语言指令；已填内容仍会保留，请选择支持的模型或清空。"} />
                {!selectedModel?.audio.instructions && (audio.style || audio.language) && <Button type="link" disabled={!ready || submitting} onClick={() => edit({ parameters: { ...audio, style: "", language: "" } })}>清除不支持的风格和语言指令</Button>}
            </div></details>
            {modelError && <Alert type="error" title={modelError} />}
            {!modelsLoading && !models.length && !modelError && scope && <Alert type="info" title="暂无可用平台音频模型；可以保留朗读草稿，待管理员配置后继续。" />}
            <p className="text-xs text-muted-foreground">下一步查看语音费用，确认费用后才会提交语音任务。</p>
        </> : <>
            <fieldset disabled={!ready || submitting} className="min-w-0 space-y-4">
            <ModelPicker config={parameters} value={kind === "image" ? parameters.imageModel || parameters.model : parameters.videoModel || parameters.model} onChange={value => changeParameter(kind === "image" ? "imageModel" : "videoModel", value)} capability={kind} />
            <details className="rounded-[12px] border border-border p-4 shadow-none"><summary className="cursor-pointer text-sm">生成参数</summary><div className="mt-4">{kind === "image"
                ? <ImageSettingsPanel config={parameters} onConfigChange={changeParameter} theme={theme} maxCount={10} showTitle={false} className="space-y-4" />
                : <VideoSettingsPanel config={parameters} onConfigChange={changeParameter} theme={theme} showTitle={false} className="space-y-4" />}</div></details>
            </fieldset>
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={event => { void addFiles(event.target.files); event.target.value = ""; }} />
            <Alert type="info" title={kind === "image" ? "使用你在设置中配置的图片服务；未配置有效服务时会提示原因，并保留草稿。" : "使用你在设置中配置的视频服务；未配置服务或超出支持范围时会提示原因，并保留全部草稿。"} />
        </>}
    </div>;
}
