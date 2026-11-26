import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Database } from "./client";
import type { SafetyActor } from "./account-moderation";
import { createTestDatabase } from "../../../apps/api/test/database";
import { getAdminGenerationRates, getGenerationRateOperation, isGenerationRateDuration, isGenerationRatePoints,
    parseGenerationRatePolicy, publishGenerationRates, resolveGenerationRates,
    type GenerationRatePolicyWrite, type GenerationSafetyDefaults } from "./generation-rate-settings";

const base: GenerationSafetyDefaults = {
    policy: { ip: { enabled: true, points: 10, duration: 3600 }, user: { enabled: true, points: 50, duration: 86400 } },
    modelRates: [], checkpointMode: "record",
};
const input = (expectedRevision = 0): GenerationRatePolicyWrite => ({ operationId: crypto.randomUUID(), expectedRevision,
    policy: { ip: { enabled: true, points: 12 }, user: { enabled: false, points: 70 } } });

async function fixture() {
    const database = await createTestDatabase();
    try {
        const seed = async (role: "user" | "admin" = "admin"): Promise<SafetyActor> => {
            const actorId = crypto.randomUUID(), sessionId = crypto.randomUUID(), expiresAt = new Date(Date.now() + 3_600_000);
            await database.db.execute(sql`INSERT INTO canvas_saas."user" (id,name,email,email_verified,role)
                VALUES (${actorId},'合成政策管理员',${`${actorId}@example.test`},true,${role})`);
            await database.db.execute(sql`INSERT INTO canvas_saas.session(id,token,user_id,expires_at)
                VALUES (${sessionId},${crypto.randomUUID()},${actorId},${expiresAt.toISOString()}::timestamptz)`);
            return { actorId, sessionId, sessionExpiresAt: expiresAt, requestId: crypto.randomUUID() };
        };
        return { ...database, seed, admin: await seed() };
    } catch (error) { await database.close(); throw error; }
}
async function counts(db: Database) {
    return (await db.execute(sql`SELECT (SELECT count(*)::int FROM canvas_saas.generation_rate_version) AS versions,
        (SELECT count(*)::int FROM canvas_saas.audit_event WHERE action='generation.rates.published') AS audits,
        (SELECT revision FROM canvas_saas.generation_rate_settings WHERE id='generation') AS revision`)).rows[0];
}

test("rate validators enforce storage/expiry representation and strict complete policy", () => {
    expect(isGenerationRatePoints(2_147_483_647)).toBe(true);
    for (const value of [0, -1, 0.5, 2_147_483_648, "10", NaN]) expect(isGenerationRatePoints(value)).toBe(false);
    expect(isGenerationRateDuration(86400)).toBe(true);
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, Math.floor(Number.MAX_SAFE_INTEGER / 1000), "3600"]) {
        expect(isGenerationRateDuration(value)).toBe(false);
    }
    expect(parseGenerationRatePolicy(base.policy)).toEqual(base.policy);
    expect(parseGenerationRatePolicy({ ...base.policy, modelRates: [] })).toBeNull();
    expect(parseGenerationRatePolicy({ ...base.policy, ip: { enabled: false, points: 0, duration: 3600 } })).toBeNull();
    expect(parseGenerationRatePolicy({ ...base.policy, ip: { enabled: false, points: 10 } })).toBeNull();
});

test("only the actual 0/null seed uses server defaults and returned snapshots do not alias inputs", async () => {
    const f = await fixture();
    try {
        const defaults: GenerationSafetyDefaults = { ...base, modelRates: [{ modelId: "synthetic-model", points: 3, duration: 300 }] };
        const current = await getAdminGenerationRates(f.db, f.admin, defaults);
        expect(current).toEqual({ ...defaults, revision: 0, publicationId: null, source: "server-default" });
        current.policy.ip.points = 99; current.modelRates[0]!.points = 99;
        expect(await resolveGenerationRates(f.db, defaults)).toMatchObject({ policy: base.policy,
            modelRates: [{ modelId: "synthetic-model", points: 3, duration: 300 }] });
        expect(await counts(f.db)).toEqual({ versions: 0, audits: 0, revision: 0 });
    } finally { await f.close(); }
}, 15_000);

