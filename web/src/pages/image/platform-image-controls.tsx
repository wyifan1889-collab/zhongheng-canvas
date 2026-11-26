import { useState } from "react";
import { Check, ChevronsUpDown, RefreshCw } from "lucide-react";
import { ModelBrandIcon } from "@/components/model-brand-icon";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WorkspaceFeedback } from "@/components/creation/workspace-feedback";
import { resolveModelBrand } from "@/lib/model-brand";
import { imageMappingAspectRatio, imageMappingQuality } from "@/services/saas/mapped-image-generation";
import type { PersonalMediaParameters } from "@/stores/use-creation-media-launch";
import { chooseWorkbenchImageParameters, selectedImageMapping, type WorkbenchImageModel } from "./mapped-image-settings";
import type { usePlatformImageWorkbench } from "./use-platform-image-workbench";

function ModelLabel({ model }: { model: WorkbenchImageModel }) {
    return <span className="flex min-w-0 items-center gap-2"><ModelBrandIcon model={model.id} label={model.displayName} brand={model.group} />
        <span className="truncate">{model.displayName}</span></span>;
}

export function PlatformImageModelPicker({ models, value, loading, disabled, onChange }: {
    models: WorkbenchImageModel[]; value: string; loading: boolean; disabled: boolean; onChange: (model: WorkbenchImageModel) => void;
}) {
    const [open, setOpen] = useState(false);
    const selected = models.find(model => model.id === value);
    const groups = new Map<string, WorkbenchImageModel[]>();
    for (const model of models) {
        const group = model.group || resolveModelBrand(model.id, model.displayName)?.name || "其他模型";
        const items = groups.get(group) ?? [];
        items.push(model);
        groups.set(group, items);
    }
    return <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild><Button type="button" role="combobox" aria-label="平台图片模型" aria-haspopup="listbox" variant="outline"
            disabled={loading || disabled} className="w-full min-w-0 justify-between overflow-hidden font-normal">
            {selected ? <ModelLabel model={selected} /> : <span className="truncate">{loading ? "正在读取模型…" : "选择图片模型"}</span>}
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button></PopoverTrigger>
        <PopoverContent align="start" side="top" sideOffset={10} className="z-[1300] w-[340px] max-w-[calc(100vw-32px)] p-0" data-canvas-shortcuts-ignore>
            <Command><CommandInput aria-label="搜索平台图片模型" placeholder="搜索模型或分组" />
                <CommandList><CommandEmpty>暂无匹配的图片模型</CommandEmpty>
                    {[...groups].map(([group, items]) => <CommandGroup key={group} heading={group}>
                        {items.map(model => <CommandItem key={model.id} value={model.id} keywords={[model.displayName, group, resolveModelBrand(model.id, model.displayName, group)?.name ?? ""]}
                            disabled={!model.combinations.some(choice => choice.available)} onSelect={() => { onChange(model); setOpen(false); }}>
                            <ModelLabel model={model} />
                            {model.id === value ? <Check className="ml-auto size-4 shrink-0" /> : null}
                        </CommandItem>)}
                    </CommandGroup>)}
                </CommandList>
            </Command>
        </PopoverContent>
    </Popover>;
}

function ParameterChoices({ label, values, value, disabled, onChange }: {
    label: string; values: { value: string; label?: string }[]; value?: string; disabled: boolean; onChange: (next: string) => void;
}) {
    return <div className="space-y-1.5">
        <p className="text-xs font-medium">{label}</p>
        <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
            {values.map(option => <Button key={option.value} type="button" size="sm" variant={value === option.value ? "default" : "outline"}
                aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label ?? option.value}</Button>)}
        </div>
    </div>;
}

export function PlatformImageSettings({ platform, parameters, onChange }: {
    platform: ReturnType<typeof usePlatformImageWorkbench>; parameters: PersonalMediaParameters; onChange: (parameters: PersonalMediaParameters) => void;
}) {
    const model = platform.mappingModels.find(item => item.id === parameters.mappingModelId);
    const choice = selectedImageMapping(platform.mappingModels, parameters);
    const disabled = platform.loading || platform.busy;
    const available = model?.combinations.filter(item => item.available) ?? [];
    const spec = choice?.specification;
    const ratio = choice ? imageMappingAspectRatio(choice) : undefined;
    const quality = imageMappingQuality(choice);
    const ratios = [...new Set(available.filter(item => item.specification === spec).map(imageMappingAspectRatio))];
    const qualities = [...new Set(available.filter(item => item.specification === spec && imageMappingAspectRatio(item) === ratio).map(item => item.execution.parameters.quality))];
    const choose = (filter: Parameters<typeof chooseWorkbenchImageParameters>[1]) => {
        if (model) onChange(chooseWorkbenchImageParameters(model, filter, parameters.count));
    };
    return <div className="min-w-0 space-y-3">
        {platform.loading ? <WorkspaceFeedback state="loading">正在读取平台模型</WorkspaceFeedback> : null}
        {!platform.loading && !model ? <WorkspaceFeedback state="empty">请先选择图片模型</WorkspaceFeedback> : null}
        {model ? <>
            <ParameterChoices label="清晰度" value={spec} disabled={disabled} values={model.specifications.filter(value => available.some(item => item.specification === value)).map(value => ({ value }))}
                onChange={specification => choose({ specification, quality,
                    aspectRatio: available.some(item => item.specification === specification && imageMappingAspectRatio(item) === ratio) ? ratio : undefined })} />
            <ParameterChoices label="比例" value={ratio} disabled={disabled} values={ratios.map(value => ({ value }))}
                onChange={aspectRatio => choose({ specification: spec, aspectRatio, quality })} />
            {qualities.length > 1 ? <ParameterChoices label="画质" value={quality} disabled={disabled}
                values={qualities.map(value => ({ value, label: { low: "低", medium: "标准", high: "高" }[value] }))}
                onChange={quality => choose({ specification: spec, aspectRatio: ratio, quality })} /> : null}
            <ParameterChoices label="张数" value={parameters.count ?? "1"} disabled={disabled || !choice}
                values={Array.from({ length: choice?.maxImages ?? 1 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 张` }))}
                onChange={count => onChange({ ...parameters, count })} />
        </> : null}
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => void platform.retryInitialization()}><RefreshCw />更新模型列表</Button>
    </div>;
}
