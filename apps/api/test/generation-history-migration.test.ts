import { expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { getGenerationHistoryForOwner, renameGenerationHistoryForOwner } from "../src/generation-history";
import { expectCurrentMigrations } from "./migrations";

test("history title schema upgrades a previous database without changing generation rows and preserves renamed titles", async () => {
    const migrationsFolder = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
    const migrationsSchema = "canvas_migrations";
    const options = { migrationsFolder, migrationsSchema };
    const migrations = readMigrationFiles(options);
    const last = migrations.findIndex(migration => migration.sql.some(statement => statement.includes('CREATE TABLE "canvas_saas"."generation_history_title"')));
    expect(last).toBeGreaterThan(0);
    const pg = new PGlite();
    try {
        // Load the exact old SQL and its journal into an isolated in-memory database.
        await pg.exec('CREATE SCHEMA canvas_migrations; CREATE TABLE canvas_migrations.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)');
        for (const migration of migrations.slice(0, last)) {
            for (const statement of migration.sql) await pg.exec(statement);
            await pg.query('INSERT INTO canvas_migrations.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [migration.hash, migration.folderMillis]);
        }
        const db = drizzle(pg);
        const ownerId = "history-migration-owner", taskId = crypto.randomUUID();
        await pg.query('INSERT INTO canvas_saas."user" (id, name, email) VALUES ($1, $2, $3)', [ownerId, "Synthetic account", "history-migration@example.test"]);
        await pg.query(`INSERT INTO canvas_saas.generation_task
            (id, owner_id, input_snapshot, model_id, parameter_snapshot, idempotency_key, request_id)
            VALUES ($1, $2, '{}', 'original-model', '{}', 'synthetic-migration-key', 'synthetic-migration-request')`, [taskId, ownerId]);
        const prior = await pg.query("SELECT * FROM canvas_saas.generation_task");
        await migrate(db, options);
        await expectCurrentMigrations(pg);
        expect((await pg.query("SELECT * FROM canvas_saas.generation_task")).rows).toEqual(prior.rows);
        const input = { ownerId, pageNumber: 1, pageSize: 50 };
        expect((await getGenerationHistoryForOwner(db, input)).items[0]).not.toHaveProperty("title");
        await db.transaction(tx => renameGenerationHistoryForOwner(tx, ownerId, taskId, "Saved cover"));
        await migrate(db, options);
        await expectCurrentMigrations(pg);
        expect(await getGenerationHistoryForOwner(db, { ...input, search: "cover" })).toMatchObject({ total: 1, items: [{ taskId, title: "Saved cover", displayModel: "original-model" }] });
        expect((await pg.query("SELECT * FROM canvas_saas.generation_task")).rows).toEqual(prior.rows);
    } finally { await pg.close(); }
}, 30_000);