test("publication and audit are atomic while effective model/mode remain current server values", async () => {
    const f = await fixture();
    try {
        const requested = input(), receipt = await publishGenerationRates(f.db, requested, f.admin, base);
        expect(receipt).toMatchObject({ operationId: requested.operationId, publishedRevision: 1,
            policy: { ip: { enabled: true, points: 12, duration: 3600 }, user: { enabled: false, points: 70, duration: 86400 } } });
        const changed: GenerationSafetyDefaults = { policy: { ip: { enabled: false, points: 1, duration: 1800 },
            user: { enabled: true, points: 1, duration: 43200 } }, checkpointMode: "off", modelRates: [{ modelId: "new-model", points: 4, duration: 600 }] };
        expect(await resolveGenerationRates(f.db, changed)).toEqual({ ...changed, policy: receipt.policy,
            revision: 1, publicationId: requested.operationId, source: "published" });
        const next = await publishGenerationRates(f.db, input(1), f.admin, changed);
        expect(next.policy.ip.duration).toBe(3600); expect(next.policy.user.duration).toBe(86400);
        const audit = (await f.db.execute(sql`SELECT actor_id, action, resource_id, revision, request_id FROM canvas_saas.audit_event
            WHERE action='generation.rates.published' ORDER BY revision`)).rows;
        expect(audit).toEqual([1, 2].map(revision => ({ actor_id: f.admin.actorId, action: "generation.rates.published",
            resource_id: "generation", revision, request_id: f.admin.requestId })));
    } finally { await f.close(); }
}, 15_000);

test("old operation replay returns its immutable receipt without reactivating it or comparing new periods", async () => {
    const f = await fixture();
    try {
        const first = input(), receipt = await publishGenerationRates(f.db, first, f.admin, base);
        const second = input(1); second.policy.ip.points = 20;
        const active = await publishGenerationRates(f.db, second, f.admin, base);
        const changed = { ...base, policy: { ip: { ...base.policy.ip, duration: 60 }, user: { ...base.policy.user, duration: 120 } } };
        expect(await publishGenerationRates(f.db, first, f.admin, changed)).toEqual(receipt);
        expect(await getGenerationRateOperation(f.db, first.operationId.toUpperCase(), f.admin)).toEqual(receipt);
        expect(await resolveGenerationRates(f.db, base)).toMatchObject({ revision: 2, publicationId: active.operationId, policy: active.policy });
        expect(await counts(f.db)).toEqual({ versions: 2, audits: 2, revision: 2 });
        await expect(publishGenerationRates(f.db, { ...first, expectedRevision: 1 }, f.admin, base)).rejects.toMatchObject({ code: "rate_settings_conflict" });
        await expect(publishGenerationRates(f.db, { ...first, policy: { ...first.policy, ip: { enabled: false, points: 12 } } }, f.admin, base))
            .rejects.toMatchObject({ code: "rate_settings_conflict" });
        const other = await f.seed();
        expect(await getGenerationRateOperation(f.db, first.operationId, other)).toBeNull();
        await expect(publishGenerationRates(f.db, first, other, base)).rejects.toMatchObject({ code: "rate_settings_conflict" });
    } finally { await f.close(); }
}, 15_000);

test("stale revision loses CAS with no extra immutable record or audit", async () => {
    const f = await fixture();
    try {
        await publishGenerationRates(f.db, input(), f.admin, base);
        await expect(publishGenerationRates(f.db, input(), f.admin, base)).rejects.toMatchObject({ code: "rate_settings_conflict" });
        expect(await counts(f.db)).toEqual({ versions: 1, audits: 1, revision: 1 });
    } finally { await f.close(); }
}, 15_000);

