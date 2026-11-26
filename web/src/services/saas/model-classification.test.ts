import { describe, expect, test } from "bun:test";
import { inferProviderModel } from "./model-classification";

describe("provider directory classification suggestions", () => {
    test("distinguishes image and video aliases before broad text families", () => {
        expect(inferProviderModel("gpt-image-2-high")).toEqual({ brand: "OpenAI", capability: "image" });
        expect(inferProviderModel("gemini-2.5-flash-image")).toEqual({ brand: "Google", capability: "image" });
        expect(inferProviderModel("grok-imagine-video")).toEqual({ brand: "xAI", capability: "video" });
        expect(inferProviderModel("veo-3.1").capability).toBe("video");
        expect(inferProviderModel("Qwen/Qwen-Image").capability).toBe("image");
    });
    test("accepts namespaces and leaves ambiguous or unknown models for confirmation", () => {
        expect(inferProviderModel("deepseek-ai/DeepSeek-V3")).toEqual({ brand: "DeepSeek", capability: "text" });
        expect(inferProviderModel("claude-sonnet-4").capability).toBe("text");
        expect(inferProviderModel("gpt-4o-audio-preview").capability).toBeNull();
        expect(inferProviderModel("qwen3-embedding").capability).toBeNull();
        expect(inferProviderModel("custom-channel-model")).toEqual({ brand: null, capability: null });
        expect(inferProviderModel(" ")).toEqual({ brand: null, capability: null });
    });
    test("CATALOG-03 recognizes the three catalogued speech names without assuming nearby aliases or music are speech", () => {
        for (const model of ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview"]) expect(inferProviderModel(model)).toEqual({ brand: "Google", capability: "audio" });
        expect(inferProviderModel("grok-voice-latest")).toEqual({ brand: "xAI", capability: "audio" });
        for (const model of ["gemini-3.8-flash-tts-preview", "gemini-other-tts", "grok-tts", "lyria-3-pro", "suno-v6-mini"]) expect(inferProviderModel(model).capability).not.toBe("audio");
    });
});
