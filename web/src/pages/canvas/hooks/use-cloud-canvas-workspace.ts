import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createCloudCanvasWorkspace } from "../../../services/saas/cloud-canvas-workspace";
import { useAccountStore } from "../../../stores/use-account-store";

/** Route adapter: one in-memory workspace per confirmed account and cloud canvas. */
export function useCloudCanvasWorkspace(canvasId: string) {
    const accountKey = useAccountStore((account) => {
        const scope = account.getDraftScope();
        return JSON.stringify([scope?.accountId, scope?.epoch, account.site?.cloudCanvas, account.site?.cloudMedia]);
    });
    const workspace = useMemo(() => createCloudCanvasWorkspace(canvasId, () => {
        const account = useAccountStore.getState(), scope = account.getDraftScope();
        return scope ? { ...scope, cloudCanvas: account.site?.cloudCanvas === true, cloudMedia: account.site?.cloudMedia === true } : null;
    }), [canvasId, accountKey]);
    const state = useSyncExternalStore(workspace.subscribe, workspace.getState, workspace.getState);
    useEffect(() => {
        void workspace.load().catch(() => { /* The workspace exposes the blocked state. */ });
        const recheck = () => { if (document.visibilityState === "visible") void workspace.recheck().catch(() => { /* Account invalidation is already projected. */ }); };
        window.addEventListener("focus", recheck);
        document.addEventListener("visibilitychange", recheck);
        return () => {
            window.removeEventListener("focus", recheck);
            document.removeEventListener("visibilitychange", recheck);
            workspace.dispose();
        };
    }, [workspace]);
    useEffect(() => {
        if (!state.dirty) return;
        const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", protect);
        return () => window.removeEventListener("beforeunload", protect);
    }, [state.dirty]);
    return { ...state, openProject: workspace.openProject, updateProject: workspace.updateProject,
        renameProject: workspace.renameProject, save: workspace.save, recheck: workspace.recheck };
}

export type CloudCanvasWorkspace = ReturnType<typeof useCloudCanvasWorkspace>;
