// Isolated subprocess: real product store/persistence, synthetic IndexedDB only.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
const storage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "window", { value: { localStorage: storage }, configurable: true });
const { useCanvasStore, useCanvasSaveStatus, flushCanvasStorage, saveCanvasMountRecovery } = await import("./use-canvas-store");
const { createCanvasDatabase, CanvasStorageConflict } = await import("./canvas-persistence");
const { createCanvasDocumentMountController } = await import("../../services/saas/canvas-document-mount-controller");
const { validateCanvasDocumentMount } = await import("../../services/saas/canvas-document-mount");
import type { JsonObject } from "../../../../packages/shared/src/index";
import type { CanvasDocumentMountPlan } from "../../services/saas/canvas-document-mount-controller";

if (!useCanvasStore.getState().hydrated) await new Promise<void>((resolve, reject) => {
    const stopState = useCanvasStore.subscribe((state) => { if (state.hydrated) { stopState(); stopStatus(); resolve(); } });
    const stopStatus = useCanvasSaveStatus.subscribe((status) => { if (status.phase === "error") { stopState(); stopStatus(); reject(new Error(status.message)); } });
});
const mode = process.argv[2];
const id = useCanvasStore.getState().createProject("挂载前原稿");
useCanvasStore.getState().updateProject(id, {
    nodes: [{ id: "original-node", type: "text", title: "正文", position: { x: 12, y: 34 }, width: 200, height: 100, metadata: { content: "仅在本机的原正文", status: "success" } } as never],
    viewport: { x: 9, y: 8, k: 1.5 },
});
await flushCanvasStorage();
const original = structuredClone(useCanvasStore.getState().openProject(id)!);
const replacement = { ...structuredClone(original), id: "cloud-project", title: "待挂载云稿", nodes: [{ ...original.nodes[0], metadata: { content: "云端正文", status: "success" } }] };
const readContext = () => ({ accountId: "synthetic-account", epoch: 1, projectId: id, currentProject: useCanvasStore.getState().openProject(id)! as unknown as JsonObject });
const controller = createCanvasDocumentMountController();
const disk = createCanvasDatabase();
let applied = false;
const put = IDBObjectStore.prototype.put;
if (mode === "abort") {
    IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        this.transaction.abort();
        return request;
    };
} else if (mode === "conflict") {
    const baseline = (await disk.read()).state;
    await disk.write(baseline, { ...baseline, projects: baseline.projects.map((project) => ({ ...project, title: "另一窗口已保存" })) });
    useCanvasStore.getState().renameProject(id, "本页未保存的修改");
}
const apply = (plan: CanvasDocumentMountPlan) => {
    applied = true;
    const next = plan.replacementProject as unknown as typeof original;
    useCanvasStore.getState().renameProject(id, next.title);
    useCanvasStore.getState().updateProject(id, next);
};
controller.prepare({ ...readContext(), candidate: validateCanvasDocumentMount(replacement) });
const attempt = controller.commitAfterRecovery(readContext, (plan) => saveCanvasMountRecovery(plan.recoveryProject as typeof original), apply);
assert.equal(applied, false);
assert.equal(useCanvasStore.getState().openProject(id)!.nodes[0].metadata?.content, "仅在本机的原正文");
if (mode === "success") {
    await attempt;
    assert.equal(applied, true);
    // A separate connection sees the durable original copy after the mount.
    const stored = (await disk.read()).state;
    const backup = stored.projects.find((project) => project.id !== id)!;
    assert.ok(backup);
    assert.equal(backup.title, "挂载前原稿（挂载前恢复副本）");
    assert.deepEqual(backup.nodes, original.nodes);
    assert.deepEqual(backup.viewport, original.viewport);
    await flushCanvasStorage();
    await useCanvasStore.persist.rehydrate();
    assert.deepEqual(useCanvasStore.getState().openProject(backup.id), backup);
    assert.equal(useCanvasStore.getState().openProject(id)!.nodes[0].metadata?.content, "云端正文");
} else {
    await assert.rejects(attempt, mode === "conflict" ? CanvasStorageConflict : Error);
    assert.equal(applied, false);
    assert.deepEqual(useCanvasStore.getState().openProject(id)!.nodes, original.nodes);
    assert.equal(useCanvasSaveStatus.getState().phase, mode === "conflict" ? "conflict" : "error");
    IDBObjectStore.prototype.put = put;
    const stored = (await disk.read()).state;
    assert.equal(stored.projects.length, 1);
    assert.deepEqual(stored.projects[0].nodes, original.nodes);
    assert.equal(stored.projects[0].title, mode === "conflict" ? "另一窗口已保存" : original.title);
}
console.log(`Mount recovery ${mode} passed; synthetic IndexedDB, no browser or network.`);
