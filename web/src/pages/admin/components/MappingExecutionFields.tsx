import { Alert, AutoComplete, Form, Input, InputNumber, Select } from "antd";
import { imageSizePresets } from "@/lib/media-size";
import { parseMappingExecution, type MappingBinding, type MappingCapability } from "../model-mapping-plan";
import { GEMINI_IMAGE_PROTOCOL, geminiImageOptions, parseGeminiImageSpecification } from "../../../../../packages/shared/src/generation-gemini-image";

export type ExecutionInput = { protocol: string; size: string; quality: string; mode: string; resolution: string; duration: string; audio: string; aspectRatio: string; maxImagesPerRequest?: string; responseFormat?: string };
export function executionInput(binding?: MappingBinding): ExecutionInput {
    const result = { protocol: "", size: "", quality: "", mode: "", resolution: "", duration: "", audio: "", aspectRatio: "" };
    const execution = binding?.execution;
    if (execution?.protocol === "openai-image-v1") return { ...result, protocol: execution.protocol, ...execution.parameters,
        ...(execution.responseFormat === undefined ? {} : { responseFormat: execution.responseFormat }),
        ...(execution.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: String(execution.maxImagesPerRequest) }) };
    if (execution?.protocol === GEMINI_IMAGE_PROTOCOL) return { ...result, protocol: execution.protocol, aspectRatio: execution.parameters.aspectRatio };
    if (execution) return { ...result, protocol: execution.protocol, ...execution.parameters, duration: String(execution.parameters.durationSeconds), audio: String(execution.parameters.generateAudio), aspectRatio: execution.parameters.aspectRatio ?? "" };
    return result;
}
export function executionFromInput(value: ExecutionInput, capability: MappingCapability, specification: string, providerModel?: string) {
    if (!value.protocol) return undefined;
    if (value.protocol === GEMINI_IMAGE_PROTOCOL) {
        const parameters = parseGeminiImageSpecification(providerModel, { aspectRatio: value.aspectRatio, imageSize: specification });
        return parameters ? parseMappingExecution({ protocol: value.protocol, parameters }, capability, specification) : null;
    }
    return parseMappingExecution({ protocol: value.protocol,
        ...(capability === "image" && value.maxImagesPerRequest ? { maxImagesPerRequest: Number(value.maxImagesPerRequest) } : {}),
        ...(capability === "image" && value.responseFormat ? { responseFormat: value.responseFormat } : {}),
        parameters: capability === "image" ? { size: value.size.trim(), quality: value.quality } : {
        mode: value.mode, resolution: value.resolution, durationSeconds: /^[1-9]\d*$/.test(value.duration) ? Number(value.duration) : null,
        generateAudio: value.audio === "true" ? true : value.audio === "false" ? false : null,
        ...(value.mode === "text" ? { aspectRatio: value.aspectRatio } : {}),
    } }, capability, specification);
}

export default function MappingExecutionFields({ capability, specification, providerModel, value, onChange }: { capability: MappingCapability; specification: string; providerModel?: string; value: ExecutionInput; onChange: (value: ExecutionInput) => void }) {
    const native = providerModel ? geminiImageOptions(providerModel) : null;
    const patch = (key: keyof ExecutionInput, item: string) => onChange({ ...value, [key]: item });
    const select = (key: keyof ExecutionInput, label: string, options: { value: string; label: string }[]) => <Form.Item label={label}><Select aria-label={label} value={value[key] || undefined} placeholder="请选择" options={options} onChange={item => patch(key, item)} /></Form.Item>;
    return <>
        <Form.Item label="调用协议"><Select aria-label="组合调用协议" value={value.protocol} onChange={protocol => onChange({ ...executionInput(), protocol })} options={[
            { value: "", label: "暂未核实，仅保留展示规格" },
            capability === "image" ? { value: "openai-image-v1", label: "OpenAI 兼容图片（PNG）" } : { value: "yunfei-grok-video-v1", label: "Grok 视频协议" },
            ...(capability === "image" && native ? [{ value: GEMINI_IMAGE_PROTOCOL, label: "Gemini 原生图片（按交付张数）" }] : []),
        ]} /></Form.Item>
        {value.protocol === GEMINI_IMAGE_PROTOCOL ? <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <Form.Item label="原生档位" validateStatus={native?.imageSize.some(size => size === specification) ? undefined : "error"}
                help={native?.imageSize.some(size => size === specification) ? undefined : "请选择该型号支持的清晰度"}><Input readOnly value={specification} /></Form.Item>
            {select("aspectRatio", "原生图片比例", (native?.aspectRatio ?? []).map(value => ({ value, label: value })))}
        </div> : value.protocol && (capability === "image" ? <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <Form.Item label="实际尺寸（像素）"><AutoComplete className="w-full" aria-label="实际图片尺寸" placeholder="例如 1024x1024" value={value.size}
                options={Object.entries(imageSizePresets[specification.toLowerCase()] ?? {}).map(([ratio, size]) => ({ value: size, label: `${ratio} · ${size}` }))}
                onChange={size => patch("size", size)} /></Form.Item>
            {select("quality", "图片画质", [{ value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" }])}
            <Form.Item label="渠道单次张数上限"><InputNumber className="!w-full" aria-label="渠道单次张数上限" min={1} max={10} precision={0}
                placeholder="未核实" value={value.maxImagesPerRequest ? Number(value.maxImagesPerRequest) : null}
                onChange={count => patch("maxImagesPerRequest", count === null ? "" : String(count))} /></Form.Item>
            <Form.Item label="图片返回方式"><Select aria-label="图片返回方式" value={value.responseFormat ?? ""}
                options={[{ value: "", label: "接口默认" }, { value: "b64_json", label: "Base64" }]}
                onChange={format => patch("responseFormat", format)} /></Form.Item>
        </div> : <>
            <Alert className="!mb-4" type="info" showIcon title="仅适用于已核实的 Grok 视频接口；其他视频型号请保留待核实。" />
            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                {select("mode", "视频模式", [{ value: "text", label: "文生视频" }, { value: "first_frame", label: "首帧生视频" }])}
                {select("resolution", "实际视频分辨率", ["480p", "720p", "1080p"].map(item => ({ value: item, label: item.toUpperCase() })))}
                <Form.Item label="视频时长（秒）"><Input aria-label="视频时长" inputMode="numeric" placeholder="现有协议支持 1–15 秒" value={value.duration} onChange={event => patch("duration", event.target.value)} /></Form.Item>
                {select("audio", "视频声音", [{ value: "true", label: "有声" }, { value: "false", label: "无声" }])}
                {value.mode === "text" && select("aspectRatio", "视频比例", ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].map(item => ({ value: item, label: item })))}
            </div>
        </>)}
    </>;
}
