// Run only in a fresh subprocess: prototype interception must never affect other tests.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createMountPersistenceGate, type GatePhase } from "./mount-persistence-gate";

const storage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true });
const { useCanvasStore, useCanvasSaveStatus, flushCanvasStorage, saveCanvasMountRecovery } = await import("../src/stores/canvas/use-canvas-store");
const { createCanvasDatabase } = await import("../src/stores/canvas/canvas-persistence");
if (!useCanvasStore.getState().hydrated) await new Promise<void>((resolve, reject) => {
    const stop = useCanvasStore.subscribe((state) => { if (state.hydrated) { stop(); stopError(); resolve(); } });
    const stopError = useCanvasSaveStatus.subscribe((state) => { if (state.phase === "error") { stop(); stopError(); reject(new Error(state.message)); } });
});
const mode = process.argv[2], key = "infinite-canvas:canvas_store";
const id = useCanvasStore.getState().createProject("门控合成原稿");
await flushCanvasStorage();
const original = structuredClone(useCanvasStore.getState().openProject(id)!);
// An existing identically named recovery copy must never be mistaken for a new one.
const oldCopyId = await saveCanvasMountRecovery(original);
const disk = createCanvasDatabase(), nativePut = IDBObjectStore.prototype.put;
const phases: GatePhase[] = [];
let captured!: () => void;
const pending = new Promise<void>((resolve) => { captured = resolve; });
const gate = createMountPersistenceGate((phase) => { phases.push(phase); if (phase === "pending") captured(); });
const baseline = (await disk.read()).state;
const envelope = (projects: typeof baseline.projects) => JSON.stringify({ state: { projects, deletedProjects: [] }, version: 0 });
const candidate = { ...original, id: "synthetic-new-copy", title: original.title + "（挂载前恢复副本）", updatedAt: new Date().toISOString() };

async function rawPut(name: string, store: string, value: string, writeKey = key, put = IDBObjectStore.prototype.put) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(store, "readwrite");
            tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("aborted"));
            const request = put.call(tx.objectStore(store), value, writeKey);
            assert.ok(request instanceof IDBRequest); // return the actual native request, not a replacement Promise
        });
    } finally { db.close(); }
}

try {
    // Creating a gate does not patch anything; a normal product write before arming still commits.
    assert.equal(IDBObjectStore.prototype.put, nativePut);
    useCanvasStore.getState().updateProject(oldCopyId, { showImageInfo: true });
    await flushCanvasStorage();
    assert.equal(gate.phase, "idle");
    assert.equal((await disk.read()).state.projects.find((project) => project.id === oldCopyId)!.showImageInfo, true);
    await gate.arm(id);
    await assert.rejects(gate.arm(id));
    assert.equal(gate.phase, "armed");

    if (mode === "selection") {
        // Ordinary persistence, including a same-name existing copy, is not intercepted.
        useCanvasStore.getState().updateProject(oldCopyId, { showImageInfo: false });
        await flushCanvasStorage();
        assert.equal(gate.phase, "armed");
        const afterOrdinarySave = (await disk.read()).state;
        assert.equal(afterOrdinarySave.projects.length, 2);
        assert.equal(afterOrdinarySave.projects.find((project) => project.id === oldCopyId)!.showImageInfo, false);
        assert.deepEqual(afterOrdinarySave.projects.find((project) => project.id === id), original);
        const encoded = envelope([candidate, ...baseline.projects]);
        await rawPut("other-database", "app_state", encoded);
        await rawPut("infinite-canvas", "app_state", encoded, "unrelated-key");
        await rawPut("other-store-database", "another_store", encoded);
        assert.equal(gate.phase, "armed");
        assert.deepEqual((await disk.read()).state, afterOrdinarySave);
        assert.equal(gate.release(), false);
        assert.equal(gate.abort(), false);
    } else if (mode === "foreign") {
        // A different realm's already-committed copy is represented by the saved native method.
        // Arm-time IDs alone would capture the subsequent put incorrectly; same-tx read must reject it.
        const encoded = envelope([candidate, ...(await disk.read()).state.projects]);
        await rawPut("infinite-canvas", "app_state", encoded, key, nativePut);
        await rawPut("infinite-canvas", "app_state", encoded);
        assert.equal(gate.phase, "bypassed");
        assert.equal(phases.includes("pending"), false);
        assert.equal((await disk.read()).state.projects.length, 3);
    } else {
        const before = (await disk.read()).state;
        // Exercise the existing product store path, including its pre-flush and real recovery import.
        const attempt = saveCanvasMountRecovery(original);
        const outcome = attempt.then((copyId) => ({ copyId }), (error: unknown) => ({ error }));
        await pending;
        assert.equal(gate.phase, "pending");
        assert.equal(IDBObjectStore.prototype.put, nativePut); // one-shot interceptor is already removed
        let settled = false, readSettled = false;
        void outcome.then(() => { settled = true; });
        const independentRead = disk.read().then((value) => { readSettled = true; return value.state; });
        // A readonly transaction on another connection must block behind the held write, not see uncommitted data.
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(settled, false); assert.equal(readSettled, false);
        await assert.rejects(gate.arm(id));
        if (mode === "release") {
            assert.equal(gate.release(), true); assert.equal(gate.release(), false); assert.equal(gate.abort(), false);
            const result = await outcome;
            assert.ok("copyId" in result);
            assert.equal(gate.phase, "committed");
            const stored = await independentRead;
            const copy = stored.projects.find((project) => project.id === result.copyId)!;
            assert.equal(stored.projects.length, before.projects.length + 1);
            assert.deepEqual(copy.nodes, original.nodes); assert.deepEqual(copy.viewport, original.viewport);
            assert.equal(copy.title, original.title + "（挂载前恢复副本）");
            assert.equal(phases.filter((phase) => phase === "committed").length, 1);
        } else {
            if (mode === "abort") { assert.equal(gate.abort(), true); assert.equal(gate.abort(), false); }
            else { assert.equal(mode, "dispose"); gate.dispose(); gate.dispose(); }
            assert.equal(gate.release(), false);
            assert.ok("error" in await outcome);
            assert.deepEqual(await independentRead, before);
            assert.equal(useCanvasSaveStatus.getState().phase, "error");
            // The product has imported the recovery in memory, but the native transaction did not persist it.
            assert.equal(useCanvasStore.getState().projects.length, before.projects.length + 1);
            assert.equal(gate.phase, mode === "abort" ? "aborted" : "disposed");
            assert.equal(phases.filter((phase) => phase === "committed").length, 0);
        }
    }
} finally { gate.dispose(); }
assert.equal(IDBObjectStore.prototype.put, nativePut);
console.log(`Native mount persistence gate ${mode} passed; isolated fake IndexedDB + product store, no browser.`);
