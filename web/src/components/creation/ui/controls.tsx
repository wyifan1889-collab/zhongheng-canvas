import * as React from "react";
import * as Ant from "antd";
import type { ButtonProps, CheckboxProps, InputNumberProps, InputProps, SwitchProps, TooltipProps } from "antd";
import type { TextAreaProps } from "antd/es/input/TextArea";
import { Check, ChevronsUpDown, LoaderCircle, X } from "lucide-react";
import { Slider as SliderPrimitive } from "radix-ui";
import { Button as UiButton } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch as UiSwitch } from "@/components/ui/switch";
import { Checkbox as UiCheckbox } from "@/components/ui/checkbox";
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Alert as UiAlert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover as UiPopover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useCreationUi } from "./context";

// This adapter preserves the existing business component contracts. Its default
// branch is the original component; only CreationUiContext opts into shadcn.
export function Button({ children, icon, loading, type, size, shape, danger, block, htmlType, ...props }: ButtonProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Button {...props} {...{ icon, loading, type, size, shape, danger, block, htmlType }}>{children}</Ant.Button>;
    return <UiButton {...props} type={htmlType ?? "button"} disabled={props.disabled || Boolean(loading)}
        variant={danger ? "destructive" : type === "primary" ? "default" : type === "link" ? "link" : type === "text" ? "ghost" : "outline"}
        size={size === "small" ? "sm" : size === "large" ? "lg" : "default"}
        className={cn(block && "w-full", shape === "circle" && "size-9 rounded-full p-0", props.className)} aria-busy={Boolean(loading) || undefined}>
        {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}{children}
    </UiButton>;
}

type CreationInputProps = Omit<React.ComponentPropsWithoutRef<"input">, "size" | "prefix"> & Pick<InputProps, "prefix" | "suffix" | "allowClear" | "onPressEnter" | "size" | "status" | "variant"> & { showCount?: boolean };
function TextInput({ prefix, suffix, allowClear, onPressEnter, size, status, variant, className, showCount, ...props }: CreationInputProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Input {...props} {...{ prefix, suffix, allowClear, onPressEnter, size, status, variant, className, showCount }} />;
    const input = <UiInput {...props} aria-invalid={status === "error" || props["aria-invalid"]} className={cn((prefix || suffix || allowClear) && "border-0 bg-transparent shadow-none focus-visible:ring-0", className)} onKeyDown={event => {
        props.onKeyDown?.(event);
        if (event.key === "Enter" && !event.nativeEvent.isComposing) onPressEnter?.(event);
    }} />;
    return prefix || suffix || allowClear || showCount ? <span className={cn("flex min-w-0 items-center gap-2 rounded-lg border border-input px-2 focus-within:ring-2 focus-within:ring-ring/50", className)}>{prefix}{input}{suffix}{showCount ? <span className="shrink-0 text-xs text-muted-foreground">{String(props.value ?? "").length}{props.maxLength ? `/${props.maxLength}` : ""}</span> : null}
        {allowClear && props.value && !props.disabled && !props.readOnly ? <button type="button" aria-label="清空输入" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => props.onChange?.({ target: { value: "" }, currentTarget: { value: "" } } as React.ChangeEvent<HTMLInputElement>)}><X className="size-3.5" /></button> : null}
    </span> : input;
}

type CreationTextAreaProps = Omit<React.ComponentPropsWithoutRef<"textarea">, "onResize"> & Pick<TextAreaProps, "autoSize" | "onPressEnter">;
function TextArea({ autoSize, onPressEnter, className, ...props }: CreationTextAreaProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Input.TextArea {...props} {...{ autoSize, onPressEnter, className }} />;
    const rows = typeof autoSize === "object" ? autoSize : null;
    return <Textarea {...props} className={cn("min-h-20", className)} style={{ ...props.style, ...(autoSize ? { fieldSizing: "content", minHeight: `${(rows?.minRows ?? 2) * 1.5 + 1}rem`, maxHeight: rows?.maxRows ? `${rows.maxRows * 1.5 + 1}rem` : undefined } : {}) }} onKeyDown={event => {
        props.onKeyDown?.(event);
        if (event.key === "Enter" && !event.nativeEvent.isComposing) onPressEnter?.(event);
    }} />;
}

