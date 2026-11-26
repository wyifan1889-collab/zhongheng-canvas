import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createStore } from "zustand/vanilla";
import { persist } from "zustand/middleware";
import { CANVAS_STORE_KEY, CanvasStorageConflict, createCanvasDatabase, createCanvasPersistence, type CanvasSnapshot, type CanvasSaveStatus } from "./canvas-persistence";
import type { CanvasProject } from "./use-canvas-store";

const copy = <T>(value: T): T => structuredClone(value);
const project = (id: string): CanvasProject => ({ id, title: id, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const snapshot = (...ids: string[]): CanvasSnapshot => ({ projects: ids.map(project), deletedProjects: [] });
const edit = (base: CanvasSnapshot, id: string, patch: Partial<CanvasProject>) => ({ ...copy(base), projects: base.projects.map((p) => p.id === id ? { ...copy(p), ...patch, updatedAt: "2026-02-01" } : copy(p)) });
const remove = (base: CanvasSnapshot, id: string): CanvasSnapshot => ({ projects: base.projects.filter((p) => p.id !== id), deletedProjects: [...base.deletedProjects, { id, deletedAt: "2026-02-01" }] });
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

// Each test owns an in-memory IndexedDB factory. Connections share only this test's
// database; the production transaction adapter runs unchanged, without browser data.
async function fixture(state = snapshot("a")) {
    const factory = new IDBFactory();
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open("canvas-test");
        request.onupgradeneeded = () => request.result.createObjectStore("app_state");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const raw = async (value?: string) => {
        const db = await open();
        return new Promise<string>((resolve, reject) => {
            const tx = db.transaction("app_state", value === undefined ? "readonly" : "readwrite");
            const store = tx.objectStore("app_state");
            if (value !== undefined) store.put(value, CANVAS_STORE_KEY);
            const request = store.get(CANVAS_STORE_KEY);
            tx.oncomplete = () => { db.close(); resolve(request.result); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        });
    };
    await raw(JSON.stringify({ state, version: 0 }));
    return { open, raw, database: () => createCanvasDatabase(open, () => null) };
}

test("legacy whole-catalog write loses another tab's new project; transactional delta preserves it", async () => {
    const old = snapshot("a"), newTab = snapshot("b", "a"), oldTab = edit(old, "a", { title: "old tab edit" });
    expect(oldTab.projects.some((p) => p.id === "b")).toBe(false);
    const f = await fixture(old);
    await f.database().write(old, newTab);
    await f.database().write(old, oldTab);
    expect((await f.database().read()).state.projects.map((p) => [p.id, p.title])).toEqual([["b", "b"], ["a", "old tab edit"]]);
});

test("independent connections concurrently create different projects without losing either", async () => {
    const f = await fixture(snapshot());
    const a = f.database(), b = f.database();
    const [beforeA, beforeB] = await Promise.all([a.read(), b.read()]);
    await Promise.all([a.write(beforeA.state, snapshot("a")), b.write(beforeB.state, snapshot("b"))]);
    expect((await a.read()).state.projects.map((p) => p.id).sort()).toEqual(["a", "b"]);
});

test("different canvases may be edited concurrently; old tab cannot resurrect a deleted canvas", async () => {
    const base = snapshot("a", "b"), f = await fixture(base);
    await Promise.all([f.database().write(base, edit(base, "a", { title: "A changed" })), f.database().write(base, edit(base, "b", { title: "B changed" }))]);
    const latest = (await f.database().read()).state;
    expect(latest.projects.map((p) => p.title)).toEqual(["A changed", "B changed"]);
    await f.database().write(latest, remove(latest, "b"));
    await f.database().write(latest, edit(latest, "a", { title: "A again" }));
    const result = (await f.database().read()).state;
    expect(result.projects.map((p) => p.id)).toEqual(["a"]);
    expect(result.deletedProjects.map((p) => p.id)).toEqual(["b"]);
});

test("same canvas concurrent edits commit exactly one version, including different fields", async () => {
    const base = snapshot("a"), f = await fixture(base);
    const outcomes = await Promise.allSettled([
        f.database().write(base, edit(base, "a", { title: "winner A" })),
        f.database().write(base, edit(base, "a", { viewport: { x: 50, y: 0, k: 1 } })),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected").every((r) => r.reason instanceof CanvasStorageConflict)).toBe(true);
    const saved = (await f.database().read()).state.projects[0];
    expect(saved.title === "winner A" ? saved.viewport.x === 0 : saved.viewport.x === 50).toBe(true);
});

for (const deletionFirst of [true, false]) test(`delete/edit conflict preserves first committed version (delete first: ${deletionFirst})`, async () => {
    const base = snapshot("a"), f = await fixture(base), deleted = remove(base, "a"), edited = edit(base, "a", { title: "new" });
    await f.database().write(base, deletionFirst ? deleted : edited);
    const raw = await f.raw();
    await expect(f.database().write(base, deletionFirst ? edited : deleted)).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect(await f.raw()).toBe(raw);
});

for (const nodesFirst of [true, false]) test(`node removal and new connections cannot merge into dangling references (${nodesFirst})`, async () => {
    const base = snapshot("a");
    base.projects[0].nodes = [{ id: "node-a" }, { id: "node-b" }] as CanvasProject["nodes"];
    const f = await fixture(base);
    const nodes = edit(base, "a", { nodes: [{ id: "node-b" }] as CanvasProject["nodes"] });
    const connections = edit(base, "a", { connections: [{ id: "link", fromNodeId: "node-a", toNodeId: "node-b" }] as CanvasProject["connections"] });
    await f.database().write(base, nodesFirst ? nodes : connections);
    const raw = await f.raw();
    await expect(f.database().write(base, nodesFirst ? connections : nodes)).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect(await f.raw()).toBe(raw);
});

test("unchanged/timestamp-only effects never overwrite remote content; equal writes and repeated deletions are idempotent", async () => {
    const base = snapshot("a"), f = await fixture(base), changed = edit(base, "a", { title: "remote" });
    await f.database().write(base, changed);
    const raw = await f.raw();
    await f.database().write(base, edit(base, "a", {}));
    await f.database().write(base, changed);
    expect(await f.raw()).toBe(raw);
    await f.database().write(changed, remove(changed, "a"));
    await f.database().write(changed, { projects: [], deletedProjects: [{ id: "a", deletedAt: "2026-03-01" }] });
    expect((await f.database().read()).state.projects).toEqual([]);
});

test("one conflicting project rolls back the whole batch, preserving unknown envelope/state/plugin fields", async () => {
    const base = snapshot("a", "b"), f = await fixture(base);
    Object.assign(base.projects[0], { pluginData: { unknown: [1, 2, 3] } });
    await f.raw(JSON.stringify({ state: { ...base, futureState: "keep" }, version: 0, futureEnvelope: "keep" }));
    await f.database().write(base, edit(base, "b", { title: "remote" }));
    const raw = await f.raw();
    await expect(f.database().write(base, edit(edit(base, "a", { title: "local A" }), "b", { title: "local B" }))).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect(await f.raw()).toBe(raw);
    const result = JSON.parse(raw);
    expect(result.futureEnvelope).toBe("keep");
    expect(result.state.futureState).toBe("keep");
    expect(result.state.projects[0].pluginData).toEqual({ unknown: [1, 2, 3] });
});

for (const bad of ["{bad", JSON.stringify({ state: snapshot("a"), version: 99 }), JSON.stringify({ state: { projects: [project("a"), project("a")], deletedProjects: [] }, version: 0 })]) {
    test(`invalid storage is never replaced with an empty/default catalog: ${bad.slice(0, 28)}`, async () => {
        const f = await fixture();
        await f.raw(bad);
        await expect(f.database().read()).rejects.toThrow();
        await expect(f.database().write(snapshot(), snapshot("new"))).rejects.toThrow();
        expect(await f.raw()).toBe(bad);
    });
}

test("a localStorage fallback is read-only, never silently promoted or cleared", async () => {
    const f = await fixture(snapshot()), legacy = JSON.stringify({ state: snapshot("legacy"), version: 0 });
    const db = createCanvasDatabase(f.open, () => legacy);
    expect((await db.read()).readOnly).toBeTruthy();
    expect((await db.read()).state.projects[0].id).toBe("legacy");
    await expect(db.write(snapshot("legacy"), snapshot("new"))).rejects.toThrow();
    expect((await f.database().read()).state).toEqual(snapshot());
});

test("transaction abort after put success must reject and leave disk unchanged", async () => {
    const f = await fixture(), raw = await f.raw();
    const db = createCanvasDatabase(async () => {
        const connection = await f.open();
        const original = connection.transaction.bind(connection);
        connection.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
            const tx = original(...args), store = tx.objectStore("app_state"), put = store.put.bind(store);
            store.put = (...values) => { const request = put(...values); request.addEventListener("success", () => tx.abort()); return request; };
            return tx;
        }) as IDBDatabase["transaction"];
        return connection;
    }, () => null);
    await expect(db.write(snapshot("a"), edit(snapshot("a"), "a", { title: "must rollback" }))).rejects.toThrow();
    expect(await f.raw()).toBe(raw);
});

test("Zustand store keeps the losing tab's edits and pauses later automatic writes", async () => {
    const f = await fixture(), statuses: CanvasSaveStatus[] = [];
    const make = () => {
        const controller = createCanvasPersistence(f.database(), (status) => statuses.push(status));
        const store = createStore(persist(() => snapshot(), { name: CANVAS_STORE_KEY, storage: controller.storage, skipHydration: true }));
        return { controller, store };
    };
    const a = make(), b = make();
    await Promise.all([a.store.persist.rehydrate(), b.store.persist.rehydrate()]);
    a.store.setState(edit(a.store.getState(), "a", { title: "A saved" }));
    await a.controller.flush();
    b.store.setState(edit(b.store.getState(), "a", { title: "B unsaved" }));
    await expect(b.controller.flush()).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect(b.store.getState().projects[0].title).toBe("B unsaved");
    b.store.setState(edit(b.store.getState(), "a", { title: "B keeps editing" }));
    await expect(b.controller.flush()).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect((await f.database().read()).state.projects[0].title).toBe("A saved");
    expect(statuses.at(-1)?.phase).toBe("conflict");
    expect(b.store.getState().projects[0].title).toBe("B keeps editing");
});

test("queued writes use only this tab's committed baseline, retaining other tabs' additions", async () => {
    const f = await fixture(), gate = deferred(), started = deferred(), db = f.database(), statuses: CanvasSaveStatus[] = [];
    let writes = 0;
    const controller = createCanvasPersistence({ read: db.read, write: async (base, next) => {
        if (++writes === 1) { started.resolve(); await gate.promise; }
        await db.write(base, next);
    } }, (status) => statuses.push(status));
    const base = (await controller.storage.getItem()).state;
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(base, "a", { title: "one" }) });
    const first = controller.flush();
    await started.promise;
    await f.database().write(base, snapshot("b", "a"));
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(base, "a", { title: "two" }) });
    const otherFlush = controller.flush();
    expect(statuses.at(-1)?.phase).toBe("pending");
    gate.resolve();
    await Promise.all([first, otherFlush]);
    expect((await db.read()).state.projects.map((p) => [p.id, p.title])).toEqual([["b", "b"], ["a", "two"]]);
    expect(writes).toBe(2);
    expect(statuses.at(-1)?.phase).toBe("saved");
});

