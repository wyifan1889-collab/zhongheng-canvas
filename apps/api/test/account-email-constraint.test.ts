import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { user } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";
import { checkAccountDatabaseReadiness } from "../src/readiness";

let database: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => { database = await createTestDatabase(); }, 30_000);
afterAll(async () => { if (database) await database.close(); });

describe("account email database invariant", () => {
    test("the complete migration set satisfies account readiness", async () => {
        const probe = { query: async (text: string, values?: readonly unknown[]) => {
            const result = await database.pool.query({ text, values: values ? [...values] : undefined });
            return result as { rows: Array<{ relation?: unknown }> };
        } };
        expect(await checkAccountDatabaseReadiness(probe, false)).toBe(true);
        expect(await checkAccountDatabaseReadiness(probe, true)).toBe(true);
    });

    test("rejects a case or whitespace variant even when bypassing the HTTP guard", async () => {
        const canonical = `email-constraint-${crypto.randomUUID()}@example.test`;
        await database.db.insert(user).values({
            id: crypto.randomUUID(), name: "First", email: canonical.toUpperCase(),
        });

        await expect((async () => {
            await database.db.insert(user).values({
                id: crypto.randomUUID(), name: "Duplicate", email: `  ${canonical}  `,
            });
        })()).rejects.toThrow();

        const rows = await database.db.select({ email: user.email }).from(user)
            .where(eq(user.email, canonical.toUpperCase()));
        expect(rows).toHaveLength(1);
    });
});
