import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { deriveModelPriceRules, parseModelPriceBinding, parseModelPriceDraftWrite, type ModelPriceDerivation, type ModelPriceDraftWrite, type ModelPriceRules } from "@infinite-canvas/shared";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { getImageSpecTaskSnapshot, getModelPricePublicationPreview, publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { listPublicModelPricing, resolveActiveGenerationPricing } from "@infinite-canvas/database/pricing";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { generationTask, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential, user, wallet } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";
import { expectCurrentMigrations } from "./migrations";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Image specification tests require isolated in-memory PGlite");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

async function seed(capability: "image" | "text" = "image", providerModel = `synthetic-${capability}`) {
    const id = crypto.randomUUID(), ownerId = `image-spec-owner-${id}`, modelId = `image-spec-${id}`, providerId = `image-spec-provider-${id}`;
    await database.db.insert(user).values({ id: ownerId, name: "Synthetic image specification owner", email: `${id}@example.test` });
    await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic image specification provider", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", secretRef: "synthetic", enabled: true });
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "synthetic", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel, displayName: "Synthetic specification model", capability, enabled: true });
    const binding = { providerId, providerModel, adapter: "openai-compatible" as const, endpoint: "https://provider.invalid/v1", capability };
    const rules: ModelPriceRules = { schemaVersion: 1, cost: null, sale: capability === "text"
        ? { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] }
        : { template: "image_request", currency: "credit", bands: [
            { parameters: { size: "1024x1024", quality: "low" }, rates: { request: "7" } },
            { parameters: { size: "2048x2048", quality: "high" }, rates: { request: "11" } },
        ] } };
    const draftInput: ModelPriceDraftWrite = { modelId, expectedVersion: 0, binding, rules, priceNote: "Synthetic private cost note" };
    return { ownerId, modelId, binding, draftInput };
}

async function publish(fixture: Awaited<ReturnType<typeof seed>>, input = fixture.draftInput, priceVersion = 0) {
    const audit = { actorId: fixture.ownerId, requestId: crypto.randomUUID() };
    const saved = await createModelPriceDraft(database.db, input, audit);
    if (saved.status !== "saved") throw new Error("Synthetic image specification draft failed");
    const result = await publishModelPriceDraft(database.db, { modelId: fixture.modelId, draftId: saved.draft.id,
        expectedDraftVersion: saved.draft.version, expectedPriceVersion: priceVersion, binding: saved.draft.binding,
        publicPriceNote: "Synthetic explicit specification price" }, audit);
    if (result.status !== "published") throw new Error("Synthetic image specification publication failed");
    return result.publication;
}

function intent(fixture: Awaited<ReturnType<typeof seed>>) {
    return { ownerId: fixture.ownerId, modelId: fixture.modelId, inputSnapshot: { prompt: "Synthetic explicit specification" },
        parameterSnapshot: { size: "2048x2048", quality: "high", n: 1, output_format: "png" },
        priceVersion: 1, billingUnitSnapshot: "request" as const, creditsPerUnitSnapshot: 11, quotedUnits: 11,
        spaceId: "synthetic-space", projectId: "synthetic-project", nodeId: "synthetic-node",
        idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() };
}

