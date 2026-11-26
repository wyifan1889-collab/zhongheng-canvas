import { expect, test } from "bun:test";
import { GenerationError, type GenerationTrackingScope } from "./generation";
import { createGenerationHistoryClient, type GenerationHistoryItem, type GenerationHistoryQuery } from "./generation-history";

const scope: GenerationTrackingScope = { accountId: "account-history", epoch: 3 };
const id = (value = 1) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, "0")}`;
const item = (value = 1): GenerationHistoryItem => ({ taskId: id(value), type: "image", displayModel: "original-model-id", executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", credits: "0.12345678901234567890123456789", createdAt: "2026-10-26T08:00:00+08:00", updatedAt: "2026-10-26T00:01:00Z", result: { url: `/api/v1/media/${id(value)}` } });
const page = <T = GenerationHistoryItem>(items?: T[], patch: object = {}) => {
    const rows = items ?? [item()];
    return { items: rows, total: rows.length, pageNumber: 1, pageSize: 50, requestId: "history-read-request", ...patch };
};
const fetcher = (fn: (path: string, init?: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const clientFor = (data: unknown) => createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async () => Response.json(data)) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("T9 exact GET uses fixed pageSize50 and only specified filters, Cookie/account header and AbortSignal", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [], abort = new AbortController();
    const client = createGenerationHistoryClient({ scope, getScope: () => ({ ...scope }), fetcher: fetcher(async (path, init) => {
        calls.push({ path, init }); return Response.json(page([item()], { pageNumber: 2, total: 51 }));
    }) });
    expect(await client.read({ pageNumber: 2, pageSize: 50, type: "image", status: "succeeded" }, abort.signal)).toEqual(page([item()], { pageNumber: 2, total: 51 }));
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/v1/generation/logs?pageNumber=2&pageSize=50&type=image&status=succeeded");
    expect(calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: abort.signal });
    expect(calls[0].init?.body).toBeUndefined();
    expect(Object.fromEntries(new Headers(calls[0].init?.headers))).toEqual({ accept: "application/json", "x-canvas-account-id": scope.accountId });
});

test("T9 defaults omit all-filter parameters; beyond-last-page empty items retain positive total", async () => {
    let path = "";
    const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async value => { path = value; return Response.json(page([])); }) });
    expect(await client.read()).toEqual(page([]));
    expect(path).toBe("/api/v1/generation/logs?pageNumber=1&pageSize=50");
    expect(await clientFor(page([], { pageNumber: 3, total: 51 })).read({ pageNumber: 3 })).toEqual(page([], { pageNumber: 3, total: 51 }));
});

test("T9 query rejects unsupported states, extra keys, raw strings and unsafe offsets before fetching", async () => {
    let calls = 0;
    const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return Response.json(page()); }) });
    for (const query of [null, [], "pageNumber=1", { pageNumber: 0 }, { pageNumber: -1 }, { pageNumber: 1.5 }, { pageNumber: "1" }, { pageNumber: Number.MAX_SAFE_INTEGER }, { pageNumber: Infinity }, { pageSize: 20 }, { pageSize: 51 }, { pageSize: "50" }, { type: "all" }, { type: null }, { status: "unknown" }, { status: "cancelled" }, { status: "timeout" }, { status: "" }, { cursor: "next" }, { ownerId: "other" }]) {
        await expect(client.read(query as GenerationHistoryQuery)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent", status: 400 });
    }
    expect(calls).toBe(0);
});

test("T9 preserves all eight original execution states and four types/null without forcing charges or results", async () => {
    const statuses = ["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"] as const;
    const rows = statuses.map((executionStatus, index) => ({ ...item(index + 1), executionStatus, type: (["text", "image", "audio", "video", null] as const)[index % 5], result: null, credits: index === 0 ? "0" : null }));
    expect((await clientFor(page(rows)).read()).items).toEqual(rows);
    for (const status of ["succeeded", "failed", "running", "queued", "pending"] as const) {
        expect((await clientFor(page([{ ...item(), executionStatus: status, result: null }])).read({ status })).items[0].executionStatus).toBe(status);
    }
});

test("T9 strict response rejects malformed DTOs, duplicate IDs, invalid dates and pagination mismatch", async () => {
    const invalid: unknown[] = [null, {}, page([], { total: -1 }), page([], { total: 1.5 }), page([], { total: Number.MAX_SAFE_INTEGER + 1 }), page([], { pageNumber: 2 }), page([], { pageSize: 49 }), page([], { requestId: " " }), page([item(), item()]), page([item(), { ...item(), taskId: id().toUpperCase() }]), page([item()], { total: 0 }), page(Array.from({ length: 51 }, (_, n) => item(n + 1))), page([item()], { providerToken: "private" })];
    for (const patch of [{ taskId: "provider-job" }, { type: "music" }, { displayModel: " " }, { executionStatus: "complete" }, { deliveryStatus: "delivered" }, { billingStatus: "refunded" }, { createdAt: "2026-02-30T00:00:00Z" }, { updatedAt: "today" }, { result: undefined }, { ownerId: "other-private-owner" }]) invalid.push(page([{ ...item(), ...patch }]));
    for (const data of invalid) await expect(clientFor(data).read()).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent", status: 200 });
    await expect(clientFor(page([item()], { total: 50, pageNumber: 2 })).read({ pageNumber: 2 })).rejects.toMatchObject({ code: "unconfirmed" });
});

test("T9 returned items must obey requested filters rather than silently showing another row", async () => {
    await expect(clientFor(page()).read({ type: "audio" })).rejects.toMatchObject({ code: "unconfirmed" });
    await expect(clientFor(page()).read({ status: "running" })).rejects.toMatchObject({ code: "unconfirmed" });
    await expect(clientFor(page([{ ...item(), type: null, result: null }])).read({ type: "image" })).rejects.toMatchObject({ code: "unconfirmed" });
});

test("T9 credits accept only exact nonnegative canonical strings or null, without number coercion", async () => {
    for (const credits of [null, "0", "1", "9007199254740993123456.12345678901234567890123456789"]) {
        expect((await clientFor(page([{ ...item(), credits }])).read()).items[0].credits).toBe(credits);
    }
    for (const credits of [0, 12, 0.1, "-1", "-0", "01", "1.0", " 1", "1e3", "NaN", undefined]) await expect(clientFor(page([{ ...item(), credits }])).read()).rejects.toMatchObject({ code: "unconfirmed" });
});

test("T9 private result paths reject origins, encoded paths, suffixes and nonmedia URLs", async () => {
    const valid = `/api/v1/media/${id()}`;
    for (const url of [`https://same.example${valid}`, `http://127.0.0.1${valid}`, `//host${valid}`, `${valid}?download=1`, `${valid}#preview`, `${valid}/extra`, `${valid}/`, "/api/v1/media/%61aaaaaaa-aaaa-4aaa-8aaa-000000000001", "/api/v1/media/../private", "data:image/png;base64,x", "blob:local", "/api/v1/media/provider-id", "\\api\\v1\\media\\id", "/API/v1/media/" + id()]) {
        await expect(clientFor(page([{ ...item(), result: { url } }])).read()).rejects.toMatchObject({ code: "unconfirmed" });
        await expect(clientFor(page([{ ...item(), result: { url: valid, thumbnailUrl: url } }])).read()).rejects.toMatchObject({ code: "unconfirmed" });
    }
    expect((await clientFor(page([{ ...item(), result: { url: valid, thumbnailUrl: `/api/v1/media/${id(2)}` } }])).read()).items[0].result?.url).toBe(valid);
    for (const patch of [{ type: "text" }, { type: null }, { executionStatus: "running" }, { deliveryStatus: "pending" }]) await expect(clientFor(page([{ ...item(), ...patch }])).read()).rejects.toMatchObject({ code: "unconfirmed" });
});

