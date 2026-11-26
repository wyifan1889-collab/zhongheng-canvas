import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Database } from "@infinite-canvas/database";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import * as schema from "@infinite-canvas/database/schema";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { quoteReserveAndEnqueueConfirmedImageTask, type GenerationQueueSender } from "../src/generation-dispatch";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("This suite requires isolated in-memory PGlite");
const { user, modelProvider, modelProviderCredential, modelCatalog, modelPricing, modelPricePublication,
    modelPriceDraft, generationTask, wallet, walletReservation, walletLedger } = schema;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

async function seed(db: Database = database.db) {
    const id = crypto.randomUUID(), ownerId = `owner-${id}`, providerId = `provider-${id}`, modelId = `model-${id}`;
    await db.insert(user).values({ id: ownerId, name: "Synthetic task source owner", email: `${id}@example.test` });
    await db.insert(wallet).values({ userId: ownerId, availableUnits: "100" });
    await db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic source", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", secretRef: "synthetic", enabled: true });
    // No provider is invoked; only the existing credential presence gate is exercised.
    await db.insert(modelProviderCredential).values({ providerId, ciphertext: "synthetic", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: "synthetic-image", displayName: "Synthetic image", capability: "image", enabled: true });
    const draftInput: ModelPriceDraftWrite = {
        modelId, expectedVersion: 0,
        binding: { providerId, providerModel: "synthetic-image", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability: "image" },
        rules: { schemaVersion: 1,
            cost: { template: "image_request", currency: "CNY", bands: [{ parameters: {}, rates: { request: "0.3141592653589" } }] },
            sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } },
        priceNote: "synthetic private note",
    };
    const intent = { ownerId, modelId, inputSnapshot: { prompt: "synthetic image" }, parameterSnapshot: {}, projectId: "synthetic-project", idempotencyKey: `task-${id}`, requestId: `request-${id}` };
    return { ownerId, modelId, draftInput, intent };
}

async function publish(input: ModelPriceDraftWrite, ownerId: string, expectedPriceVersion = 0, db: Database = database.db) {
    const audit = { actorId: ownerId, requestId: crypto.randomUUID() };
    const saved = await createModelPriceDraft(db, input, audit);
    if (saved.status !== "saved") throw new Error("Synthetic draft setup failed");
    const result = await publishModelPriceDraft(db, { modelId: input.modelId, draftId: saved.draft.id,
        expectedDraftVersion: saved.draft.version, expectedPriceVersion, binding: saved.draft.binding, publicPriceNote: "Public synthetic price" }, audit);
    if (result.status !== "published") throw new Error("Synthetic publication setup failed");
    return result.publication;
}

function queue() {
    const jobs: string[] = [];
    const sender: GenerationQueueSender = { async send(name, payload, options) {
        expect(name).toBe("generation"); expect(options?.db).toBeDefined();
        jobs.push(payload.taskId); return `synthetic-job-${jobs.length}`;
    } };
    return { jobs, sender };
}
async function source(taskId: string) {
    const [row] = await database.db.select().from(generationTask).where(eq(generationTask.id, taskId));
    return row!;
}
const businessState = () => Promise.all([database.db.select().from(generationTask), database.db.select().from(wallet),
    database.db.select().from(walletReservation), database.db.select().from(walletLedger)]);

test("real confirmed dispatch binds the immutable publication and replay keeps it after a newer price", async () => {
    const fixture = await seed(), first = await publish(fixture.draftInput, fixture.ownerId), transport = queue();
    const accepted = await quoteReserveAndEnqueueConfirmedImageTask(database.db, transport.sender, fixture.intent, 1);
    expect(await source(accepted.task.id)).toMatchObject({ pricePublicationId: first.id, priceVersion: 1, quotedUnits: 7 });
    expect(accepted.task.pricePublicationId).toBe(first.id); // Internal view; publicTask remains an explicit whitelist.
    const next = structuredClone(fixture.draftInput); next.expectedVersion = 1;
    next.rules.cost = null; next.rules.sale.bands[0]!.rates.request = "9";
    const second = await publish(next, fixture.ownerId, 1), beforeReplay = await businessState();
    const replay = await quoteReserveAndEnqueueConfirmedImageTask(database.db, transport.sender, { ...fixture.intent, requestId: "replay-new-http-request" }, 1);
    expect(replay).toMatchObject({ created: false, task: { id: accepted.task.id, quotedUnits: 7 }, reservation: { id: accepted.reservation.id } });
    expect(await businessState()).toEqual(beforeReplay); expect(transport.jobs).toHaveLength(1);
    const fresh = await quoteReserveAndEnqueueConfirmedImageTask(database.db, transport.sender, { ...fixture.intent, idempotencyKey: "new-nine-credit-task" }, 2);
    expect(await source(fresh.task.id)).toMatchObject({ pricePublicationId: second.id, priceVersion: 2, quotedUnits: 9 });
    const [original] = await database.db.select({ rules: modelPriceDraft.rules }).from(modelPricePublication)
        .innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId)).where(eq(modelPricePublication.id, first.id));
    expect(original?.rules).toEqual(fixture.draftInput.rules);
    const [balance] = await database.db.select().from(wallet).where(eq(wallet.userId, fixture.ownerId));
    expect(balance).toMatchObject({ availableUnits: "84", reservedUnits: "16" });
});

