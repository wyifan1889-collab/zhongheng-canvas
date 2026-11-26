import { Buffer } from "node:buffer";
import type { ProviderAudioResult } from "./provider-gateway";

const prefix = "[media](data:audio/wav;base64,";
const unknownResponse = () => ({ status: "unknown", code: "provider_response_unknown", retryable: false } as const);
const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Unwrap only the observed complete Chat TTS envelope; full WAV integrity is checked downstream. */
export function normalizeChatTtsAudioResult(payload: unknown, expectedModel: string, maxBytes: number): ProviderAudioResult {
    const response = record(payload);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || typeof expectedModel !== "string" || !expectedModel || !response ||
        response.model !== expectedModel || "error" in response || !Array.isArray(response.choices) || response.choices.length !== 1) return unknownResponse();
    const choice = record(response.choices[0]);
    const message = record(choice?.message);
    if (!choice || choice.finish_reason !== "stop" || "delta" in choice || !message || message.role !== "assistant" ||
        Object.keys(message).some(key => key !== "role" && key !== "content") || typeof message.content !== "string") return unknownResponse();
    const content = message.content;
    if (!content.startsWith(prefix) || !content.endsWith(")") || content.length > prefix.length + 4 * Math.ceil(maxBytes / 3) + 1) return unknownResponse();
    const base64 = content.slice(prefix.length, -1);
    if (!base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return unknownResponse();
    const body = Buffer.from(base64, "base64");
    if (!body.byteLength || body.byteLength > maxBytes || body.toString("base64") !== base64) return unknownResponse();
    return { status: "succeeded", upstreamStatus: 200, contentType: "audio/wav", body, source: "audio_chat_data_uri" };
}
