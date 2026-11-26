import { VIDEO_PROTOCOL, type VideoBinding, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { createProviderGateway } from "./provider-gateway";
import { normalizeVideoProviderResponse } from "./video-provider-response";
import { buildVideoProviderCreateRequest, videoProviderTaskPath, type VideoInput, type VideoReference } from "./video-provider-request";
import type { VideoRuntimePolicy } from "./generation-video-config";

export type VideoProviderGateway = Pick<ReturnType<typeof createProviderGateway>, "requestVideoJson" | "requestVideoContent">;
/** No loops or retries. Durable stage claims are the sole authority to call create. */
export function createVideoProviderAdapter(options: { policy: VideoRuntimePolicy; credential: (binding: VideoBinding) => Promise<string | null>; gateway?: VideoProviderGateway }) {
    const gateway = options.gateway ?? createProviderGateway();
    const target = async (binding: VideoBinding) => {
        try {
            const endpoint = new URL(binding.endpoint);
            if (binding.protocol !== VIDEO_PROTOCOL || !binding.providerId || !binding.providerModel || endpoint.protocol !== "https:" ||
                endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/\/v1\/?$/.test(endpoint.pathname)) return null;
            const credential = await options.credential(binding);
            return credential ? { providerId: binding.providerId, adapter: "openai-compatible" as const, endpoint: binding.endpoint,
                providerModel: binding.providerModel, credential } : null;
        } catch { return null; }
    };
    return {
        async create(binding: VideoBinding, input: VideoInput, parameters: VideoParameters, reference?: VideoReference) {
            const body = buildVideoProviderCreateRequest(binding, input, parameters, reference);
            const upstream = body ? await target(binding) : null;
            if (!body || !upstream) return normalizeVideoProviderResponse({ operation: "create", httpStatus: null, payload: null });
            try {
                const result = await gateway.requestVideoJson({ target: upstream, path: "videos", method: "POST", body,
                    maxBytes: options.policy.jsonMaxBytes, signal: AbortSignal.timeout(options.policy.createTimeoutMs) });
                return normalizeVideoProviderResponse({ operation: "create", httpStatus: result.httpStatus, payload: result.status === "observed" ? result.payload : null });
            } catch { return normalizeVideoProviderResponse({ operation: "create", httpStatus: null, payload: null }); }
        },
        async inspect(binding: VideoBinding, providerTaskId: string) {
            const path = videoProviderTaskPath(providerTaskId), upstream = path ? await target(binding) : null;
            try {
                const result = upstream && path ? await gateway.requestVideoJson({ target: upstream, path, method: "GET",
                    maxBytes: options.policy.jsonMaxBytes, signal: AbortSignal.timeout(options.policy.inspectTimeoutMs) }) : null;
                return normalizeVideoProviderResponse({ operation: "inspect", expectedTaskId: providerTaskId, httpStatus: result?.httpStatus ?? null,
                    payload: result?.status === "observed" ? result.payload : null });
            } catch { return normalizeVideoProviderResponse({ operation: "inspect", expectedTaskId: providerTaskId, httpStatus: null, payload: null }); }
        },
        async resolveAsset(binding: VideoBinding, providerTaskId: string) {
            const path = videoProviderTaskPath(providerTaskId, true), upstream = path ? await target(binding) : null;
            if (!path || !upstream) return { status: "unknown" as const, httpStatus: null, reason: "configuration_invalid" as const };
            try { return await gateway.requestVideoContent({ target: upstream, path, method: "GET", maxBytes: options.policy.maxVideoBytes,
                signal: AbortSignal.timeout(options.policy.downloadTimeoutMs) }); }
            catch { return { status: "unknown" as const, httpStatus: null, reason: "transport_unknown" as const }; }
        },
    };
}
