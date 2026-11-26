import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { normalizeResponsesUsage, type TextQuoteSnapshot } from "@infinite-canvas/shared";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { generationTask, modelCatalog, modelProvider, modelProviderCredential, user, wallet } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Requires isolated memory database");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID(), modelId = crypto.randomUUID(), providerId = crypto.randomUUID();
const binding = { providerId, providerModel: "fixture-text", adapter: "sub2api" as const,
    endpoint: "https://provider.invalid/v1", capability: "text" as const };
const quote: TextQuoteSnapshot = { schemaVersion: 1, budgetCredits: "0.01", inputCreditsPerMillion: "2",
    outputCreditsPerMillion: "4", usageSource: "responses" };
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: ownerId, name: "Fixture", email: "text-budget@example.test" });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "10" });
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Fixture", adapter: binding.adapter,
        endpoint: binding.endpoint, secretRef: "fixture", enabled: true });
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "fixture", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, displayName: "Fixture text", providerId,
        providerModel: binding.providerModel, capability: "text", enabled: true });
    const saved = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, priceNote: "private",
        rules: { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {},
            rates: { input_token: "2", output_token: "4" } }] } } }, { actorId: ownerId, requestId: "fixture-draft" });
    if (saved.status !== "saved") throw new Error("fixture draft failed");
    const published = await publishModelPriceDraft(database.db, { modelId, draftId: saved.draft.id, expectedDraftVersion: 1,
        expectedPriceVersion: 0, binding, publicPriceNote: "Fixture dual rates" }, { actorId: ownerId, requestId: "fixture-publish" });
    if (published.status !== "published") throw new Error(`fixture publication failed ${published.status}`);
});
afterAll(async () => { await database?.close(); });

async function accepted(key: string) {
    const tasks = createGenerationTaskRepository(database.db), wallets = createWalletRepository(database.db);
    const input = { ownerId, modelId, inputSnapshot: { prompt: "fixture" }, parameterSnapshot: {}, priceVersion: 1,
        textQuoteSnapshot: quote, idempotencyKey: key, requestId: key };
    const created = await tasks.create(input);
    const reservation = await wallets.reserve({ userId: ownerId, requestedUnits: quote.budgetCredits, taskId: created.task.id,
        idempotencyKey: `budget:${key}`, referenceType: "generation", referenceId: created.task.id });
    await tasks.setReservationId({ ownerId, taskId: created.task.id, reservationId: reservation.id });
    await tasks.transitionBilling({ ownerId, taskId: created.task.id, status: "reserved" });
    const task = await tasks.transitionExecution({ ownerId, taskId: created.task.id, status: "queued" });
    return { task, reservation, input, payload: { schemaVersion: 1 as const, taskId: task.id, ownerId, requestId: key } };
}

test("published Sub2API rates bind immutable text budget and exact task replays", async () => {
    const { task, input } = await accepted("text-contract");
    expect(task).toMatchObject({ textQuoteSnapshot: quote, priceVersion: 1, quotedUnits: null, billingUnitSnapshot: null, creditsPerUnitSnapshot: null });
    expect(await validatePublishedGenerationTask(database.db, task, binding)).toBe(true);
    expect((await createGenerationTaskRepository(database.db).create(input)).created).toBe(false);
    await expect(createGenerationTaskRepository(database.db).create({ ...input, textQuoteSnapshot: { ...quote, budgetCredits: "0.02" } })).rejects.toThrow();
    await expect(database.db.update(generationTask).set({ textQuoteSnapshot: { ...quote, budgetCredits: "0.02" } }).where(eq(generationTask.id, task.id)).execute()).rejects.toThrow();
    for (const changed of [{ inputCreditsPerMillion: "1" }, { usageSource: "chat_completions" as const }, { budgetCredits: "0" },
        { cachedInputCreditsPerMillion: "0.5" }]) {
        await expect(database.db.insert(generationTask).values({ id: crypto.randomUUID(), ...input,
            idempotencyKey: crypto.randomUUID(), textQuoteSnapshot: { ...quote, ...changed } }).execute()).rejects.toThrow();
    }
    await expect(Promise.resolve(database.db.execute(sql`INSERT INTO canvas_saas.generation_task (id,owner_id,model_id,input_snapshot,parameter_snapshot,price_version,text_quote_snapshot,idempotency_key,request_id)
        VALUES (${crypto.randomUUID()},${ownerId},${modelId},'{}','{}',1,${JSON.stringify({ ...quote, private: "x" })}::jsonb,${crypto.randomUUID()},'fixture')`))).rejects.toThrow();
});