test("0026 publishes every exact image price without a global scalar and historical tasks retain their selected source", async () => {
    const migrations = await database.db.execute(sql`SELECT hash,created_at::text AS created_at FROM canvas_migrations.__drizzle_migrations ORDER BY created_at,id`);
    await expectCurrentMigrations({ query: text => database.db.execute(sql.raw(text)) });
    expect(migrations.rows[26]).toMatchObject({ created_at: "1792742400010" });
    const f = await seed(), first = await publish(f);
    expect(first).toMatchObject({ billingUnit: "image_specs", creditsPerUnit: null,
        imageSpecs: [{ parameters: { size: "1024x1024", quality: "low" }, creditsPerRequest: 7 },
            { parameters: { size: "2048x2048", quality: "high" }, creditsPerRequest: 11 }] });
    const preview = await getModelPricePublicationPreview(database.db, f.modelId);
    expect(preview?.currentPrice).toMatchObject({ billingUnit: "image_specs", creditsPerUnit: null, imageSpecs: first.billingUnit === "image_specs" ? first.imageSpecs : [] });
    const prices = await listPublicModelPricing(database.db);
    const publicPrice = prices.find(row => row.modelId === f.modelId)!;
    expect(publicPrice).toMatchObject({ billingUnit: "image_specs", creditsPerUnit: null });
    for (const field of ["rules", "binding", "cost", "draftId", "providerId", "publicationId"]) expect(publicPrice).not.toHaveProperty(field);
    expect(await resolveActiveGenerationPricing(database.db, { modelId: f.modelId })).toBeNull();
    const tasks = createGenerationTaskRepository(database.db), created = await tasks.create(intent(f));
    expect(created.task).toMatchObject({ pricePublicationId: first.id, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 11, quotedUnits: 11 });
    expect(await getImageSpecTaskSnapshot(database.db, created.task)).toEqual({ status: "recorded", protocol: "openai-image-v1", publicationId: first.id,
        parameters: { size: "2048x2048", quality: "high" }, creditsPerRequest: 11 });
    expect(await validatePublishedGenerationTask(database.db, created.task, f.binding)).toBe(true);
    expect(await getImageSpecTaskSnapshot(database.db, { ...created.task, pricePublicationId: null })).toEqual({ status: "invalid" });
    expect(await getImageSpecTaskSnapshot(database.db, { ...created.task, quotedUnits: 7 })).toEqual({ status: "invalid" });
    const next = structuredClone(f.draftInput); next.expectedVersion = 1; next.rules.sale.bands[1]!.rates.request = "13";
    await publish(f, next, 1);
    expect(await getImageSpecTaskSnapshot(database.db, created.task)).toMatchObject({ status: "recorded", publicationId: first.id, creditsPerRequest: 11 });
});

test("SQL image specification guards reject forged amounts, noncanonical parameters and missing publications", async () => {
    const f = await seed(), publication = await publish(f), base = { ...intent(f), id: crypto.randomUUID() };
    const mutations: Array<Partial<typeof generationTask.$inferInsert>> = [
        { quotedUnits: 7 }, { creditsPerUnitSnapshot: 7 }, { billingUnitSnapshot: "second" },
        { parameterSnapshot: { size: "2048x2048", n: 1, output_format: "png" } },
        { parameterSnapshot: { size: "2048x2048", quality: "medium", n: 1, output_format: "png" } },
        { parameterSnapshot: { size: "2048x2048", quality: "high", n: 2, output_format: "png" } },
        { parameterSnapshot: { size: "2048x2048", quality: "high", n: 1, output_format: "jpeg" } },
        { parameterSnapshot: { size: "2048x2048", quality: "high", n: 1, output_format: "png", background: "auto" } },
        { inputSnapshot: {} }, { inputSnapshot: { prompt: "" } }, { inputSnapshot: { prompt: " \t\r\n" } },
        { inputSnapshot: { prompt: "valid", extra: true } }, { pricePublicationId: "wrong-publication" },
    ];
    for (const mutation of mutations) await expect(database.db.insert(generationTask).values({ ...base, ...mutation }).execute()).rejects.toThrow();
    expect(await database.db.select().from(generationTask).where(eq(generationTask.modelId, f.modelId))).toHaveLength(0);
    const [valid] = await database.db.insert(generationTask).values(base).returning();
    expect(valid?.pricePublicationId).toBe(publication.id);
    const orphan = await seed();
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: orphan.modelId, version: 1,
        billingUnit: "image_specs", creditsPerUnit: null, effectiveFrom: new Date(), enabled: true });
    await expect(database.db.insert(generationTask).values({ ...intent(orphan), id: crypto.randomUUID() }).execute()).rejects.toThrow();
    expect(await getImageSpecTaskSnapshot(database.db, { ...intent(orphan), pricePublicationId: null })).toEqual({ status: "invalid" });
});

