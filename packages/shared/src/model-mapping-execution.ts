import { OPENAI_IMAGE_PROTOCOL, parseImagePricePolicy, parseImageSpecParameters, type ImageSpecParameters, type ImageResponseFormat } from "./generation-image-protocol";
import { parseVideoParameters, VIDEO_PROTOCOL, type VideoParameters } from "./generation-video";
import { GEMINI_IMAGE_PROTOCOL, parseGeminiImageSpecification, type GeminiImageSpecification } from "./generation-gemini-image";

/** Explicit draft configuration, not proof of upstream support or permission to generate. */
export type MappingExecution =
    | { protocol: typeof OPENAI_IMAGE_PROTOCOL; parameters: Required<ImageSpecParameters>; maxImagesPerRequest?: number; responseFormat?: ImageResponseFormat }
    | { protocol: typeof GEMINI_IMAGE_PROTOCOL; parameters: GeminiImageSpecification }
    | { protocol: typeof VIDEO_PROTOCOL; parameters: VideoParameters };

export function parseMappingExecution(value: unknown, capability: "image" | "video", specification: string): MappingExecution | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !["protocol", "parameters", "maxImagesPerRequest", "responseFormat"].includes(key)) || !Object.hasOwn(row, "protocol") || !Object.hasOwn(row, "parameters")) return null;
    if (capability === "image" && row.protocol === "openai-image-v1") {
        const parameters = parseImageSpecParameters(row.parameters);
        const policy = parseImagePricePolicy({ schemaVersion: 1, protocol: row.protocol,
            ...(Object.hasOwn(row, "maxImagesPerRequest") ? { maxImagesPerRequest: row.maxImagesPerRequest } : {}),
            ...(Object.hasOwn(row, "responseFormat") ? { responseFormat: row.responseFormat } : {}) });
        if (!policy) return null;
        // A display label cannot supply omitted size/quality defaults.
        return parameters?.size && parameters.quality ? { protocol: row.protocol, parameters: { size: parameters.size, quality: parameters.quality },
            ...(policy.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: policy.maxImagesPerRequest }),
            ...(policy.responseFormat === undefined ? {} : { responseFormat: policy.responseFormat }) } : null;
    }
    if (capability === "image" && row.protocol === GEMINI_IMAGE_PROTOCOL && Object.keys(row).length === 2) {
        const parameters = parseGeminiImageSpecification(undefined, row.parameters);
        return parameters && parameters.imageSize === specification ? { protocol: GEMINI_IMAGE_PROTOCOL, parameters } : null;
    }
    if (capability === "video" && row.protocol === VIDEO_PROTOCOL && !Object.hasOwn(row, "maxImagesPerRequest") && !Object.hasOwn(row, "responseFormat")) {
        const parameters = parseVideoParameters(row.parameters);
        return parameters && parameters.resolution.toUpperCase() === specification ? { protocol: row.protocol, parameters } : null;
    }
    return null;
}

/** Stable keys even after PostgreSQL JSONB changes object property order. */
export function mappingExecutionKey(execution: MappingExecution): string {
    const capability = execution.protocol === VIDEO_PROTOCOL ? "video" : "image";
    const specification = execution.protocol === VIDEO_PROTOCOL ? execution.parameters.resolution.toUpperCase()
        : execution.protocol === GEMINI_IMAGE_PROTOCOL ? execution.parameters.imageSize : "";
    const parsed = parseMappingExecution(execution, capability, specification);
    if (!parsed) throw new Error("Invalid mapping execution parameters");
    return JSON.stringify(parsed);
}
