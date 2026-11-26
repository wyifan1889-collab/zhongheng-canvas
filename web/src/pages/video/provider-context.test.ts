import { expect, test } from "bun:test";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { captureVideoProviderContext } from "./provider-context";

function config(): AiConfig {
    return { ...structuredClone(defaultConfig), videoModel: "original::video-one", model: "original::video-one",
        channels: [{ id: "original", name: "Original", baseUrl: "https://provider.example", apiKey: "synthetic-private-key", apiFormat: "openai", models: [{ name: "video-one", capability: "video" }] }] };
}

test("video receipts contain a stable digest without exposing the provider key or URL", async () => {
    const original = config();
    const first = captureVideoProviderContext(original, original.model, () => original);
    const fingerprint = await first.fingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain(original.channels[0].apiKey);
    expect(fingerprint).not.toContain(original.channels[0].baseUrl);
    expect(await captureVideoProviderContext(structuredClone(original), original.model, () => original).fingerprint).toBe(fingerprint);
    expect(first.isCurrent()).toBe(true);
});

test("provider, key, protocol, script and proxy changes invalidate a pending video context", async () => {
    const mutations = [
        (value: AiConfig) => { value.channels[0].baseUrl = "https://different.example"; },
        (value: AiConfig) => { value.channels[0].apiKey = "different-key"; },
        (value: AiConfig) => { value.channels[0].apiFormat = "gemini"; },
        (value: AiConfig) => { value.channels[0].models[0].script = "different-script"; },
        (value: AiConfig) => { value.proxyEnabled = true; },
        (value: AiConfig) => { value.proxyUrl = "http://127.0.0.1:9000"; },
    ];
    for (const mutate of mutations) {
        const original = config(); let current = structuredClone(original);
        const operation = captureVideoProviderContext(original, original.model, () => current);
        mutate(current);
        expect(operation.isCurrent()).toBe(false);
        expect(await captureVideoProviderContext(current, original.model, () => current).fingerprint).not.toBe(await operation.fingerprint);
    }
    const original = config(); let current = { ...original, size: "1920x1080", videoSeconds: "12" };
    expect(captureVideoProviderContext(original, original.model, () => current).isCurrent()).toBe(true);
});
