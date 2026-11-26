import { describe, expect, test } from "bun:test";
import { createCreationTaskProjection, createCreationTaskProjectionStore, type CreationTaskProjection, type CreationTaskProjectionBacking } from "./creation-task-projection";

const task = (patch: Partial<CreationTaskProjection> = {}) =>
    createCreationTaskProjection({
        accountId: "user-1",
        epoch: 2,
        taskId: "11111111-1111-4111-8111-111111111111",
        originRoute: "/image",
        kind: "image",
        modelId: "image-model",
        priceVersion: 3,
        quotedUnits: 7,
        submittedAt: 100,
        executionStatus: "running",
        deliveryStatus: "pending",
        billingStatus: "reserved",
        ...patch,
    });
function backing(): CreationTaskProjectionBacking {
    const values = new Map<string, unknown>();
    return {
        keys: async () => [...values.keys()],
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
            values.set(key, value);
        },
    };
}

describe("creation task projection", () => {
    test("restores the same account after refresh with a new runtime epoch and isolates other accounts", async () => {
        const store = createCreationTaskProjectionStore(backing());
        await store.put(task({ epoch: 3 }));
        expect(await store.list("user-1", 1)).toMatchObject([{ taskId: task().taskId, epoch: 1 }]);
        expect(await store.get("user-1", 1, task().taskId)).toMatchObject({ accountId: "user-1", epoch: 1 });
        expect(await store.list("user-2", 1)).toEqual([]);
        expect(await store.get("user-2", 1, task().taskId)).toBeNull();
        await store.put(task({ accountId: "user-2", quotedUnits: 9 }));
        expect((await store.list("user-1", 1))[0].quotedUnits).toBe(7);
        expect((await store.list("user-2", 1))[0].quotedUnits).toBe(9);
    });
    test("does not read other-account records or accept mismatched or incomplete stored ownership", async () => {
        const db = backing(), reads: string[] = [];
        await createCreationTaskProjectionStore(db).put(task({ accountId: "user-2" }));
        const store = createCreationTaskProjectionStore({ ...db, getItem: async key => { reads.push(key); return db.getItem(key); } });
        expect(await store.list("user-1", 1)).toEqual([]);
        expect(reads).toEqual([]);
        for (const invalid of [{ ...task(), accountId: "user-2" }, { ...task(), taskId: "22222222-2222-4222-8222-222222222222" }, { ...task(), accountId: undefined }]) {
            const corrupt = createCreationTaskProjectionStore({ ...db, keys: async () => [`v1:user-1:${task().taskId}`], getItem: async () => invalid });
            expect(await corrupt.get("user-1", 1, task().taskId)).toBeNull();
            expect(await corrupt.list("user-1", 1)).toEqual([]);
        }
    });
    test("stores a submittedAt that does not depend on updatedAt", async () => {
        const store = createCreationTaskProjectionStore(backing());
        await store.put(task({ submittedAt: 100, updatedAt: 900 }));
        const recovered = await store.get("user-1", 2, task().taskId);
        expect(recovered?.submittedAt).toBe(100);
        expect(recovered?.updatedAt).toBe(900);
    });
    test("rejects malformed projections instead of displaying an untrusted task", async () => {
        const store = createCreationTaskProjectionStore(backing());
        await expect(store.put({ ...task(), taskId: "not-a-uuid" } as CreationTaskProjection)).rejects.toThrow();
    });
});