test("current database role, session, enabled state and moderation epoch guard reads and writes", async () => {
    const f = await fixture();
    try {
        const ordinary = await f.seed("user"), revoked = await f.seed(), disabled = await f.seed(), oldEpoch = await f.seed();
        await f.db.execute(sql`DELETE FROM canvas_saas.session WHERE id=${revoked.sessionId}`);
        await f.db.execute(sql`UPDATE canvas_saas."user" SET disabled=true WHERE id=${disabled.actorId}`);
        await f.db.execute(sql`UPDATE canvas_saas."user" SET moderation_version=1 WHERE id=${oldEpoch.actorId}`);
        for (const actor of [ordinary, revoked, disabled, oldEpoch, { ...f.admin, sessionExpiresAt: new Date(0) }]) {
            await expect(getAdminGenerationRates(f.db, actor, base)).rejects.toMatchObject({ code: "account_changed" });
            await expect(publishGenerationRates(f.db, input(), actor, base)).rejects.toMatchObject({ code: "account_changed" });
            await expect(getGenerationRateOperation(f.db, crypto.randomUUID(), actor)).rejects.toMatchObject({ code: "account_changed" });
        }
        expect(await counts(f.db)).toEqual({ versions: 0, audits: 0, revision: 0 });
    } finally { await f.close(); }
}, 15_000);

test("audit failure rolls back both publication and active pointer without returning database details", async () => {
    const f = await fixture();
    try {
        await f.db.execute(sql`CREATE FUNCTION pg_temp.reject_generation_rate_audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.action='generation.rates.published' THEN RAISE EXCEPTION 'synthetic-private-audit-failure'; END IF; RETURN NEW; END; $$`);
        await f.db.execute(sql`CREATE TRIGGER reject_generation_rate_audit BEFORE INSERT ON canvas_saas.audit_event
            FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_generation_rate_audit()`);
        try { await publishGenerationRates(f.db, input(), f.admin, base); throw new Error("expected audit rejection"); }
        catch (failure) { expect(failure).toMatchObject({ code: "rate_settings_unavailable" }); expect(String(failure)).not.toContain("synthetic-private"); }
        expect(await counts(f.db)).toEqual({ versions: 0, audits: 0, revision: 0 });
        expect(await resolveGenerationRates(f.db, base)).toMatchObject({ revision: 0, source: "server-default" });
    } finally { await f.close(); }
}, 15_000);

test("missing or inconsistent joined settings never silently fall back to server defaults", async () => {
    const id = crypto.randomUUID(), valid = { settings_revision: 1, active_version_id: id, version_id: id, revision: 1,
        expected_revision: 0, policy: base.policy, actor_id: "synthetic-admin", request_id: "synthetic-request", created_at: new Date() };
    const fake = (rows: unknown[]) => ({ async execute() { return { rows }; } }) as unknown as Database;
    for (const row of [undefined, { ...valid, settings_revision: 0 }, { ...valid, active_version_id: null }, { ...valid, version_id: null },
        { ...valid, settings_revision: 2 }, { ...valid, expected_revision: 1 }, { ...valid, created_at: null },
        { ...valid, policy: { ...base.policy, ip: { enabled: true, points: 0, duration: 3600 } } }]) {
        await expect(resolveGenerationRates(fake(row ? [row] : []), base)).rejects.toMatchObject({ code: "rate_settings_unavailable" });
    }
    await expect(resolveGenerationRates({ async execute() { throw new Error("private-database-address-and-secret"); } } as unknown as Database, base))
        .rejects.toMatchObject({ code: "rate_settings_unavailable" });
    expect(await resolveGenerationRates(fake([valid]), base)).toMatchObject({ revision: 1, source: "published", publicationId: id });
});

test("strict writes reject extra identity, duration, model or invalid points before any database call", async () => {
    const original = input();
    for (const invalid of [{ ...original, actorId: "forged" }, { ...original, policy: { ...original.policy, models: [] } },
        { ...original, policy: { ...original.policy, ip: { ...original.policy.ip, duration: 300 } } },
        { ...original, expectedRevision: 2_147_483_648 }, ...[0, -1, 1.5, 2_147_483_648, "12"].map(points => ({ ...original,
            policy: { ...original.policy, ip: { ...original.policy.ip, points } } }))]) {
        await expect(publishGenerationRates(null as unknown as Database, invalid as GenerationRatePolicyWrite, {} as SafetyActor, base))
            .rejects.toMatchObject({ code: "rate_settings_invalid" });
    }
    await expect(getGenerationRateOperation(null as unknown as Database, "not-a-uuid", {} as SafetyActor)).rejects.toMatchObject({ code: "rate_settings_invalid" });
});
