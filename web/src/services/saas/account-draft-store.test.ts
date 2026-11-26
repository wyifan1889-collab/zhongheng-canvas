import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import type { JsonObject } from "../../../../packages/shared/src/index";
import { AccountDraftStorageError, createAccountDraftStore, type AccountDraftRecord } from "./account-draft-store";

const project = (id = "document-a", title = id): JsonObject => ({
    id, title, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-01-01", updatedAt: "2026-01-01", plugin: { retained: [true, "extension"] },
});
const input = (accountId = "account-a", localProjectId = "local-a", title = "draft") => ({ accountId, localProjectId, project: project("document-a", title), cloud: null });
const keyOf = (accountId = "account-a", localProjectId = "local-a") => JSON.stringify([accountId, localProjectId]);
const saved = (): AccountDraftRecord => ({ schemaVersion: 1, accountId: "account-a", localProjectId: "local-a", revision: 1, project: project(), cloud: null });
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { resolve, promise };
}

function fixture(decorate?: (db: IDBDatabase) => void) {
    const factory = new IDBFactory(), active = new Set<IDBDatabase>(), reads: IDBValidKey[] = [];
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open("account-draft-test");
        request.onupgradeneeded = () => request.result.createObjectStore("canvas_drafts");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result, close = db.close.bind(db), transaction = db.transaction.bind(db);
            active.add(db);
            db.close = () => { active.delete(db); close(); };
            db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
                const tx = transaction(...args), store = tx.objectStore("canvas_drafts"), get = store.get.bind(store), cursor = store.openCursor.bind(store);
                store.get = (key) => { reads.push(key as IDBValidKey); return get(key); };
                store.openCursor = (key, direction) => { if (key !== null && key !== undefined) reads.push(key as IDBValidKey); return cursor(key, direction); };
                return tx;
            }) as IDBDatabase["transaction"];
            decorate?.(db);
            resolve(db);
        };
    });
    const raw = async (key: string, write?: { value: unknown }) => {
        const db = await open();
        return new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction("canvas_drafts", write ? "readwrite" : "readonly"), store = tx.objectStore("canvas_drafts");
            if (write) store.put(write.value, key);
            const request = store.get(key);
            tx.oncomplete = () => { db.close(); resolve(request.result); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        });
    };
    return { open, active, reads, raw, factory, store: () => createAccountDraftStore(open) };
}

