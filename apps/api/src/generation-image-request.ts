import { OPENAI_IMAGE_PROTOCOL, validImageGenerationCount } from "@infinite-canvas/shared";

/** Shared API/worker boundary for PNG generation. */
export function parseGenerationImageRequest(
    input: Record<string, unknown>,
    parameters: Record<string, unknown>,
): { body: Record<string, unknown> } | { errorCode: string } {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "prompt") || typeof input.prompt !== "string" || !input.prompt.trim()) {
        return { errorCode: "invalid_generation_input" };
    }
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).some((key) => !["protocol", "size", "quality", "background", "n", "output_format", "response_format"].includes(key)) ||
        Object.hasOwn(parameters, "protocol") && parameters.protocol !== OPENAI_IMAGE_PROTOCOL) {
        return { errorCode: "invalid_generation_parameters" };
    }
    const size = parameters.size;
    const dimensions = typeof size === "string" && /^[1-9]\d*x[1-9]\d*$/.test(size) ? size.split("x").map(Number) : null;
    if ((size !== undefined && size !== "auto" && !(dimensions && dimensions.every(Number.isSafeInteger))) ||
        (parameters.quality !== undefined && !["auto", "low", "medium", "high"].includes(parameters.quality as string)) ||
        (parameters.background !== undefined && !["auto", "opaque", "transparent"].includes(parameters.background as string)) ||
        (parameters.n !== undefined && !validImageGenerationCount(parameters.n)) ||
        (parameters.output_format !== undefined && parameters.output_format !== "png") ||
        (parameters.response_format !== undefined && parameters.response_format !== "b64_json")) {
        return { errorCode: "invalid_generation_parameters" };
    }
    const { protocol: _protocol, ...transport } = parameters;
    return { body: { prompt: input.prompt, ...transport, n: parameters.n ?? 1, output_format: "png" } };
}
