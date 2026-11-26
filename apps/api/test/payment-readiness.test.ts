import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { checkPaymentDatabaseReadiness, checkVideoDatabaseReadiness } from "../src/readiness";
import { expectCurrentMigrations } from "./migrations";

// This suite is always an independent, in-memory database, including under native test runners.
const external = Object.keys(process.env).filter(name => /(?:^|_)DATABASE_URL$|^PG|^SAAS_POSTGRES_|^SAAS_TEST_|^SAAS_PAYMENTS_/i.test(name));
if (external.length) throw new Error(`readiness_external_database_environment_rejected_${external.sort().join("_")}`);

describe("payment and video opt-in database readiness", () => {
    const client = new PGlite();
    const queryErrors: string[] = [];
    let missing: string[] = [];
    const database = { query: async (text: string, values?: readonly unknown[]) => {
        try {
            const result = await client.query<{ relation: string }>(text, values ? [...values] : undefined);
            const found = new Set(result.rows.map(row => row.relation));
            const objects = values?.map(value => JSON.parse(value as string)) ?? [];
            missing = ["database.writable",
                ...(objects[0] ?? []).map((item: { table: string; name: string }) => `column.${item.table}.${item.name}`),
                ...(objects[1] ?? []).map((item: { table: string; name: string }) => `check.${item.table}.${item.name}`),
                ...(objects[2] ?? []).map((item: { name: string }) => `index.${item.name}`),
                ...(objects[3] ?? []).map((item: { name: string }) => `function.${item.name}`),
                ...(objects[4] ?? []).map((item: { name: string }) => `trigger.${item.name}`),
                ...(objects[5] ?? []).map((item: { name: string }) => `foreign.${item.name}`),
            ].filter(name => !found.has(name));
            return result;
        } catch (error) { queryErrors.push(String(error)); throw error; }
    } };
    const paymentReady = () => checkPaymentDatabaseReadiness(database);
    const videoReady = () => checkVideoDatabaseReadiness(database);
    const rejectsChange = async (gate: () => Promise<boolean>, ddl: string) => {
        await client.exec("BEGIN");
        try {
            await client.exec(ddl);
            expect(await gate(), ddl).toBe(false);
        } finally { await client.exec("ROLLBACK"); }
        expect(queryErrors).toEqual([]);
        expect(await gate(), `rollback restores ${ddl}`).toBe(true);
    };

    beforeAll(async () => {
        await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), migrationsSchema: "canvas_migrations" });
    }, 30_000);
    afterAll(async () => { await client.close(); });

    test("accepts the formal migration catalog and fails closed on unavailable or read-only databases", async () => {
        await expectCurrentMigrations(client);
        const payment = await paymentReady();
        expect(queryErrors).toEqual([]);
        expect(missing).toEqual([]);
        expect(payment).toBe(true);
        const video = await videoReady();
        expect(queryErrors).toEqual([]);
        expect(missing).toEqual([]);
        expect(video).toBe(true);
        await client.exec("BEGIN READ ONLY");
        try {
            expect(await paymentReady()).toBe(false);
            expect(await videoReady()).toBe(false);
        } finally { await client.exec("ROLLBACK"); }
        const broken = { query: async () => { throw new Error("private connection details"); } };
        expect(await checkPaymentDatabaseReadiness(broken)).toBe(false);
        expect(await checkVideoDatabaseReadiness(broken)).toBe(false);
    });

    test("payment rejects old or weakened cash, credit, encryption and validated-state shapes", async () => {
        for (const ddl of [
            "ALTER TABLE canvas_saas.payment_merchant_version DROP COLUMN ciphertext CASCADE",
            "ALTER TABLE canvas_saas.payment_order ALTER COLUMN credit_units TYPE numeric(12,2)",
            "ALTER TABLE canvas_saas.payment_order ALTER COLUMN owner_id DROP NOT NULL",
            "ALTER TABLE canvas_saas.payment_settings ALTER COLUMN new_orders_enabled SET DEFAULT true",
            "ALTER TABLE canvas_saas.payment_order DROP CONSTRAINT payment_order_attempt_pair",
            "ALTER TABLE canvas_saas.payment_order DROP CONSTRAINT payment_order_credit_state; ALTER TABLE canvas_saas.payment_order ADD CONSTRAINT payment_order_credit_state CHECK (true)",
            "ALTER TABLE canvas_saas.payment_offer_version DROP CONSTRAINT payment_offer_credits; ALTER TABLE canvas_saas.payment_offer_version ADD CONSTRAINT payment_offer_credits CHECK (credit_units > 0) NOT VALID",
            "ALTER TABLE canvas_saas.payment_event DROP CONSTRAINT payment_event_notice_cipher",
            "ALTER TABLE canvas_saas.payment_order DROP CONSTRAINT payment_order_owner_id_user_id_fk",
        ]) await rejectsChange(paymentReady, ddl);
    });

    test("payment uniqueness keeps the merchant domain and exact notification and recharge predicates", async () => {
        for (const ddl of [
            "DROP INDEX canvas_saas.payment_order_merchant_transaction; CREATE UNIQUE INDEX payment_order_merchant_transaction ON canvas_saas.payment_order (owner_id,provider,merchant_id,provider_trade_no)",
            "DROP INDEX canvas_saas.payment_order_merchant_transaction; CREATE UNIQUE INDEX payment_order_merchant_transaction ON canvas_saas.payment_order (provider,merchant_version_id,provider_trade_no)",
            "DROP INDEX canvas_saas.payment_order_merchant_number; CREATE UNIQUE INDEX payment_order_merchant_number ON canvas_saas.payment_order (merchant_id,merchant_order_id)",
            "DROP INDEX canvas_saas.payment_event_identity; CREATE UNIQUE INDEX payment_event_identity ON canvas_saas.payment_event (event_identity) WHERE outcome='verified_success'",
            "DROP INDEX canvas_saas.wallet_ledger_payment_order_unique; CREATE UNIQUE INDEX wallet_ledger_payment_order_unique ON canvas_saas.wallet_ledger (user_id,reference_id) WHERE kind='recharge' AND reference_type='payment_order'",
            "DROP INDEX canvas_saas.wallet_ledger_payment_order_unique; CREATE UNIQUE INDEX wallet_ledger_payment_order_unique ON canvas_saas.wallet_ledger (reference_id) WHERE kind='recharge'",
        ]) await rejectsChange(paymentReady, ddl);
    });

    test("payment requires enabled append-only and original-order guards with deferred dual evidence", async () => {
        for (const [table, trigger] of [
            ["payment_merchant_version", "payment_merchant_version_immutable"], ["payment_offer_version", "payment_offer_version_immutable"],
            ["payment_event", "payment_event_immutable"], ["payment_order", "payment_order_protected"],
            ["wallet_ledger", "wallet_ledger_append_only"], ["payment_order", "payment_order_credit_consistent"],
            ["wallet_ledger", "wallet_ledger_payment_consistent"],
        ]) await rejectsChange(paymentReady, `ALTER TABLE canvas_saas.${table} DISABLE TRIGGER ${trigger}`);
        for (const ddl of [
            "DROP TRIGGER payment_order_credit_consistent ON canvas_saas.payment_order; CREATE CONSTRAINT TRIGGER payment_order_credit_consistent AFTER INSERT OR UPDATE ON canvas_saas.payment_order DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION canvas_saas.check_payment_credit_final()",
            "DROP TRIGGER wallet_ledger_payment_consistent ON canvas_saas.wallet_ledger; CREATE TRIGGER wallet_ledger_payment_consistent AFTER INSERT ON canvas_saas.wallet_ledger FOR EACH ROW EXECUTE FUNCTION canvas_saas.check_payment_credit_final()",
            "CREATE OR REPLACE FUNCTION canvas_saas.payment_credit_evidence_matches(target uuid,notice_id uuid,query_id uuid) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'",
            "ALTER FUNCTION canvas_saas.payment_credit_evidence_matches(uuid,uuid,uuid) SECURITY DEFINER",
            "CREATE OR REPLACE FUNCTION canvas_saas.check_payment_credit_final() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'",
            "CREATE OR REPLACE FUNCTION canvas_saas.protect_payment_order() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
        ]) await rejectsChange(paymentReady, ddl);
    });

    test("video requires durable quote, stage ownership, paired create and lease fields", async () => {
        for (const ddl of [
            "ALTER TABLE canvas_saas.generation_task DROP COLUMN video_quote_snapshot CASCADE",
            "ALTER TABLE canvas_saas.generation_video_stage ALTER COLUMN revision TYPE bigint",
            "ALTER TABLE canvas_saas.generation_video_stage ALTER COLUMN owner_id DROP NOT NULL",
            "ALTER TABLE canvas_saas.generation_video_stage DROP CONSTRAINT generation_video_stage_phase",
            "ALTER TABLE canvas_saas.generation_video_stage DROP CONSTRAINT generation_video_stage_claim_pair",
            "ALTER TABLE canvas_saas.generation_video_stage DROP CONSTRAINT generation_video_stage_create_pair",
            "ALTER TABLE canvas_saas.generation_task DROP CONSTRAINT generation_task_video_quote; ALTER TABLE canvas_saas.generation_task ADD CONSTRAINT generation_task_video_quote CHECK (true)",
            "ALTER TABLE canvas_saas.generation_video_stage DROP CONSTRAINT generation_video_stage_counters; ALTER TABLE canvas_saas.generation_video_stage ADD CONSTRAINT generation_video_stage_counters CHECK (revision >= 0) NOT VALID",
        ]) await rejectsChange(videoReady, ddl);
    });

    test("video requires original source helpers and every deferred task, stage and result mirror", async () => {
        for (const [table, trigger] of [
            ["model_price_publication", "model_price_publication_source"], ["generation_task", "generation_task_price_publication_insert"],
            ["generation_task", "generation_task_price_source_immutable"], ["generation_video_stage", "generation_video_stage_immutable"],
            ["generation_task", "generation_task_video_stage_final"], ["generation_video_stage", "generation_video_stage_task_final"],
            ["generation_result", "generation_video_result_final"],
        ]) await rejectsChange(videoReady, `ALTER TABLE canvas_saas.${table} DISABLE TRIGGER ${trigger}`);
        for (const ddl of [
            "DROP TRIGGER generation_video_result_final ON canvas_saas.generation_result; CREATE CONSTRAINT TRIGGER generation_video_result_final AFTER INSERT OR UPDATE OR DELETE ON canvas_saas.generation_result DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION canvas_saas.check_generation_video_stage_final()",
            "CREATE OR REPLACE FUNCTION canvas_saas.video_spec_task_credits(rules jsonb, task_parameters jsonb, binding jsonb) RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS 'BEGIN RETURN 1; END'",
            "ALTER FUNCTION canvas_saas.video_spec_task_credits(jsonb,jsonb,jsonb) SECURITY DEFINER",
            "ALTER FUNCTION canvas_saas.video_spec_task_credits(jsonb,jsonb,jsonb) VOLATILE",
            "CREATE OR REPLACE FUNCTION canvas_saas.bind_generation_task_price_publication() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
            "CREATE OR REPLACE FUNCTION canvas_saas.protect_generation_video_stage() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
            "CREATE OR REPLACE FUNCTION canvas_saas.check_generation_video_stage_final() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'",
        ]) await rejectsChange(videoReady, ddl);
    });
});