test("success captures exact dual-rate usage, releases the budget remainder and never repeats provider or ledger", async () => {
    const item = await accepted("text-settled"); let calls = 0;
    const dependencies = { provider: async () => { calls++; return { status: "succeeded" as const,
        resultSnapshot: { kind: "text", text: "fixture result", usageEvidence: normalizeResponsesUsage({ input_tokens: 200, output_tokens: 700,
            input_tokens_details: { cached_tokens: 150 }, output_tokens_details: { reasoning_tokens: 500 } }) } }; },
        deliver: async () => ({ status: "saved" as const }), settleBilling: createGenerationWalletSettlement(database.db) };
    const first = await processGenerationJob(database.db, item.payload, dependencies);
    const replay = await processGenerationJob(database.db, item.payload, dependencies);
    expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured" });
    expect(replay.task.billingStatus).toBe("captured"); expect(calls).toBe(1);
    expect(await createWalletRepository(database.db).getReservation(ownerId, item.reservation.id)).toMatchObject({
        requestedUnits: "0.01", capturedUnits: "0.0032", releasedUnits: "0.0068", status: "captured" });
});

test("missing usage and above-budget usage preserve funds for review instead of charging again", async () => {
    for (const [key, usage] of [["missing", normalizeResponsesUsage(null)], ["over", normalizeResponsesUsage({ input_tokens: 1_000_000, output_tokens: 0 })]] as const) {
        const item = await accepted(`text-${key}`);
        const result = await processGenerationJob(database.db, item.payload, { provider: async () => ({ status: "succeeded",
            resultSnapshot: { kind: "text", text: "fixture", usageEvidence: usage } }), deliver: async () => ({ status: "saved" }),
            settleBilling: createGenerationWalletSettlement(database.db) });
        expect(result.task.billingStatus).toBe("pending_review");
        expect(await createWalletRepository(database.db).getReservation(ownerId, item.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
    }
});

test("explicit zero usage and definite provider failure release the full budget", async () => {
    for (const [key, outcome] of [["zero", { status: "succeeded" as const, resultSnapshot: { kind: "text", text: "fixture",
        usageEvidence: normalizeResponsesUsage({ input_tokens: 0, output_tokens: 0 }) } }],
        ["failed", { status: "failed" as const, errorCode: "provider_rejected" }]] as const) {
        const item = await accepted(`text-${key}`);
        const result = await processGenerationJob(database.db, item.payload, { provider: async () => outcome,
            deliver: async () => ({ status: "saved" }), settleBilling: createGenerationWalletSettlement(database.db) });
        expect(result.task.billingStatus).toBe("released");
        expect(await createWalletRepository(database.db).getReservation(ownerId, item.reservation.id)).toMatchObject({ capturedUnits: "0", releasedUnits: "0.01", status: "released" });
    }
});

test("text settlement resumes an exact partial capture once and refuses conflicting prior capture", async () => {
    for (const [key, capturedUnits] of [["resume", "0.0032"], ["conflict", "0.0033"]] as const) {
        const item = await accepted(`text-capture-${key}`);
        const wallets = createWalletRepository(database.db);
        await wallets.capture({ userId: ownerId, reservationId: item.reservation.id, capturedUnits,
            idempotencyKey: `generation:${item.task.id}:capture`, referenceType: "generation", referenceId: item.task.id });
        let calls = 0;
        const deps = { provider: async () => { calls++; return { status: "succeeded" as const, resultSnapshot: { kind: "text", text: "fixture",
            usageEvidence: normalizeResponsesUsage({ input_tokens: 200, output_tokens: 700 }) } }; },
            deliver: async () => ({ status: "visible" as const }), settleBilling: createGenerationWalletSettlement(database.db) };
        const result = await processGenerationJob(database.db, item.payload, deps);
        await processGenerationJob(database.db, item.payload, deps);
        expect(calls).toBe(1);
        expect(result.task.billingStatus).toBe(key === "resume" ? "captured" : "pending_review");
        expect(await wallets.getReservation(ownerId, item.reservation.id)).toMatchObject({ capturedUnits,
            releasedUnits: key === "resume" ? "0.0068" : "0", status: key === "resume" ? "captured" : "pending" });
    }
});