async function failure(action: Promise<unknown>, code: AccountDraftStorageError["code"]) {
    const error = await action.catch((value) => value);
    expect(error).toBeInstanceOf(AccountDraftStorageError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(new AccountDraftStorageError(code).message);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("synthetic-private");
}

test("account drafts survive new store instances and retain isolated project/cloud snapshots", async () => {
    const f = fixture(), store = f.store(), source = { ...input(), cloud: { id: "11111111-1111-4111-8111-111111111111", revision: 3 } };
    const result = await store.write(source, null);
    expect(result).toEqual({ schemaVersion: 1, ...source, revision: 1 });
    result.project.title = "mutated result";
    result.cloud!.revision = 99;
    const recovered = await f.store().read("account-a", "local-a");
    expect(recovered!.project.title).toBe("draft");
    expect(recovered!.project.plugin).toEqual({ retained: [true, "extension"] });
    expect(recovered!.cloud!.revision).toBe(3);
    recovered!.project.title = "mutated read";
    expect((await store.read("account-a", "local-a"))!.project.title).toBe("draft");
    const summaries = await store.list("account-a");
    expect(summaries).toEqual([{ schemaVersion: 1, accountId: "account-a", localProjectId: "local-a", revision: 1, title: "draft", updatedAt: "2026-01-01", cloud: { id: "11111111-1111-4111-8111-111111111111", revision: 3 } }]);
    expect(summaries[0]).not.toHaveProperty("project");
    summaries[0].cloud!.revision = 100;
    expect((await store.list("account-a"))[0].cloud!.revision).toBe(3);
    expect(f.active.size).toBe(0);
});

test("account listing never retrieves another account's body, including corrupt foreign records", async () => {
    const f = fixture(), store = f.store();
    await store.write(input(), null);
    await store.write(input("account-b", "local-a", "B body"), null);
    await f.raw(keyOf("account-corrupt"), { value: { secret: "synthetic-private" } });
    f.reads.length = 0;
    expect((await store.list("account-a")).map((p) => p.title)).toEqual(["draft"]);
    expect(f.reads).toEqual([keyOf()]);
    expect((await store.read("account-b", "local-a"))!.project.title).toBe("B body");
    expect(await store.read("account-a", "missing")).toBeNull();
    expect(await store.list("unknown-account")).toEqual([]);
    expect(f.active.size).toBe(0);
});

test("cloud slots with identical document IDs and delimiter-shaped scopes remain independent", async () => {
    const f = fixture(), store = f.store();
    const sources = [input("account-a", "cloud-a", "cloud A"), input("account-a", "cloud-b", "cloud B"), input('a,b"', "c"), input("a", 'b",c')];
    await Promise.all(sources.map((source) => store.write(source, null)));
    for (const source of sources) expect((await store.read(source.accountId, source.localProjectId))!.project).toEqual(source.project);
    expect((await store.list("account-a")).map((p) => p.localProjectId).sort()).toEqual(["cloud-a", "cloud-b"]);
    expect(f.active.size).toBe(0);
});

test("cold simultaneous creates commit once, and independent connections reject stale revision updates", async () => {
    const f = fixture(), a = f.store(), b = f.store();
    const creations = await Promise.allSettled([a.write(input(), null), b.write(input("account-a", "local-a", "B"), null)]);
    expect(creations.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(creations.filter((r) => r.status === "rejected").map((r) => r.reason.code)).toEqual(["conflict"]);
    const first = await a.read("account-a", "local-a");
    const updates = await Promise.allSettled([a.write(input("account-a", "local-a", "A update"), first!.revision), b.write(input("account-a", "local-a", "B update"), first!.revision)]);
    expect(updates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((r) => r.status === "rejected").map((r) => r.reason.code)).toEqual(["conflict"]);
    const committed = updates.find((r) => r.status === "fulfilled")!;
    expect(await a.read("account-a", "local-a")).toEqual(committed.value);
    expect(committed.value.revision).toBe(2);
    expect(f.active.size).toBe(0);
});

test("different projects and accounts save concurrently without losing records", async () => {
    const f = fixture(), sources = [input(), input("account-a", "local-b"), input("account-b", "local-a")];
    await Promise.all(sources.map((source) => f.store().write(source, null)));
    await Promise.all(sources.map((source) => f.store().write({ ...source, project: { ...source.project, title: "updated" } }, 1)));
    for (const source of sources) {
        const value = await f.store().read(source.accountId, source.localProjectId);
        expect(value!.revision).toBe(2);
        expect(value!.project.title).toBe("updated");
    }
    expect(f.active.size).toBe(0);
});

test("create-only and exact revision updates never silently overwrite or upsert", async () => {
    const f = fixture(), store = f.store();
    await failure(store.write(input(), 1), "conflict");
    const previous = await store.write(input(), null);
    for (const version of [null, 2, 5]) await failure(store.write(input(), version), "conflict");
    expect(await store.read("account-a", "local-a")).toEqual(previous);
    expect(f.active.size).toBe(0);
});

test("input is copied before opening storage, including scope, project extensions and cloud revision", async () => {
    const f = fixture(), gate = deferred(), started = deferred();
    const store = createAccountDraftStore(async () => { started.resolve(); await gate.promise; return f.open(); });
    const source = { ...input(), cloud: { id: "11111111-1111-4111-8111-111111111111", revision: 2 } };
    const pending = store.write(source, null);
    await started.promise;
    source.accountId = "account-b";
    source.localProjectId = "local-b";
    source.project.id = "mutated-document";
    source.project.title = "mutated";
    (source.project.plugin as JsonObject).retained = false;
    source.cloud.revision = 99;
    gate.resolve();
    const written = await pending;
    expect(written.accountId).toBe("account-a");
    expect(written.localProjectId).toBe("local-a");
    expect(written.project.id).toBe("document-a");
    expect(written.project.title).toBe("draft");
    expect(written.project.plugin).toEqual({ retained: [true, "extension"] });
    expect(written.cloud!.revision).toBe(2);
    expect(await f.store().list("account-b")).toEqual([]);
});

test("an account change while opening prevents all writes and closes the delayed connection", async () => {
    const f = fixture(), gate = deferred(), started = deferred();
    let current = true;
    const store = createAccountDraftStore(async () => { started.resolve(); await gate.promise; return f.open(); });
    const pending = store.write(input(), null, () => current);
    await started.promise;
    current = false;
    gate.resolve();
    await failure(pending, "account_changed");
    expect(await f.store().list("account-a")).toEqual([]);
    expect(f.active.size).toBe(0);
});

test("account guard is rechecked immediately before put, after reading the current record", async () => {
    const f = fixture();
    let checks = 0;
    await failure(f.store().write(input(), null, () => ++checks < 3), "account_changed");
    expect(checks).toBe(3);
    expect(await f.store().read("account-a", "local-a")).toBeNull();
    expect(f.active.size).toBe(0);
});

test("invalid input and accessors fail without opening storage or exposing private errors", async () => {
    let opens = 0, getters = 0;
    const store = createAccountDraftStore(async () => { opens++; throw new Error("synthetic-private"); });
    const broken = [
        null, {}, { ...input(), accountId: "" }, { ...input(), localProjectId: "" }, { ...input(), token: "synthetic-private" },
        { ...input(), cloud: { id: "cloud", revision: 0 } }, { ...input(), cloud: { id: "cloud", revision: 1, secret: "synthetic-private" } },
        { ...input(), cloud: { id: "not-a-uuid", revision: 1 } }, { ...input(), cloud: { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", revision: 1 } },
        { ...input(), project: { ...project(), id: "" } }, { ...input(), project: { ...project(), unknown: undefined } },
        { ...input(), project: { ...project(), nodes: [{ metadata: { content: undefined } }] } },
        Object.defineProperty(input(), "project", { get() { getters++; throw new Error("synthetic-private"); } }),
        new Proxy({}, { getPrototypeOf() { throw new Error("synthetic-private"); } }),
    ];
    for (const value of broken) await failure(store.write(value as ReturnType<typeof input>, null), "invalid_data");
    for (const version of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) await failure(store.write(input(), version), "invalid_data");
    await failure(store.read("", "local-a"), "invalid_data");
    await failure(store.list(""), "invalid_data");
    expect(opens).toBe(0);
    expect(getters).toBe(0);
});

test("malformed, mismatched, unknown-version and extra-field records are not repaired", async () => {
    const corrupt = [
        null, undefined, {}, { ...saved(), schemaVersion: 2 }, { ...saved(), revision: 0 }, { ...saved(), revision: 1.5 },
        { ...saved(), accountId: "account-b" }, { ...saved(), localProjectId: "local-b" }, { ...saved(), secret: "synthetic-private" },
        { ...saved(), cloud: { id: "cloud", revision: 1, unexpected: true } }, { ...saved(), project: { ...project(), id: "" } },
        { ...saved(), cloud: { id: "not-a-uuid", revision: 1 } }, { ...saved(), cloud: { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", revision: 1 } },
        { ...saved(), project: { ...project(), nodes: [{ metadata: { content: undefined } }] } },
    ];
    for (const value of corrupt) {
        const f = fixture(), store = f.store();
        await f.raw(keyOf(), { value });
        await failure(store.read("account-a", "local-a"), "invalid_data");
        await failure(store.list("account-a"), "invalid_data");
        await failure(store.write(input(), null), "invalid_data");
        expect(await f.raw(keyOf())).toEqual(value);
        expect(f.active.size).toBe(0);
    }
});

test("malformed current-account keys fail listing without reading their contents", async () => {
    for (const key of ['["account-a",', '["account-a","local-a","extra"]', '["account-a", "local-a"]', '["account-a",""]']) {
        const f = fixture();
        await f.raw(key, { value: saved() });
        f.reads.length = 0;
        await failure(f.store().list("account-a"), "invalid_data");
        expect(f.reads).toEqual([]);
        expect(f.active.size).toBe(0);
    }
});

test("transaction abort after put success rejects and preserves the previously committed body", async () => {
    const f = fixture(), previous = await f.store().write(input(), null);
    const store = createAccountDraftStore(async () => {
        const db = await f.open(), transaction = db.transaction.bind(db);
        db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
            const tx = transaction(...args), objectStore = tx.objectStore("canvas_drafts"), put = objectStore.put.bind(objectStore);
            objectStore.put = (...values) => { const request = put(...values); request.addEventListener("success", () => tx.abort()); return request; };
            return tx;
        }) as IDBDatabase["transaction"];
        return db;
    });
    await failure(store.write(input("account-a", "local-a", "rollback"), 1), "unavailable");
    expect(await f.store().read("account-a", "local-a")).toEqual(previous);
    expect(f.active.size).toBe(0);
});

test("open, transaction and put failures are sanitized, with no fallback or automatic retry", async () => {
    let opens = 0;
    const unavailable = createAccountDraftStore(async () => { opens++; throw new Error("synthetic-private"); });
    await failure(unavailable.read("account-a", "local-a"), "unavailable");
    await failure(unavailable.list("account-a"), "unavailable");
    await failure(unavailable.write(input(), null), "unavailable");
    expect(opens).toBe(3);
    for (const stage of ["transaction", "put"]) {
        const f = fixture(), store = createAccountDraftStore(async () => {
            const db = await f.open(), transaction = db.transaction.bind(db);
            db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
                if (stage === "transaction") throw new Error("synthetic-private-transaction");
                const tx = transaction(...args);
                tx.objectStore("canvas_drafts").put = () => { throw new DOMException("synthetic-private-quota", "QuotaExceededError"); };
                return tx;
            }) as IDBDatabase["transaction"];
            return db;
        });
        await failure(store.write(input(), null), "unavailable");
        expect(f.active.size).toBe(0);
        expect(await f.store().read("account-a", "local-a")).toBeNull();
    }
});

test("version change aborts the pending operation and releases the connection", async () => {
    const f = fixture(), store = createAccountDraftStore(async () => {
        const db = await f.open(), transaction = db.transaction.bind(db);
        db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
            const tx = transaction(...args), objectStore = tx.objectStore("canvas_drafts"), cursor = objectStore.openCursor.bind(objectStore);
            objectStore.openCursor = (...values) => {
                const request = cursor(...values);
                request.addEventListener("success", () => db.dispatchEvent(new Event("versionchange")));
                return request;
            };
            return tx;
        }) as IDBDatabase["transaction"];
        return db;
    });
    await failure(store.write(input(), null), "unavailable");
    expect(f.active.size).toBe(0);
    expect(await f.store().read("account-a", "local-a")).toBeNull();
});

test("revision overflow refuses a write without modifying stored data", async () => {
    const f = fixture(), record = { ...saved(), revision: Number.MAX_SAFE_INTEGER };
    await f.raw(keyOf(), { value: record });
    await failure(f.store().write(input(), Number.MAX_SAFE_INTEGER), "invalid_data");
    expect(await f.raw(keyOf())).toEqual(record);
});

test("default lazy open rejects blocked/error/upgrades and closes late connections (isolated process)", () => {
    const result = spawnSync(process.execPath, ["--no-env-file", fileURLToPath(new URL("./account-draft-open.fixture.ts", import.meta.url))], { encoding: "utf8" });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("default open checks passed");
});

