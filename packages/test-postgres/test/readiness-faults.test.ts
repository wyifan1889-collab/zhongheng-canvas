import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { postgresTestUrl } from "../../../apps/api/test/database";
import { checkAccountDatabaseReadiness } from "../../../apps/api/src/readiness";

const url = postgresTestUrl();
if (!url) throw new Error("请通过 bun run test:postgres 运行故障验收");
const client = new Client({ connectionString: url });
beforeAll(() => client.connect());
afterAll(() => client.end());

test("a missing normalized email index fails readiness and rollback restores it", async () => {
    expect(await checkAccountDatabaseReadiness(client, true)).toBe(true);
    await client.query("BEGIN");
    try {
        await client.query("DROP INDEX canvas_saas.user_email_lower_unique");
        expect(await checkAccountDatabaseReadiness(client, true)).toBe(false);
    } finally { await client.query("ROLLBACK"); }
    expect(await checkAccountDatabaseReadiness(client, true)).toBe(true);
});

test("a read-only transaction is not a writable account service", async () => {
    await client.query("BEGIN READ ONLY");
    try {
        expect((await client.query("SELECT 1 AS readable")).rows).toEqual([{ readable: 1 }]);
        expect(await checkAccountDatabaseReadiness(client, true)).toBe(false);
        await expect(client.query('UPDATE canvas_saas."user" SET name = name WHERE false')).rejects.toMatchObject({ code: "25006" });
    } finally { await client.query("ROLLBACK"); }
    expect(await checkAccountDatabaseReadiness(client, true)).toBe(true);
});
