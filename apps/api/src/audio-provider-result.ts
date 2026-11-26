import { fileTypeFromBuffer } from "file-type";

export type AudioProviderFormat = "mp3" | "wav";

export type AudioProviderResponse = {
    upstreamStatus: number;
    contentType: string | null;
    /** Complete response bytes, already bounded while reading by the caller. */
    body: Uint8Array;
    requestedFormat: string;
    /** Explicit caller policy, not a default or a network buffering limit. */
    maxBytes: number;
};

export type AudioProviderUnknownCode =
    | "audio_http_response_unknown"
    | "audio_format_unsupported"
    | "audio_content_type_missing"
    | "audio_content_type_unsupported"
    | "audio_content_type_mismatch"
    | "audio_body_invalid"
    | "audio_body_too_large"
    | "audio_json_response"
    | "audio_unrecognized"
    | "audio_detection_failed"
    | "audio_format_mismatch";

export type AudioProviderResult =
    | {
        /** Signature/metadata candidate only: not a worker or billing success. */
        status: "candidate";
        upstreamStatus: 200;
        format: AudioProviderFormat;
        sizeBytes: number;
        contentType: "audio/mpeg" | "audio/wav";
        /** Not a GenerationDeliveryAsset: A2 must validate before constructing one. */
        candidateBytes: Uint8Array;
        validation: { level: "signature"; detector: "file-type@22.2.0" };
        usageEvidence: { status: "missing"; source: "audio_speech_binary" };
        durationEvidence: { status: "missing" };
    }
    | { status: "failed"; code: "provider_rejected"; upstreamStatus: number; retryable: false }
    | { status: "unknown"; code: AudioProviderUnknownCode; upstreamStatus: number; retryable: false };

const contentTypes = { mp3: "audio/mpeg", wav: "audio/wav" } as const;
const explicitRejections = new Set([400, 401, 403, 404, 429]);

function isJson(body: Uint8Array): boolean {
    try {
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        return true;
    } catch {
        return false;
    }
}

/**
 * Normalize an already-collected binary Speech response without I/O or billing.
 * file-type checks signatures; even a recognized truncated file can be a
 * candidate. Full decoding, duration and billable usage are deliberately absent.
 */
export async function normalizeAudioProviderResult(input: AudioProviderResponse): Promise<AudioProviderResult> {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) throw new TypeError("音频大小边界必须是正安全整数");
    const upstreamStatus = input.upstreamStatus;
    const unknown = (code: AudioProviderUnknownCode): AudioProviderResult => ({
        status: "unknown", code, upstreamStatus, retryable: false,
    });
    if (!Number.isInteger(upstreamStatus) || upstreamStatus < 100 || upstreamStatus > 599) return unknown("audio_http_response_unknown");
    // Unverified 4xx, including timeout/abort-like 408 and 499, stay unknown.
    if (explicitRejections.has(upstreamStatus)) {
        return { status: "failed", code: "provider_rejected", upstreamStatus, retryable: false };
    }
    if (upstreamStatus !== 200) return unknown("audio_http_response_unknown");
    const format = input.requestedFormat;
    if (format !== "mp3" && format !== "wav") return unknown("audio_format_unsupported");
    if (typeof input.contentType !== "string" || !input.contentType.trim()) return unknown("audio_content_type_missing");
    const contentType = input.contentType.trim().toLowerCase();
    // A strict allowlist, not a MIME parser: aliases/parameters/generic types
    // require a verified channel contract before they can be accepted.
    if (/[\u0000-\u001f\u007f]/.test(input.contentType) ||
        (contentType !== contentTypes.mp3 && contentType !== contentTypes.wav)) return unknown("audio_content_type_unsupported");
    if (contentType !== contentTypes[format]) return unknown("audio_content_type_mismatch");
    if (!(input.body instanceof Uint8Array) || input.body.byteLength === 0) return unknown("audio_body_invalid");
    if (input.body.byteLength > input.maxBytes) return unknown("audio_body_too_large");

    // Own the bytes before the first await so caller mutations cannot change
    // what is detected or returned. Do not persist caller-controlled metadata.
    const body = new Uint8Array(input.body);
    if (isJson(body)) return unknown("audio_json_response");
    let detected;
    try {
        detected = await fileTypeFromBuffer(body, { maxBufferSize: input.maxBytes });
    } catch {
        return unknown("audio_detection_failed");
    }
    if (!detected) return unknown("audio_unrecognized");
    if (detected.ext !== format || detected.mime !== contentType) return unknown("audio_format_mismatch");
    return {
        status: "candidate", upstreamStatus: 200, format, sizeBytes: body.byteLength,
        contentType, candidateBytes: body,
        validation: { level: "signature", detector: "file-type@22.2.0" },
        usageEvidence: { status: "missing", source: "audio_speech_binary" },
        durationEvidence: { status: "missing" },
    };
}
