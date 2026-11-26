import { useEffect, useRef, useState, type ReactNode } from "react";
import { theme as antdTheme } from "antd";
import { Button, Dropdown, Select as CreationSelect, Switch, Tooltip } from "@/components/creation/ui";
import { ArrowUp, Check, ChevronUp, Cpu, Gauge, Hand, ImagePlus, LoaderCircle, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { canvasThemes } from "@/lib/canvas-theme";
import { AGENT_MESSAGE_REFERENCE_LIMIT, countAgentDraftReferences } from "@/lib/agent/message-references";
import { CREATION_DRAFT_REFERENCE_LIMIT, creationReferenceSendIssue } from "@/lib/creation-reference-limits";
import { useAgentStore, type AgentModel, type AgentPermissionMode, type AgentReasoningEffort } from "@/stores/use-agent-store";
import type { AgentChatAttachment } from "./agent-chat-message";
import { AgentChatPromptInput } from "./agent-chat-prompt-input";
import { CreationUiContext } from "@/components/creation/ui/context";
import { CreationHint, CreationParameters, CreationToolbar, CreationToolsMenu } from "@/components/creation/creation-workbench";

export function AgentChatComposer({
    prompt,
    attachments = [],
    disabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onStop,
    onAddFiles,
    onRemoveAttachment,
    confirmTools,
    onConfirmToolsChange,
    autoConfirm = false,
    autoConfirmDisabled = false,
    onAutoConfirmChange,
    permissionMode,
    onPermissionModeChange,
    models,
    model,
    reasoningEffort,
    onModelChange,
    onReasoningEffortChange,
    left,
    variant = "canvas",
    uiVariant = "canvas",
    modeTabs,
    workbenchParametersPopover = false,
    workbenchTools = [],
}: {
    prompt: string;
    attachments?: AgentChatAttachment[];
    disabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onStop?: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
    confirmTools?: boolean;
    onConfirmToolsChange?: (confirmTools: boolean) => void;
    autoConfirm?: boolean;
    autoConfirmDisabled?: boolean;
    onAutoConfirmChange?: (autoConfirm: boolean) => void;
    permissionMode?: AgentPermissionMode;
    onPermissionModeChange?: (permissionMode: AgentPermissionMode) => void;
    models?: AgentModel[];
    model?: string;
    reasoningEffort?: AgentReasoningEffort | "";
    onModelChange?: (model: string) => void;
    onReasoningEffortChange?: (effort: AgentReasoningEffort) => void;
    left?: ReactNode;
    variant?: "canvas" | "workbench";
    uiVariant?: "canvas" | "creation";
    modeTabs?: ReactNode;
    workbenchParametersPopover?: boolean;
    workbenchTools?: Array<{ key: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean }>;
}) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken(), workbench = variant === "workbench";
    const fileInputRef = useRef<HTMLInputElement>(null);
    const canvasReferences = useAgentStore((state) => state.canvasReferences);
    const draftAttachments = useAgentStore((state) => state.attachments);
    let referenceCount: number | null = null;
    try { referenceCount = countAgentDraftReferences({ attachments: draftAttachments, canvasReferences }); } catch { /* Keep an invalid draft editable so its sources can be removed. */ }
    const draftLimit = workbench ? CREATION_DRAFT_REFERENCE_LIMIT : AGENT_MESSAGE_REFERENCE_LIMIT;
    const referencesFull = referenceCount === null || referenceCount >= draftLimit;
    const referenceIssue = referenceCount === null ? null : creationReferenceSendIssue(referenceCount, "agent");
    const canSubmit = !disabled && !sending && referenceCount !== null && referenceCount <= AGENT_MESSAGE_REFERENCE_LIMIT && Boolean(prompt.trim() || attachments.length || canvasReferences.length);
    const parametersPopover = workbench && workbenchParametersPopover;
    const [parametersOpen, setParametersOpen] = useState(false);
    useEffect(() => { if (parametersPopover && (disabled || sending)) setParametersOpen(false); }, [parametersPopover, disabled, sending]);
    const parameterControls = <>
        {onConfirmToolsChange ? <ToolConfirmationMenu confirmTools={Boolean(confirmTools)} theme={theme} onChange={onConfirmToolsChange} /> : null}
        {onAutoConfirmChange ? (
            <Tooltip title={t("agent.interactions.autoConfirmDescription")} placement="top">
                <span className="inline-flex shrink-0 items-center gap-1.5 px-1 text-xs" style={{ color: theme.node.text }}>
                    <Switch size="small" checked={autoConfirm} disabled={autoConfirmDisabled} onChange={onAutoConfirmChange} aria-label={t("agent.interactions.autoConfirmLabel")} />
                    <span>{t("agent.interactions.autoConfirmLabel")}</span>
                </span>
            </Tooltip>
        ) : null}
        {permissionMode && onPermissionModeChange ? <PermissionModeMenu permissionMode={permissionMode} theme={theme} onChange={onPermissionModeChange} /> : null}
        {!parametersPopover && models?.length && model && reasoningEffort && onModelChange && onReasoningEffortChange ? <AgentModelControls models={models} model={model} reasoningEffort={reasoningEffort} onModelChange={onModelChange} onReasoningEffortChange={onReasoningEffortChange} /> : null}
        {left}
    </>;
    if (parametersPopover) {
        const current = models?.find(item => item.model === model);
        const effort = reasoningEffort ? t(`agent.composer.effort.${reasoningEffort}`) : "未选择思考程度";
        const permission = permissionMode ? t(`agent.composer.permission.${permissionMode === "full" ? "fullShort" : permissionMode}`) : "权限与工具";
        return <CreationUiContext value><div data-canvas-shortcuts-ignore className="min-w-0 rounded-2xl border border-border bg-card p-3 sm:p-4" onWheelCapture={event => event.stopPropagation()}
            onDragOver={event => { if (onAddFiles && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={event => {
                if (!onAddFiles || !event.dataTransfer.files.length) return;
                event.preventDefault(); event.stopPropagation();
                if (!disabled && !sending) void onAddFiles(Array.from(event.dataTransfer.files));
            }}>
            <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
                <CreationToolsMenu items={[
                    ...(onAddFiles ? [{ key: "upload", label: "上传参考素材", icon: <ImagePlus className="size-4" />, disabled: disabled || sending || referencesFull, onSelect: () => fileInputRef.current?.click() }] : []),
                    ...workbenchTools,
                ]} />
                <span role="status" className="text-xs text-muted-foreground">{referenceCount === null ? "参考素材有冲突，请移除后重试。" : `参考图 ${referenceCount}/${draftLimit} 张`}</span>
            </div>
            <div className="hover-scrollbar mb-2 flex min-w-0 items-center gap-2 overflow-x-auto pb-1 overscroll-x-contain" aria-label="Agent 参考素材">
                {onAddFiles ? <Button type="text" className="!size-16 !shrink-0 !rounded-xl !border !border-dashed !border-border !p-0 !text-muted-foreground" disabled={disabled || sending || referencesFull} icon={<ImagePlus className="size-5" />} onClick={() => fileInputRef.current?.click()} aria-label="添加参考素材" /> : null}
                {attachments.map(item => <div key={item.id} className="relative size-16 shrink-0 overflow-hidden rounded-xl border border-border" title={item.name}>
                    <img src={item.url} alt={item.name} className="size-full object-cover" />
                    {onRemoveAttachment ? <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border border-border bg-card text-foreground shadow-sm" onClick={() => onRemoveAttachment(item.id)} aria-label={t("agent.composer.removeImage")}><X className="size-3" /></button> : null}
                </div>)}
            </div>
            {onAddFiles ? <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={event => { void onAddFiles(event.target.files); event.target.value = ""; }} /> : null}
            {!referenceIssue ? <CreationHint>草稿可保留14张，单次发送给 AI 最多12个参考素材；进入画布后可输入 @ 引用画布素材。</CreationHint> : null}
            <AgentChatPromptInput value={prompt} disabled={disabled} placeholder={placeholder} theme={theme} onChange={onPromptChange} onSubmit={() => { if (canSubmit) void onSubmit(); }} onAddFiles={onAddFiles} suggestionsVariant="workbench" />
            {referenceIssue ? <p role="alert" className="mt-2 text-xs text-muted-foreground">{referenceIssue}</p> : null}
            <div className="mt-3"><CreationToolbar mode={modeTabs}
                model={<CreationSelect<string> aria-label="Agent 模型" className="w-full min-w-0" value={model || undefined} options={(models ?? []).map(item => ({ value: item.model, label: item.displayName || item.model }))}
                    showSearch={{ optionFilterProp: "label" }} placeholder={model || "连接 AI 后选择模型"} disabled={disabled || sending || !onModelChange || !models?.length}
                    notFoundContent="暂无可用 Agent 模型" onChange={value => onModelChange?.(value)} />}
                parameters={<CreationParameters label="Agent 参数" summary={`${effort} · ${permission}`} open={parametersOpen && !disabled && !sending} onOpenChange={setParametersOpen} disabled={disabled || sending}>
                    <fieldset disabled={disabled || sending} className="mt-3 min-w-0 space-y-4"><legend className="sr-only">Agent 参数</legend>
                        <label className="block min-w-0 space-y-2"><span className="block text-xs font-medium text-muted-foreground">思考程度</span>
                            <CreationSelect<string> aria-label="Agent 思考程度" className="w-full" value={reasoningEffort || undefined} disabled={disabled || sending || !onReasoningEffortChange || !current?.supportedReasoningEfforts.length}
                                options={(current?.supportedReasoningEfforts ?? []).map(item => ({ value: item.reasoningEffort, label: t(`agent.composer.effort.${item.reasoningEffort}`) }))}
                                placeholder="连接 AI 后选择思考程度" onChange={value => onReasoningEffortChange?.(value as AgentReasoningEffort)} />
                        </label>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">{parameterControls}</div>
                    </fieldset>
                </CreationParameters>}
                estimate={<CreationHint summary={<span className="whitespace-nowrap">预计 — 积分</span>}>当前服务结算，尚无平台正式报价；平台生成由原能力另行确认费用。</CreationHint>}
                action={sending && onStop ? <Tooltip title={t("agent.composer.stop")} placement="top"><Button danger shape="circle" className="!h-10 !w-10 !min-w-10" icon={<Square className="size-4" />} onClick={() => void onStop()} aria-label={t("agent.composer.stop")} /></Tooltip>
                    : <Tooltip title={t("agent.composer.send")} placement="top"><Button type="primary" shape="circle" className="!h-10 !w-10 !min-w-10" disabled={!canSubmit} icon={sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />} onClick={() => void onSubmit()} aria-label={t("agent.composer.send")} /></Tooltip>}
            /></div>
        </div></CreationUiContext>;
    }
    return (
        <CreationUiContext value={workbench || uiVariant === "creation"}><div className={workbench ? "p-0 [&_[role=textbox]]:p-0" : "px-2 pb-2 pt-2"} onWheelCapture={(event) => event.stopPropagation()}
            onDragOver={(event) => { if (onAddFiles && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={(event) => {
                if (!onAddFiles || !event.dataTransfer.files.length) return;
                event.preventDefault();
                event.stopPropagation();
                if (!disabled && !sending) void onAddFiles(Array.from(event.dataTransfer.files));
            }}>
            <div className={workbench ? "rounded-2xl border p-4 shadow-none" : "rounded-[24px] border px-3 pb-3 pt-3 shadow-lg"}
                style={{ background: workbench ? token.colorBgContainer : theme.toolbar.panel, borderColor: workbench ? token.colorBorderSecondary : theme.node.stroke }}>
                {workbench ? <div className="mb-3 flex items-center gap-3"><Tooltip title="草稿可保留14张；单次发送给AI最多12个参考素材。"><span><Button type="text" className="!size-14 !rounded-xl !border !border-dashed !border-border !text-primary" disabled={disabled || sending || referencesFull} icon={<ImagePlus className="size-5" />} onClick={() => fileInputRef.current?.click()} aria-label="添加参考素材" /></span></Tooltip><span role="status" className="text-xs text-muted-foreground">{referenceCount === null ? "参考素材有冲突，请移除后重试。" : `参考图 ${referenceCount}/${draftLimit} 张`}</span></div> : null}
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className={`group relative size-14 shrink-0 overflow-hidden border ${workbench ? "rounded-[12px]" : "rounded-xl"}`} style={{ borderColor: theme.node.stroke }} title={item.name}>
                                <img src={item.url} alt={item.name} className="size-full object-cover" />
                                {onRemoveAttachment ? (
                                    <button type="button" className={`absolute right-1 top-1 grid size-5 place-items-center rounded-full border shadow-sm transition ${workbench ? "" : "opacity-0 group-hover:opacity-100"}`} style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label={t("agent.composer.removeImage")}>
                                        <X className="size-3" />
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
                <AgentChatPromptInput value={prompt} disabled={disabled} placeholder={placeholder} theme={theme} onChange={onPromptChange} onSubmit={() => { if (canSubmit) void onSubmit(); }} onAddFiles={onAddFiles} suggestionsVariant={parametersPopover ? "workbench" : "inline"} />
                {!workbench ? <div role="status" className="mt-1 text-xs" style={{ color: theme.node.muted }}>{referenceCount === null ? "参考素材有冲突，请移除后重试。" : `已添加 ${referenceCount}/${AGENT_MESSAGE_REFERENCE_LIMIT} 个参考素材`}</div> : null}
                <div className={`@container mt-2 flex items-center justify-between gap-2 ${workbench ? "flex-wrap" : ""}`}>
                    <div className={workbench ? "contents" : "flex min-w-0 items-center gap-1"}>
                        {onAddFiles ? (
                            <>
                                <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => {
                                    void onAddFiles(event.target.files);
                                    event.target.value = "";
                                }} />
                                {!workbench ? <Tooltip title={referencesFull ? `参考素材最多 ${AGENT_MESSAGE_REFERENCE_LIMIT} 个` : t("agent.composer.uploadImage")}>
                                    <Button type="text" shape={workbench ? "default" : "circle"} className={workbench ? "!px-1 text-xs" : "!h-9 !w-9 !min-w-9"} disabled={disabled || sending || referencesFull} style={{ color: theme.node.muted }} icon={<ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()} aria-label={workbench ? "添加参考素材" : t("agent.composer.uploadImage")}>{workbench ? "添加参考素材" : null}</Button>
                                </Tooltip> : null}
                            </>
                        ) : null}
                        {parametersPopover ? <CreationParameters label="Agent 参数" summary={models?.find(item => item.model === model)?.displayName || model || "模型与设置"}
                            open={parametersOpen && !disabled && !sending} onOpenChange={setParametersOpen} disabled={disabled || sending}>
                            <fieldset disabled={disabled || sending} className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                                <legend className="sr-only">Agent 参数</legend>{parameterControls}
                            </fieldset>
                        </CreationParameters> : <div className={workbench ? "order-3 flex w-full min-w-0 flex-wrap items-center gap-1 border-t border-border pt-2" : "contents"}>{parameterControls}</div>}
                    </div>
                    <div className={`flex shrink-0 items-center gap-1.5 ${workbench ? "w-full min-w-0 flex-wrap" : ""}`}>
                        {modeTabs}
                        {workbench ? <Tooltip title="所连接的AI服务尚未提供平台积分预估，费用由该服务结算；平台生成会另行确认费用。"><span className="ml-auto text-xs text-muted-foreground">预计 — 积分</span></Tooltip> : null}
                        {sending && onStop ? (
                            <Tooltip title={t("agent.composer.stop")} placement="top"><Button danger shape="circle" className="!h-10 !w-10 !min-w-10" icon={<Square className="size-4" />} onClick={() => void onStop()} aria-label={t("agent.composer.stop")} /></Tooltip>
                        ) : (
                            <Tooltip title={t("agent.composer.send")} placement="top"><Button type="primary" shape="circle" className="!h-10 !w-10 !min-w-10" disabled={!canSubmit} icon={sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />} onClick={() => void onSubmit()} aria-label={t("agent.composer.send")} /></Tooltip>
                        )}
                    </div>
                </div>
                {workbench && referenceIssue ? <p role="alert" className="mt-2 text-xs text-muted-foreground">{referenceIssue}</p> : null}
            </div>
        </div></CreationUiContext>
    );
}

function AgentModelControls({ models, model, reasoningEffort, onModelChange, onReasoningEffortChange }: { models: AgentModel[]; model: string; reasoningEffort: AgentReasoningEffort; onModelChange: (model: string) => void; onReasoningEffortChange: (effort: AgentReasoningEffort) => void }) {
    const { t } = useTranslation();
    const current = models.find((item) => item.model === model) || models[0];
    const effortLabel = (effort: AgentReasoningEffort) => t(`agent.composer.effort.${effort}`);
    const [modelOpen, setModelOpen] = useState(false);
    const [reasoningOpen, setReasoningOpen] = useState(false);
    return (
        <div className="flex min-w-0 items-center gap-1">
            <Tooltip title={t("agent.composer.model", { model: current.displayName || current.model })} placement="top" open={modelOpen ? false : undefined}>
                <span className="inline-flex shrink-0">
                    <Select value={model} open={modelOpen} onOpenChange={setModelOpen} onValueChange={onModelChange}>
                        <SelectTrigger hideChevron className="h-9 w-9 min-w-9 justify-center gap-0 rounded-full border-0 bg-transparent px-0 text-xs font-medium shadow-none hover:bg-black/5 focus:ring-0 @min-[660px]:w-auto @min-[660px]:min-w-36 @min-[660px]:max-w-36 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:bg-transparent dark:hover:bg-white/10" aria-label={t("agent.composer.selectModel", { model: current.displayName || current.model })}>
                            <Cpu className="size-3.5 shrink-0 opacity-70" />
                            <span className="hidden min-w-0 flex-1 truncate text-left @min-[660px]:inline">{current.displayName || current.model}</span>
                            <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                        </SelectTrigger>
                        <SelectContent data-canvas-no-zoom position="popper" side="top" align="start" sideOffset={6} className="z-[1200] w-64 rounded-xl border border-border/70 bg-popover p-1 shadow-xl">
                            {models.map((item) => <SelectItem key={item.model} value={item.model}>{item.displayName || item.model}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </span>
            </Tooltip>
            <Tooltip title={t("agent.composer.reasoning", { effort: effortLabel(reasoningEffort) })} placement="top" open={reasoningOpen ? false : undefined}>
                <span className="inline-flex shrink-0">
                    <Select value={reasoningEffort} open={reasoningOpen} onOpenChange={setReasoningOpen} onValueChange={(value) => onReasoningEffortChange(value as AgentReasoningEffort)}>
                        <SelectTrigger hideChevron className="h-9 w-9 min-w-9 justify-center gap-0 rounded-full border-0 bg-transparent px-0 text-xs font-medium shadow-none hover:bg-black/5 focus:ring-0 @min-[660px]:w-auto @min-[660px]:min-w-[4.5rem] @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:bg-transparent dark:hover:bg-white/10" aria-label={t("agent.composer.selectReasoning", { effort: effortLabel(reasoningEffort) })}>
                            <Gauge className="size-3.5 opacity-70" />
                            <span className="hidden @min-[660px]:inline">{effortLabel(reasoningEffort)}</span>
                            <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                        </SelectTrigger>
                        <SelectContent data-canvas-no-zoom position="popper" side="top" align="start" sideOffset={6} className="z-[1200] min-w-32 rounded-xl border border-border/70 bg-popover p-1 shadow-xl">
                            {current.supportedReasoningEfforts.map((item) => <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabel(item.reasoningEffort)}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </span>
            </Tooltip>
        </div>
    );
}

function PermissionModeMenu({ permissionMode, theme, onChange }: { permissionMode: AgentPermissionMode; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (permissionMode: AgentPermissionMode) => void }) {
    const { t } = useTranslation();
    const permissionOptions: Array<{ key: AgentPermissionMode; title: string; shortTitle: string; description: string; icon: ReactNode }> = [
        { key: "request", title: t("agent.composer.permission.request"), shortTitle: t("agent.composer.permission.request"), description: t("agent.composer.permission.requestDescription"), icon: <ShieldAlert className="size-3.5" /> },
        { key: "automatic", title: t("agent.composer.permission.automatic"), shortTitle: t("agent.composer.permission.automatic"), description: t("agent.composer.permission.automaticDescription"), icon: <ShieldCheck className="size-3.5" /> },
        { key: "full", title: t("agent.composer.permission.full"), shortTitle: t("agent.composer.permission.fullShort"), description: t("agent.composer.permission.fullDescription"), icon: <ShieldOff className="size-3.5" /> },
    ];
    const current = permissionOptions.find((item) => item.key === permissionMode) || permissionOptions[0];
    const [open, setOpen] = useState(false);
    return (
        <Tooltip title={t("agent.composer.permissionLabel", { mode: current.shortTitle })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: permissionOptions.map((item) => ({
                            key: item.key,
                            label: <ConfirmationOption icon={item.icon} title={item.title} description={item.description} selected={permissionMode === item.key} />,
                            onClick: () => onChange(item.key),
                        })),
                    }}
                >
                    <button type="button" className="flex h-9 w-9 min-w-9 shrink-0 items-center justify-center gap-0 rounded-full px-0 text-xs font-medium transition hover:bg-black/5 @min-[660px]:h-9 @min-[660px]:w-auto @min-[660px]:min-w-0 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:hover:bg-white/10" style={{ color: permissionMode === "full" ? "#ea580c" : theme.node.text }} aria-label={t("agent.composer.selectPermission", { mode: current.title })}>
                        {current.icon}
                        <span className="hidden @min-[660px]:inline">{current.shortTitle}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ToolConfirmationMenu({ confirmTools, theme, onChange }: { confirmTools: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (confirmTools: boolean) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const mode = t(confirmTools ? "agent.composer.tools.manual" : "agent.composer.tools.automatic");
    return (
        <Tooltip title={t("agent.composer.tools.label", { mode })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: [
                            {
                                key: "manual",
                                label: <ConfirmationOption icon={<Hand className="size-4" />} title={t("agent.composer.tools.manual")} description={t("agent.composer.tools.manualDescription")} selected={confirmTools} />,
                                onClick: () => onChange(true),
                            },
                            {
                                key: "automatic",
                                label: <ConfirmationOption icon={<RefreshCw className="size-4" />} title={t("agent.composer.tools.automatic")} description={t("agent.composer.tools.automaticDescription")} selected={!confirmTools} />,
                                onClick: () => onChange(false),
                            },
                        ],
                    }}
                >
                    <button type="button" className="flex h-9 w-9 min-w-9 shrink-0 items-center justify-center gap-0 rounded-full px-0 text-xs font-medium transition hover:bg-black/5 @min-[660px]:w-auto @min-[660px]:min-w-0 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("agent.composer.tools.select", { mode })}>
                        {confirmTools ? <Hand className="size-3.5" /> : <RefreshCw className="size-3.5" />}
                        <span className="hidden @min-[660px]:inline">{mode}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ConfirmationOption({ icon, title, description, selected }: { icon: ReactNode; title: string; description: string; selected: boolean }) {
    return (
        <div className="flex min-w-64 items-start gap-3 py-1">
            <span className="mt-0.5 shrink-0">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="mt-0.5 block text-xs leading-5 opacity-60">{description}</span>
            </span>
            {selected ? <Check className="mt-0.5 size-4 shrink-0" /> : null}
        </div>
    );
}