function PasswordInput(props: CreationInputProps) {
    const owned = useCreationUi(), [visible, setVisible] = React.useState(false);
    if (!owned) return <Ant.Input.Password {...props} />;
    return <TextInput {...props} type={visible ? "text" : "password"} suffix={<button type="button" className="shrink-0 text-xs text-muted-foreground" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? "隐藏" : "显示"}</button>} />;
}
export const Input = Object.assign(TextInput, { TextArea, Password: PasswordInput });

type CreationSliderProps = Pick<React.ComponentProps<typeof Ant.Slider>, "id" | "className" | "style" | "min" | "max" | "step" | "disabled"> & React.AriaAttributes & {
    value?: number; defaultValue?: number; onChange?: (value: number) => void;
};
/** The video duration remains a controlled number; unmigrated/canvas callers keep Ant. */
export function Slider({ value, defaultValue, onChange, ...props }: CreationSliderProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Slider {...props} value={value} defaultValue={defaultValue} onChange={onChange} />;
    return <SliderPrimitive.Root {...props} step={props.step ?? undefined} value={value === undefined ? undefined : [value]}
        defaultValue={defaultValue === undefined ? undefined : [defaultValue]} onValueChange={values => onChange?.(values[0])}
        className={cn("relative flex h-8 min-w-0 touch-none items-center select-none data-disabled:opacity-50", props.className)}>
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted"><SliderPrimitive.Range className="absolute h-full bg-primary" /></SliderPrimitive.Track>
        <SliderPrimitive.Thumb aria-label={props["aria-label"] ?? "视频时长"} className="block size-4 rounded-full border border-primary bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none" />
    </SliderPrimitive.Root>;
}

export function InputNumber<T extends number = number>({ onChange, controls, precision, ...props }: InputNumberProps<T>) {
    const owned = useCreationUi();
    if (!owned) return <Ant.InputNumber<T> {...props} {...{ onChange, controls, precision }} />;
    return <UiInput id={props.id} type="number" className={props.className} style={props.style} value={props.value ?? ""} min={props.min} max={props.max} step={props.step} disabled={props.disabled} placeholder={props.placeholder} aria-label={props["aria-label"]} onChange={event => onChange?.((Number.isFinite(event.currentTarget.valueAsNumber) ? event.currentTarget.valueAsNumber : null) as T | null)} />;
}

type CreationSwitchProps = Pick<SwitchProps, "id" | "size" | "className" | "style" | "title" | "checked" | "defaultChecked" | "disabled" | "autoFocus" | "onChange" | "loading"> & React.AriaAttributes;
export function Switch({ size, onChange, loading, ...props }: CreationSwitchProps) {
    const owned = useCreationUi();
    return owned ? <span className="relative inline-flex"><UiSwitch {...props} disabled={props.disabled || loading} aria-busy={loading || undefined} onCheckedChange={value => onChange?.(value, {} as React.MouseEvent<HTMLButtonElement>)} />{loading ? <LoaderCircle className="pointer-events-none absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 animate-spin" aria-hidden /> : null}</span> : <Ant.Switch {...props} {...{ size, onChange, loading }} />;
}
type CreationCheckboxProps = Pick<CheckboxProps, "id" | "name" | "className" | "style" | "children" | "title" | "checked" | "defaultChecked" | "disabled" | "required" | "autoFocus" | "onChange" | "onClick" | "onKeyDown" | "indeterminate"> & React.AriaAttributes;
export function Checkbox({ children, onChange, indeterminate, ...props }: CreationCheckboxProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Checkbox {...props} {...{ onChange, indeterminate }}>{children}</Ant.Checkbox>;
    const control = <UiCheckbox {...props} checked={indeterminate ? "indeterminate" : props.checked} onCheckedChange={value => onChange?.({ target: { ...props, checked: value === true }, stopPropagation() {}, preventDefault() {}, nativeEvent: {} } as Parameters<NonNullable<CheckboxProps["onChange"]>>[0])} />;
    return children ? <label className="inline-flex items-center gap-2 text-sm">{control}{children}</label> : control;
}

