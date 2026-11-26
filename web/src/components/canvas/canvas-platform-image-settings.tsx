import { useId, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Segmented, Select, Tooltip } from "antd";
import { Cpu, RefreshCw } from "lucide-react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAccountStore } from "@/stores/use-account-store";
import { chooseImageMapping, createMappedImageGenerationClient, imageMappingAspectRatio, imageMappingChoiceKey, imageMappingQuality, selectedImageMapping, type ImageMappingModel, type ImageMappingSelection } from "@/services/saas/mapped-image-generation";
import { AspectIcon, ImageSettingsTheme } from "@/components/image-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { mediaRatioOptions, parseAspectRatio } from "@/lib/media-size";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { ModelBrandIcon } from "@/components/model-brand-icon";
import { WorkspaceFeedback } from "@/components/creation/workspace-feedback";
import { cn } from "@/lib/utils";
import { resolveModelBrand } from "@/lib/model-brand";
import { validImageGenerationCount } from "../../../../packages/shared/src/model-price-publications";

type FieldsProps = { models: ImageMappingModel[]; selection?: ImageMappingSelection; onChange: (selection: ImageMappingSelection) => void; loading?: boolean; disabled?: boolean };
type ImageModelOption = { value: string; label: ReactNode; search: string; specs: string; disabled: boolean };
type ImageModelGroup = { label: string; options: ImageModelOption[] };

function modelOptions(models: ImageMappingModel[], other: string): ImageModelGroup[] {
    const groups = new Map<string, ImageModelOption[]>();
    for (const { id, displayName, group, combinations, specifications } of models) {
        const available = new Set(combinations.filter(item => item.available).map(item => item.specification));
        const specs = specifications.filter(value => available.has(value)).join(" · ");
        const brand = resolveModelBrand(id, displayName, group)?.name ?? "";
        const options = groups.get(group) ?? [];
        options.push({ value: id, search: `${displayName} ${id} ${group} ${brand} ${specs}`, specs, disabled: !available.size,
            label: <span className="flex min-w-0 items-center gap-2"><ModelBrandIcon model={id} label={displayName} brand={group} />
                <span className="min-w-0 truncate" title={displayName}>{displayName}</span></span> });
        groups.set(group, options);
    }
    return Array.from(groups, ([group, options]) => ({ label: group || other, options }));
}

export function ImageMappingFields({ models, selection = {}, onChange, loading, disabled }: FieldsProps) {
    const { t } = useTranslation();
    const id = useId();
    const model = models.find(item => item.id === selection.modelId);
    const combinations = model?.combinations.filter(item => item.specification === selection.specification) ?? [];
    const otherModels = t("canvasImageSettings.otherModels");
    const groups = useMemo(() => modelOptions(models, otherModels), [models, otherModels]);
    return <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2"><label htmlFor={`${id}-model`} className="mb-1 block text-xs">图片模型</label>
            <Select id={`${id}-model`} aria-label="图片模型" className="w-full" showSearch={{ optionFilterProp: "search" }}
                placeholder="选择模型" value={model?.id} loading={loading} disabled={disabled || loading || !models.length} options={groups}
                onChange={modelId => onChange({ modelId })} /></div>
        <div className="min-w-0"><label htmlFor={`${id}-specification`} className="mb-1 block text-xs">清晰度</label>
            <Select id={`${id}-specification`} aria-label="清晰度" className="w-full" placeholder="选择清晰度" value={model ? selection.specification : undefined}
                disabled={disabled || loading || !model} options={model?.specifications.map(value => ({ value,
                    label: value, disabled: !model.combinations.some(item => item.specification === value && item.available) }))}
                onChange={specification => onChange({ modelId: selection.modelId, specification })} /></div>
        <div className="min-w-0"><label htmlFor={`${id}-combination`} className="mb-1 block text-xs">尺寸与画质</label>
            <Select id={`${id}-combination`} aria-label="尺寸与画质" className="w-full" placeholder="选择尺寸与画质"
                value={combinations.some(item => imageMappingChoiceKey(item) === selection.combination) ? selection.combination : undefined}
                disabled={disabled || loading || !combinations.length} options={combinations.map(item => ({ value: imageMappingChoiceKey(item), disabled: !item.available,
                    label: item.execution.protocol === "openai-image-v1" ? `${item.execution.parameters.size.replace("x", " × ")} · ${{ low: "低", medium: "标准", high: "高" }[item.execution.parameters.quality]}画质`
                        : `${item.execution.parameters.aspectRatio} · ${item.execution.parameters.imageSize}` }))}
                onChange={combination => onChange({ ...selection, combination })} /></div>
    </div>;
}

