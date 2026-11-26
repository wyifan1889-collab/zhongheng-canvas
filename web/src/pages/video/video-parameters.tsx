import { Button, Select } from "@/components/creation/ui";
import type { VideoParameters } from "../../../../packages/shared/src/generation-video";
import { videoMappingChoiceKey, type VideoMappingModel } from "@/services/saas/mapped-video-generation";
import { selectedVideoMapping } from "./mapped-video-settings";

export type VideoDraftParameters = { source: "platform-video"; modelId: string; mappingModelId?: string; specification?: string; parameters: VideoParameters | null; legacy?: Record<string, string> };
export const emptyVideoParameters = (): VideoDraftParameters => ({ source: "platform-video", modelId: "", parameters: null });
export const describeVideoParameters = (value: VideoParameters) => `${value.mode === "text" ? "文生" : "单张首帧"} · ${value.resolution} · ${value.durationSeconds}秒 · ${value.generateAudio ? "带声音" : "无声音"}${value.aspectRatio ? ` · ${value.aspectRatio}` : ""}`;
export function VideoParametersForm({ value, models, onChange, onReload, disabled = false, loading = false }: {
    value: VideoDraftParameters; models: VideoMappingModel[]; onChange: (value: VideoDraftParameters) => void; onReload: () => void; disabled?: boolean; loading?: boolean;
}) {
    const model = models.find(item => item.id === value.mappingModelId), selected = selectedVideoMapping(models, value);
    const choices = model?.combinations.filter(item => item.specification === value.specification) ?? [];
    return <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-2 text-sm"><span>{model?.displayName || "请先选择视频模型"}</span><Button type="text" size="small" disabled={disabled || loading} onClick={onReload}>更新模型列表</Button></div>
        {loading ? <p role="status" className="text-sm text-muted-foreground">正在读取平台模型…</p> : null}
        {model ? <div className="space-y-2"><span className="text-sm">清晰度</span><div role="group" aria-label="视频清晰度" className="flex flex-wrap gap-1">{model.specifications.map(spec =>
            <Button key={spec} type={value.specification === spec ? "primary" : "text"} aria-pressed={value.specification === spec}
                disabled={disabled || loading || !model.combinations.some(item => item.available && item.specification === spec)}
                onClick={() => onChange({ ...value, specification: spec, modelId: "", parameters: null })}>{spec}</Button>)}</div><p className="text-xs text-muted-foreground">灰色规格暂未开放</p></div> : null}
        {value.specification && model ? <label className="block space-y-2 text-sm"><span>模式、时长与声音</span><Select className="w-full" aria-label="视频完整规格" value={selected ? videoMappingChoiceKey(selected) : undefined}
            placeholder="选择完整视频规格" disabled={disabled || loading} options={choices.map(item => ({ value: videoMappingChoiceKey(item), disabled: !item.available, label: describeVideoParameters(item.execution.parameters) }))}
            onChange={key => { const item = choices.find(item => videoMappingChoiceKey(item) === key); if (item?.available) onChange({ ...value, modelId: item.nodeModelId, parameters: { ...item.execution.parameters } }); }} /></label> : null}
        <p className="text-xs text-muted-foreground">每次生成1条视频；文生不使用参考图，首帧模式仅支持1张本人图片。尾帧、多图、音视频参考、编辑延长和水印暂未开放。</p>
    </div>;
}
