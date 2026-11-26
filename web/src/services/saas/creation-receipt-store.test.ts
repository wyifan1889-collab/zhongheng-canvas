import { expect, spyOn, test } from "bun:test";
import "./idb-test-setup";
const localforage = (await import("localforage")).default;
const { createCreationReceiptStore, ReceiptStorageError } = await import("./creation-receipt-store");
import type { CreationReceipt, CreationReceiptBacking } from "./creation-receipt-store";

const id = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const secondId = "b1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const thirdId = "c1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const sample: CreationReceipt = { accountId: "synthetic-account-A", localProjectId: "synthetic-project-A", creationId: id };
const keyOf = (value: CreationReceipt) => `${JSON.stringify([value.accountId, value.localProjectId])}:v1:${value.creationId}`;

function rawIndexedDbPut(value: CreationReceipt) {
    return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("infinite-canvas-saas-receipts");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const connection = request.result, transaction = connection.transaction("creation_receipts", "readwrite");
            transaction.oncomplete = () => { connection.close(); resolve(); };
            transaction.onerror = () => { connection.close(); reject(transaction.error); };
            transaction.objectStore("creation_receipts").put(value, keyOf(value));
        };
    });
}

function memory() {
    const data = new Map<string, unknown>(), calls: { method: string; key?: string }[] = [];
    const backing: CreationReceiptBacking = {
        async getItem(key) { calls.push({ method: "get", key }); return data.has(key) ? structuredClone(data.get(key)) : null; },
        async setItem(key, value) { calls.push({ method: "set", key }); data.set(key, structuredClone(value)); return value; },
        async keys() { calls.push({ method: "keys" }); return [...data.keys()]; },
    };
    return { data, calls, backing };
}

async function expectSafeFailure(action: Promise<unknown>) {
    const error = await action.catch((failure) => failure);
    expect(error).toBeInstanceOf(ReceiptStorageError);
    expect(error.message).toBe(new ReceiptStorageError().message);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("synthetic-private");
}

test("each receipt is a detached three-field projection, with lowercase UUID and no cleanup API", async () => {
    const { backing, calls, data } = memory(), store = createCreationReceiptStore(backing);
    let extraReads = 0;
    const input = {
        ...sample, creationId: id.toUpperCase(), document: { secret: "synthetic-private-document" }, token: "synthetic-private-token",
        get password() { extraReads++; throw new Error("must not read"); },
    };
    expect(calls).toEqual([]);
    expect(Object.keys(store).sort()).toEqual(["claim", "list", "put"]);
    expect(Object.isFrozen(store)).toBe(true);
    const pending = store.put(input);
    input.accountId = "synthetic-account-B";
    await pending;
    expect(extraReads).toBe(0);
    expect([...data.entries()]).toEqual([[keyOf(sample), sample]]);
    const receipts = await store.list(sample.accountId, sample.localProjectId);
    expect(receipts).toEqual([sample]);
    expect(Object.isFrozen(receipts[0])).toBe(true);
    receipts.length = 0;
    expect(await store.list(sample.accountId, sample.localProjectId)).toEqual([sample]);
    await store.put(sample);
    expect(calls.filter((call) => call.method === "set")).toHaveLength(1);
});

test("two instances append different intentions and preserve all earlier records", async () => {
    const { backing, data } = memory(), one = createCreationReceiptStore(backing), two = createCreationReceiptStore(backing);
    const second = { ...sample, creationId: secondId };
    await Promise.all([one.put(sample), two.put(second)]);
    await Promise.all([one.put(sample), two.put(sample)]);
    expect(data.size).toBe(2);
    expect((await one.list(sample.accountId, sample.localProjectId)).map((value) => value.creationId).sort()).toEqual([id, secondId]);
    expect(await two.list(sample.accountId, sample.localProjectId)).toEqual(await one.list(sample.accountId, sample.localProjectId));
});

test("two independent stores can claim one project slot only once", async () => {
    const { backing, data } = memory();
    const claims = new Map<string, string>();
    const claim = async (key: string, value: CreationReceipt) => {
        const owner = claims.get(JSON.stringify([value.accountId, value.localProjectId]));
        if (owner && owner !== value.creationId) return "busy" as const;
        claims.set(JSON.stringify([value.accountId, value.localProjectId]), value.creationId);
        data.set(key, structuredClone(value));
        return owner ? "existing" as const : "claimed" as const;
    };
    const one = createCreationReceiptStore({ ...backing, claim });
    const two = createCreationReceiptStore({ ...backing, claim });
    const second = { ...sample, creationId: secondId };
    const results = await Promise.all([one.claim(sample), two.claim(second)]);
    expect(results.sort()).toEqual(["busy", "claimed"]);
    expect(data.size).toBe(1);
    expect(await one.claim(sample)).toBe("existing");
    expect(await two.claim(second)).toBe("busy");
});