test("0038 binds explicit task protocols without granting a protocol-only draft unverified batch counts", async () => {
    const f = await seed(), input = structuredClone(f.draftInput);
    input.rules.image = { schemaVersion: 1, protocol: "openai-image-v1" };
    const publication = await publish(f, input), base = intent(f);
    const parameters = { ...base.parameterSnapshot, protocol: "openai-image-v1" };
    const created = await createGenerationTaskRepository(database.db).create({ ...base, parameterSnapshot: parameters });
    expect(created.task.parameterSnapshot).toEqual(parameters);
    expect(await getImageSpecTaskSnapshot(database.db, created.task)).toMatchObject({ status: "recorded", protocol: "openai-image-v1", publicationId: publication.id });
    for (const protocol of ["gemini", "grok", null, 1, {}]) {
        await expect(database.db.insert(generationTask).values({ ...base, id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
            parameterSnapshot: { ...parameters, protocol } }).execute()).rejects.toThrow();
        expect(await getImageSpecTaskSnapshot(database.db, { ...created.task, parameterSnapshot: { ...parameters, protocol } })).toEqual({ status: "invalid" });
    }
    await expect(database.db.insert(generationTask).values({ ...base, id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
        parameterSnapshot: { ...parameters, n: 4 }, quotedUnits: 44 }).execute()).rejects.toThrow();
    const historical = await createGenerationTaskRepository(database.db).create({ ...base, idempotencyKey: crypto.randomUUID() });
    expect(historical.task.parameterSnapshot).not.toHaveProperty("protocol");
    expect(await getImageSpecTaskSnapshot(database.db, historical.task)).toMatchObject({ status: "recorded", protocol: "openai-image-v1" });
    for (const image of [{ schemaVersion: 1, protocol: "gemini" }, { schemaVersion: 1, protocol: null },
        { schemaVersion: 1 }, { schemaVersion: 1, protocol: "openai-image-v1", maxImagesPerRequest: null },
        { schemaVersion: 1, protocol: "openai-image-v1", maxImagesPerRequest: 1.5 },
        { schemaVersion: 1, protocol: "openai-image-v1", maxImagesPerRequest: 11 },
        { schemaVersion: 1, protocol: "openai-image-v1", extra: true }]) {
        const result = await database.db.execute(sql`SELECT canvas_saas.image_spec_task_credits(${JSON.stringify({ ...input.rules, image })}::jsonb, ${JSON.stringify(parameters)}::jsonb) AS credits`);
        expect(result.rows[0]?.credits).toBeNull();
    }
});

test("IMG-03 SQL and historical reads require the exact published return format", async () => {
    const f = await seed(), input = structuredClone(f.draftInput);
    input.rules.image = { schemaVersion: 1, protocol: "openai-image-v1", responseFormat: "b64_json" };
    const publication = await publish(f, input), base = intent(f);
    const parameters = { ...base.parameterSnapshot, protocol: "openai-image-v1", response_format: "b64_json" };
    const created = await createGenerationTaskRepository(database.db).create({ ...base, parameterSnapshot: parameters });
    expect(created.task.parameterSnapshot).toEqual(parameters);
    expect(await getImageSpecTaskSnapshot(database.db, created.task)).toMatchObject({ status: "recorded", publicationId: publication.id, responseFormat: "b64_json" });
    for (const changed of [base.parameterSnapshot, ...["url", null, 1].map(response_format => ({ ...parameters, response_format }))]) {
        await expect(database.db.insert(generationTask).values({ ...base, id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), parameterSnapshot: changed }).execute()).rejects.toThrow();
        expect(await getImageSpecTaskSnapshot(database.db, { ...created.task, parameterSnapshot: changed })).toEqual({ status: "invalid" });
    }
    const old = await seed(); await publish(old);
    await expect(database.db.insert(generationTask).values({ ...intent(old), id: crypto.randomUUID(), parameterSnapshot: parameters }).execute()).rejects.toThrow();
    const historical = await createGenerationTaskRepository(database.db).create(intent(old));
    expect(await getImageSpecTaskSnapshot(database.db, historical.task)).toMatchObject({ status: "recorded" });
    expect(await getImageSpecTaskSnapshot(database.db, { ...historical.task, parameterSnapshot: parameters })).toEqual({ status: "invalid" });
    for (const responseFormat of ["url", null, 1]) {
        const result = await database.db.execute(sql`SELECT canvas_saas.image_spec_task_credits(${JSON.stringify({ ...input.rules, image: { ...input.rules.image, responseFormat } })}::jsonb, ${JSON.stringify(parameters)}::jsonb) AS credits`);
        expect(result.rows[0]?.credits).toBeNull();
    }
});

