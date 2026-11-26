import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generationPng64x48 as png } from "./fixtures/generation-png";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { modelCatalog, modelProvider, user } from "@infinite-canvas/database/schema";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createTestDatabase } from "./database";
import { createGenerationProvider } from "../src/generation-provider";
import { createProviderGateway } from "../src/provider-gateway";
import { normalizeChatUsage, parseTextUsageEvidence } from "../../../packages/shared/src/text-usage";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const authSecret = "generation-provider-test-secret-" + crypto.randomUUID();
const pngBytes = Buffer.from(png, "base64").length;

beforeAll(async () => {
    if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("This suite requires isolated in-memory PGlite");
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: ownerId, name: "Provider owner", email: `${ownerId}@example.test` });
    await database.db.insert(modelProvider).values({
        id: "provider-generation-test", displayName: "Generation test provider", adapter: "openai-compatible",
        endpoint: "https://provider.example/v1", secretRef: "GENERATION_TEST_PROVIDER", enabled: true,
    });
    await database.db.insert(modelProvider).values({
        id: "provider-sub2api-test", displayName: "Sub2API generation provider", adapter: "sub2api",
        endpoint: "https://sub2api.example/v1", secretRef: "SUB2API_GENERATION_TEST", enabled: true,
    });
    await database.db.insert(modelProvider).values([
        { id: "provider-disabled-test", displayName: "Disabled generation provider", adapter: "openai-compatible", endpoint: "https://disabled.example/v1", secretRef: "DISABLED_GENERATION_TEST", enabled: false },
        { id: "provider-missing-credential-test", displayName: "Missing credential provider", adapter: "openai-compatible", endpoint: "https://missing-credential.example/v1", secretRef: "MISSING_CREDENTIAL_GENERATION_TEST", enabled: true },
        { id: "provider-root-test", displayName: "Root endpoint provider", adapter: "openai-compatible", endpoint: "https://root.example/", secretRef: "ROOT_GENERATION_TEST", enabled: true },
    ]);
    await saveProviderCredential(database.db, authSecret, "provider-generation-test", "server-provider-secret");
    await saveProviderCredential(database.db, authSecret, "provider-sub2api-test", "sub2api-provider-secret");
    await saveProviderCredential(database.db, authSecret, "provider-root-test", "root-provider-secret");
    await database.db.insert(modelCatalog).values([
        { id: "generation-text-model", providerId: "provider-generation-test", publicId: "generation-text", providerModel: "gpt-test", displayName: "Generation text", capability: "text", enabled: true },
        { id: "generation-text-root-model", providerId: "provider-root-test", publicId: "generation-text-root", providerModel: "opaque/text-model", displayName: "Root text", capability: "text", enabled: true },
        { id: "generation-image-model", providerId: "provider-generation-test", publicId: "generation-image", providerModel: "image-test", displayName: "Generation image", capability: "image", enabled: true },
        { id: "generation-image-root-model", providerId: "provider-root-test", publicId: "generation-image-root", providerModel: "opaque/image-model", displayName: "Root image", capability: "image", enabled: true },
        { id: "generation-known-image-model", providerId: "provider-generation-test", publicId: "generation-known-image", providerModel: "gpt-image-2", displayName: "Known image without specification pricing", capability: "image", enabled: true },
        { id: "generation-video-model", providerId: "provider-generation-test", publicId: "generation-video", providerModel: "video-test", displayName: "Generation video", capability: "video", enabled: true },
        { id: "generation-audio-model", providerId: "provider-generation-test", publicId: "generation-audio", providerModel: "audio-test", displayName: "Generation audio", capability: "audio", enabled: true },
        { id: "generation-sub2api-model", providerId: "provider-sub2api-test", publicId: "generation-sub2api", providerModel: "sub2api-test", displayName: "Generation sub2api", capability: "text", enabled: true },
        { id: "generation-disabled-model", providerId: "provider-disabled-test", publicId: "generation-disabled", providerModel: "disabled-test", displayName: "Generation disabled", capability: "text", enabled: true },
        { id: "generation-missing-credential-model", providerId: "provider-missing-credential-test", publicId: "generation-missing-credential", providerModel: "missing-credential-test", displayName: "Generation missing credential", capability: "text", enabled: true },
    ]);
});

