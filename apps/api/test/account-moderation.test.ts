import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAuth, getPrincipal } from "@infinite-canvas/auth";
import { session, user } from "@infinite-canvas/database/schema";
import { AccountModerationError, getAccountModeration, getAccountModerationOperation, setAccountModeration,
    type ModerationWrite, type SafetyActor } from "../../../packages/database/src/account-moderation";
import { prepareProviderDiscovery } from "../../../packages/database/src/provider-discovery";
import { listNodeModelGroups, saveNodeModelGroups } from "../../../packages/database/src/node-model-groups";
import { createTestDatabase } from "./database";

const origin = "http://localhost:4000", password = "synthetic-safety-password";
let database: Awaited<ReturnType<typeof createTestDatabase>>, auth: ReturnType<typeof createAuth>;
type Identity = { id: string; cookie: string; actor: SafetyActor; email: string };
let admin: Identity, otherAdmin: Identity;
const body = (disabled: boolean, expectedVersion: number): ModerationWrite => ({ operationId: crypto.randomUUID(), disabled,
    expectedVersion, reason: "合成账户处置验证" });
const request = (path: string, input: unknown) => auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input),
}));
const rows = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;
async function login(email: string) {
    const response = await request("/sign-in/email", { email, password });
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return { response, cookie };
}
async function identity(role: "user" | "admin" = "user"): Promise<Identity> {
    const email = `safety-${crypto.randomUUID()}@example.test`;
    expect((await request("/sign-up/email", { name: "合成安全账号", email, password,
        moderationVersion: 99, disabled: true, role: "admin" })).status).toBe(200);
    const [row] = await database.db.select().from(user).where(eq(user.email, email));
    expect(row.disabled).toBe(false);
    expect(rows(await database.db.execute(sql`SELECT moderation_version FROM canvas_saas."user" WHERE id = ${row.id}`)))
        .toEqual([{ moderation_version: 0 }]);
    await database.db.update(user).set({ emailVerified: true, role }).where(eq(user.id, row.id));
    const { response, cookie } = await login(email);
    expect(response.status).toBe(200);
    const principal = await getPrincipal(auth, new Headers({ cookie }));
    expect(principal.principal?.id).toBe(row.id);
    expect(principal.sessionContext?.moderationVersion).toBe(0);
    return { id: row.id, cookie, email, actor: { actorId: row.id, sessionId: principal.sessionContext!.id,
        sessionExpiresAt: principal.sessionContext!.expiresAt, requestId: crypto.randomUUID() } };
}
async function counts(id: string) {
    return rows(await database.db.execute(sql`SELECT
        (SELECT count(*)::int FROM canvas_saas.account_moderation_operation WHERE target_user_id = ${id}) AS operations,
        (SELECT count(*)::int FROM canvas_saas.audit_event WHERE resource_id = ${id} AND action IN ('user.disabled', 'user.enabled')) AS audits,
        (SELECT count(*)::int FROM canvas_saas.session WHERE user_id = ${id}) AS sessions`))[0];
}
beforeAll(async () => {
    database = await createTestDatabase();
    auth = createAuth({ database: database.db, baseURL: origin, secret: crypto.randomUUID() + crypto.randomUUID(),
        sendVerificationEmail: async () => {}, sendResetPassword: async () => {} });
    admin = await identity("admin"); otherAdmin = await identity("admin");
}, 30_000);
afterAll(async () => { await database?.close(); });

test("ban revokes sessions atomically and unban never revives an old cookie", async () => {
    const target = await identity(), input = body(true, 0);
    const banned = await setAccountModeration(database.db, target.id, input, admin.actor);
    expect(banned).toMatchObject({ operationId: input.operationId, targetUserId: target.id, disabled: true, revision: 1 });
    expect(await getAccountModeration(database.db, target.id, admin.actor)).toEqual({ userId: target.id, disabled: true, moderationVersion: 1 });
    expect(await counts(target.id)).toEqual({ operations: 1, audits: 1, sessions: 0 });
    expect((await getPrincipal(auth, new Headers({ cookie: target.cookie }))).principal).toBeNull();
    expect((await login(target.email)).response.status).toBe(403);
    await setAccountModeration(database.db, target.id, body(false, 1), admin.actor);
    expect((await getPrincipal(auth, new Headers({ cookie: target.cookie }))).principal).toBeNull();
    const fresh = await login(target.email);
    expect(fresh.response.status).toBe(200);
    const current = await getPrincipal(auth, new Headers({ cookie: fresh.cookie }));
    expect(current.principal?.id).toBe(target.id);
    expect(current.sessionContext?.moderationVersion).toBe(2);
    const audit = rows(await database.db.execute(sql`SELECT action, revision FROM canvas_saas.audit_event
        WHERE resource_id = ${target.id} ORDER BY revision`));
    expect(audit).toEqual([{ action: "user.disabled", revision: 1 }, { action: "user.enabled", revision: 2 }]);
});

