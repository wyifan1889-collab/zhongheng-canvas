import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CreationUiContext } from "@/components/creation/ui/context";
import { AudioParametersForm, DEFAULT_AUDIO_PARAMETERS, audioVoiceLabel, selectAudioModelParameters } from "./audio-parameters";

test("selecting the single default-voice WAV model adapts a new draft and preserves unsupported instructions for explicit clearing", () => {
    const original = { ...DEFAULT_AUDIO_PARAMETERS, model: "verified-tts", prompt: "  保留原文  ", voice: "alloy", style: "自然", language: "普通话" };
    const next = selectAudioModelParameters(original, { voices: ["default"], formats: ["wav"] });
    expect(next).toEqual({ ...original, voice: "default", format: "wav" });
    expect(original.format).toBe("mp3"); expect(original.voice).toBe("alloy");
    const fresh = selectAudioModelParameters({ ...DEFAULT_AUDIO_PARAMETERS, model: "verified-tts" }, { voices: ["default"], formats: ["wav"] });
    expect(fresh.voice).toBe("default"); expect(fresh.format).toBe("wav");
});

test("model selection preserves supported choices and clears an unsupported voice when explicit choice is needed", () => {
    const original = { ...DEFAULT_AUDIO_PARAMETERS, model: "speech", voice: "nova", format: "wav" as const };
    expect(selectAudioModelParameters(original, { voices: ["alloy", "nova"], formats: ["mp3", "wav"] })).toEqual(original);
    expect(selectAudioModelParameters({ ...original, voice: "default" }, { voices: ["alloy", "nova"], formats: ["mp3", "wav"] }).voice).toBe("");
    expect(audioVoiceLabel("default")).toBe("默认音色"); expect(audioVoiceLabel("alloy")).toBe("alloy");
});

test("the form displays the declared default voice and WAV while disabling language, style and music controls", () => {
    const html = renderToStaticMarkup(<AudioParametersForm value={{ ...DEFAULT_AUDIO_PARAMETERS, model: "verified-tts", voice: "default", format: "wav" }}
        modelOptions={[{ value: "verified-tts", label: "已验证语音模型" }]} voiceOptions={["default"]} formatOptions={["wav"]}
        instructionsDisabled instructionsNote="此模型默认按中文清晰朗读。" onChange={() => {}} />);
    expect(html).toContain("默认音色"); expect(html).toContain("WAV"); expect(html).not.toContain("MP3");
    expect(html).toContain("此模型默认按中文清晰朗读。");
    for (const field of ["style", "language"]) expect(html.match(new RegExp(`<(?:input|textarea)[^>]+id="[^"]*-${field}"[^>]*>`))?.[0]).toContain("disabled");
    expect(html).toContain('fieldset'); expect(html).toContain("音乐参数（暂不可用）");
    expect(html).not.toContain('role="radiogroup"'); expect(html).not.toContain("查看完整说明");
});

test("creation uses controlled voice and format segments without enabling unsupported music or instructions", () => {
    const html = renderToStaticMarkup(<AudioParametersForm variant="creation" hidePrompt value={{ ...DEFAULT_AUDIO_PARAMETERS, voice: "nova", format: "wav", style: "保留风格", language: "保留语言" }}
        modelOptions={[]} voiceOptions={["alloy", "nova"]} formatOptions={["mp3", "wav"]} instructionsDisabled instructionsNote="所选模型不支持语音指令。" onChange={() => {}} />);
    const radios = html.match(/<button\b[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(4); expect(radios.filter(radio => radio.includes('aria-checked="true"'))).toHaveLength(2);
    expect(html).toContain("nova"); expect(html).toContain("WAV"); expect(html).not.toContain("朗读文本"); expect(html).not.toContain("音频模型");
    for (const field of ["style", "language", "seconds"]) expect(html.match(new RegExp(`<input[^>]+id="[^"]*-${field}"[^>]*>`))?.[0]).toContain("disabled");
    expect(html).toContain('value="保留风格"'); expect(html).toContain('value="保留语言"');
    expect(html.match(/查看完整说明/g)).toHaveLength(1); expect(html).toContain("音乐参数（暂不可用）");
});

test("creation retains searchable selection for a long voice list and busy segments remain disabled", () => {
    const long = renderToStaticMarkup(<CreationUiContext value={true}><AudioParametersForm variant="creation" hidePrompt value={DEFAULT_AUDIO_PARAMETERS} modelOptions={[]}
        voiceOptions={["alloy", "ash", "ballad", "coral", "echo"]} onChange={() => {}} /></CreationUiContext>);
    expect(long.match(/role="radiogroup"/g)).toHaveLength(1); expect(long).toContain("选择音色");
    expect(long.match(/<button\b[^>]*role="combobox"[^>]*>/)?.[0]).toContain('aria-label="音色"');
    const busy = renderToStaticMarkup(<AudioParametersForm variant="creation" hidePrompt disabled value={{ ...DEFAULT_AUDIO_PARAMETERS, voice: "default", format: "wav" }}
        modelOptions={[]} voiceOptions={["default"]} formatOptions={["wav"]} onChange={() => {}} />);
    const radios = busy.match(/<button\b[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2); expect(radios.every(radio => radio.includes("disabled"))).toBe(true);
});
