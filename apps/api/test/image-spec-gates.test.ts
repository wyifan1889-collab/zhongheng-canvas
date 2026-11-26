import { expect, test } from "bun:test";
import { generationPng64x48 as png } from "./fixtures/generation-png";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { ModelPriceBinding, ModelPriceRules } from "@infinite-canvas/shared";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { modelCatalog, modelPricing, modelProvider, modelProviderCredential, user } from "@infinite-canvas/database/schema";
import { checkGenerationDatabaseReadiness } from "../src/readiness";
import { evaluateGenerationPreflight, type GenerationPreflightSnapshot } from "../src/generation-config-preflight";
import { createGenerationProvider } from "../src/generation-provider";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("I1 gates require isolated in-memory PGlite");

const now = new Date("2026-10-25T00:00:00.000Z");
const imageOptions = { testAccountId: "synthetic-i1-wallet", now, capability: "image" as const, publicModelId: "synthetic-image-selected" };
const scalarSnapshot: GenerationPreflightSnapshot = {
    providers: [{ id: "synthetic-provider", enabled: true, adapter: "openai-compatible", credentialConfigured: true }],
    models: [{ id: "synthetic-model", publicId: imageOptions.publicModelId, providerId: "synthetic-provider", capability: "image", enabled: true }],
    pricing: [{ modelId: "synthetic-model", version: 1, billingUnit: "request", creditsPerUnit: 7, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, enabled: true }],
    wallets: [{ userId: imageOptions.testAccountId, unit: "credit", availableUnits: "1000", reservedUnits: "0" }],
};

test("I1 image-spec metadata is recognized but cannot produce an execution or default-price preflight", () => {
    const latest = { ...scalarSnapshot.pricing[0]!, version: 2, billingUnit: "image_specs" as const, creditsPerUnit: null };
    for (const minimumWalletUnits of [undefined, 1, 100]) {
        const result = evaluateGenerationPreflight({ ...scalarSnapshot, pricing: [...scalarSnapshot.pricing, latest] }, { ...imageOptions, minimumWalletUnits });
        expect(result.status).toBe("blocked");
        expect(result.summary.image).toMatchObject({ priceVersion: 2, billingUnit: "image_specs", creditsPerRequest: null, requiredWalletUnits: null });
        expect(result.summary.testWalletReady).toBe(false);
        expect(result.checks).toContainEqual({ code: "image_spec_execution_unavailable", status: "fail" });
    }
    expect(() => evaluateGenerationPreflight({ ...scalarSnapshot, pricing: [{ ...latest, creditsPerUnit: 1 } as any] }, imageOptions)).toThrow();
    expect(evaluateGenerationPreflight(scalarSnapshot, imageOptions)).toMatchObject({ status: "ready", summary: { image: { creditsPerRequest: 7, requiredWalletUnits: 7 } } });
});

function functionStatement(statements: string[], name: string): string {
    const pattern = new RegExp(`CREATE(?: OR REPLACE)? FUNCTION\\s+"?canvas_saas"?\\."?${name}"?\\s*\\(`);
    const statement = statements.findLast(value => pattern.test(value));
    if (!statement) throw new Error(`Missing migration function ${name}`);
    return statement.replace(/\bCREATE FUNCTION\b/, "CREATE OR REPLACE FUNCTION");
}

test("I1 readiness rejects partial 0026 upgrades and damaged image protections on the current schema", async () => {
    const client = new PGlite();
    const connection = { query: (text: string, values?: readonly unknown[]) => client.query<{ relation: string }>(text, values ? [...values] : undefined) };
    try {
        const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)) });
        for (const migration of migrations.slice(0, 26)) for (const statement of migration.sql) await client.exec(statement);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        const upgrade = migrations[26]!.sql;
        const helper = functionStatement(upgrade, "image_spec_task_credits");
        await client.exec(helper);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        await client.exec("DROP FUNCTION canvas_saas.image_spec_task_credits(jsonb,jsonb)");
        for (const statement of upgrade) await client.exec(statement);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        for (const migration of migrations.slice(27)) for (const statement of migration.sql) await client.exec(statement);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        const current = migrations.flatMap(migration => migration.sql);
        const currentWrapper = functionStatement(current, "image_spec_task_credits");
        const currentCore = functionStatement(migrations[26]!.sql, "image_spec_task_credits")
            .replace('"image_spec_task_credits"(', '"image_spec_task_credits_core"(');
        const rejectsMutation = async (statement: string) => {
            await client.exec("BEGIN");
            try {
                await client.exec(statement);
                expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
            } finally { await client.exec("ROLLBACK"); }
            expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        };
        for (const [name, oldIndex] of [
            ["check_model_price_publication_source", 25], ["bind_generation_task_price_publication", 25],
            ["protect_generation_task_price_source", 24],
        ] as const) {
            await rejectsMutation(functionStatement(migrations[oldIndex]!.sql, name));
        }
        for (const guard of ["jsonb_typeof(checked_rule)", "jsonb_typeof(derivation)", "jsonb_typeof(binding)", "jsonb_typeof(source)"]) {
            expect(currentCore).toContain(guard);
            await rejectsMutation(currentCore.replaceAll(guard, "'object'::text"));
        }
        const wrapperGuard = "task_parameters->'response_format' IS DISTINCT FROM policy->'responseFormat'";
        expect(currentWrapper).toContain(wrapperGuard);
        await rejectsMutation(currentWrapper.replace(wrapperGuard, "false"));
        for (const name of ["check_model_price_publication_source", "bind_generation_task_price_publication"]) {
            const complete = functionStatement(current, name);
            for (const column of ["provider_id_snapshot", "provider_model_snapshot", "adapter_snapshot", "endpoint_snapshot", "capability_snapshot"]) {
                expect(complete).toContain(`source.${column}`);
                await rejectsMutation(complete.replaceAll(`source.${column}`, "'omitted'::text"));
            }
        }
        const immutable = functionStatement(current, "protect_generation_task_price_source");
        for (const column of ["id", "owner_id", "idempotency_key", "request_id", "model_id", "input_snapshot", "parameter_snapshot",
            "space_id", "project_id", "node_id", "price_version", "quoted_units", "billing_unit_snapshot", "credits_per_unit_snapshot",
            "price_publication_id", "text_quote_snapshot", "created_at", "reservation_id"]) {
            const damaged = immutable.replace(new RegExp(`\\b(?:OLD|NEW)\\.${column}\\b`, "g"), "NULL");
            expect(damaged).not.toBe(immutable);
            await rejectsMutation(damaged);
        }
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        const args = (await client.query<{ args: string }>("SELECT pg_get_function_arguments('canvas_saas.image_spec_task_credits(jsonb,jsonb)'::regprocedure) AS args")).rows[0]!.args;
        await rejectsMutation(`CREATE OR REPLACE FUNCTION canvas_saas.image_spec_task_credits(${args}) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::bigint $$`);
        await client.exec("BEGIN READ ONLY");
        try { expect(await checkGenerationDatabaseReadiness(connection)).toBe(false); }
        finally { await client.exec("ROLLBACK"); }
        await rejectsMutation("ALTER TABLE canvas_saas.model_pricing DROP CONSTRAINT model_pricing_credits_positive");
    } finally { await client.close(); }
}, 30_000);