test("SQL batch guard binds integer counts and full totals to the published model", async () => {
    const f = await seed("image", "gpt-image-2"), publication = await publish(f), base = intent(f);
    for (const n of [0, -1, 11, 1.5, "4", null]) {
        await expect(database.db.insert(generationTask).values({ ...base, id: crypto.randomUUID(),
            parameterSnapshot: { ...base.parameterSnapshot, n }, quotedUnits: 44 }).execute()).rejects.toThrow();
    }
    for (const mutation of [{ quotedUnits: 11 }, { quotedUnits: 45 }, { quotedUnits: 44, creditsPerUnitSnapshot: 44 }]) {
        await expect(database.db.insert(generationTask).values({ ...base, id: crypto.randomUUID(),
            parameterSnapshot: { ...base.parameterSnapshot, n: 4 }, ...mutation }).execute()).rejects.toThrow();
    }
    const created = await createGenerationTaskRepository(database.db).create({ ...base,
        parameterSnapshot: { ...base.parameterSnapshot, n: 4 }, quotedUnits: 44 });
    expect(await getImageSpecTaskSnapshot(database.db, created.task)).toMatchObject({ status: "recorded", publicationId: publication.id,
        parameters: { size: "2048x2048", quality: "high", n: 4 }, creditsPerRequest: 11 });
    expect(await validatePublishedGenerationTask(database.db, created.task, f.binding)).toBe(true);
});

test("SQL validates the complete rule and never publishes an unsupported or overlapping subset", async () => {
    const f = await seed();
    const invalidCases: Array<{ parameters: Record<string, string>; request: string }> = [
        { parameters: { size: "auto" }, request: "7" }, { parameters: { size: "1024x1024", mode: "image" }, request: "7" },
        { parameters: { size: "1024x1024" }, request: "0.1" }, { parameters: { size: "1024x1024" }, request: "0" },
        { parameters: { size: "1024x1024" }, request: "9007199254740992" },
    ];
    const invalidRules: unknown[] = invalidCases.map(value => ({ schemaVersion: 1, cost: null,
        sale: { template: "image_request", currency: "credit", bands: [{ parameters: value.parameters, rates: { request: value.request } }] } }));
    const policy = { schemaVersion: 1, protocol: "openai-image-v1", maxImagesPerRequest: 4 };
    for (const image of [null, {}, { ...policy, protocol: "gemini" }, { ...policy, schemaVersion: "1" }, { ...policy, extra: true },
        ...[0, 11, 1.5, "4", null].map(maxImagesPerRequest => ({ ...policy, maxImagesPerRequest }))]) invalidRules.push({ ...f.draftInput.rules, image });
    invalidRules.push({ schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands: [
        { parameters: { size: "1024x1024" }, rates: { request: "7" } },
        { parameters: { size: "1024x1024", quality: "high" }, rates: { request: "11" } },
    ] } });
    const derivation: ModelPriceDerivation = { schemaVersion: 1, kind: "multiplier", binding: f.binding,
        basis: { ...structuredClone(f.draftInput.rules.sale), currency: "CNY" }, costMultiplier: "0.5", saleMultiplier: "1", creditsPerCurrency: "1", source: { kind: "custom" } };
    const derived = deriveModelPriceRules(derivation);
    if (!derived) throw new Error("Synthetic multiplier derivation failed");
    const derivedRules = { ...derived, derivation };
    invalidRules.push(
        { ...f.draftInput.rules, cost: false }, { ...f.draftInput.rules, derivation: false },
        { ...f.draftInput.rules, cost: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "1" } }] } },
        { ...f.draftInput.rules, cost: { template: "image_request", currency: "CNY", bands: [{ parameters: {}, rates: { request: "-1" } }] } },
        { ...f.draftInput.rules, cost: { template: "image_request", currency: "CNY", bands: [{ parameters: {}, rates: { request: "1", image: "1" } }] } },
        { ...f.draftInput.rules, cost: { template: "image_count", currency: "USD", bands: [{ parameters: { mode: " " }, rates: { image: null } }] } },
        { ...f.draftInput.rules, cost: { template: "image_request", currency: "CNY", bands: [
            { parameters: { size: "1024x1024" }, rates: { request: "1" } },
            { parameters: { size: "1024x1024", quality: "high" }, rates: { request: "2" } },
        ] } },
        { ...derivedRules, derivation: { ...derivation, source: { kind: "custom", extra: true } } },
        { ...derivedRules, derivation: { ...derivation, source: { kind: "saved_cost", draftId: "invalid", draftVersion: 1 } } },
        { ...derivedRules, derivation: { ...derivation, saleMultiplier: "0" } },
        { ...derivedRules, derivation: { ...derivation, creditsPerCurrency: "2" } },
        { ...derivedRules, derivation: { ...derivation, costMultiplier: null } },
        { ...derivedRules, derivation: { ...derivation, basis: { ...derivation.basis, bands: [{ parameters: { size: "1024x1024", quality: "low" }, rates: { request: null } }] } } },
        { ...derivedRules, derivation: { ...derivation, binding: { ...f.binding, adapter: "sub2api" } } },
        { ...derivedRules, derivation: { ...derivation, binding: { ...f.binding, capability: "text" } } },
    );
    for (const field of ["providerId", "providerModel", "endpoint"] as const) invalidRules.push({ ...derivedRules,
        derivation: { ...derivation, binding: { ...f.binding, [field]: field === "endpoint" ? "https://other.invalid/v1" : "different-binding" } } });
    for (const rules of invalidRules) await expect(database.db.transaction(async (tx) => {
        const draftId = crypto.randomUUID(), priceId = crypto.randomUUID();
        await tx.insert(modelPriceDraft).values({ id: draftId, modelId: f.modelId, version: 1, rules: rules as ModelPriceRules,
            priceNote: "Synthetic invalid source", providerIdSnapshot: f.binding.providerId, providerModelSnapshot: f.binding.providerModel,
            adapterSnapshot: f.binding.adapter, endpointSnapshot: f.binding.endpoint, capabilitySnapshot: "image" });
        await tx.insert(modelPricing).values({ id: priceId, modelId: f.modelId, version: 1, billingUnit: "image_specs", creditsPerUnit: null, effectiveFrom: new Date(), enabled: true });
        await tx.insert(modelPricePublication).values({ id: crypto.randomUUID(), draftId, pricingId: priceId, publicPriceNote: "Must not publish" });
    })).rejects.toThrow();
    expect(await database.db.select().from(modelPricing).where(eq(modelPricing.modelId, f.modelId))).toHaveLength(0);
    const control = await publish(f, { ...f.draftInput, rules: derivedRules });
    expect(control).toMatchObject({ billingUnit: "image_specs", creditsPerUnit: null });
    const task = await createGenerationTaskRepository(database.db).create(intent(f));
    expect(await getImageSpecTaskSnapshot(database.db, task.task)).toMatchObject({ status: "recorded", creditsPerRequest: 11, publicationId: control.id });
    const uppercase = { ...derivation, binding: { ...f.binding, endpoint: "HTTPS://provider.invalid/v1" } };
    const uppercaseRules = deriveModelPriceRules(uppercase);
    expect(uppercaseRules).not.toBeNull(); // URL parsing preserves a lawful uppercase scheme in the source binding.
    const accepted = await database.db.execute(sql`SELECT canvas_saas.image_spec_task_credits(
        ${JSON.stringify({ ...uppercaseRules!, derivation: uppercase })}::jsonb,
        ${JSON.stringify(intent(f).parameterSnapshot)}::jsonb)::text AS credits`);
    expect(accepted.rows[0]).toEqual({ credits: "11" });
});

