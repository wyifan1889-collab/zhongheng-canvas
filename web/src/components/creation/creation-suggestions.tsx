import { useMemo, type ReactNode, type RefObject } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

/** Keep the editor caret while Radix follows its real container outside the dock. */
export function CreationSuggestions({ anchorRef, children, onClose }: {
    anchorRef: RefObject<HTMLElement | null>;
    children: ReactNode;
    onClose: () => void;
}) {
    const virtualRef = useMemo(() => ({ current: {
        get contextElement() { return anchorRef.current ?? undefined; },
        getBoundingClientRect: () => anchorRef.current?.getBoundingClientRect() ?? new DOMRect(),
    } }), [anchorRef]);
    return <Popover open onOpenChange={open => { if (!open) onClose(); }}>
        <PopoverAnchor virtualRef={virtualRef} />
        <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="创作候选"
            className="z-[1250] min-h-0 w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-24px)] gap-0 overflow-hidden rounded-xl bg-transparent p-0 shadow-none ring-0"
            style={{ maxHeight: "min(21rem,52vh,var(--radix-popover-content-available-height))" }}
            onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
            onInteractOutside={event => { if (event.target instanceof Node && anchorRef.current?.contains(event.target)) event.preventDefault(); }}>
            {children}
        </PopoverContent>
    </Popover>;
}
