export type ModelClassification = {
    brand: string | null;
    capability: "text" | "image" | "video" | "audio" | null;
};

/** Name-based suggestions only. A directory response does not verify generation capabilities. */
export function inferProviderModel(modelId: string): ModelClassification {
    const name = modelId.trim().toLowerCase().split("/").at(-1) ?? "";
    const starts = (pattern: RegExp) => pattern.test(name);
    const brand = starts(/^(gpt(?:-|\d)|chatgpt-|o[134](?:-|$)|dall-e|sora(?:-|$)|whisper-|tts-)/) ? "OpenAI"
        : starts(/^claude(?:-|$)/) ? "Anthropic"
        : starts(/^deepseek(?:-|$)/) ? "DeepSeek"
        : starts(/^(gemini|imagen|veo)(?:-|$)/) ? "Google"
        : starts(/^grok(?:-|$)/) ? "xAI"
        : starts(/^qwen(?:-|\d|$)/) ? "通义千问"
        : starts(/^flux(?:[.-]|$)/) ? "Black Forest Labs"
        : null;
    // Embeddings, moderation and multimodal audio/chat aliases are not plain text nodes.
    if (/(?:^|[-_.])(?:embedding|embeddings|moderation|realtime|audio)(?:[-_.]|$)/.test(name)) {
        return { brand, capability: null };
    }
    const capability = starts(/^(sora|veo)(?:-|$)/) || starts(/^grok-.*video(?:-|$)/) ? "video"
        : starts(/^(gpt-image|dall-e|imagen)(?:-|$)/) || starts(/^flux(?:[.-]|$)/)
            || starts(/^(gemini|qwen|grok)-.*image(?:-|$)/) ? "image"
        : ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "grok-voice-latest"].includes(name) || starts(/^(whisper-|tts-|gpt-4o-mini-tts(?:-|$))/) ? "audio"
        : starts(/^(gpt(?:-|\d)|chatgpt-|o[134](?:-|$)|claude-|deepseek-|gemini-|grok-|qwen(?:-|\d))/) ? "text"
        : null;
    return { brand, capability };
}
