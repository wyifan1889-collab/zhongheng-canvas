import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { createTestDatabase } from "./database";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { getTextTaskSettlementPolicy, publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { auditEvent, modelCatalog, modelPriceDraft, modelPricePublication, modelProvider, modelProviderCredential, officialPriceMapping, officialPriceSource, user, wallet } from "@infinite-canvas/database/schema";
import { deriveModelPriceRules, parseModelPriceDerivation, type ModelPriceDerivationV2 } from "../../../packages/shared/src/model-price-derivation";
import { composeTextContextTierNote } from "../../../packages/shared/src/model-price-publications";
import { explainTextBilling, parseTextBillingExplanation, resolveTextSettlement } from "../../../packages/shared/src/text-billing";
import { normalizeResponsesUsage, type TextQuoteSnapshot } from "@infinite-canvas/shared";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { getGenerationTaskByKeyForOwner, getGenerationTaskForOwner } from "../src/generation-query";
import { resolveExecutableTextQuote } from "../src/generation-text-policy";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("No existing database accepted");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID(), otherId = crypto.randomUUID(), providerId = crypto.randomUUID(), modelId = `tiers-${crypto.randomUUID()}`;
const binding = { providerId, providerModel: "fixture-sol", adapter: "sub2api" as const, endpoint: "https://provider.invalid/v1", capability: "text" as const };
const labels = ["短上下文输入", "短上下文输出", "短上下文缓存读取", "短上下文缓存写入（30 分钟）", "短上下文缓存写入（12 小时）", "长上下文输入", "长上下文输出", "长上下文缓存读取", "长上下文缓存写入（30 分钟）", "长上下文缓存写入（12 小时）"];
const amounts = ["2", "10", "0.1", "2.5", "5", "4", "15", "0.2", "5", "10"];
const derivation: ModelPriceDerivationV2 = { schemaVersion: 2, kind: "multiplier", binding, costMultiplier: null, saleMultiplier: "0.36", creditsPerCurrency: "100",
    basis: { template: "text_cached_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.1", output_token: "10" } }] },
    source: { kind: "official", application: "context_tiers", sourceId: "openai", version: 1, checkedAt: "2026-10-29T00:00:00.000Z",
        entry: { id: "openai:gpt-6.1-sol", modelName: "gpt-6.1-sol", context: "官方输入阈值272K；平台另按总量判档", rates: labels.map((label, i) => ({ label, usdPerMillion: amounts[i] })) },
        selection: { metric: "total_tokens", shortMaxTotalTokens: 272000,
            short: { "短上下文输入": "input_token", "短上下文缓存读取": "cached_input_token", "短上下文输出": "output_token" },
            long: { "长上下文输入": "input_token", "长上下文缓存读取": "cached_input_token", "长上下文输出": "output_token" } } } };
const rules = { ...deriveModelPriceRules(derivation)!, derivation };
const quote: TextQuoteSnapshot = { schemaVersion: 1, budgetCredits: "100", inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360", usageSource: "responses" };
let publicationId: string, draftId: string;
const usage = (input: number, output = 1, cached = 0, writes: number | undefined = 0, reported = true) => normalizeResponsesUsage({ input_tokens: input, output_tokens: output,
    ...(reported ? { total_tokens: input + output } : {}), input_tokens_details: { cached_tokens: cached, ...(writes === undefined ? {} : { cache_write_tokens: writes }) } });

beforeAll(async () => {
    if (process.env.SAAS_CONTEXT_PG_URL) {
        const url = new URL(process.env.SAAS_CONTEXT_PG_URL);
        if (process.env.SAAS_CONTEXT_PG_RUN !== "owned" || url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/context_tiers_")) throw new Error("Not an owned isolated context database");
        database = createDatabase(url.toString()); await migrateDatabase(database.db);
    } else database = await createTestDatabase();
    await database.db.insert(user).values([{ id: ownerId, name: "A", email: `${ownerId}@example.test` }, { id: otherId, name: "B", email: `${otherId}@example.test` }]);
    await database.db.insert(wallet).values([{ userId: ownerId, availableUnits: "10000" }, { userId: otherId, availableUnits: "10000" }]);
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Fixture", adapter: binding.adapter, endpoint: binding.endpoint, secretRef: "fixture", enabled: true });
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "fixture", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, displayName: "Context fixture", providerId, providerModel: binding.providerModel, capability: "text", enabled: true });
    await database.db.insert(officialPriceSource).values({ id: "openai", version: 1, checkedAt: new Date(derivation.source.checkedAt), status: "ready", entries: [derivation.source.entry], changedEntryIds: [] });
    await database.db.insert(officialPriceMapping).values({ modelId, referenceId: derivation.source.entry.id, version: 1,
        providerIdSnapshot: providerId, providerModelSnapshot: binding.providerModel, adapterSnapshot: binding.adapter, endpointSnapshot: binding.endpoint, capabilitySnapshot: "text" });
    const saved = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, rules, priceNote: "fixture" }, { actorId: ownerId, requestId: "tiers-save" });
    if (saved.status !== "saved") throw new Error(`save ${saved.status}`); draftId = saved.draft.id;
    const input = { modelId, draftId, expectedDraftVersion: 1, expectedPriceVersion: 0, binding, publicPriceNote: composeTextContextTierNote(rules, binding, "fixture")! };
    expect((await publishModelPriceDraft(database.db, { ...input, publicPriceNote: "missing policy" }, { actorId: ownerId, requestId: "bad-note" })).status).toBe("unsupported_price_rule");
    const published = await publishModelPriceDraft(database.db, input, { actorId: ownerId, requestId: "tiers-publish" });
    if (published.status !== "published") throw new Error(`publish ${published.status}`); publicationId = published.publication.id;
    expect((await publishModelPriceDraft(database.db, input, { actorId: ownerId, requestId: "tiers-replay" })).status).toBe("published");
});
afterAll(async () => { await database?.close(); });

