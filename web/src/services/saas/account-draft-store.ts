import localforage from "localforage";
import type { JsonObject } from "../../../../packages/shared/src/index";
import { inspectCanvasDocument } from "./canvas-document";

export type AccountDraftRecord = {
    schemaVersion: 1;
    accountId: string;
    localProjectId: string;
    revision: number;
    project: JsonObject;
    cloud: { id: string; revision: number } | null;
};
export type AccountDraftSummary = Omit<AccountDraftRecord, "project"> & { title: string; updatedAt: string };
type DraftInput = { accountId: string; localProjectId: string; project: JsonObject; cloud: AccountDraftRecord["cloud"] };
type ErrorCode = "conflict" | "unavailable" | "invalid_data" | "account_changed";

export class AccountDraftStorageError extends Error {
    constructor(public code: ErrorCode) {
        super({
            conflict: "本机草稿已被其他窗口修改，本次内容未覆盖已保存版本。",
            unavailable: "本机草稿存储未完成，请保留当前内容。",
            invalid_data: "本机草稿数据不完整或版本不支持，未读取或覆盖原记录。",
            account_changed: "账号已变化，本次草稿操作已停止。",
        }[code]);
        this.name = "AccountDraftStorageError";
    }
}

const databaseName = "infinite-canvas-saas-drafts", storeName = "canvas_drafts";
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const cloudId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const keyOf = (accountId: string, localProjectId: string) => JSON.stringify([accountId, localProjectId]);
const invalid = (): never => { throw new AccountDraftStorageError("invalid_data"); };
const safeError = (error: unknown) => error instanceof AccountDraftStorageError ? error : new AccountDraftStorageError("unavailable");

function fields(value: unknown, names: string[]): unknown[] {
    try {
        if (typeof value !== "object" || value === null || Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== names.length) return invalid();
        return names.map((name) => {
            const field = Object.getOwnPropertyDescriptor(value, name);
            if (!field?.enumerable || !Object.hasOwn(field, "value")) return invalid();
            return field.value;
        });
    } catch { return invalid(); }
}

function copyProject(value: unknown): JsonObject {
    try {
        const inspection = inspectCanvasDocument(value);
        // This store accepts complete JSON only; never repair malformed stored data.
        if (inspection.omittedOptionalPaths.length || !identity(inspection.snapshot.id)) return invalid();
        return inspection.snapshot;
    } catch { return invalid(); }
}

function copyCloud(value: unknown): AccountDraftRecord["cloud"] {
    if (value === null) return null;
    const [id, version] = fields(value, ["id", "revision"]);
    if (!cloudId(id) || !revision(version)) return invalid();
    return { id, revision: version };
}

function decode(value: unknown, key: string): AccountDraftRecord {
    const [schemaVersion, accountId, localProjectId, version, body, cloud] = fields(value, ["schemaVersion", "accountId", "localProjectId", "revision", "project", "cloud"]);
    if (schemaVersion !== 1 || !identity(accountId) || !identity(localProjectId) || !revision(version) || keyOf(accountId, localProjectId) !== key) return invalid();
    const project = copyProject(body);
    return { schemaVersion: 1, accountId, localProjectId, revision: version, project, cloud: copyCloud(cloud) };
}

let databaseStore: ReturnType<typeof localforage.createInstance> | undefined;
async function openAccountDraftDatabase(): Promise<IDBDatabase> {
    databaseStore ??= localforage.createInstance({ name: databaseName, storeName, driver: [localforage.INDEXEDDB] });
    await databaseStore.ready();
    return new Promise((resolve, reject) => {
        let failed = false;
        const request = indexedDB.open(databaseName);
        request.onerror = request.onblocked = () => { failed = true; reject(new AccountDraftStorageError("unavailable")); };
        // A database removed after initialization must not become an empty replacement.
        request.onupgradeneeded = () => { failed = true; request.transaction?.abort(); reject(new AccountDraftStorageError("unavailable")); };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            if (failed) db.close(); else resolve(db);
        };
    });
}

function guard(isCurrent?: () => boolean) {
    try { if (!isCurrent || isCurrent()) return; } catch { /* Never expose account/store details. */ }
    throw new AccountDraftStorageError("account_changed");
}

