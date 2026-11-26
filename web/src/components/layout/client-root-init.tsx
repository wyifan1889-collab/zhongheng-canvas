import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";
import { useAccountStore } from "@/stores/use-account-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { GenerationTrackingNotifications } from "@/components/layout/generation-tracking-notifications";
import { useRootMessage } from "@/components/creation/ui/app";
import { stripConfigParams } from "@/services/config-file";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const message = useRootMessage();
    const { t } = useTranslation();
    const pendingConfigParams = useRef<{ baseUrl: string | null; apiKey: string | null } | null>(null);
    const [urlReady, setUrlReady] = useState(false);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const accountStatus = useAccountStore((state) => state.status);
    const accountUser = useAccountStore((state) => state.user);
    const accountSite = useAccountStore((state) => state.site);
    const accountBusy = useAccountStore((state) => state.busy);
    const initializeAccount = useAccountStore((state) => state.initialize);

    usePromptSourceScheduler();

    useLayoutEffect(() => {
        let disposed = false;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (baseUrl || apiKey) {
            pendingConfigParams.current = { baseUrl, apiKey };
            const sanitizedUrl = stripConfigParams(window.location.href);
            void import("@/router").then(({ router }) => router.navigate(sanitizedUrl, { replace: true, state: router.state.location.state })).finally(() => {
                if (!disposed) setUrlReady(true);
            });
            return () => { disposed = true; };
        }
        setUrlReady(true);
    }, []);

    useEffect(() => { void initializeAccount(); }, [initializeAccount]);

    useEffect(() => {
        if (!urlReady) return;
        const unsubscribe = useAccountStore.subscribe((current) => {
            if (current.status !== "ready" || current.busy || current.user || !current.site || current.site.captcha) pendingConfigParams.current = null;
        });
        if (accountStatus === "idle" || accountStatus === "loading") return unsubscribe;
        const personalContext = accountStatus === "ready" && !accountBusy && !accountUser && accountSite && !accountSite.captcha;
        if (!personalContext) {
            pendingConfigParams.current = null;
            return unsubscribe;
        }
        const params = pendingConfigParams.current;
        if (!params) return unsubscribe;
        pendingConfigParams.current = null;
        const result = importChannelCredentials(params);
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));
        return unsubscribe;
    }, [urlReady, accountStatus, accountBusy, accountSite, accountUser, importChannelCredentials, message, openConfigDialog, t]);

    return <><GenerationTrackingNotifications />{urlReady ? children : null}</>;
}
