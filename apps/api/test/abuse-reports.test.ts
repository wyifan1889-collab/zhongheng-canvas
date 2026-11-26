import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { user, session } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";
import { getOwnAbuseReport, listAbuseReports, receiveAbuseReport, submitAbuseReport } from "../../../packages/database/src/abuse-reports";
import type { SafetyActor } from "../../../packages/database/src/account-moderation";
import { handleAbuseReport } from "../src/abuse-report-handler";
import { handleAccountModeration } from "../src/account-moderation-handler";
import { readContentSafetyConfig } from "../src/content-safety-config";
import type { SafetyRouteContext } from "../src/account-moderation-contract";
import { accountPolicy } from "../src/policy";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let alice: SafetyActor, bob: SafetyActor, admin: SafetyActor;
const config = readContentSafetyConfig({ SAAS_ABUSE_REPORTS_ENABLED: "true", SAAS_ACCOUNT_MODERATION_ENABLED: "true" });
const report = () => ({ id: crypto.randomUUID(), subject: "隔离投诉主题", details: "仅合成测试，未举报真实用户。" });
const ctx = (actor: SafetyActor, role: "user" | "admin" = "user"): SafetyRouteContext => ({ database: database.db, actor, role, config, policy: accountPolicy });
const request = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:4000${path}`, { method,
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const rows = async (query: ReturnType<typeof sql>) => (await database.db.execute(query)).rows;

beforeAll(async () => {
    database = await createTestDatabase();
    const seed = async (role: "user" | "admin") => {
        const actorId = crypto.randomUUID(), sessionId = crypto.randomUUID(), sessionExpiresAt = new Date(Date.now() + 60_000);
        await database.db.insert(user).values({ id: actorId, email: `${actorId}@fixture.invalid`, name: "合成账户", role, emailVerified: true });
        await database.db.insert(session).values({ id: sessionId, userId: actorId, token: crypto.randomUUID(), expiresAt: sessionExpiresAt });
        return { actorId, sessionId, sessionExpiresAt, requestId: crypto.randomUUID() };
    };
    alice = await seed("user"); bob = await seed("user"); admin = await seed("admin");
}, 30_000);
afterAll(async () => { await database?.close(); });

test("safety routes reject forged body identity and ordinary users before accessing administrator writes", async () => {
    await expect(handleAbuseReport(request("/api/v1/abuse-reports", "POST", { ...report(), reporterId: bob.actorId }), ctx(alice))).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(handleAccountModeration(request(`/api/v1/admin/users/${bob.actorId}/moderation`, "PUT", {}), ctx(alice))).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(handleAbuseReport(request("/api/v1/admin/abuse-reports"), ctx(alice))).rejects.toMatchObject({ status: 403 });
    await expect(handleAbuseReport(request("/api/v1/abuse-reports", "POST", report()), { ...ctx(alice), actor: null as never })).rejects.toMatchObject({ status: 401 });
    await expect(handleAbuseReport(request("/api/v1/admin/abuse-reports?status=submitted&status=received"), ctx(admin, "admin"))).rejects.toMatchObject({ status: 400 });
});

test("disabled feature defaults touch no repository and unrelated routes remain unclaimed", async () => {
    const closed = { ...ctx(alice), database: null as never, config: readContentSafetyConfig({}) };
    await expect(handleAbuseReport(request("/api/v1/abuse-reports", "POST", report()), closed)).rejects.toMatchObject({ code: "abuse_reports_unavailable", status: 503 });
    await expect(handleAccountModeration(request(`/api/v1/admin/users/${alice.actorId}/moderation`), { ...closed, role: "admin" })).rejects.toMatchObject({ code: "moderation_unavailable", status: 503 });
    expect(await handleAbuseReport(request("/api/v1/generation/tasks"), closed)).toBeNull();
    expect(await handleAccountModeration(request("/api/v1/wallet"), closed)).toBeNull();
});

test("owner-only receipts and immutable duplicate submissions expose no other account content", async () => {
    const input = report(), first = await submitAbuseReport(database.db, input, alice);
    expect(first.status).toBe("submitted"); expect(first.revision).toBe(1);
    expect(await submitAbuseReport(database.db, input, alice)).toEqual(first);
    expect(await getOwnAbuseReport(database.db, input.id, bob)).toBeNull();
    expect(await getOwnAbuseReport(database.db, input.id, alice)).toEqual(first);
    await expect(submitAbuseReport(database.db, input, bob)).rejects.toMatchObject({ code: "report_conflict" });
    await expect(submitAbuseReport(database.db, { ...input, details: "不同正文" }, alice)).rejects.toMatchObject({ code: "report_conflict" });
    expect((await rows(sql`SELECT * FROM canvas_saas.audit_event WHERE resource_id = ${input.id}`))).toHaveLength(1);
});

test("the database rejects a forged administrator context and revoked sessions", async () => {
    await expect(listAbuseReports(database.db, {}, alice, 50)).rejects.toMatchObject({ code: "account_changed" });
    await expect(handleAbuseReport(request("/api/v1/admin/abuse-reports"), ctx(alice, "admin"))).rejects.toMatchObject({ code: "account_changed" });
    await expect(getOwnAbuseReport(database.db, crypto.randomUUID(), { ...alice, sessionId: "revoked" })).rejects.toMatchObject({ code: "account_changed" });
});

test("administrator receipt records one transition and safe audit without creating a decision", async () => {
    const input = report(); await submitAbuseReport(database.db, input, alice);
    const received = await receiveAbuseReport(database.db, input.id, 1, admin);
    expect(received).toMatchObject({ id: input.id, status: "received", revision: 2 }); expect(received.receivedAt).not.toBeNull();
    await expect(receiveAbuseReport(database.db, input.id, 1, admin)).rejects.toMatchObject({ code: "report_conflict" });
    expect(await receiveAbuseReport(database.db, input.id, 2, admin)).toEqual(received);
    const audit = await rows(sql`SELECT * FROM canvas_saas.audit_event WHERE resource_id = ${input.id} ORDER BY revision`);
    expect(audit.map(row => row.action)).toEqual(["abuse.report.submitted", "abuse.report.received"]);
    expect(JSON.stringify(audit)).not.toContain(input.details);
    const lookup = await handleAbuseReport(request(`/api/v1/admin/abuse-reports/${input.id}`), ctx(admin, "admin"));
    expect(lookup?.data.item).toEqual(received);
    await expect(handleAbuseReport(request(`/api/v1/abuse-reports/${input.id}`), ctx(bob))).rejects.toMatchObject({ status: 404 });
});

test("concurrent same-number report submissions preserve one record and one audit", async () => {
    const input = report();
    const results = await Promise.all([submitAbuseReport(database.db, input, alice), submitAbuseReport(database.db, input, alice)]);
    expect(results[0]).toEqual(results[1]);
    expect(await rows(sql`SELECT id FROM canvas_saas.abuse_report WHERE id = ${input.id}::uuid`)).toHaveLength(1);
    expect(await rows(sql`SELECT id FROM canvas_saas.audit_event WHERE resource_id = ${input.id}`)).toHaveLength(1);
});

test("audit failures roll back both new reports and receipt status changes", async () => {
    const input = report(), existing = report(); await submitAbuseReport(database.db, existing, alice);
    await database.db.execute(sql`CREATE FUNCTION canvas_saas.q1_reject_report_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action IN ('abuse.report.submitted', 'abuse.report.received') THEN RAISE EXCEPTION 'isolated audit fault'; END IF; RETURN NEW; END $$`);
    await database.db.execute(sql`CREATE TRIGGER q1_reject_report_audit BEFORE INSERT ON canvas_saas.audit_event FOR EACH ROW EXECUTE FUNCTION canvas_saas.q1_reject_report_audit()`);
    try {
        await expect(submitAbuseReport(database.db, input, alice)).rejects.toThrow();
        expect(await getOwnAbuseReport(database.db, input.id, alice)).toBeNull();
        await expect(receiveAbuseReport(database.db, existing.id, 1, admin)).rejects.toThrow();
        expect(await getOwnAbuseReport(database.db, existing.id, alice)).toMatchObject({ status: "submitted", revision: 1, receivedAt: null });
    } finally {
        await database.db.execute(sql`DROP TRIGGER q1_reject_report_audit ON canvas_saas.audit_event`);
        await database.db.execute(sql`DROP FUNCTION canvas_saas.q1_reject_report_audit()`);
    }
});

test("status filters and microsecond cursors page without skipping or repeating a report", async () => {
    const inputs = [report(), report(), report()];
    for (let i = 0; i < inputs.length; i++) {
        await submitAbuseReport(database.db, inputs[i], alice);
        await database.db.execute(sql`UPDATE canvas_saas.abuse_report SET created_at = ${`2099-01-01T00:00:00.00000${i + 1}Z`}::timestamptz WHERE id = ${inputs[i].id}::uuid`);
    }
    let cursor: string | undefined; const found: string[] = [];
    for (let i = 0; i < 3; i++) {
        const page = await listAbuseReports(database.db, { status: "submitted", cursor }, admin, 1);
        found.push(page.items[0].id); cursor = page.nextCursor ?? undefined;
    }
    expect(found).toEqual(inputs.map(row => row.id).reverse());
    await expect(listAbuseReports(database.db, { cursor: "broken" }, admin, 1)).rejects.toMatchObject({ code: "report_invalid" });
});
