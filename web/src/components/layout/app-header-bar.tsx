import { useEffect, useRef, useState } from "react";
import { Badge, Button, Empty, Popover } from "@/components/creation/ui";
import { Bell, ListTodo, Menu, Users } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";

import { AccountControl } from "@/components/account/account-control";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { navigationTools, navigationToolPath } from "@/constant/navigation-tools";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAccountStore } from "@/stores/use-account-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { generationTracker, generationTrackingPresentation, isGenerationOriginRoute } from "@/stores/use-generation-tracker";
import { useCreationUi } from "@/components/creation/ui/context";
import { MobileNavDrawer } from "./mobile-nav-drawer";

export function AppHeaderBar() {
    const creationUi = useCreationUi();
    const { t } = useTranslation(), { pathname, search, hash } = useLocation(), navigate = useNavigate();
    const [navigationOpen, setNavigationOpen] = useState(false);
    const autoConnectRef = useRef(false);
    const agent = useAgentStore(), account = useAccountStore(), scope = account.getDraftScope();
    const tracked = useStore(generationTracker, (state) => state.entries);
    const notices = useStore(generationTracker, (state) => state.notices);
    const theme = useThemeStore((state) => state.theme), setTheme = useThemeStore((state) => state.setTheme);
    const tasks = Object.values(tracked).filter((entry) => scope && entry.accountId === scope.accountId && entry.epoch === scope.epoch);
    const notifications = Object.values(notices).filter((notice) => scope && notice.accountId === scope.accountId && notice.epoch === scope.epoch && notice.isCurrent());
    const unread = notifications.filter((notice) => !notice.read).length;
    const active = navigationTools.find((tool) => pathname === navigationToolPath(tool) || navigationToolPath(tool) !== "/" && pathname.startsWith(navigationToolPath(tool) + "/"));
    useEffect(() => { setNavigationOpen(false); }, [pathname, search, hash, creationUi]);
    useEffect(() => {
        if (!navigationOpen) return;
        const desktop = window.matchMedia("(min-width: 640px)");
        const close = () => { if (desktop.matches) setNavigationOpen(false); };
        desktop.addEventListener("change", close);
        return () => desktop.removeEventListener("change", close);
    }, [navigationOpen]);
    useEffect(() => {
        if (autoConnectRef.current || agent.enabled || agent.connected || !agent.token.trim()) return;
        autoConnectRef.current = true;
        agent.connectAgent({ silent: true });
    }, [agent.enabled, agent.connected, agent.token, agent.connectAgent]);

    if (/^\/canvas\/[^/]+\/?$/.test(pathname)) return null;
    const title = pathname === "/generation/history" ? t("generationHistory.title") : pathname === "/prompts" ? t("prompts.title") : pathname === "/projects" ? t("navigation.canvas") : active ? t(`navigation.${active.slug}`) : t("meta.title");
    return <header className={`${creationUi ? "col-span-full row-start-1 h-14 bg-card px-3 sm:h-16 sm:px-6" : "h-12 px-2 sm:px-4"} flex min-w-0 shrink-0 items-center justify-between gap-2 border-b border-border sm:gap-3`}>
        {creationUi ? <MobileNavDrawer owned open={navigationOpen} onClose={() => setNavigationOpen(false)} trigger={<button type="button" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-accent sm:hidden" aria-label="打开导航" onClick={() => setNavigationOpen(true)}><Menu className="size-4" /></button>} /> : null}
        <div className="min-w-0 flex-1">{creationUi ? <Link to="/" aria-label={t("meta.title")} className="inline-flex max-w-full items-center gap-2 rounded-md font-semibold focus-visible:outline-2 focus-visible:outline-ring">
            <span aria-hidden className="size-6 shrink-0 bg-current" style={{ color: "var(--gold-5)", mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
            <span className="truncate text-base">{t("meta.title")}</span>
        </Link> : <span className="block truncate text-sm font-medium">{title}</span>}</div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-accent [&_svg]:size-4" aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
            {creationUi ? <span aria-label="社群未配置" className="hidden h-10 items-center gap-1.5 px-2 text-xs text-muted-foreground xl:inline-flex"><Users className="size-4" />社群<span className="rounded-full border border-border px-1.5 py-0.5 text-[10px]">未配置</span></span> : null}
            <Popover key={`queue:${pathname}`} trigger="click" placement="bottomRight" title={t("appHeader.taskQueue")} content={tasks.length ? <div className="max-h-80 w-72 max-w-[calc(100vw-48px)] overflow-y-auto">
                {tasks.map((task) => <button key={task.taskId} type="button" className="block w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-accent" onClick={() => {
                    const current = useAccountStore.getState().getDraftScope();
                    if (current?.accountId === task.accountId && current.epoch === task.epoch && isGenerationOriginRoute(task.originRoute)) navigate(task.originRoute);
                }}><span className="block font-medium">{generationTrackingPresentation(task).title}</span><span className="block truncate text-xs opacity-60">{task.modelId}</span></button>)}
            </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("appHeader.emptyQueue")} />}>
                {creationUi ? <Button type="text" size="small" aria-label={t("appHeader.taskQueue")}><Badge count={tasks.filter(task => task.polling).length} size="small"><ListTodo className="size-4" /></Badge><span className="hidden lg:inline">{t("appHeader.taskQueue")}</span></Button> : <Badge count={tasks.filter((task) => task.polling).length} size="small"><Button type="text" size="small" icon={<ListTodo className="size-4" />} aria-label={t("appHeader.taskQueue")}><span className="hidden lg:inline">{t("appHeader.taskQueue")}</span></Button></Badge>}
            </Popover>
            <Popover key={`notices:${pathname}`} trigger="click" placement="bottomRight" title="通知" onOpenChange={(open) => { if (open) generationTracker.getState().markNoticesRead(notifications.map((notice) => notice.key)); }} content={notifications.length ? <div className="max-h-80 w-72 max-w-[calc(100vw-48px)] overflow-y-auto">
                {notifications.map((notice) => <button key={notice.key} type="button" className="block w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-accent" onClick={() => {
                    const current = useAccountStore.getState().getDraftScope();
                    if (current?.accountId === notice.accountId && current.epoch === notice.epoch && notice.isCurrent() && isGenerationOriginRoute(notice.originRoute)) navigate(notice.originRoute);
                }}><span className="block font-medium">{notice.title}</span><span className="block text-xs text-muted-foreground">{notice.description}</span></button>)}
            </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务通知" />}>
                {creationUi ? <Button type="text" size="small" aria-label={`通知，${unread} 条未读`} title="通知"><Badge count={unread} size="small"><Bell className="size-4" /></Badge></Button> : <Badge count={unread} size="small"><Button type="text" size="small" icon={<Bell className="size-4" />} aria-label={`通知，${unread} 条未读`} title="通知" /></Badge>}
            </Popover>
            <AccountControl variant="top-nav" compact showCredits className="inline-flex size-8 shrink-0 items-center justify-center text-foreground hover:bg-accent" />
        </div>
    </header>;
}
