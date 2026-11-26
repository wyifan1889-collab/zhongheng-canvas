import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppHeaderBar } from "@/components/layout/app-header-bar";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { CanvasStorageNotice } from "@/components/canvas/canvas-storage-notice";
import { useCreationMediaLaunch } from "@/stores/use-creation-media-launch";
import { isCreationMediaTarget } from "@/lib/creation-routes";
import { CreationUiBoundary, isCreationUiRoute } from "@/components/creation/ui";
import { CreationSettingsBoundary } from "@/components/creation/creation-settings-boundary";
import { isOwnedUiRoute } from "@/components/creation/ui/context";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname, search, hash } = useLocation();
    const creation = isCreationUiRoute(pathname);
    const ownedUi = isOwnedUiRoute(pathname);
    const cloudCanvas = /^\/canvas\/[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(pathname);
    const joiningCanvas = pathname.startsWith("/canvas/join/");
    useEffect(() => {
        const launch = useCreationMediaLaunch.getState();
        if (launch.pending && !isCreationMediaTarget(pathname, search, launch.pending.draft.kind)) launch.cancel();
    }, [pathname, search]);
    useEffect(() => () => useCreationMediaLaunch.getState().cancel(), []);
    return (
        <CreationUiBoundary active={ownedUi} presentationKey={`${pathname}${search}${hash}`}><div data-owned-layout={ownedUi || undefined} className={`${ownedUi ? "grid grid-cols-[minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-rows-[64px_minmax(0,1fr)]" : "flex"} h-dvh w-full min-w-0 overflow-hidden bg-background text-foreground`}>
            <AppSidebar />
            <div className={ownedUi ? "contents" : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}>
                <AppHeaderBar />
                <div className={`${ownedUi ? "col-start-1 row-start-2 sm:col-start-2" : "flex-1"} flex min-h-0 min-w-0 flex-col overflow-hidden`}>
                    {!cloudCanvas && !joiningCanvas && <CanvasStorageNotice />}
                    <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
                </div>
            </div>
            <AgentPanel uiVariant={ownedUi ? "creation" : "canvas"} />
            {creation ? <CreationSettingsBoundary /> : <AppConfigModal />}
        </div></CreationUiBoundary>
    );
}
