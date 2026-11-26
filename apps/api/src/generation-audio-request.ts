/** Exact implemented TTS contracts; discovering a model alone never enables it. */
const voices = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"] as const;
const legacyVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;

export function audioSpeechCapabilities(providerModel: string) {
    if (providerModel === "gemini-3.8-flash-tts") return { formats: ["wav"] as const, voices: ["default"] as const, instructions: false };
    const legacy = providerModel === "tts-1" || providerModel === "tts-1-hd";
    if (!legacy && providerModel !== "gpt-4o-mini-tts" && providerModel !== "gpt-4o-mini-tts-2025-12-15") return null;
    return { formats: ["mp3", "wav"] as const, voices: legacy ? legacyVoices : voices, instructions: !legacy };
}

/** Preserve the confirmed text and fields. Unsupported music parameters never reach the provider. */
export function parseGenerationAudioRequest(input: Record<string, unknown>, parameters: Record<string, unknown>, providerModel?: string):
    { protocol: "speech" | "chat-audio"; body: Record<string, unknown> } | { errorCode: string } {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "text") ||
        typeof input.text !== "string" || !input.text.trim() || Array.from(input.text).length > 4096) return { errorCode: "invalid_generation_audio_input" };
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) ||
        Object.keys(parameters).some(key => !["voice", "format", "style", "language"].includes(key)) ||
        typeof parameters.voice !== "string" || (parameters.voice !== "default" && !(voices as readonly string[]).includes(parameters.voice)) ||
        (parameters.format !== "mp3" && parameters.format !== "wav")) return { errorCode: "invalid_generation_audio_parameters" };
    for (const field of ["style", "language"] as const) {
        if (parameters[field] !== undefined && (typeof parameters[field] !== "string" ||
            Array.from(parameters[field] as string).length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(parameters[field] as string))) {
            return { errorCode: "invalid_generation_audio_parameters" };
        }
    }
    const instructions = [parameters.language && (parameters.language as string).trim() ? `语言：${parameters.language}` : "",
        parameters.style && (parameters.style as string).trim() ? `朗读风格：${parameters.style}` : ""].filter(Boolean).join("\n");
    if (Array.from(instructions).length > 4096) return { errorCode: "invalid_generation_audio_parameters" };
    if (providerModel !== undefined) {
        const capability = audioSpeechCapabilities(providerModel);
        if (!capability) return { errorCode: "audio_model_unsupported" };
        if (!(capability.voices as readonly string[]).includes(parameters.voice)) return { errorCode: "audio_voice_unsupported" };
        if (!(capability.formats as readonly string[]).includes(parameters.format)) return { errorCode: "audio_format_unsupported" };
        if (instructions && !capability.instructions) return { errorCode: "audio_instructions_unsupported" };
    }
    if (providerModel === "gemini-3.8-flash-tts") return { protocol: "chat-audio", body: {
        messages: [{ role: "user", content: `请用中文清晰读出：${input.text}` }], stream: false } };
    return { protocol: "speech", body: { input: input.text, voice: parameters.voice, response_format: parameters.format,
        stream_format: "audio", ...(instructions ? { instructions } : {}) } };
}
