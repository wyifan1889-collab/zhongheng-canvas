import { resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";

/** Keep the provider secret only in this closure; persisted receipts contain its digest. */
export function captureVideoProviderContext(config: AiConfig, model: string, getConfig: () => AiConfig) {
    const serialize = (value: AiConfig) => {
        const request = resolveModelRequestConfig(value, model);
        return JSON.stringify([model, request.model, request.baseUrl, request.apiKey, request.apiFormat,
            resolveModelScript(value, model), value.proxyEnabled, value.proxyUrl]);
    };
    const source = serialize(config);
    const fingerprint = crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))
        .then(bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join(""));
    return { fingerprint, isCurrent: () => source === serialize(getConfig()) };
}
