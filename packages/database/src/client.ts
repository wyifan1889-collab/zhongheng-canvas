import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Does not migrate, seed or connect until queried. Call close when finished. */
export function createDatabase(connectionString: string) {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
        throw new Error("必须提供独立画布 PostgreSQL 数据库地址");
    }
    const pool = new Pool({ connectionString });
    return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}
