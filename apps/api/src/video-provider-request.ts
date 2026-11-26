import { VIDEO_PROTOCOL, parseVideoParameters, type VideoBinding, type VideoParameters } from "../../../packages/shared/src/generation-video";

export type VideoInput = { prompt: string; referenceMediaId?: string };
export type VideoReference = { mediaId: string; contentType: string; body: Uint8Array };
/** Inputs have already passed the publication, owner, hash and resource checks. */
export function buildVideoProviderCreateRequest(binding: VideoBinding, input: VideoInput, parameters: VideoParameters, reference?: VideoReference): Record<string, unknown> | null {
    const selected = parseVideoParameters(parameters);
    if (!selected || binding.protocol !== VIDEO_PROTOCOL || !binding.providerId || !binding.providerModel || !input ||
        Object.keys(input).some(key => key !== "prompt" && key !== "referenceMediaId") || typeof input.prompt !== "string" || !input.prompt.trim() ||
        (selected.mode === "first_frame") !== (typeof input.referenceMediaId === "string") ||
        (selected.mode === "first_frame") !== Boolean(reference) || reference && (reference.mediaId !== input.referenceMediaId ||
            !/^image\/(png|jpeg|webp)$/.test(reference.contentType) || !(reference.body instanceof Uint8Array) || !reference.body.byteLength)) return null;
    try {
        const endpoint = new URL(binding.endpoint);
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/\/v1\/?$/.test(endpoint.pathname)) return null;
    } catch { return null; }
    return { model: binding.providerModel, prompt: input.prompt, duration: selected.durationSeconds, resolution: selected.resolution,
        generate_audio: selected.generateAudio, ...(selected.mode === "text" ? { aspect_ratio: selected.aspectRatio } : {
            image: { url: `data:${reference!.contentType};base64,${Buffer.from(reference!.body).toString("base64")}` },
        }) };
}

export function videoProviderTaskPath(providerTaskId: string, content = false): string | null {
    if (typeof providerTaskId !== "string" || !providerTaskId || providerTaskId.length > 200 || providerTaskId.trim() !== providerTaskId ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(providerTaskId) || providerTaskId === "." || providerTaskId === "..") return null;
    try {
        const encoded = encodeURIComponent(providerTaskId).replace(/[.!'()*~]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
        return `videos/${encoded}${content ? "/content" : ""}`;
    } catch { return null; }
}
