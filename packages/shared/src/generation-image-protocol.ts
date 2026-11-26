export const OPENAI_IMAGE_PROTOCOL = "openai-image-v1";
export type ImageProtocol = typeof OPENAI_IMAGE_PROTOCOL;
export type ImageResponseFormat = "b64_json";
export type ImageSpecParameters = { size?: string; quality?: "low" | "medium" | "high" };
export type ImageGenerationParameters = ImageSpecParameters & { n?: number };
export type ImageSpecification = { protocol: ImageProtocol; parameters: ImageGenerationParameters; responseFormat?: ImageResponseFormat };
export type ImageSpecTaskParameters = ImageSpecParameters & { protocol: ImageProtocol; n: number; output_format: "png"; response_format?: ImageResponseFormat };
export type ImagePricePolicy = { schemaVersion: 1; protocol: ImageProtocol; maxImagesPerRequest?: number; responseFormat?: ImageResponseFormat };
export const MAX_IMAGE_GENERATION_COUNT = 10;

export function validImageGenerationCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_IMAGE_GENERATION_COUNT;
}

/** Protocol identity does not grant a model an administrator's explicit batch allowance. */
export function parseImagePricePolicy(value: unknown): ImagePricePolicy | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (!Object.hasOwn(row, "schemaVersion") || !Object.hasOwn(row, "protocol") || row.schemaVersion !== 1 || row.protocol !== OPENAI_IMAGE_PROTOCOL ||
        Object.keys(row).some(key => !["schemaVersion", "protocol", "maxImagesPerRequest", "responseFormat"].includes(key)) ||
        Object.hasOwn(row, "maxImagesPerRequest") && !validImageGenerationCount(row.maxImagesPerRequest) ||
        Object.hasOwn(row, "responseFormat") && row.responseFormat !== "b64_json") return null;
    return { schemaVersion: 1, protocol: row.protocol, ...(Object.hasOwn(row, "maxImagesPerRequest") ? { maxImagesPerRequest: row.maxImagesPerRequest as number } : {}),
        ...(row.responseFormat === "b64_json" ? { responseFormat: row.responseFormat } : {}) };
}

/** OpenAI's executable specification; native vendor fields require their own implemented protocol. */
export function parseImageSpecParameters(value: unknown): ImageSpecParameters | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>, fields = Object.keys(row);
    if (!fields.length || fields.some(key => key !== "size" && key !== "quality")) return null;
    if (Object.hasOwn(row, "size") && (typeof row.size !== "string" || !/^[1-9]\d*x[1-9]\d*$/.test(row.size) ||
        !row.size.split("x").map(Number).every(Number.isSafeInteger))) return null;
    if (Object.hasOwn(row, "quality") && row.quality !== "low" && row.quality !== "medium" && row.quality !== "high") return null;
    return { ...(Object.hasOwn(row, "size") ? { size: row.size as string } : {}),
        ...(Object.hasOwn(row, "quality") ? { quality: row.quality as ImageSpecParameters["quality"] } : {}) };
}

export function parseImageGenerationParameters(value: unknown): ImageGenerationParameters | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { n, ...spec } = value as Record<string, unknown>;
    if (Object.hasOwn(value, "n") && !validImageGenerationCount(n)) return null;
    const parsed = parseImageSpecParameters(spec);
    return parsed ? { ...parsed, ...(n !== undefined && n !== 1 ? { n: n as number } : {}) } : null;
}

export function imageGenerationSpec(parameters: ImageGenerationParameters): ImageSpecParameters {
    const { n: _count, ...spec } = parameters;
    return spec;
}

export function canonicalImageSpecTaskParameters(parameters: ImageGenerationParameters, responseFormat?: ImageResponseFormat): ImageSpecTaskParameters {
    const parsed = parseImageGenerationParameters(parameters);
    if (!parsed || responseFormat !== undefined && responseFormat !== "b64_json") throw new Error("Invalid image specification parameters");
    return { protocol: OPENAI_IMAGE_PROTOCOL, ...parsed, n: parsed.n ?? 1, output_format: "png",
        ...(responseFormat === undefined ? {} : { response_format: responseFormat }) };
}

/** Pre-protocol tasks retain their original immutable OpenAI contract; unknown identifiers never fall back. */
export function imageSpecParametersFromTask(value: unknown): ImageGenerationParameters | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (!validImageGenerationCount(row.n) || row.output_format !== "png" ||
        Object.hasOwn(row, "protocol") && row.protocol !== OPENAI_IMAGE_PROTOCOL ||
        Object.hasOwn(row, "response_format") && row.response_format !== "b64_json" ||
        Object.keys(row).some(key => !["protocol", "size", "quality", "n", "output_format", "response_format"].includes(key))) return null;
    return parseImageGenerationParameters({ n: row.n, ...(Object.hasOwn(row, "size") ? { size: row.size } : {}),
        ...(Object.hasOwn(row, "quality") ? { quality: row.quality } : {}) });
}
