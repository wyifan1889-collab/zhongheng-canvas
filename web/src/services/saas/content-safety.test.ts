import { expect, test } from "bun:test";
import { createContentSafetyClient, type AbuseReportView, type ContentSafetyScope } from "./content-safety";

const scope: ContentSafetyScope = { accountId: "safety-owner", epoch: 7, role: "user" };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", otherId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const report: AbuseReportView = { id, subject: "投诉主题", details: "情况说明", status: "submitted", revision: 1, createdAt: "2026-10-28T01:00:00.000Z", receivedAt: null };
const input = { id, subject: report.subject, details: report.details };
const fetcher = (fn: (path: string, init?: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test("complaints use account-scoped same-origin requests and do not send body identity", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createContentSafetyClient({ scope, getScope: () => scope, fetcher: fetcher(async (path, init) => { calls.push({ path, init }); return Response.json({ item: report }); }) });
    expect(await client.submitReport(input)).toEqual(report);
    expect(calls).toHaveLength(1); expect(calls[0].path).toBe("/api/v1/abuse-reports");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual(input);
    expect(new Headers(calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    await expect(client.submitReport({ ...input, reporterId: "other" } as typeof input)).rejects.toMatchObject({ outcome: "not-sent" });
    expect(calls).toHaveLength(1);
});

test("unknown complaint submission is never resent and only the original owner GET reconciles it", async () => {
    const calls: string[] = [];
    const client = createContentSafetyClient({ scope, getScope: () => scope, fetcher: fetcher(async (path, init) => { calls.push(`${init?.method} ${path}`); if (init?.method === "POST") throw new Error("private network detail"); return Response.json({ item: report }); }) });
    await expect(client.submitReport(input)).rejects.toMatchObject({ code: "result_unknown", outcome: "unknown" });
    await expect(client.submitReport(input)).rejects.toMatchObject({ code: "result_unknown" });
    expect(calls).toEqual(["POST /api/v1/abuse-reports"]);
    expect(await client.readOwnReport(id)).toEqual(report);
    expect(calls).toEqual(["POST /api/v1/abuse-reports", `GET /api/v1/abuse-reports/${id}`]);
});

for (const stage of ["fetch", "json"] as const) test(`account or epoch changes drop late complaint ${stage} and permanently invalidate the old client`, async () => {
    const gate = deferred<Response>(), body = deferred<unknown>(), started = deferred<void>(); let current: ContentSafetyScope | null = { ...scope }, calls = 0;
    const response = Response.json({ item: report }); response.json = () => { started.resolve(); return body.promise; };
    const client = createContentSafetyClient({ scope, getScope: () => current, fetcher: fetcher(async () => { calls++; return gate.promise; }) });
    const reading = client.readOwnReport(id);
    if (stage === "json") { gate.resolve(response); await started.promise; }
    current = { ...scope, epoch: scope.epoch + 1 };
    if (stage === "fetch") gate.resolve(response); else body.resolve({ item: report });
    await expect(reading).rejects.toMatchObject({ code: "context_changed" });
    current = scope; await expect(client.readOwnReport(id)).rejects.toMatchObject({ code: "context_changed" }); expect(calls).toBe(1);
});

test("ordinary users cannot call any administrator endpoint even if the interface is invoked directly", async () => {
    let calls = 0; const client = createContentSafetyClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return Response.json({}); }) });
    for (const action of [() => client.readModeration("target"), () => client.setModeration("target", { operationId: id, disabled: true, expectedVersion: 0, reason: "人工核对" }),
        () => client.readModerationOperation(id), () => client.listReports(), () => client.receiveReport(id, 1), () => client.readAdminReport(id)]) await expect(action()).rejects.toMatchObject({ code: "forbidden", outcome: "not-sent" });
    expect(calls).toBe(0);
});

