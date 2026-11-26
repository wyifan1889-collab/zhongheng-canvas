import { describe, expect, test } from "bun:test";
import {
    GenerationContractError,
    parseGenerationIdempotencyKey,
    parseGenerationIntent,
    parseGenerationSubmission,
} from "../src/generation-contract";

describe("public generation request contract", () => {
    test("accepts task intent and maps public fields to server snapshots", () => {
        expect(parseGenerationIntent({
            modelId: "text-demo",
            input: { prompt: "hello" },
            parameters: { max_tokens: 32 },
            projectId: "project-1",
        })).toEqual({
            modelId: "text-demo",
            inputSnapshot: { prompt: "hello" },
            parameterSnapshot: { max_tokens: 32 },
            projectId: "project-1",
        });
    });

    test("rejects client pricing, provider and unknown fields", () => {
        for (const body of [
            { modelId: "text-demo", input: {}, parameters: {}, quotedUnits: 1 },
            { modelId: "text-demo", input: {}, parameters: {}, apiKey: "secret" },
            { modelId: "text-demo", input: {}, parameters: {}, providerEndpoint: "https://provider.example" },
            { modelId: "text-demo", input: {}, parameters: {}, extra: true },
        ]) {
            expect(() => parseGenerationIntent(body)).toThrowError(GenerationContractError);
            expect(() => parseGenerationIntent(body)).toThrow("生成请求字段或格式不正确");
        }
    });

    test("requires object snapshots and a valid model id", () => {
        expect(() => parseGenerationIntent({ modelId: "bad id", input: {}, parameters: {} })).toThrow("生成请求字段或格式不正确");
        expect(() => parseGenerationIntent({ modelId: "text-demo", input: [], parameters: {} })).toThrow("生成请求字段或格式不正确");
        expect(() => parseGenerationIntent({ modelId: "text-demo", input: {}, parameters: [] })).toThrow("生成请求字段或格式不正确");
    });

    test("submissions require a confirmed version without accepting a client credit total", () => {
        const intent = { modelId: "image-demo", input: { prompt: "one image" }, parameters: {} };
        expect(parseGenerationSubmission({ ...intent, confirmedPriceVersion: 7 })).toMatchObject({ modelId: "image-demo", confirmedPriceVersion: 7 });
        for (const version of [undefined, null, 0, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => parseGenerationSubmission({ ...intent, confirmedPriceVersion: version })).toThrowError(GenerationContractError);
        }
        expect(() => parseGenerationSubmission({ ...intent, confirmedPriceVersion: 7, quotedUnits: 1 })).toThrowError(GenerationContractError);
    });
});

describe("generation idempotency contract", () => {
    test("accepts stable header tokens and rejects missing or unsafe values", () => {
        expect(parseGenerationIdempotencyKey("gen-01:retry")).toBe("gen-01:retry");
        expect(() => parseGenerationIdempotencyKey(null)).toThrow("缺少 Idempotency-Key");
        expect(() => parseGenerationIdempotencyKey("with space")).toThrow("Idempotency-Key 格式或长度不正确");
        expect(() => parseGenerationIdempotencyKey("a".repeat(199))).toThrow("Idempotency-Key 格式或长度不正确");
    });
});
