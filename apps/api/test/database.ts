import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@infinite-canvas/database/schema";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";

/** Only the isolated runner may opt into a real database; never reads DATABASE_URL. */
export function postgresTestUrl() {
    const value = process.env.SAAS_TEST_DATABASE_URL;
    if (!value) return null;
    const url = new URL(value);
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username !== "canvas_test_app" || url.pathname !== "/canvas_saas_test" || url.search || url.hash) {
        throw new Error("拒绝非隔离本机测试数据库；请使用 bun run test:postgres");
    }
    return value;
}

/** Default is in-memory PGlite; real mode uses the runner's fresh local cluster. */
export async function createTestDatabase() {
    const connectionString = postgresTestUrl();
    if (connectionString) {
        const database = createDatabase(connectionString);
        try {
            await migrateDatabase(database.db);
            return database;
        } catch (error) {
            await database.close();
            throw error;
        }
    }
    const client = new PGlite();
    const db = drizzle(client, { schema });
    const migrationsFolder = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
    try {
        await migrate(db, { migrationsFolder, migrationsSchema: "canvas_migrations" });
        return { db, pool: { query: ({ text, values }: { text: string; values?: unknown[] }) => client.query(text, values) }, close: () => client.close() };
    } catch (error) {
        await client.close();
        throw error;
    }
}
