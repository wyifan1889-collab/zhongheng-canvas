import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app";
import { checkAccountDatabaseReadiness } from "../src/readiness";
import { expectCurrentMigrations } from "./migrations";

const client = new PGlite();
const database = { query: (text: string, values?: readonly unknown[]) => client.query<{ relation: string }>(text, values ? [...values] : undefined) };
const ready = () => checkAccountDatabaseReadiness(database, false);
const app = createApp(undefined, undefined, false, false, ready);
beforeAll(async () => {
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: "canvas_migrations" });
    expect(await ready()).toBe(true);
}, 30_000);
afterAll(() => client.close());

async function rejectsChange(sql: string, http = false) {
    await client.exec("BEGIN");
    try {
        await client.exec(sql);
        expect(await ready(), sql).toBe(false);
        if (http) {
            const response = await app(new Request("http://localhost/readyz"));
            expect(response.status).toBe(503);
            expect(await response.json()).toEqual({ status: "not_ready", service: "infinite-canvas-api", checks: {} });
        }
    } finally { await client.exec("ROLLBACK"); }
    expect(await ready(), `rollback restores ${sql}`).toBe(true);
}

test("readyz rejects either missing mapping migration and the absent catalog row with generation disabled", async () => {
    for (const table of ["model_mapping_draft", "model_mapping_publication"]) await rejectsChange(`DROP TABLE canvas_saas.${table}`, true);
    await rejectsChange("DELETE FROM canvas_saas.model_mapping_draft WHERE id='catalog'", true);
    const response = await app(new Request("http://localhost/readyz"));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ready");
});

test("CATALOG-03 readyz rejects missing audio groups and a weakened capability constraint", async () => {
    await rejectsChange("DELETE FROM canvas_saas.model_node_groups WHERE capability='audio'", true);
    await rejectsChange("ALTER TABLE canvas_saas.model_node_groups DROP CONSTRAINT model_node_groups_capability, ADD CONSTRAINT model_node_groups_capability CHECK (true)", true);
});

test("mapping drafts and publications require the formal fields, validated guards and unique versions", async () => {
    for (const sql of [
        "ALTER TABLE canvas_saas.model_mapping_draft ALTER COLUMN version TYPE bigint",
        "ALTER TABLE canvas_saas.model_mapping_draft ALTER COLUMN document DROP NOT NULL",
        "ALTER TABLE canvas_saas.model_mapping_publication DROP COLUMN fingerprint CASCADE",
        "ALTER TABLE canvas_saas.model_mapping_publication ALTER COLUMN created_at DROP DEFAULT",
        "ALTER TABLE canvas_saas.model_mapping_draft DROP CONSTRAINT model_mapping_draft_pkey",
        "ALTER TABLE canvas_saas.model_mapping_publication DROP CONSTRAINT model_mapping_publication_pkey",
        "DROP INDEX canvas_saas.model_mapping_publication_version; CREATE INDEX model_mapping_publication_version ON canvas_saas.model_mapping_publication(version)",
        "DROP INDEX canvas_saas.model_mapping_publication_version; CREATE UNIQUE INDEX model_mapping_publication_version ON canvas_saas.model_mapping_publication(draft_version)",
        "DROP INDEX canvas_saas.model_mapping_publication_version; CREATE UNIQUE INDEX model_mapping_publication_version ON canvas_saas.model_mapping_publication(version) WHERE version > 1",
        "ALTER TABLE canvas_saas.model_mapping_draft DROP CONSTRAINT model_mapping_draft_id",
        "ALTER TABLE canvas_saas.model_mapping_draft DROP CONSTRAINT model_mapping_draft_version; ALTER TABLE canvas_saas.model_mapping_draft ADD CONSTRAINT model_mapping_draft_version CHECK (version >= -1)",
        "ALTER TABLE canvas_saas.model_mapping_draft DROP CONSTRAINT model_mapping_draft_object",
        "ALTER TABLE canvas_saas.model_mapping_publication DROP CONSTRAINT model_mapping_publication_positive_version",
        "ALTER TABLE canvas_saas.model_mapping_publication DROP CONSTRAINT model_mapping_publication_fingerprint; ALTER TABLE canvas_saas.model_mapping_publication ADD CONSTRAINT model_mapping_publication_fingerprint CHECK (true)",
        "ALTER TABLE canvas_saas.model_mapping_publication DROP CONSTRAINT model_mapping_publication_document; ALTER TABLE canvas_saas.model_mapping_publication ADD CONSTRAINT model_mapping_publication_document CHECK (jsonb_typeof(document) = 'object') NOT VALID",
    ]) await rejectsChange(sql);
});