afterAll(async () => { await database?.close(); });

async function task(modelId = "generation-text", billingUnitSnapshot?: "request" | "output_token", snapshots?: Pick<GenerationTaskView, "inputSnapshot" | "parameterSnapshot">) {
    return (await createGenerationTaskRepository(database.db).create({
        ownerId, inputSnapshot: { prompt: "hello" }, modelId, parameterSnapshot: { temperature: 0.4, unknown: "discard" },
        ...snapshots,
        ...(billingUnitSnapshot ? { priceVersion: 1, quotedUnits: 2, billingUnitSnapshot, creditsPerUnitSnapshot: 3 } : {}),
        idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID(),
    })).task;
}

async function imageTask(modelId = "generation-image", parameters: Record<string, unknown> = {}) {
    return task(modelId, "request", { inputSnapshot: { prompt: "draw four colored squares" }, parameterSnapshot: parameters });
}

describe("Chat Completions usage evidence", () => {
    test("normalizes reported and derived totals without adding cached or reasoning subsets", () => {
        const usage = { prompt_tokens: 12, input_tokens: 12, completion_tokens: 8, output_tokens: 8, total_tokens: 20,
            prompt_tokens_details: { cached_tokens: 5, audio_tokens: 0 }, input_tokens_details: { cached_tokens: 5 },
            completion_tokens_details: { reasoning_tokens: 3 }, output_tokens_details: { reasoning_tokens: 3 }, privateKey: "must-not-store" };
        const reported = normalizeChatUsage(usage);
        expect(reported).toEqual({ schemaVersion: 1, source: "chat_completions", status: "complete", inputTokens: 12, outputTokens: 8,
            totalTokens: 20, totalSource: "reported", cachedInputTokens: 5, reasoningOutputTokens: 3, reason: null });
        expect(parseTextUsageEvidence(reported)).toEqual(reported);
        expect(JSON.stringify(reported)).not.toContain("must-not-store");
        const derived = normalizeChatUsage({ input_tokens: 12, output_tokens: 8 });
        expect(derived).toMatchObject({ status: "complete", totalTokens: 20, totalSource: "derived", cachedInputTokens: null, reasoningOutputTokens: null });
        expect(parseTextUsageEvidence(derived)).toEqual(derived);
        expect(normalizeChatUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toMatchObject({ status: "complete", totalTokens: 0 });
    });

    test("keeps missing usage separate from zero and preserves only known partial counts", () => {
        for (const [raw, expected] of [
            [undefined, { reason: "missing_usage", inputTokens: null, outputTokens: null, totalTokens: null }],
            [{}, { reason: "missing_counts", inputTokens: null, outputTokens: null, totalTokens: null }],
            [{ completion_tokens: 2 }, { reason: "missing_counts", inputTokens: null, outputTokens: 2, totalTokens: null }],
            [{ prompt_tokens: 4, total_tokens: 7, prompt_tokens_details: { cached_tokens: 1 } }, { reason: "missing_counts", inputTokens: 4, outputTokens: null, totalTokens: 7, cachedInputTokens: 1 }],
        ] as const) {
            const evidence = normalizeChatUsage(raw);
            expect(evidence).toMatchObject({ status: "missing", ...expected });
            expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
        }
    });

    test("rejects malformed counts, aliases, inconsistent totals and overflow with no surviving numbers", () => {
        const cases: Array<[unknown, string]> = [
            [null, "invalid_counts"], [[], "invalid_counts"], ["usage", "invalid_counts"],
            ...[null, undefined, "3", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value): [unknown, string] => [{ prompt_tokens: value, completion_tokens: 2 }, "invalid_counts"]),
            [{ prompt_tokens: 3, input_tokens: 4, completion_tokens: 2 }, "conflicting_counts"],
            [{ prompt_tokens: 3, completion_tokens: 2, output_tokens: 3 }, "conflicting_counts"],
            [{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 6 }, "inconsistent_total"],
            [{ prompt_tokens: 3, total_tokens: 2 }, "inconsistent_total"],
            [{ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }, "inconsistent_total"],
        ];
        for (const [raw, reason] of cases) {
            const evidence = normalizeChatUsage(raw);
            expect(evidence).toMatchObject({ status: "invalid", reason, inputTokens: null, outputTokens: null, totalTokens: null,
                totalSource: null, cachedInputTokens: null, reasoningOutputTokens: null });
            expect(parseTextUsageEvidence(evidence)).toEqual(evidence);
        }
    });

    test("rejects malformed or contradictory details and children outside their parent counts", () => {
        for (const details of [
            { prompt_tokens_details: null }, { completion_tokens_details: [] },
            { prompt_tokens_details: { cached_tokens: null } }, { completion_tokens_details: { reasoning_tokens: "1" } },
            { prompt_tokens_details: { cached_tokens: 4 } }, { completion_tokens_details: { reasoning_tokens: 3 } },
            { prompt_tokens_details: { cached_tokens: 1 }, input_tokens_details: { cached_tokens: 2 } },
            { completion_tokens_details: { reasoning_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } },
        ]) expect(normalizeChatUsage({ prompt_tokens: 3, completion_tokens: 2, ...details })).toMatchObject({ status: "invalid", reason: "invalid_details", inputTokens: null });
        expect(normalizeChatUsage({ completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } })).toMatchObject({ status: "invalid", reason: "invalid_details" });
    });

    test("parses only the complete evidence whitelist with consistent state and arithmetic", () => {
        const complete = normalizeChatUsage({ prompt_tokens: 3, completion_tokens: 2 });
        for (const changed of [
            { secret: "must-not-leak" }, { schemaVersion: 2 }, { source: "provider_estimate" }, { status: "missing" },
            { reason: "missing_counts" }, { totalTokens: 6 }, { totalSource: null }, { inputTokens: null },
            { inputTokens: "3" }, { cachedInputTokens: 4 }, { reasoningOutputTokens: 3 },
        ]) expect(parseTextUsageEvidence({ ...complete, ...changed })).toBeNull();
        const { reason: _reason, ...incomplete } = complete;
        expect(parseTextUsageEvidence(incomplete)).toBeNull();
        expect(parseTextUsageEvidence({ ...normalizeChatUsage(undefined), outputTokens: 0 })).toBeNull();
        expect(parseTextUsageEvidence({ ...normalizeChatUsage(null), totalSource: "reported" })).toBeNull();
        expect(parseTextUsageEvidence({ ...normalizeChatUsage(null), reason: "missing_usage" })).toBeNull();
        expect(parseTextUsageEvidence({ ...normalizeChatUsage({ completion_tokens: 2 }), totalSource: "derived" })).toBeNull();
    });
});