async function accepted(key: string, budget = "100") {
    const tasks = createGenerationTaskRepository(database.db), wallets = createWalletRepository(database.db);
    const item = await tasks.create({ ownerId, modelId, priceVersion: 1, inputSnapshot: { prompt: "fixture" }, parameterSnapshot: {},
        textQuoteSnapshot: { ...quote, budgetCredits: budget }, idempotencyKey: key, requestId: key });
    const reservation = await wallets.reserve({ userId: ownerId, requestedUnits: budget, taskId: item.task.id, idempotencyKey: `reserve:${key}`, referenceType: "generation", referenceId: item.task.id });
    await tasks.setReservationId({ ownerId, taskId: item.task.id, reservationId: reservation.id });
    await tasks.transitionBilling({ ownerId, taskId: item.task.id, status: "reserved" });
    const task = await tasks.transitionExecution({ ownerId, taskId: item.task.id, status: "queued" });
    return { task, reservation, payload: { schemaVersion: 1 as const, ownerId, taskId: task.id, requestId: key } };
}

test("complete ten-row source, publication note replay and side-effect-free quote preserve frozen v2", async () => {
    const q = await resolveExecutableTextQuote(database.db, { modelId, inputSnapshot: { prompt: "fixture" }, parameterSnapshot: {}, budgetCredits: "100" });
    expect(q).toMatchObject({ priceVersion: 1, ...Object.fromEntries(Object.entries(quote).filter(([k]) => k !== "schemaVersion")), priceNote: composeTextContextTierNote(rules, binding, "fixture") });
    expect((await database.db.select().from(modelPricePublication)).filter(row => row.draftId === draftId)).toHaveLength(1);
    const changed = structuredClone(derivation); changed.source.entry.rates[3].usdPerMillion = "999";
    const invalid = await createModelPriceDraft(database.db, { modelId, expectedVersion: 1, binding, rules: { ...deriveModelPriceRules(changed)!, derivation: changed }, priceNote: "tampered unselected TTL" }, { actorId: ownerId, requestId: "bad-ttl" });
    expect(invalid.status).toBe("price_derivation_source_changed");
    expect((await database.db.select().from(modelPriceDraft)).filter(row => row.modelId === modelId)).toHaveLength(1);
    expect((await database.db.select().from(auditEvent)).filter(row => row.requestId === "bad-ttl")).toHaveLength(0);
});

test("exact total boundary and cached/derived usage settle automatically and explain original actual long rates", async () => {
    for (const [key, evidence, expected, tier] of [
        ["short", usage(271999), "19.584288", "short"], ["long", usage(272000), "39.16854", "long"],
        ["cached-derived", usage(272000, 1, 100000, 0, false), "25.48854", "long"],
    ] as const) {
        const item = await accepted(`boundary-${key}`); let calls = 0;
        expect(await getTextTaskSettlementPolicy(database.db, item.task)).toMatchObject({ status: "context_tiers" });
        const deps = { provider: async () => { calls++; return { status: "succeeded" as const, resultSnapshot: { kind: "text", text: "fixture", usageEvidence: evidence } }; },
            deliver: async () => ({ status: "saved" as const }), settleBilling: createGenerationWalletSettlement(database.db) };
        expect((await processGenerationJob(database.db, item.payload, deps)).task.billingStatus).toBe("captured");
        await processGenerationJob(database.db, item.payload, deps); expect(calls).toBe(1);
        const reservation = await createWalletRepository(database.db).getReservation(ownerId, item.reservation.id);
        expect(reservation?.capturedUnits).toBe(expected);
        const view = await getGenerationTaskForOwner(database.db, { ownerId, taskId: item.task.id });
        expect(view.task.textBillingExplanation).toMatchObject({ policy: "context_tiers", tier, totalTokens: evidence.totalTokens, expectedCredits: expected });
        expect(parseTextBillingExplanation(view.task.textBillingExplanation)).toEqual(view.task.textBillingExplanation);
        expect(view.task.billing?.capturedCredits).toBe(expected);
        expect(view.task.textQuoteSnapshot).toMatchObject({ inputCreditsPerMillion: "72" });
        expect(JSON.stringify(view)).not.toContain(binding.endpoint); expect(JSON.stringify(view)).not.toContain("costMultiplier");
        expect((await getGenerationTaskByKeyForOwner(database.db, { ownerId, idempotencyKey: `boundary-${key}` })).task.textBillingExplanation).toEqual(view.task.textBillingExplanation);
        await expect(getGenerationTaskForOwner(database.db, { ownerId: otherId, taskId: item.task.id })).rejects.toThrow();
    }
});

