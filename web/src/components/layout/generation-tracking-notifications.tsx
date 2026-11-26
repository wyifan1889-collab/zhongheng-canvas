import { useEffect, type Key } from "react";
import { App } from "antd";
import { Button, Typography } from "@/components/creation/ui";
import type { NotificationInstance } from "antd/es/notification/interface";
import type { ArgsProps } from "antd/es/notification/interface";
import { toast } from "sonner";
import { isCreationPresentation, subscribeCreationPresentation } from "@/components/creation/ui/app";
import type { GenerationTrackingScope } from "@/services/saas/generation";
import { useAccountStore } from "@/stores/use-account-store";
import { generationTracker, isGenerationOriginRoute, type GenerationTrackerNotice } from "@/stores/use-generation-tracker";

export async function navigateToGenerationOrigin(route: string, isCurrent: () => boolean,
    loadRouter: () => Promise<{ router: { navigate: (path: string) => void | Promise<void> } }> = () => import("@/router")) {
    if (!isCurrent()) return;
    const { router } = await loadRouter();
    if (isCurrent()) await router.navigate(route);
}

/** Own only this module's notices; old buttons lose authority on scope change or teardown. */
export function createGenerationNotificationBridge(options: {
    notification: Pick<NotificationInstance, "open" | "destroy">;
    getScope: () => GenerationTrackingScope | null;
    navigate: (route: string, isCurrent: () => boolean) => void;
}) {
    let active = true;
    const keys = new Set<string>();
    const current = (notice: GenerationTrackerNotice) => {
        const scope = options.getScope();
        return active && notice.isCurrent() && scope?.accountId === notice.accountId && scope.epoch === notice.epoch && isGenerationOriginRoute(notice.originRoute);
    };
    const dismiss = (key: string) => { if (keys.delete(key)) options.notification.destroy(key); };
    return {
        dismiss,
        notify(notice: GenerationTrackerNotice) {
            if (!current(notice)) return;
            keys.add(notice.key);
            options.notification.open({ key: notice.key, type: notice.level, title: notice.title, role: "status",
                description: <div><p>{notice.description}</p><Typography.Text type="secondary">任务：{notice.taskId}</Typography.Text></div>,
                actions: <Button size="small" onClick={() => {
                    const isCurrent = () => current(notice);
                    if (isCurrent()) options.navigate(notice.originRoute, isCurrent);
                }}>{notice.originRoute === "/image" ? "返回图片工作台" : notice.kindHint === "image" && notice.originRoute.startsWith("/create?") ? "打开图片对话" : notice.originRoute === "/audio" ? "返回音频工作台" : notice.originRoute === "/video" ? "返回视频工作台" : "返回原画布"}</Button> });
        },
        close() {
            active = false;
            for (const key of [...keys]) dismiss(key);
        },
    };
}

/** Route changes dismiss this bridge's visuals, without restarting its tracker. */
export function createGenerationNotificationPresentation(options: {
    notification: Pick<NotificationInstance, "open" | "destroy">;
    isCreation: () => boolean;
    subscribe: (listener: () => void) => () => void;
    showToast: (notice: ArgsProps, key: string) => void;
    dismissToast: (key: string) => void;
}) {
    const antKeys = new Set<string>(), toastKeys = new Set<string>();
    const destroy = (key?: Key) => {
        if (key === undefined) return;
        const value = String(key);
        if (antKeys.delete(value)) options.notification.destroy(value);
        if (toastKeys.delete(value)) options.dismissToast(value);
    };
    const clear = () => { for (const key of [...antKeys, ...toastKeys]) destroy(key); };
    const unsubscribe = options.subscribe(clear);
    return {
        open(notice: ArgsProps) {
            const key = String(notice.key);
            destroy(key);
            if (options.isCreation()) { toastKeys.add(key); options.showToast(notice, key); }
            else { antKeys.add(key); options.notification.open(notice); }
        },
        destroy,
        close() { unsubscribe(); clear(); },
    };
}

/** One tab lifecycle, deliberately above route unmounts and inside Ant Design App. */
export function GenerationTrackingNotifications() {
    const { notification } = App.useApp();
    useEffect(() => {
        const presentation = createGenerationNotificationPresentation({ notification, isCreation: isCreationPresentation, subscribe: subscribeCreationPresentation,
            dismissToast: key => toast.dismiss(key), showToast: (notice, key) => {
                toast.custom(() => <section role={notice.role ?? "status"} className="w-[min(360px,calc(100vw-32px))] space-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
                    <h2 className="text-sm font-semibold">{notice.title ?? notice.message}</h2><div className="text-xs text-muted-foreground">{notice.description}</div><div className="flex justify-end">{notice.actions}</div>
                </section>, { id: key, duration: 8000 });
            } });
        const bridge = createGenerationNotificationBridge({ notification: presentation,
            getScope: () => useAccountStore.getState().getDraftScope(),
            navigate: (route, isCurrent) => {
                // ClientRootInit is outside RouterProvider. Recheck after loading the existing router.
                void navigateToGenerationOrigin(route, isCurrent);
            } });
        const actions = generationTracker.getState(), stop = actions.start({ notify: bridge.notify, dismiss: bridge.dismiss });
        const unsubscribe = useAccountStore.subscribe(() => actions.syncAccount());
        actions.syncAccount();
        return () => { unsubscribe(); stop(); bridge.close(); presentation.close(); };
    }, [notification]);
    return null;
}