describe("generation provider adapter boundary", () => {
    test("loads the enabled catalogue binding, sends a safe text request, and stores normalized usage", async () => {
        let observed: { target: unknown; path: string; body: unknown } | null = null;
        const provider = createGenerationProvider({
            database: database.db,
            authSecret,
            gateway: {
                async request(input) {
                    observed = { target: input.target, path: input.path, body: input.body };
                    return { status: "succeeded", upstreamStatus: 200, payload: {
                        id: "provider-result-1",
                        choices: [{ message: { role: "assistant", content: "hello back" } }],
                        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
                    } };
                },
            },
        });
        const result = await provider(await task());
        expect(observed).toMatchObject({ path: "chat/completions", body: { model: "gpt-test", messages: [{ role: "user", content: "hello" }], temperature: 0.4 } });
        expect((observed?.target as { credential: string }).credential).toBe("server-provider-secret");
        expect(result).toEqual({
            status: "succeeded", providerStatus: 200, providerTaskId: "provider-result-1",
            resultSnapshot: { kind: "text", text: "hello back", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
                usageEvidence: normalizeChatUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) },
        });
        expect(JSON.stringify(result)).not.toContain("server-provider-secret");
    });

    test("maps only an explicit request or output-token billing snapshot to consumed units", async () => {
        const provider = createGenerationProvider({
            database: database.db,
            authSecret,
            gateway: { async request() { return { status: "succeeded", upstreamStatus: 200, payload: {
                choices: [{ message: { content: "metered" } }], usage: { prompt_tokens: 3, completion_tokens: 2 },
            } }; } },
        });
        expect(await provider(await task("generation-text", "output_token"))).toMatchObject({ status: "succeeded", consumedUnits: 2 });
        expect(await provider(await task("generation-text", "request"))).toMatchObject({ status: "succeeded", consumedUnits: 1 });
        expect(await provider(await task())).not.toHaveProperty("consumedUnits");
    });

    test("rejects unavailable delivery, missing quotes and catalogue bindings before contacting a provider", async () => {
        let calls = 0;
        const provider = createGenerationProvider({
            database: database.db,
            authSecret,
            gateway: { async request() { calls += 1; return { status: "failed", code: "provider_rejected" }; } },
        });
        expect(await provider(await task("generation-image"))).toEqual({ status: "failed", errorCode: "image_delivery_unavailable" });
        // Unquoted video views must fail before dispatch; the database also refuses to persist them.
        expect(await provider({ ...(await task()), modelId: "generation-video" })).toEqual({ status: "failed", errorCode: "model_unavailable" });
        expect(await provider(await task("generation-audio"))).toEqual({ status: "failed", errorCode: "model_unavailable" });
        expect(await provider(await task("generation-sub2api"))).toEqual({ status: "failed", errorCode: "provider_adapter_unsupported" });
        expect(await provider(await task("generation-disabled"))).toEqual({ status: "failed", errorCode: "model_unavailable" });
        expect(await provider(await task("generation-missing-credential"))).toEqual({ status: "failed", errorCode: "model_unavailable" });
        expect(await provider({ ...(await task()), modelId: "missing-model" })).toEqual({ status: "failed", errorCode: "model_unavailable" });
        expect(calls).toBe(0);
    });

    test("maps provider rejection, timeout, and malformed success without exposing upstream details", async () => {
        const queue = [
            { status: "failed" as const, code: "provider_rejected" as const },
            { status: "unknown" as const, code: "provider_timeout" as const, retryable: false as const },
            { status: "succeeded" as const, upstreamStatus: 200, payload: { choices: [{ message: { content: "" } }] } },
        ];
        const provider = createGenerationProvider({
            database: database.db,
            authSecret,
            gateway: { async request() { return queue.shift()!; } },
        });
        expect(await provider(await task())).toEqual({ status: "failed", errorCode: "provider_rejected" });
        expect(await provider(await task())).toEqual({ status: "unknown", errorCode: "provider_timeout", unknownReason: "provider_timeout" });
        expect(await provider(await task())).toEqual({ status: "unknown", errorCode: "provider_text_invalid_response", unknownReason: "provider_text_invalid_response" });
    });

    test("never makes partial or invalid token evidence billable, while explicit request pricing stays per request", async () => {
        const baseline = await task("generation-text", "output_token");
        for (const usage of [undefined, { completion_tokens: 2 }, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 99 }, { prompt_tokens: 3, completion_tokens: null }]) {
            const provider = createGenerationProvider({ database: database.db, authSecret,
                gateway: { async request() { return { status: "succeeded", upstreamStatus: 200, payload: { choices: [{ message: { content: "usable text" } }], usage } }; } },
            });
            const result = await provider(baseline);
            expect(result).toMatchObject({ status: "succeeded", resultSnapshot: { usageEvidence: normalizeChatUsage(usage) } });
            expect(result).not.toHaveProperty("consumedUnits");
            expect(result.resultSnapshot).not.toHaveProperty("usage");
            expect(await provider({ ...baseline, billingUnitSnapshot: "request" })).toMatchObject({ status: "succeeded", consumedUnits: 1 });
        }
    });

    test("uses real gateway response handling for text root/v1 paths, invalid 2xx and explicit rejection without retries", async () => {
        const urls: string[] = [];
        const responses = [
            new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })),
            new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })),
            new Response("not-json-private-upstream-data"), new Response(JSON.stringify({ choices: [] })),
            new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] })), new Response("private rejection", { status: 401 }),
        ];
        const provider = createGenerationProvider({ database: database.db, authSecret,
            gateway: createProviderGateway(async (url) => { urls.push(String(url)); const response = responses.shift(); if (!response) throw new Error("unexpected retry"); return response; }, () => ["93.184.216.34"]),
        });
        expect((await provider(await task("generation-text-root", "output_token"))).status).toBe("succeeded");
        const baseline = await task("generation-text", "output_token");
        expect((await provider(baseline)).status).toBe("succeeded");
        for (let index = 0; index < 3; index++) expect(await provider(baseline)).toEqual({ status: "unknown", errorCode: "provider_text_invalid_response", unknownReason: "provider_text_invalid_response" });
        expect(await provider(baseline)).toEqual({ status: "failed", errorCode: "provider_rejected" });
        expect(urls).toEqual(["https://root.example/v1/chat/completions", ...Array(5).fill("https://provider.example/v1/chat/completions")]);
        expect(responses).toHaveLength(0);
    });

    test("keeps a proven pre-request gateway refusal failed without issuing a fetch", async () => {
        let calls = 0;
        const provider = createGenerationProvider({ database: database.db, authSecret,
            gateway: createProviderGateway(async () => { calls++; throw new Error("must not fetch"); }, () => ["127.0.0.1"]),
        });
        expect(await provider(await task("generation-text", "output_token"))).toEqual({ status: "failed", errorCode: "provider_invalid_response" });
        expect(calls).toBe(0);
    });

    test("sends exactly one PNG image request with catalogue model and root or v1 path", async () => {
        const observed: Array<{ path: string; body: unknown }> = [];
        const provider = createGenerationProvider({
            database: database.db, authSecret, imageMaxBytes: pngBytes,
            gateway: { async request(input) {
                observed.push({ path: input.path, body: input.body });
                expect(input.signal).toBeInstanceOf(AbortSignal);
                return { status: "succeeded", upstreamStatus: 200, payload: {
                    id: "private-provider-id", credential: "must-not-store", usage: { total_tokens: 500 },
                    data: [{ b64_json: png, url: "https://private.example/image", revised_prompt: "private prompt" }],
                } };
            } },
        });
        for (const model of ["generation-image", "generation-image-root"]) {
            const result = await provider(await imageTask(model));
            expect(result).toEqual({ status: "succeeded", providerStatus: 200, consumedUnits: 1,
                resultSnapshot: { kind: "image", image: { contentType: "image/png", base64: png } } });
            expect(JSON.stringify(result)).not.toMatch(/private-provider-id|must-not-store|private\.example|private prompt|total_tokens/);
        }
        expect(observed).toEqual([
            { path: "images/generations", body: { model: "image-test", prompt: "draw four colored squares", n: 1, output_format: "png" } },
            { path: "v1/images/generations", body: { model: "opaque/image-model", prompt: "draw four colored squares", n: 1, output_format: "png" } },
        ]);
    });

    test("forwards only explicitly supported image parameters without model-name guessing", async () => {
        const bodies: unknown[] = [];
        const provider = createGenerationProvider({
            database: database.db, authSecret, imageMaxBytes: pngBytes,
            gateway: { async request(input) { bodies.push(input.body); return { status: "succeeded", upstreamStatus: 200, payload: { data: [{ b64_json: png }] } }; } },
        });
        const parameters = { size: "1024x1536", quality: "high", background: "transparent", n: 1, output_format: "png", response_format: "b64_json" };
        expect((await provider(await imageTask("generation-image-root", parameters))).status).toBe("succeeded");
        expect(bodies[0]).toEqual({ model: "opaque/image-model", prompt: "draw four colored squares", ...parameters });
        expect((await provider(await imageTask("generation-image", { size: "auto", quality: "auto", background: "auto" }))).status).toBe("succeeded");
        expect(bodies[1]).not.toHaveProperty("response_format");
    });

    test("rejects image effects, reference inputs and unsupported billing before any provider call", async () => {
        let calls = 0;
        const provider = createGenerationProvider({
            database: database.db, authSecret, imageMaxBytes: pngBytes,
            gateway: { async request() { calls++; throw new Error("must not call"); } },
        });
        const baseline = await imageTask();
        for (const inputSnapshot of [{ prompt: "" }, { prompt: "  " }, { prompt: 5 }, { messages: [] }, { prompt: "edit", images: [] }, { prompt: "edit", image: "https://example.test/photo" }]) {
            expect(await provider({ ...baseline, inputSnapshot })).toEqual({ status: "failed", errorCode: "invalid_generation_input" });
        }
        expect(await provider({ ...baseline, parameterSnapshot: { n: 2 } })).toEqual({ status: "failed", errorCode: "unsupported_image_count" });
        expect(await provider(await imageTask("generation-known-image", { n: 4 }))).toEqual({ status: "failed", errorCode: "unsupported_image_count" });
        for (const parameterSnapshot of [{ n: "1" }, { output_format: "jpeg" }, { response_format: "url" }, { stream: true }, { seed: 1 }, { size: "0x1024" }, { size: "1024x1.5" }, { size: "9007199254740992x1" }, { quality: "ultra" }, { background: "white" }]) {
            expect(await provider({ ...baseline, parameterSnapshot })).toEqual({ status: "failed", errorCode: "invalid_generation_parameters" });
        }
        for (const billingUnitSnapshot of [null, "input_token", "output_token", "second", "megapixel"] as const) {
            expect(await provider({ ...baseline, billingUnitSnapshot })).toEqual({ status: "failed", errorCode: "unsupported_image_billing" });
        }
        expect(calls).toBe(0);
    });

    test("keeps unusable image success unknown and never retries its request", async () => {
        const payloads = [
            { data: [{ url: "https://private.example/image" }] }, { data: [] }, { data: [{ b64_json: "broken" }] },
            { data: [{ b64_json: png + png }] }, { data: [{ b64_json: png }, { b64_json: png }] },
            { data: [{ b64_json: png }], error: { message: "private provider error" } },
            { data: [{ b64_json: png }], success: false },
            { data: [{ b64_json: png, error: "private provider error" }] },
        ];
        let calls = 0;
        const provider = createGenerationProvider({
            database: database.db, authSecret, imageMaxBytes: pngBytes,
            gateway: { async request() { const payload = payloads[calls++]; return { status: "succeeded", upstreamStatus: 200, payload }; } },
        });
        for (let i = 0; i < payloads.length; i++) {
            expect(await provider(await imageTask())).toEqual({ status: "unknown", errorCode: "provider_image_invalid_response", unknownReason: "provider_image_invalid_response" });
            expect(calls).toBe(i + 1);
        }
    });

    test("preserves image rejection versus unknown transport and JSON outcomes without retries", async () => {
        const responses = [
            { status: "failed" as const, code: "provider_rejected" as const },
            { status: "failed" as const, code: "provider_invalid_response" as const },
            { status: "unknown" as const, code: "provider_timeout" as const, retryable: false as const },
            { status: "unknown" as const, code: "provider_unreachable" as const, retryable: false as const },
        ];
        let calls = 0;
        const provider = createGenerationProvider({
            database: database.db, authSecret, imageMaxBytes: pngBytes,
            gateway: { async request() { calls++; const response = responses.shift(); if (!response) throw new Error("upstream secret detail"); return response; } },
        });
        expect(await provider(await imageTask())).toEqual({ status: "failed", errorCode: "provider_rejected" });
        expect(await provider(await imageTask())).toEqual({ status: "unknown", errorCode: "provider_image_invalid_response", unknownReason: "provider_image_invalid_response" });
        expect(await provider(await imageTask())).toEqual({ status: "unknown", errorCode: "provider_timeout", unknownReason: "provider_timeout" });
        expect(await provider(await imageTask())).toEqual({ status: "unknown", errorCode: "provider_unreachable", unknownReason: "provider_unreachable" });
        expect(await provider(await imageTask())).toEqual({ status: "unknown", errorCode: "provider_adapter_exception", unknownReason: "provider_adapter_exception" });
        expect(calls).toBe(5);
    });
});

