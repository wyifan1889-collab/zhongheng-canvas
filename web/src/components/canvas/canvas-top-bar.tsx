import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, Bot, Download, FileCheck2, Home, Images, ListTodo, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Trash2, Undo2, Upload, Users, Video } from "lucide-react";
import { Badge, Button, Dropdown, Empty, Modal, Popover, Switch, Tooltip, type MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useStore } from "zustand";

import { AccountControl } from "@/components/account/account-control";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { DOCS_URL } from "@/constant/env";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAccountStore } from "@/stores/use-account-store";
import { useAppSidebarCollapsed, useAppSidebarStore } from "@/stores/use-app-sidebar-store";
import { generationTracker, generationTrackingPresentation, isGenerationOriginRoute } from "@/stores/use-generation-tracker";
import { CanvasLocalSaveStatus } from "./canvas-local-save-status";

function confirmedOwnerContext(account = useAccountStore.getState()) {
    const scope = account.getDraftScope();
    if (scope) return scope.accountId;
    return account.status === "ready" && !account.busy && !account.user && account.site && !account.site.captcha ? "local" : null;
}

export function CanvasTopBar({
    onShare,
    readOnly = false,
    cloudMode = false,
    saveStatus,
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onExportProject,
    onCheckSave,
    onReviewReceipts,
    onFirstSave,
    onCloudLibrary,
    cloudCanvasEnabled,
    onAccountDrafts,
    onPlatformImage,
    onPlatformVideo,
    onPlatformText,
    onImportImage,
    onOpenPlugins,
    onUndo,
    onRedo,
    agentOpen,
    compactAgentStatus,
    onToggleAgent,
}: {
    onShare?: () => void;
    readOnly?: boolean;
    cloudMode?: boolean;
    saveStatus?: ReactNode;
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onExportProject: () => void;
    onCheckSave: () => void;
    onReviewReceipts: () => void;
    onFirstSave: () => void;
    onCloudLibrary: () => void;
    cloudCanvasEnabled: boolean;
    onAccountDrafts: () => void;
    onPlatformImage: () => void;
    onPlatformVideo?: () => void;
    onPlatformText?: () => void;
    onImportImage: () => void;
    onOpenPlugins: () => void;
    onUndo: () => void;
    onRedo: () => void;
    agentOpen: boolean;
    compactAgentStatus: { connected: boolean; enabled: boolean; activity: string };
    onToggleAgent: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const { t } = useTranslation();
    const { pathname } = useLocation(), navigate = useNavigate();
    const sidebarCollapsed = useAppSidebarCollapsed();
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const sidePanelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const toggleSidePanel = useCanvasSidePanelStore((state) => state.togglePanel);
    const autoConfirm = useAgentStore((state) => state.autoConfirm);
    const autoConfirmOwnerContext = useAgentStore((state) => state.autoConfirmOwnerContext);
    const ownerContext = useAccountStore(confirmedOwnerContext);
    const account = useAccountStore(), scope = account.getDraftScope();
    const tracked = useStore(generationTracker, (state) => state.entries);
    const tasks = Object.values(tracked).filter((entry) => scope && entry.accountId === scope.accountId && entry.epoch === scope.epoch);
    const canAutoConfirm = !readOnly && !!ownerContext && ownerContext === autoConfirmOwnerContext;
    const agentStatus = compactAgentStatus.connected ? "AI 已连接" : compactAgentStatus.enabled ? "AI 连接中" : "连接 AI";
    const connectAgent = () => {
        if (readOnly) return;
        const agent = useAgentStore.getState();
        agent.setAgentState({ activeTab: "setup" }); agent.openPanel();
    };
    const menuItems = (items: NonNullable<MenuProps["items"]>) => items
        .filter(item => !cloudMode || !["cloud-library", "account-drafts", "delete", "export", "save-check", "save-receipts"].includes(String(item?.key)))
        .map(item => readOnly && item && item.type !== "divider" && !["home", "docs", "projects", "new"].includes(String(item.key)) ? { ...item, disabled: true } : item);

    useEffect(() => {
        if (!isTitleEditing || readOnly) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, readOnly, onFinishTitleEditing]);

    return (
        <>
            <div data-canvas-shortcuts-ignore className="pointer-events-none relative flex min-h-16 flex-wrap items-center justify-between gap-x-2 gap-y-2 px-3 py-3" style={{ color: theme.node.text }}>
                <div className="pointer-events-auto flex min-w-0 max-w-full flex-[1_1_8rem] items-center gap-2">
                    <Tooltip title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}><button type="button" onClick={() => useAppSidebarStore.getState().toggle(pathname)} aria-label={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"} aria-expanded={!sidebarCollapsed} className="grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10">{sidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</button></Tooltip>
                    <Tooltip title="返回画布列表"><button type="button" onClick={onProjects} aria-label="返回画布列表" className="grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10"><ArrowLeft className="size-4" /></button></Tooltip>
                    <div ref={titleRef} className="flex min-w-12 max-w-[clamp(92px,22vw,280px)] items-center gap-2">
                        {isTitleEditing && !readOnly ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onFocus={(event) => event.target.select()}
                                aria-label={t("canvas.name")}
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.nativeEvent.isComposing) return;
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="min-w-0 w-full bg-transparent p-0 text-left text-sm font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                disabled={readOnly}
                                className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-1 text-left text-sm font-semibold tracking-normal transition hover:bg-black/5 dark:hover:bg-white/10"
                                onClick={onStartTitleEditing}
                                title={readOnly ? "只读画布" : t("canvas.renameHint")}
                                aria-label={`${readOnly ? "画布名称" : t("canvas.rename")}: ${title}`}
                            >
                                <span className="truncate">{title}</span>
                                {!readOnly && <Pencil className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />}
                            </button>
                        )}
                    </div>
                </div>

                <div className="pointer-events-auto flex max-w-full flex-[0_1_auto] flex-wrap items-center justify-end gap-x-1 gap-y-2 [&>*]:shrink-0">
                    <div className="w-28 min-w-24 max-w-full [&>[role=status]]:block">{saveStatus !== undefined ? saveStatus : !cloudMode ? <CanvasLocalSaveStatus /> : null}</div>
                    {!readOnly && <>
                        <Tooltip title={canAutoConfirm ? t("agent.interactions.autoConfirmDescription") : "请先打开 AI 连接设置，确认当前账号"}>
                            <span className="inline-flex shrink-0 items-center gap-1.5 px-1 text-xs"><Switch size="small" aria-label={t("agent.interactions.autoConfirmLabel")} checked={canAutoConfirm && autoConfirm} disabled={!canAutoConfirm} onChange={value => {
                                const agent = useAgentStore.getState(), owner = confirmedOwnerContext();
                                if (!readOnly && owner && owner === agent.autoConfirmOwnerContext) agent.setAutoConfirm(value);
                            }} /><span className="hidden xl:inline">免确认生成</span></span>
                        </Tooltip>
                        <Tooltip title={`${agentStatus}${compactAgentStatus.activity ? ` · ${compactAgentStatus.activity}` : ""}，打开 AI 连接设置`}><Button type="text" className="!h-8 !px-2 !font-medium !shadow-none" style={{ color: theme.node.text }} icon={<Bot className="size-4" />} onClick={connectAgent} aria-label={`${agentStatus}，打开 AI 连接设置`} aria-expanded={agentOpen}>
                            <span aria-hidden="true" className={`size-1.5 rounded-full ${compactAgentStatus.connected ? "bg-primary" : compactAgentStatus.enabled ? "animate-pulse bg-primary" : "bg-muted-foreground/40"}`} /><span className="hidden lg:inline">{agentStatus}</span>
                        </Button></Tooltip>
                    </>}
                    <Tooltip title={onShare ? "分享协作" : cloudMode ? "画布权限尚未确认" : "即将上线"}><span><Button type="text" className="!h-8 !px-2 !shadow-none" style={{ color: theme.node.text }} icon={<Users className="size-4" />} aria-label="分享协作" disabled={!onShare} onClick={onShare}><span className="hidden lg:inline">分享协作</span></Button></span></Tooltip>
                    <Popover trigger="click" placement="bottomRight" title="我的任务队列" content={<div data-canvas-shortcuts-ignore>{tasks.length ? <div className="max-h-80 w-72 overflow-y-auto">
                        {tasks.map((task) => <button key={task.taskId} type="button" className="block w-full rounded-lg px-2 py-2 text-left text-[13px] transition hover:bg-black/5 dark:hover:bg-white/10" onClick={() => {
                            const current = useAccountStore.getState().getDraftScope();
                            if (current?.accountId === task.accountId && current.epoch === task.epoch && isGenerationOriginRoute(task.originRoute)) navigate(task.originRoute);
                        }}><span className="block font-medium">{generationTrackingPresentation(task).title}</span><span className="block truncate text-xs opacity-60">{task.modelId}</span></button>)}
                    </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前账户暂无跟踪任务" />}</div>}>
                        <Badge count={tasks.filter((task) => task.polling).length} size="small"><Button type="text" className="!h-8 !px-2 !shadow-none" style={{ color: theme.node.text }} icon={<ListTodo className="size-4" />} aria-label="查看我的生成队列"><span className="hidden xl:inline">任务</span></Button></Badge>
                    </Popover>
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: menuItems([
                                { key: "home", icon: <Home className="size-4" />, label: t("canvas.home"), onClick: onHome },
                                { key: "docs", icon: <BookOpen className="size-4" />, label: t("canvas.docs"), onClick: () => window.open(DOCS_URL, "_blank", "noopener,noreferrer") },
                                { key: "projects", icon: <Images className="size-4" />, label: t("canvas.projects"), onClick: onProjects },
                                { key: "agent", icon: <Bot className="size-4" />, label: agentOpen ? "收起 AI 面板" : "打开 AI 面板", onClick: onToggleAgent },
                                { key: "side-panel", icon: sidePanelOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />, label: sidePanelOpen ? t("canvas.collapsePanel") : t("canvas.expandPanel"), onClick: toggleSidePanel },
                                { key: "cloud-library", icon: <Images className="size-4" />, label: cloudCanvasEnabled ? "我的云稿" : "我的云稿（未开放）", onClick: (info) => { info.domEvent.preventDefault(); onCloudLibrary(); } },
                                { key: "account-drafts", icon: <FileCheck2 className="size-4" />, label: "账号草稿（本机）", onClick: (info) => { info.domEvent.preventDefault(); onAccountDrafts(); } },
                                ...(onPlatformText ? [{ key: "platform-text", icon: <Pencil className="size-4" />, label: "平台生成文本", onClick: onPlatformText }] : []),
                                { key: "platform-image", icon: <Images className="size-4" />, label: "平台生成图片", onClick: onPlatformImage },
                                ...(onPlatformVideo ? [{ key: "platform-video", icon: <Video className="size-4" />, label: "平台生成视频", onClick: onPlatformVideo }] : []),
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: t("canvas.create"), onClick: onCreateProject },
                                { key: "rename", disabled: readOnly, icon: <Pencil className="size-4" />, label: t("canvas.rename"), onClick: onStartTitleEditing },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.deleteCurrent"), onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: t("canvas.importAsset"), onClick: onImportImage },
                                { key: "export", icon: <Download className="size-4" />, label: t("canvas.exportCurrent"), onClick: onExportProject },
                                { key: "save-check", icon: <FileCheck2 className="size-4" />, label: "保存检查（仅本机）", onClick: onCheckSave },
                                { key: "first-cloud-save", icon: <Upload className="size-4" />, label: cloudCanvasEnabled ? "手动云保存" : "手动云保存（未开放）", onClick: (info) => { info.domEvent.preventDefault(); onFirstSave(); } },
                                { key: "save-receipts", icon: <FileCheck2 className="size-4" />, label: "保存回执（只读）", onClick: (info) => { info.domEvent.preventDefault(); onReviewReceipts(); } },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text={t("canvas.undo")} shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text={t("canvas.redo")} shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ]),
                        }}
                    >
                        <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("canvas.openMenu")}>
                            <MoreHorizontal className="size-4" />
                        </button>
                    </Dropdown>
                    <Popover trigger="click" placement="bottomRight" content={<div data-canvas-shortcuts-ignore><UserStatusActions showAccount={false} variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} onOpenPlugins={readOnly ? undefined : onOpenPlugins} /></div>}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 !p-0 !shadow-none" style={{ color: theme.node.text }} icon={<BookOpen className="size-4" />} aria-label="界面与帮助" />
                    </Popover>
                    <AccountControl variant="canvas" compact showCredits={cloudMode} className="inline-flex shrink-0 items-center justify-center transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} />
                </div>
            </div>
            <Modal title={t("canvas.shortcuts")} open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["Ctrl / Space", t("canvas.shortcut.drag")]} value={t("canvas.shortcut.toggleTool")} />
                    <Shortcut keys={[t("canvas.shortcut.wheel")]} value={t("canvas.shortcut.zoom")} />
                    <Shortcut keys={[t("canvas.shortcut.zoomSlider")]} value={t("canvas.shortcut.preciseZoom")} />
                    <Shortcut keys={[t("canvas.shortcut.drag")]} value={t("canvas.shortcut.boxSelect")} />
                    <Shortcut keys={["Shift / Cmd", t("canvas.shortcut.click")]} value={t("canvas.shortcut.addSelection")} />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value={t("canvas.shortcut.selectAll")} />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value={t("canvas.shortcut.copyPaste")} />
                    <Shortcut keys={["Ctrl / Cmd", "G"]} value={t("canvas.shortcut.group")} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "G"]} value={t("canvas.shortcut.ungroup")} />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value={t("canvas.undo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Delete / Backspace"]} value={t("canvas.shortcut.delete")} />
                    <Shortcut keys={["Esc"]} value={t("canvas.shortcut.escape")} />
                    <Shortcut keys={[t("canvas.shortcut.dropMedia")]} value={t("canvas.shortcut.upload")} />
                </div>
            </Modal>
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-6 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2.5 py-1.5 text-center text-xs font-medium leading-none shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: "rgba(120,113,108,.28)", background: "linear-gradient(#fff, rgba(245,245,244,.92))", color: "rgb(68,64,60)" }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{value}</span>
        </div>
    );
}
