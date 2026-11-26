import { expect, test } from "bun:test";
import { createGenerationTrackingClient, GenerationTrackingError, type GenerationTrackingItem, type GenerationTrackingScope } from "./generation";

const scope: GenerationTrackingScope = { accountId: "synthetic-tracking-account", epoch: 3 };
const id = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
const item = (taskId = id(1)): GenerationTrackingItem => ({ taskId, projectId: "original-canvas", nodeId: null, modelId: "synthetic-text",
    executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", updatedAt: "2026-10-26T00:00:00.000Z" });
const result = <T = GenerationTrackingItem>(items?: T[], missingTaskIds: string[] = []) => ({ items: items ?? [item()], missingTaskIds, requestId: "synthetic-request" });
const fetcher = (run: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
    Object.assign((input: RequestInfo | URL, init?: RequestInit) => run(String(input), init), { preconnect: fetch.preconnect });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const clientFor = (data: unknown) => createGenerationTrackingClient({ scope, getScope: () => scope, fetcher: fetcher(async () => Response.json(data)) });

test("T4 tracking client admits fifty UUIDs, normalizes before sending, and uses the account read transport", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => id(index));
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createGenerationTrackingClient({ scope, getScope: () => ({ ...scope }), fetcher: fetcher(async (path, init) => {
        calls.push({ path, init }); return Response.json(result(ids.map(taskId => item(taskId))));
    }) });
    expect((await client.read(ids.map(taskId => taskId.toUpperCase()))).items.map(value => value.taskId)).toEqual(ids);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/v1/generation/tasks/batch");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ taskIds: ids });
    expect(Object.fromEntries(new Headers(calls[0].init?.headers))).toEqual({ accept: "application/json", "content-type": "application/json", "x-canvas-account-id": scope.accountId });
});

test("T4 invalid raw batches including fifty-one duplicate UUIDs never fetch, while empty reads remain local", async () => {
    let calls = 0;
    const client = createGenerationTrackingClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return Response.json(result()); }) });
    for (const value of [null, {}, "uuid", [1], Array(1), ["provider-job"], ["aaaaaaaa-aaaa-0aaa-0aaa-000000000001"], Array(51).fill(id(1))]) {
        await expect(client.read(value as readonly string[])).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    }
    expect(await client.read([])).toEqual({ items: [], missingTaskIds: [], requestId: "" });
    expect(calls).toBe(0);
});

test("T4 tracking response is a complete canonical whitelist partition, independent of payload result fields", async () => {
    let sent: unknown;
    const client = createGenerationTrackingClient({ scope, getScope: () => scope, fetcher: fetcher(async (_path, init) => {
        sent = JSON.parse(init!.body as string);
        return Response.json({ ...result([{ ...item(id(2)), ownerId: "private-owner", result: "private-result", quotedUnits: 900 },
            { ...item(id(1).toUpperCase()), provider: "private-provider", modelDisplayName: "private-name" }], [id(3).toUpperCase()]), token: "private-token" });
    }) });
    const response = await client.read([id(1).toUpperCase(), id(2), id(3), id(1)]);
    expect(sent).toEqual({ taskIds: [id(1), id(2), id(3)] });
    expect(response).toEqual(result([item(id(1)), item(id(2))], [id(3)]));
    expect(JSON.stringify(response)).not.toContain("private");
    expect(JSON.stringify(response)).not.toContain("quotedUnits");
});

test("T4 tracking DTO rejects malformed dates, states, identities and incomplete or overlapping membership", async () => {
    const bad: unknown[] = [null, { ...result(), items: null }, { ...result(), missingTaskIds: null }, { ...result(), requestId: " " },
        result([], []), result([item(id(2))]), result([item(), item()]), result([item(), item(id(1).toUpperCase())]), result([item()], [id(1)]),
        result([], [id(1), id(1)]), result([], [id(1), id(2)]), result([{ ...item(), taskId: "provider-job" }])];
    for (const patch of [{ projectId: undefined }, { nodeId: 3 }, { modelId: "" }, { executionStatus: "complete" }, { deliveryStatus: "delivered" },
        { billingStatus: "refunded" }, { updatedAt: "2026-02-30T00:00:00Z" }, { updatedAt: "yesterday" }, { updatedAt: "2026-10-26" }]) bad.push(result([{ ...item(), ...patch }]));
    for (const data of bad) await expect(clientFor(data).read([id(1)])).rejects.toMatchObject({ code: "read_unconfirmed", status: 200 });
    expect((await clientFor(result([{ ...item(), projectId: null, nodeId: "original-node", updatedAt: "2026-10-26T08:00:00+08:00" }])).read([id(1)])).items[0])
        .toMatchObject({ projectId: null, nodeId: "original-node", updatedAt: "2026-10-26T08:00:00+08:00" });
});