test("a repeated old operation returns its receipt without reapplying a later-reversed state", async () => {
    const target = await identity(), input = body(true, 0);
    const first = await setAccountModeration(database.db, target.id, input, admin.actor);
    await setAccountModeration(database.db, target.id, body(false, 1), admin.actor);
    expect(await setAccountModeration(database.db, target.id, input, admin.actor)).toEqual(first);
    expect(await getAccountModerationOperation(database.db, input.operationId, admin.actor)).toEqual(first);
    expect(await getAccountModerationOperation(database.db, input.operationId, otherAdmin.actor)).toBeNull();
    expect(await getAccountModeration(database.db, target.id, admin.actor)).toMatchObject({ disabled: false, moderationVersion: 2 });
    for (const modified of [{ ...input, reason: "另一理由" }, { ...input, expectedVersion: 2 }, { ...input, disabled: false }]) {
        await expect(setAccountModeration(database.db, target.id, modified, admin.actor)).rejects.toMatchObject({ code: "moderation_conflict" });
    }
    await expect(setAccountModeration(database.db, target.id, input, otherAdmin.actor)).rejects.toMatchObject({ code: "moderation_conflict" });
    expect(await counts(target.id)).toEqual({ operations: 2, audits: 2, sessions: 0 });
});

test("normal users and stale, expired or revoked administrator sessions cannot write", async () => {
    const target = await identity(), ordinary = await identity(), expired = await identity("admin"), revoked = await identity("admin");
    await database.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, expired.actor.sessionId));
    await database.db.delete(session).where(eq(session.id, revoked.actor.sessionId));
    for (const actor of [ordinary.actor, expired.actor, revoked.actor, { ...admin.actor, sessionExpiresAt: new Date(0) },
        { ...ordinary.actor, actorId: admin.id }]) {
        await expect(setAccountModeration(database.db, target.id, body(true, 0), actor)).rejects.toMatchObject({ code: "account_changed" });
    }
    expect(await counts(target.id)).toEqual({ operations: 0, audits: 0, sessions: 1 });
});

test("audit failure rolls back disabled state, sessions and immutable receipt", async () => {
    const target = await identity(), input = body(true, 0);
    await database.db.execute(sql`ALTER TABLE canvas_saas.audit_event ADD CONSTRAINT q1_block_audit CHECK (action <> 'user.disabled') NOT VALID`);
    try { await expect(setAccountModeration(database.db, target.id, input, admin.actor)).rejects.toThrow(); }
    finally { await database.db.execute(sql`ALTER TABLE canvas_saas.audit_event DROP CONSTRAINT q1_block_audit`); }
    expect(await getAccountModeration(database.db, target.id, admin.actor)).toEqual({ userId: target.id, disabled: false, moderationVersion: 0 });
    expect(await counts(target.id)).toEqual({ operations: 0, audits: 0, sessions: 1 });
    expect((await getPrincipal(auth, new Headers({ cookie: target.cookie }))).principal?.id).toBe(target.id);
    expect(await getAccountModerationOperation(database.db, input.operationId, admin.actor)).toBeNull();
});

test("new identifiers for unchanged state or stale versions do not create receipts or audit", async () => {
    const target = await identity();
    for (const input of [body(false, 0), body(true, 1)]) {
        await expect(setAccountModeration(database.db, target.id, input, admin.actor)).rejects.toMatchObject({ code: "moderation_conflict" });
    }
    await expect(setAccountModeration(database.db, "absent-user", body(true, 0), admin.actor)).rejects.toMatchObject({ code: "moderation_not_found" });
    expect(await counts(target.id)).toEqual({ operations: 0, audits: 0, sessions: 1 });
});

test("self moderation follows the same authorization and revokes its actor session", async () => {
    const actor = await identity("admin");
    expect((await setAccountModeration(database.db, actor.id, body(true, 0), actor.actor)).revision).toBe(1);
    expect(await counts(actor.id)).toEqual({ operations: 1, audits: 1, sessions: 0 });
    expect((await getPrincipal(auth, new Headers({ cookie: actor.cookie }))).principal).toBeNull();
});

test("version-mismatched sessions fail authentication and existing administrative repository guards", async () => {
    const actor = await identity("admin");
    await database.db.execute(sql`UPDATE canvas_saas."user" SET moderation_version = 2 WHERE id = ${actor.id}`);
    const principal = await getPrincipal(auth, new Headers({ cookie: actor.cookie }));
    expect(principal.principal).toBeNull();
    expect(principal.headers.getSetCookie()).toHaveLength(0);
    expect(principal.sessionContext).toBeNull();
    await expect(getAccountModeration(database.db, admin.id, actor.actor)).rejects.toBeInstanceOf(AccountModerationError);
    await expect(prepareProviderDiscovery(database.db, "synthetic-key", crypto.randomUUID(), {
        displayName: "合成渠道", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", enabled: false,
        apiKey: "synthetic-provider-key", revision: 0,
    }, actor.actor)).rejects.toMatchObject({ code: "account_changed" });
    const groups = (await listNodeModelGroups(database.db))[0]!;
    await expect(saveNodeModelGroups(database.db, { capability: groups.capability, expectedVersion: groups.version,
        groups: groups.groups }, actor.actor)).rejects.toMatchObject({ code: "account_changed" });
});
