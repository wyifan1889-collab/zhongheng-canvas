import { SQL, is, sql } from "drizzle-orm";
import { fromDrizzle } from "@infinite-canvas/jobs";
import type { Database } from "@infinite-canvas/database";

/** Preserve the original transaction; normalize only its driver's result envelope. */
export function videoQueueTransaction(database: Database) {
    return fromDrizzle({ async execute(query: unknown) {
        if (!is(query, SQL)) throw new Error("Video queue requires a parameterized Drizzle query");
        const result: unknown = await database.execute(query);
        if (Array.isArray(result)) return result;
        if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return { rows: result.rows };
        throw new Error("Video queue transaction result is invalid");
    } }, sql);
}
