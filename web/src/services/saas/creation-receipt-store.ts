import localforage from "localforage";

export type CreationReceipt = {
    readonly accountId: string;
    readonly localProjectId: string;
    readonly creationId: string;
};
export type CreationReceiptBacking = {
    getItem(key: string): Promise<unknown>;
    setItem(key: string, value: CreationReceipt): Promise<unknown>;
    keys(): Promise<string[]>;
    /** Atomically claim the account/project slot for this creation ID. */
    claim?(key: string, value: CreationReceipt): Promise<"claimed" | "existing" | "busy">;
};

export class ReceiptStorageError extends Error {
    constructor() {
        super("本机保存回执读写未完成，请保留当前内容，不要自动重传或覆盖。");
        this.name = "ReceiptStorageError";
    }
}

const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields = ["accountId", "localProjectId", "creationId"] as const;
const scopeKey = (accountId: string, localProjectId: string) => JSON.stringify([accountId, localProjectId]);
const receiptKey = (receipt: CreationReceipt) => `${scopeKey(receipt.accountId, receipt.localProjectId)}:v1:${receipt.creationId}`;
const scopePrefix = (receipt: CreationReceipt) => `${scopeKey(receipt.accountId, receipt.localProjectId)}:v1:`;

function receipt(value: unknown, stored = false): CreationReceipt {
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new ReceiptStorageError();
    if (stored && (Reflect.ownKeys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key)))) throw new ReceiptStorageError();
    const properties = fields.map((key) => Object.getOwnPropertyDescriptor(value, key));
    if (properties.some((property) => !property?.enumerable || !("value" in property))) throw new ReceiptStorageError();
    const [accountId, localProjectId, creationId] = properties.map((property) => property!.value);
    if (!identity(accountId) || !identity(localProjectId) || !uuid(creationId) || (stored && creationId !== creationId.toLowerCase())) throw new ReceiptStorageError();
    // Deliberately ignore extra input fields, without reading them or retaining the input object.
    return Object.freeze({ accountId, localProjectId, creationId: creationId.toLowerCase() });
}

async function storedKeys(db: CreationReceiptBacking): Promise<string[]> {
    const keys = await db.keys();
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) throw new ReceiptStorageError();
    return keys;
}

/**
 * The localforage get/set pair used by the append-only receipt path is not a
 * cross-tab compare-and-set. The claim path uses one IndexedDB transaction so
 * a second tab cannot reserve another creation ID for the same project.
 */
async function claimWithIndexedDb(key: string, value: CreationReceipt): Promise<"claimed" | "existing" | "busy"> {
    if (typeof indexedDB === "undefined") throw new ReceiptStorageError();
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("infinite-canvas-saas-receipts");
        request.onerror = () => reject(new ReceiptStorageError());
        request.onblocked = () => reject(new ReceiptStorageError());
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains("creation_receipts")) database.createObjectStore("creation_receipts");
        };
        request.onsuccess = () => {
            const connection = request.result;
            let outcome: "claimed" | "existing" | "busy" | undefined;
            let existing = false, busy = false;
            let failure: unknown;
            let transaction: IDBTransaction;
            try { transaction = connection.transaction("creation_receipts", "readwrite"); }
            catch { connection.close(); reject(new ReceiptStorageError()); return; }
            connection.onversionchange = () => connection.close();
            transaction.oncomplete = () => { connection.close(); outcome ? resolve(outcome) : reject(new ReceiptStorageError()); };
            transaction.onerror = () => { failure ??= new ReceiptStorageError(); };
            transaction.onabort = () => { connection.close(); reject(failure ?? new ReceiptStorageError()); };
            const store = transaction.objectStore("creation_receipts");
            const cursor = store.openCursor();
            cursor.onerror = () => { failure ??= new ReceiptStorageError(); transaction.abort(); };
            cursor.onsuccess = () => {
                try {
                    const current = cursor.result;
                    if (current) {
                        const currentKey = typeof current.key === "string" ? current.key : "";
                        if (currentKey.startsWith(scopePrefix(value))) {
                            const stored = receipt(current.value, true);
                            if (receiptKey(stored) !== currentKey) throw new ReceiptStorageError();
                            if (stored.creationId === value.creationId) existing = true;
                            else busy = true;
                        }
                        current.continue();
                        return;
                    }
                    outcome ??= existing ? "existing" : busy ? "busy" : "claimed";
                    if (outcome === "claimed") store.put(value, key);
                } catch (error) { failure = error; transaction.abort(); }
            };
        };
    });
}

/** Append-only recovery hints plus an explicit same-project first-save claim. */
export function createCreationReceiptStore(backing?: CreationReceiptBacking) {
    let storage = backing;
    let defaultDatabase: ReturnType<typeof localforage.createInstance> | undefined;
    function database(): CreationReceiptBacking {
        // The original application store may fall back to localStorage; this isolated one must not.
        if (storage) return storage;
        defaultDatabase ??= localforage.createInstance({
            name: "infinite-canvas-saas-receipts", storeName: "creation_receipts", driver: [localforage.INDEXEDDB],
        });
        return storage = {
            getItem: (key) => defaultDatabase!.getItem(key),
            setItem: (key, value) => defaultDatabase!.setItem(key, value),
            keys: () => defaultDatabase!.keys(),
            claim: (key, value) => claimWithIndexedDb(key, value),
        };
    }
    return Object.freeze({
        async claim(value: CreationReceipt): Promise<"claimed" | "existing" | "busy"> {
            try {
                const next = receipt(value), key = receiptKey(next), db = database();
                if (db.claim) return await db.claim(key, next);
                // Custom test backings from older callers have no transaction
                // primitive; preserve their append-only behavior explicitly.
                return "claimed";
            } catch { throw new ReceiptStorageError(); }
        },
        async put(value: CreationReceipt): Promise<void> {
            try {
                const next = receipt(value), key = receiptKey(next), db = database();
                // getItem alone cannot distinguish a stored null (corruption) from a missing key.
                const keys = await storedKeys(db);
                const previous = await db.getItem(key);
                if (previous !== null || keys.includes(key)) {
                    // Never silently repair an existing malformed or mismatched record.
                    if (receiptKey(receipt(previous, true)) !== key) throw new ReceiptStorageError();
                    return;
                }
                // localforage's IndexedDB promise resolves after transaction completion.
                // Different creation IDs have separate keys; get/set is not a single transaction.
                await db.setItem(key, next);
            } catch { throw new ReceiptStorageError(); }
        },
        async list(accountId: string, localProjectId: string): Promise<CreationReceipt[]> {
            try {
                if (!identity(accountId) || !identity(localProjectId)) throw new ReceiptStorageError();
                const prefix = scopeKey(accountId, localProjectId), db = database(), keys = await storedKeys(db);
                const receipts: CreationReceipt[] = [];
                for (const key of keys) {
                    if (!key.startsWith(prefix)) continue;
                    const suffix = key.slice(prefix.length);
                    if (!suffix.startsWith(":v1:") || !uuid(suffix.slice(4)) || suffix !== suffix.toLowerCase()) throw new ReceiptStorageError();
                    const current = receipt(await db.getItem(key), true);
                    if (receiptKey(current) !== key) throw new ReceiptStorageError();
                    receipts.push(current);
                }
                return receipts;
            } catch { throw new ReceiptStorageError(); }
        },
    });
}
