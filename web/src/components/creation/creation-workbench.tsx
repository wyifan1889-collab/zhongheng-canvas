import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Info, Plus, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { CreationKind } from "./creation-mode-tabs";

/** The home route owns the real shortcut actions and account-scoped configuration. */
export const CreationLandingContext = createContext<{ heading: ReactNode; shortcuts: ReactNode } | null>(null);

export function CreationToolbar({ mode, model, parameters, estimate, action }: {
    mode: ReactNode; model: ReactNode; parameters: ReactNode; estimate: ReactNode; action: ReactNode;
}) {
    return <div data-creation-toolbar className="mt-auto grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_44px] items-center gap-2 pt-3 sm:flex">
        <div className="contents">
            <div className="col-span-4 min-w-0 sm:shrink-0">{mode}</div>
            <div className="min-w-0 sm:max-w-64 sm:flex-1 [&>*]:max-w-full [&>button]:px-2 sm:[&>button]:px-3">{model}</div>
        </div>
        <div className="min-w-0 max-w-24 sm:max-w-72 [&>*]:max-w-full">{parameters}</div>
        <div className="min-w-0 max-w-24 whitespace-nowrap text-xs text-muted-foreground sm:ml-auto sm:max-w-32">{estimate}</div>
        <div className="size-11 shrink-0 [&>button]:size-11 [&>button]:min-w-11 [&>button]:rounded-full [&>button]:p-0">{action}</div>
    </div>;
}

export function CreationToolsMenu({ items, disabled }: { items: { key: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean }[]; disabled?: boolean }) {
    const trigger = useRef<HTMLButtonElement>(null);
    const [boundary, setBoundary] = useState<Element | null>(null);
    useLayoutEffect(() => { setBoundary(trigger.current?.closest("[data-creation-workbench]") ?? null); }, []);
    return <DropdownMenu><DropdownMenuTrigger asChild><Button ref={trigger} type="button" variant="ghost" size="icon" disabled={disabled} aria-label="添加与工具" className="size-9 rounded-full"><Plus className="size-5" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" collisionBoundary={boundary ?? undefined} collisionPadding={12} className="z-[1300] w-44" data-canvas-shortcuts-ignore>
            {items.map(item => <DropdownMenuItem key={item.key} disabled={item.disabled} onSelect={item.onSelect}>{item.icon}{item.label}</DropdownMenuItem>)}
        </DropdownMenuContent>
    </DropdownMenu>;
}

/** One visible help line; the same text remains reachable by touch and keyboard. */
export function CreationHint({ children, summary, id }: { children: ReactNode; summary?: ReactNode; id?: string }) {
    return <Popover><PopoverTrigger asChild><button id={id} type="button" className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs leading-5 text-muted-foreground" aria-label={summary ? undefined : "查看完整说明"}>
        {!summary ? <Info className="size-3.5 shrink-0" /> : null}<span className="truncate">{summary ?? children}</span>
    </button></PopoverTrigger><PopoverContent side="top" align="start" className="z-[1300] max-w-[calc(100vw-24px)] text-xs leading-5" data-canvas-shortcuts-ignore>{children}</PopoverContent></Popover>;
}

const frame = "mx-auto w-[calc(100%_-_2rem)] max-w-[1076px] lg:w-[calc(100%_-_9rem)]";

export function CreationWorkbench({ kind, hasContent, composer, children }: {
    kind: CreationKind; hasContent: boolean; composer: ReactNode; children?: ReactNode;
}) {
    const landing = useContext(CreationLandingContext);
    return <main aria-label="创作工作台" data-creation-workbench={kind} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
        <div data-creation-stage style={{ minHeight: hasContent ? "min(9rem, 40%)" : 0 }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className={`${frame} space-y-4 py-4 md:py-6`}>
                {landing?.heading}
                {hasContent ? children : landing?.shortcuts}
            </div>
        </div>
        <div data-creation-dock style={{ maxHeight: hasContent ? "calc(100% - min(9rem, 40%))" : "100%" }} className={`${frame} thin-scrollbar min-h-0 shrink-0 overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:pb-6`}>
            {composer}
        </div>
    </main>;
}

/** Real parameter values remain controlled by their original workbench owner. */
export function CreationParameters({ label, summary, children, open, onOpenChange, disabled, presentation = "anchored" }: {
    label: string; summary: ReactNode; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean; presentation?: "anchored" | "image" | "centered";
}) {
    const trigger = useRef<HTMLSpanElement>(null);
    const [localOpen, setLocalOpen] = useState(false), [dockWidth, setDockWidth] = useState<number>();
    const [boundary, setBoundary] = useState<Element | null>(null);
    const visible = open ?? localOpen;
    const change = (next: boolean) => { if (open === undefined) setLocalOpen(next); onOpenChange?.(next); };
    useLayoutEffect(() => {
        const dock = trigger.current?.closest("[data-creation-dock]");
        if (!dock) return;
        setBoundary(dock.closest("[data-creation-workbench]"));
        const resize = () => setDockWidth(dock.getBoundingClientRect().width);
        resize();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(resize); observer.observe(dock);
        return () => observer.disconnect();
    }, []);
    if (presentation === "centered") return <Dialog open={visible} onOpenChange={change}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={label} className="h-10 max-w-full gap-1.5 rounded-full"><SlidersHorizontal className="hidden size-3.5 shrink-0 sm:block" /><span className="truncate">{summary}</span></Button></DialogTrigger>
        <DialogContent data-canvas-shortcuts-ignore className="z-[1200] max-h-[80dvh] w-[calc(100vw-32px)] overflow-y-auto sm:max-w-[544px]" aria-describedby={undefined}>
            <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>{children}
        </DialogContent>
    </Dialog>;
    return <Popover modal open={visible} onOpenChange={change}>
        <span ref={trigger} className="inline-flex min-w-0 max-w-full">
            <PopoverTrigger asChild><Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={label} className="h-10 max-w-full gap-1.5 rounded-full">
                <SlidersHorizontal className="hidden size-3.5 shrink-0 sm:block" /><span className="sm:hidden">参数</span><span className="hidden truncate sm:inline">{summary}</span>
            </Button></PopoverTrigger>
        </span>
        <PopoverContent side="top" align={presentation === "image" && (dockWidth ?? 544) < 400 ? "start" : "end"} sideOffset={presentation === "image" ? 10 : 8} collisionBoundary={boundary ?? undefined} collisionPadding={presentation === "image" ? 16 : 12} aria-label={label}
            style={{ width: Math.min(presentation === "image" ? 340 : 544, dockWidth ?? 544), maxWidth: presentation === "image" ? "calc(100vw - 49px)" : "calc(100vw - 24px)", maxHeight: presentation === "image" ? "min(374px, 70dvh, var(--radix-popover-content-available-height))" : "min(70dvh, var(--radix-popover-content-available-height))" }}
            className="z-[1200] gap-3 overflow-y-auto overscroll-contain rounded-2xl border border-border p-4">
            <div className="flex items-center justify-between gap-2"><h2 className="font-medium">{label}</h2><Button type="button" variant="ghost" size="icon-sm" aria-label={`关闭${label}`} onClick={() => change(false)}><X className="size-4" /></Button></div>
            {children}
        </PopoverContent>
    </Popover>;
}
