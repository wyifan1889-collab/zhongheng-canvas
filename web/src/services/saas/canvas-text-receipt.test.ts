import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createTextGenerationReceiptStore, createTextReceiptAtomicUpdate, parseTextGenerationReceipt, parseTextTargetBinding, parseTextConfigBinding, sameTextConfigBinding, type TextGenerationReceipt, type TextGenerationReceiptBacking, type TextTargetBinding, type TextConfigBinding } from "./canvas-text-receipt";

const target: TextTargetBinding = { schemaVersion: 1, nodeId: "text-node-A", guardId: "11111111-1111-4111-8111-111111111111" };
const base = { accountId: "text-account", projectId: "text-project", idempotencyKey: "text-key", priceVersion: 3 };
const taskId = "22222222-2222-4222-8222-222222222222";
function memory() {
    const data = new Map<string, unknown>();
    const backing: TextGenerationReceiptBacking = { keys: async () => [...data.keys()], getItem: async key => structuredClone(data.get(key) ?? null),
        setItem: async (key, value) => { data.set(key, structuredClone(value)); return value; } };
    return { data, backing, store: createTextGenerationReceiptStore(backing) };
}

test("text receipts strictly project and freeze a detached original target", () => {
    const source = { ...base, textTarget: { ...target } }, parsed = parseTextGenerationReceipt(source);
    source.textTarget.nodeId = "node-B";
    expect(parsed).toEqual({ ...base, textTarget: target });
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.textTarget)).toBe(true);
    expect(parseTextGenerationReceipt(base)).toEqual(base);
    for (const value of [null, [], { ...source, extra: "private" }, { ...base, taskId: "not-a-task" },
        { ...base, textTarget: undefined }, { ...base, textTarget: null }, { ...base, textTarget: { ...target, extra: "private" } }]) {
        expect(() => parseTextGenerationReceipt(value)).toThrow();
    }
    for (const value of [{ ...target, schemaVersion: 2 }, { ...target, nodeId: "" }, { ...target, nodeId: " node " },
        { ...target, nodeId: "node\nprivate" }, { ...target, guardId: "not-a-uuid" }, { nodeId: target.nodeId, guardId: target.guardId }]) {
        expect(() => parseTextTargetBinding(value)).toThrow();
    }
});

test("old unbound text keys remain readable and cannot be retroactively bound", async () => {
    const f = memory(), oldKey = `${JSON.stringify([base.accountId, base.projectId])}:v1:${base.idempotencyKey}`;
    f.data.set(oldKey, { ...base });
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([base]);
    await expect(f.store.put({ ...base, textTarget: target })).rejects.toMatchObject({ code: "receipt_storage" });
    await f.store.put({ ...base, taskId });
    await f.store.put(base);
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([{ ...base, taskId }]);
    expect(f.data.size).toBe(1);
    expect(f.data.get(oldKey)).not.toHaveProperty("textTarget");
});

test("a bound target cannot be erased, swapped or changed while task IDs remain monotonic", async () => {
    const f = memory(), original = { ...base, textTarget: target };
    await f.store.put(original);
    for (const next of [base, { ...original, textTarget: { ...target, nodeId: "node-B" } },
        { ...original, textTarget: { ...target, guardId: taskId } }, { ...original, priceVersion: 4 }]) {
        await expect(f.store.put(next)).rejects.toMatchObject({ code: "receipt_storage" });
    }
    await f.store.put({ ...original, taskId });
    await f.store.put(original);
    await expect(f.store.put({ ...original, taskId: "33333333-3333-4333-8333-333333333333" })).rejects.toMatchObject({ code: "receipt_storage" });
    await expect(f.store.put({ ...original, rejection: "price_changed" })).rejects.toMatchObject({ code: "receipt_storage" });
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([{ ...original, taskId }]);
});

test("definitive rejection preserves its target and cannot become an accepted task or another rejection", async () => {
    const f = memory(), rejected = { ...base, textTarget: target, rejection: "price_changed" as const };
    await f.store.put({ ...base, textTarget: target }); await f.store.put(rejected);
    await expect(f.store.put({ ...rejected, taskId })).rejects.toMatchObject({ code: "receipt_storage" });
    await expect(f.store.put({ ...rejected, rejection: "insufficient_balance" })).rejects.toMatchObject({ code: "receipt_storage" });
    await expect(f.store.put({ ...base, textTarget: target })).rejects.toMatchObject({ code: "receipt_storage" });
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([rejected]);
});

