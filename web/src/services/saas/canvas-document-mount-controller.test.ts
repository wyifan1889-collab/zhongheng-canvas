import { expect, test } from "bun:test";
import type { JsonObject } from "../../../../packages/shared/src/index";
import { validateCanvasDocumentMount } from "./canvas-document-mount";
import { CanvasDocumentMountControllerError, createCanvasDocumentMountController, type CanvasDocumentMountContext } from "./canvas-document-mount-controller";

const project = (id = "source-project", title = "源画布"): JsonObject => ({
    id, title, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    nodes: [{ id: "node-1", type: "text", title: "文本", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content: "正文", status: "success" } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});
const candidate = () => validateCanvasDocumentMount(project("draft-project", "账号草稿"));
const context = (overrides: Partial<CanvasDocumentMountContext> = {}): CanvasDocumentMountContext => ({ accountId: "account-a", epoch: 3, projectId: "local-project", currentProject: project("local-project", "当前画布"), candidate: candidate(), ...overrides });
const failure = async (action: () => unknown, code: string) => {
    const error = await Promise.resolve().then(action).catch((value) => value);
    expect(error).toBeInstanceOf(CanvasDocumentMountControllerError);
    expect((error as CanvasDocumentMountControllerError).code).toBe(code);
    expect(String(error)).not.toContain("正文");
};

test("prepare creates a detached replacement and recovery copy without changing the input", () => {
    const source = context(), controller = createCanvasDocumentMountController(), plan = controller.prepare(source);
    expect(plan.targetProjectId).toBe("local-project");
    expect(plan.replacementProject.id).toBe("local-project");
    expect(plan.replacementProject.title).toBe("账号草稿");
    expect(plan.recoveryProject).toEqual(source.currentProject);
    expect(plan.replacementProject).not.toBe(source.candidate.project);
    (plan.replacementProject.nodes as JsonObject[])[0].title = "changed";
    expect((source.candidate.project.nodes as JsonObject[])[0].title).toBe("文本");
});

test("mount plan carries hydrated media preview ownership through commit", () => {
    const previewUrl = "blob:cloud-preview";
    const source = context({ mediaObjectUrls: [previewUrl] });
    const controller = createCanvasDocumentMountController();
    const prepared = controller.prepare(source);
    expect(prepared.mediaObjectUrls).toEqual([previewUrl]);
    const committed = controller.commit(source);
    expect(committed.mediaObjectUrls).toEqual([previewUrl]);
});

test("commit requires the same account epoch, project and current body", async () => {
    const source = context(), controller = createCanvasDocumentMountController();
    controller.prepare(source);
    const result = controller.commit({ accountId: source.accountId, epoch: source.epoch, projectId: source.projectId, currentProject: { ...source.currentProject, updatedAt: "2026-01-03T00:00:00.000Z" } });
    expect(result.replacementProject.id).toBe(source.projectId);
    expect(controller.getPlan()).toBeNull();
    for (const patch of [
        { accountId: "account-b" },
        { epoch: 4 },
        { projectId: "other-project" },
        { currentProject: { ...source.currentProject, title: "已编辑" } },
    ]) {
        const next = createCanvasDocumentMountController();
        next.prepare(source);
        await failure(() => next.commit({ accountId: source.accountId, epoch: source.epoch, projectId: source.projectId, currentProject: source.currentProject, ...patch }), "context_changed");
    }
});

test("a plan is single-use and disposal rejects later operations", async () => {
    const controller = createCanvasDocumentMountController(), source = context();
    controller.prepare(source);
    controller.commit(source);
    await failure(() => controller.commit(source), "already_used");
    const closed = createCanvasDocumentMountController();
    closed.prepare(source); closed.dispose();
    await failure(() => closed.getPlan(), "closed");
    await failure(() => closed.prepare(source), "closed");
});

test("invalid context is rejected before a replacement plan is created", async () => {
    const controller = createCanvasDocumentMountController();
    await failure(() => controller.prepare({ ...context(), accountId: "" }), "invalid_context");
    await failure(() => controller.prepare({ ...context(), epoch: -1 }), "invalid_context");
    await failure(() => controller.prepare({ ...context(), projectId: "" }), "invalid_context");
});

test("cloud metadata is scoped and detached; local mounts never establish a cloud baseline", async () => {
    const cloud = { accountId: "account-a", id: "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef", revision: 7 };
    const source = context({ cloudVersion: cloud }), controller = createCanvasDocumentMountController();
    const plan = controller.prepare(source);
    expect(plan.cloudVersion).toMatchObject({ ...cloud, epoch: 3, localProjectId: "local-project" });
    cloud.revision = 99;
    expect(controller.commit(source).cloudVersion?.revision).toBe(7);
    expect(createCanvasDocumentMountController().prepare(context()).cloudVersion).toBeNull();
    for (const patch of [{ accountId: "other" }, { id: "invalid" }, { revision: 0 }]) {
        await failure(() => createCanvasDocumentMountController().prepare(context({ cloudVersion: { ...cloud, ...patch } })), "invalid_context");
    }
});

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test("async commit waits for recovery persistence and then consumes the plan once", async () => {
    const source = context(), controller = createCanvasDocumentMountController(), saved = deferred();
    controller.prepare(source);
    let reads = 0, writes = 0, committed = false;
    const result = controller.commitAfterRecovery(() => { reads++; return source; }, async (plan) => {
        writes++;
        expect(plan.recoveryProject).toEqual(source.currentProject);
        plan.recoveryProject.title = "modified callback copy";
        await saved.promise;
    }).then((plan) => { committed = true; return plan; });
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    expect(committed).toBe(false);
    expect(controller.getPlan()?.recoveryProject.title).toBe("当前画布");
    saved.resolve();
    expect((await result).recoveryProject).toEqual(source.currentProject);
    expect(reads).toBe(2);
    expect(controller.getPlan()).toBeNull();
    await failure(() => controller.commitAfterRecovery(() => source, async () => { writes++; }), "already_used");
    expect(writes).toBe(1);
});

test("async commit rejects stale context before attempting recovery persistence", async () => {
    const source = context(), controller = createCanvasDocumentMountController();
    controller.prepare(source);
    let writes = 0;
    await failure(() => controller.commitAfterRecovery(() => ({ ...source, epoch: 4 }), async () => { writes++; }), "context_changed");
    expect(writes).toBe(0);
    expect(controller.getPlan()).not.toBeNull();
});

test("async commit blocks duplicate submissions and synchronous prepare/commit while saving", async () => {
    const source = context(), controller = createCanvasDocumentMountController(), saved = deferred();
    controller.prepare(source);
    let writes = 0;
    const result = controller.commitAfterRecovery(() => source, async () => { writes++; await saved.promise; });
    await failure(() => controller.commitAfterRecovery(() => source, async () => { writes++; }), "pending");
    await failure(() => controller.prepare(source), "pending");
    await failure(() => controller.commit(source), "pending");
    expect(writes).toBe(1);
    saved.resolve();
    expect((await result).targetProjectId).toBe(source.projectId);
});

test("account, epoch, project or live body changes while saving prevent a late mount", async () => {
    for (const patch of [
        { accountId: "account-b" }, { epoch: 4 }, { projectId: "another-project" },
        { currentProject: { ...project("local-project", "当前画布"), nodes: [] } },
    ]) {
        const source = context(), controller = createCanvasDocumentMountController(), saved = deferred();
        controller.prepare(source);
        let current = source;
        const result = controller.commitAfterRecovery(() => current, async () => saved.promise);
        current = { ...source, ...patch };
        saved.resolve();
        await failure(() => result, "context_changed");
        expect(controller.getPlan()?.recoveryProject).toEqual(source.currentProject);
    }
});

test("a timestamp-only change remains valid after recovery persistence", async () => {
    const source = context(), controller = createCanvasDocumentMountController(), saved = deferred();
    controller.prepare(source);
    let current = source;
    const result = controller.commitAfterRecovery(() => current, async () => saved.promise);
    current = { ...source, currentProject: { ...source.currentProject, updatedAt: "2026-01-04T00:00:00.000Z" } };
    saved.resolve();
    expect((await result).recoveryProject).toEqual(source.currentProject);
});

test("closing while saving rejects the late result and never reopens the controller", async () => {
    const source = context(), controller = createCanvasDocumentMountController(), saved = deferred();
    controller.prepare(source);
    let reads = 0;
    const result = controller.commitAfterRecovery(() => { reads++; return source; }, async () => saved.promise);
    controller.dispose();
    saved.resolve();
    await failure(() => result, "closed");
    expect(reads).toBe(1);
    await failure(() => controller.prepare(source), "closed");
});

test("failed recovery persistence leaves the plan available for an explicit retry", async () => {
    const source = context(), controller = createCanvasDocumentMountController(), saved = deferred();
    controller.prepare(source);
    const persistenceError = new Error("recovery persistence failed");
    const result = controller.commitAfterRecovery(() => source, async () => saved.promise);
    saved.reject(persistenceError);
    await expect(result).rejects.toBe(persistenceError);
    expect(controller.getPlan()?.recoveryProject).toEqual(source.currentProject);
    expect((await controller.commitAfterRecovery(() => source, async () => {})).targetProjectId).toBe(source.projectId);
});

test("apply runs synchronously after the final context check and receives a detached plan", async () => {
    const source = context(), controller = createCanvasDocumentMountController(), saved = deferred();
    controller.prepare(source);
    const events: string[] = [];
    const result = controller.commitAfterRecovery(() => { events.push("read"); return source; }, async () => {
        events.push("persist"); await saved.promise; events.push("persisted");
    }, (plan) => {
        events.push("apply");
        expect(controller.getPlan()).toBeNull();
        plan.replacementProject.title = "callback mutation";
    }).then((plan) => { events.push("returned"); return plan; });
    expect(events).toEqual(["read", "persist"]);
    saved.resolve();
    expect((await result).replacementProject.title).toBe("账号草稿");
    expect(events).toEqual(["read", "persist", "persisted", "read", "apply", "returned"]);
});

test("a failed apply cannot reuse the consumed plan or repeat persistence", async () => {
    const source = context(), controller = createCanvasDocumentMountController();
    controller.prepare(source);
    const applyError = new Error("apply failed");
    let writes = 0, applies = 0;
    await expect(controller.commitAfterRecovery(() => source, async () => { writes++; }, () => {
        applies++; throw applyError;
    })).rejects.toBe(applyError);
    expect(controller.getPlan()).toBeNull();
    await failure(() => controller.commitAfterRecovery(() => source, async () => { writes++; }, () => { applies++; }), "already_used");
    expect({ writes, applies }).toEqual({ writes: 1, applies: 1 });
});
