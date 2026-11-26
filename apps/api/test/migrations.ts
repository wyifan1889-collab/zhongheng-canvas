import { expect } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

/** Compare the full applied chain with the current formal files, not a stale count. */
export async function expectCurrentMigrations(database: { query: (text: string) => Promise<{ rows: unknown[] }> }) {
    const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)) });
    expect(migrations.length).toBeGreaterThan(0);
    const applied = await database.query("SELECT hash, created_at::text AS created_at FROM canvas_migrations.__drizzle_migrations ORDER BY created_at, id");
    expect(applied.rows).toEqual(migrations.map(row => ({ hash: row.hash, created_at: String(row.folderMillis) })));
}
