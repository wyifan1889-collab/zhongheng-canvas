import { normalizeChatUsage, normalizeResponsesUsage, type TextUsageEvidence } from "@infinite-canvas/shared";
import type { GenerationProviderResult } from "./generation-worker";

type TextMessage = { role: "system" | "user" | "assistant"; content: string };
type RequestError = { errorCode: "invalid_generation_input" | "invalid_generation_parameters" };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;

/** API and worker use the same pure-text contract. Retain the existing message
 * count/content bounds; no token estimate or implicit output limit is added.
 */
export function parseGenerationTextRequest(input: Record<string, unknown>, parameters: Record<string, unknown>): { messages: TextMessage[] } | RequestError {
    if (!record(input) || Object.keys(input).length !== 1) return { errorCode: "invalid_generation_input" };
    if (!record(parameters) || Object.keys(parameters).length !== 0) return { errorCode: "invalid_generation_parameters" };
    if (Object.hasOwn(input, "prompt")) {
        return text(input.prompt, 100_000) ? { messages: [{ role: "user", content: input.prompt }] } : { errorCode: "invalid_generation_input" };
    }
    if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 64) return { errorCode: "invalid_generation_input" };
    const messages: TextMessage[] = [];
    for (const value of input.messages) {
        const item = record(value);
        if (!item || Object.keys(item).length !== 2 || !["system", "user", "assistant"].includes(item.role as string) || !text(item.content, 100_000)) {
            return { errorCode: "invalid_generation_input" };
        }
        messages.push({ role: item.role as TextMessage["role"], content: item.content });
    }
    return { messages };
}

/** Explicit protocol selection, never fallback after a possibly paid request. */
export function buildGenerationTextRequest(adapter: "openai-compatible" | "sub2api", model: string, input: Record<string, unknown>, parameters: Record<string, unknown>):
    { body: Record<string, unknown>; source: TextUsageEvidence["source"]; path: "chat/completions" | "responses" } | RequestError {
    const parsed = parseGenerationTextRequest(input, parameters);
    if ("errorCode" in parsed) return parsed;
    return adapter === "sub2api"
        ? { source: "responses", path: "responses", body: { model, input: parsed.messages, stream: false, store: false } }
        : { source: "chat_completions", path: "chat/completions", body: { model, messages: parsed.messages, stream: false } };
}

function chatOutput(payload: Record<string, unknown> | null): { completed: boolean; value: string | null } {
    const choices = payload?.choices;
    if (!Array.isArray(choices) || choices.length !== 1) return { completed: false, value: null };
    const choice = record(choices[0]), message = record(choice?.message), content = message?.content;
    const value = text(content, 200_000) ? content : null;
    const completed = (payload?.error === undefined || payload.error === null) && choice?.finish_reason === "stop" && message?.role === "assistant" &&
        (!Object.hasOwn(message, "tool_calls") || Array.isArray(message.tool_calls) && message.tool_calls.length === 0 || message.tool_calls === null) &&
        (message.function_call === undefined || message.function_call === null) &&
        (message.refusal === undefined || message.refusal === null);
    return { completed, value };
}

function responsesOutput(payload: Record<string, unknown> | null): { completed: boolean; value: string | null } {
    if (!payload || !Array.isArray(payload.output)) return { completed: false, value: null };
    let completed = payload.status === "completed" && (payload.error === undefined || payload.error === null) &&
        (payload.incomplete_details === undefined || payload.incomplete_details === null);
    const parts: string[] = [];
    for (const value of payload.output) {
        const item = record(value);
        if (item?.type === "reasoning") continue;
        if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) { completed = false; continue; }
        if (item.status !== "completed") completed = false;
        for (const value of item.content) {
            const part = record(value);
            if (part?.type !== "output_text" || typeof part.text !== "string") { completed = false; continue; }
            parts.push(part.text);
        }
    }
    const joined = parts.join("");
    return { completed, value: text(joined, 200_000) ? joined : null };
}

/** Normalize non-streaming text and preserve safe usage even when completion is
 * unknown (e.g. reasoning consumed tokens but produced no deliverable text).
 * Missing usage is not a failed request or a zero-cost result: settlement owns it.
 */
export function normalizeGenerationTextResponse(payload: unknown, source: TextUsageEvidence["source"]): GenerationProviderResult {
    const data = record(payload);
    const usageEvidence = source === "responses" ? normalizeResponsesUsage(data?.usage) : normalizeChatUsage(data?.usage);
    const output = source === "responses" ? responsesOutput(data) : chatOutput(data);
    const responseId = data?.id;
    const providerTaskId = text(responseId, 200) ? responseId : undefined;
    const resultSnapshot = {
        kind: "text", ...(output.value === null ? {} : { text: output.value }), usageEvidence,
        ...(usageEvidence.status === "complete" ? { usage: { inputTokens: usageEvidence.inputTokens, outputTokens: usageEvidence.outputTokens, totalTokens: usageEvidence.totalTokens } } : {}),
    };
    return output.completed && output.value !== null
        ? { status: "succeeded", providerTaskId, resultSnapshot }
        : { status: "unknown", errorCode: "provider_text_invalid_response", unknownReason: "provider_text_invalid_response", providerTaskId, resultSnapshot };
}