test("IndexedDB claims serialize two independent connections", async () => {
    const one = createCreationReceiptStore(), two = createCreationReceiptStore();
    const second = { ...sample, creationId: secondId };
    const results = await Promise.all([one.claim(sample), two.claim(second)]);
    expect(results.sort()).toEqual(["busy", "claimed"]);
    await rawIndexedDbPut(second);
    expect(await one.claim(sample)).toBe("existing");
    expect(await two.claim({ ...sample, creationId: thirdId })).toBe("busy");
});

test("cold concurrent puts for the same normalized ID leave one identical record", async () => {
    const { backing, data } = memory();
    let readers = 0;
    const release: (() => void)[] = [];
    const simultaneous: CreationReceiptBacking = { ...backing, async getItem() {
        readers++;
        await new Promise<void>((resolve) => {
            release.push(resolve);
            if (release.length === 2) release.forEach((finish) => finish());
        });
        return null;
    } };
    await Promise.all([
        createCreationReceiptStore(simultaneous).put(sample),
        createCreationReceiptStore(simultaneous).put({ ...sample, creationId: id.toUpperCase() }),
    ]);
    expect(readers).toBe(2);
    expect([...data.entries()]).toEqual([[keyOf(sample), sample]]);
    expect(await createCreationReceiptStore(backing).list(sample.accountId, sample.localProjectId)).toEqual([sample]);
});

test("scope encoding cannot collide and values from other accounts or projects are not read", async () => {
    const { backing, calls, data } = memory(), store = createCreationReceiptStore(backing);
    const receipts = [
        sample, { ...sample, accountId: "synthetic-account-B" }, { ...sample, localProjectId: "synthetic-project-B" },
        { ...sample, accountId: 'a,b\\"', localProjectId: "c" }, { ...sample, accountId: "a", localProjectId: 'b\\",c' },
    ];
    for (const value of receipts) await store.put(value);
    data.set(keyOf({ ...sample, accountId: "synthetic-account-corrupt" }), { secret: "synthetic-private-other" });
    calls.length = 0;
    expect(await store.list(sample.accountId, sample.localProjectId)).toEqual([sample]);
    expect(calls.filter((call) => call.method === "get")).toEqual([{ method: "get", key: keyOf(sample) }]);
    for (const value of receipts) expect(await store.list(value.accountId, value.localProjectId)).toEqual([value]);
    expect(data.size).toBe(6);
});

test("invalid identifiers or receipt shapes fail before storage is touched", async () => {
    const { backing, calls } = memory(), store = createCreationReceiptStore(backing);
    const invalid = [
        null, [], "synthetic-private", {}, { ...sample, accountId: "" }, { ...sample, accountId: 1 },
        { ...sample, localProjectId: "" }, { ...sample, localProjectId: null },
        ...["", "../session", `${id}?query=synthetic-private`, ` ${id}`, null, 1].map((creationId) => ({ ...sample, creationId })),
        Object.create(sample), Object.defineProperty({ ...sample }, "creationId", { get() { throw new Error("synthetic-private-getter"); } }),
    ];
    for (const value of invalid) await expectSafeFailure(store.put(value as CreationReceipt));
    for (const [account, project] of [["", sample.localProjectId], [sample.accountId, ""], [null, sample.localProjectId], [sample.accountId, 1]]) {
        await expectSafeFailure(store.list(account as string, project as string));
    }
    expect(calls).toEqual([]);
});

test("malformed existing values are neither repaired nor silently treated as absent", async () => {
    const corruptions = [
        undefined, null, [], "synthetic-private", {}, { ...sample, accountId: "other" }, { ...sample, localProjectId: "other" },
        { ...sample, creationId: secondId }, { ...sample, creationId: id.toUpperCase() }, { ...sample, secret: "synthetic-private-body" },
        { accountId: sample.accountId, localProjectId: sample.localProjectId },
    ];
    for (const corrupt of corruptions) {
        const { backing, data, calls } = memory(), store = createCreationReceiptStore(backing);
        data.set(keyOf(sample), corrupt);
        await expectSafeFailure(store.list(sample.accountId, sample.localProjectId));
        await expectSafeFailure(store.put(sample));
        expect(calls.some((call) => call.method === "set")).toBe(false);
        expect(data.get(keyOf(sample))).toEqual(corrupt);
    }
});

