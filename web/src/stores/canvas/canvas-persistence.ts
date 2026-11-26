import localforage from "localforage";
import type { CanvasDeletedProject, CanvasProject } from "./use-canvas-store";

export const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
export type CanvasSnapshot = { projects: CanvasProject[]; deletedProjects: CanvasDeletedProject[] };
export type CanvasSaveStatus = { phase: "loading" | "saved" | "pending" | "conflict" | "error"; message?: string; savedAt?: number };
type Envelope = { state: CanvasSnapshot; version?: number };
export type CanvasDatabase = {
    read(): Promise<{ state: CanvasSnapshot; readOnly?: string }>;
    write(base: CanvasSnapshot, next: CanvasSnapshot): Promise<boolean | void>;
};

export class CanvasStorageConflict extends Error {
    constructor() {
        super("另一个标签已修改或删除同一画布，本页本机保存已暂停。已保存版本未被覆盖，本页内容仍可导出。");
    }
}
const storageError = () => new Error("本机存储读写未完成，保存已暂停。请先导出本页内容，保留当前页面；不要直接刷新或关闭。");
const empty = (): CanvasSnapshot => ({ projects: [], deletedProjects: [] });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]));
const body = (project: CanvasProject) => {
    const { updatedAt: _, ...content } = project;
    return content;
};

function decode(value: unknown): Envelope {
    if (value === undefined) return { state: empty(), version: 0 };
    if (typeof value !== "string") throw storageError();
    const data: unknown = JSON.parse(value);
    if (!record(data) || (data.version !== undefined && data.version !== 0) || !record(data.state)) throw storageError();
    const { projects, deletedProjects } = data.state;
    for (const entries of [projects, deletedProjects]) {
        if (!Array.isArray(entries) || entries.some((item) => !record(item) || typeof item.id !== "string" || !item.id) ||
            new Set(entries.map((item) => item.id)).size !== entries.length) throw storageError();
    }
    if ((projects as CanvasProject[]).some((item) => typeof item.title !== "string" || !Array.isArray(item.nodes) || !Array.isArray(item.connections)) ||
        (deletedProjects as CanvasDeletedProject[]).some((item) => typeof item.deletedAt !== "string")) throw storageError();
    const deleted = new Set((deletedProjects as CanvasDeletedProject[]).map((item) => item.id));
    if ((projects as CanvasProject[]).some((item) => deleted.has(item.id))) throw storageError();
    return data as Envelope;
}

/** Only this tab's changes are applied; timestamps never establish a write baseline. */
export function mergeCanvasChanges(base: CanvasSnapshot, next: CanvasSnapshot, current: CanvasSnapshot): CanvasSnapshot {
    const before = byId(base.projects), after = byId(next.projects), projects = byId(current.projects);
    const oldDeleted = byId(base.deletedProjects), nextDeleted = byId(next.deletedProjects), deleted = byId(current.deletedProjects);
    const additions: string[] = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(id), proposed = after.get(id), stored = projects.get(id);
        if (previous && proposed) {
            if (equal(body(previous), body(proposed))) continue;
            if (!stored || !equal(oldDeleted.get(id), deleted.get(id))) throw new CanvasStorageConflict();
            // One canvas is the conflict unit: nodes/connections and chat/active chat
            // must not be independently merged into an internally inconsistent document.
            if (!equal(body(stored), body(previous)) && !equal(body(stored), body(proposed))) throw new CanvasStorageConflict();
            projects.set(id, proposed);
        } else if (proposed) {
            if (!equal(oldDeleted.get(id), deleted.get(id)) || (stored && !equal(body(stored), body(proposed)))) throw new CanvasStorageConflict();
            if (!stored) { projects.set(id, proposed); additions.push(id); }
        } else if (previous && stored) {
            if (!equal(body(stored), body(previous))) throw new CanvasStorageConflict();
            projects.delete(id);
        }
    }
    for (const id of new Set([...oldDeleted.keys(), ...nextDeleted.keys()])) {
        const previous = oldDeleted.get(id), proposed = nextDeleted.get(id), stored = deleted.get(id);
        if (equal(previous, proposed)) continue;
        if (proposed && projects.has(id)) throw new CanvasStorageConflict();
        if (!equal(previous, stored) && !equal(proposed, stored)) {
            if (proposed && stored && !projects.has(id)) continue; // Two deletions do not resurrect a project.
            throw new CanvasStorageConflict();
        }
        if (proposed) deleted.set(id, proposed);
        else deleted.delete(id);
    }
    return {
        ...current,
        projects: [...additions.map((id) => projects.get(id)!), ...current.projects.flatMap((item) => projects.has(item.id) ? [projects.get(item.id)!] : [])],
        deletedProjects: [...deleted.values()],
    };
}

const canvasDatabaseStore = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state", driver: [localforage.INDEXEDDB] });
async function openCanvasDatabase(): Promise<IDBDatabase> {
    // Use public localforage initialization, not its private driver/database fields.
    await canvasDatabaseStore.ready();
    return new Promise((resolve, reject) => {
        let failed = false;
        const request = indexedDB.open("infinite-canvas");
        request.onerror = request.onblocked = () => { failed = true; reject(storageError()); };
        request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
    });
}

