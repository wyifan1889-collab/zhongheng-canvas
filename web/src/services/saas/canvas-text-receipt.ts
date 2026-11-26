import localforage from "localforage";
import { GenerationError } from "./generation";
import { parseGenerationReceipt, type GenerationReceipt } from "./canvas-image-generation";

export type TextTargetBinding = Readonly<{ schemaVersion: 1; nodeId: string; guardId: string }>;
export type TextConfigBinding = Readonly<{ schemaVersion: 1; nodeId: string; guardId: string }>;
export type TextGenerationReceipt = GenerationReceipt & Readonly<{ textTarget?: TextTargetBinding; configTarget?: TextConfigBinding; application?: "pending" | "applied" }>;
export type TextGenerationReceiptBacking = { keys(): Promise<string[]>; getItem(key: string): Promise<unknown>; setItem(key: string, value: TextGenerationReceipt): Promise<unknown>;
    updateItem?: (key: string, update: (previous: unknown) => TextGenerationReceipt) => Promise<TextGenerationReceipt> };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const storageError = () => new GenerationError("receipt_storage", "本机文本任务回执读写未完成，请保留当前窗口和回执，不要重复提交。", "not-sent");
const exactRecord = (value: unknown): value is Record<string, unknown> => record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));

export function parseTextTargetBinding(value: unknown): TextTargetBinding {
    if (!record(value) || Object.keys(value).some(key => !["schemaVersion", "nodeId", "guardId"].includes(key)) || value.schemaVersion !== 1 ||
        typeof value.nodeId !== "string" || !value.nodeId.trim() || value.nodeId.trim() !== value.nodeId || /[\u0000-\u001f\u007f]/.test(value.nodeId) ||
        typeof value.guardId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.guardId)) throw storageError();
    return Object.freeze({ schemaVersion: 1, nodeId: value.nodeId, guardId: value.guardId });
}

export function sameTextTargetBinding(left: TextTargetBinding | undefined, right: TextTargetBinding | undefined): boolean {
    return left === undefined || right === undefined ? left === right : left.schemaVersion === right.schemaVersion && left.nodeId === right.nodeId && left.guardId === right.guardId;
}

/** Same JSON shape as a Text target, with separate Config receipt authority. */
export function parseTextConfigBinding(value: unknown): TextConfigBinding {
    if (!exactRecord(value) || Reflect.ownKeys(value).length !== 3) throw storageError();
    return parseTextTargetBinding(value);
}
export function sameTextConfigBinding(left: TextConfigBinding | undefined, right: TextConfigBinding | undefined): boolean {
    return left === undefined || right === undefined ? left === right : left.schemaVersion === right.schemaVersion && left.nodeId === right.nodeId && left.guardId === right.guardId;
}

/** Text-only extension. The image parser and its strict stored-record contract stay unchanged. */
export function parseTextGenerationReceipt(value: unknown): TextGenerationReceipt {
    if (!exactRecord(value) || Object.keys(value).some(key => !["accountId", "projectId", "idempotencyKey", "priceVersion", "taskId", "rejection", "textTarget", "configTarget", "application"].includes(key)) ||
        Object.hasOwn(value, "textTarget") && Object.hasOwn(value, "configTarget") || Object.hasOwn(value, "application") &&
        (!Object.hasOwn(value, "configTarget") || !value.taskId || value.rejection || value.application !== "pending" && value.application !== "applied")) throw storageError();
    const { textTarget, configTarget, application, ...base } = value;
    const parsed = parseGenerationReceipt(base);
    return Object.freeze({ ...parsed, ...(Object.hasOwn(value, "textTarget") ? { textTarget: parseTextTargetBinding(textTarget) } : {}),
        ...(Object.hasOwn(value, "configTarget") ? { configTarget: parseTextConfigBinding(configTarget) } : {}),
        ...(Object.hasOwn(value, "application") ? { application: application as "pending" | "applied" } : {}) });
}
const prefix = (accountId: string, projectId: string) => `${JSON.stringify([accountId, projectId])}:v1:`;
const receiptKey = (value: TextGenerationReceipt) => `${prefix(value.accountId, value.projectId)}${value.idempotencyKey}`;
const testWriteChains = new WeakMap<TextGenerationReceiptBacking, Promise<unknown>>();

/** One read/compare/write transaction; independent browser connections cannot both claim the same receipt. */
export function createTextReceiptAtomicUpdate(open: () => Promise<IDBDatabase>): NonNullable<TextGenerationReceiptBacking["updateItem"]> {
    return (key, update) => open().then(db => new Promise<TextGenerationReceipt>((resolve, reject) => {
        let result: TextGenerationReceipt, failure: unknown, tx: IDBTransaction;
        try { tx = db.transaction("receipts", "readwrite"); } catch { db.close(); reject(storageError()); return; }
        db.onversionchange = () => db.close();
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = () => { db.close(); reject(failure ?? storageError()); };
        tx.onerror = () => { failure ??= storageError(); };
        const store = tx.objectStore("receipts"), request = store.get(key);
        request.onsuccess = () => {
            try { result = parseTextGenerationReceipt(update(request.result ?? null)); store.put(result, key); }
            catch (error) { failure = error; tx.abort(); }
        };
    }));
}

