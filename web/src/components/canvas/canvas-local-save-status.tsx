import { useEffect, useState } from "react";
import { canvasSavedRelativeTime } from "@/lib/canvas/save-relative-time";
import { useCanvasSaveStatus } from "@/stores/canvas/use-canvas-store";

export function CanvasLocalSaveStatus() {
    const status = useCanvasSaveStatus(), [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (status.phase !== "saved" || status.savedAt === undefined) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, [status.phase, status.savedAt]);
    const savedTime = status.phase === "saved" ? canvasSavedRelativeTime(status.savedAt, now) : null;
    const blocked = status.phase === "error" || status.phase === "conflict";
    const label = blocked ? "本机保存未完成" : status.phase === "pending" ? "正在保存到本机…" : status.phase === "loading" ? "正在读取本机画布…" : savedTime ? `本机已保存 · ${savedTime}` : "本机自动保存就绪";
    return <span role="status" data-canvas-save-phase={status.phase} title={blocked ? status.message : "本机自动保存，非云端备份"} className="truncate text-xs opacity-65">{label}</span>;
}