export function CanvasPlatformImageSettings({ selection, onChange, config, onCountChange, onOpenChange, onReadyChange }: {
    selection?: ImageMappingSelection; onChange: FieldsProps["onChange"]; config: AiConfig; onCountChange: (count: number) => void;
    onOpenChange?: (open: boolean) => void; onReadyChange: (ready: boolean) => void;
}) {
    const { t } = useTranslation();
    const { id: projectId = "" } = useParams<{ id: string }>();
    const account = useAccountStore(), scope = account.getDraftScope();
    const [models, setModels] = useState<ImageMappingModel[]>([]), [loading, setLoading] = useState(true), [readFailed, setReadFailed] = useState(false);
    const [revision, setRevision] = useState(0);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    useLayoutEffect(() => {
        let active = true;
        setModels([]); setLoading(true); setReadFailed(false);
        if (!scope || !projectId || !account.site?.cloudMedia) { setLoading(false); return; }
        const captured = { ...scope, projectId }, route = window.location.pathname;
        const getScope = () => {
            const current = useAccountStore.getState(), next = current.getDraftScope();
            return active && current.site?.cloudMedia && next?.accountId === captured.accountId && next.epoch === captured.epoch
                && window.location.pathname === route ? captured : null;
        };
        const client = createMappedImageGenerationClient({ scope: captured, getScope });
        void client.mappedModels().then(items => {
            if (getScope()) setModels(items);
        }).catch(() => { if (getScope()) setReadFailed(true); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [scope?.accountId, scope?.epoch, projectId, account.site?.cloudMedia, revision]);
    const chosen = selectedImageMapping(models, selection);
    const native = chosen?.execution.protocol === "gemini-generate-content-v1";
    useLayoutEffect(() => { onReadyChange(!!chosen && !loading && !readFailed && validImageGenerationCount(Number(config.count)) && (native || Number(config.count) <= (chosen.maxImages ?? 1)) && !config.background.trim() && !config.systemPrompt.trim()); },
        [chosen, loading, readFailed, native, config.count, config.background, config.systemPrompt, onReadyChange]);
    const model = models.find(item => item.id === selection?.modelId), ratio = chosen ? imageMappingAspectRatio(chosen) : undefined;
    const otherModels = t("canvasImageSettings.otherModels");
    const groups = useMemo(() => modelOptions(models, otherModels), [models, otherModels]);
    const modelAvailable = !!model?.combinations.some(item => item.available);
    const selectionUnavailable = !!selection?.modelId && (!modelAvailable || !!selection.combination && !chosen);
    const message = loading ? null : readFailed ? t("canvasImageSettings.loadFailed") : selectionUnavailable ? t("canvasImageSettings.selectionChanged")
        : groups.every(group => group.options.every(option => option.disabled)) ? t("canvasImageSettings.empty") : null;
    const combinations = model?.combinations.filter(item => item.specification === selection?.specification) ?? [];
    const ratios = [...new Set(combinations.map(imageMappingAspectRatio))];
    const quality = imageMappingQuality(chosen);
    const qualities = [...new Set(combinations.filter(item => imageMappingAspectRatio(item) === ratio).flatMap(item => imageMappingQuality(item) ? [imageMappingQuality(item)!] : []))];
    const ratioOptions = [...mediaRatioOptions.filter(item => item.value !== "auto" && (!native || ratios.includes(item.value))), ...ratios.filter(value => !mediaRatioOptions.some(item => item.value === value))
        .map(value => ({ value, ...parseAspectRatio(value)! }))];
    const change = (filter: Parameters<typeof chooseImageMapping>[1]) => { if (model) onChange(chooseImageMapping(model, filter)); };
    const panel = <ImageSettingsTheme theme={theme}><div className="space-y-3" role="group" aria-label={t("canvasImageSettings.panel")}>
        <div className="space-y-1.5"><div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvasImageSettings.resolution")}</div>
            <Segmented aria-label={t("canvasImageSettings.resolution")} block value={selection?.specification} options={model?.specifications.map(value => ({ value, label: value,
                disabled: !model.combinations.some(item => item.specification === value && item.available) })) ?? []}
                onChange={specification => {
                    const sameRatio = model?.combinations.some(item => item.available && item.specification === specification && imageMappingAspectRatio(item) === ratio);
                    change({ specification, ...(sameRatio ? { aspectRatio: ratio } : {}), quality });
                }} />
        </div>
        <div className="space-y-1.5"><div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvasImageSettings.ratio")}</div>
            <div role="group" aria-label={t("canvasImageSettings.ratioGroup")} className="grid grid-cols-4 gap-1.5">
                {ratioOptions.map(item => {
                    const available = combinations.some(choice => choice.available && imageMappingAspectRatio(choice) === item.value);
                    const selected = ratio === item.value;
                    return <button key={item.value} type="button" aria-label={t("canvasImageSettings.ratioChoice", { ratio: item.value })} aria-pressed={selected} disabled={!available}
                        className={cn("flex h-12 min-w-0 cursor-pointer flex-col items-center justify-center rounded-md border text-xs hover:border-current focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40",
                            selected && "font-semibold")}
                        style={{ background: selected ? theme.toolbar.activeBg : undefined, borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                        onClick={() => change({ specification: selection?.specification, aspectRatio: item.value, quality })}>
                        <AspectIcon width={item.width} height={item.height} color={theme.node.text} /><span>{item.value}</span>
                    </button>;
                })}
            </div>
        </div>
        {qualities.length > 1 ? <div className="space-y-1.5"><div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("settingsPanels.image.quality")}</div>
            <Segmented aria-label={t("canvasImageSettings.qualityGroup")} block value={quality} options={qualities.map(value => ({ value, label: t(`settingsPanels.common.${value}`),
                disabled: !combinations.some(item => item.available && imageMappingAspectRatio(item) === ratio && imageMappingQuality(item) === value) }))}
                onChange={quality => change({ specification: selection?.specification, aspectRatio: ratio, quality })} />
        </div> : null}
        {native ? <p className="text-xs" style={{ color: theme.node.muted }}>{t("canvasImageSettings.byDelivery")}</p> : <div className="space-y-1.5"><div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("settingsPanels.image.count")}</div>
            <div role="group" aria-label={t("canvasImageSettings.countGroup")} className="grid grid-cols-5 gap-1.5">
                {Array.from({ length: chosen?.maxImages ?? 1 }, (_, index) => index + 1).map(count => {
                    const selected = Number(config.count) === count;
                    return <button key={count} type="button" aria-label={t("canvasImageSettings.countChoice", { count })} aria-pressed={selected}
                        className={cn("h-9 cursor-pointer rounded-md border text-xs focus-visible:outline-2 focus-visible:outline-offset-1", selected && "font-semibold")}
                        style={{ background: selected ? theme.toolbar.activeBg : undefined, borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                        onClick={() => onCountChange(count)}>{count}</button>;
                })}
            </div>
            {Number(config.count) > (chosen?.maxImages ?? 1) ? <p role="status" className="text-xs">{t("canvasImageSettings.countInvalid", { count: config.count })}</p> : null}
        </div>}
    </div></ImageSettingsTheme>;
    return <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="canvas-platform-image-settings">
        <Select<string, ImageModelOption | ImageModelGroup> aria-label={t("canvasImageSettings.model")} className="canvas-platform-model-picker w-[190px] max-w-full" variant="outlined" prefix={!model ? <Cpu className="size-4 shrink-0 opacity-70" /> : undefined}
            placement="topLeft" listHeight={208} listItemHeight={44}
            popupMatchSelectWidth={320} styles={{ popup: { root: { maxWidth: "calc(100vw - 24px)" } } }}
            popupAlign={{ overflow: { adjustX: true, adjustY: true, shiftX: true }, htmlRegion: "visible" }}
            style={{ height: 40, borderRadius: 999 }} showSearch={{ optionFilterProp: "search" }}
            placeholder={selectionUnavailable && !loading ? t("canvasImageSettings.selectedUnavailable") : t("settingsPanels.model.select")} value={model?.id}
            loading={loading} disabled={loading || !models.length}
            options={groups} notFoundContent={t("canvasImageSettings.noMatch")}
            optionRender={({ data }) => "options" in data ? data.label : <div className="space-y-0.5 overflow-hidden py-0.5">{data.label}
                <span className="block truncate pl-6 text-xs text-muted-foreground">{data.disabled ? t("canvasImageSettings.unavailable") : data.specs}</span></div>}
            onChange={modelId => { const next = models.find(item => item.id === modelId && item.combinations.some(choice => choice.available)); if (next) onChange(chooseImageMapping(next)); }} />
        <CanvasImageSettingsPopover config={config} summary={`${selection?.specification ?? t("canvasImageSettings.resolution")} · ${ratio ?? t("canvasImageSettings.ratio")}${native ? "" : ` · ${t("canvas.controls.images", { count: config.count })}`}`}
            settingsPanel={panel} disabled={loading || !modelAvailable} onOpenChange={onOpenChange} placement="topLeft"
            buttonClassName="!h-10 !max-w-[190px] !justify-start !rounded-full !px-3" />
        {chosen ? <span className="text-xs" style={{ color: theme.node.muted }}>{t("canvasImageSettings.perImage", { credits: chosen.credits })}</span> : null}
        <Tooltip title={t("canvasImageSettings.reload")}><Button type="text" size="small" aria-label={t("canvasImageSettings.reload")} icon={<RefreshCw className="size-3.5" />}
            className="!h-10 !w-10 shrink-0" loading={loading} onClick={() => setRevision(value => value + 1)} /></Tooltip>
        {loading || message ? <WorkspaceFeedback compact state={loading ? "loading" : readFailed || selectionUnavailable ? "error" : "empty"}
            style={{ color: theme.node.muted, borderColor: theme.node.stroke }}>{loading ? t("creationWorkspace.loadingModels") : message}</WorkspaceFeedback> : null}
    </div>;
}
