import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { normalizeChatTtsAudioResult } from "./audio-chat-result";

const model = "gemini-3.8-flash-tts";
// Synthetic bytes test the transport envelope only, not WAV validity or spoken content.
const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0xff]);
const wrapper = (base64: string) => `[media](data:audio/wav;base64,${base64})`;
const content = wrapper(bytes.toString("base64"));
const message = (value: unknown = content) => ({ role: "assistant", content: value });
const completion = (value: unknown = content) => ({ model, choices: [{ message: message(value), finish_reason: "stop" }] });
const unknownResponse = { status: "unknown", code: "provider_response_unknown", retryable: false };

describe("complete Chat TTS data URI", () => {
    test("unwraps one exact envelope without converting provider usage into billing", () => {
        const result = normalizeChatTtsAudioResult({ ...completion(), usage: { prompt_tokens: 999, total_tokens: 999 } }, model, bytes.length);
        expect(result).toEqual({ status: "succeeded", upstreamStatus: 200, contentType: "audio/wav", body: bytes, source: "audio_chat_data_uri" });
        expect(result).not.toHaveProperty("usage");
        expect(result).not.toHaveProperty("consumedUnits");
    });

    test.each([Buffer.from([0]), Buffer.from([0, 1]), Buffer.from([0, 1, 2])])("accepts canonical base64 padding for %p", (body) => {
        expect(normalizeChatTtsAudioResult(completion(wrapper(body.toString("base64"))), model, body.length))
            .toMatchObject({ status: "succeeded", body });
    });

    test("checks decoded length even when the encoded length fits the same base64 block", () => {
        expect(normalizeChatTtsAudioResult(completion(wrapper("AAEC")), model, 2)).toEqual(unknownResponse);
        expect(normalizeChatTtsAudioResult(completion(), model, bytes.length - 1)).toEqual(unknownResponse);
        expect(normalizeChatTtsAudioResult(completion(wrapper("AA==")), model, 1)).toHaveProperty("status", "succeeded");
    });

    test("does not mistake unwrapped bytes for validated WAV media", () => {
        const result = normalizeChatTtsAudioResult(completion(wrapper("AA==")), model, 1);
        expect(result).toMatchObject({ status: "succeeded", body: Buffer.from([0]) });
        expect(result).not.toHaveProperty("asset");
        expect(result).not.toHaveProperty("technicalAudio");
    });
});

describe("unverified Chat TTS remains unknown without a retry", () => {
    test.each([
        null, undefined, [], "plain response", 1,
        { choices: completion().choices },
        { ...completion(), model: "gemini-3.8-flash-tts-preview" },
        { ...completion(), model: model.toUpperCase() },
        { ...completion(), error: { message: "provider error" } },
        { ...completion(), choices: [] },
        { ...completion(), choices: [...completion().choices, ...completion().choices] },
        { ...completion(), choices: {} },
        { ...completion(), choices: [null] },
        { ...completion(), choices: [{ delta: message(), finish_reason: "stop" }] },
        { ...completion(), choices: [{ message: message(), delta: {}, finish_reason: "stop" }] },
        { ...completion(), choices: [{ message: message(), finish_reason: "length" }] },
        { ...completion(), choices: [{ message: message() }] },
        { ...completion(), choices: [{ message: { role: "user", content }, finish_reason: "stop" }] },
        { ...completion(), choices: [{ message: { ...message(), audio: { data: "AA==" } }, finish_reason: "stop" }] },
    ].map(value => [value] as const))("rejects an incomplete, contradictory or different response %p", (payload) => {
        expect(normalizeChatTtsAudioResult(payload, model, 100)).toEqual(unknownResponse);
    });

    test.each([
        null, [], { type: "audio", data: "AA==" },
        "https://example.com/audio.wav", "[media](https://example.com/audio.wav)",
        "<audio src='https://example.com/audio.wav'></audio>", "read this text",
        `${content}\n`, ` ${content}`, `${content}${content}`, `prefix ${content}`, `${content} suffix`,
        content.replace("[media]", "[audio]"), content.replace("audio/wav", "audio/mpeg"),
        content.replace("data:", "DATA:"), content.slice(0, -1),
    ].map(value => [value] as const))("rejects content outside the observed single WAV wrapper %p", (value) => {
        expect(normalizeChatTtsAudioResult(completion(value), model, 100)).toEqual(unknownResponse);
    });

    test.each(["", "AQ", "AQ===", "AQ==\n", "AQ ==", "_w==", "AA?=", "AB==", "AAB="])("rejects noncanonical base64 %s", (base64) => {
        expect(normalizeChatTtsAudioResult(completion(wrapper(base64)), model, 100)).toEqual(unknownResponse);
    });

    test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid maximum size %s", (maxBytes) => {
        expect(normalizeChatTtsAudioResult(completion(), model, maxBytes)).toEqual(unknownResponse);
    });

    test("requires a nonempty exact expected model", () => {
        expect(normalizeChatTtsAudioResult({ ...completion(), model: "" }, "", 100)).toEqual(unknownResponse);
    });
});
