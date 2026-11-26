import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { AccountModerationError, assertSafetyActor, type SafetyActor, type SafetyTx } from "./account-moderation";
import type { RateRule } from "./rate-limit";

export type GenerationRatePolicy = { ip: RateRule & { enabled: boolean }; user: RateRule & { enabled: boolean } };
export type GenerationSafetyDefaults = {
    policy: GenerationRatePolicy;
    modelRates: Array<RateRule & { modelId: string }>;
    checkpointMode: "off" | "record";
};
export type GenerationRatePolicyWrite = {
    operationId: string;
    expectedRevision: number;
    policy: { ip: { enabled: boolean; points: number }; user: { enabled: boolean; points: number } };
};
export type EffectiveGenerationSettings = GenerationSafetyDefaults & {
    revision: number; publicationId: string | null; source: "server-default" | "published";
};
export type GenerationRatePublication = { operationId: string; publishedRevision: number; policy: GenerationRatePolicy; createdAt: string };
export class GenerationRateSettingsError extends Error {
    constructor(readonly code: "account_changed" | "rate_settings_conflict" | "rate_settings_invalid" | "rate_settings_unavailable", message: string) { super(message); }
}
const error = (code: GenerationRateSettingsError["code"]) => new GenerationRateSettingsError(code,
    code === "account_changed" ? "登录状态已变化，请重新确认账号" : code === "rate_settings_conflict" ? "生成政策或操作编号已变化，请核对原回执与当前版本"
        : code === "rate_settings_invalid" ? "生成政策字段或格式不正确" : "生成政策暂不可用，请保留输入并稍后再试");
const maxInteger = 2_147_483_647;
const revision = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maxInteger;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isGenerationRatePoints(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= maxInteger;
}
export function isGenerationRateDuration(value: unknown): value is number {
    return typeof value === "number" && value > 0 && Number.isSafeInteger(value) &&
        Number.isSafeInteger(value * 1000) && Number.isSafeInteger(Date.now() + value * 1000);
}
/** Strict storage projection; disabled dimensions retain their positive points and period. */
export function parseGenerationRatePolicy(value: unknown): GenerationRatePolicy | null {
    if (!fields(value, ["ip", "user"])) return null;
    for (const key of ["ip", "user"] as const) {
        const rule = value[key];
        if (!fields(rule, ["enabled", "points", "duration"]) || typeof rule.enabled !== "boolean" ||
            !isGenerationRatePoints(rule.points) || !isGenerationRateDuration(rule.duration)) return null;
    }
    const policy = value as unknown as GenerationRatePolicy;
    return { ip: { ...policy.ip }, user: { ...policy.user } };
}
function defaults(input: GenerationSafetyDefaults): GenerationSafetyDefaults {
    const policy = parseGenerationRatePolicy(input?.policy);
    if (!policy || !Array.isArray(input.modelRates) || !["off", "record"].includes(input.checkpointMode)) throw error("rate_settings_unavailable");
    const models = input.modelRates.map(rule => {
        if (!fields(rule, ["modelId", "points", "duration"]) || typeof rule.modelId !== "string" || !rule.modelId ||
            /\s|[\x00-\x1f\x7f]/.test(rule.modelId) || !isGenerationRatePoints(rule.points) || !isGenerationRateDuration(rule.duration)) {
            throw error("rate_settings_unavailable");
        }
        return { modelId: rule.modelId, points: rule.points, duration: rule.duration };
    });
    if (new Set(models.map(rule => rule.modelId)).size !== models.length) throw error("rate_settings_unavailable");
    return { policy, modelRates: models, checkpointMode: input.checkpointMode };
}
function write(input: GenerationRatePolicyWrite): GenerationRatePolicyWrite {
    if (!fields(input, ["operationId", "expectedRevision", "policy"]) || !uuid(input.operationId) || !revision(input.expectedRevision) ||
        !fields(input.policy, ["ip", "user"])) throw error("rate_settings_invalid");
    for (const key of ["ip", "user"] as const) {
        const rule = input.policy[key];
        if (!fields(rule, ["enabled", "points"]) || typeof rule.enabled !== "boolean" || !isGenerationRatePoints(rule.points)) throw error("rate_settings_invalid");
    }
    return { operationId: input.operationId.toLowerCase(), expectedRevision: input.expectedRevision,
        policy: { ip: { ...input.policy.ip }, user: { ...input.policy.user } } };
}
type StoredVersion = { id: string; revision: number; expected_revision: number; policy: unknown; actor_id: string; request_id: string; created_at: Date | string };
function publication(row: StoredVersion): GenerationRatePublication {
    const policy = parseGenerationRatePolicy(row.policy);
    if (!(row.created_at instanceof Date) && (typeof row.created_at !== "string" || !row.created_at)) throw error("rate_settings_unavailable");
    const createdAt = new Date(row.created_at instanceof Date ? row.created_at.getTime() : row.created_at);
    if (!uuid(row.id) || !revision(row.revision) || row.revision === 0 || !revision(row.expected_revision) ||
        row.revision !== row.expected_revision + 1 || !policy || typeof row.actor_id !== "string" || !row.actor_id ||
        typeof row.request_id !== "string" || !row.request_id || !Number.isFinite(createdAt.getTime())) throw error("rate_settings_unavailable");
    return { operationId: row.id, publishedRevision: row.revision, policy, createdAt: createdAt.toISOString() };
}
async function query<T>(db: Database | SafetyTx, statement: ReturnType<typeof sql>): Promise<T[]> {
    return (await db.execute(statement) as unknown as { rows: T[] }).rows;
}
function rethrow(failure: unknown): never {
    if (failure instanceof GenerationRateSettingsError) throw failure;
    if (failure instanceof AccountModerationError && failure.code === "account_changed") throw error("account_changed");
    throw error("rate_settings_unavailable");
}
async function operation(db: Database | SafetyTx, id: string): Promise<StoredVersion | undefined> {
    return (await query<StoredVersion>(db, sql`SELECT id, revision, expected_revision, policy, actor_id, request_id, created_at
        FROM canvas_saas.generation_rate_version WHERE id = ${id}::uuid`))[0];
}