test("promoting a merged remote body to the tab's baseline would permit stale overwrite; controller rejects it", async () => {
    const f = await fixture(snapshot("a", "b")), db = f.database();
    const controller = createCanvasPersistence(db, () => {}), base = (await controller.storage.getItem()).state;
    await db.write(base, edit(base, "b", { title: "remote B" }));
    const next = edit(base, "a", { title: "local A" });
    controller.storage.setItem(CANVAS_STORE_KEY, { state: next });
    await controller.flush();
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(next, "b", { title: "stale edit B" }) });
    await expect(controller.flush()).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect((await db.read()).state.projects[1].title).toBe("remote B");
});

test("failed deletion/bulk replacement retains pre-operation content for recovery", async () => {
    const f = await fixture(), controller = createCanvasPersistence(f.database(), () => {});
    const base = (await controller.storage.getItem()).state;
    controller.retain(base.projects);
    await f.database().write(base, edit(base, "a", { title: "remote changed" }));
    controller.storage.setItem(CANVAS_STORE_KEY, { state: remove(base, "a") });
    await expect(controller.flush()).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect(controller.recoveryProjects()).toEqual(base.projects);
    expect((await f.database().read()).state.projects[0].title).toBe("remote changed");
});

test("successful deletion discards transient recovery material only after commit", async () => {
    const f = await fixture(), controller = createCanvasPersistence(f.database(), () => {});
    const base = (await controller.storage.getItem()).state;
    controller.retain(base.projects);
    controller.storage.setItem(CANVAS_STORE_KEY, { state: remove(base, "a") });
    expect(controller.recoveryProjects()).toHaveLength(1);
    await controller.flush();
    expect(controller.recoveryProjects()).toEqual([]);
});

