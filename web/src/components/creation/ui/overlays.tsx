import * as React from "react";
import * as Ant from "antd";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover as UiPopover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { CreationImagePreview } from "./image-preview";
import { cn } from "@/lib/utils";
import { Button } from "./controls";
import { useCreationUi } from "./context";

function useFocusReturn(open: boolean) {
    const previous = React.useRef(false), target = React.useRef<HTMLElement | null>(null), fallback = React.useRef<HTMLElement | null>(null);
    if (open && !previous.current && typeof document !== "undefined") {
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const menuId = active?.closest("[role=menu]")?.id;
        const trigger = menuId ? document.querySelector(`[aria-controls="${CSS.escape(menuId)}"]`) : null;
        target.current = trigger instanceof HTMLElement ? trigger : active;
        fallback.current = target.current?.closest("aside")?.querySelector<HTMLElement>("button:not([disabled])") ?? null;
    }
    previous.current = open;
    return (event: Event) => { const node = target.current?.isConnected ? target.current : fallback.current?.isConnected ? fallback.current : null; if (node) { event.preventDefault(); node.focus(); } };
}

// Match Ant's dialog body: closing keeps the last open children through exit.
// Updating a preserve=false Form to an empty editor during that exit clears its store.
const ModalBody = React.memo(({ children }: React.PropsWithChildren<{ open: boolean }>) => <>{children}</>, (_, next) => !next.open);