test("derived image specification publication preserves empty URL suffixes and rejects nonempty URL components", async () => {
    const baseline = await seed();
    const derivation: ModelPriceDerivation = { schemaVersion: 1, kind: "multiplier", binding: baseline.binding,
        basis: { ...structuredClone(baseline.draftInput.rules.sale), currency: "CNY" },
        costMultiplier: "0.5", saleMultiplier: "1", creditsPerCurrency: "1", source: { kind: "custom" } };
    const derived = deriveModelPriceRules(derivation);
    if (!derived) throw new Error("Synthetic endpoint control derivation failed");
    for (const endpoint of [
        "http://provider.invalid/v1", "https://user:password@provider.invalid/v1", "https://user@provider.invalid/v1",
        "https://provider.invalid/v1?query=1", "https://provider.invalid/v1#fragment",
        "https://provider.invalid/v1?query=1#", "https://provider.invalid/v1?#fragment",
        "https://provider.invalid/v1#?", "https://provider.invalid/v1??", "https://provider.invalid/v1##",
    ]) {
        const binding = { ...baseline.binding, endpoint };
        expect(parseModelPriceBinding(binding)).toBeNull();
        // The valid materialized amounts stay fixed; only the endpoint changes.
        const result = await database.db.execute(sql`SELECT canvas_saas.image_spec_task_credits(
            ${JSON.stringify({ ...derived, derivation: { ...derivation, binding } })}::jsonb,
            ${JSON.stringify(intent(baseline).parameterSnapshot)}::jsonb)::text AS credits`);
        expect(result.rows[0]).toEqual({ credits: null });
    }
    for (const suffix of ["", "?", "#", "?#"]) {
        const f = await seed(), endpoint = `https://provider.invalid/v1${suffix}`;
        const binding = { ...f.binding, endpoint };
        await database.db.update(modelProvider).set({ endpoint }).where(eq(modelProvider.id, binding.providerId));
        expect(parseModelPriceBinding(binding)).toEqual(binding);
        const source = { ...derivation, binding };
        const materialized = deriveModelPriceRules(source);
        if (!materialized) throw new Error("Synthetic empty-suffix derivation failed");
        const input = parseModelPriceDraftWrite({ ...f.draftInput, binding, rules: { ...materialized, derivation: source } });
        expect(input?.binding.endpoint).toBe(endpoint);
        if (!input) throw new Error("Synthetic empty-suffix draft did not parse");
        const audit = { actorId: f.ownerId, requestId: crypto.randomUUID() };
        const saved = await createModelPriceDraft(database.db, input, audit);
        expect(saved.status).toBe("saved");
        if (saved.status !== "saved") throw new Error("Synthetic empty-suffix draft did not save");
        expect(saved.draft.binding.endpoint).toBe(endpoint);
        const [stored] = await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.id, saved.draft.id));
        expect(stored?.endpointSnapshot).toBe(endpoint);
        expect(stored?.rules.derivation?.binding.endpoint).toBe(endpoint);
        // A lawful saved binding must also pass the SQL publication source guard.
        const publication = await publishModelPriceDraft(database.db, { modelId: f.modelId, draftId: saved.draft.id,
            expectedDraftVersion: saved.draft.version, expectedPriceVersion: 0, binding, publicPriceNote: "Synthetic endpoint control" }, audit);
        expect(publication.status).toBe("published");
        if (publication.status !== "published") throw new Error("Synthetic empty-suffix publication failed");
        const task = await createGenerationTaskRepository(database.db).create(intent(f));
        expect(await getImageSpecTaskSnapshot(database.db, task.task)).toMatchObject({ status: "recorded",
            publicationId: publication.publication.id, parameters: { size: "2048x2048", quality: "high" }, creditsPerRequest: 11 });
    }
}, 30_000);

