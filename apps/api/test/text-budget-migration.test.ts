import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { checkGenerationDatabaseReadiness } from "../src/readiness";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Requires isolated memory database");

test("0024 through the current migrations preserve historical scalar snapshots and gate partial schema readiness", async () => {
    const client = new PGlite();
    const connection = { query: (text: string, values?: readonly unknown[]) => client.query<{ relation: string }>(text, values ? [...values] : undefined) };
    try {
        const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)) });
        const target = migrations.findIndex((entry) => entry.sql.some((statement) => statement.includes('ADD COLUMN "text_quote_snapshot"')));
        expect(target).toBe(24);
        for (const migration of migrations.slice(0, target)) for (const statement of migration.sql) await client.exec(statement);
        await client.exec(`INSERT INTO canvas_saas."user" (id,name,email) VALUES ('legacy-text-owner','Fixture','legacy-text@example.test');
            INSERT INTO canvas_saas.wallet (user_id,available_units,reserved_units) VALUES ('legacy-text-owner',10.125,2);
            INSERT INTO canvas_saas.generation_task (id,owner_id,model_id,input_snapshot,parameter_snapshot,price_version,quoted_units,billing_unit_snapshot,credits_per_unit_snapshot,idempotency_key,request_id)
                VALUES ('legacy-scalar-task','legacy-text-owner','legacy-model','{}','{}',1,2,'request',2,'legacy-key','legacy-request');`);
        const beforeTask = (await client.query("SELECT * FROM canvas_saas.generation_task")).rows;
        const beforeWallet = (await client.query("SELECT * FROM canvas_saas.wallet")).rows;
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        for (const statement of migrations[target]!.sql) await client.exec(statement);
        expect((await client.query("SELECT * FROM canvas_saas.generation_task")).rows).toEqual(beforeTask.map((row) => ({ ...row, text_quote_snapshot: null })));
        expect((await client.query("SELECT * FROM canvas_saas.wallet")).rows).toEqual(beforeWallet);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        for (const migration of migrations.slice(target + 1)) for (const statement of migration.sql) await client.exec(statement);
        const historicalColumns = Object.keys(beforeTask[0]!).map(column => `"${column.replaceAll('"', '""')}"`).join(",");
        expect((await client.query(`SELECT ${historicalColumns}, text_quote_snapshot FROM canvas_saas.generation_task`)).rows)
            .toEqual(beforeTask.map((row) => ({ ...row, text_quote_snapshot: null })));
        expect((await client.query("SELECT * FROM canvas_saas.wallet")).rows).toEqual(beforeWallet);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        await client.exec("ALTER TABLE canvas_saas.generation_task DISABLE TRIGGER generation_task_price_source_immutable");
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        await client.exec("ALTER TABLE canvas_saas.generation_task ENABLE TRIGGER generation_task_price_source_immutable");
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(true);
        await client.exec("BEGIN READ ONLY");
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
        await client.exec("ROLLBACK");
        const oldPublication = migrations[20]!.sql.find((statement) => statement.includes('CREATE OR REPLACE FUNCTION "canvas_saas"."check_model_price_publication_source"'));
        expect(oldPublication).toBeDefined();
        await client.exec(oldPublication!);
        expect(await checkGenerationDatabaseReadiness(connection)).toBe(false);
    } finally { await client.close(); }
}, 30_000);
