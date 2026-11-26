import * as React from "react";
import { Form as AntForm, Progress as AntProgress, Radio as AntRadio, Tabs as AntTabs } from "antd";
import { RadioGroup } from "radix-ui";
import { useCreationUi } from "@/components/creation/ui/context";
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// Settings use Form only for labels and layout; the original controlled values
// and change handlers remain in the settings components.
function SettingsForm(props: React.ComponentProps<typeof AntForm>) {
    const owned = useCreationUi();
    return owned ? <div className={props.className}>{typeof props.children === "function" ? null : props.children}</div> : <AntForm {...props} />;
}

function SettingsField(props: React.ComponentProps<typeof AntForm.Item>) {
    const owned = useCreationUi(), id = React.useId();
    if (!owned) return <AntForm.Item {...props} />;
    const child = React.isValidElement<{ id?: string; "aria-describedby"?: string }>(props.children) ? props.children : null;
    const inputId = child?.props.id ?? id, descriptionId = `${id}-help`;
    return <div className={cn("min-w-0 space-y-1.5", props.className)}>
        {props.label ? <label htmlFor={inputId} className="block text-sm font-medium">{props.label}</label> : null}
        {child ? React.cloneElement(child, { id: inputId, ...(props.extra ? { "aria-describedby": descriptionId } : {}) }) : typeof props.children === "function" ? null : props.children}
        {props.extra ? <div id={descriptionId} className="text-xs leading-5 text-muted-foreground">{props.extra}</div> : null}
    </div>;
}
export const Form = Object.assign(SettingsForm, { Item: SettingsField });

// Like Ant's default panes, settings mount on their first visit and retain local
// request/loading state while hidden, so tab switches cannot enable duplicates.
export function Tabs(props: React.ComponentProps<typeof AntTabs>) {
    const owned = useCreationUi();
    const [value, setValue] = React.useState(props.defaultActiveKey ?? String(props.items?.[0]?.key ?? ""));
    const active = props.activeKey ?? value;
    const [visited, setVisited] = React.useState(() => new Set([active]));
    React.useEffect(() => { setVisited(current => current.has(active) ? current : new Set(current).add(active)); }, [active]);
    if (!owned) return <AntTabs {...props} />;
    return <UiTabs value={active} onValueChange={next => { setValue(next); props.onChange?.(next); }} className={props.className}>
        <TabsList variant="line" className="!h-auto w-full flex-wrap justify-start border-b border-border pb-1">{props.items?.map(item => <TabsTrigger key={item.key} value={String(item.key)} disabled={item.disabled} className="h-10 flex-none px-4">{item.label}</TabsTrigger>)}</TabsList>
        {props.items?.filter(item => item.forceRender || item.key === active || visited.has(item.key)).map(item => <TabsContent key={item.key} value={String(item.key)} forceMount hidden={item.key !== active} className={item.key !== active ? "hidden" : undefined}>{item.children}</TabsContent>)}
    </UiTabs>;
}

export function Progress(props: React.ComponentProps<typeof AntProgress>) {
    const owned = useCreationUi();
    if (!owned) return <AntProgress {...props} />;
    const percent = Math.max(0, Math.min(100, props.percent ?? 0));
    return <div className={cn("flex items-center gap-2", props.className)} role="progressbar" aria-label="进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full bg-primary transition-[width]", props.status === "exception" && "bg-destructive", props.status === "active" && "animate-pulse")} style={{ width: `${percent}%` }} /></div>
        {props.showInfo !== false ? <span className="text-xs text-muted-foreground">{Math.round(percent)}%</span> : null}
    </div>;
}

function SettingsRadio(props: React.ComponentProps<typeof AntRadio>) {
    const owned = useCreationUi();
    if (!owned) return <AntRadio {...props} />;
    return <label className={cn("flex min-w-0 cursor-pointer items-start gap-2 text-sm", props.disabled && "cursor-not-allowed opacity-50", props.className)}>
        <RadioGroup.Item value={String(props.value)} disabled={props.disabled} className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-input bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none">
            <RadioGroup.Indicator className="size-2 rounded-full bg-primary" />
        </RadioGroup.Item><span className="min-w-0">{props.children}</span>
    </label>;
}

function SettingsRadioGroup(props: React.ComponentProps<typeof AntRadio.Group>) {
    const owned = useCreationUi();
    if (!owned) return <AntRadio.Group {...props} />;
    return <RadioGroup.Root id={props.id} name={props.name} value={String(props.value ?? "")} disabled={props.disabled} onValueChange={value => props.onChange?.({ target: { value } } as Parameters<NonNullable<typeof props.onChange>>[0])} className={props.className} aria-label="重新生成方式">{props.children}</RadioGroup.Root>;
}
export const Radio = Object.assign(SettingsRadio, { Group: SettingsRadioGroup });