test("complete task identity is immutable while reservation and normal lifecycle transitions remain legal", async () => {
    const f = await seed(); await publish(f);
    const tasks = createGenerationTaskRepository(database.db), created = await tasks.create(intent(f));
    const other = await seed();
    const mutations: Array<Partial<typeof generationTask.$inferInsert>> = [
        { id: crypto.randomUUID() }, { ownerId: other.ownerId }, { modelId: other.modelId }, { requestId: "changed" },
        { idempotencyKey: "changed" }, { inputSnapshot: { prompt: "changed" } }, { parameterSnapshot: {} },
        { spaceId: "changed" }, { projectId: "changed" }, { nodeId: "changed" }, { priceVersion: 2 },
        { quotedUnits: 7 }, { billingUnitSnapshot: "second" }, { creditsPerUnitSnapshot: 7 }, { pricePublicationId: null },
        { textQuoteSnapshot: { schemaVersion: 1, budgetCredits: "1", inputCreditsPerMillion: "2", outputCreditsPerMillion: "4", usageSource: "chat_completions" } },
        { createdAt: new Date("2026-01-01Z") },
    ];
    const [original] = await database.db.select().from(generationTask).where(eq(generationTask.id, created.task.id));
    for (const mutation of mutations) await expect(database.db.update(generationTask).set(mutation).where(eq(generationTask.id, created.task.id)).execute()).rejects.toThrow();
    expect((await database.db.select().from(generationTask).where(eq(generationTask.id, created.task.id)))[0]).toEqual(original);
    const reservation = await createWalletRepository(database.db).reserve({ userId: f.ownerId, requestedUnits: 11,
        idempotencyKey: crypto.randomUUID(), taskId: created.task.id, referenceType: "generation", referenceId: created.task.id });
    await tasks.setReservationId({ ownerId: f.ownerId, taskId: created.task.id, reservationId: reservation.id });
    const otherReservation = await createWalletRepository(database.db).reserve({ userId: f.ownerId, requestedUnits: 1,
        idempotencyKey: crypto.randomUUID(), referenceType: "synthetic", referenceId: crypto.randomUUID() });
    for (const reservationId of [otherReservation.id, null]) await expect(database.db.update(generationTask).set({ reservationId })
        .where(eq(generationTask.id, created.task.id)).execute()).rejects.toThrow();
    expect((await tasks.setReservationId({ ownerId: f.ownerId, taskId: created.task.id, reservationId: reservation.id })).reservationId).toBe(reservation.id);
    await tasks.transitionBilling({ ownerId: f.ownerId, taskId: created.task.id, status: "reserved" });
    await tasks.transitionExecution({ ownerId: f.ownerId, taskId: created.task.id, status: "queued" });
    expect((await tasks.transitionExecution({ ownerId: f.ownerId, taskId: created.task.id, status: "running" })).executionStatus).toBe("running");
    expect((await tasks.transitionDelivery({ ownerId: f.ownerId, taskId: created.task.id, status: "saved" })).deliveryStatus).toBe("saved");
});