function mergeReceipt(previous: unknown, next: TextGenerationReceipt): TextGenerationReceipt {
    if (previous === null) { if (next.application) throw storageError(); return next; }
    const old = parseTextGenerationReceipt(previous);
    if (receiptKey(old) !== receiptKey(next) || old.priceVersion !== next.priceVersion || !sameTextTargetBinding(old.textTarget, next.textTarget) || !sameTextConfigBinding(old.configTarget, next.configTarget) ||
        old.taskId && next.taskId && old.taskId !== next.taskId || old.taskId && next.rejection || old.rejection && (next.rejection !== old.rejection || next.taskId) ||
        next.application && next.application !== old.application) throw storageError();
    return parseTextGenerationReceipt({ ...next, ...(old.taskId ? { taskId: old.taskId } : {}), ...(old.application ? { application: old.application } : {}) });
}

/** Keeps the existing text partition and reads old unbound receipts without upgrading their destination. */
export function createTextGenerationReceiptStore(backing?: TextGenerationReceiptBacking) {
    let storage = backing;
    function database(): TextGenerationReceiptBacking {
        if (!storage) {
            const db = localforage.createInstance({ name: "infinite-canvas-text-generation-receipts", storeName: "receipts", driver: [localforage.INDEXEDDB] });
            const updateItem = createTextReceiptAtomicUpdate(async () => {
                await db.ready();
                return new Promise<IDBDatabase>((resolve, reject) => {
                    let failed = false;
                    const request = indexedDB.open("infinite-canvas-text-generation-receipts");
                    request.onerror = request.onblocked = () => { failed = true; reject(storageError()); };
                    request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
                });
            });
            storage = { keys: () => db.keys(), getItem: key => db.getItem(key), setItem: (key, value) => db.setItem(key, value), updateItem };
        }
        return storage;
    }
    function update(key: string, transform: (previous: unknown) => TextGenerationReceipt) {
        const db = database();
        if (db.updateItem) return db.updateItem(key, transform);
        // Injected in-memory test backings only. Production always uses the cross-connection transaction above.
        const next = (testWriteChains.get(db) ?? Promise.resolve()).catch(() => undefined).then(async () => {
            const value = parseTextGenerationReceipt(transform(await db.getItem(key)));
            await db.setItem(key, value); return value;
        });
        testWriteChains.set(db, next.catch(() => undefined)); return next;
    }
    function applicationReference(value: TextGenerationReceipt, previous: unknown) {
        const current = parseTextGenerationReceipt(previous);
        if (!value.configTarget || !value.taskId || value.rejection || !current.configTarget || !current.taskId || current.rejection ||
            receiptKey(current) !== receiptKey(value) || current.priceVersion !== value.priceVersion || current.taskId !== value.taskId ||
            !sameTextConfigBinding(current.configTarget, value.configTarget)) throw storageError();
        return current;
    }
    return Object.freeze({
        async put(value: TextGenerationReceipt): Promise<void> {
            try {
                const next = parseTextGenerationReceipt(value);
                await update(receiptKey(next), previous => mergeReceipt(previous, next));
            } catch { throw storageError(); }
        },
        async claimConfigApplication(value: TextGenerationReceipt): Promise<"claimed" | "pending" | "applied"> {
            try {
                const reference = parseTextGenerationReceipt(value); let result: "claimed" | "pending" | "applied" = "pending";
                await update(receiptKey(reference), previous => {
                    const current = applicationReference(reference, previous);
                    result = current.application ?? "claimed";
                    return current.application ? current : parseTextGenerationReceipt({ ...current, application: "pending" });
                });
                return result;
            } catch { throw storageError(); }
        },
        async completeConfigApplication(value: TextGenerationReceipt): Promise<void> {
            try {
                const reference = parseTextGenerationReceipt(value);
                await update(receiptKey(reference), previous => {
                    const current = applicationReference(reference, previous);
                    if (!current.application) throw storageError();
                    return parseTextGenerationReceipt({ ...current, application: "applied" });
                });
            } catch { throw storageError(); }
        },
        async list(accountId: string, projectId: string): Promise<TextGenerationReceipt[]> {
            try {
                const db = database(), keys = await db.keys(), result: TextGenerationReceipt[] = [];
                for (const key of keys.filter(item => item.startsWith(prefix(accountId, projectId)))) {
                    const value = parseTextGenerationReceipt(await db.getItem(key));
                    if (receiptKey(value) !== key) throw storageError();
                    result.push(value);
                }
                return result;
            } catch { throw storageError(); }
        },
    });
}
export type TextGenerationReceiptStore = ReturnType<typeof createTextGenerationReceiptStore>;
