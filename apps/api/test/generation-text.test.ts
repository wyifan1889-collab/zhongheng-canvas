import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { createGenerationTaskRepository, type GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { modelCatalog, modelProvider, user } from "@infinite-canvas/database/schema";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { buildGenerationTextRequest, normalizeGenerationTextResponse, parseGenerationTextRequest } from "../src/generation-text";
import { createGenerationProvider } from "../src/generation-provider";
import { createProviderGateway, type ProviderRequest } from "../src/provider-gateway";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Only isolated in-memory PGlite is permitted");
const ownerId = crypto.randomUUID(), authSecret = "text-adapter-synthetic-" + crypto.randomUUID();
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: ownerId, name: "Synthetic text adapter owner", email: ownerId + "@example.test" });
});
afterAll(async () => { await database?.close(); });

async function task(adapter: "openai-compatible" | "sub2api", endpoint = "https://provider.example/v1"): Promise<GenerationTaskView> {
    const id = crypto.randomUUID();
    await database.db.insert(modelProvider).values({ id, displayName: "Synthetic provider", adapter, endpoint, secretRef: "synthetic-only", enabled: true });
    await saveProviderCredential(database.db, authSecret, id, "synthetic-provider-private-key");
    await database.db.insert(modelCatalog).values({ id, providerId: id, publicId: id, providerModel: "opaque/model", displayName: "Synthetic text", capability: "text", enabled: true });
    const write: ModelPriceDraftWrite = { modelId: id, expectedVersion: 0,
        binding: { providerId: id, adapter, endpoint, providerModel: "opaque/model", capability: "text" }, priceNote: "Synthetic only",
        rules: { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] } } };
    const saved = await createModelPriceDraft(database.db, write, { actorId: ownerId, requestId: crypto.randomUUID() });
    if (saved.status !== "saved") throw new Error("synthetic draft failed");
    const publication = await publishModelPriceDraft(database.db, { modelId: id, draftId: saved.draft.id, expectedDraftVersion: 1,
        expectedPriceVersion: 0, binding: write.binding, publicPriceNote: "Synthetic text price" }, { actorId: ownerId, requestId: crypto.randomUUID() });
    if (publication.status !== "published") throw new Error("synthetic publication failed: " + publication.status);
    return (await createGenerationTaskRepository(database.db).create({ ownerId, modelId: id, inputSnapshot: { prompt: "hello" }, parameterSnapshot: {},
        priceVersion: 1, textQuoteSnapshot: { schemaVersion: 1, budgetCredits: "1", inputCreditsPerMillion: "2", outputCreditsPerMillion: "4",
            usageSource: adapter === "sub2api" ? "responses" : "chat_completions" }, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() })).task;
}

const responses = () => ({ id: "response-test", status: "completed", error: null,
    output: [{ type: "reasoning", encrypted_content: "do-not-store" }, { type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "hello ", annotations: [{ private: "do-not-store" }] }, { type: "output_text", text: "world" }] }],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } },
    private_key: "do-not-store" });
const chat = () => ({ id: "chat-test", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello world" } }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });

test("pure-text intent is strict and retains existing input bounds without inventing token limits", () => {
    expect(parseGenerationTextRequest({ prompt: " hello " }, {})).toEqual({ messages: [{ role: "user", content: " hello " }] });
    const messages = [{ role: "system", content: "write" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    expect(parseGenerationTextRequest({ messages }, {})).toEqual({ messages });
    for (const input of [{}, { prompt: "" }, { prompt: " " }, { prompt: "x".repeat(100_001) }, { prompt: "hello", messages },
        { prompt: "hello", image: "https://private.invalid" }, { messages: [] }, { messages: Array(65).fill(messages[0]) },
        { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] },
        { messages: [{ role: "user", content: "x", extra: "private" }] }]) {
        expect(parseGenerationTextRequest(input, {})).toEqual({ errorCode: "invalid_generation_input" });
    }
    for (const parameters of [{ temperature: 1 }, { stream: false }, { max_output_tokens: 1 }, { budgetCredits: "1" }, { tools: [] }]) {
        expect(parseGenerationTextRequest({ prompt: "hello" }, parameters)).toEqual({ errorCode: "invalid_generation_parameters" });
    }
});

test("adapter determines one explicit request protocol, with no guessed model behavior or budget forwarding", () => {
    expect(buildGenerationTextRequest("openai-compatible", "opaque/model", { prompt: "hello" }, {})).toEqual({ source: "chat_completions", path: "chat/completions",
        body: { model: "opaque/model", messages: [{ role: "user", content: "hello" }], stream: false } });
    expect(buildGenerationTextRequest("sub2api", "opaque/model", { prompt: "hello" }, {})).toEqual({ source: "responses", path: "responses",
        body: { model: "opaque/model", input: [{ role: "user", content: "hello" }], stream: false, store: false } });
});

test("completed Responses text and safe usage are preserved without raw provider fields or scalar billing", () => {
    const result = normalizeGenerationTextResponse(responses(), "responses");
    expect(result).toMatchObject({ status: "succeeded", providerTaskId: "response-test", resultSnapshot: { kind: "text", text: "hello world",
        usageEvidence: { source: "responses", status: "complete", inputTokens: 12, outputTokens: 8, totalTokens: 20, cachedInputTokens: 5, reasoningOutputTokens: 3 } } });
    expect(result).not.toHaveProperty("consumedUnits");
    expect(JSON.stringify(result)).not.toMatch(/do-not-store|encrypted_content|private_key|annotations/);
});

test("valid delivered text with missing or invalid usage is not made zero-cost or provider-failed", () => {
    for (const usage of [undefined, null, { input_tokens: 1, output_tokens: 2, total_tokens: 9 }]) {
        const result = normalizeGenerationTextResponse({ ...responses(), usage }, "responses");
        expect(result.status).toBe("succeeded");
        expect(result.resultSnapshot?.usageEvidence).toMatchObject({ source: "responses", inputTokens: null, outputTokens: null });
        expect(result).not.toHaveProperty("consumedUnits");
    }
});

test("incomplete, refused, tool-only and reasoning-only Responses retain safe evidence for review", () => {
    for (const payload of [
        { ...responses(), status: "incomplete" }, { ...responses(), status: "failed", error: { message: "do-not-store" } },
        { ...responses(), incomplete_details: { reason: "max_output_tokens" } },
        { ...responses(), output: [{ type: "reasoning" }] },
        { ...responses(), output: [{ type: "function_call", arguments: "do-not-store" }] },
        { ...responses(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "do-not-store" }] }] },
        { ...responses(), output: [{ type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "partial" }] }] },
    ]) {
        const result = normalizeGenerationTextResponse(payload, "responses");
        expect(result).toMatchObject({ status: "unknown", errorCode: "provider_text_invalid_response", resultSnapshot: { usageEvidence: { status: "complete", totalTokens: 20 } } });
        expect(JSON.stringify(result)).not.toContain("do-not-store");
    }
    expect(normalizeGenerationTextResponse({ ...responses(), output_text: "do not trust SDK convenience fields", output: [] }, "responses").status).toBe("unknown");
});