export function Tooltip(props: TooltipProps) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Tooltip {...props} />;
    if (!props.title) return props.children;
    const placement = props.placement ?? "top";
    const title = typeof props.title === "function" ? props.title() : props.title;
    return <TooltipProvider delayDuration={350}><UiTooltip open={props.open} onOpenChange={props.onOpenChange}>
        <TooltipTrigger asChild>{props.children}</TooltipTrigger><TooltipContent side={placement.startsWith("bottom") ? "bottom" : placement.startsWith("left") ? "left" : placement.startsWith("right") ? "right" : "top"} className="z-[1300] max-w-80 text-pretty">{title}</TooltipContent>
    </UiTooltip></TooltipProvider>;
}

export function Alert(props: React.ComponentProps<typeof Ant.Alert>) {
    const owned = useCreationUi();
    if (!owned) return <Ant.Alert {...props} />;
    return <UiAlert className={props.className} variant={props.type === "error" ? "destructive" : "default"} role={props.type === "error" || props.type === "warning" ? "alert" : "status"}>
        <AlertTitle>{props.title ?? props.message}</AlertTitle>{props.description ? <AlertDescription>{props.description}</AlertDescription> : null}{props.action ? <div className="mt-2">{props.action}</div> : null}
    </UiAlert>;
}
function TagLabel(props: React.ComponentProps<typeof Ant.Tag>) {
    const owned = useCreationUi();
    return owned ? <UiBadge variant={props.color === "red" ? "destructive" : "secondary"} className={props.className} style={props.style}>{props.children}</UiBadge> : <Ant.Tag {...props} />;
}
function CheckableTag(props: React.ComponentProps<typeof Ant.Tag.CheckableTag>) {
    const owned = useCreationUi();
    return owned ? <UiButton type="button" size="sm" variant={props.checked ? "default" : "outline"} className={cn("h-7 px-2 text-xs", props.className)} aria-pressed={props.checked} onClick={() => props.onChange?.(!props.checked)}>{props.children}</UiButton> : <Ant.Tag.CheckableTag {...props} />;
}
export const Tag = Object.assign(TagLabel, { CheckableTag });
export function Spin(props: React.ComponentProps<typeof Ant.Spin>) {
    const owned = useCreationUi();
    return owned ? <span role="status" aria-label="正在加载" className={cn("inline-flex items-center gap-2 text-muted-foreground", props.className)}><LoaderCircle className={cn("animate-spin", props.size === "small" ? "size-4" : "size-5")} aria-hidden />{props.tip}</span> : <Ant.Spin {...props} />;
}
function EmptyState(props: React.ComponentProps<typeof Ant.Empty>) {
    const owned = useCreationUi();
    return owned ? <div className={cn("px-3 py-8 text-center text-sm text-muted-foreground", props.className)} style={props.style}>{props.description ?? "暂无内容"}{props.children}</div> : <Ant.Empty {...props} />;
}
export const Empty = Object.assign(EmptyState, { PRESENTED_IMAGE_SIMPLE: Ant.Empty.PRESENTED_IMAGE_SIMPLE });

type CreationSelectProps<T extends string | number> = Pick<Ant.SelectProps<T>, "id" | "aria-label" | "aria-describedby" | "className" | "style" | "value" | "options" | "disabled" | "loading" | "placeholder" | "notFoundContent" | "onChange" | "showSearch" | "size" | "variant" | "open" | "defaultOpen" | "onOpenChange" | "onSearch" | "searchValue" | "status"> & { popupPresentation?: "image" };

