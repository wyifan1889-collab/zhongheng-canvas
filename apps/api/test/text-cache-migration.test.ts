import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { checkGenerationDatabaseReadiness } from "../src/readiness";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Requires isolated memory database");

test("0025 preserves accepted dual-rate tasks, prices and balances and gates either partial function upgrade", async () => {
    const client = new PGlite();
    const connection = { query: (text: string, values?: readonly unknown[]) => client.query<{ relation: string }>(text, values ? [...values] : undefined) };
    try {
        const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)) });
        // Later migrations do not change the 0025/0026 upgrade under test.
        expect(migrations.length).toBeGreaterThanOrEqual(27);
        for (const migration of migrations.slice(0, 25)) for (const statement of migration.sql) await client.exec(statement);
        await client.exec(`BEGIN;
            INSERT INTO canvas_saas."user" (id,name,email) VALUES ('cache-legacy-owner','Fixture','cache-legacy@example.test');
            INSERT INTO canvas_saas.wallet (user_id,available_units,reserved_units) VALUES ('cache-legacy-owner',1.25,0);
            INSERT INTO canvas_saas.model_provider (id,display_name,adapter,endpoint,secret_ref,enabled)
                VALUES ('cache-legacy-provider','Fixture','sub2api','https://provider.invalid/v1','synthetic-only',true);
            INSERT INTO canvas_saas.model_catalog (id,provider_id,public_id,provider_model,display_name,capability,enabled)
                VALUES ('cache-legacy-model','cache-legacy-provider','cache-legacy-model','fixture-text','Fixture','text',true);
            INSERT INTO canvas_saas.model_price_draft
                (id,model_id,version,rules,price_note,provider_id_snapshot,provider_model_snapshot,adapter_snapshot,endpoint_snapshot,capability_snapshot)
                VALUES ('cache-legacy-draft','cache-legacy-model',1,
                    '{"schemaVersion":1,"cost":null,"sale":{"template":"text_tokens","currency":"credit","bands":[{"parameters":{},"rates":{"input_token":"2","output_token":"4"}}]}}',
                    'synthetic','cache-legacy-provider','fixture-text','sub2api','https://provider.invalid/v1','text');
            INSERT INTO canvas_saas.model_pricing (id,model_id,version,billing_unit,credits_per_unit,effective_from,enabled)
                VALUES ('cache-legacy-price','cache-legacy-model',1,'text_tokens',NULL,now(),true);
            INSERT INTO canvas_saas.model_price_publication (id,pricing_id,draft_id,public_price_note)
                VALUES ('cache-legacy-publication','cache-legacy-price','cache-legacy-draft','synthetic');
            INSERT INTO canvas_saas.generation_task
                (id,owner_id,model_id,input_snapshot,parameter_snapshot,price_version,text_quote_snapshot,idempotency_key,request_id)
                VALUES ('cache-legacy-task','cache-legacy-owner','cache-legacy-model','{}','{}',1,
                    '{"schemaVersion":1,"budgetCredits":"1","inputCreditsPerMillion":"2","outputCreditsPerMillion":"4","usageSource":"responses"}',
                    'cache-legacy-key','cache-legacy-request');
            COMMIT;`);
        const tables = ["generation_task", "model_price_draft", "model_price_publication", "model_pricing", "wallet", "wallet_ledger", "wallet_reservation"];
        const snapshot = () => Promise.all(tables.map(table => client.query(`SELECT * FROM canvas_saas.${table}`).then(result => result.rows)));
        const before = await snapshot();
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        const migration = migrations[25]!;
        expect(migration.sql).toHaveLength(2);
        await client.exec(migration.sql[0]!);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        await client.exec(migration.sql[1]!);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        for (const statement of migrations[26]!.sql) await client.exec(statement);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        expect(await snapshot()).toEqual(before);
        const oldBinder = migrations[24]!.sql.find(statement => statement.includes('CREATE OR REPLACE FUNCTION "canvas_saas"."bind_generation_task_price_publication"'))!;
        await client.exec(oldBinder);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        const currentBinder = migrations[26]!.sql.find(statement => statement.includes('CREATE OR REPLACE FUNCTION "canvas_saas"."bind_generation_task_price_publication"'))!;
        await client.exec(currentBinder);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        expect(await snapshot()).toEqual(before);
    } finally { await client.close(); }
}, 30_000);
