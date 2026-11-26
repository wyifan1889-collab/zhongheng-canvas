import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { session, user } from "./schema";

export type SafetyTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type SafetyActor = { actorId: string; sessionId: string; sessionExpiresAt: Date; requestId: string };
export type ModerationWrite = { operationId: string; disabled: boolean; expectedVersion: number; reason: string };
export type ModerationReceipt = { operationId: string; targetUserId: string; disabled: boolean; revision: number; createdAt: string };
export class AccountModerationError extends Error {
    constructor(readonly code: "account_changed" | "moderation_conflict" | "moderation_not_found" | "moderation_invalid", message: string) { super(message); }
}
const changed = () => new AccountModerationError("account_changed", "登录状态已变化，请重新确认账号");
const conflict = () => new AccountModerationError("moderation_conflict", "账户状态或操作编号已变化，请读取原回执后核对");
const invalid = () => new AccountModerationError("moderation_invalid", "账户处置字段或格式不正确");
const validVersion = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** User-before-session ordering also coordinates existing administrator writes with revocation. */
export async function assertSafetyActor(tx: SafetyTx, actor: SafetyActor, adminOnly: boolean): Promise<void> {
    const [owner] = await tx.select({ role: user.role, disabled: user.disabled, emailVerified: user.emailVerified,
        moderationVersion: sql<number>`moderation_version` }).from(user).where(eq(user.id, actor.actorId)).for("share");
    const [current] = await tx.select({ expiresAt: session.expiresAt, moderationVersion: sql<number>`moderation_version` })
        .from(session).where(and(eq(session.id, actor.sessionId), eq(session.userId, actor.actorId))).for("share");
    const now = new Date();
    if (!owner || owner.disabled || !owner.emailVerified || (adminOnly && owner.role !== "admin") ||
        !current || current.expiresAt <= now || !(actor.sessionExpiresAt instanceof Date) ||
        !Number.isFinite(actor.sessionExpiresAt.getTime()) || actor.sessionExpiresAt <= now ||
        !validVersion(owner.moderationVersion) || current.moderationVersion !== owner.moderationVersion) throw changed();
}

type StoredOperation = { id: string; target_user_id: string; actor_id: string; disabled: boolean;
    expected_version: number; revision: number; reason: string; created_at: Date | string };
const receipt = (row: StoredOperation): ModerationReceipt => ({ operationId: row.id, targetUserId: row.target_user_id,
    disabled: row.disabled, revision: row.revision, createdAt: new Date(row.created_at).toISOString() });
async function operation(tx: SafetyTx, id: string) {
    const result = await tx.execute(sql`SELECT id, target_user_id, actor_id, disabled, expected_version, revision, reason, created_at
        FROM canvas_saas.account_moderation_operation WHERE id = ${id}::uuid`);
    return (result as unknown as { rows: StoredOperation[] }).rows[0];
}

export async function getAccountModeration(db: Database, targetUserId: string, actor: SafetyActor) {
    return db.transaction(async tx => {
        await assertSafetyActor(tx, actor, true);
        const [target] = await tx.select({ userId: user.id, disabled: user.disabled,
            moderationVersion: sql<number>`moderation_version` }).from(user).where(eq(user.id, targetUserId));
        return target ?? null;
    });
}

export async function getAccountModerationOperation(db: Database, operationId: string, actor: SafetyActor): Promise<ModerationReceipt | null> {
    if (!uuid(operationId)) throw invalid();
    return db.transaction(async tx => {
        await assertSafetyActor(tx, actor, true);
        const found = await operation(tx, operationId.toLowerCase());
        return found?.actor_id === actor.actorId ? receipt(found) : null;
    });
}

/** State, session invalidation, immutable receipt and audit have one commit boundary. */
export async function setAccountModeration(db: Database, targetUserId: string, input: ModerationWrite,
    actor: SafetyActor): Promise<ModerationReceipt> {
    if (!targetUserId || !uuid(input.operationId) || typeof input.disabled !== "boolean" ||
        !validVersion(input.expectedVersion) || typeof input.reason !== "string" || !input.reason.trim()) throw invalid();
    const id = input.operationId.toLowerCase();
    return db.transaction(async tx => {
        // Every cross-account moderation takes the same user-row order. Do not take
        // an actor session lock first: another administrator may be deleting it.
        const targets = await tx.select({ id: user.id, disabled: user.disabled, moderationVersion: sql<number>`moderation_version` })
            .from(user).where(inArray(user.id, [...new Set([actor.actorId, targetUserId])])).orderBy(asc(user.id)).for("update");
        await assertSafetyActor(tx, actor, true);
        const previous = await operation(tx, id);
        if (previous) {
            if (previous.actor_id !== actor.actorId || previous.target_user_id !== targetUserId ||
                previous.disabled !== input.disabled || previous.expected_version !== input.expectedVersion || previous.reason !== input.reason) throw conflict();
            return receipt(previous);
        }
        const target = targets.find(row => row.id === targetUserId);
        if (!target) throw new AccountModerationError("moderation_not_found", "账户不存在");
        if (!validVersion(target.moderationVersion) || target.moderationVersion !== input.expectedVersion ||
            target.disabled === input.disabled || target.moderationVersion === 2_147_483_647) throw conflict();
        const revision = target.moderationVersion + 1;
        await tx.execute(sql`UPDATE canvas_saas."user" SET disabled = ${input.disabled}, moderation_version = ${revision}, updated_at = now()
            WHERE id = ${targetUserId}`);
        await tx.delete(session).where(eq(session.userId, targetUserId));
        const inserted = await tx.execute(sql`INSERT INTO canvas_saas.account_moderation_operation
            (id, target_user_id, actor_id, disabled, expected_version, revision, reason, request_id)
            VALUES (${id}::uuid, ${targetUserId}, ${actor.actorId}, ${input.disabled}, ${input.expectedVersion}, ${revision}, ${input.reason}, ${actor.requestId})
            ON CONFLICT (id) DO NOTHING RETURNING id, target_user_id, actor_id, disabled, expected_version, revision, reason, created_at`);
        // A competing operation on another target may claim this UUID. Roll back
        // this entire transaction instead of preserving any partial state change.
        const saved = (inserted as unknown as { rows: StoredOperation[] }).rows[0];
        if (!saved) throw conflict();
        await tx.execute(sql`INSERT INTO canvas_saas.audit_event (id, actor_id, action, resource_id, revision, request_id)
            VALUES (${crypto.randomUUID()}, ${actor.actorId}, ${input.disabled ? "user.disabled" : "user.enabled"}, ${targetUserId}, ${revision}, ${actor.requestId})`);
        return receipt(saved);
    });
}
