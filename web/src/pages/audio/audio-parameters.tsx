import { useId, type ReactNode } from "react";
import { RadioGroup } from "radix-ui";
import { Input, InputNumber, Select, Switch, Typography } from "@/components/creation/ui";
import { CreationHint } from "@/components/creation/creation-workbench";

export type AudioParameters = {
    prompt: string;
    model: string;
    voice: string;
    style: string;
    language: string;
    format: "mp3" | "wav";
    seconds?: number;
    loop: boolean;
    instrumental: boolean;
};

export type AudioModelOption = { value: string; label: string; disabled?: boolean };
type AudioModelParameters = { voices: readonly string[]; formats: readonly AudioParameters["format"][] };

export const audioVoiceLabel = (voice: string) => voice === "default" ? "默认音色" : voice;

/** A deliberate model selection adapts unsupported defaults, preserving the user's text and instructions. */
export function selectAudioModelParameters(value: AudioParameters, audio: AudioModelParameters): AudioParameters {
    return { ...value, format: audio.formats.includes(value.format) ? value.format : audio.formats[0] ?? value.format,
        voice: audio.voices.includes(value.voice) ? value.voice : audio.voices.length === 1 && audio.voices[0] === "default" ? "default" : "" };
}

export const DEFAULT_AUDIO_PARAMETERS: AudioParameters = {
    prompt: "",
    model: "",
    voice: "",
    style: "",
    language: "",
    format: "mp3",
    seconds: undefined,
    loop: false,
    instrumental: false,
};

type AudioParametersFormProps = {
    value: AudioParameters;
    onChange: (value: AudioParameters) => void;
    modelOptions: AudioModelOption[];
    voiceOptions?: string[];
    formatOptions?: readonly AudioParameters["format"][];
    loading?: boolean;
    disabled?: boolean;
    instructionsDisabled?: boolean;
    instructionsNote?: string;
    hidePrompt?: boolean;
    promptFooter?: ReactNode;
    variant?: "default" | "creation" | "music";
};

