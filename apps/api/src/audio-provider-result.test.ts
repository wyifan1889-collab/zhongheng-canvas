import { describe, expect, test } from "bun:test";
import { fileTypeFromBuffer } from "file-type";
import { normalizeAudioProviderResult, type AudioProviderResponse } from "./audio-provider-result";

// Synthetic file envelopes/frames, not downloaded media or real TTS output.
function wav(): Uint8Array {
    const body = Buffer.alloc(52);
    body.write("RIFF", 0);
    body.writeUInt32LE(body.length - 8, 4);
    body.write("WAVEfmt ", 8);
    body.writeUInt32LE(16, 16);
    body.writeUInt16LE(1, 20); // PCM
    body.writeUInt16LE(1, 22); // mono
    body.writeUInt32LE(24_000, 24);
    body.writeUInt32LE(48_000, 28);
    body.writeUInt16LE(2, 32);
    body.writeUInt16LE(16, 34);
    body.write("data", 36);
    body.writeUInt32LE(8, 40);
    return new Uint8Array(body);
}

function mp3(): Uint8Array {
    // Two MPEG-1 Layer III 128kbps / 44.1kHz frame headers, zero-filled payload.
    // No claim is made that a decoder validates or plays these synthetic frames.
    const body = new Uint8Array(834);
    body.set([0xff, 0xfb, 0x90, 0x64], 0);
    body.set([0xff, 0xfb, 0x90, 0x64], 417);
    return body;
}

const text = (value: string) => new TextEncoder().encode(value);
const response = (changes: Partial<AudioProviderResponse> = {}): AudioProviderResponse => ({
    upstreamStatus: 200, contentType: "audio/wav", body: wav(), requestedFormat: "wav",
    maxBytes: 4096, // Synthetic test policy only, not a product default.
    ...changes,
});

describe("binary Speech delivery candidates", () => {
    test.each([
        ["mp3", "audio/mpeg", mp3()],
        ["wav", "audio/wav", wav()],
    ] as const)("recognizes %s bytes with the real dependency", async (format, contentType, body) => {
        expect(await fileTypeFromBuffer(body)).toEqual({ ext: format, mime: contentType });
        const result = await normalizeAudioProviderResult(response({ requestedFormat: format, contentType, body }));
        expect(result).toMatchObject({ status: "candidate", upstreamStatus: 200, format, sizeBytes: body.byteLength,
            contentType, candidateBytes: body, validation: { level: "signature", detector: "file-type@22.2.0" },
            usageEvidence: { status: "missing", source: "audio_speech_binary" }, durationEvidence: { status: "missing" } });
        expect(result).not.toHaveProperty("asset");
        expect(result).not.toHaveProperty("kind");
        expect(result).not.toHaveProperty("body");
        expect(result).not.toHaveProperty("consumedUnits");
        expect(result).not.toHaveProperty("durationMs");
        expect(result).not.toHaveProperty("providerTaskId");
        expect(result).not.toHaveProperty("usageEvidence.inputTokens");
    });

    test("normalizes only MIME casing and surrounding spaces", async () => {
        expect(await normalizeAudioProviderResult(response({ contentType: "  AuDiO/WaV  " }))).toHaveProperty("status", "candidate");
    });

    test("owns bytes before asynchronous detection and after returning", async () => {
        const body = wav();
        const original = new Uint8Array(body);
        const pending = normalizeAudioProviderResult(response({ body }));
        body.fill(0);
        const result = await pending;
        expect(result.status).toBe("candidate");
        if (result.status !== "candidate") throw new Error("Expected signature candidate");
        expect(result.candidateBytes).toEqual(original);
        expect(result.candidateBytes).not.toBe(body);
        result.candidateBytes.fill(1);
        expect(body.every((byte) => byte === 0)).toBe(true);
    });

    test("snapshots HTTP metadata across asynchronous detection", async () => {
        const input = response({ body: mp3() }); // Detected format differs after await.
        const pending = normalizeAudioProviderResult(input);
        input.upstreamStatus = 429;
        expect(await pending).toEqual({ status: "unknown", code: "audio_format_mismatch", upstreamStatus: 200, retryable: false });
    });

    test("documents the signature-only blind spot instead of claiming complete WAV validation", async () => {
        const headerOnly = wav().slice(0, 12);
        const result = await normalizeAudioProviderResult(response({ body: headerOnly }));
        expect(result).toMatchObject({ status: "candidate", sizeBytes: 12, validation: { level: "signature" },
            usageEvidence: { status: "missing" }, durationEvidence: { status: "missing" } });
        expect(result).not.toHaveProperty("asset");
        expect(result).not.toHaveProperty("kind");
        expect(result).not.toHaveProperty("body");
        expect(result).not.toHaveProperty("decoded");
    });
});