export function Select<T extends string | number = string>(props: CreationSelectProps<T>) {
    const owned = useCreationUi();
    const [query, setQuery] = React.useState("");
    const [internalOpen, setInternalOpen] = React.useState(props.defaultOpen ?? false);
    if (!owned) { const { popupPresentation: _presentation, ...defaultProps } = props; return <Ant.Select<T> {...defaultProps} />; }
    const options = props.options ?? [], selected = options.find(option => option.value === props.value);
    const optionKey = (option: (typeof options)[number]) => JSON.stringify([typeof option.value, option.value]);
    const changeOpen = (open: boolean) => { setInternalOpen(open); props.onOpenChange?.(open); if (!open) { setQuery(""); props.onSearch?.(""); } };
    const choose = (key: string) => { const option = options.find(item => optionKey(item) === key); if (option && !option.disabled) props.onChange?.(option.value as T, option); };
    const triggerProps = { id: props.id, disabled: props.disabled || props.loading, "aria-label": props["aria-label"], "aria-describedby": props["aria-describedby"], "aria-invalid": props.status === "error", className: cn("min-w-0 w-full", props.className), style: props.style };
    if (props.showSearch) return <UiPopover open={props.open ?? internalOpen} onOpenChange={changeOpen}>
        <PopoverTrigger asChild><UiButton {...triggerProps} role="combobox" variant="outline" className={cn("justify-between overflow-hidden font-normal", triggerProps.className)} aria-haspopup="listbox"><span className="min-w-0 truncate">{selected?.label ?? props.placeholder}</span><ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" /></UiButton></PopoverTrigger>
        <PopoverContent align="start" side={props.popupPresentation === "image" ? "top" : undefined} sideOffset={props.popupPresentation === "image" ? 10 : undefined} className={cn("z-[1300] min-w-48 p-0", props.popupPresentation === "image" ? "w-[340px] max-w-[calc(100vw-49px)]" : "w-(--radix-popover-trigger-width) max-w-[calc(100vw-24px)]")} data-canvas-shortcuts-ignore>
            <Command><CommandInput aria-label={typeof props["aria-label"] === "string" ? `搜索${props["aria-label"]}` : "搜索模型"} placeholder="搜索模型" value={props.searchValue ?? query} onValueChange={value => { setQuery(value); props.onSearch?.(value); }} />
                <CommandList><CommandEmpty>{props.notFoundContent ?? "暂无可用选项"}</CommandEmpty><CommandGroup>
                    {options.map(option => <CommandItem key={optionKey(option)} value={optionKey(option)} keywords={[String(option.label ?? ""), String(option.value)]} disabled={option.disabled} onSelect={key => { choose(key); changeOpen(false); }}>
                        {option.label ?? String(option.value)}{option.value === props.value ? <Check className="ml-auto size-4" /> : null}
                    </CommandItem>)}
                </CommandGroup></CommandList>
            </Command>
        </PopoverContent>
    </UiPopover>;
    return <UiSelect value={selected ? optionKey(selected) : ""} open={props.open ?? internalOpen} disabled={props.disabled || props.loading} onValueChange={choose} onOpenChange={changeOpen}>
        <SelectTrigger {...triggerProps}><SelectValue placeholder={props.placeholder} /></SelectTrigger>
        <SelectContent position="popper" className="z-[1300] max-w-[calc(100vw-24px)]">
            {options.map(option => <SelectItem key={optionKey(option)} value={optionKey(option)} disabled={option.disabled}>{option.label ?? String(option.value)}</SelectItem>)}
            {!options.length ? <p className="p-2 text-xs text-muted-foreground">{props.notFoundContent ?? "暂无可用选项"}</p> : null}
        </SelectContent>
    </UiSelect>;
}