export function Modal(props: Ant.ModalProps) {
    const owned = useCreationUi();
    const restoreFocus = useFocusReturn(owned && Boolean(props.open));
    if (!owned) return <Ant.Modal {...props} />;
    const cancel = () => props.onCancel?.({} as React.MouseEvent<HTMLButtonElement>);
    const cancelAllowed = props.keyboard !== false;
    const styles = typeof props.styles === "object" ? props.styles : undefined;
    return <Dialog open={Boolean(props.open)} onOpenChange={open => { if (!open) cancel(); }}><DialogContent data-canvas-shortcuts-ignore
        showCloseButton={props.closable !== false} aria-describedby={undefined} onOpenAutoFocus={() => props.afterOpenChange?.(true)} onCloseAutoFocus={event => { restoreFocus(event); props.afterClose?.(); props.afterOpenChange?.(false); }}
        className={cn("z-[1100] max-h-[90dvh] w-[calc(100%-24px)] overflow-y-auto", props.className)} style={{ maxWidth: typeof props.width === "number" || typeof props.width === "string" ? props.width : 520, ...props.style }}
        onEscapeKeyDown={event => { if (!cancelAllowed) event.preventDefault(); }} onPointerDownOutside={event => { if (props.maskClosable === false || typeof props.mask === "object" && props.mask.closable === false) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{props.title ?? "操作确认"}</DialogTitle></DialogHeader>
        <div className="min-w-0" style={styles?.body}><ModalBody open={Boolean(props.open)}>{props.children}</ModalBody></div>
        {props.footer === null ? null : <DialogFooter className="flex-wrap">{props.footer === undefined ? <><Button {...props.cancelButtonProps} onClick={cancel}>{props.cancelText ?? "取消"}</Button><Button type="primary" {...props.okButtonProps} loading={props.confirmLoading} onClick={props.onOk}>{props.okText ?? "确定"}</Button></> : typeof props.footer === "function" ? null : props.footer}</DialogFooter>}
    </DialogContent></Dialog>;
}

export function Drawer(props: Ant.DrawerProps) {
    const owned = useCreationUi();
    const restoreFocus = useFocusReturn(owned && Boolean(props.open));
    if (!owned) return <Ant.Drawer {...props} />;
    const close = () => props.onClose?.({} as React.MouseEvent<HTMLButtonElement>);
    return <Sheet open={Boolean(props.open)} onOpenChange={open => { if (!open) close(); }}><SheetContent data-canvas-shortcuts-ignore side={props.placement ?? "right"} aria-describedby={undefined} onCloseAutoFocus={restoreFocus}
        className={cn("z-[1100] flex max-h-[90dvh] flex-col gap-0", props.placement === "bottom" && "data-[side=bottom]:h-[82dvh] rounded-t-2xl", props.className)}
        onEscapeKeyDown={event => { if (props.keyboard === false) event.preventDefault(); }} onPointerDownOutside={event => { if (props.maskClosable === false) event.preventDefault(); }}>
        <SheetHeader className="shrink-0 border-b border-border"><SheetTitle>{props.title ?? "详情"}</SheetTitle>{props.extra}</SheetHeader>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">{props.children}</div>{props.footer ? <div className="border-t border-border p-4">{props.footer}</div> : null}
    </SheetContent></Sheet>;
}

export function Popover(props: React.ComponentProps<typeof Ant.Popover>) {
    const owned = useCreationUi(), [internal, setInternal] = React.useState(false);
    if (!owned) return <Ant.Popover {...props} />;
    const placement = props.placement ?? "top", open = props.open ?? internal;
    const change = (value: boolean) => { setInternal(value); props.onOpenChange?.(value); };
    const triggers = Array.isArray(props.trigger) ? props.trigger : [props.trigger ?? "hover"];
    const hover = triggers.includes("hover") || triggers.includes("focus");
    const side = placement.startsWith("bottom") ? "bottom" : placement.startsWith("left") ? "left" : placement.startsWith("right") ? "right" : "top";
    const align = placement.endsWith("Right") ? "end" : placement.endsWith("Left") ? "start" : "center";
    const content = <>{props.title ? <h2 className="mb-2 text-sm font-semibold">{typeof props.title === "function" ? props.title() : props.title}</h2> : null}{typeof props.content === "function" ? props.content() : props.content}</>;
    if (hover && props.open === undefined) return <HoverCard open={open} onOpenChange={change} openDelay={(props.mouseEnterDelay ?? .15) * 1000} closeDelay={(props.mouseLeaveDelay ?? .15) * 1000}>
        <HoverCardTrigger asChild>{props.children}</HoverCardTrigger><HoverCardContent data-canvas-shortcuts-ignore side={side} align={align} className="z-[1200] w-auto max-w-[calc(100vw-24px)]">{content}</HoverCardContent>
    </HoverCard>;
    return <UiPopover open={open} onOpenChange={change}>
        <PopoverTrigger asChild>{props.children}</PopoverTrigger><PopoverContent data-canvas-shortcuts-ignore
            side={side} align={align}
            className={cn("z-[1200] w-auto max-w-[calc(100vw-24px)]", props.className)} onOpenAutoFocus={event => { if (hover) event.preventDefault(); }}>
            {content}
        </PopoverContent>
    </UiPopover>;
}

export function Dropdown(props: Ant.DropdownProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Dropdown {...props} />;
    const placement = props.placement ?? "bottomLeft";
    return <DropdownMenu open={props.open} onOpenChange={open => props.onOpenChange?.(open, { source: "trigger" })}>
        <DropdownMenuTrigger asChild disabled={props.disabled}>{props.children}</DropdownMenuTrigger>
        <DropdownMenuContent data-canvas-shortcuts-ignore side={placement.startsWith("top") ? "top" : "bottom"} align={placement.endsWith("Right") ? "end" : "start"} className="z-[1300] max-w-[calc(100vw-24px)]">
            {props.menu?.items?.map((item, index) => {
                if (!item) return null;
                if (item.type === "divider") return <DropdownMenuSeparator key={index} />;
                if (item.type === "group" || "children" in item) return null;
                return <DropdownMenuItem key={item.key ?? index} disabled={item.disabled} variant={item.danger ? "destructive" : "default"} onSelect={event => {
                    const info = { key: String(item.key ?? index), keyPath: [String(item.key ?? index)], item: event.target as HTMLElement, domEvent: event as unknown as React.MouseEvent<HTMLElement> };
                    item.onClick?.(info); props.menu?.onClick?.(info);
                }}>{item.icon}{item.label}</DropdownMenuItem>;
            })}
        </DropdownMenuContent>
    </DropdownMenu>;
}

export function Image(props: React.ComponentProps<typeof Ant.Image>) {
    const owned = useCreationUi();
    const config = typeof props.preview === "object" ? props.preview : {};
    const [internalOpen, setInternalOpen] = React.useState(false), open = config.open ?? config.visible ?? internalOpen;
    const restoreFocus = useFocusReturn(owned && open);
    if (!owned) return <Ant.Image {...props} />;
    const image = <img src={props.src} alt={props.alt ?? "图片"} width={props.width} height={props.height} className={cn("max-w-full", props.className)} style={props.style} onLoad={props.onLoad} onError={props.onError} />;
    if (props.preview === false) return image;
    const preview = config.src ?? props.src;
    return <Dialog open={open} onOpenChange={next => { setInternalOpen(next); config.onOpenChange?.(next); config.onVisibleChange?.(next, open); }}><DialogTrigger asChild><button type="button" className="block w-full cursor-zoom-in" aria-label={`查看图片：${props.alt ?? "图片"}`}>{image}</button></DialogTrigger>
        <DialogContent data-canvas-shortcuts-ignore className="z-[1200]" style={{ maxWidth: "min(1100px,calc(100vw - 24px))" }} aria-describedby={undefined} onCloseAutoFocus={restoreFocus}>
            <DialogHeader><DialogTitle>{props.alt ?? "图片预览"}</DialogTitle></DialogHeader>
            <CreationImagePreview src={preview} alt={props.alt ?? "图片"} />
        </DialogContent>
    </Dialog>;
}

export function Collapse(props: Ant.CollapseProps) {
    const owned = useCreationUi();
    const toArray = (value: Ant.CollapseProps["activeKey"]) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String);
    const [value, setValue] = React.useState(() => toArray(props.defaultActiveKey));
    if (!owned) return <Ant.Collapse {...props} />;
    const activeKeys = props.activeKey === undefined ? value : toArray(props.activeKey);
    return <Accordion type="multiple" value={activeKeys} onValueChange={next => { setValue(next); props.onChange?.(next); }} className={props.className}>
        {props.items?.map((item, index) => <AccordionItem key={item.key ?? index} value={String(item.key ?? index)}><AccordionTrigger disabled={item.collapsible === "disabled"}>{item.label}</AccordionTrigger><AccordionContent forceMount={item.forceRender || undefined} className={item.forceRender && !activeKeys.includes(String(item.key ?? index)) ? "hidden" : undefined}>{item.children}</AccordionContent></AccordionItem>)}
    </Accordion>;
}
export function Tabs(props: Ant.TabsProps) {
    const owned = useCreationUi(), [value, setValue] = React.useState(props.defaultActiveKey ?? String(props.items?.[0]?.key ?? ""));
    if (!owned) return <Ant.Tabs {...props} />;
    return <UiTabs value={props.activeKey ?? value} onValueChange={next => { setValue(next); props.onChange?.(next); }} className={props.className}>
        <TabsList className="h-auto max-w-full flex-wrap">{props.items?.map(item => <TabsTrigger key={item.key} value={String(item.key)} disabled={item.disabled}>{item.label}</TabsTrigger>)}</TabsList>
        {props.items?.map(item => <TabsContent key={item.key} value={String(item.key)}>{item.children}</TabsContent>)}
    </UiTabs>;
}
export function Pagination(props: Ant.PaginationProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Pagination {...props} />;
    const page = props.current ?? 1, size = props.pageSize ?? 10, pages = Math.max(1, Math.ceil((props.total ?? 0) / size));
    return <nav aria-label="分页" className={cn("flex items-center justify-center gap-3", props.className)}><Button size="small" disabled={props.disabled || page <= 1} onClick={() => props.onChange?.(page - 1, size)}>上一页</Button><span className="text-xs text-muted-foreground">{page} / {pages}</span><Button size="small" disabled={props.disabled || page >= pages} onClick={() => props.onChange?.(page + 1, size)}>下一页</Button></nav>;
}