test("a deletion queued during an active save keeps its recovery copy if that later deletion conflicts", async () => {
    const f = await fixture(snapshot("a", "b")), db = f.database(), gate = deferred(), started = deferred();
    let writes = 0;
    const controller = createCanvasPersistence({ read: db.read, write: async (base, next) => {
        if (++writes === 1) { started.resolve(); await gate.promise; }
        await db.write(base, next);
    } }, () => {});
    const base = (await controller.storage.getItem()).state, first = edit(base, "a", { title: "A edit" });
    controller.storage.setItem(CANVAS_STORE_KEY, { state: first });
    const flushing = controller.flush();
    await started.promise;
    controller.retain(first.projects.filter((p) => p.id === "b"));
    controller.storage.setItem(CANVAS_STORE_KEY, { state: remove(first, "b") });
    await db.write(base, edit(base, "b", { title: "B remote edit" }));
    gate.resolve();
    await expect(flushing).rejects.toBeInstanceOf(CanvasStorageConflict);
    expect(controller.recoveryProjects()[0].id).toBe("b");
    expect((await db.read()).state.projects.map((p) => p.title)).toEqual(["A edit", "B remote edit"]);
});

test("rehydrating a dirty page cannot discard its pending local draft", async () => {
    const f = await fixture(), controller = createCanvasPersistence(f.database(), () => {});
    const base = (await controller.storage.getItem()).state;
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(base, "a", { title: "dirty" }) });
    await expect(controller.storage.getItem()).rejects.toThrow();
    await controller.flush();
    expect((await f.database().read()).state.projects[0].title).toBe("dirty");
});