/** One joined snapshot is shared by the administrator view and actual task admission. */
export async function resolveGenerationRates(db: Database | SafetyTx, input: GenerationSafetyDefaults): Promise<EffectiveGenerationSettings> {
    const base = defaults(input);
    try {
        type Current = { settings_revision: number; active_version_id: string | null; version_id: string | null } & Omit<StoredVersion, "id">;
        const [row] = await query<Current>(db, sql`SELECT s.revision AS settings_revision, s.active_version_id, v.id AS version_id,
            v.revision, v.expected_revision, v.policy, v.actor_id, v.request_id, v.created_at
            FROM canvas_saas.generation_rate_settings s LEFT JOIN canvas_saas.generation_rate_version v ON v.id = s.active_version_id
            WHERE s.id = 'generation'`);
        if (!row || !revision(row.settings_revision)) throw error("rate_settings_unavailable");
        if (row.settings_revision === 0 && row.active_version_id === null && row.version_id === null) {
            return { ...base, revision: 0, publicationId: null, source: "server-default" };
        }
        if (!uuid(row.active_version_id) || row.active_version_id !== row.version_id || row.settings_revision !== row.revision) throw error("rate_settings_unavailable");
        const current = publication({ ...row, id: row.active_version_id });
        return { ...base, policy: current.policy, revision: current.publishedRevision, publicationId: current.operationId, source: "published" };
    } catch (failure) { rethrow(failure); }
}

export async function getAdminGenerationRates(db: Database, actor: SafetyActor, input: GenerationSafetyDefaults): Promise<EffectiveGenerationSettings> {
    try {
        return await db.transaction(async tx => {
            await assertSafetyActor(tx, actor, true);
            return resolveGenerationRates(tx, input);
        });
    } catch (failure) { rethrow(failure); }
}

/** The receipt never claims its historical policy is still the active configuration. */
export async function getGenerationRateOperation(db: Database, operationId: string, actor: SafetyActor): Promise<GenerationRatePublication | null> {
    if (!uuid(operationId)) throw error("rate_settings_invalid");
    try {
        return await db.transaction(async tx => {
            await assertSafetyActor(tx, actor, true);
            const row = await operation(tx, operationId.toLowerCase());
            return row?.actor_id === actor.actorId ? publication(row) : null;
        });
    } catch (failure) { rethrow(failure); }
}

/** Permission, immutable publication, active pointer and audit share one commit boundary. */
export async function publishGenerationRates(db: Database, input: GenerationRatePolicyWrite, actor: SafetyActor,
    suppliedDefaults: GenerationSafetyDefaults): Promise<GenerationRatePublication> {
    const requested = write(input), base = defaults(suppliedDefaults);
    try {
        return await db.transaction(async tx => {
            await assertSafetyActor(tx, actor, true); // user -> session -> settings, shared with existing writes.
            const locked = await query(tx, sql`SELECT revision, active_version_id FROM canvas_saas.generation_rate_settings
                WHERE id = 'generation' FOR UPDATE`);
            if (locked.length !== 1) throw error("rate_settings_unavailable");
            // Existing user/session locks prevent revocation races; check expiry again after a settings-lock wait.
            await assertSafetyActor(tx, actor, true);
            const current = await resolveGenerationRates(tx, base);
            const previous = await operation(tx, requested.operationId);
            if (previous) {
                const receipt = publication(previous);
                if (previous.actor_id !== actor.actorId || previous.expected_revision !== requested.expectedRevision ||
                    (["ip", "user"] as const).some(key => receipt.policy[key].enabled !== requested.policy[key].enabled ||
                        receipt.policy[key].points !== requested.policy[key].points)) throw error("rate_settings_conflict");
                return receipt;
            }
            if (current.revision !== requested.expectedRevision || current.revision === maxInteger) throw error("rate_settings_conflict");
            const policy: GenerationRatePolicy = {
                ip: { ...requested.policy.ip, duration: current.policy.ip.duration },
                user: { ...requested.policy.user, duration: current.policy.user.duration },
            };
            const [inserted] = await query<StoredVersion>(tx, sql`INSERT INTO canvas_saas.generation_rate_version
                (id, revision, expected_revision, policy, actor_id, request_id) VALUES
                (${requested.operationId}::uuid, ${current.revision + 1}, ${current.revision}, ${JSON.stringify(policy)}::jsonb, ${actor.actorId}, ${actor.requestId})
                RETURNING id, revision, expected_revision, policy, actor_id, request_id, created_at`);
            if (!inserted) throw error("rate_settings_unavailable");
            const next = await query(tx, sql`UPDATE canvas_saas.generation_rate_settings SET revision = ${current.revision + 1},
                active_version_id = ${requested.operationId}::uuid, updated_at = now()
                WHERE id = 'generation' AND revision = ${current.revision} RETURNING id`);
            if (next.length !== 1) throw error("rate_settings_conflict");
            await tx.execute(sql`INSERT INTO canvas_saas.audit_event (id, actor_id, action, resource_id, revision, request_id)
                VALUES (${crypto.randomUUID()}, ${actor.actorId}, 'generation.rates.published', 'generation', ${current.revision + 1}, ${actor.requestId})`);
            return publication(inserted);
        });
    } catch (failure) { rethrow(failure); }
}
