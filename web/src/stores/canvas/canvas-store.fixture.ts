// Only the subprocess test executes this fixture; globals never enter other tests.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true });
const { flushCanvasStorage, getCanvasRecoveryProjects, useCanvasSaveStatus, useCanvasStore } = await import("./use-canvas-store");
const { CanvasStorageConflict, createCanvasDatabase } = await import("./canvas-persistence");

async function run() {
    if (!useCanvasStore.getState().hydrated) await new Promise<void>((resolve, reject) => {
        const stopState = useCanvasStore.subscribe((state) => { if (state.hydrated) { stopState(); stopStatus(); resolve(); } });
        const stopStatus = useCanvasSaveStatus.subscribe((status) => { if (status.phase === "error") { stopState(); stopStatus(); reject(new Error(status.message)); } });
        if (useCanvasSaveStatus.getState().phase === "error") { stopState(); stopStatus(); reject(new Error("initialization failed")); }
    });
    const id = useCanvasStore.getState().createProject("original");
    await flushCanvasStorage();
    const beforeDownload = useCanvasStore.getState();
    const merged = beforeDownload.projects.map((p) => ({ ...p, title: "WebDAV remote" }));
    useCanvasStore.getState().renameProject(id, "edited while downloading");
    await assert.rejects(useCanvasStore.getState().replaceProjects(merged, [], beforeDownload), CanvasStorageConflict);
    assert.equal(useCanvasStore.getState().projects[0].title, "edited while downloading");
    await flushCanvasStorage();

    const current = useCanvasStore.getState(), external = createCanvasDatabase();
    const baseline = (await external.read()).state;
    await external.write(baseline, { ...baseline, projects: baseline.projects.map((p) => ({ ...p, title: "other tab saved" })) });
    await assert.rejects(useCanvasStore.getState().replaceProjects(merged, [], current), CanvasStorageConflict);
    assert.equal(useCanvasSaveStatus.getState().phase, "conflict");
    assert.equal((await external.read()).state.projects[0].title, "other tab saved");
    assert.deepEqual(getCanvasRecoveryProjects().map((p) => p.title), ["WebDAV remote", "edited while downloading（操作前恢复副本）"]);

    useCanvasStore.getState().deleteProjects([id]);
    await assert.rejects(flushCanvasStorage(), CanvasStorageConflict);
    assert.ok(getCanvasRecoveryProjects().map((p) => p.title).includes("WebDAV remote（操作前恢复副本）"));
    assert.equal((await external.read()).state.projects[0].title, "other tab saved");
}
await run();
console.log("Synthetic real-store integration passed (9 assertions); no browser or remote WebDAV used.");