test("budgeted Chat requires a completed single assistant text choice and keeps incomplete usage evidence", () => {
    expect(normalizeGenerationTextResponse(chat(), "chat_completions")).toMatchObject({ status: "succeeded", resultSnapshot: { text: "hello world", usageEvidence: { source: "chat_completions" } } });
    for (const choice of [
        { finish_reason: "length", message: { role: "assistant", content: "partial" } },
        { finish_reason: "stop", message: { role: "tool", content: "tool" } },
        { finish_reason: "stop", message: { role: "assistant", content: "", refusal: "private" } },
        { finish_reason: "stop", message: { role: "assistant", content: "text", tool_calls: [{ private: "no" }] } },
    ]) expect(normalizeGenerationTextResponse({ ...chat(), choices: [choice] }, "chat_completions")).toMatchObject({ status: "unknown", resultSnapshot: { usageEvidence: { status: "complete" } } });
    expect(normalizeGenerationTextResponse({ ...chat(), choices: [...chat().choices, ...chat().choices] }, "chat_completions").status).toBe("unknown");
    expect(normalizeGenerationTextResponse({ ...chat(), error: { message: "private" } }, "chat_completions").status).toBe("unknown");
});

test("budgeted adapters use root/v1 paths once, server model/credential and their fixed protocol", async () => {
    const observed: ProviderRequest[] = [];
    const provider = createGenerationProvider({ database: database.db, authSecret,
        gateway: { async request(input) { observed.push(input); return { status: "succeeded", upstreamStatus: 200, payload: input.target.adapter === "sub2api" ? responses() : chat() }; } } });
    for (const adapter of ["openai-compatible", "sub2api"] as const) {
        for (const endpoint of ["https://provider.example/v1", "https://provider.example/"]) {
            expect((await provider(await task(adapter, endpoint))).status).toBe("succeeded");
        }
    }
    expect(observed.map((value) => value.path)).toEqual(["chat/completions", "v1/chat/completions", "responses", "v1/responses"]);
    expect(observed.every((value) => value.target.credential === "synthetic-provider-private-key")).toBe(true);
    for (const value of observed) {
        expect(value.body).toMatchObject({ model: "opaque/model", stream: false });
        expect(JSON.stringify(value.body)).not.toMatch(/budgetCredits|CreditsPerMillion|max_output_tokens|max_completion_tokens/);
    }
});

test("budgeted requests refuse unsupported fields or changed price bindings before upstream calls", async () => {
    const selected = await task("sub2api"); let calls = 0;
    const provider = createGenerationProvider({ database: database.db, authSecret, gateway: { async request() { calls++; throw new Error("must not call"); } } });
    expect(await provider({ ...selected, parameterSnapshot: { temperature: 0.5 } })).toEqual({ status: "failed", errorCode: "invalid_generation_parameters" });
    expect(await provider({ ...selected, inputSnapshot: { prompt: "hello", tools: [] } })).toEqual({ status: "failed", errorCode: "invalid_generation_input" });
    expect(await provider({ ...selected, textQuoteSnapshot: { ...selected.textQuoteSnapshot!, usageSource: "chat_completions" } })).toEqual({ status: "failed", errorCode: "model_unavailable" });
    await database.db.update(modelCatalog).set({ providerModel: "changed-model" }).where(eq(modelCatalog.publicId, selected.modelId));
    expect(await provider(selected)).toEqual({ status: "failed", errorCode: "model_unavailable" });
    expect(calls).toBe(0);
});

test("Sub2API transport and malformed 2xx never trigger a Chat fallback or request retry", async () => {
    const selected = await task("sub2api"); const urls: string[] = [];
    const replies = [new Response("private", { status: 503 }), new Response("invalid-json", { status: 200 }),
        new Response(JSON.stringify({ ...responses(), status: "incomplete" })), new Response("private", { status: 401 })];
    const provider = createGenerationProvider({ database: database.db, authSecret,
        gateway: createProviderGateway(async (url) => { urls.push(String(url)); return replies.shift()!; }, () => ["93.184.216.34"]) });
    for (let index = 0; index < 3; index++) expect((await provider(selected)).status).toBe("unknown");
    expect(await provider(selected)).toEqual({ status: "failed", errorCode: "provider_rejected" });
    expect(urls).toEqual(Array(4).fill("https://provider.example/v1/responses"));
    expect(replies).toHaveLength(0);
});
