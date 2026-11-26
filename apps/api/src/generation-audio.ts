import { Buffer } from "node:buffer";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { parseGenerationAudioRequest } from "./generation-audio-request";
import type { ProviderAudioResult } from "./provider-gateway";
import type { GenerationProviderResult } from "./generation-worker";

/** Full decoders load only for an enabled audio request or audio delivery replay. */
export async function normalizeGenerationAudio(result: ProviderAudioResult, task: GenerationTaskView, maxBytes: number): Promise<GenerationProviderResult> {
    if (result.status === "failed") return { status: "failed", errorCode: result.code };
    if (result.status === "unknown") return { status: "unknown", errorCode: result.code, unknownReason: result.code };
    const { validateAudioIntegrity } = await import("./audio-integrity");
    const checked = await validateAudioIntegrity({ ...result, requestedFormat: String(task.parameterSnapshot.format), maxBytes });
    if (checked.status !== "verified") return checked.status === "failed"
        ? { status: "failed", errorCode: checked.code, providerStatus: result.upstreamStatus }
        : { status: "unknown", errorCode: checked.code, unknownReason: checked.code, providerStatus: result.upstreamStatus };
    // One platform request is counted only when the worker attaches its durable audio media.
    return { status: "succeeded", providerStatus: result.upstreamStatus, resultSnapshot: {
        kind: "audio", audio: { contentType: checked.asset.contentType, base64: Buffer.from(checked.asset.body).toString("base64") },
        usageEvidence: { status: "missing", source: result.source === "audio_chat_data_uri" ? "audio_chat_data_uri" : checked.usageEvidence.source }, technicalAudio: checked.technicalAudio,
        billingPolicy: { source: "platform_successful_request", unit: "request" },
    } };
}

export async function resolveGenerationAudio(task: GenerationTaskView, snapshot: Record<string, unknown>, maxBytes: number) {
    if (snapshot.kind !== "audio" || "errorCode" in parseGenerationAudioRequest(task.inputSnapshot, task.parameterSnapshot)) return null;
    const audio = snapshot.audio as Record<string, unknown> | undefined;
    const base64 = audio?.base64;
    if (typeof base64 !== "string" || !base64.length || base64.length > 4 * Math.ceil(maxBytes / 3) ||
        base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
    const body = Buffer.from(base64, "base64");
    if (!body.byteLength || body.byteLength > maxBytes || body.toString("base64") !== base64) return null;
    const { validateAudioIntegrity } = await import("./audio-integrity");
    const checked = await validateAudioIntegrity({ upstreamStatus: 200, contentType: typeof audio?.contentType === "string" ? audio.contentType : null,
        body, requestedFormat: String(task.parameterSnapshot.format), maxBytes });
    if (checked.status !== "verified") return null;
    const technical = snapshot.technicalAudio as Record<string, unknown> | undefined;
    const evidence = snapshot.usageEvidence as Record<string, unknown> | undefined;
    if (!technical || Object.entries(checked.technicalAudio).some(([key, value]) => technical[key] !== value) ||
        evidence?.status !== "missing" || evidence.source !== "audio_speech_binary" && evidence.source !== "audio_chat_data_uri") return null;
    const policy = snapshot.billingPolicy as Record<string, unknown> | undefined;
    return policy?.source === "platform_successful_request" && policy.unit === "request" ? checked.asset : null;
}
