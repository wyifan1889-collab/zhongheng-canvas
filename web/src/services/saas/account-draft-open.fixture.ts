// Process-isolated checks for the default open-request lifecycle. No browser data or global fake IndexedDB installation.
import assert from "node:assert/strict";
import localforage from "localforage";
import { AccountDraftStorageError, createAccountDraftStore } from "./account-draft-store";

let readyError = false, readyCalls = 0, creations = 0, closes = 0, aborts = 0;
const options: unknown[] = [];
localforage.createInstance = ((config) => {
    creations++;
    options.push(config);
    return { ready: async () => { readyCalls++; if (readyError) throw new Error("synthetic-private-ready"); } };
}) as typeof localforage.createInstance;

type RequestStub = {
    result: IDBDatabase;
    transaction: { abort(): void };
    onerror?: () => void;
    onblocked?: () => void;
    onupgradeneeded?: () => void;
    onsuccess?: () => void;
};
let request!: RequestStub, opened!: () => void;
Object.defineProperty(globalThis, "indexedDB", { value: {
    open(name: string) {
        assert.equal(name, "infinite-canvas-saas-drafts");
        request = {
            result: { close() { closes++; }, transaction() { throw new Error("synthetic-private-transaction"); } } as unknown as IDBDatabase,
            transaction: { abort() { aborts++; } },
        };
        opened();
        return request;
    },
}, configurable: true });
const one = createAccountDraftStore(), two = createAccountDraftStore();
assert.equal(creations, 0);
await assert.rejects(one.list(""), (error: unknown) => error instanceof AccountDraftStorageError && error.code === "invalid_data");
assert.equal(creations, 0);

for (const kind of ["blocked", "error", "upgrade", "versionchange"] as const) {
    const called = new Promise<void>((resolve) => { opened = resolve; });
    const pending = kind === "error" ? two.read("account-a", "local-a") : one.list("account-a");
    await called;
    const beforeCloses = closes;
    if (kind === "blocked") request.onblocked!();
    if (kind === "error") request.onerror!();
    if (kind === "upgrade") request.onupgradeneeded!();
    if (kind === "versionchange") {
        // Trigger the native connection's versionchange handler before a transaction is set up.
        request.onsuccess!();
        request.result.onversionchange!.call(request.result, {} as IDBVersionChangeEvent);
    }
    await assert.rejects(pending, (error: unknown) => error instanceof AccountDraftStorageError && error.code === "unavailable" && !String(error).includes("synthetic-private"));
    if (kind !== "versionchange") request.onsuccess!(); // A blocked/error open may still complete later.
    assert.ok(closes > beforeCloses);
}
assert.equal(aborts, 1);
assert.equal(creations, 1);
assert.deepEqual(options, [{ name: "infinite-canvas-saas-drafts", storeName: "canvas_drafts", driver: [localforage.INDEXEDDB] }]);
readyError = true;
await assert.rejects(two.list("account-a"), (error: unknown) => error instanceof AccountDraftStorageError && error.code === "unavailable");
assert.equal(creations, 1);
assert.equal(readyCalls, 5);
process.stdout.write("default open checks passed\n");
