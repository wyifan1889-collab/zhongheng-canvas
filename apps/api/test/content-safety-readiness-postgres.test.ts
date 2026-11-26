import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { checkAccountDatabaseReadiness, type RelationQuery } from "../src/readiness";
import { postgresTestUrl } from "./database";

const enabled = process.env.Q1_SAFETY_POSTGRES === "1", pgTest = enabled ? test : test.skip;
const connectionString = enabled ? postgresTestUrl() : null;
if (enabled && (!connectionString || process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL)) {
    throw new Error("Q1 readiness仅接受runner新建的隔离回环PostgreSQL目标");
}
const off = { moderationEnabled: false, reportsEnabled: false, checkpointMode: "off" as const };
const on = { moderationEnabled: true, reportsEnabled: true, checkpointMode: "record" as const };
let database: ReturnType<typeof createDatabase> | undefined, client: PoolClient | undefined;
const safeError = (error: unknown) => {
    const value = error as { code?: unknown; position?: unknown } | null;
    return { code: typeof value?.code === "string" && /^[0-9A-Z]{5}$/.test(value.code) ? value.code : "unclassified",
        position: typeof value?.position === "string" && /^\d+$/.test(value.position) ? Number(value.position) : null };
};

/** Catalog-only diagnostics, emitted only for an unexpected real SQL result. */
async function catalog() {
    try {
        const columns = (await client!.query(`SELECT c.relname AS table_name, a.attname AS column_name,
            a.atttypid::regtype::text AS type_name, a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default_value
            FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE n.nspname='canvas_saas' AND c.relname IN ('user','session') AND a.attname LIKE '%moderation_version%'
            AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`)).rows;
        const constraints = (await client!.query(`SELECT c.relname AS table_name, k.conname, k.convalidated,
            lower(regexp_replace(pg_get_expr(k.conbin,k.conrelid), '[[:space:]()"]', '', 'g')) AS expression
            FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='canvas_saas' AND c.relname IN ('user','session','account_moderation_operation','abuse_report','content_safety_event')
            AND k.contype='c' ORDER BY c.relname,k.conname`)).rows;
        const triggers = (await client!.query(`SELECT t.tgname,t.tgenabled,t.tgtype,p.proname,p.prosecdef,
            btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g')) AS function_body
            FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
            WHERE t.tgrelid='canvas_saas.account_moderation_operation'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
        return { columns, constraints, triggers };
    } catch (error) { return { catalogError: safeError(error) }; }
}

async function ready(safety: typeof off | typeof on | undefined, expected: boolean, label: string, cloudMedia = false) {
    let markers: string[] = [], expectedMarkers: string[] = [], sqlError: ReturnType<typeof safeError> | null = null;
    const query: RelationQuery = { async query(text, values) {
        if (Array.isArray(values?.[0])) {
            const columns = JSON.parse(values?.[1] as string) as Array<{ table_name: string; column_name: string }>;
            const constraints = JSON.parse(values?.[2] as string) as Array<{ name: string }>;
            expectedMarkers = [...values[0].map(value => `canvas_saas.${value}`),
                ...columns.map(value => `column.${value.table_name}.${value.column_name}`), ...constraints.map(value => `constraint.${value.name}`),
                "constraint.user_email_lower_unique", "database.writable", ...(safety?.moderationEnabled ? ["trigger.account_moderation_operation_immutable"] : [])];
        } else if (values?.length === 6) {
            expectedMarkers = ["database.writable", ...values.flatMap((value, index) =>
                (JSON.parse(value as string) as Array<{ table: string; name: string }>).map(row =>
                    `${["column", "check", "index", "function", "trigger", "foreign"][index]}.${index < 2 ? row.table + "." : ""}${row.name}`))];
        } else expectedMarkers = ["mapping.catalog"];
        try {
            const result = await client!.query<{ relation: string }>(text, values ? [...values] : undefined);
            markers = result.rows.map(row => row.relation);
            return result;
        } catch (error) { sqlError = safeError(error); throw error; }
    } };
    const actual = await checkAccountDatabaseReadiness(query, cloudMedia, safety);
    if (actual !== expected) console.error(JSON.stringify({ case: label, expected, actual, sqlError,
        missing: expectedMarkers.filter(value => !markers.includes(value)), catalog: await catalog() }));
    expect(actual).toBe(expected);
}

beforeAll(async () => {
    if (!enabled) return;
    database = createDatabase(connectionString!);
    client = await database.pool.connect();
    const boundary = (await client.query(`SELECT current_database() AS name,current_user AS role,host(inet_server_addr()) AS host,
        current_setting('server_version_num')::int AS version,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged`)).rows[0];
    expect(boundary).toMatchObject({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false });
    expect(boundary.version).toBeGreaterThanOrEqual(160000); expect(boundary.version).toBeLessThan(170000);
}, 30_000);
afterAll(async () => {
    if (client) { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    await database?.close();
});

pgTest("the formally migrated PostgreSQL 16 database is ready with all safety flags off and on", async () => {
    await ready(undefined, true, "default_off");
    await ready(off, true, "all_off");
    await ready(on, true, "all_on");
    await ready(on, true, "all_on_media", true);
}, 30_000);

for (const table of ["user", "session"] as const) pgTest(`${table} moderation version and validated nonnegative constraint are required even with all flags off`, async () => {
    const changes = [
        { name: "missing_column", sql: `ALTER TABLE canvas_saas."${table}" RENAME COLUMN moderation_version TO q1_missing_moderation_version` },
        { name: "weakened_constraint", sql: `ALTER TABLE canvas_saas."${table}" DROP CONSTRAINT ${table}_moderation_version,
            ADD CONSTRAINT ${table}_moderation_version CHECK (moderation_version >= -1)` },
        { name: "unvalidated_constraint", sql: `ALTER TABLE canvas_saas."${table}" DROP CONSTRAINT ${table}_moderation_version,
            ADD CONSTRAINT ${table}_moderation_version CHECK (moderation_version >= 0) NOT VALID` },
    ];
    for (const change of changes) {
        await client!.query("BEGIN");
        try {
            await client!.query(change.sql);
            await ready(off, false, `${table}_${change.name}_off`);
            await ready(on, false, `${table}_${change.name}_on`);
        } finally { await client!.query("ROLLBACK"); }
        await ready(on, true, `${table}_${change.name}_restored`);
    }
}, 30_000);

const triggerChanges = [
    { name: "disabled_trigger", statements: ["ALTER TABLE canvas_saas.account_moderation_operation DISABLE TRIGGER account_moderation_operation_immutable"] },
    { name: "invalid_trigger_shape", statements: ["DROP TRIGGER account_moderation_operation_immutable ON canvas_saas.account_moderation_operation",
        `CREATE TRIGGER account_moderation_operation_immutable AFTER UPDATE OR DELETE ON canvas_saas.account_moderation_operation
            FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_account_moderation_operation_mutation()`] },
    { name: "nonprotecting_function_body", statements: [`CREATE OR REPLACE FUNCTION canvas_saas.reject_account_moderation_operation_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END; $$`] },
];
for (const change of triggerChanges) pgTest(`enabled safety rejects ${change.name} and recovers after rollback`, async () => {
    await client!.query("BEGIN");
    try {
        for (const statement of change.statements) await client!.query(statement);
        await ready(on, false, change.name);
    } finally { await client!.query("ROLLBACK"); }
    await ready(on, true, `${change.name}_restored`);
}, 30_000);
