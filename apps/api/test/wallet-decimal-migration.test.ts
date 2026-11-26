import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("This suite requires isolated in-memory PGlite");

test("0019 retains every historical integer amount and identity without JS-number conversion", async () => {
    const client = new PGlite();
    try {
        const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)) });
        const target = migrations.findIndex((entry) => entry.sql.some((statement) => statement.includes('ADD CONSTRAINT "wallet_amounts_finite"')));
        expect(target).toBe(19);
        for (const migration of migrations.slice(0, target)) for (const statement of migration.sql) await client.exec(statement);
        await client.exec(`INSERT INTO canvas_saas."user" (id,name,email) VALUES ('legacy-owner','Synthetic legacy owner','legacy@example.test');
            INSERT INTO canvas_saas.wallet (user_id,available_units,reserved_units,version) VALUES ('legacy-owner',9007199254740993,2,4);
            INSERT INTO canvas_saas.wallet_reservation (id,user_id,requested_units,captured_units,released_units,idempotency_key,task_id)
                VALUES ('legacy-reservation','legacy-owner',4,1,1,'legacy-reservation','legacy-task');
            INSERT INTO canvas_saas.wallet_ledger (id,user_id,kind,delta_available_units,delta_reserved_units,available_units_after,reserved_units_after,idempotency_key,reference_type,reference_id)
                VALUES ('legacy-ledger','legacy-owner','reserve',-4,4,9007199254740993,4,'legacy-ledger','generation','legacy-reservation');`);
        const queries = [
            "SELECT user_id,unit,available_units::text,reserved_units::text,version,created_at::text,updated_at::text FROM canvas_saas.wallet",
            "SELECT id,user_id,kind,delta_available_units::text,delta_reserved_units::text,available_units_after::text,reserved_units_after::text,idempotency_key,reference_type,reference_id,actor_id,metadata,created_at::text FROM canvas_saas.wallet_ledger",
            "SELECT id,user_id,requested_units::text,captured_units::text,released_units::text,status,idempotency_key,provider_request_id,task_id,expires_at::text,created_at::text,updated_at::text FROM canvas_saas.wallet_reservation",
        ];
        const before = await Promise.all(queries.map(async (query) => (await client.query(query)).rows));
        for (const statement of migrations[target]!.sql) await client.exec(statement);
        expect(await Promise.all(queries.map(async (query) => (await client.query(query)).rows))).toEqual(before);
        const fields = await client.query<{ table_name: string; column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null }>(
            "SELECT table_name,column_name,data_type,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='canvas_saas' AND table_name IN ('wallet','wallet_ledger','wallet_reservation') AND column_name IN ('available_units','reserved_units','delta_available_units','delta_reserved_units','available_units_after','reserved_units_after','requested_units','captured_units','released_units')");
        expect(fields.rows).toHaveLength(9);
        for (const field of fields.rows) expect(field).toMatchObject({ data_type: "numeric", numeric_precision: null, numeric_scale: null });
        const repository = createWalletRepository(drizzle(client, { schema }));
        expect(await repository.get("legacy-owner")).toMatchObject({ availableUnits: "9007199254740993", reservedUnits: "2", totalUnits: "9007199254740995", version: 4 });
        expect(await repository.getReservation("legacy-owner", "legacy-reservation")).toMatchObject({ requestedUnits: "4", capturedUnits: "1", releasedUnits: "1" });
        await expect(client.exec("UPDATE canvas_saas.wallet_ledger SET reference_id='changed'")).rejects.toThrow();
        await expect(client.exec("DELETE FROM canvas_saas.wallet_ledger")).rejects.toThrow();
    } finally { await client.close(); }
});