test("related malformed keys or unsupported versions reject without reading their values", async () => {
    const prefix = JSON.stringify([sample.accountId, sample.localProjectId]);
    for (const key of [prefix, `${prefix}:v1:`, `${prefix}:v1:not-a-uuid`, `${prefix}:v2:${id}`, `${prefix}:v1:${id.toUpperCase()}`, `${prefix}:v1:${id}:extra`]) {
        const { backing, data, calls } = memory(), store = createCreationReceiptStore(backing);
        data.set(key, { secret: "synthetic-private" });
        await expectSafeFailure(store.list(sample.accountId, sample.localProjectId));
        expect(calls).toEqual([{ method: "keys" }]);
        expect(data.has(key)).toBe(true);
    }
});

test("enumeration, read and transaction failures stay safe errors, without retries or fallback", async () => {
    for (const stage of ["keys", "getItem", "setItem"] as const) {
        const { backing, calls, data } = memory();
        let failures = 0;
        const broken: CreationReceiptBacking = { ...backing, [stage]: async () => { failures++; throw new Error(`synthetic-private-${stage}`); } };
        const store = createCreationReceiptStore(broken);
        await expectSafeFailure(stage === "keys" ? store.list(sample.accountId, sample.localProjectId) : store.put(sample));
        expect(failures).toBe(1);
        expect(data.size).toBe(0);
        expect(calls.some((call) => call.method === "set")).toBe(false);
    }
    for (const keys of [null, [1], "synthetic-private"]) {
        await expectSafeFailure(createCreationReceiptStore({ ...memory().backing, keys: async () => keys as string[] }).list(sample.accountId, sample.localProjectId));
    }
});

test("put does not resolve until the backing transaction has completed", async () => {
    const { backing, data } = memory();
    let release!: () => void, started!: () => void, finished = false;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const store = createCreationReceiptStore({ ...backing, async setItem(key, value) {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return backing.setItem(key, value);
    } });
    const pending = store.put(sample).then(() => { finished = true; });
    await entered;
    expect(finished).toBe(false);
    expect(data.size).toBe(0);
    release();
    await pending;
    expect(finished).toBe(true);
    expect(data.get(keyOf(sample))).toEqual(sample);
});

test("a disappeared or unreadable enumerated record is an error, not an empty recovery list", async () => {
    for (const getItem of [
        async () => null,
        async () => { throw new Error("synthetic-private-read-failure"); },
    ]) {
        let reads = 0;
        const { backing, calls } = memory();
        const store = createCreationReceiptStore({ ...backing, keys: async () => [keyOf(sample)], async getItem() { reads++; return getItem(); } });
        await expectSafeFailure(store.list(sample.accountId, sample.localProjectId));
        expect(reads).toBe(1);
        expect(calls.some((call) => call.method === "set")).toBe(false);
    }
});

test("default backing is lazy, independent, IndexedDB-only and reused within the store", async () => {
    const { backing } = memory();
    const factory = spyOn(localforage, "createInstance").mockImplementation(() => backing as ReturnType<typeof localforage.createInstance>);
    try {
        const store = createCreationReceiptStore();
        expect(factory).not.toHaveBeenCalled();
        await expectSafeFailure(store.put({ ...sample, creationId: "bad" }));
        expect(factory).not.toHaveBeenCalled();
        await store.put(sample);
        await store.list(sample.accountId, sample.localProjectId);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith({ name: "infinite-canvas-saas-receipts", storeName: "creation_receipts", driver: [localforage.INDEXEDDB] });
    } finally { factory.mockRestore(); }
});

test("default backing initialization failure is sanitized and never selects another driver", async () => {
    const factory = spyOn(localforage, "createInstance").mockImplementation(() => { throw new Error("synthetic-private-init"); });
    try {
        await expectSafeFailure(createCreationReceiptStore().put(sample));
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith({ name: "infinite-canvas-saas-receipts", storeName: "creation_receipts", driver: [localforage.INDEXEDDB] });
    } finally { factory.mockRestore(); }
});