/** Account grouping is a local data boundary, not encryption or server authorization. */
export function createAccountDraftStore(open: () => Promise<IDBDatabase> = openAccountDraftDatabase) {
    async function transaction<T>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void,
        isCurrent?: () => boolean,
    ): Promise<T> {
        let db: IDBDatabase | undefined;
        try {
            db = await open();
            guard(isCurrent);
            const connection = db;
            return await new Promise<T>((resolve, reject) => {
                const tx = connection.transaction(storeName, mode);
                let result: T, hasResult = false, failure: AccountDraftStorageError | undefined;
                const fail = (error: unknown) => {
                    failure ??= safeError(error);
                    try { tx.abort(); } catch { reject(failure); }
                };
                tx.oncomplete = () => hasResult && !failure ? resolve(result) : reject(failure ?? new AccountDraftStorageError("unavailable"));
                tx.onabort = () => reject(failure ?? new AccountDraftStorageError("unavailable"));
                tx.onerror = () => fail(new AccountDraftStorageError("unavailable"));
                connection.onversionchange = () => { fail(new AccountDraftStorageError("unavailable")); connection.close(); };
                try { run(tx.objectStore(storeName), (value) => { result = value; hasResult = true; }, fail); }
                catch (error) { fail(error); }
            });
        } catch (error) { throw safeError(error); }
        finally { db?.close(); }
    }

    return Object.freeze({
        async read(accountId: string, localProjectId: string): Promise<AccountDraftRecord | null> {
            if (!identity(accountId) || !identity(localProjectId)) return invalid();
            const key = keyOf(accountId, localProjectId);
            return transaction("readonly", (store, done, fail) => {
                const request = store.openCursor(key);
                request.onsuccess = () => {
                    try { done(request.result ? decode(request.result.value, key) : null); }
                    catch (error) { fail(error); }
                };
            });
        },
        async list(accountId: string): Promise<AccountDraftSummary[]> {
            if (!identity(accountId)) return invalid();
            return transaction("readonly", (store, done, fail) => {
                // Enumerate keys only, never retrieve another account's record/body.
                const request = store.getAllKeys(), summaries: AccountDraftSummary[] = [];
                request.onsuccess = () => {
                    try {
                        const prefix = `[${JSON.stringify(accountId)},`;
                        for (const key of request.result) {
                            if (typeof key !== "string") continue;
                            let scope: unknown;
                            try { scope = JSON.parse(key); }
                            catch { if (key.startsWith(prefix)) return invalid(); else continue; }
                            if (!Array.isArray(scope) || scope[0] !== accountId) continue;
                            if (scope.length !== 2 || !identity(scope[1]) || keyOf(accountId, scope[1]) !== key) return invalid();
                            const read = store.get(key);
                            read.onsuccess = () => {
                                try {
                                    const { project, ...summary } = decode(read.result, key);
                                    if (typeof project.updatedAt !== "string") return invalid();
                                    summaries.push({ ...summary, title: project.title as string, updatedAt: project.updatedAt });
                                } catch (error) { fail(error); }
                            };
                        }
                        done(summaries);
                    } catch (error) { fail(error); }
                };
            });
        },
        async write(input: DraftInput, expectedRevision: number | null, isCurrent?: () => boolean): Promise<AccountDraftRecord> {
            // Copy everything before the first await: subsequent editor mutations are a new proposal.
            const [accountId, localProjectId, body, cloud] = fields(input, ["accountId", "localProjectId", "project", "cloud"]);
            if (!identity(accountId) || !identity(localProjectId) || (expectedRevision !== null && !revision(expectedRevision))) return invalid();
            const project = copyProject(body), key = keyOf(accountId, localProjectId);
            const proposed: AccountDraftRecord = { schemaVersion: 1, accountId, localProjectId, revision: 1, project, cloud: copyCloud(cloud) };
            guard(isCurrent);
            return transaction("readwrite", (store, done, fail) => {
                const request = store.openCursor(key);
                request.onsuccess = () => {
                    try {
                        const current = request.result ? decode(request.result.value, key) : null;
                        if ((current?.revision ?? null) !== expectedRevision) throw new AccountDraftStorageError("conflict");
                        proposed.revision = (current?.revision ?? 0) + 1;
                        if (!revision(proposed.revision)) return invalid();
                        guard(isCurrent);
                        store.put(proposed, key);
                        done(proposed);
                    } catch (error) { fail(error); }
                };
            }, isCurrent);
        },
    });
}
