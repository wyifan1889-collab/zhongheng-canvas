import { useEffect, useMemo, useState } from "react";
import { Button, Dropdown, Input, Modal, Spin, Tooltip } from "@/components/creation/ui";
import { AudioLines, ChevronDown, ChevronRight, FileText, History, Image, Maximize2, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings2, Trash2, Video } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";

import { AccountControl } from "@/components/account/account-control";
import { navigationTools, navigationToolPath } from "@/constant/navigation-tools";
import { useAccountStore } from "@/stores/use-account-store";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAppSidebarCollapsed, useAppSidebarStore } from "@/stores/use-app-sidebar-store";
import { useAppSidebarHistory } from "./use-app-sidebar-history";
import { useCreationUi } from "@/components/creation/ui/context";
import { imageConversationPath } from "@/lib/creation-routes";

const scopeKey = (account = useAccountStore.getState()) => { const scope = account.getDraftScope(); return scope ? JSON.stringify([scope.accountId, scope.epoch]) : null; };
type CanvasOperation = { kind: "rename" | "delete"; id: string; title: string; account: string };

export function AppSidebar({ mobile = false }: { mobile?: boolean }) {
    const { t } = useTranslation();
    const owned = useCreationUi();
    const { pathname } = useLocation(), navigate = useNavigate();
    const dark = useThemeStore((state) => state.theme === "dark"), savedCollapsed = useAppSidebarCollapsed();
    const collapsed = !mobile && savedCollapsed;
    const accountKey = useAccountStore(scopeKey);
    const [historyExpanded, setHistoryExpanded] = useState(true), [canvasesExpanded, setCanvasesExpanded] = useState(true);
    const [operation, setOperation] = useState<CanvasOperation | null>(null);
    const history = useAppSidebarHistory(historyExpanded && !collapsed);
    const conversationTaskIds = new Set(history.conversations.flatMap(conversation => conversation.taskIds));
    const recentHistory = [
        ...history.conversations.map(item => ({ key: item.id, title: item.title, time: new Date(item.updatedAt).toISOString(), Icon: Image, to: imageConversationPath(item.id) })),
        ...history.items.filter(item => !conversationTaskIds.has(item.taskId)).map(item => ({
            key: item.taskId, title: item.title ?? item.displayModel, time: item.createdAt, to: "/generation/history",
            Icon: item.type === "image" ? Image : item.type === "video" ? Video : item.type === "audio" ? AudioLines : item.type === "text" ? FileText : History,
        })),
    ].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 8);
    const projects = useCanvasStore((state) => state.projects), hydrated = useCanvasStore((state) => state.hydrated);
    const recentProjects = useMemo(() => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8), [projects]);
    const createProject = useCanvasStore((state) => state.createProject);
    const linkClass = `flex h-10 items-center gap-3 ${owned ? "rounded-[10px] transition-colors hover:bg-accent" : "rounded-lg transition-opacity hover:opacity-75"} ${mobile ? "" : "max-sm:justify-center max-sm:px-0"} ${collapsed ? "justify-center" : "px-3"}`;
    const navClass = `${linkClass} text-[14px] font-medium`, secondaryClass = `${linkClass} text-[13px] font-normal`;
    const muted = { color: "var(--muted-foreground)" };
    const active = (target: string) => pathname === target || target !== "/" && pathname.startsWith(`${target}/`) || target === "/canvas" && pathname === "/projects";
    useEffect(() => {
        if (useAppSidebarStore.getState().expandedCanvasPath !== pathname) useAppSidebarStore.getState().resetCanvas();
    }, [pathname]);
    useEffect(() => { setOperation(null); }, [accountKey, pathname]);
    const newCanvas = () => {
        if (!useCanvasStore.getState().hydrated || !scopeKey()) return;
        navigate(`/canvas/${createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }))}`);
    };
    const openOperation = (kind: CanvasOperation["kind"], project: CanvasProject) => {
        const account = scopeKey();
        if (account && useCanvasStore.getState().hydrated) setOperation({ kind, id: project.id, title: project.title, account });
    };
    const confirmOperation = () => {
        if (!operation || operation.account !== scopeKey() || !useCanvasStore.getState().hydrated || !useCanvasStore.getState().openProject(operation.id)) { setOperation(null); return; }
        if (operation.kind === "rename") {
            if (!operation.title.trim()) return;
            useCanvasStore.getState().renameProject(operation.id, operation.title.trim());
        }
        else {
            useCanvasStore.getState().deleteProjects([operation.id]);
            useAssetStore.getState().cleanupImages();
            useCanvasUiStore.getState().removeSelectedProjectIds([operation.id]);
            if (pathname === `/canvas/${operation.id}`) navigate("/projects");
        }
        setOperation(null);
    };
    return <aside data-canvas-shortcuts-ignore aria-label={t("appSidebar.navigation")} className={`${owned && !mobile ? "col-start-1 row-start-2 hidden sm:flex" : "flex"} h-full min-h-0 shrink-0 flex-col overflow-hidden ${owned ? "" : "border-r max-sm:!w-16"}`} style={{ width: mobile ? "100%" : collapsed ? 64 : 220, transition: "width 200ms ease", background: "var(--sidebar)", borderColor: "var(--sidebar-border)", color: "var(--sidebar-foreground)" }}>
        <div className={`flex shrink-0 items-center gap-2 ${owned ? mobile ? "h-16 px-5" : "h-12 px-5" : "h-16 p-3 max-sm:justify-center"} ${collapsed ? "justify-center" : owned && !mobile ? "justify-end" : "justify-between"}`}>
            {(!owned || mobile) && <Link to="/" className={`flex min-w-0 items-center gap-2 ${collapsed ? "sm:hidden" : ""}`} aria-label={t("meta.title")}>
                <span className="size-[26px] shrink-0 bg-current" style={{ color: "var(--gold-5)", mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                {!collapsed ? <span className={`truncate ${owned ? "text-xl font-semibold" : "text-[14px] font-semibold max-sm:hidden"} ${dark ? "brand-gold-shimmer" : ""}`}>{t("meta.title")}</span> : null}
            </Link>}
            <Tooltip placement="right" title={t(collapsed ? "appSidebar.expand" : "appSidebar.collapse")}>
                <Button type="text" className={`!shrink-0 ${mobile ? "hidden!" : "max-sm:!hidden"}`} aria-label={t(collapsed ? "appSidebar.expand" : "appSidebar.collapse")} onClick={() => useAppSidebarStore.getState().toggle(pathname)} icon={collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />} />
            </Tooltip>
        </div>
        <div className={`thin-scrollbar min-h-0 flex-1 overflow-y-auto pb-3 ${owned && !collapsed ? "px-5" : "px-2"}`}>
            <nav className={owned ? "space-y-2" : "space-y-1"}>
                {navigationTools.map((tool) => {
                    const target = navigationToolPath(tool), selected = active(target), Icon = tool.icon;
                    return <Tooltip key={tool.slug} title={collapsed ? t(`navigation.${tool.slug}`) : undefined} placement="right">
                        <Link to={target} aria-label={t(`navigation.${tool.slug}`)} aria-current={selected ? "page" : undefined} className={`${navClass} ${selected ? "sidebar-nav-active" : ""}`} style={selected ? undefined : muted}>
                            <Icon className="size-4 shrink-0" />{!collapsed ? <span className={mobile ? "truncate" : "truncate max-sm:hidden"}>{t(`navigation.${tool.slug}`)}</span> : null}
                        </Link>
                    </Tooltip>;
                })}
                {!owned || collapsed ? <Link to="/generation/history" aria-label={t("generationHistory.title")} title={t("generationHistory.title")} aria-current={active("/generation/history") ? "page" : undefined} className={`${navClass} ${owned ? "" : "sm:hidden"} ${active("/generation/history") ? "sidebar-nav-active" : ""}`} style={active("/generation/history") ? undefined : muted}><History className="size-4 shrink-0" /></Link> : null}
            </nav>
            {!collapsed ? <div className={`mt-5 space-y-4 ${mobile ? "" : "max-sm:hidden"}`}>
                {owned ? <p className="text-[11px] text-muted-foreground">工作区</p> : null}
                <section>
                    <button type="button" className="flex h-8 w-full items-center gap-2 px-2 text-left !text-[13px] font-normal" aria-expanded={historyExpanded} onClick={() => setHistoryExpanded(!historyExpanded)} style={muted}>
                        <History className="size-3.5 shrink-0" /><span className="flex-1">创作历史</span>{historyExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </button>
                    {historyExpanded ? <div className="space-y-1 pl-2">
                        {!history.authenticated || history.blocked ? <p className="px-2 text-[13px] font-normal" style={muted}>{t("appSidebar.signInRequired")}</p> : <>
                            {history.phase === "loading" ? <div role="status" className="flex items-center gap-2 px-2 py-1 text-[13px] font-normal" style={muted}><Spin size="small" />{t("appSidebar.loading")}</div> : null}
                            {history.phase === "error" ? <div className="px-2 text-[13px] font-normal" style={muted}><p>{t("appSidebar.historyError")}</p><Button type="link" size="small" className="!text-[13px] !font-normal" onClick={history.refresh}>{t("appSidebar.retry")}</Button></div> : null}
                            {history.phase === "ready" && !recentHistory.length ? <p className="px-2 text-[13px] font-normal" style={muted}>{t("appSidebar.emptyHistory")}</p> : null}
                            {recentHistory.map(({ key, title, time, Icon, to }) => <Link key={key} to={to} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:opacity-75" aria-label={t("appSidebar.openHistory", { model: title })} title={title}>
                                <Icon className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate text-[13px] font-normal">{title}</span><time dateTime={time} className="shrink-0 text-[11px] font-normal" style={muted}>{dayjs(time).format("MM-DD HH:mm")}</time>
                            </Link>)}
                        </>}
                        <Link to="/generation/history?view=conversations" className="block px-2 py-1 text-[13px] font-normal" style={muted}>查看全部</Link>
                    </div> : null}
                </section>
                <section>
                    <div className="flex items-center">
                        <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left !text-[13px] font-normal" aria-expanded={canvasesExpanded} onClick={() => setCanvasesExpanded(!canvasesExpanded)} style={muted}>
                            <Maximize2 className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">画布</span>{canvasesExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        </button>
                        <Tooltip title={t("appSidebar.newCanvas")}><Button type="text" size="small" disabled={!hydrated || !accountKey} aria-label={t("appSidebar.newCanvas")} onClick={newCanvas} icon={<Plus className="size-3.5" />} /></Tooltip>
                    </div>
                    {canvasesExpanded ? <div className="space-y-1 pl-2">
                        {!accountKey ? <p className="px-2 text-[13px] font-normal" style={muted}>{t("appSidebar.signInRequired")}</p> : !hydrated ? <p className="px-2 text-[13px] font-normal" style={muted}>{t("appSidebar.loading")}</p>
                            : recentProjects.length ? recentProjects.map((project) => <div key={project.id} className={`flex min-w-0 items-center rounded-lg ${pathname === `/canvas/${project.id}` ? "sidebar-nav-active" : ""}`}>
                                <Link to={`/canvas/${project.id}`} className="min-w-0 flex-1 truncate px-2 py-1.5 text-[13px] font-normal hover:opacity-75" aria-current={pathname === `/canvas/${project.id}` ? "page" : undefined} aria-label={t("appSidebar.openCanvas", { title: project.title })} title={project.title}>{project.title}</Link>
                                <Dropdown trigger={["click"]} popupRender={(menu) => <div data-canvas-shortcuts-ignore onKeyDown={(event) => event.stopPropagation()}>{menu}</div>} menu={{ items: [{ key: "rename", label: t("canvas.project.rename"), icon: <Pencil className="size-3.5" /> }, { key: "delete", label: t("canvas.project.delete"), icon: <Trash2 className="size-3.5" />, danger: true }], onClick: ({ key }) => openOperation(key === "rename" ? "rename" : "delete", project) }}>
                                    <Button type="text" size="small" aria-label={`画布操作：${project.title}`} icon={<MoreHorizontal className="size-3.5" />} />
                                </Dropdown>
                            </div>) : <p className="px-2 text-[13px] font-normal" style={muted}>{t("appSidebar.emptyCanvases")}</p>}
                    </div> : null}
                </section>
            </div> : null}
        </div>
        <div className="shrink-0 space-y-1 border-t p-2" style={{ borderColor: "var(--sidebar-border)" }}>
            <Tooltip title={collapsed ? t("navigation.config") : undefined} placement="right"><Link to="/config" aria-label={t("navigation.config")} className={secondaryClass} style={muted}><Settings2 className="size-4 shrink-0" />{!collapsed ? <span className={mobile ? "" : "max-sm:hidden"}>{t("navigation.config")}</span> : null}</Link></Tooltip>
            {!owned ? <>
            <div className={`flex min-w-0 overflow-hidden max-sm:justify-center max-sm:[&_button>span]:!hidden [&_button]:!max-w-full [&_button>svg]:shrink-0 [&_button_span]:!text-[13px] [&_button_span]:!font-normal ${collapsed ? "justify-center [&_button>span]:!hidden" : "justify-start [&_button>span]:!inline-flex [&_button>span]:min-w-0"}`}>
                <AccountControl variant="canvas" className={`inline-flex h-9 max-w-full items-center gap-2 rounded-lg px-2 hover:opacity-75 ${collapsed ? "justify-center" : "justify-start"}`} style={{ color: "var(--sidebar-foreground)" }} />
            </div>
            {!collapsed ? <span className="block px-3 py-1 text-xs opacity-40 max-sm:hidden">忠恒AI · Beta</span> : null}
            </> : null}
        </div>
        <Modal open={Boolean(operation && operation.account === accountKey)} title={operation?.kind === "rename" ? t("canvas.rename") : t("canvas.project.deleteTitle")} onCancel={() => setOperation(null)} onOk={confirmOperation} okText={operation?.kind === "rename" ? t("common.save") : t("common.delete")} okButtonProps={{ danger: operation?.kind === "delete", disabled: operation?.kind === "rename" && !operation.title.trim() }} destroyOnHidden modalRender={(node) => <div data-canvas-shortcuts-ignore onKeyDown={(event) => event.stopPropagation()}>{node}</div>}>
            {operation?.kind === "rename" ? <Input aria-label={t("canvas.rename")} autoFocus value={operation.title} onChange={(event) => setOperation({ ...operation, title: event.target.value })} onPressEnter={confirmOperation} /> : <p className="text-sm text-muted-foreground">确定从本机画布库删除「{operation?.title}」？里面的节点和连线也会移除，不会删除云端画布。</p>}
        </Modal>
    </aside>;
}