for (const stage of ["fetch", "json"] as const) for (const change of ["account", "epoch"] as const) {
    test(`T4 ${stage} completion cannot revive the prior ${change} scope`, async () => {
        let current = { ...scope }, calls = 0;
        const started = deferred<void>(), responseReady = deferred<Response>(), bodyReady = deferred<unknown>();
        const response = Response.json(result());
        response.json = () => { started.resolve(); return bodyReady.promise; };
        const client = createGenerationTrackingClient({ scope, getScope: () => current, fetcher: fetcher(async () => {
            calls++;
            if (stage === "fetch") { started.resolve(); return responseReady.promise; }
            return response;
        }) });
        const pending = client.read([id(1)]).catch((error: unknown) => error);
        await started.promise;
        current = { ...scope, ...(change === "account" ? { accountId: "other-account" } : { epoch: scope.epoch + 1 }) };
        if (stage === "fetch") responseReady.resolve(Response.json(result())); else bodyReady.resolve(result());
        expect(await pending).toMatchObject({ code: "context_changed" });
        current = { ...scope };
        await expect(client.read([id(1)])).rejects.toMatchObject({ code: "context_changed" });
        expect(calls).toBe(1);
    });
}

test("T4 account-only reads survive same-account project navigation without relaxing original project clients", async () => {
    let current = { ...scope, projectId: "first-canvas" }, calls = 0;
    const client = createGenerationTrackingClient({ scope: current, getScope: () => current, fetcher: fetcher(async () => { calls++; return Response.json(result()); }) });
    await client.read([id(1)]);
    current = { ...current, projectId: "second-canvas" };
    expect((await client.read([id(1)])).items[0].projectId).toBe("original-canvas");
    expect(calls).toBe(2);
});

test("T4 aborted reads are isolated before transport and after ignored fetch or JSON cancellation", async () => {
    const before = new AbortController(); before.abort();
    let calls = 0;
    const client = createGenerationTrackingClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return Response.json(result()); }) });
    await expect(client.read([id(1)], before.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toBe(0);
    for (const stage of ["fetch", "json"] as const) {
        const controller = new AbortController(), started = deferred<void>(), responseReady = deferred<Response>(), bodyReady = deferred<unknown>();
        let actualSignal: AbortSignal | null | undefined;
        const response = Response.json(result()); response.json = () => { started.resolve(); return bodyReady.promise; };
        const late = createGenerationTrackingClient({ scope, getScope: () => scope, fetcher: fetcher(async (_path, init) => {
            actualSignal = init?.signal;
            if (stage === "fetch") { started.resolve(); return responseReady.promise; }
            return response;
        }) });
        const pending = late.read([id(1)], controller.signal).catch((error: unknown) => error);
        await started.promise; controller.abort();
        if (stage === "fetch") responseReady.resolve(Response.json(result())); else bodyReady.resolve(result());
        expect(actualSignal).toBe(controller.signal);
        expect(await pending).toMatchObject({ code: "aborted" });
    }
    expect((await client.read([id(1)])).items).toEqual([item()]);
});

test("T4 authentication and account errors permanently stop this client without leaking server detail", async () => {
    for (const [status, code] of [[401, "unauthorized"], [400, "account_context_required"], [409, "account_changed"]] as const) {
        let calls = 0;
        const client = createGenerationTrackingClient({ scope, getScope: () => scope, fetcher: fetcher(async () => {
            calls++; return status === 401 ? new Response("private unauthorized HTML", { status }) : Response.json({ error: { code, message: "private-detail" } }, { status });
        }) });
        const error = await client.read([id(1)]).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(GenerationTrackingError);
        expect(error).toMatchObject({ code, status });
        expect(String(error)).not.toContain("private");
        await expect(client.read([id(1)])).rejects.toMatchObject({ code: "context_changed" });
        expect(calls).toBe(1);
    }
});

test("T4 429 preserves Retry-After seconds or HTTP date and performs no retry itself", async () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    for (const [header, delay] of [["7", 7000], ["Mon, 26 Oct 2026 00:00:10 GMT", 10000], ["Mon, 26 Oct 2026 00:00:00 GMT", 0], ["not-a-date", undefined]] as const) {
        let calls = 0;
        const client = createGenerationTrackingClient({ scope, getScope: () => scope, now: () => now, fetcher: fetcher(async () => {
            calls++; return new Response("private proxy HTML", { status: 429, headers: { "Retry-After": header } });
        }) });
        expect(await client.read([id(1)]).catch((error: unknown) => error)).toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: delay });
        expect(calls).toBe(1);
    }
});

test("T4 transport, 5xx and malformed JSON stay read-unconfirmed and never retry or return fake missing tasks", async () => {
    for (const respond of [async () => { throw new Error("private-network"); }, async () => Response.json({ error: { code: "internal", message: "private-error" } }, { status: 503 }),
        async () => new Response("private-invalid-json", { status: 200 })]) {
        let calls = 0;
        const client = createGenerationTrackingClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return respond(); }) });
        const error = await client.read([id(1)]).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(GenerationTrackingError);
        expect(error).toMatchObject({ code: "read_unconfirmed" });
        expect(String(error)).not.toContain("private");
        expect(calls).toBe(1);
    }
});
