const brands = {
    openai: { name: "OpenAI", icon: "/icons/openai.svg", monochrome: true },
    google: { name: "Google Gemini", icon: "/icons/gemini.svg", monochrome: false },
    xai: { name: "xAI Grok", icon: "/icons/grok.svg", monochrome: true },
    anthropic: { name: "Anthropic", icon: "/icons/claude.svg", monochrome: true },
    deepseek: { name: "DeepSeek", icon: "/icons/deepseek.svg", monochrome: true },
    zhipu: { name: "智谱", icon: "/icons/glm.svg", monochrome: true },
};

/** Presentation hints only; these names never establish protocol or billing capabilities. */
export function resolveModelBrand(...hints: (string | undefined)[]) {
    for (const hint of hints) {
        const name = hint?.split("::").at(-1)?.trim().toLowerCase() ?? "";
        if (/(?:^|[\s/._-])(?:gemini|google|imagen|veo|nano[\s_-]*banana|banana)(?:$|[\s/._-])|香蕉/.test(name)) return { id: "google", ...brands.google };
        if (/(?:^|[\s/._-])(?:grok|xai|x\.ai)(?:$|[\s/._-])/.test(name)) return { id: "xai", ...brands.xai };
        if (/(?:^|[\s/._-])(?:gpt|chatgpt|openai|dall[\s_-]*e|sora)(?:$|[\s/._-])|^image[- ]2(?:[.-]|$)/.test(name)) return { id: "openai", ...brands.openai };
        if (/(?:^|[\s/._-])(?:claude|anthropic)(?:$|[\s/._-])/.test(name)) return { id: "anthropic", ...brands.anthropic };
        if (/(?:^|[\s/._-])deepseek(?:$|[\s/._-])/.test(name)) return { id: "deepseek", ...brands.deepseek };
        if (/(?:^|[\s/._-])(?:glm|zhipu)(?:$|[\s/._-])|智谱/.test(name)) return { id: "zhipu", ...brands.zhipu };
    }
    return null;
}
