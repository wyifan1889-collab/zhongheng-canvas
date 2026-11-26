import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { App, Button } from "@/components/creation/ui";
import { canvasThemes } from "@/lib/canvas-theme";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { canvasSavedRelativeTime } from "@/lib/canvas/save-relative-time";
import { useThemeStore } from "@/stores/use-theme-store";
import { flushCanvasStorage, getCanvasRecoveryProjects, useCanvasSaveStatus } from "@/stores/canvas/use-canvas-store";

export function CanvasStorageNotice() {
    const status = useCanvasSaveStatus();
    const { message } = App.useApp();
    const { pathname } = useLocation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [exporting, setExporting] = useState(false);
    const [now, setNow] = useState(Date.now);
    const blocked = status.phase === "error" || status.phase === "conflict";
    useEffect(() => {
        if (status.phase !== "saved" || status.savedAt === undefined) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, [status.phase, status.savedAt]);
    const savedTime = status.phase === "saved" ? canvasSavedRelativeTime(status.savedAt, now) : null;
    useEffect(() => {
        // A refresh or route leave can happen during the debounce window. Ask
        // the existing persistence controller to finish its one queued write
        // while the page is still alive; failures remain paused and visible.
        const flushPending = () => {
            if (useCanvasSaveStatus.getState().phase !== "pending") return;
            void flushCanvasStorage().catch(() => {});
        };
        const flushOnVisibilityChange = () => {
            if (document.visibilityState === "hidden") flushPending();
        };
        // pagehide may fire while visibilityState is still "visible" in some
        // browsers, so it must not share the visibility guard.
        document.addEventListener("visibilitychange", flushOnVisibilityChange);
        window.addEventListener("pagehide", flushPending);
        return () => {
            document.removeEventListener("visibilitychange", flushOnVisibilityChange);
            window.removeEventListener("pagehide", flushPending);
        };
    }, []);
    useEffect(() => {
        if (!blocked && status.phase !== "pending") return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [blocked, status.phase]);

    if (!blocked && !pathname.startsWith("/canvas")) return null;
    const exportLocal = async () => {
        setExporting(true);
        try {
            window.dispatchEvent(new Event("canvas:collect-draft"));
            const projects = getCanvasRecoveryProjects();
            if (!projects.length) { message.info("本页没有可导出的画布内容。原存储副本未被清理。"); return; }
            await exportCanvasProjects(projects, "本页画布恢复副本");
            message.info("已生成本页导出包，请核对内容和媒体后再刷新。导出不会恢复自动保存。");
        } catch { message.error("导出未完成，请保留当前页面和内容。"); }
        finally { setExporting(false); }
    };
    return (
        <section role={blocked ? "alert" : "status"} aria-live="polite" data-canvas-shortcuts-ignore
            className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs"
            style={{ background: theme.canvas.background, color: blocked ? theme.node.text : theme.node.muted }}
            onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
            <span>{blocked ? status.message : status.phase === "pending" ? "正在保存到本机，请稍候…" : status.phase === "loading" ? "正在读取本机画布…" : savedTime ? `本页已保存到本机 · ${savedTime} · 非云端备份` : "本机自动保存就绪 · 非云端备份"}</span>
            {blocked ? <>
                <Button size="small" type="text" loading={exporting} onClick={() => void exportLocal()}>导出本页作品</Button>
                <span>未保存内容只在当前页；请先导出并核对，再刷新读取已保存版本。</span>
            </> : null}
        </section>
    );
}