test("two tasks targeting one node retain independent immutable bindings and account/project partitions", async () => {
    const f = memory(), first = { ...base, textTarget: target, taskId }, second = { ...base, idempotencyKey: "second-key", textTarget: target,
        taskId: "33333333-3333-4333-8333-333333333333" };
    await f.store.put(first); await f.store.put(second);
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([first, second]);
    expect(await f.store.list("other-account", base.projectId)).toEqual([]);
    expect(await f.store.list(base.accountId, "other-project")).toEqual([]);
    expect(JSON.stringify([...f.data.values()])).not.toContain("prompt");
});

test("unknown stored fields and mismatched keys fail closed instead of discarding target evidence", async () => {
    for (const change of [(value: TextGenerationReceipt) => ({ ...value, private: "unsafe" }),
        (value: TextGenerationReceipt) => ({ ...value, textTarget: { ...target, private: "unsafe" } }),
        (value: TextGenerationReceipt) => ({ ...value, accountId: "other-account" })]) {
        const f = memory(); await f.store.put({ ...base, textTarget: target });
        const [key] = f.data.keys(); f.data.set(key, change(f.data.get(key) as TextGenerationReceipt));
        await expect(f.store.list(base.accountId, base.projectId)).rejects.toMatchObject({ code: "receipt_storage" });
        await expect(f.store.put({ ...base, textTarget: target })).rejects.toMatchObject({ code: "receipt_storage" });
    }
    const f = memory();
    await expect(f.store.put({ ...base, private: "unsafe" } as TextGenerationReceipt)).rejects.toMatchObject({ code: "receipt_storage" });
    expect(f.data.size).toBe(0);
});

const configTarget: TextConfigBinding = { schemaVersion: 1, nodeId: "config-node-A", guardId: "44444444-4444-4444-8444-444444444444" };
test("F2 Config receipts strictly freeze independent bindings and reject mixed or lossy authority", () => {
    const mutable = { ...configTarget }, parsed = parseTextGenerationReceipt({ ...base, configTarget: mutable });
    mutable.nodeId = "config-node-B";
    expect(parsed.configTarget).toEqual(configTarget); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.configTarget)).toBe(true);
    expect(parsed).not.toHaveProperty("textTarget"); expect(sameTextConfigBinding(parsed.configTarget, configTarget)).toBe(true);
    expect(sameTextConfigBinding(configTarget, undefined)).toBe(false); expect(sameTextConfigBinding(undefined, undefined)).toBe(true);
    expect(sameTextConfigBinding(configTarget, { ...configTarget, nodeId: "other" })).toBe(false);
    let getters = 0;
    const getter = { ...configTarget, get nodeId() { getters++; return "config-node-A"; } };
    const symbolic = { ...configTarget, [Symbol("extra")]: true };
    for (const value of [null, undefined, [], { ...configTarget, schemaVersion: 2 }, { ...configTarget, nodeId: "" }, { ...configTarget, nodeId: " x " },
        { ...configTarget, nodeId: "x\nsecret" }, { ...configTarget, guardId: "not-uuid" }, { ...configTarget, extra: true }, getter, symbolic, Object.create(configTarget)]) {
        expect(() => parseTextConfigBinding(value)).toThrow();
    }
    for (const value of [{ ...base, configTarget: undefined }, { ...base, configTarget: null }, { ...base, configTarget, textTarget: target },
        { ...base, configTarget, textTarget: undefined }, { ...base, configTarget, [Symbol("extra")]: true },
        { ...base, get configTarget() { getters++; return configTarget; } }]) expect(() => parseTextGenerationReceipt(value)).toThrow();
    expect(getters).toBe(0);
});

test("F2 Config receipt authority never upgrades legacy or F1 keys, erases or swaps a binding", async () => {
    for (const initial of [base, { ...base, textTarget: target }]) {
        const f = memory(); await f.store.put(initial);
        await expect(f.store.put({ ...base, configTarget })).rejects.toMatchObject({ code: "receipt_storage" });
        expect(await f.store.list(base.accountId, base.projectId)).toEqual([initial]);
    }
    const f = memory(), original = { ...base, configTarget };
    await f.store.put(original);
    for (const next of [base, { ...base, textTarget: target }, { ...original, configTarget: { ...configTarget, nodeId: "config-B" } },
        { ...original, configTarget: { ...configTarget, guardId: taskId } }]) await expect(f.store.put(next)).rejects.toMatchObject({ code: "receipt_storage" });
    await f.store.put({ ...original, taskId }); await f.store.put(original);
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([{ ...original, taskId }]);
    expect(await f.store.list("other", base.projectId)).toEqual([]); expect(await f.store.list(base.accountId, "other")).toEqual([]);
    expect(JSON.stringify([...f.data.values()])).not.toContain("prompt");
});