test("failed hydration and read-only storage never accept writes or report saved", async () => {
    for (const read of [async () => { throw new Error("private database detail"); }, async () => ({ state: snapshot("a"), readOnly: "read only" })]) {
        const statuses: CanvasSaveStatus[] = [];
        let writes = 0;
        const controller = createCanvasPersistence({ read, write: async () => { writes++; } }, (status) => statuses.push(status));
        try { await controller.storage.getItem(); } catch {}
        controller.storage.setItem(CANVAS_STORE_KEY, { state: snapshot("new") });
        await expect(controller.flush()).rejects.toThrow();
        expect(writes).toBe(0);
        expect(statuses.some((status) => status.phase === "saved")).toBe(false);
        expect(JSON.stringify(statuses)).not.toContain("private database detail");
    }
});

test("quota/write failure and clear requests pause without erasing the existing catalog", async () => {
    const f = await fixture(), db = f.database(), statuses: CanvasSaveStatus[] = [];
    let writes = 0;
    const controller = createCanvasPersistence({ read: db.read, write: async () => { writes++; throw new DOMException("private", "QuotaExceededError"); } }, (status) => statuses.push(status));
    const base = (await controller.storage.getItem()).state;
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(base, "a", { title: "unsaved" }) });
    await expect(controller.flush()).rejects.toThrow();
    controller.storage.setItem(CANVAS_STORE_KEY, { state: snapshot("another") });
    await expect(controller.flush()).rejects.toThrow();
    controller.storage.removeItem();
    expect(writes).toBe(1);
    expect(statuses.at(-1)?.phase).toBe("error");
    expect((await db.read()).state).toEqual(base);
});

