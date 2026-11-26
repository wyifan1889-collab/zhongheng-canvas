import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { assertSafetyActor, type SafetyActor, type SafetyTx } from "./account-moderation";

export type AbuseReportWrite = { id: string; subject: string; details: string };
export type AbuseReportView = AbuseReportWrite & { status: "submitted" | "received"; revision: number; createdAt: string; receivedAt: string | null };
export type AbuseReportPage = { items: AbuseReportView[]; nextCursor: string | null };
type ReportRow = AbuseReportView & { reporterId: string };
type Cursor = { createdAt: string; id: string };
export class AbuseReportError extends Error {
    constructor(readonly code: "report_invalid" | "report_conflict" | "report_not_found", message: string) { super(message); }
}
const invalid = () => new AbuseReportError("report_invalid", "请核对投诉内容与当前版本");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projection = sql`id, reporter_id AS "reporterId", subject, details, status, revision,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
    CASE WHEN received_at IS NULL THEN NULL ELSE to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "receivedAt"`;
const view = ({ reporterId: _reporterId, ...row }: ReportRow): AbuseReportView => row;
async function read(tx: SafetyTx, id: string, ownerId?: string, lock = false) {
    const result = await tx.execute(sql`SELECT ${projection} FROM canvas_saas.abuse_report WHERE id = ${id}::uuid
        ${ownerId ? sql`AND reporter_id = ${ownerId}` : sql``} ${lock ? sql`FOR UPDATE` : sql``}`);
    return (result as unknown as { rows: ReportRow[] }).rows[0];
}
async function audit(tx: SafetyTx, actor: SafetyActor, id: string, revision: number, action: "abuse.report.submitted" | "abuse.report.received") {
    await tx.execute(sql`INSERT INTO canvas_saas.audit_event (id, actor_id, action, resource_id, revision, request_id)
        VALUES (${crypto.randomUUID()}, ${actor.actorId}, ${action}, ${id}, ${revision}, ${actor.requestId})`);
}

/** Input is user text only. Reporter, permissions and session authority are server-owned. */
export async function submitAbuseReport(db: Database, input: AbuseReportWrite, actor: SafetyActor): Promise<AbuseReportView> {
    if (!uuid.test(input.id) || !input.subject?.trim() || !input.details?.trim()) throw invalid();
    return db.transaction(async tx => {
        await assertSafetyActor(tx, actor, false);
        const inserted = await tx.execute(sql`INSERT INTO canvas_saas.abuse_report (id, reporter_id, subject, details)
            VALUES (${input.id}::uuid, ${actor.actorId}, ${input.subject}, ${input.details}) ON CONFLICT (id) DO NOTHING RETURNING id`);
        const created = (inserted as unknown as { rows: unknown[] }).rows.length > 0;
        const row = await read(tx, input.id, actor.actorId);
        if (!row || row.subject !== input.subject || row.details !== input.details) {
            throw new AbuseReportError("report_conflict", "提交编号已使用，请先核对原投诉回执");
        }
        if (created) await audit(tx, actor, input.id, row.revision, "abuse.report.submitted");
        return view(row);
    });
}

export async function getOwnAbuseReport(db: Database, id: string, actor: SafetyActor): Promise<AbuseReportView | null> {
    if (!uuid.test(id)) throw invalid();
    return db.transaction(async tx => {
        await assertSafetyActor(tx, actor, false);
        const row = await read(tx, id, actor.actorId);
        return row ? view(row) : null;
    });
}

export async function getAdminAbuseReport(db: Database, id: string, actor: SafetyActor): Promise<AbuseReportView | null> {
    if (!uuid.test(id)) throw invalid();
    return db.transaction(async tx => {
        await assertSafetyActor(tx, actor, true);
        const row = await read(tx, id);
        return row ? view(row) : null;
    });
}

function parseCursor(cursor?: string): Cursor | undefined {
    if (!cursor) return;
    try {
        if (!/^[\w-]+$/.test(cursor)) throw invalid();
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!value || Object.keys(value).sort().join(",") !== "createdAt,id" || !uuid.test(value.id) ||
            typeof value.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) throw invalid();
        return value;
    } catch { throw invalid(); }
}

export async function listAbuseReports(db: Database, input: { cursor?: string; status?: "submitted" | "received" }, actor: SafetyActor, pageSize: number): Promise<AbuseReportPage> {
    const before = parseCursor(input.cursor);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || input.status && !["submitted", "received"].includes(input.status)) throw invalid();
    return db.transaction(async tx => {
        await assertSafetyActor(tx, actor, true);
        const result = await tx.execute(sql`SELECT ${projection} FROM canvas_saas.abuse_report WHERE true
            ${input.status ? sql`AND status = ${input.status}` : sql``}
            ${before ? sql`AND (created_at, id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)` : sql``}
            ORDER BY created_at DESC, id DESC LIMIT ${pageSize + 1}`);
        const rows = (result as unknown as { rows: ReportRow[] }).rows;
        const items = rows.slice(0, pageSize).map(view), last = items.at(-1);
        return { items, nextCursor: rows.length > pageSize && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
    });
}

/** Receipt of a report is an administrative record, not a moderation decision. */
export async function receiveAbuseReport(db: Database, id: string, expectedVersion: number, actor: SafetyActor): Promise<AbuseReportView> {
    if (!uuid.test(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw invalid();
    return db.transaction(async tx => {
        await assertSafetyActor(tx, actor, true);
        const row = await read(tx, id, undefined, true);
        if (!row) throw new AbuseReportError("report_not_found", "投诉回执不存在");
        if (row.revision !== expectedVersion) throw new AbuseReportError("report_conflict", "投诉状态已变化，请先读取原回执");
        if (row.status === "received") return view(row);
        if (row.revision >= 2_147_483_647) throw new AbuseReportError("report_conflict", "投诉状态暂不可更新");
        await tx.execute(sql`UPDATE canvas_saas.abuse_report SET status = 'received', revision = revision + 1,
            received_by = ${actor.actorId}, received_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ${id}::uuid`);
        const received = await read(tx, id);
        await audit(tx, actor, id, received!.revision, "abuse.report.received");
        return view(received!);
    });
}
