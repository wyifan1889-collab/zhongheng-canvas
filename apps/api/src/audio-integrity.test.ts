import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateAudioIntegrity } from "./audio-integrity";
import type { AudioProviderResponse } from "./audio-provider-result";

const fixtureRoot = new URL("../test/fixtures/audio-integrity/", import.meta.url);
const mp3 = new Uint8Array(readFileSync(new URL("silence.mp3", fixtureRoot)));
const wav = new Uint8Array(readFileSync(new URL("sine-24000-mono-s16.wav", fixtureRoot)));
const request = (format: "mp3" | "wav", bytes: Uint8Array, changes: Partial<AudioProviderResponse> = {}): AudioProviderResponse => ({
    upstreamStatus: 200, contentType: format === "mp3" ? "audio/mpeg" : "audio/wav",
    requestedFormat: format, body: bytes, maxBytes: 4096, ...changes, // Fixture policy only.
});
const unsafe = (result: Awaited<ReturnType<typeof validateAudioIntegrity>>) => {
    expect(result.status).toBe("unknown");
    expect(result).toHaveProperty("retryable", false);
    expect(result).not.toHaveProperty("asset");
    expect(result).not.toHaveProperty("consumedUnits");
};

describe("complete local audio decode", () => {
    test("fully decodes a licensed Audacity MP3 and retains the same original media bytes", async () => {
        const result = await validateAudioIntegrity(request("mp3", mp3));
        expect(result.status).toBe("verified");
        if (result.status !== "verified") throw new Error("Expected decoded MP3");
        expect(result.asset).toMatchObject({ kind: "audio", contentType: "audio/mpeg", body: mp3 });
        expect(result.asset.body).not.toBe(mp3);
        expect(result.technicalAudio).toEqual({ source: "decoded_samples", samplesPerChannel: 662, sampleRate: 44_100, channels: 1, durationSeconds: 662 / 44_100 });
        expect(result.validation).toEqual({ decoder: "libav.js@6.10.9/FFmpeg9.0", structure: "contiguous-mpeg-spans",
            demuxEof: true, decoderEof: true, packets: 3, frames: 2 });
        expect(result.usageEvidence).toEqual({ status: "missing", source: "audio_speech_binary" });
        expect(result).not.toHaveProperty("consumedUnits");
        expect(result).not.toHaveProperty("billingSeconds");
    });

    test("fully decodes the standard-library PCM WAV fixture and discards PCM", async () => {
        const result = await validateAudioIntegrity(request("wav", wav));
        expect(result.status).toBe("verified");
        if (result.status !== "verified") throw new Error("Expected decoded WAV");
        expect(result.asset.body).toEqual(wav);
        expect(result.technicalAudio).toEqual({ source: "decoded_samples", samplesPerChannel: 240, sampleRate: 24_000, channels: 1, durationSeconds: 0.01 });
        expect(result.validation).toMatchObject({ structure: "bounded-riff", demuxEof: true, decoderEof: true, packets: 1, frames: 1 });
        expect(result).not.toHaveProperty("channelData");
        expect(result).not.toHaveProperty("consumedUnits");
        expect(result.usageEvidence.status).toBe("missing");
    });

    test.each([
        ["old header only", wav.slice(0, 12)],
        ["no data payload", wav.slice(0, 44)],
        ["missing complete samples", wav.slice(0, -8)],
        ["partial sample", wav.slice(0, -1)],
    ] as const)("rejects WAV %s with no deliverable asset", async (_name, bytes) => {
        unsafe(await validateAudioIntegrity(request("wav", bytes)));
    });

    test("rejects an incomplete MP3 frame that strict decoding alone accepted", async () => {
        const result = await validateAudioIntegrity(request("mp3", mp3.slice(0, -15)));
        unsafe(result);
        expect(result).toHaveProperty("code", "audio_packet_incomplete");
    });

    test.each(["long", "short", "short-data-tail", "outside-tail"])("RIFF rejects contradictory container length: %s", async (mode) => {
        let bytes = new Uint8Array(wav);
        const view = new DataView(bytes.buffer);
        if (mode === "long") view.setUint32(4, wav.length + 100, true);
        if (mode === "short") view.setUint32(4, 40, true);
        if (mode === "short-data-tail") view.setUint32(40, 476, true);
        if (mode === "outside-tail") {
            bytes = new Uint8Array(wav.length + 9);
            bytes.set(wav); bytes.set(new TextEncoder().encode("bad-tail!"), wav.length);
        }
        const result = await validateAudioIntegrity(request("wav", bytes));
        unsafe(result);
        expect(result).toHaveProperty("code", "audio_container_invalid");
    });

    test.each([4, 16, 40])("RIFF bounds an oversized declaration at fixture offset %p before allocation", async (offset) => {
        const bytes = new Uint8Array(wav);
        new DataView(bytes.buffer).setUint32(offset, 0xffff_ffff, true);
        const result = await validateAudioIntegrity(request("wav", bytes));
        unsafe(result);
        expect(result).toHaveProperty("code", "audio_container_invalid");
    });

    function appendRiffChunk(chunk: Uint8Array): Uint8Array {
        const bytes = new Uint8Array(wav.length + chunk.length);
        bytes.set(wav); bytes.set(chunk, wav.length);
        new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
        return bytes;
    }

    test("RIFF consumes a bounded LIST/INFO without decoding metadata text", async () => {
        const list = Buffer.alloc(22);
        list.write("LIST"); list.writeUInt32LE(14, 4); list.write("INFOINAM", 8);
        list.writeUInt32LE(2, 16); list[20] = 0x78;
        const result = await validateAudioIntegrity(request("wav", appendRiffChunk(list)));
        expect(result.status).toBe("verified");
        expect(result).toHaveProperty("technicalAudio.samplesPerChannel", 240);
    });

    test("RIFF rejects a nested child escaping its LIST even when the file has later bytes", async () => {
        const list = Buffer.alloc(22);
        list.write("LIST"); list.writeUInt32LE(14, 4); list.write("INFOINAM", 8);
        list.writeUInt32LE(10, 16); list[20] = 0x78;
        const next = Buffer.from("JUNK\x00\x00\x00\x00", "binary");
        const result = await validateAudioIntegrity(request("wav", appendRiffChunk(Buffer.concat([list, next]))));
        unsafe(result);
        expect(result).toHaveProperty("code", "audio_container_invalid");
    });

    test("RIFF accounts for application metadata as bytes without imposing an inflation budget", async () => {
        const metadata = Buffer.alloc(12);
        metadata.write("ResU"); metadata.writeUInt32LE(4, 4);
        const result = await validateAudioIntegrity(request("wav", appendRiffChunk(metadata)));
        expect(result.status).toBe("verified");
        expect(result).toHaveProperty("technicalAudio.samplesPerChannel", 240);
    });

    test("source coverage rejects inter-frame bytes skipped by the demuxer", async () => {
        const bytes = new Uint8Array(mp3.length + 8);
        bytes.set(mp3.subarray(0, 834));
        bytes.set(new TextEncoder().encode("bad-gap!"), 834);
        bytes.set(mp3.subarray(834), 842);
        const result = await validateAudioIntegrity(request("mp3", bytes));
        unsafe(result);
    });

    test("source coverage rejects an unrecognized MP3 suffix", async () => {
        const bytes = new Uint8Array(mp3.length + 9);
        bytes.set(mp3); bytes.set(new TextEncoder().encode("bad-tail!"), mp3.length);
        const result = await validateAudioIntegrity(request("mp3", bytes));
        unsafe(result);
    });

    test("MPEG metadata is parsed at its exact position rather than searched past", async () => {
        const bytes = new Uint8Array(mp3.length + 10);
        bytes.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]); // Empty ID3v2.3 fixture tag.
        bytes.set(mp3, 10);
        const result = await validateAudioIntegrity(request("mp3", bytes));
        expect(result.status).toBe("verified");
        if (result.status !== "verified") throw new Error("Expected exact ID3 span");
        expect(result.asset.body).toEqual(bytes);
        expect(result.technicalAudio.samplesPerChannel).toBe(662);
    });

    test("rejects corrupted MP3 side information rather than ignoring decoder errors", async () => {
        const corrupted = new Uint8Array(mp3);
        // This fixture's first audio frame starts at 417 after its Xing frame.
        // Corrupt the coded payload, retaining its original sync/header/length.
        corrupted.fill(0xff, 421, 455);
        unsafe(await validateAudioIntegrity(request("mp3", corrupted)));
    });

    test("rejects decoded nonfinite float WAV samples", async () => {
        const nonfinite = new Uint8Array(wav);
        const view = new DataView(nonfinite.buffer);
        // Mutated fixture only: PCM16 -> IEEE float32, keeping valid block lengths.
        view.setUint16(20, 3, true);
        view.setUint32(28, 96_000, true);
        view.setUint16(32, 4, true);
        view.setUint16(34, 32, true);
        view.setFloat32(44, Number.NaN, true);
        const result = await validateAudioIntegrity(request("wav", nonfinite));
        unsafe(result);
        expect(result).toHaveProperty("code", "audio_pcm_invalid");
    });

    test("retains ownership when the source bytes change during asynchronous decode", async () => {
        const bytes = new Uint8Array(wav);
        const pending = validateAudioIntegrity(request("wav", bytes));
        bytes.fill(0);
        const result = await pending;
        expect(result.status).toBe("verified");
        if (result.status !== "verified") throw new Error("Expected owned audio");
        expect(result.asset.body).toEqual(wav);
    });

    test("a failed decode does not contaminate the next decoder instance", async () => {
        unsafe(await validateAudioIntegrity(request("wav", wav.slice(0, 12))));
        const result = await validateAudioIntegrity(request("wav", wav));
        expect(result.status).toBe("verified");
    });

    test("rejects a format conflict before constructing an audio asset", async () => {
        const result = await validateAudioIntegrity(request("mp3", wav));
        unsafe(result);
        expect(result).toHaveProperty("code", "audio_format_mismatch");
    });

    test("keeps existing known HTTP rejection and timeout-like unknown semantics", async () => {
        expect(await validateAudioIntegrity(request("mp3", mp3, { upstreamStatus: 429 })))
            .toEqual({ status: "failed", code: "provider_rejected", upstreamStatus: 429, retryable: false });
        expect(await validateAudioIntegrity(request("mp3", mp3, { upstreamStatus: 408 })))
            .toEqual({ status: "unknown", code: "audio_http_response_unknown", upstreamStatus: 408, retryable: false });
        expect(await validateAudioIntegrity(request("mp3", mp3, { upstreamStatus: 499 })))
            .toEqual({ status: "unknown", code: "audio_http_response_unknown", upstreamStatus: 499, retryable: false });
    });

    test("keeps the caller's compressed-file limit without inventing a PCM budget", async () => {
        const result = await validateAudioIntegrity(request("wav", wav, { maxBytes: wav.length - 1 }));
        unsafe(result);
        expect(result).toHaveProperty("code", "audio_body_too_large");
    });
});
