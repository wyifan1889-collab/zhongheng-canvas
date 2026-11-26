import { useEffect, useRef, useState } from "react";
import { FlipHorizontal, FlipVertical, RotateCcw, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { Button } from "./controls";

/** Radix owns the dialog; the audited gesture library owns pan and pinch. */
export function CreationImagePreview({ src, alt }: { src?: string; alt: string }) {
    const transform = useRef<ReactZoomPanPinchRef>(null), area = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1), [orientation, setOrientation] = useState({ rotation: 0, x: 1, y: 1 });
    const clamp = (value: number) => Math.min(50, Math.max(1, value));
    useEffect(() => {
        const node = area.current;
        if (!node) return;
        const wheel = (event: WheelEvent) => {
            const current = transform.current;
            if (!current || !event.deltaY) return;
            event.preventDefault(); event.stopPropagation();
            // Match the existing image preview's capped .5 multiplicative step.
            const ratio = 1 + Math.min(Math.abs(event.deltaY / 100), 1) * .5;
            const next = clamp(current.state.scale * (event.deltaY > 0 ? 1 / ratio : ratio));
            if (next === 1) void current.centerView(1, 0);
            else void current.zoomToPoint(next, event.clientX, event.clientY, 0);
        };
        node.addEventListener("wheel", wheel, { passive: false });
        return () => node.removeEventListener("wheel", wheel);
    }, []);
    return <TransformWrapper ref={transform} initialScale={1} minScale={1} maxScale={50} centerOnInit limitToBounds={false} disablePadding
        wheel={{ disabled: true }} doubleClick={{ disabled: true }} panning={{ velocityDisabled: true }} onTransform={(_, state) => setScale(state.scale)}>
        {({ zoomIn, zoomOut, centerView, zoomToPoint }) => <>
            <div className="flex flex-wrap items-center justify-center gap-1" aria-label="图片预览操作">
                <Button type="text" aria-label="缩小图片" title="缩小图片" disabled={scale <= 1} onClick={() => void zoomOut(scale / 3, 0)}><ZoomOut className="size-4" /></Button>
                <Button type="text" aria-label="放大图片" title="放大图片" disabled={scale >= 50} onClick={() => void zoomIn(scale * .5, 0)}><ZoomIn className="size-4" /></Button>
                <output aria-label="缩放比例" className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</output>
                <Button type="text" aria-label="向左旋转" title="向左旋转" onClick={() => setOrientation(value => ({ ...value, rotation: value.rotation - 90 }))}><RotateCcw className="size-4" /></Button>
                <Button type="text" aria-label="向右旋转" title="向右旋转" onClick={() => setOrientation(value => ({ ...value, rotation: value.rotation + 90 }))}><RotateCw className="size-4" /></Button>
                <Button type="text" aria-label="水平翻转" title="水平翻转" onClick={() => setOrientation(value => ({ ...value, x: -value.x }))}><FlipHorizontal className="size-4" /></Button>
                <Button type="text" aria-label="垂直翻转" title="垂直翻转" onClick={() => setOrientation(value => ({ ...value, y: -value.y }))}><FlipVertical className="size-4" /></Button>
            </div>
            <div ref={area} className="h-[65dvh] overflow-hidden rounded-lg" onDoubleClick={event => {
                event.preventDefault();
                if (transform.current?.state.scale !== 1) void centerView(1, 0);
                else void zoomToPoint(1.5, event.clientX, event.clientY, 0);
            }}>
                <TransformComponent wrapperStyle={{ width: "100%", height: "65dvh", touchAction: "none" }} contentStyle={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <img src={src} alt={alt} draggable={false} className="max-h-[65dvh] max-w-full object-contain" style={{ transform: `rotate(${orientation.rotation}deg) scale(${orientation.x},${orientation.y})` }} />
                </TransformComponent>
            </div>
        </>}
    </TransformWrapper>;
}
