import { expect, test } from "bun:test";
import type { CanvasDraft, JsonObject } from "../../../../packages/shared/src/index";
import { validateCanvasDocumentMount } from "./canvas-document-mount";
import { createCanvasDocumentMountController } from "./canvas-document-mount-controller";
import { createCanvasVersionSession } from "./canvas-version-save";
import { createDraftClient } from "./drafts";

const id = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const scope = { accountId: "test-account", epoch: 1, cloudCanvas: true };
const project = (localId: string, content = "original"): JsonObject => ({
    id: localId, title: "test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    nodes: [{ id: "text", type: "text", title: "text", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content, status: "success" } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});
function mount(localId: string, revision = 1) {
    const controller = createCanvasDocumentMountController();
    const context = { ...scope, projectId: localId, currentProject: project(localId, "empty"),
        candidate: validateCanvasDocumentMount(project("source-device")), cloudVersion: { accountId: scope.accountId, id, revision } };
    controller.prepare(context);
    return controller.commit(context);
}
function server() {
    let remote: CanvasDraft = { id, revision: 1, title: "test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", documentVersion: 1, document: project("source-device") };
    const requests: { method: string; revision?: number }[] = [];
    const client = (getScope: () => { accountId: string; epoch: number } | null) => createDraftClient(getScope, (async (_path, options) => {
        const method = options!.method!, input = options!.body ? JSON.parse(String(options!.body)) : null;
        requests.push({ method, ...(input ? { revision: input.expectedRevision } : {}) });
        if (method === "PUT") {
            if (input.expectedRevision !== remote.revision) return Response.json({ error: { code: "revision_conflict" }, currentRevision: remote.revision }, { status: 409 });
            remote = { ...remote, document: input.document, revision: remote.revision + 1 };
        }
        return Response.json({ draft: remote });
    }) as typeof fetch);
    return { client, requests, remote: () => structuredClone(remote) };
}

test("two confirmed mounts keep the mounted revision: first saves, stale device conflicts and retains its content", async () => {
    const cloud = server(), leftPlan = mount("left-device"), rightPlan = mount("right-device");
    const left = createCanvasVersionSession(() => ({ ...scope, localProjectId: "left-device" }), cloud.client);
    const right = createCanvasVersionSession(() => ({ ...scope, localProjectId: "right-device" }), cloud.client);
    left.seedMounted(leftPlan.cloudVersion!); right.seedMounted(rightPlan.cloudVersion!);
    expect(cloud.requests).toEqual([]);
    const a = left.open(); a.prepare(project("left-device", "left edit"));
    expect((await a.submit()).revision).toBe(2);
    const rightContent = project("right-device", "right edit"), before = structuredClone(rightContent);
    const b = right.open(); expect(b.prepare(rightContent).expectedRevision).toBe(1);
    await expect(b.submit()).rejects.toMatchObject({ code: "revision_conflict", currentRevision: 2 });
    expect(rightContent).toEqual(before);
    expect(cloud.remote().document).toEqual(project("left-device", "left edit"));
    expect(await b.reconcile()).toMatchObject({ status: "found-current", revision: 2 });
    expect(right.getState()).toMatchObject({ status: "conflict", revision: 1 });
    expect(() => right.seedMounted(rightPlan.cloudVersion!)).toThrow();
    expect(() => right.open().prepare(rightContent)).toThrow();
    expect(cloud.requests).toEqual([{ method: "PUT", revision: 1 }, { method: "PUT", revision: 1 }, { method: "GET" }]);
});

test("mounted save works across different local IDs, closes/reopens without losing baseline, refresh starts empty", async () => {
    const cloud = server(), plan = mount("target-device"), context = { ...scope, localProjectId: "target-device" };
    const session = createCanvasVersionSession(() => context, cloud.client);
    session.seedMounted(plan.cloudVersion!);
    session.open().close();
    expect(await session.open().reconcile()).toMatchObject({ status: "found-current", revision: 1 });
    const save = session.open(); save.prepare(plan.replacementProject);
    expect((await save.submit()).revision).toBe(2);
    expect(cloud.remote().id).toBe(id);
    expect(cloud.remote().document.id).toBe("target-device");
    session.dispose();
    expect(createCanvasVersionSession(() => context, cloud.client).getState()).toEqual({ status: "empty" });
    // Explicit directory selection still works after refresh, even if another
    // device last wrote the body using its own local project ID.
    const resumed = createCanvasVersionSession(() => ({ ...scope, localProjectId: "another-device" }), cloud.client);
    await resumed.resumeFromCloudSelection({ accountId: scope.accountId, id, revision: 2 });
    expect(resumed.getState()).toMatchObject({ status: "ready", id, revision: 2 });
});

test("mounted baselines reject foreign accounts, epochs, projects and malformed versions before any I/O", () => {
    const cloud = server(), plan = mount("target-device");
    for (const patch of [{ accountId: "foreign" }, { epoch: 2 }, { localProjectId: "other" }, { id: "invalid" }, { revision: 0 }, { updatedAt: "invalid" }]) {
        const session = createCanvasVersionSession(() => ({ ...scope, localProjectId: "target-device" }), cloud.client);
        expect(() => session.seedMounted({ ...plan.cloudVersion!, ...patch })).toThrow();
        expect(session.getState().status).toBe("empty");
    }
    const controller = createCanvasDocumentMountController();
    const localPlan = controller.prepare({ ...scope, projectId: "target-device", currentProject: project("target-device"), candidate: validateCanvasDocumentMount(project("source-device")) });
    expect(localPlan.cloudVersion).toBeNull();
    expect(cloud.requests).toEqual([]);
});