test("T2 hydration and timestamp-only no-op do not invent a successful save time", async () => {
    const f = await fixture(), statuses: CanvasSaveStatus[] = [];
    const controller = createCanvasPersistence(f.database(), (status) => statuses.push(status));
    const base = (await controller.storage.getItem()).state;
    expect(statuses.at(-1)).toEqual({ phase: "saved" });
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(base, "a", {}) });
    await controller.flush();
    expect(statuses.at(-1)?.savedAt).toBeUndefined();
    const next = edit(base, "a", { title: "real saved content" }), before = Date.now();
    controller.storage.setItem(CANVAS_STORE_KEY, { state: next });
    await controller.flush();
    const committedAt = statuses.at(-1)?.savedAt;
    expect(committedAt).toBeGreaterThanOrEqual(before);
    expect(committedAt).toBeLessThanOrEqual(Date.now());
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(next, "a", {}) });
    await controller.flush();
    expect(statuses.at(-1)?.savedAt).toBe(committedAt);
});

test("T2 a held write stays pending and only a committed drained queue reports saved time", async () => {
    const f = await fixture(), db = f.database(), gate = deferred(), started = deferred(), statuses: CanvasSaveStatus[] = [];
    let writes = 0;
    const controller = createCanvasPersistence({ read: db.read, write: async (base, next) => {
        if (++writes === 1) { started.resolve(); await gate.promise; }
        return db.write(base, next);
    } }, (status) => statuses.push(status));
    const base = (await controller.storage.getItem()).state;
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(base, "a", { title: "one" }) });
    const flushing = controller.flush();
    await started.promise;
    controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(base, "a", { title: "two" }) });
    expect(statuses.at(-1)).toEqual({ phase: "pending" });
    expect((await db.read()).state).toEqual(base);
    gate.resolve();
    await flushing;
    expect(writes).toBe(2);
    expect(statuses.at(-1)?.phase).toBe("saved");
    expect(statuses.at(-1)?.savedAt).toBeNumber();
    expect((await db.read()).state.projects[0].title).toBe("two");
});

test("T2 failed or conflicting writes keep the original warning and do not publish a new save time", async () => {
    for (const mode of ["error", "conflict"] as const) {
        const f = await fixture(), db = f.database(), statuses: CanvasSaveStatus[] = [];
        let rejectWrite = false;
        const controller = createCanvasPersistence({ read: db.read, write: async (base, next) => {
            if (rejectWrite) throw new DOMException("quota", "QuotaExceededError");
            return db.write(base, next);
        } }, (status) => statuses.push(status));
        const base = (await controller.storage.getItem()).state, saved = edit(base, "a", { title: "saved" });
        controller.storage.setItem(CANVAS_STORE_KEY, { state: saved });
        await controller.flush();
        expect(statuses.at(-1)?.savedAt).toBeNumber();
        if (mode === "conflict") await db.write(saved, edit(saved, "a", { title: "other tab" }));
        else rejectWrite = true;
        controller.storage.setItem(CANVAS_STORE_KEY, { state: edit(saved, "a", { title: "unsaved local" }) });
        await expect(controller.flush()).rejects.toThrow();
        expect(statuses.at(-1)?.phase).toBe(mode);
        expect(statuses.at(-1)?.message).toContain("保存已暂停");
        expect(statuses.at(-1)?.savedAt).toBeUndefined();
        expect((await db.read()).state.projects[0].title).toBe(mode === "conflict" ? "other tab" : "saved");
    }
});