test("legacy prices stay null and replay does not silently upgrade to a later publication", async () => {
    const fixture = await seed(), transport = queue();
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: fixture.modelId, version: 1, billingUnit: "request", creditsPerUnit: 3, effectiveFrom: new Date("2026-01-01Z"), enabled: true });
    const accepted = await quoteReserveAndEnqueueConfirmedImageTask(database.db, transport.sender, fixture.intent, 1);
    expect((await source(accepted.task.id)).pricePublicationId).toBeNull();
    await publish(fixture.draftInput, fixture.ownerId, 1);
    const before = await businessState();
    expect((await quoteReserveAndEnqueueConfirmedImageTask(database.db, transport.sender, fixture.intent, 1)).created).toBe(false);
    expect(await businessState()).toEqual(before); expect(transport.jobs).toHaveLength(1);
    expect((await source(accepted.task.id)).pricePublicationId).toBeNull();
});

test("direct inserts cannot forge a publication or understate its single-request snapshot", async () => {
    const fixture = await seed(), publication = await publish(fixture.draftInput, fixture.ownerId);
    const other = await seed(), otherPublication = await publish(other.draftInput, other.ownerId);
    const base: typeof generationTask.$inferInsert = { ...fixture.intent, id: crypto.randomUUID(), priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7 };
    const mutations: Array<Partial<typeof generationTask.$inferInsert>> = [
        { pricePublicationId: otherPublication.id }, { pricePublicationId: "missing-publication" },
        { quotedUnits: 1 }, { quotedUnits: null }, { creditsPerUnitSnapshot: 1 },
        { billingUnitSnapshot: "output_token" }, { billingUnitSnapshot: null, creditsPerUnitSnapshot: null },
        { priceVersion: 2, pricePublicationId: publication.id },
    ];
    const before = await businessState();
    for (const mutation of mutations) await expect(database.db.insert(generationTask).values({ ...base, ...mutation }).execute()).rejects.toThrow();
    expect(await businessState()).toEqual(before);
    const [explicit] = await database.db.insert(generationTask).values({ ...base, pricePublicationId: publication.id }).returning();
    expect(explicit?.pricePublicationId).toBe(publication.id);
});

test("all confirmed price identity fields stay immutable while normal task transitions still work", async () => {
    const fixture = await seed(), publication = await publish(fixture.draftInput, fixture.ownerId), transport = queue();
    const accepted = await quoteReserveAndEnqueueConfirmedImageTask(database.db, transport.sender, fixture.intent, 1);
    const before = await source(accepted.task.id);
    const mutations: Array<Partial<typeof generationTask.$inferInsert>> = [
        { modelId: "another-model" }, { priceVersion: 2 }, { priceVersion: null }, { quotedUnits: 8 },
        { billingUnitSnapshot: "output_token" }, { creditsPerUnitSnapshot: 8 },
        { pricePublicationId: null }, { pricePublicationId: "another-source" },
    ];
    for (const mutation of mutations) await expect(database.db.update(generationTask).set(mutation).where(eq(generationTask.id, accepted.task.id)).execute()).rejects.toThrow();
    expect(await source(accepted.task.id)).toEqual(before);
    const running = await createGenerationTaskRepository(database.db).transitionExecution({ ownerId: fixture.ownerId, taskId: accepted.task.id, status: "running" });
    expect(running.executionStatus).toBe("running");
    expect((await source(accepted.task.id)).pricePublicationId).toBe(publication.id);
    await expect(database.db.update(modelPricePublication).set({ publicPriceNote: "overwrite source" }).where(eq(modelPricePublication.id, publication.id)).execute()).rejects.toThrow();
    await expect(database.db.update(modelPriceDraft).set({ rules: { ...fixture.draftInput.rules, cost: null } }).where(eq(modelPriceDraft.id, publication.draftId)).execute()).rejects.toThrow();
});