test("a partial publication-function upgrade refuses image_specs and restored 0026 accepts it", async () => {
    const oldSql = await readFile(new URL("../../../packages/database/migrations/0025_text_cached_pricing.sql", import.meta.url), "utf8");
    const newSql = await readFile(new URL("../../../packages/database/migrations/0026_image_spec_task_contract.sql", import.meta.url), "utf8");
    const statement = (text: string) => text.split("--> statement-breakpoint").find(part => part.includes('CREATE OR REPLACE FUNCTION "canvas_saas"."check_model_price_publication_source"'))!;
    const f = await seed();
    const audit = { actorId: f.ownerId, requestId: crypto.randomUUID() };
    const saved = await createModelPriceDraft(database.db, f.draftInput, audit);
    if (saved.status !== "saved") throw new Error("Synthetic partial-upgrade draft failed");
    const input = { modelId: f.modelId, draftId: saved.draft.id, expectedDraftVersion: saved.draft.version,
        expectedPriceVersion: 0, binding: f.binding, publicPriceNote: "Synthetic partial upgrade" };
    await database.db.execute(sql.raw(statement(oldSql)));
    try { await expect(publishModelPriceDraft(database.db, input, audit)).rejects.toThrow(); }
    finally { await database.db.execute(sql.raw(statement(newSql))); }
    const restored = await publishModelPriceDraft(database.db, input, audit);
    expect(restored.status).toBe("published");
    if (restored.status === "published") expect(restored.publication.billingUnit).toBe("image_specs");
});

test("legacy scalar and text sources remain distinct controls under the new bindings", async () => {
    const scalar = await seed();
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: scalar.modelId, version: 1,
        billingUnit: "request", creditsPerUnit: 3, effectiveFrom: new Date(), enabled: true });
    const scalarTask = await createGenerationTaskRepository(database.db).create({ ...intent(scalar), parameterSnapshot: {}, creditsPerUnitSnapshot: 3, quotedUnits: 3 });
    expect(scalarTask.task.pricePublicationId).toBeNull();
    expect(await getImageSpecTaskSnapshot(database.db, scalarTask.task)).toEqual({ status: "legacy" });
    expect(await validatePublishedGenerationTask(database.db, scalarTask.task, scalar.binding)).toBe(true);
    const laterRulePrice = await publish(scalar, scalar.draftInput, 1);
    expect(await getImageSpecTaskSnapshot(database.db, scalarTask.task)).toEqual({ status: "legacy" });
    expect(await getImageSpecTaskSnapshot(database.db, { ...scalarTask.task, pricePublicationId: laterRulePrice.id })).toEqual({ status: "invalid" });
    expect(await validatePublishedGenerationTask(database.db, scalarTask.task, scalar.binding)).toBe(true);
    const text = await seed("text"), textPrice = await publish(text);
    const textTask = await createGenerationTaskRepository(database.db).create({ ownerId: text.ownerId, modelId: text.modelId,
        inputSnapshot: { prompt: "Synthetic text control" }, parameterSnapshot: {}, priceVersion: 1,
        textQuoteSnapshot: { schemaVersion: 1, budgetCredits: "2", inputCreditsPerMillion: "2", outputCreditsPerMillion: "4", usageSource: "chat_completions" },
        idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() });
    expect(textTask.task.pricePublicationId).toBe(textPrice.id);
    expect(await getImageSpecTaskSnapshot(database.db, textTask.task)).toEqual({ status: "legacy" });
    expect(await validatePublishedGenerationTask(database.db, textTask.task, text.binding)).toBe(true);
});