test("publication history cannot be considered ready with a missing or weakened append-only trigger", async () => {
    for (const sql of [
        "ALTER TABLE canvas_saas.model_mapping_publication DISABLE TRIGGER model_mapping_publication_append_only",
        "DROP TRIGGER model_mapping_publication_append_only ON canvas_saas.model_mapping_publication",
        "DROP TRIGGER model_mapping_publication_append_only ON canvas_saas.model_mapping_publication; CREATE TRIGGER model_mapping_publication_append_only BEFORE UPDATE ON canvas_saas.model_mapping_publication FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_model_price_draft_mutation()",
        "CREATE OR REPLACE FUNCTION canvas_saas.reject_model_price_draft_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN OLD; END'",
        "ALTER FUNCTION canvas_saas.reject_model_price_draft_mutation() SECURITY DEFINER",
    ]) await rejectsChange(sql);
});

test("mapping checks fail closed on unavailable queries and read-only transactions", async () => {
    await client.exec("BEGIN READ ONLY");
    try { expect(await ready()).toBe(false); }
    finally { await client.exec("ROLLBACK"); }
    let calls = 0;
    const brokenMappingQuery = { query: async (text: string, values?: readonly unknown[]) => {
        if (++calls > 1) throw new Error("private database detail");
        return database.query(text, values);
    } };
    expect(await checkAccountDatabaseReadiness(brokenMappingQuery, false)).toBe(false);
    expect(await ready()).toBe(true);
});

test("CATALOG-03 the actual migration chain upgrades existing groups before becoming ready", async () => {
    const fresh = new PGlite();
    const target = { query: (text: string, values?: readonly unknown[]) => fresh.query<{ relation: string }>(text, values ? [...values] : undefined) };
    const journal = await Bun.file(new URL("../../../packages/database/migrations/meta/_journal.json", import.meta.url)).json();
    try {
        let existing: unknown[] | null = null;
        for (const entry of journal.entries) {
            await fresh.exec(await Bun.file(new URL(`../../../packages/database/migrations/${entry.tag}.sql`, import.meta.url)).text());
            if (["0033_catalog_deletion", "0034_model_mapping_draft", "0035_model_mapping_publication", "0039_image_response_format"].includes(entry.tag)) expect(await checkAccountDatabaseReadiness(target, false)).toBe(false);
            if (entry.tag === "0039_image_response_format") {
                const group = { id: crypto.randomUUID(), name: "既有图片分组" };
                await fresh.query("UPDATE canvas_saas.model_node_groups SET groups=$1::jsonb,version=5 WHERE capability='image'", [JSON.stringify([group])]);
                existing = (await fresh.query("SELECT * FROM canvas_saas.model_node_groups ORDER BY capability")).rows;
            }
        }
        expect(existing).not.toBeNull();
        expect((await fresh.query("SELECT * FROM canvas_saas.model_node_groups WHERE capability<>'audio' ORDER BY capability")).rows).toEqual(existing);
        expect((await fresh.query("SELECT capability,version,groups FROM canvas_saas.model_node_groups WHERE capability='audio'")).rows).toEqual([{ capability: "audio", version: 0, groups: [] }]);
        expect(await checkAccountDatabaseReadiness(target, false)).toBe(true);
    } finally { await fresh.close(); }
}, 30_000);

test("migration evidence matches every formal hash and timestamp and detects same-count corruption", async () => {
    await expectCurrentMigrations(client);
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: "canvas_migrations" });
    await expectCurrentMigrations(client);
    for (const change of ["hash=repeat('0',64)", "created_at=created_at+1"]) {
        await client.exec("BEGIN");
        try {
            await client.exec(`UPDATE canvas_migrations.__drizzle_migrations SET ${change} WHERE id=(SELECT min(id) FROM canvas_migrations.__drizzle_migrations)`);
            await expect(expectCurrentMigrations(client)).rejects.toThrow();
        } finally { await client.exec("ROLLBACK"); }
    }
    await expectCurrentMigrations(client);
});