test("amount equals budget captures; excess budget, missing/nonzero writes, absent cache or corrupt policy never downgrade", async () => {
    const equal = await accepted("equal", "39.16854");
    const deps = (evidence: unknown) => ({ provider: async () => ({ status: "succeeded" as const, resultSnapshot: { kind: "text", text: "fixture", usageEvidence: evidence } }),
        deliver: async () => ({ status: "saved" as const }), settleBilling: createGenerationWalletSettlement(database.db) });
    expect((await processGenerationJob(database.db, equal.payload, deps(usage(272000)))).task.billingStatus).toBe("captured");
    expect(await createWalletRepository(database.db).getReservation(ownerId, equal.reservation.id)).toMatchObject({ capturedUnits: "39.16854", releasedUnits: "0" });
    for (const [key, budget, evidence] of [["over", "39", usage(272000)], ["missing-write", "100", normalizeResponsesUsage({ input_tokens: 272000, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } })],
        ["write", "100", usage(272000, 1, 0, 1)], ["missing-cache", "100", normalizeResponsesUsage({ input_tokens: 272000, output_tokens: 1, input_tokens_details: { cache_write_tokens: 0 } })],
        ["missing-usage", "100", normalizeResponsesUsage(null)]] as const) {
        const item = await accepted(key, budget);
        expect((await processGenerationJob(database.db, item.payload, deps(evidence))).task.billingStatus).toBe("pending_review");
        expect(await createWalletRepository(database.db).getReservation(ownerId, item.reservation.id)).toMatchObject({ capturedUnits: "0", releasedUnits: "0", status: "pending" });
    }
    const item = await accepted("invalid-policy");
    expect(await getTextTaskSettlementPolicy(database.db, { ...item.task, pricePublicationId: null })).toEqual({ status: "invalid" });
    expect(await getTextTaskSettlementPolicy(database.db, { ...item.task, modelId: "wrong" })).toEqual({ status: "invalid" });
    expect(resolveTextSettlement(quote, usage(272000), { status: "invalid" })).toBeNull();
    expect(explainTextBilling({ ...item.task, priceVersion: 1 }, usage(272000), { status: "invalid" }).rates).toBeNull();
});

test("capture committed before release resumes once with original tier and rejects a conflicting captured amount", async () => {
    for (const [key, captured] of [["resume", "39.16854"], ["conflict", "39.17"]] as const) {
        const item = await accepted(key), wallets = createWalletRepository(database.db);
        await wallets.capture({ userId: ownerId, reservationId: item.reservation.id, capturedUnits: captured, idempotencyKey: `generation:${item.task.id}:capture`, referenceType: "generation", referenceId: item.task.id });
        const deps = { provider: async () => ({ status: "succeeded" as const, resultSnapshot: { kind: "text", text: "fixture", usageEvidence: usage(272000) } }), deliver: async () => ({ status: "visible" as const }), settleBilling: createGenerationWalletSettlement(database.db) };
        expect((await processGenerationJob(database.db, item.payload, deps)).task.billingStatus).toBe(key === "resume" ? "captured" : "pending_review");
        await processGenerationJob(database.db, item.payload, deps);
        expect(await wallets.getReservation(ownerId, item.reservation.id)).toMatchObject({ capturedUnits: captured, releasedUnits: key === "resume" ? "60.83146" : "0" });
    }
});

test("frozen lookup ignores source refresh and binding changes while current execution permission remains enforced", async () => {
    const item = await accepted("historic");
    await database.db.update(officialPriceSource).set({ version: 2, entries: [] }).where(eq(officialPriceSource.id, "openai"));
    await database.db.update(modelCatalog).set({ providerModel: "changed" }).where(eq(modelCatalog.id, modelId));
    expect(resolveTextSettlement(quote, usage(272000), await getTextTaskSettlementPolicy(database.db, item.task))?.expectedCredits).toBe("39.16854");
    expect(await validatePublishedGenerationTask(database.db, item.task, { ...binding, providerModel: "changed" })).toBe(false);
    const legacy = resolveTextSettlement(quote, usage(272000), { status: "legacy_fixed" });
    expect(legacy?.tier).toBe("fixed"); expect(legacy?.expectedCredits).toBe("19.58436");
    await database.db.update(modelCatalog).set({ providerModel: binding.providerModel }).where(eq(modelCatalog.id, modelId));
    expect(await getTextTaskSettlementPolicy(database.db, { ...item.task, pricePublicationId: crypto.randomUUID() })).toEqual({ status: "invalid" });
    await expect(Promise.resolve(database.db.execute(sql`UPDATE canvas_saas.model_price_publication SET draft_id=${crypto.randomUUID()} WHERE id=${publicationId}`))).rejects.toThrow();
});
