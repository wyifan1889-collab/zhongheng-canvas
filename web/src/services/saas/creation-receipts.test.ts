import { expect, test } from "bun:test";
import { createReceiptedDraftClient } from "./creation-receipts";
import { DraftError } from "./drafts";
import type { CreationReceipt } from "./creation-receipt-store";
import type { DraftAccountScope, DraftInput } from "./drafts";

const scope = () => ({ accountId: "receipt-account-A", epoch: 1 });
const input = (): DraftInput => ({ title: "合成作品", documentVersion: 1, document: { id: "local-A", nodes: [{ content: "不可放进回执的正文" }], extension: { keep: true } } });
const missing = () => Response.json({ error: { code: "not_found" } }, { status: 404 });
const saved = (id: string, document = input().document) => ({ ...input(), document, id, revision: 1, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" });
function memory() {
    const rows = new Map<string, CreationReceipt>();
    return {
        rows,
        async put(value: CreationReceipt) { rows.set(JSON.stringify(value), structuredClone(value)); },
        async list(accountId: string, localProjectId: string) { return [...rows.values()].filter((row) => row.accountId === accountId && row.localProjectId === localProjectId).map((row) => structuredClone(row)); },
    };
}
function claimedMemory() {
    const backing = memory(), owners = new Map<string, string>();
    return {
        ...backing,
        async claim(row: CreationReceipt) {
            const scopeKey = `${row.accountId}\u0000${row.localProjectId}`, owner = owners.get(scopeKey);
            if (owner && owner !== row.creationId) return "busy" as const;
            owners.set(scopeKey, row.creationId);
            await backing.put(row);
            return owner ? "existing" as const : "claimed" as const;
        },
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("preparation is I/O-free; a receipt commits before POST and never contains the snapshot", async () => {
    const backing = memory(), committed = deferred<void>();
    const events: string[] = [];
    const receipts = { ...backing, async put(row: CreationReceipt) { events.push("write-start"); await committed.promise; await backing.put(row); events.push("committed"); } };
    const client = createReceiptedDraftClient(scope, receipts, (async (_path, options) => {
        events.push("POST");
        const body = JSON.parse(String(options?.body));
        expect([...backing.rows.values()]).toEqual([{ accountId: scope().accountId, localProjectId: "local-A", creationId: body.creationId }]);
        return Response.json({ draft: saved(body.creationId, body.document) });
    }) as typeof fetch);
    const value = input(), intent = client.prepareCreate("local-A", value);
    expect(events).toEqual([]);
    const pending = intent.submit();
    expect(events).toEqual(["write-start"]);
    value.document.nodes = [];
    committed.resolve();
    expect((await pending).document.nodes).toEqual(input().document.nodes);
    expect(events).toEqual(["write-start", "committed", "POST"]);
    expect(JSON.stringify([...backing.rows.values()])).not.toContain("正文");
});

test("write failure prevents every network request, including when storage may already have committed", async () => {
    for (const didCommit of [false, true]) {
        const backing = memory(); let calls = 0;
        const receipts = { ...backing, async put(row: CreationReceipt) { if (didCommit) await backing.put(row); throw new Error("private-storage-details"); } };
        const intent = createReceiptedDraftClient(scope, receipts, (async () => { calls++; return missing(); }) as typeof fetch).prepareCreate("local-A", input());
        const error = await intent.submit().catch((value) => value);
        expect(error).toMatchObject({ code: "receipt_unavailable", outcome: "not-sent", creationId: intent.id });
        expect(String(error)).not.toContain("private-storage-details");
        expect(calls).toBe(0);
        expect(backing.rows.size).toBe(didCommit ? 1 : 0);
    }
});

test("claim failure prevents the receipt fallback and every network request", async () => {
    const base = memory(); let calls = 0, putCalls = 0;
    const receipts = {
        ...base,
        async claim() { throw new Error("private-claim-details"); },
        async put(row: CreationReceipt) { putCalls++; await base.put(row); },
    };
    const intent = createReceiptedDraftClient(scope, receipts, (async () => { calls++; return missing(); }) as unknown as typeof fetch).prepareCreate("local-A", input());
    const error = await intent.submit().catch((value) => value);
    expect(error).toMatchObject({ code: "receipt_unavailable", outcome: "not-sent", creationId: intent.id });
    expect(String(error)).not.toContain("private-claim-details");
    expect(calls).toBe(0);
    expect(putCalls).toBe(0);
    expect(base.rows.size).toBe(0);
});

test("account changes while a receipt commits prevent sending without deleting the old account's receipt", async () => {
    for (const next of [null, { accountId: "receipt-account-B", epoch: 2 }, { ...scope(), epoch: 3 }]) {
        const backing = memory(), committed = deferred<void>(); let active: DraftAccountScope | null = scope(), calls = 0;
        const receipts = { ...backing, async put(row: CreationReceipt) { await committed.promise; await backing.put(row); } };
        const client = createReceiptedDraftClient(() => active, receipts, (async () => { calls++; return missing(); }) as typeof fetch);
        const intent = client.prepareCreate("local-A", input());
        const pending = intent.submit().catch((error) => error);
        active = next; committed.resolve();
        expect(await pending).toMatchObject({ code: "account_changed", outcome: "not-sent" });
        expect([...backing.rows.values()][0].accountId).toBe(scope().accountId);
        active = scope();
        await expect(intent.submit()).rejects.toMatchObject({ code: "account_changed" });
        expect(calls).toBe(0);
    }
});

test("new clients recover only matching receipts as read-only references; 404 retains every record", async () => {
    const backing = memory(), methods: string[] = [];
    const original = createReceiptedDraftClient(scope, backing, (async (_path: unknown, options: { method?: string } | undefined) => { methods.push(options!.method!); throw new Error("response-loss"); }) as unknown as typeof fetch);
    const intent = original.prepareCreate("local-A", input());
    await expect(intent.submit()).rejects.toMatchObject({ outcome: "unknown" });
    await backing.put({ accountId: "other-account", localProjectId: "local-A", creationId: crypto.randomUUID() });
    await backing.put({ accountId: scope().accountId, localProjectId: "other-project", creationId: crypto.randomUUID() });
    const before = structuredClone([...backing.rows]);
    const fresh = createReceiptedDraftClient(() => ({ ...scope(), epoch: 9 }), backing, (async (_path, options) => { methods.push(options!.method!); return missing(); }) as typeof fetch);
    const references = await fresh.recover("local-A");
    expect(references).toHaveLength(1);
    expect(references[0].id).toBe(intent.id);
    expect(Object.keys(references[0]).sort()).toEqual(["id", "reconcile"]);
    expect(methods).toEqual(["POST"]);
    expect(await references[0].reconcile()).toEqual({ status: "not-found-yet" });
    expect(methods).toEqual(["POST", "GET"]);
    expect([...backing.rows]).toEqual(before);
});

test("concurrent independent intents are all retained; repeated explicit submit uses the same receipt", async () => {
    const backing = memory(), ids: string[] = [];
    const fetcher = (async (_path: unknown, options: { method?: string; body?: unknown } | undefined) => {
        const id = JSON.parse(String(options?.body)).creationId; ids.push(id);
        return Response.json({ draft: saved(id) });
    }) as typeof fetch;
    const a = createReceiptedDraftClient(scope, backing, fetcher).prepareCreate("local-A", input());
    const b = createReceiptedDraftClient(scope, backing, fetcher).prepareCreate("local-A", input());
    await Promise.all([a.submit(), b.submit()]);
    await a.submit();
    expect(backing.rows.size).toBe(2);
    expect(ids).toEqual([a.id, b.id, a.id]);
    const refs = await createReceiptedDraftClient(scope, backing, fetcher).recover("local-A");
    expect(refs.map((ref) => ref.id).sort()).toEqual([a.id, b.id].sort());
    expect(ids).toHaveLength(3);
});

test("same project claims one creation slot; the losing tab stays local and sends no POST", async () => {
    const backing = claimedMemory(), calls: string[] = [];
    const fetcher = (async (_path: unknown, options: { method?: string; body?: unknown } | undefined) => {
        calls.push(options!.method!);
        return Response.json({ draft: saved(JSON.parse(String(options!.body)).creationId) });
    }) as unknown as typeof fetch;
    const one = createReceiptedDraftClient(scope, backing, fetcher).prepareCreate("local-A", input());
    const two = createReceiptedDraftClient(scope, backing, fetcher).prepareCreate("local-A", input());
    const outcomes = await Promise.all([one.submit(), two.submit()].map((request) => request.then(() => "saved", (error) => error)));
    expect(outcomes.filter((value) => value === "saved")).toHaveLength(1);
    const blocked = outcomes.find((value) => value instanceof DraftError) as DraftError;
    expect(blocked).toMatchObject({ code: "creation_in_progress", outcome: "not-sent" });
    expect(calls).toEqual(["POST"]);
    expect((await backing.list(scope().accountId, "local-A"))).toHaveLength(1);
});

test("a claim that completes after account change never sends and leaves the committed receipt for the old account", async () => {
    let active: DraftAccountScope | null = scope(), release!: () => void;
    const entered = new Promise<void>((resolve) => { release = resolve; });
    const base = memory();
    const backing = {
        ...base,
        async claim(row: CreationReceipt) { await entered; await base.put(row); return "claimed" as const; },
    };
    let calls = 0;
    const client = createReceiptedDraftClient(() => active, backing, (async () => { calls++; return missing(); }) as unknown as typeof fetch);
    const intent = client.prepareCreate("local-A", input());
    const pending = intent.submit();
    active = { ...scope(), epoch: 2 };
    release();
    await expect(pending).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
    expect(calls).toBe(0);
    expect((await base.list(scope().accountId, "local-A"))).toHaveLength(1);
});

test("receipt reading failures or wrong scoped records fail closed without leaking identifiers", async () => {
    let calls = 0;
    for (const list of [
        async () => { throw new Error("private-storage"); },
        async () => [{ accountId: "private-other-account", localProjectId: "local-A", creationId: crypto.randomUUID() }],
        async () => [{ accountId: scope().accountId, localProjectId: "private-other-project", creationId: crypto.randomUUID() }],
        async () => [{ accountId: scope().accountId, localProjectId: "local-A", creationId: "bad" }],
    ]) {
        const client = createReceiptedDraftClient(scope, { put: async () => {}, list }, (async () => { calls++; return missing(); }) as typeof fetch);
        const error = await client.recover("local-A").catch((value) => value);
        expect(error).toMatchObject({ code: "receipt_unavailable", outcome: "not-sent" });
        expect(String(error)).not.toContain("private-");
    }
    expect(calls).toBe(0);
});

test("switching account during local read cannot expose old references or revive the client", async () => {
    let active = scope(); const loaded = deferred<CreationReceipt[]>();
    const client = createReceiptedDraftClient(() => active, { put: async () => {}, list: () => loaded.promise });
    const pending = client.recover("local-A").catch((error) => error);
    active = { ...scope(), epoch: 2 };
    loaded.resolve([{ accountId: scope().accountId, localProjectId: "local-A", creationId: crypto.randomUUID() }]);
    expect(await pending).toMatchObject({ code: "account_changed" });
    active = scope();
    await expect(client.recover("local-A")).rejects.toMatchObject({ code: "account_changed" });
});

test("unconfirmed account, invalid document and mismatched project never touch storage or network", async () => {
    let calls = 0;
    const receipts = { put: async () => { calls++; }, list: async () => { calls++; return []; } };
    const fetcher = (async () => { calls++; return missing(); }) as typeof fetch;
    const unavailable = createReceiptedDraftClient(() => null, receipts, fetcher);
    expect(() => unavailable.prepareCreate("local-A", input())).toThrow();
    await expect(unavailable.recover("local-A")).rejects.toMatchObject({ code: "account_changed" });
    const client = createReceiptedDraftClient(scope, receipts, fetcher);
    expect(() => client.prepareCreate("other-project", input())).toThrow();
    expect(() => client.prepareCreate("", input())).toThrow();
    const value = input(); Object.assign(value.document, { lossy: undefined });
    expect(() => client.prepareCreate("local-A", value)).toThrow();
    expect(calls).toBe(0);
});

test("a prior 401 stays account_changed during recovery and prevents another receipt write", async () => {
    const backing = memory(); let writes = 0, calls = 0;
    const receipts = { ...backing, async put(row: CreationReceipt) { writes++; await backing.put(row); } };
    const client = createReceiptedDraftClient(scope, receipts, (async () => {
        calls++; return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }) as typeof fetch);
    const intent = client.prepareCreate("local-A", input());
    await expect(intent.submit()).rejects.toMatchObject({ code: "unauthorized", outcome: "rejected" });
    const before = structuredClone([...backing.rows]);
    // The account store may not yet have observed the failed session; the client still stays invalid.
    await expect(client.recover("local-A")).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
    await expect(intent.submit()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
    expect(writes).toBe(1);
    expect(calls).toBe(1);
    expect([...backing.rows]).toEqual(before);
});
