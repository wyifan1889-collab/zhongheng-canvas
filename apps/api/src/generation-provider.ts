import { and, eq } from "drizzle-orm";
import { normalizeChatUsage, imageModelMaxCount, MAX_IMAGE_GENERATION_COUNT } from "@infinite-canvas/shared";
import type { Database } from "@infinite-canvas/database";
import { loadProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { getImageSpecTaskSnapshot, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { modelCatalog, modelProvider } from "@infinite-canvas/database/schema";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import {
    createProviderGateway,
    type ProviderAdapter,
    type ProviderCallResult,
    type ProviderTarget,
} from "./provider-gateway";
import type { GenerationProviderResult } from "./generation-worker";
import { normalizeGenerationImage, resolveVerifiedGenerationImage } from "./generation-image";
import { parseGenerationImageRequest } from "./generation-image-request";
import { buildGenerationTextRequest, normalizeGenerationTextResponse } from "./generation-text";
import { imageSpecFitsPixelBudget } from "./generation-image-limits";
import { normalizeGenerationImageSpecification } from "./generation-image-specification";
import { generatePlannedImageRequests } from "./generation-image-requests";
import { parseGenerationAudioRequest } from "./generation-audio-request";
import { normalizeGenerationAudio } from "./generation-audio";
import { geminiImageDimensions } from "../../../packages/shared/src/generation-gemini-image";
import { geminiRequest, normalizeGeminiDelivery } from "./generation-gemini-delivery-evidence";
import { accountPolicy } from "./policy";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { compareCreditAmounts } from "@infinite-canvas/shared";

/**
 * Server-only bridge from the durable model catalogue to the normalized
 * generation worker contract. Text and explicitly enabled single-PNG image
 * requests share the task and billing state machines.
 */
export type GenerationProviderGateway = Pick<ReturnType<typeof createProviderGateway>, "request"> & Partial<Pick<ReturnType<typeof createProviderGateway>, "requestAudio" | "requestChatAudio">>;

export type GenerationProviderDependencies = {
    database: Database;
    authSecret: string;
    gateway?: GenerationProviderGateway;
    requestTimeoutMs?: number;
    /** Present only when the worker has configured image storage/delivery. */
    imageMaxBytes?: number;
    audioMaxBytes?: number;
};

type ProviderBinding = {
    providerId: string;
    adapter: ProviderAdapter;
    endpoint: string;
    providerModel: string;
    capability: "text" | "image" | "video" | "audio";
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength ? value : null;
}

function messagesFromInput(input: Record<string, unknown>): ChatMessage[] | null {
    if (Array.isArray(input.messages)) {
        if (input.messages.length < 1 || input.messages.length > 64) return null;
        const messages = input.messages.map((item): ChatMessage | null => {
            const record = asRecord(item);
            const role = record?.role;
            const content = boundedString(record?.content, 100_000);
            return (role === "system" || role === "user" || role === "assistant") && content
                ? { role, content }
                : null;
        });
        return messages.every(Boolean) ? messages as ChatMessage[] : null;
    }
    const prompt = boundedString(input.prompt, 100_000);
    return prompt ? [{ role: "user", content: prompt }] : null;
}

function safeParameters(parameters: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const temperature = parameters.temperature;
    if (typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) result.temperature = temperature;
    const topP = parameters.top_p;
    if (typeof topP === "number" && Number.isFinite(topP) && topP > 0 && topP <= 1) result.top_p = topP;
    for (const key of ["max_tokens", "max_completion_tokens"] as const) {
        const value = parameters[key];
        if (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 100_000) result[key] = value;
    }
    if (typeof parameters.stop === "string" && parameters.stop.length <= 100) result.stop = parameters.stop;
    if (Array.isArray(parameters.stop) && parameters.stop.length <= 4 && parameters.stop.every((item) => typeof item === "string" && item.length <= 100)) result.stop = parameters.stop;
    const responseFormat = asRecord(parameters.response_format);
    if (responseFormat && (responseFormat.type === "text" || responseFormat.type === "json_object")) result.response_format = { type: responseFormat.type };
    return result;
}

function requestBody(task: GenerationTaskView, binding: ProviderBinding): { body: Record<string, unknown> } | { errorCode: string } {
    const messages = messagesFromInput(task.inputSnapshot);
    if (!messages) return { errorCode: "invalid_generation_input" };
    return {
        body: {
            model: binding.providerModel,
            messages,
            ...safeParameters(task.parameterSnapshot),
        },
    };
}

function imageRequestBody(task: GenerationTaskView, binding: ProviderBinding): { body: Record<string, unknown> } | { errorCode: string } {
    const parsed = parseGenerationImageRequest(task.inputSnapshot, task.parameterSnapshot);
    return "errorCode" in parsed ? parsed : { body: { model: binding.providerModel, ...parsed.body } };
}

function invalidTextResponse(): GenerationProviderResult {
    return { status: "unknown", errorCode: "provider_text_invalid_response", unknownReason: "provider_text_invalid_response" };
}

function normalizeChatResponse(payload: unknown, billingUnit: GenerationTaskView["billingUnitSnapshot"]): GenerationProviderResult {
    const record = asRecord(payload);
    const choices = Array.isArray(record?.choices) ? record.choices : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first?.message);
    const text = boundedString(message?.content, 200_000);
    if (!text) return invalidTextResponse();

    const usageEvidence = normalizeChatUsage(record?.usage);
    const usageSnapshot = usageEvidence.status === "complete"
        ? { inputTokens: usageEvidence.inputTokens, outputTokens: usageEvidence.outputTokens, totalTokens: usageEvidence.totalTokens }
        : undefined;
    const providerTaskId = boundedString(record?.id, 200) ?? undefined;
    const consumedUnits = billingUnit === "request" ? 1 : billingUnit === "output_token" && usageEvidence.status === "complete" ? usageEvidence.outputTokens ?? undefined : undefined;
    return {
        status: "succeeded",
        ...(consumedUnits === undefined ? {} : { consumedUnits }),
        providerTaskId,
        // Token counts remain evidence. A billable consumedUnits value is
        // emitted only when the immutable task snapshot explicitly selects a
        // supported request or output-token billing policy.
        resultSnapshot: { kind: "text", text, usageEvidence, ...(usageSnapshot ? { usage: usageSnapshot } : {}) },
    };
}

async function loadBinding(database: Database, authSecret: string, modelId: string): Promise<(ProviderBinding & { credential: string }) | null> {
    const [row] = await database.select({
        providerId: modelProvider.id,
        adapter: modelProvider.adapter,
        endpoint: modelProvider.endpoint,
        providerModel: modelCatalog.providerModel,
        capability: modelCatalog.capability,
    }).from(modelCatalog)
        .innerJoin(modelProvider, eq(modelCatalog.providerId, modelProvider.id))
        .where(and(eq(modelCatalog.publicId, modelId), eq(modelCatalog.enabled, true), eq(modelProvider.enabled, true)))
        .limit(1);
    if (!row) return null;
    let credential: string | null;
    try {
        credential = await loadProviderCredential(database, authSecret, row.providerId);
    } catch {
        return null;
    }
    return credential ? { ...row, credential } as ProviderBinding & { credential: string } : null;
}

function mapGatewayResult(result: ProviderCallResult, billingUnit: GenerationTaskView["billingUnitSnapshot"]): GenerationProviderResult {
    if (result.status === "unknown") return { status: "unknown", errorCode: result.code, unknownReason: result.code };
    if (result.status === "failed") return result.code === "provider_rejected" || result.requestSent === false
        ? { status: "failed", errorCode: result.code } : invalidTextResponse();
    const normalized = normalizeChatResponse(result.payload, billingUnit);
    if (normalized.status !== "succeeded") return normalized;
    return { ...normalized, providerStatus: result.upstreamStatus };
}

/** Build the provider callback that a real worker will inject when enabled. */
export function createGenerationProvider(dependencies: GenerationProviderDependencies): (task: GenerationTaskView) => Promise<GenerationProviderResult> {
    const gateway = dependencies.gateway ?? createProviderGateway();
    const timeoutMs = dependencies.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("生成 Provider 超时配置无效");
    if (dependencies.imageMaxBytes !== undefined && (!Number.isSafeInteger(dependencies.imageMaxBytes) || dependencies.imageMaxBytes <= 0)) throw new Error("生成图片大小上限无效");
    if (dependencies.audioMaxBytes !== undefined && (!Number.isSafeInteger(dependencies.audioMaxBytes) || dependencies.audioMaxBytes <= 0)) throw new Error("生成音频大小上限无效");
    return async (task) => {
        const imageSpec = await getImageSpecTaskSnapshot(dependencies.database, task);
        if (imageSpec.status === "invalid") return { status: "failed", errorCode: "model_unavailable" };
        if (imageSpec.status === "recorded" && !imageSpecFitsPixelBudget(imageSpec.parameters)) return { status: "failed", errorCode: "image_spec_pixel_budget_exceeded" };
        const binding = await loadBinding(dependencies.database, dependencies.authSecret, task.modelId);
        if (!binding) return { status: "failed", errorCode: "model_unavailable" };
        // No supplier request has started. A changed binding or price cannot spend an accepted task's frozen credits.
        if (!await validatePublishedGenerationTask(dependencies.database, task, binding)) return { status: "failed", errorCode: "model_unavailable" };
        if (imageSpec.status === "gemini") {
            const reservation = task.reservationId && await createWalletRepository(dependencies.database).getReservation(task.ownerId, task.reservationId);
            if (!reservation || reservation.taskId !== task.id || reservation.providerRequestId !== task.requestId || reservation.status !== "pending" ||
                compareCreditAmounts(reservation.requestedUnits, String(imageSpec.parameters.budgetCredits)) !== 0 ||
                compareCreditAmounts(reservation.capturedUnits, "0") !== 0 || compareCreditAmounts(reservation.releasedUnits, "0") !== 0)
                return { status: "unknown", unknownReason: "gemini_image_reservation_mismatch" };
            const maxBytes = dependencies.imageMaxBytes;
            if (maxBytes === undefined) return { status: "failed", errorCode: "image_delivery_unavailable" };
            const dimensions = geminiImageDimensions(imageSpec.parameters);
            if (!dimensions || !imageSpecFitsPixelBudget({ size: `${dimensions.width}x${dimensions.height}` }))
                return { status: "failed", errorCode: "image_spec_pixel_budget_exceeded" };
            const request = geminiRequest(task, imageSpec);
            if ("errorCode" in request) return { status: "failed", errorCode: request.errorCode };
            // Existing image count/byte limits, Base64 expansion, and the existing document budget for JSON metadata.
            const maxResponseBytes = MAX_IMAGE_GENERATION_COUNT * 4 * Math.ceil(maxBytes / 3) + accountPolicy.documentBytes;
            const response = await gateway.request({ ...request, target: binding, maxResponseBytes, signal: AbortSignal.timeout(timeoutMs) });
            if (response.status === "failed" && (response.requestSent === false || response.code === "provider_rejected"))
                return { status: "failed", errorCode: response.code };
            if (response.status !== "succeeded") return { status: "unknown", unknownReason: response.code };
            return normalizeGeminiDelivery(response.payload, task, imageSpec, maxBytes, response.upstreamStatus);
        }
        if (binding.capability === "audio") {
            if (binding.adapter !== "openai-compatible") return { status: "failed", errorCode: "provider_adapter_unsupported" };
            if (dependencies.audioMaxBytes === undefined) return { status: "failed", errorCode: "audio_delivery_unavailable" };
            if (task.billingUnitSnapshot !== "request" || !task.pricePublicationId) return { status: "failed", errorCode: "unsupported_audio_billing" };
            const request = parseGenerationAudioRequest(task.inputSnapshot, task.parameterSnapshot, binding.providerModel);
            if ("errorCode" in request) return { status: "failed", errorCode: request.errorCode };
            const sendAudio = request.protocol === "chat-audio" ? gateway.requestChatAudio : gateway.requestAudio;
            if (!sendAudio) return { status: "failed", errorCode: "audio_delivery_unavailable" };
            try {
                const path = `${/\/v1$/i.test(new URL(binding.endpoint).pathname.replace(/\/+$/, "")) ? "" : "v1/"}${request.protocol === "chat-audio" ? "chat/completions" : "audio/speech"}`;
                const result = await sendAudio({ target: { ...binding }, path,
                    body: { model: binding.providerModel, ...request.body }, maxBytes: dependencies.audioMaxBytes, signal: AbortSignal.timeout(timeoutMs) });
                return await normalizeGenerationAudio(result, task, dependencies.audioMaxBytes);
            } catch { return { status: "unknown", errorCode: "provider_audio_exception", unknownReason: "provider_audio_exception" }; }
        }
        if (binding.capability !== "text" && binding.capability !== "image") return { status: "failed", errorCode: "unsupported_generation_capability" };
        const budgetText = binding.capability === "text" && task.textQuoteSnapshot != null;
        if (binding.adapter !== "openai-compatible" && !(budgetText && binding.adapter === "sub2api")) return { status: "failed", errorCode: "provider_adapter_unsupported" };
        const image = binding.capability === "image";
        if (image && Number(task.parameterSnapshot.n ?? 1) > 1 &&
            (imageSpec.status !== "recorded" || Number(task.parameterSnapshot.n) > imageModelMaxCount(binding.providerModel,
                imageSpec.maxImagesPerRequest === undefined ? undefined : { schemaVersion: 1, protocol: "openai-image-v1", maxImagesPerRequest: imageSpec.maxImagesPerRequest }))) return { status: "failed", errorCode: "unsupported_image_count" };
        if (image && dependencies.imageMaxBytes === undefined) return { status: "failed", errorCode: "image_delivery_unavailable" };
        if (image && task.billingUnitSnapshot !== "request") return { status: "failed", errorCode: "unsupported_image_billing" };
        const textRequest = budgetText ? buildGenerationTextRequest(binding.adapter, binding.providerModel, task.inputSnapshot, task.parameterSnapshot) : null;
        const request = image ? imageRequestBody(task, binding) : textRequest ?? requestBody(task, binding);
        if ("errorCode" in request) return { status: "failed", errorCode: request.errorCode };
        const target: ProviderTarget = {
            providerId: binding.providerId,
            adapter: binding.adapter,
            endpoint: binding.endpoint,
            credential: binding.credential,
            providerModel: binding.providerModel,
        };
        if (image && imageSpec.status === "recorded" && imageSpec.maxImagesPerRequest !== undefined &&
            (imageSpec.parameters.n ?? 1) > imageSpec.maxImagesPerRequest) {
            const fixedBinding = { providerId: binding.providerId, providerModel: binding.providerModel, endpoint: binding.endpoint,
                adapter: "openai-compatible" as const, capability: "image" as const };
            return generatePlannedImageRequests({ database: dependencies.database, task, binding: fixedBinding, target,
                specification: { ...imageSpec, maxImagesPerRequest: imageSpec.maxImagesPerRequest }, gateway, timeoutMs, maxBytes: dependencies.imageMaxBytes!,
                canSend: async () => {
                    const current = await loadBinding(dependencies.database, dependencies.authSecret, task.modelId);
                    return !!current && current.credential === binding.credential &&
                        ["providerId", "providerModel", "endpoint", "adapter", "capability"].every(key => current[key as keyof ProviderBinding] === binding[key as keyof ProviderBinding]) &&
                        await validatePublishedGenerationTask(dependencies.database, task, current);
                } });
        }
        let result: ProviderCallResult;
        try {
            const path = `${/\/v1$/i.test(new URL(binding.endpoint).pathname.replace(/\/+$/, "")) ? "" : "v1/"}${image ? "images/generations" : textRequest && "path" in textRequest ? textRequest.path : "chat/completions"}`;
            result = await gateway.request({ target, path, body: request.body, signal: AbortSignal.timeout(timeoutMs) });
        } catch {
            return { status: "unknown", errorCode: "provider_adapter_exception", unknownReason: "provider_adapter_exception" };
        }
        if (image) {
            if (result.status === "unknown") return { status: "unknown", errorCode: result.code, unknownReason: result.code };
            if (result.status === "failed" && (result.code === "provider_rejected" || result.requestSent === false)) return { status: "failed", errorCode: result.code };
            if (imageSpec.status === "recorded" && result.status === "succeeded") {
                const normalized = await normalizeGenerationImageSpecification(result.payload, task, { ...imageSpec,
                    binding: { providerId: binding.providerId, providerModel: binding.providerModel, endpoint: binding.endpoint,
                        adapter: "openai-compatible", capability: "image" } }, dependencies.imageMaxBytes!);
                if (normalized.status !== "verified") return { status: "unknown", errorCode: normalized.reason, unknownReason: normalized.reason,
                    ...(normalized.resultSnapshot ? { resultSnapshot: normalized.resultSnapshot } : {}) };
                return { status: "succeeded", providerStatus: result.upstreamStatus, consumedUnits: 1, resultSnapshot: normalized.resultSnapshot };
            }
            const snapshot = result.status === "succeeded" ? normalizeGenerationImage(result.payload, dependencies.imageMaxBytes!) : null;
            // An unusable 2xx (including a gateway JSON parse failure) may
            // already have cost upstream credits: do not release or retry it.
            if (!snapshot || !await resolveVerifiedGenerationImage(snapshot, dependencies.imageMaxBytes!)) {
                return { status: "unknown", errorCode: "provider_image_invalid_response", unknownReason: "provider_image_invalid_response" };
            }
            return { status: "succeeded", providerStatus: result.status === "succeeded" ? result.upstreamStatus : undefined, consumedUnits: 1, resultSnapshot: snapshot };
        }
        if (textRequest && "source" in textRequest) {
            if (result.status === "unknown") return { status: "unknown", errorCode: result.code, unknownReason: result.code };
            if (result.status === "failed") return result.code === "provider_rejected" || result.requestSent === false
                ? { status: "failed", errorCode: result.code } : invalidTextResponse();
            return { ...normalizeGenerationTextResponse(result.payload, textRequest.source), providerStatus: result.upstreamStatus };
        }
        return mapGatewayResult(result, task.billingUnitSnapshot);
    };
}

