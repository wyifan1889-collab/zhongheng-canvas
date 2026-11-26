import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";
import type { ImageTargetBinding } from "@/lib/canvas/platform-image-target";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasPlatformImageTaskProjection = Readonly<{
    taskId: string;
    target: ImageTargetBinding;
    modelId: string;
    quotedUnits?: number;
    executionStatus: "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
    deliveryStatus: "pending" | "saved" | "visible" | "failed" | "unknown";
    billingStatus: "unbilled" | "reserved" | "captured" | "released" | "pending_review";
    submittedAt?: string;
    application?: "pending" | "applied";
}>;

type Props = {
    node: CanvasNodeData;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    insets: { top: number; bottom: number };
    task: CanvasPlatformImageTaskProjection;
    onOpen: () => void;
    placementMode?: "canvas" | "screen" | "panel";
};

export function canvasImageTaskPlacement(node: CanvasNodeData, viewport: ViewportTransform, size: Props["viewportSize"], insets: Props["insets"], height: number) {
    const scale = Math.max(viewport.k, 0.05), x = node.position.x * scale + viewport.x, y = node.position.y * scale + viewport.y;
    const top = Math.max(0, insets.top), bottom = size.height - Math.max(0, insets.bottom), gap = 8;
    const width = Math.min(node.width, 320, size.width - gap * 2), maxHeight = bottom - top - gap * 2;
    // Render-culling includes a buffer outside the canvas. Do not pin those nodes to its edges.
    if (width <= 0 || maxHeight <= 0 || x + node.width * scale <= 0 || x >= size.width || y + node.height * scale <= top || y >= bottom) return null;
    const left = Math.max(gap, Math.min(x, size.width - width - gap));
    const screenTop = Math.max(top + gap, Math.min(y - height - gap, bottom - Math.min(height, maxHeight) - gap));
    return { left: (left - viewport.x) / scale, top: (screenTop - viewport.y) / scale, width, maxHeight, transform: `scale(${1 / scale})`, transformOrigin: "top left" };
}

const labels: Record<CanvasPlatformImageTaskProjection["executionStatus"], string> = {
    pending: "待处理", queued: "排队中", running: "生成中", succeeded: "生成完成", failed: "生成失败", unknown: "结果待核对", cancelled: "已取消", timeout: "结果待核对",
};

function formatElapsed(submittedAt?: string, now = Date.now()) {
    if (!submittedAt) return "时间待核对";
    const elapsed = Math.max(0, now - Date.parse(submittedAt));
    const seconds = Math.floor(elapsed / 1000);
    return `已用 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function CanvasPlatformImageTaskPlaceholder({ node, viewport, viewportSize, insets, task, onOpen, placementMode = "canvas" }: Props) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [now, setNow] = useState(() => Date.now());
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [height, setHeight] = useState(0);
    const placement = canvasImageTaskPlacement(node, viewport, viewportSize, insets, height);
    useLayoutEffect(() => {
        const button = buttonRef.current;
        if (!button) return;
        const measure = () => setHeight(button.offsetHeight);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(button);
        return () => observer.disconnect();
    }, [Boolean(placement), task.application]);
    const active = task.executionStatus === "pending" || task.executionStatus === "queued" || task.executionStatus === "running";
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    if (task.application === "applied" || !placement) return null;
    const billing = task.billingStatus === "captured" ? "已结算" : task.billingStatus === "released" ? "积分已退回" : task.billingStatus === "pending_review" ? "结算待核对" : "结算处理中";
    const delivery = task.deliveryStatus === "saved" || task.deliveryStatus === "visible" ? "已交付" : task.deliveryStatus === "failed" ? "交付失败" : "交付待确认";
    const application = task.application === "pending" ? "画布落点保存待核对" : "尚未应用到画布";
    const quote = task.quotedUnits === undefined ? "原报价待核对" : `原报价 ${task.quotedUnits} 积分`;
    const style = placementMode === "panel" ? { position: "relative" as const, width: "100%", maxHeight: placement.maxHeight }
        : placementMode === "screen" ? { ...placement, left: placement.left * viewport.k + viewport.x,
            top: placement.top * viewport.k + viewport.y, transform: "none" } : placement;
    return <button ref={buttonRef} type="button" data-node-id={node.id} data-canvas-no-zoom aria-label={`平台图片任务 ${labels[task.executionStatus]}`} onPointerDown={event => event.stopPropagation()} onClick={onOpen}
        className="pointer-events-auto absolute z-[90] flex flex-col items-start gap-0.5 overflow-y-auto rounded-lg border px-3 py-2 text-left text-xs shadow-lg backdrop-blur"
        style={{ ...style, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, visibility: height ? "visible" : "hidden" }}>
        <span className="flex w-full items-center justify-between gap-2 font-medium"><span className="truncate">平台图片 · {labels[task.executionStatus]}</span><span className="shrink-0 opacity-75">{formatElapsed(task.submittedAt, now)}</span></span>
        <span className="w-full truncate opacity-75">{task.modelId} · {quote} · {billing}</span>
        <span className="w-full break-words opacity-70">{delivery} · {application} · 点击查看原任务</span>
    </button>;
}
