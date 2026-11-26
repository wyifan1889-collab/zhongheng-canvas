import { useEffect, useState } from "react";
import { canvasSavedRelativeTime } from "@/lib/canvas/save-relative-time";
import type { CloudCanvasWorkspaceState } from "@/services/saas/cloud-canvas-workspace";

export type CanvasCloudSaveStatusProps = Pick<CloudCanvasWorkspaceState, "phase" | "dirty" | "lastSavedAt" | "revision" | "access">;

export function CanvasCloudSaveStatus({ phase, dirty, lastSavedAt, revision, access }: CanvasCloudSaveStatusProps) {
    const [now, setNow] = useState(Date.now);
    const savedAt = lastSavedAt ? Date.parse(lastSavedAt) : undefined;
    useEffect(() => {
        if (phase !== "ready" || dirty || savedAt === undefined || !Number.isFinite(savedAt) || savedAt <= 0) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, [phase, dirty, savedAt]);
    const savedTime = phase === "ready" && !dirty ? canvasSavedRelativeTime(savedAt, now) : null;
    const label = phase === "blocked" ? "云端保存已暂停"
        : phase === "error" ? "云端保存未完成"
        : phase === "conflict" ? "云端版本冲突，待处理"
        : phase === "unknown" ? "云端保存结果待核对"
        : phase === "saving" ? "正在保存到云端…"
        : dirty ? "云端有未保存修改"
        : phase === "loading" ? "正在读取云端画布…"
        : access?.role === "viewer" ? savedTime ? `云端只读 · 上次保存 ${savedTime}` : "云端只读"
        : savedTime ? `云端已保存 · ${savedTime}` : "云端保存就绪";
    const title = Number.isSafeInteger(revision) && revision !== null && revision > 0 ? `${label}；云端版本 ${revision}` : label;
    return <span role="status" data-canvas-save-kind="cloud" data-canvas-save-phase={phase} title={title} className="truncate text-xs opacity-65">{label}</span>;
}