test("image-spec tasks require credentials and a valid source while legacy scalar images keep their path", async () => {
    const database = await createTestDatabase();
    const ownerId = crypto.randomUUID(), secret = "synthetic-i1-gates-" + crypto.randomUUID() + crypto.randomUUID();
    try {
        await database.db.insert(user).values({ id: ownerId, name: "I1 gates", email: `${ownerId}@example.test` });
        const suffix = crypto.randomUUID();
        const providerId = `i1-provider-${suffix}`, modelId = `i1-image-${suffix}`, legacyId = `i1-legacy-${suffix}`;
        await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic I1", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", secretRef: "synthetic-i1-gates", enabled: true });
        await saveProviderCredential(database.db, secret, providerId, "synthetic-provider-credential");
        for (const [id, providerModel] of [[modelId, "synthetic-image"], [legacyId, "synthetic-legacy-image"]] as const) {
            await database.db.insert(modelCatalog).values({ id, publicId: id, providerId, providerModel, displayName: id, capability: "image", enabled: true });
        }
        const binding: ModelPriceBinding = { providerId, providerModel: "synthetic-image", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability: "image" };
        const rules: ModelPriceRules = { schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands: [
            { parameters: { size: "1024x1024", quality: "low" }, rates: { request: "7" } },
            { parameters: { size: "1024x1024", quality: "high" }, rates: { request: "11" } },
        ] } };
        const saved = await createModelPriceDraft(database.db, { modelId, expectedVersion: 0, binding, rules, priceNote: "Synthetic only" }, { actorId: ownerId, requestId: crypto.randomUUID() });
        if (saved.status !== "saved") throw new Error("Synthetic draft was not saved");
        const publication = await publishModelPriceDraft(database.db, { modelId, draftId: saved.draft.id, expectedDraftVersion: saved.draft.version, expectedPriceVersion: 0, binding, publicPriceNote: "Synthetic only" }, { actorId: ownerId, requestId: crypto.randomUUID() });
        if (publication.status !== "published") throw new Error("Synthetic spec publication was not created");
        const tasks = createGenerationTaskRepository(database.db);
        const specTask = (await tasks.create({ ownerId, modelId, inputSnapshot: { prompt: "Synthetic I1" }, parameterSnapshot: { size: "1024x1024", quality: "low", n: 1, output_format: "png" },
            priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() })).task;
        // No image task can execute without the current original provider credential.
        await database.db.delete(modelProviderCredential).where(eq(modelProviderCredential.providerId, providerId));
        let upstreamCalls = 0;
        const provider = createGenerationProvider({ database: database.db, authSecret: secret, imageMaxBytes: Buffer.from(png, "base64").length,
            gateway: { async request() { upstreamCalls++; return { status: "succeeded", upstreamStatus: 200, payload: { data: [{ b64_json: png }] } }; } } });
        expect(await provider(specTask)).toEqual({ status: "failed", errorCode: "model_unavailable" });
        expect(await provider({ ...specTask, pricePublicationId: null })).toEqual({ status: "failed", errorCode: "model_unavailable" });
        expect(upstreamCalls).toBe(0);
        await saveProviderCredential(database.db, secret, providerId, "synthetic-provider-credential");
        await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: legacyId, version: 1, billingUnit: "request", creditsPerUnit: 3, effectiveFrom: new Date(), enabled: true });
        const legacy = (await tasks.create({ ownerId, modelId: legacyId, inputSnapshot: { prompt: "Synthetic legacy" }, parameterSnapshot: {},
            priceVersion: 1, quotedUnits: 3, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 3, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() })).task;
        expect(await provider(legacy)).toMatchObject({ status: "succeeded", consumedUnits: 1 });
        expect(upstreamCalls).toBe(1);
    } finally { await database.close(); }
}, 30_000);
