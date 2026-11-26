import * as React from "react";
import * as Ant from "antd";
import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreationUi } from "./context";
import { creationMessage } from "./app";

export * from "./controls";
export * from "./overlays";
export { App, CreationUiBoundary } from "./app";
export { useCreationUi, isCreationUiRoute } from "./context";

export function Badge(props: React.ComponentProps<typeof Ant.Badge>) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Badge {...props} />;
    const { count, children, showZero, overflowCount, color, dot, offset, size, status, text, className, style, ...native } = props;
    return <span {...native} className={cn("relative inline-flex", className)} style={style}>{children}{count || showZero ? <span className="pointer-events-none absolute -right-1 -top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground" aria-hidden>{count}</span> : null}</span>;
}

function Text(props: React.ComponentProps<typeof Ant.Typography.Text>) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Typography.Text {...props} />;
    return <span id={props.id} className={cn(props.type === "secondary" && "text-muted-foreground", props.type === "danger" && "text-destructive", props.strong && "font-semibold", props.className)} style={props.style}>{props.children}</span>;
}
function Paragraph(props: React.ComponentProps<typeof Ant.Typography.Paragraph>) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Typography.Paragraph {...props} />;
    const copy = props.copyable;
    return <div className={cn("mb-3 text-sm", props.type === "secondary" && "text-muted-foreground", props.strong && "font-semibold", props.className)} style={props.style}>{props.children}{copy ? <button type="button" aria-label="复制" className="ml-2 inline-flex rounded p-1 text-muted-foreground hover:bg-accent" onClick={async () => {
        const value = typeof copy === "object" && typeof copy.text === "string" ? copy.text : typeof props.children === "string" ? props.children : "";
        try { await navigator.clipboard.writeText(value); creationMessage.success("已复制。"); } catch { creationMessage.error("复制未完成，请手动复制。"); }
    }}><Copy className="size-3.5" /></button> : null}</div>;
}
export const Typography = { Text, Paragraph };