for (const stage of ["fetch", "json"] as const) for (const change of ["account", "epoch", "logout"] as const) {
    test(`T9 late ${stage} after ${change} change is discarded and invalidates the old client`, async () => {
        let current: GenerationTrackingScope | null = { ...scope }, calls = 0;
        const responseGate = deferred<Response>(), jsonGate = deferred<unknown>(), jsonStarted = deferred<void>();
        const response = Response.json(page()); response.json = () => { jsonStarted.resolve(); return jsonGate.promise; };
        const client = createGenerationHistoryClient({ scope, getScope: () => current, fetcher: fetcher(async () => { calls++; return responseGate.promise; }) });
        const reading = client.read();
        if (stage === "json") { responseGate.resolve(response); await jsonStarted.promise; }
        current = change === "logout" ? null : change === "account" ? { ...scope, accountId: "other" } : { ...scope, epoch: scope.epoch + 1 };
        if (stage === "fetch") responseGate.resolve(Response.json(page())); else jsonGate.resolve(page());
        await expect(reading).rejects.toMatchObject({ code: "context_changed", outcome: "not-sent" });
        current = { ...scope };
        await expect(client.read()).rejects.toMatchObject({ code: "context_changed" });
        expect(calls).toBe(1);
    });
}

test("T9 unauthorized is recognized before JSON parsing and permanently stops that client", async () => {
    let calls = 0;
    const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return new Response("not-json-private", { status: 401 }); }) });
    await expect(client.read()).rejects.toMatchObject({ code: "unauthorized", status: 401, outcome: "not-sent" });
    await expect(client.read()).rejects.toMatchObject({ code: "context_changed" });
    expect(calls).toBe(1);
});

test("T9 context errors invalidate only on their exact known HTTP status and no requests retry", async () => {
    for (const [code, status] of [["account_context_required", 400], ["account_changed", 409]] as const) {
        let calls = 0;
        const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return Response.json({ error: { code, message: "private-detail" } }, { status }); }) });
        await expect(client.read()).rejects.toMatchObject({ code, status });
        await expect(client.read()).rejects.toMatchObject({ code: "context_changed" });
        expect(calls).toBe(1);
    }
});

test("T9 known unavailable stays distinct from generic HTTP failure and never shows raw server errors", async () => {
    for (const [status, code, expected] of [[503, "generation_unavailable", "generation_unavailable"], [503, "private_backend_error", "unconfirmed"], [400, "generation_unavailable", "unconfirmed"], [429, "rate_limited", "rate_limited"], [403, "forbidden", "forbidden"], [403, "invalid_origin", "invalid_origin"]] as const) {
        let calls = 0;
        const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return Response.json({ error: { code, message: "private-secret-provider" } }, { status }); }) });
        let failure: unknown; try { await client.read(); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(GenerationError);
        expect(failure).toMatchObject({ code: expected, status, outcome: "not-sent" });
        expect(String(failure)).not.toContain("private-secret-provider");
        expect(calls).toBe(1);
    }
});

test("T9 aborted reads and network failures never poll or start media requests", async () => {
    let calls = 0;
    const abort = new AbortController(), gate = deferred<Response>();
    const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return gate.promise; }) });
    const reading = client.read({}, abort.signal); abort.abort(); gate.resolve(Response.json(page()));
    await expect(reading).rejects.toMatchObject({ code: "aborted" });
    await expect(client.read({}, abort.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toBe(1);
    const broken = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { throw Error("private-network-detail"); }) });
    await expect(broken.read()).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
});
