import { describe, expect, test } from "bun:test";
import { checkAccountDatabaseReadiness, requiredAccountRelations } from "../src/readiness";
import { PGlite } from "@electric-sql/pglite";

async function catalogDeletionColumns(client: PGlite) {
    for (const name of ["model_provider", "model_catalog"]) await client.exec(`ALTER TABLE canvas_saas.${name} ADD COLUMN enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN deleted_at timestamptz, ADD CONSTRAINT ${name}_deleted_disabled CHECK (deleted_at IS NULL OR NOT enabled)`);
    const priceDraft = await Bun.file(new URL("../../../packages/database/migrations/0016_model_price_drafts.sql", import.meta.url)).text();
    const immutable = priceDraft.split("--> statement-breakpoint").find(sql => sql.includes('CREATE FUNCTION "canvas_saas"."reject_model_price_draft_mutation"'));
    if (!immutable) throw new Error("Formal append-only function missing");
    await client.exec(immutable);
    const nodeGroups = await Bun.file(new URL("../../../packages/database/migrations/0023_node_model_groups.sql", import.meta.url)).text();
    await client.exec(nodeGroups.split("--> statement-breakpoint").slice(0, 2).join("\n"));
    for (const name of ["0034_model_mapping_draft", "0035_model_mapping_publication", "0040_audio_model_groups"]) {
        await client.exec(await Bun.file(new URL(`../../../packages/database/migrations/${name}.sql`, import.meta.url)).text());
    }
}

describe("account database readiness", () => {
    test("requires every core account relation and optional media relations when enabled", async () => {
        const core = requiredAccountRelations(false);
        const media = requiredAccountRelations(true);
        expect(core).toContain("model_provider_credential");
        expect(core).toContain("provider_discovery_receipt");
        expect(core).toContain("provider_discovered_model");
        expect(core).toContain("model_node_groups");
        expect(core).toContain("model_mapping_draft");
        expect(core).toContain("model_mapping_publication");
        expect(core).not.toContain("media_object");
        expect(media).toContain("media_object");
        expect(media).toContain("storage_quota");
    });

    test("checks the actual email constraint, rejecting absent, wrong and partial indexes", async () => {
        const client = new PGlite();
        const database = { query: (text: string, values?: readonly unknown[]) => client.query<{ relation: string }>(text, values ? [...values] : undefined) };
        try {
            await client.exec('CREATE SCHEMA canvas_saas');
            for (const name of requiredAccountRelations(true).filter(name => !name.startsWith("model_mapping_") && name !== "model_node_groups")) await client.exec(`CREATE TABLE canvas_saas."${name}" (email text)`);
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
            await client.exec('CREATE UNIQUE INDEX user_email_lower_unique ON canvas_saas."user" (email)');
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
            await client.exec('DROP INDEX canvas_saas.user_email_lower_unique; CREATE UNIQUE INDEX user_email_lower_unique ON canvas_saas."user" (lower(btrim(email))) WHERE email IS NOT NULL');
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
            await client.exec('DROP INDEX canvas_saas.user_email_lower_unique; CREATE INDEX user_email_lower_unique ON canvas_saas."user" (lower(btrim(email)))');
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
            await client.exec('DROP INDEX canvas_saas.user_email_lower_unique; CREATE UNIQUE INDEX user_email_lower_unique ON canvas_saas."user" (lower(btrim(email)))');
            // All old core tables and the correct email index cannot conceal a pre-Q1 auth schema.
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
            await client.exec('ALTER TABLE canvas_saas."user" ADD COLUMN moderation_version integer NOT NULL DEFAULT 0 CONSTRAINT user_moderation_version CHECK (moderation_version >= 0)');
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
            await client.exec('ALTER TABLE canvas_saas.session ADD COLUMN moderation_version integer NOT NULL DEFAULT 0 CONSTRAINT session_moderation_version CHECK (moderation_version >= 0)');
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
            await catalogDeletionColumns(client);
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(true);
            expect(await checkAccountDatabaseReadiness(database, true)).toBe(true);
            await client.exec("BEGIN READ ONLY");
            try { expect(await checkAccountDatabaseReadiness(database, true)).toBe(false); }
            finally { await client.exec("ROLLBACK"); }
            expect(await checkAccountDatabaseReadiness(database, true)).toBe(true);
            await client.exec('DROP TABLE canvas_saas.storage_quota');
            expect(await checkAccountDatabaseReadiness(database, true)).toBe(false);
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(true);
        } finally {
            await client.close();
        }
    }, 30_000);

    test("fails closed when a required relation is missing or the database query fails", async () => {
        const required = requiredAccountRelations(false);
        const missing = required.slice(0, -1);
        const incomplete = { query: async () => ({ rows: missing.map((name) => ({ relation: `canvas_saas.${name}` })) }) };
        expect(await checkAccountDatabaseReadiness(incomplete, false)).toBe(false);
        const broken = { query: async () => { throw new Error("private database details"); } };
        expect(await checkAccountDatabaseReadiness(broken, false)).toBe(false);
    });

    test("auth version shape and validated nonnegative guards are mandatory even with every safety flag off", async () => {
        const client = new PGlite();
        const database = { query: (text: string, values?: readonly unknown[]) => client.query<{ relation: string }>(text, values ? [...values] : undefined) };
        try {
            await client.exec('CREATE SCHEMA canvas_saas');
            for (const name of requiredAccountRelations(false).filter(name => !name.startsWith("model_mapping_") && name !== "model_node_groups")) await client.exec(`CREATE TABLE canvas_saas."${name}" (email text)`);
            await client.exec('CREATE UNIQUE INDEX user_email_lower_unique ON canvas_saas."user" (lower(btrim(email)))');
            for (const name of ["user", "session"]) await client.exec(`ALTER TABLE canvas_saas."${name}" ADD COLUMN moderation_version integer NOT NULL DEFAULT 0 CONSTRAINT ${name}_moderation_version CHECK (moderation_version >= 0)`);
            await catalogDeletionColumns(client);
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(true);
            for (const change of [
                'ALTER COLUMN moderation_version DROP NOT NULL',
                'ALTER COLUMN moderation_version SET DEFAULT 1',
                'ALTER COLUMN moderation_version TYPE bigint',
                'DROP CONSTRAINT user_moderation_version, ADD CONSTRAINT user_moderation_version CHECK (moderation_version >= -1)',
                'DROP CONSTRAINT user_moderation_version, ADD CONSTRAINT user_moderation_version CHECK (moderation_version >= 0) NOT VALID',
            ]) {
                await client.exec('BEGIN');
                try {
                    await client.exec(`ALTER TABLE canvas_saas."user" ${change}`);
                    expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
                } finally { await client.exec('ROLLBACK'); }
            }
            const enabled = { moderationEnabled: true, reportsEnabled: true, checkpointMode: "record" as const };
            expect(await checkAccountDatabaseReadiness(database, false, enabled)).toBe(false);
            expect(await checkAccountDatabaseReadiness(database, false)).toBe(true);
            for (const name of ["model_provider", "model_catalog"]) {
                await client.exec("BEGIN");
                try {
                    await client.exec(`ALTER TABLE canvas_saas.${name} DROP CONSTRAINT ${name}_deleted_disabled`);
                    expect(await checkAccountDatabaseReadiness(database, false)).toBe(false);
                } finally { await client.exec("ROLLBACK"); }
            }
        } finally { await client.close(); }
    }, 30_000);
});