export function AudioParametersForm({ value, onChange, modelOptions, voiceOptions = [], formatOptions = ["mp3", "wav"], loading = false, disabled = false, instructionsDisabled = false, instructionsNote = "语音风格和语言提示是否生效，以所选模型支持情况为准。", hidePrompt = false, promptFooter, variant = "default" }: AudioParametersFormProps) {
    const id = useId();
    const update = <K extends keyof AudioParameters>(key: K, next: AudioParameters[K]) => onChange({ ...value, [key]: next });
    const labelClassName = variant === "music" ? "mb-1.5 block text-xs font-medium text-muted-foreground" : "mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base";

    if (variant === "creation") {
        const segmentClassName = "min-h-9 min-w-0 rounded-lg border border-border px-2 py-1.5 text-sm break-words transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";
        return <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            {!hidePrompt ? <div className="min-w-0 sm:col-span-2">
                <label className={labelClassName} htmlFor={`${id}-prompt`}>朗读文本</label>
                <Input.TextArea id={`${id}-prompt`} value={value.prompt} onChange={event => update("prompt", event.target.value)} rows={7} placeholder="输入需要转换为语音的文字" disabled={disabled} />
                {promptFooter ? <div className="mt-3 flex flex-wrap items-center gap-2">{promptFooter}</div> : null}
            </div> : null}
            <div className="min-w-0 sm:col-span-2">
                <span id={`${id}-voice-label`} className={labelClassName}>音色</span>
                {voiceOptions.length > 0 && voiceOptions.length <= 4 ? <RadioGroup.Root value={value.voice} onValueChange={next => update("voice", next)} disabled={disabled}
                    aria-labelledby={`${id}-voice-label`} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {voiceOptions.map(voice => <RadioGroup.Item key={voice} value={voice} className={segmentClassName} style={value.voice === voice ? { color: "var(--primary-foreground)" } : undefined}>{audioVoiceLabel(voice)}</RadioGroup.Item>)}
                </RadioGroup.Root> : <Select<string> id={`${id}-voice`} aria-label="音色" className="w-full" value={value.voice || undefined}
                    onChange={next => update("voice", next)} showSearch={{ optionFilterProp: "label" }} options={voiceOptions.map(voice => ({ value: voice, label: audioVoiceLabel(voice) }))}
                    placeholder="选择音色" disabled={disabled || !voiceOptions.length} />}
            </div>
            <div className="min-w-0 sm:col-span-2">
                <span id={`${id}-format-label`} className={labelClassName}>输出格式</span>
                <RadioGroup.Root value={value.format} onValueChange={next => update("format", next as AudioParameters["format"])} disabled={disabled || !formatOptions.length}
                    aria-labelledby={`${id}-format-label`} className="grid grid-cols-2 gap-1.5">
                    {formatOptions.map(format => <RadioGroup.Item key={format} value={format} className={segmentClassName} style={value.format === format ? { color: "var(--primary-foreground)" } : undefined}>{format.toUpperCase()}</RadioGroup.Item>)}
                </RadioGroup.Root>
            </div>
            <label className="block min-w-0" htmlFor={`${id}-style`}>
                <span className={labelClassName}>语音风格（可选）</span>
                <Input id={`${id}-style`} value={value.style} onChange={event => update("style", event.target.value)} placeholder="例如：平静、自然" disabled={disabled || instructionsDisabled} aria-describedby={`${id}-instructions`} />
            </label>
            <label className="block min-w-0" htmlFor={`${id}-language`}>
                <span className={labelClassName}>语言（可选）</span>
                <Input id={`${id}-language`} value={value.language} onChange={event => update("language", event.target.value)} placeholder="例如：普通话" disabled={disabled || instructionsDisabled} aria-describedby={`${id}-instructions`} />
            </label>
            <fieldset className="min-w-0 space-y-3 sm:col-span-2" disabled aria-describedby={`${id}-instructions`}>
                <legend className={labelClassName}>音乐参数（暂不可用）</legend>
                <label className="block min-w-0" htmlFor={`${id}-seconds`}><span className="mb-1.5 block text-sm">时长（秒）</span>
                    <InputNumber<number> id={`${id}-seconds`} className="w-full" value={value.seconds ?? null} placeholder="未设置" disabled controls={false} />
                </label>
                <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center justify-between gap-2"><label className="text-sm" htmlFor={`${id}-loop`}>循环播放</label><Switch id={`${id}-loop`} checked={value.loop} disabled /></div>
                    <div className="flex items-center justify-between gap-2"><label className="text-sm" htmlFor={`${id}-instrumental`}>纯音乐</label><Switch id={`${id}-instrumental`} checked={value.instrumental} disabled /></div>
                </div>
            </fieldset>
            <div id={`${id}-instructions`} className="min-w-0 sm:col-span-2"><CreationHint>{instructionsNote} 音乐生成尚未接入；文字转语音不支持准确时长、循环或纯音乐。</CreationHint></div>
        </div>;
    }

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block min-w-0 sm:col-span-2" htmlFor={`${id}-model`}>
                <span className={labelClassName}>音频模型</span>
                <Select<string>
                    id={`${id}-model`}
                    className="w-full"
                    value={value.model || undefined}
                    options={modelOptions}
                    loading={loading}
                    disabled={disabled || loading}
                    showSearch={{ optionFilterProp: "label" }}
                    placeholder={loading ? "正在加载平台音频模型" : "选择平台音频模型"}
                    notFoundContent={loading ? "正在加载" : "暂无可用平台音频模型"}
                    onChange={(next) => update("model", next)}
                />
            </label>
            {!hidePrompt ? <div className="block min-w-0 sm:col-span-2">
                <label className={labelClassName} htmlFor={`${id}-prompt`}>朗读文本</label>
                <Input.TextArea id={`${id}-prompt`} value={value.prompt} onChange={(event) => update("prompt", event.target.value)} rows={6} placeholder="输入要朗读的正文，语气和节奏请在朗读风格中设置…" disabled={disabled} />
                {promptFooter ? <div className="mt-3 flex flex-wrap items-center gap-2">{promptFooter}</div> : null}
            </div> : null}
            <label className="block min-w-0" htmlFor={`${id}-language`}>
                <span className={labelClassName}>朗读语言（可选）</span>
                <Input id={`${id}-language`} value={value.language} onChange={(event) => update("language", event.target.value)} placeholder="例如：普通话" disabled={disabled || instructionsDisabled} aria-describedby={`${id}-instructions`} />
            </label>
            <label className="block min-w-0" htmlFor={`${id}-voice`}>
                <span className={labelClassName}>音色</span>
                <Select<string> id={`${id}-voice`} className="w-full" value={value.voice || undefined} onChange={(next) => update("voice", next)} options={voiceOptions.map(voice => ({ value: voice, label: audioVoiceLabel(voice) }))} placeholder="选择音色" disabled={disabled || !voiceOptions.length} />
            </label>
            <label className="block min-w-0 sm:col-span-2" htmlFor={`${id}-style`}>
                <span className={labelClassName}>语音风格（可选）</span>
                <Input.TextArea id={`${id}-style`} rows={2} value={value.style} onChange={(event) => update("style", event.target.value)} placeholder="例如：温柔亲切，语速放慢，句间稍作停顿" disabled={disabled || instructionsDisabled} aria-describedby={`${id}-instructions`} />
            </label>
            <label className="block min-w-0 sm:col-span-2" htmlFor={`${id}-format`}>
                <span className={labelClassName}>输出格式</span>
                <Select<AudioParameters["format"]> id={`${id}-format`} className="w-full" value={value.format} onChange={(next) => update("format", next)} options={formatOptions.map(format => ({ value: format, label: format.toUpperCase() }))} disabled={disabled || !formatOptions.length} />
            </label>
            {variant === "music" ? <div id={`${id}-instructions`} className="min-w-0 sm:col-span-2"><CreationHint>{instructionsNote}；生成的是 AI 合成语音，确认正式费用后才提交；记录保存在当前浏览器账号下，音频保存在平台私有素材中；音乐生成尚未开放，文字转语音不支持准确时长、循环或纯音乐。</CreationHint></div>
                : <Typography.Text id={`${id}-instructions`} type="secondary" className="text-xs sm:col-span-2">{instructionsNote}</Typography.Text>}
            <details className="min-w-0 text-xs text-muted-foreground sm:col-span-2"><summary className="cursor-pointer">音乐参数（暂不可用）</summary>
            <fieldset className="min-w-0 space-y-3 sm:col-span-2" disabled aria-describedby={`${id}-${variant === "music" ? "instructions" : "music-note"}`}>
                <legend className="sr-only">未接入的音乐参数</legend>
                {variant !== "music" && <Typography.Text id={`${id}-music-note`} type="secondary" className="block text-xs">音乐生成功能尚未接入；文字转语音不支持指定准确时长。</Typography.Text>}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block min-w-0 sm:col-span-2" htmlFor={`${id}-seconds`}>
                        <span className="mb-1.5 block text-sm">时长（秒）</span>
                        <InputNumber<number> id={`${id}-seconds`} className="w-full" value={value.seconds ?? null} placeholder="未设置" disabled controls={false} />
                    </label>
                    <div className="flex items-center justify-between gap-3">
                        <label className="text-sm" htmlFor={`${id}-loop`}>循环播放</label>
                        <Switch id={`${id}-loop`} checked={value.loop} disabled />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <label className="text-sm" htmlFor={`${id}-instrumental`}>纯音乐</label>
                        <Switch id={`${id}-instrumental`} checked={value.instrumental} disabled />
                    </div>
                </div>
            </fieldset>
            </details>
        </div>
    );
}
