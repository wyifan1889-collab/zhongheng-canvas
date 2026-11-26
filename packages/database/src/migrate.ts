import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { createDatabase } from "./client";

/** Explicit operation; never called by API startup. Applied migrations must not be edited. */
export function migrateDatabase(db: ReturnType<typeof createDatabase>["db"]) {
    return migrate(db, {
        migrationsFolder: fileURLToPath(new URL("../migrations/", import.meta.url)),
        migrationsSchema: "canvas_migrations",
    });
}