test("closed features are definite rejections while malformed or unrelated server errors remain unknown", async () => {
    for (const [status, code, outcome] of [[503, "abuse_reports_unavailable", "rejected"], [503, "private_db_detail", "unknown"], [409, "report_conflict", "rejected"], [404, "report_not_found", "rejected"]] as const) {
        const client = createContentSafetyClient({ scope, getScope: () => scope, fetcher: fetcher(async () => Response.json({ error: { code, message: "private text" } }, { status })) });
        await expect(client.submitReport(input)).rejects.toMatchObject({ outcome });
        try { await client.submitReport(input); } catch (failure) { expect((failure as Error).message).not.toContain("private text"); }
    }
    const client = createContentSafetyClient({ scope, getScope: () => scope, fetcher: fetcher(async () => Response.json({ item: { ...report, id: otherId } })) });
    await expect(client.submitReport(input)).rejects.toMatchObject({ code: "result_unknown" });
});

test("admin moderation receipt must match the exact target, operation, action and next version", async () => {
    const admin = { ...scope, role: "admin" as const }, write = { operationId: id, disabled: true, expectedVersion: 0, reason: "人工核对" };
    for (const patch of [{ targetUserId: "other" }, { operationId: otherId }, { disabled: false }, { revision: 0 }, { revision: 2 }]) {
        let calls = 0;
        const client = createContentSafetyClient({ scope: admin, getScope: () => admin, fetcher: fetcher(async () => { calls++; return Response.json({ item: { operationId: id, targetUserId: "target", disabled: true, revision: 1, createdAt: report.createdAt, ...patch } }); }) });
        await expect(client.setModeration("target", write)).rejects.toMatchObject({ code: "result_unknown" });
        await expect(client.setModeration("target", write)).rejects.toMatchObject({ code: "result_unknown" }); expect(calls).toBe(1);
    }
});

test("unknown receipt is read by its original admin ID without repeating acceptance", async () => {
    const admin = { ...scope, role: "admin" as const }, calls: string[] = [];
    const client = createContentSafetyClient({ scope: admin, getScope: () => admin, fetcher: fetcher(async (path, init) => { calls.push(`${init?.method} ${path}`);
        if (init?.method === "PUT") return new Response("gateway unavailable", { status: 502 });
        return Response.json({ item: { ...report, status: "received", revision: 2, receivedAt: report.createdAt } }); }) });
    await expect(client.receiveReport(id, 1)).rejects.toMatchObject({ outcome: "unknown" });
    await expect(client.receiveReport(id, 1)).rejects.toMatchObject({ outcome: "unknown" });
    expect((await client.readAdminReport(id)).status).toBe("received");
    expect(calls).toEqual([`PUT /api/v1/admin/abuse-reports/${id}/receipt`, `GET /api/v1/admin/abuse-reports/${id}`]);
});

test("an expired session requests one account recheck while a late reply after switching accounts does not", async () => {
    let calls = 0, invalidations = 0;
    const client = createContentSafetyClient({ scope, getScope: () => scope, onAccountInvalidated: () => { invalidations++; }, fetcher: fetcher(async () => { calls++; return Response.json({ error: { code: "unauthorized" } }, { status: 401 }); }) });
    await expect(client.readOwnReport(id)).rejects.toMatchObject({ code: "context_changed" });
    await expect(client.readOwnReport(id)).rejects.toMatchObject({ code: "context_changed" });
    expect(invalidations).toBe(1); expect(calls).toBe(1);
    const gate = deferred<Response>(); let current: ContentSafetyScope | null = { ...scope };
    const old = createContentSafetyClient({ scope, getScope: () => current, onAccountInvalidated: () => { invalidations++; }, fetcher: fetcher(async () => gate.promise) });
    const reading = old.readOwnReport(id); current = { ...scope, accountId: "new-owner" }; gate.resolve(Response.json({ error: { code: "unauthorized" } }, { status: 401 }));
    await expect(reading).rejects.toMatchObject({ code: "context_changed" }); expect(invalidations).toBe(1);
});
