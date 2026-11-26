import type { CSSProperties, ReactNode } from "react";
import { Inbox, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export const workspaceAction = "h-auto min-h-11 whitespace-normal px-3 text-center";

export function WorkspaceHeading({ id, title, description, action }: {
    id: string; title: ReactNode; description?: ReactNode; action?: ReactNode;
}) {
    return <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border pb-4">
        <div className="min-w-0 flex-[1_1_12rem] space-y-1">
            <h1 id={id} className="break-words text-2xl font-semibold">{title}</h1>
            {description ? <p className="text-sm leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {action}
    </header>;
}

export function WorkspaceFeedback({ state, children, description, action, compact, style }: {
    state: "loading" | "empty" | "error"; children: ReactNode; description?: ReactNode; action?: ReactNode;
    compact?: boolean; style?: CSSProperties;
}) {
    const Icon = state === "loading" ? Loader2 : state === "empty" ? Inbox : TriangleAlert;
    return <div className={cn("flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border",
        state === "empty" && "border-dashed", compact ? "w-full px-2 py-1.5 text-xs" : "bg-muted/30 px-4 py-3 text-sm text-muted-foreground")}
        style={style}>
        <div role={state === "error" ? "alert" : "status"} className="flex min-w-0 flex-[1_1_12rem] items-start gap-2.5">
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", state === "loading" && "animate-spin motion-reduce:animate-none")} />
            <div className="min-w-0 break-words">
                <p className={!compact && state !== "loading" ? "font-medium text-foreground" : undefined}>{children}</p>
                {description ? <p className="mt-1 text-xs leading-5">{description}</p> : null}
            </div>
        </div>
        {action}
    </div>;
}
