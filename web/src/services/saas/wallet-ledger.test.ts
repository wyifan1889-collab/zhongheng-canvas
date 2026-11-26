import { expect, test } from "bun:test";
import { createWalletLedgerClient, type WalletLedgerItem } from "./wallet-ledger";
import type { DraftAccountScope } from "./drafts";

const scope: DraftAccountScope = { accountId: "ledger-owner", epoch: 7 };
const id = (value = 1) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, "0")}`;
const item = (kind: WalletLedgerItem["kind"] = "reserve"): WalletLedgerItem => ({ id: id(), kind,
    deltaAvailableUnits: "-0.12345678901234567890123456789", deltaReservedUnits: "0.12345678901234567890123456789",
    availableUnitsAfter: "9007199254740993.000001", reservedUnitsAfter: "0.12345678901234567890123456789",
    referenceType: "generation", referenceId: id(2), createdAt: "2026-10-28T01:00:00.000Z" });
const fetcher = (fn: (path: string, init?: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const withData = (data: unknown) => createWalletLedgerClient({ scope, getScope: () => scope, fetcher: fetcher(async () => Response.json(data)) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test("ledger uses the existing default latest-50 owner GET and no mutation or background retry", async () => {
    const calls: { path: string; init?: RequestInit }[] = [], abort = new AbortController();
    const client = createWalletLedgerClient({ scope, getScope: () => scope, fetcher: fetcher(async (path, init) => { calls.push({ path, init }); return Response.json({ items: [item()] }); }) });
    expect(await client.read(abort.signal)).toEqual([item()]);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/v1/wallet/ledger");
    expect(calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: abort.signal });
    expect(calls[0].init?.body).toBeUndefined();
    expect(Object.fromEntries(new Headers(calls[0].init?.headers))).toEqual({ accept: "application/json", "x-canvas-account-id": scope.accountId });
});

test("ledger keeps all real entry types and exact signed decimal strings, including nullable references and empty history", async () => {
    for (const kind of ["grant", "recharge", "adjustment", "reserve", "capture", "release", "refund", "consume"] as const) {
        const row = { ...item(kind), referenceType: null, referenceId: null };
        expect(await withData({ items: [row], requestId: "read-1" }).read()).toEqual([row]);
    }
    expect(await withData({ items: [] }).read()).toEqual([]);
});

test("ledger rejects malformed precision, balances, dates, unknown entry types and duplicate identities", async () => {
    for (const value of [0, 1, "-0", "1.0", "01", "1e-6", " 1", "NaN", "Infinity", null]) {
        await expect(withData({ items: [{ ...item(), deltaAvailableUnits: value }] }).read()).rejects.toMatchObject({ code: "read_failed" });
    }
    for (const patch of [{ availableUnitsAfter: "-1" }, { reservedUnitsAfter: 0 }, { kind: "withdraw" }, { createdAt: "2026-02-30T00:00:00Z" }, { id: "other" }, { ownerId: "private" }]) {
        await expect(withData({ items: [{ ...item(), ...patch }] }).read()).rejects.toMatchObject({ code: "read_failed" });
    }
    for (const data of [null, {}, { items: [item(), item()] }, { items: Array.from({ length: 51 }, (_, n) => ({ ...item(), id: id(n + 1) })) }]) {
        await expect(withData(data).read()).rejects.toMatchObject({ code: "read_failed" });
    }
});

for (const stage of ["fetch", "json"] as const) for (const change of ["account", "epoch", "logout"] as const) {
    test(`ledger drops late ${stage} after ${change} and never revives that client`, async () => {
        let current: DraftAccountScope | null = { ...scope }, calls = 0;
        const responseGate = deferred<Response>(), jsonGate = deferred<unknown>(), jsonStarted = deferred<void>();
        const response = Response.json({ items: [item()] }); response.json = () => { jsonStarted.resolve(); return jsonGate.promise; };
        const client = createWalletLedgerClient({ scope, getScope: () => current, fetcher: fetcher(async () => { calls++; return responseGate.promise; }) });
        const reading = client.read();
        if (stage === "json") { responseGate.resolve(response); await jsonStarted.promise; }
        current = change === "logout" ? null : { ...scope, ...(change === "account" ? { accountId: "other" } : { epoch: 8 }) };
        if (stage === "fetch") responseGate.resolve(response); else jsonGate.resolve({ items: [item()] });
        await expect(reading).rejects.toMatchObject({ code: "context_changed" });
        current = scope;
        await expect(client.read()).rejects.toMatchObject({ code: "context_changed" });
        expect(calls).toBe(1);
    });
}

test("ledger 401 and exact account-context errors stop reads; unrelated outages stay retryable without exposing server detail", async () => {
    for (const [status, code, terminal] of [[401, "anything", true], [400, "account_context_required", true], [409, "account_changed", true], [503, "account_changed", false], [500, "private_server_detail", false]] as const) {
        let calls = 0;
        const client = createWalletLedgerClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return Response.json({ error: { code, message: "private secret" } }, { status }); }) });
        await expect(client.read()).rejects.toMatchObject({ code: status === 401 ? "unauthorized" : terminal ? "context_changed" : "read_failed" });
        await expect(client.read()).rejects.toMatchObject({ code: terminal ? "context_changed" : "read_failed" });
        expect(calls).toBe(terminal ? 1 : 2);
    }
});

test("ledger cancellation is honored before transport and after an ignored cancellation", async () => {
    const abort = new AbortController(), gate = deferred<Response>(); let calls = 0;
    const client = createWalletLedgerClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return gate.promise; }) });
    const reading = client.read(abort.signal); abort.abort(); gate.resolve(Response.json({ items: [item()] }));
    await expect(reading).rejects.toMatchObject({ code: "aborted" });
    await expect(client.read(abort.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toBe(1);
});
