import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { checkGenerationRateDatabaseReadiness, type RelationQuery } from "../src/readiness";
import { postgresTestUrl } from "./database";
import { expectCurrentMigrations } from "./migrations";

const enabled = process.env.Q1_D04_POSTGRES === "1", native = enabled ? test : test.skip;
const url = enabled ? postgresTestUrl() : null;
if (enabled && (!url || process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL)) throw new Error("D04 catalog tests require the runner's new isolated PG16 cluster");
let database: ReturnType<typeof createDatabase> | undefined;
const acquireClient = () => database!.pool.connect();
let client: Awaited<ReturnType<typeof acquireClient>> | undefined;
// Every damage and catalog query uses this one connection, including its uncommitted DDL.
const target: RelationQuery = { query: (text, values) => client!.query(text, values ? [...values] : undefined) };
const policy = { ip: { enabled: true, points: 10, duration: 3600 }, user: { enabled: true, points: 50, duration: 86400 } };

beforeAll(async () => {
    if (!enabled) return;
    database = createDatabase(url!);
    await migrateDatabase(database.db); // Only the repository's complete formal chain; no fallback DDL.
    client = await database.pool.connect();
    const boundary = (await client.query(`SELECT current_user AS role,current_database() AS database,
        host(inet_server_addr()) AS host,current_setting('server_version_num') AS version,
        NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AS restricted
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
    expect(boundary).toEqual({ role: "canvas_test_app", database: "canvas_saas_test", host: "127.0.0.1", version: "160015", restricted: true });
    await expectCurrentMigrations(client);
    expect((await client.query("SELECT revision,active_version_id FROM canvas_saas.generation_rate_settings WHERE id='generation'")).rows)
        .toEqual([{ revision: 0, active_version_id: null }]);
    expect(await checkGenerationRateDatabaseReadiness(target)).toBe(true);
}, 30_000);
afterAll(async () => {
    if (client) { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    await database?.close();
});

async function damage(statement: string) {
    expect(await checkGenerationRateDatabaseReadiness(target)).toBe(true);
    await client!.query("BEGIN");
    try {
        await client!.query(statement);
        expect(await checkGenerationRateDatabaseReadiness(target)).toBe(false);
    } finally { await client!.query("ROLLBACK"); }
    expect(await checkGenerationRateDatabaseReadiness(target)).toBe(true);
}

const catalogDamages = [
    ["missing policy relation", "DROP TABLE canvas_saas.generation_rate_version CASCADE"],
    ["missing policy column", "ALTER TABLE canvas_saas.generation_rate_version DROP COLUMN policy CASCADE"],
    ["nullable expected revision", "ALTER TABLE canvas_saas.generation_rate_version ALTER COLUMN expected_revision DROP NOT NULL"],
    ["changed revision type", "ALTER TABLE canvas_saas.generation_rate_version ALTER COLUMN expected_revision TYPE bigint"],
    ["missing singleton revision default", "ALTER TABLE canvas_saas.generation_rate_settings ALTER COLUMN revision DROP DEFAULT"],
    ["weakened JSON policy check", "ALTER TABLE canvas_saas.generation_rate_version DROP CONSTRAINT generation_rate_version_policy; ALTER TABLE canvas_saas.generation_rate_version ADD CONSTRAINT generation_rate_version_policy CHECK (true)"],
    ["unvalidated revision check", "ALTER TABLE canvas_saas.generation_rate_version DROP CONSTRAINT generation_rate_version_revision; ALTER TABLE canvas_saas.generation_rate_version ADD CONSTRAINT generation_rate_version_revision CHECK (revision>0) NOT VALID"],
    ["missing singleton identity check", "ALTER TABLE canvas_saas.generation_rate_settings DROP CONSTRAINT generation_rate_settings_id"],
    ["missing singleton pointer check", "ALTER TABLE canvas_saas.generation_rate_settings DROP CONSTRAINT generation_rate_settings_revision"],
    ["missing singleton primary key", "ALTER TABLE canvas_saas.generation_rate_settings DROP CONSTRAINT generation_rate_settings_pkey"],
    ["weakened revision uniqueness", "DROP INDEX canvas_saas.generation_rate_version_revision; CREATE UNIQUE INDEX generation_rate_version_revision ON canvas_saas.generation_rate_version(revision,id)"],
    ["disabled immutable trigger", "ALTER TABLE canvas_saas.generation_rate_version DISABLE TRIGGER generation_rate_version_immutable"],
    ["incomplete immutable events", "DROP TRIGGER generation_rate_version_immutable ON canvas_saas.generation_rate_version; CREATE TRIGGER generation_rate_version_immutable BEFORE UPDATE ON canvas_saas.generation_rate_version FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_generation_rate_version_mutation()"],
    ["conditional immutable trigger", "DROP TRIGGER generation_rate_version_immutable ON canvas_saas.generation_rate_version; CREATE TRIGGER generation_rate_version_immutable BEFORE UPDATE OR DELETE ON canvas_saas.generation_rate_version FOR EACH ROW WHEN (OLD.revision>0) EXECUTE FUNCTION canvas_saas.reject_generation_rate_version_mutation()"],
    ["no-op immutable function", "CREATE OR REPLACE FUNCTION canvas_saas.reject_generation_rate_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"],
    ["security-definer immutable function", "ALTER FUNCTION canvas_saas.reject_generation_rate_version_mutation() SECURITY DEFINER"],
    ["changed immutable volatility", "ALTER FUNCTION canvas_saas.reject_generation_rate_version_mutation() STABLE"],
    ["missing actor foreign key", "ALTER TABLE canvas_saas.generation_rate_version DROP CONSTRAINT generation_rate_version_actor_id_user_id_fk"],
    ["unvalidated actor foreign key", "ALTER TABLE canvas_saas.generation_rate_version DROP CONSTRAINT generation_rate_version_actor_id_user_id_fk; ALTER TABLE canvas_saas.generation_rate_version ADD CONSTRAINT generation_rate_version_actor_id_user_id_fk FOREIGN KEY(actor_id) REFERENCES canvas_saas.\"user\"(id) ON DELETE RESTRICT NOT VALID"],
    ["cascading active-version foreign key", "ALTER TABLE canvas_saas.generation_rate_settings DROP CONSTRAINT generation_rate_settings_active_version_id_generation_rate_version_id_fk; ALTER TABLE canvas_saas.generation_rate_settings ADD CONSTRAINT generation_rate_settings_active_version_id_generation_rate_version_id_fk FOREIGN KEY(active_version_id) REFERENCES canvas_saas.generation_rate_version(id) ON DELETE CASCADE"],
    ["missing singleton seed", "DELETE FROM canvas_saas.generation_rate_settings WHERE id='generation'"],
] as const;
for (const [label, statement] of catalogDamages) native(`formal D04 catalog fails closed on ${label}`, () => damage(statement), 30_000);

native("formal D04 readiness rejects a read-only transaction and unavailable query path", async () => {
    await client!.query("BEGIN READ ONLY");
    try { expect(await checkGenerationRateDatabaseReadiness(target)).toBe(false); }
    finally { await client!.query("ROLLBACK"); }
    expect(await checkGenerationRateDatabaseReadiness(target)).toBe(true);
    expect(await checkGenerationRateDatabaseReadiness({ query: async () => { throw new Error("synthetic query unavailable"); } })).toBe(false);
});

async function seedVersion() {
    const actor = `q1-catalog-${crypto.randomUUID()}`, id = crypto.randomUUID();
    await client!.query('INSERT INTO canvas_saas."user"(id,name,email,email_verified,role) VALUES ($1,$1,$2,true,\'admin\')', [actor, `${actor}@fixture.invalid`]);
    await client!.query("INSERT INTO canvas_saas.generation_rate_version(id,revision,expected_revision,policy,actor_id,request_id) VALUES ($1,1,0,$2::jsonb,$3,$4)",
        [id, JSON.stringify(policy), actor, crypto.randomUUID()]);
    return { actor, id };
}

native("formal D04 readiness accepts a valid active pointer and rejects a mismatched revision", async () => {
    await client!.query("BEGIN");
    try {
        const { id } = await seedVersion();
        await client!.query("UPDATE canvas_saas.generation_rate_settings SET revision=1,active_version_id=$1 WHERE id='generation'", [id]);
        expect(await checkGenerationRateDatabaseReadiness(target)).toBe(true);
        await client!.query("UPDATE canvas_saas.generation_rate_settings SET revision=2 WHERE id='generation'");
        expect(await checkGenerationRateDatabaseReadiness(target)).toBe(false);
    } finally { await client!.query("ROLLBACK"); }
    expect(await checkGenerationRateDatabaseReadiness(target)).toBe(true);
});

native("formal policy versions reject UPDATE and DELETE, including an identical UPDATE", async () => {
    await client!.query("BEGIN");
    try {
        const { id } = await seedVersion();
        for (const statement of ["UPDATE canvas_saas.generation_rate_version SET policy=policy WHERE id=$1", "DELETE FROM canvas_saas.generation_rate_version WHERE id=$1"]) {
            await client!.query("SAVEPOINT immutable_fault");
            await expect(client!.query(statement, [id])).rejects.toThrow("published generation rate versions are immutable");
            await client!.query("ROLLBACK TO SAVEPOINT immutable_fault");
            expect((await client!.query("SELECT id,policy FROM canvas_saas.generation_rate_version WHERE id=$1", [id])).rows).toEqual([{ id, policy }]);
        }
    } finally { await client!.query("ROLLBACK"); }
});

native("formal policy JSON checks reject missing, extra, mistyped and out-of-range fields", async () => {
    await client!.query("BEGIN");
    try {
        const actor = `q1-policy-check-${crypto.randomUUID()}`;
        await client!.query('INSERT INTO canvas_saas."user"(id,name,email) VALUES ($1,$1,$2)', [actor, `${actor}@fixture.invalid`]);
        const invalid = [null, {}, { ip: policy.ip }, { ...policy, extra: true }, { ...policy, user: null },
            ...["true", 0, null].map(enabled => ({ ...policy, ip: { ...policy.ip, enabled } })),
            ...[0, -1, 1.5, 2147483648, "10"].map(points => ({ ...policy, ip: { ...policy.ip, points } })),
            ...[0, -1, 1.5, 9007199254741, "3600"].map(duration => ({ ...policy, user: { ...policy.user, duration } })),
            { ...policy, user: { enabled: true, points: 50 } }, { ...policy, ip: { ...policy.ip, extra: true } }];
        for (const value of invalid) {
            await client!.query("SAVEPOINT policy_fault");
            let rejected = false;
            try { await client!.query("INSERT INTO canvas_saas.generation_rate_version(id,revision,expected_revision,policy,actor_id,request_id) VALUES ($1,1,0,$2::jsonb,$3,$4)",
                [crypto.randomUUID(), JSON.stringify(value), actor, crypto.randomUUID()]); }
            catch (error) {
                // PG may reject a JSON numeric cast before the CHECK reports its name.
                expect(["23514", "22P02", "22003"]).toContain((error as { code?: string }).code ?? "unexpected_missing_code"); rejected = true;
            }
            await client!.query("ROLLBACK TO SAVEPOINT policy_fault");
            expect(rejected).toBe(true);
        }
        expect((await client!.query("SELECT count(*)::int AS count FROM canvas_saas.generation_rate_version WHERE actor_id=$1", [actor])).rows[0].count).toBe(0);
    } finally { await client!.query("ROLLBACK"); }
});