/** The read/compare/write share one readwrite transaction, including across connections/tabs. */
export function createCanvasDatabase(
    open: () => Promise<IDBDatabase> = openCanvasDatabase,
    readFallback: () => string | null = () => typeof window === "undefined" ? null : window.localStorage.getItem(CANVAS_STORE_KEY),
): CanvasDatabase {
    function transaction(write?: (value: Envelope) => Envelope): Promise<Envelope> {
        return open().then((db) => new Promise<Envelope>((resolve, reject) => {
            let result: Envelope, failure: unknown;
            let tx: IDBTransaction;
            try { tx = db.transaction("app_state", write ? "readwrite" : "readonly"); }
            catch { db.close(); reject(storageError()); return; }
            db.onversionchange = () => db.close();
            tx.oncomplete = () => { db.close(); resolve(result); };
            tx.onabort = () => { db.close(); reject(failure ?? storageError()); };
            tx.onerror = () => { failure ??= storageError(); };
            const store = tx.objectStore("app_state"), request = store.get(CANVAS_STORE_KEY);
            request.onsuccess = () => {
                try {
                    const previous = decode(request.result);
                    result = write ? write(previous) : previous;
                    if (write && !equal(previous, result)) {
                        const encoded = JSON.stringify(result);
                        decode(encoded);
                        store.put(encoded, CANVAS_STORE_KEY);
                    }
                } catch (error) { failure = error; tx.abort(); }
            };
        }));
    }
    let readOnly = false;
    return {
        async read() {
            const fallback = readFallback();
            try {
                const result = await transaction();
                if (fallback !== null) {
                    readOnly = true;
                    const legacy = decode(fallback);
                    return {
                        state: result.state.projects.length || result.state.deletedProjects.length ? result.state : legacy.state,
                        readOnly: "检测到备用本机存储副本，已暂停写入。导出仅包含当前展示内容，另一份仍在原存储中；请保留页面，分别核对后再处理。",
                    };
                }
                return { state: result.state };
            } catch (error) {
                if (fallback === null) throw error;
                readOnly = true;
                return { state: decode(fallback).state, readOnly: "主存储无法读取，当前仅展示备用副本供导出。自动保存已暂停，原数据没有被覆盖。" };
            }
        },
        async write(base, next) {
            if (readOnly || readFallback() !== null) throw storageError();
            let changed = false;
            await transaction((current) => {
                const merged = { ...current, state: mergeCanvasChanges(base, next, current.state) };
                changed = !equal(current, merged);
                return merged;
            });
            return changed;
        },
    };
}

/** A tab's baseline advances only after its transaction completes, never after a latest-value read. */
export function createCanvasPersistence(database: CanvasDatabase, onStatus: (status: CanvasSaveStatus) => void) {
    let baseline: CanvasSnapshot | null = null, requested: CanvasSnapshot | null = null, pending: CanvasSnapshot | null = null;
    let recovery: CanvasProject[] = [];
    let savedAt: number | undefined;
    let active: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null, failure: Error | null = null;
    const pause = (error: unknown) => {
        failure = error instanceof CanvasStorageConflict ? error : storageError();
        pending = null;
        if (timer) clearTimeout(timer);
        timer = null;
        onStatus({ phase: failure instanceof CanvasStorageConflict ? "conflict" : "error", message: failure.message });
    };
    async function flush(): Promise<void> {
        while (active) await active;
        if (failure) throw failure;
        if (!baseline) throw storageError();
        if (!pending) return;
        if (timer) clearTimeout(timer);
        timer = null;
        let next: CanvasSnapshot;
        try { next = clone(pending); }
        catch (error) { pause(error); throw failure; }
        pending = null;
        active = (async () => {
            try {
                if (await database.write(baseline!, next) === true) savedAt = Date.now();
                baseline = next;
                if (!pending) recovery = [];
                onStatus({ phase: pending ? "pending" : "saved", savedAt });
            } catch (error) { pause(error); throw failure; }
            finally { active = null; }
        })();
        await active;
        if (pending) await flush();
    }
    const storage = {
        async getItem() {
            // Rehydrating a live, dirty tab would discard its uncommitted content/baseline.
            if (pending || active || failure) throw failure ?? storageError();
            try {
                const result = await database.read();
                baseline = clone(result.state);
                requested = result.state;
                if (result.readOnly) {
                    failure = new Error(result.readOnly);
                    onStatus({ phase: "error", message: result.readOnly });
                } else onStatus({ phase: "saved" });
                return { state: result.state, version: 0 };
            } catch (error) { pause(error); throw failure; }
        },
        setItem(_name: string, value: { state: CanvasSnapshot }) {
            const next = value.state;
            if (requested?.projects === next.projects && requested?.deletedProjects === next.deletedProjects) return;
            requested = next;
            if (!baseline || failure) return;
            pending = next;
            onStatus({ phase: "pending" });
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { void flush().catch(() => {}); }, 400);
        },
        removeItem() { pause(storageError()); }, // No caller may clear the entire catalog behind other tabs.
    };
    return {
        storage, flush,
        retain(projects: CanvasProject[]) {
            recovery = [...recovery, ...clone(projects.filter((project) => !recovery.some((old) => equal(old, project))))];
        },
        recoveryProjects: () => recovery,
    };
}