test("F2 application markers require accepted Config authority and only claim then complete can advance them", async () => {
    const accepted = { ...base, configTarget, taskId }, f = memory(); let coerced = 0;
    for (const value of [{ ...base, application: "pending" }, { ...base, textTarget: target, taskId, application: "pending" },
        { ...base, configTarget, application: "pending" }, { ...accepted, application: undefined }, { ...accepted, application: "other" },
        { ...accepted, application: { toString() { coerced++; return "pending"; } } }, { ...accepted, application: "pending", rejection: "price_changed" }]) {
        expect(() => parseTextGenerationReceipt(value)).toThrow();
    }
    expect(coerced).toBe(0);
    await expect(f.store.put({ ...accepted, application: "pending" })).rejects.toMatchObject({ code: "receipt_storage" });
    await f.store.put(accepted);
    await expect(f.store.completeConfigApplication(accepted)).rejects.toMatchObject({ code: "receipt_storage" });
    expect(await f.store.claimConfigApplication(accepted)).toBe("claimed");
    expect(await f.store.claimConfigApplication(accepted)).toBe("pending");
    await f.store.put(accepted); expect((await f.store.list(base.accountId, base.projectId))[0].application).toBe("pending");
    await expect(f.store.put({ ...accepted, application: "applied" })).rejects.toMatchObject({ code: "receipt_storage" });
    await f.store.completeConfigApplication(accepted); await f.store.put(accepted);
    expect(await f.store.claimConfigApplication(accepted)).toBe("applied");
    await expect(f.store.put({ ...accepted, application: "pending" })).rejects.toMatchObject({ code: "receipt_storage" });
    for (const changed of [{ ...accepted, taskId: "55555555-5555-4555-8555-555555555555" }, { ...accepted, priceVersion: 4 },
        { ...accepted, configTarget: { ...configTarget, nodeId: "other" } }, { ...accepted, accountId: "other" }]) {
        await expect(f.store.claimConfigApplication(changed)).rejects.toMatchObject({ code: "receipt_storage" });
        await expect(f.store.completeConfigApplication(changed)).rejects.toMatchObject({ code: "receipt_storage" });
    }
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([{ ...accepted, application: "applied" }]);
});

test("F2 a failed claim reply preserves pending uncertainty and does not authorize a replay", async () => {
    const f = memory(), accepted = { ...base, configTarget, taskId }; await f.store.put(accepted);
    const write = f.backing.setItem;
    f.backing.setItem = async (key, value) => { await write(key, value); throw new Error("lost local commit reply"); };
    await expect(f.store.claimConfigApplication(accepted)).rejects.toMatchObject({ code: "receipt_storage" });
    f.backing.setItem = write;
    expect(await f.store.claimConfigApplication(accepted)).toBe("pending");
    expect(await f.store.list(base.accountId, base.projectId)).toEqual([{ ...accepted, application: "pending" }]);
});

test("F2 independent IndexedDB connections atomically claim once and stale task writes preserve consumption", async () => {
    const factory = new IDBFactory(), name = `f2-text-receipts-${crypto.randomUUID()}`;
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(name);
        request.onupgradeneeded = () => { request.result.createObjectStore("receipts"); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const key = `${JSON.stringify([base.accountId, base.projectId])}:v1:${base.idempotencyKey}`;
    const read = async () => {
        const db = await open();
        return new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction("receipts", "readonly"), request = tx.objectStore("receipts").get(key); let value: unknown;
            request.onsuccess = () => { value = request.result; };
            tx.oncomplete = () => { db.close(); resolve(value); }; tx.onabort = () => { db.close(); reject(tx.error); };
        });
    };
    const backing = (): TextGenerationReceiptBacking => ({ keys: async () => [key], getItem: read, setItem: async () => { throw new Error("atomic path required"); }, updateItem: createTextReceiptAtomicUpdate(open) });
    const first = createTextGenerationReceiptStore(backing()), second = createTextGenerationReceiptStore(backing()), accepted = { ...base, configTarget, taskId };
    await first.put(accepted);
    const [one, two] = await Promise.all([first.claimConfigApplication(accepted), second.claimConfigApplication(accepted), second.put(accepted)]);
    expect([one, two].sort()).toEqual(["claimed", "pending"]); expect(await read()).toEqual({ ...accepted, application: "pending" });
    await first.completeConfigApplication(accepted); await second.put(accepted);
    expect(await second.claimConfigApplication(accepted)).toBe("applied"); expect(await read()).toEqual({ ...accepted, application: "applied" });
});