describe("binary Speech protocol rejection", () => {
    test.each([null, "", "   "])("rejects missing Content-Type %p", async (contentType) => {
        expect(await normalizeAudioProviderResult(response({ contentType }))).toMatchObject({ status: "unknown", code: "audio_content_type_missing", retryable: false });
    });

    test.each([
        "audio/wav, audio/mpeg", "audio/wav, audio/wav", "audio/wav\r\n", "application/json", "text/html",
        "text/event-stream", "application/octet-stream", "audio/pcm", "audio/flac", "audio/ogg", "audio/aac",
        "audio/x-wav", "audio/vnd.wave", "audio/wav; codecs=pcm", "audio/wav; charset=binary",
    ])("rejects unsupported or contradictory Content-Type %s", async (contentType) => {
        expect(await normalizeAudioProviderResult(response({ contentType }))).toMatchObject({ status: "unknown", code: "audio_content_type_unsupported", retryable: false });
    });

    test.each(["pcm", "opus", "aac", "flac", "", "MP3"])("explicitly rejects unimplemented requested format %s", async (requestedFormat) => {
        expect(await normalizeAudioProviderResult(response({ requestedFormat }))).toMatchObject({ status: "unknown", code: "audio_format_unsupported" });
    });

    test("rejects requested format and declared MIME disagreement", async () => {
        expect(await normalizeAudioProviderResult(response({ contentType: "audio/mpeg" }))).toMatchObject({ status: "unknown", code: "audio_content_type_mismatch" });
    });

    test.each([
        ["wav", "audio/wav", mp3()],
        ["mp3", "audio/mpeg", wav()],
    ] as const)("rejects bytes disguised as %s", async (requestedFormat, contentType, body) => {
        expect(await normalizeAudioProviderResult(response({ requestedFormat, contentType, body }))).toMatchObject({ status: "unknown", code: "audio_format_mismatch" });
    });

    test.each([
        '{"error":{"message":"synthetic failure https://never-return.example"}}',
        '{"code":0,"data":"not-audio"}', '[]', '"audio data"', '0', 'null', '\ufeff{"error":"BOM"}',
    ])("rejects JSON masquerading as audio without leaking the payload", async (json) => {
        const result = await normalizeAudioProviderResult(response({ contentType: "audio/mpeg", requestedFormat: "mp3", body: text(json) }));
        expect(result).toEqual({ status: "unknown", code: "audio_json_response", upstreamStatus: 200, retryable: false });
        expect(JSON.stringify(result)).not.toContain("never-return.example");
    });

    test.each(["<html>synthetic gateway error</html>", "event: speech.audio.done\ndata: {}\n\n", "unrecognized bytes"])("rejects non-audio bytes %s", async (value) => {
        expect(await normalizeAudioProviderResult(response({ body: text(value) }))).toMatchObject({ status: "unknown", code: "audio_unrecognized" });
    });

    test("rejects empty, oversized and unusably truncated bodies", async () => {
        expect(await normalizeAudioProviderResult(response({ body: new Uint8Array() }))).toHaveProperty("code", "audio_body_invalid");
        expect(await normalizeAudioProviderResult(response({ maxBytes: 51 }))).toHaveProperty("code", "audio_body_too_large");
        expect(await normalizeAudioProviderResult(response({ body: wav().slice(0, 2) }))).toHaveProperty("code", "audio_unrecognized");
        expect(await normalizeAudioProviderResult(response({ body: text("ID3") }))).toMatchObject({ status: "unknown" });
    });

    test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid caller maxBytes %s", async (maxBytes) => {
        await expect(normalizeAudioProviderResult(response({ maxBytes }))).rejects.toBeInstanceOf(TypeError);
    });

    test.each([400, 401, 403, 404, 429])("keeps explicit HTTP %s rejection distinct from unknown", async (upstreamStatus) => {
        expect(await normalizeAudioProviderResult(response({ upstreamStatus, contentType: "application/json", body: text('{"error":"synthetic"}') })))
            .toEqual({ status: "failed", code: "provider_rejected", upstreamStatus, retryable: false });
    });

    test.each([408, 499, 418])("keeps unverified 4xx %p unknown", async (upstreamStatus) => {
        expect(await normalizeAudioProviderResult(response({ upstreamStatus })))
            .toEqual({ status: "unknown", code: "audio_http_response_unknown", upstreamStatus, retryable: false });
    });

    test.each([0, 199, 201, 202, 204, 206, 302, 500, 502, 599, 600, 400.5])("keeps uncontracted HTTP %s unknown without a retry", async (upstreamStatus) => {
        expect(await normalizeAudioProviderResult(response({ upstreamStatus })))
            .toEqual({ status: "unknown", code: "audio_http_response_unknown", upstreamStatus, retryable: false });
    });
});