test("queue failure rolls back task source, wallet reserve and ledger together", async () => {
    const fixture = await seed(); await publish(fixture.draftInput, fixture.ownerId);
    const before = await businessState(); let sends = 0;
    await expect(quoteReserveAndEnqueueConfirmedImageTask(database.db, { async send() { sends++; throw new Error("synthetic queue rejection"); } }, fixture.intent, 1)).rejects.toThrow("synthetic queue rejection");
    expect(sends).toBe(1); expect(await businessState()).toEqual(before);
});

test("0018 adds no inferred source to pre-migration tasks even when the historical price has a publication", async () => {
    const client = new PGlite();
    try {
        const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)) });
        const sourceMigrationIndex = migrations.findIndex((migration) => migration.sql.join("\n").includes("CREATE FUNCTION \"canvas_saas\".\"bind_generation_task_price_publication\""));
        expect(sourceMigrationIndex).toBeGreaterThan(0);
        const current = migrations[sourceMigrationIndex]!;
        expect(current.sql.join("\n")).toContain("bind_generation_task_price_publication");
        for (const migration of migrations.slice(0, sourceMigrationIndex)) for (const statement of migration.sql) await client.exec(statement);
        // Use only columns present through 0017; current repository helpers target later schemas.
        const taskId = "pre-0018-task", publicationId = "pre-0018-publication";
        await client.exec(`BEGIN;
            INSERT INTO canvas_saas."user" (id,name,email)
                VALUES ('pre-0018-owner','Synthetic task source owner','pre-0018@example.test');
            INSERT INTO canvas_saas.model_provider (id,display_name,adapter,endpoint,secret_ref,enabled)
                VALUES ('pre-0018-provider','Synthetic source','openai-compatible','https://provider.invalid/v1','synthetic',true);
            INSERT INTO canvas_saas.model_catalog (id,provider_id,public_id,provider_model,display_name,capability,enabled)
                VALUES ('pre-0018-model','pre-0018-provider','pre-0018-model','synthetic-image','Synthetic image','image',true);
            INSERT INTO canvas_saas.model_price_draft
                (id,model_id,version,rules,price_note,provider_id_snapshot,provider_model_snapshot,adapter_snapshot,endpoint_snapshot,capability_snapshot)
                VALUES ('pre-0018-draft','pre-0018-model',1,
                    '{"schemaVersion":1,"cost":null,"sale":{"template":"image_request","currency":"credit","bands":[{"parameters":{},"rates":{"request":"7"}}]}}',
                    'synthetic private note','pre-0018-provider','synthetic-image','openai-compatible','https://provider.invalid/v1','image');
            INSERT INTO canvas_saas.model_pricing (id,model_id,version,billing_unit,credits_per_unit,effective_from,enabled)
                VALUES ('pre-0018-price','pre-0018-model',1,'request',7,now(),true);
            INSERT INTO canvas_saas.model_price_publication (id,pricing_id,draft_id,public_price_note)
                VALUES ('pre-0018-publication','pre-0018-price','pre-0018-draft','Public synthetic price');
            INSERT INTO canvas_saas.generation_task
                (id,owner_id,model_id,input_snapshot,parameter_snapshot,price_version,quoted_units,billing_unit_snapshot,credits_per_unit_snapshot,idempotency_key,request_id)
                VALUES ('pre-0018-task','pre-0018-owner','pre-0018-model','{}','{}',1,7,'request',7,'pre-0018','pre-0018');
            COMMIT;`);
        const original = await client.query<{ row: Record<string, unknown> }>("SELECT row_to_json(t) AS row FROM canvas_saas.generation_task t WHERE id = $1", [taskId]);
        for (const statement of current.sql) await client.exec(statement);
        const migrated = await client.query<{ row: Record<string, unknown> }>("SELECT row_to_json(t) AS row FROM canvas_saas.generation_task t WHERE id = $1", [taskId]);
        expect(migrated.rows[0]!.row).toEqual({ ...original.rows[0]!.row, price_publication_id: null });
        await expect(client.query("UPDATE canvas_saas.generation_task SET price_publication_id = $1 WHERE id = $2", [publicationId, taskId]))
            .rejects.toThrow("Generation task price snapshot and publication source are immutable");
        await client.query("UPDATE canvas_saas.generation_task SET execution_status = 'queued' WHERE id = $1", [taskId]);
        const unchanged = await client.query<{ price_publication_id: string | null; execution_status: string }>(
            "SELECT price_publication_id, execution_status FROM canvas_saas.generation_task WHERE id = $1", [taskId]);
        expect(unchanged.rows).toEqual([{ price_publication_id: null, execution_status: "queued" }]);
    } finally { await client.close(); }
});
