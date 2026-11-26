import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasCloudSaveStatus, type CanvasCloudSaveStatusProps } from "../../components/canvas/canvas-cloud-save-status";
import { createCloudCanvasWorkspace, type CloudCanvasContext } from "./cloud-canvas-workspace";
import { canvasSharingView } from "./canvas-sharing-view";
import { createDraftClient, DraftError, type CanvasDraftAccess } from "./drafts";
import type { CanvasDraft, JsonObject } from "../../../../packages/shared/src/index";
import type { CloudMedia } from "../api/media";

const id = "10000000-0000-4000-8000-000000000001";
const originalMedia = "20000000-0000-4000-8000-000000000001", addedMedia = "20000000-0000-4000-8000-000000000002";
const context: CloudCanvasContext = { accountId: "actual-editor", epoch: 1, cloudCanvas: true, cloudMedia: true };
const project = (): JsonObject => ({ id: "source-device-nanoid", title: "source-title", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    nodes: [{ id: "text", type: "text", title: "文本", position: { x: 0, y: 0 }, width: 200, height: 100,
        metadata: { content: "original", platformTextRequests: [{ guardId: "30000000-0000-4000-8000-000000000001", edited: false }] } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } });
const mediaItem = (mediaId: string): CloudMedia => ({ id: mediaId, kind: "image", contentType: "image/png", sizeBytes: 3, createdAt: "2026-01-01T00:00:00Z", url: `/api/v1/media/${mediaId}` });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { resolve, promise }; }
function harness(role: CanvasDraftAccess["role"] = "editor") {
    let active: CloudCanvasContext | null = { ...context }, remote: CanvasDraft = { id, title: "cloud-title", revision: 7, documentVersion: 1, document: project(), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
    let access: CanvasDraftAccess = { role, ownerId: role === "owner" ? context.accountId : "canvas-owner", readOnly: role === "viewer" };
    const calls: { method: string; body?: any }[] = [], scoped: string[][] = [], own: string[][] = [];
    let getFailure: unknown, saveFailure: unknown, getDelay: Promise<void> | undefined, saveDelay: Promise<void> | undefined;
    const workspace = createCloudCanvasWorkspace(id.toUpperCase(), () => active, {
        clientFactory: (scope) => createDraftClient(scope, (async (_path, init) => {
            calls.push({ method: init!.method!, ...(init!.body ? { body: JSON.parse(String(init!.body)) } : {}) });
            if (init!.method === "PUT") {
                if (saveDelay) await saveDelay;
                if (saveFailure instanceof Response) return saveFailure;
                if (saveFailure) throw saveFailure;
                const body = JSON.parse(String(init!.body));
                remote = { ...remote, title: body.title, document: body.document, revision: remote.revision + 1 };
            } else {
                if (getDelay) await getDelay;
                if (getFailure) return Response.json({ error: { code: "not_found" } }, { status: 404 });
            }
            return Response.json({ draft: remote, access });
        }) as typeof fetch),
        mediaFactory: (_scope, canvasId, current) => ({
            async resolve(ids) { if (!current()) throw new Error("stale media"); expect(canvasId).toBe(id); scoped.push(ids); return { items: ids.filter((mediaId) => mediaId === originalMedia).map(mediaItem), missing: ids.filter((mediaId) => mediaId !== originalMedia) }; },
            async download() { if (!current()) throw new Error("stale media"); return new Blob(["abc"], { type: "image/png" }); },
        }),
        ownMediaFactory: () => ({ async resolve(ids) { own.push(ids); return { items: ids.filter((mediaId) => mediaId === addedMedia).map(mediaItem), missing: ids.filter((mediaId) => mediaId !== addedMedia) }; } }),
    });
    return { workspace, calls, scoped, own, remote: () => remote, setRemote: (value: CanvasDraft) => { remote = value; },
        role: (value: CanvasDraftAccess["role"]) => { access = { ...access, role: value, readOnly: value === "viewer" }; },
        revoke: () => { getFailure = true; }, scope: (value: CloudCanvasContext | null) => { active = value; },
        delayGet: (value: Promise<void> | undefined) => { getDelay = value; }, delaySave: (value: Promise<void> | undefined) => { saveDelay = value; }, failSave: (value: unknown) => { saveFailure = value; } };
}

test("a cloud entry reads afresh, normalizes route identity, strips execution authority and keeps edits only in memory", async () => {
    const h = harness(); await h.workspace.load();
    const initial = h.workspace.getState();
    expect(h.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(initial.currentProject?.id).toBe(id); expect(initial.currentProject?.title).toBe("cloud-title");
    expect(initial.currentProject?.nodes[0].metadata?.platformTextRequests?.[0].edited).toBe(true);
    expect(initial.canEdit).toBe(true); expect(h.scoped).toEqual([]);
    expect(initial.dirty).toBe(false);
    h.workspace.renameProject(id, "edited-title");
    expect(h.workspace.getState().sourceProject).toBe(initial.sourceProject);
    expect(h.workspace.openProject(id)?.title).toBe("edited-title");
    expect(h.workspace.getState().dirty).toBe(true);
    expect(h.remote().document.id).toBe("source-device-nanoid");
    expect(h.calls).toHaveLength(1);
});

test("viewer cannot mutate or send a save even through direct workspace calls", async () => {
    const h = harness("viewer"); await h.workspace.load();
    const before = h.workspace.getState().currentProject;
    h.workspace.renameProject(id, "forged"); h.workspace.updateProject(id, { nodes: [] });
    expect(h.workspace.getState().currentProject).toBe(before);
    expect(h.workspace.getState().dirty).toBe(false);
    await expect(h.workspace.save(before)).rejects.toMatchObject({ code: "permission_denied", outcome: "not-sent" });
    expect(h.calls).toHaveLength(1);
});

test("active members get information-only sharing, while retained recovery permissions cannot reopen sharing", async () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
        const h = harness(role);
        expect(canvasSharingView(h.workspace.getState())).toBe(null);
        await h.workspace.load();
        expect(canvasSharingView(h.workspace.getState())).toBe(role === "owner" ? "manage" : "information");
        h.revoke(); await h.workspace.recheck();
        expect(h.workspace.getState().currentProject).not.toBe(null);
        expect(canvasSharingView(h.workspace.getState())).toBe(null);
        expect(h.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
        h.workspace.dispose();
    }
});

test("focus permission recheck preserves dirty content and CAS baseline while downgrade invalidates old media", async () => {
    const h = harness(); await h.workspace.load();
    const oldMedia = h.workspace.getState().media!;
    h.workspace.renameProject(id, "dirty"); const dirty = h.workspace.getState().currentProject;
    h.role("viewer"); h.setRemote({ ...h.remote(), title: "remote-new", revision: 8 });
    await h.workspace.recheck();
    expect(h.workspace.getState().currentProject).toBe(dirty); expect(h.workspace.getState().revision).toBe(7);
    expect(h.workspace.getState().canEdit).toBe(false); expect(h.workspace.getState().accessGeneration).toBe(1);
    await expect(oldMedia.resolve([originalMedia])).rejects.toThrow();
});

test("revocation blocks the mounted editor and every later save, retaining its in-memory recovery content", async () => {
    const h = harness(); await h.workspace.load(); h.workspace.renameProject(id, "dirty");
    h.revoke(); await h.workspace.recheck();
    expect(h.workspace.getState()).toMatchObject({ phase: "blocked", canEdit: false, canSave: false, media: null });
    expect(h.workspace.getState().currentProject?.title).toBe("dirty");
    await expect(h.workspace.save(h.workspace.getState().currentProject)).rejects.toMatchObject({ outcome: "not-sent" });
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
});

test("account epoch changes discard an in-flight body and cannot populate the old workspace", async () => {
    const h = harness(), delayed = deferred<void>(); h.delayGet(delayed.promise);
    const pending = h.workspace.load(); h.scope({ ...context, epoch: 2 }); delayed.resolve(); await pending;
    expect(h.workspace.getState()).toMatchObject({ phase: "blocked", currentProject: null, sourceProject: null, canEdit: false, lastSavedAt: null });
});

test("cloud saved time comes from the server receipt and rechecking never certifies local edits", async () => {
    const h = harness(), initialTime = "2026-02-01T00:00:00Z", savedTime = "2026-02-02T00:00:00Z";
    expect(h.workspace.getState().lastSavedAt).toBeNull();
    h.setRemote({ ...h.remote(), updatedAt: initialTime }); await h.workspace.load();
    expect(h.workspace.getState().lastSavedAt).toBe(initialTime);
    expect(h.workspace.getState().currentProject?.updatedAt).not.toBe(initialTime);
    h.workspace.renameProject(id, "unsaved-local-title");
    h.setRemote({ ...h.remote(), updatedAt: savedTime }); await h.workspace.recheck();
    expect(h.workspace.getState()).toMatchObject({ dirty: true, revision: 7, lastSavedAt: initialTime });
    await h.workspace.save(h.workspace.getState().currentProject);
    expect(h.workspace.getState()).toMatchObject({ dirty: false, revision: 8, lastSavedAt: savedTime });
    h.workspace.dispose(); expect(h.workspace.getState().lastSavedAt).toBeNull();
});

test("failed saves retain the prior confirmed time and account invalidation clears it", async () => {
    for (const failure of [new Error("offline"),
        Response.json({ error: { code: "revision_conflict" }, currentRevision: 10 }, { status: 409 }),
        Response.json({ error: { code: "invalid_input" } }, { status: 400 })]) {
        const h = harness(); await h.workspace.load(); const before = h.workspace.getState().lastSavedAt;
        h.workspace.renameProject(id, "unconfirmed-local-title");
        h.setRemote({ ...h.remote(), updatedAt: "2026-03-01T00:00:00Z" }); h.failSave(failure);
        await expect(h.workspace.save(h.workspace.getState().currentProject)).rejects.toBeInstanceOf(DraftError);
        expect(h.workspace.getState().lastSavedAt).toBe(before);
        expect(h.workspace.getState().dirty).toBe(true);
        h.scope({ ...context, epoch: 2 }); await expect(h.workspace.recheck()).rejects.toMatchObject({ code: "account_changed" });
        expect(h.workspace.getState().lastSavedAt).toBeNull();
    }
});

test("StrictMode setup cleanup setup performs a new read and never adopts the disposed read", async () => {
    const h = harness(), delayed = deferred<void>(); h.delayGet(delayed.promise);
    const first = h.workspace.load(); h.workspace.dispose(); h.delayGet(undefined);
    let notified = 0; h.workspace.subscribe(() => { notified++; });
    await h.workspace.load(); expect(h.workspace.getState().phase).toBe("ready");
    const adopted = h.workspace.getState().sourceProject;
    delayed.resolve(); await first;
    expect(h.workspace.getState().sourceProject).toBe(adopted); expect(h.calls).toHaveLength(2); expect(notified).toBeGreaterThan(0);
});

test("editor saves original shared references with canvas scope and only new references through their own media ownership", async () => {
    const h = harness();
    const document = project(); document.nodes = [{ id: "image", type: "image", title: "shared image", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { cloudMediaId: originalMedia } }];
    h.setRemote({ ...h.remote(), document }); await h.workspace.load();
    const snapshot = structuredClone(h.workspace.getState().currentProject!);
    snapshot.nodes.push({ id: "added", type: "image", title: "own image", position: { x: 1, y: 1 }, width: 100, height: 100, metadata: { cloudMediaId: addedMedia } });
    const saved = await h.workspace.save(snapshot);
    expect(saved.revision).toBe(8); expect(h.scoped).toEqual([[originalMedia]]); expect(h.own).toEqual([[addedMedia]]);
    expect(h.calls[1]).toMatchObject({ method: "PUT", body: { expectedRevision: 7, document: { id } } });
    expect(h.workspace.getState().canSave).toBe(true);
});

test("saving a newly guessed owner media ID fails before PUT", async () => {
    const h = harness(); await h.workspace.load(); const snapshot = structuredClone(h.workspace.getState().currentProject!);
    snapshot.nodes.push({ id: "forged", type: "image", title: "forged", position: { x: 1, y: 1 }, width: 100, height: 100, metadata: { cloudMediaId: originalMedia } });
    await expect(h.workspace.save(snapshot)).rejects.toThrow();
    expect(h.own).toEqual([[originalMedia]]); expect(h.scoped).toEqual([]); expect(h.calls).toHaveLength(1);
    expect(h.workspace.getState()).toMatchObject({ phase: "ready", canEdit: true, canSave: true });
    expect(h.workspace.getState().error).not.toBe("");
});

test("invalid local snapshots report an actionable error and let the editor correct an unsent snapshot", async () => {
    const h = harness(); await h.workspace.load();
    const snapshot = structuredClone(h.workspace.getState().currentProject!);
    snapshot.nodes[0].metadata = { content: "blob:private-preview" }; snapshot.nodes[0].type = "image";
    await expect(h.workspace.save(snapshot)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    expect(h.workspace.getState()).toMatchObject({ phase: "ready", canEdit: true, canSave: true });
    expect(h.workspace.getState().error).not.toBe(""); expect(h.calls).toHaveLength(1);
    expect((await h.workspace.save(h.workspace.getState().currentProject)).revision).toBe(8);
});

test("a same-role visibility recheck keeps edit permission, media identity, dirty content and revision stable", async () => {
    const h = harness(); await h.workspace.load(); h.workspace.renameProject(id, "dirty");
    const before = h.workspace.getState(), delayed = deferred<void>(); h.delayGet(delayed.promise);
    const pending = h.workspace.recheck();
    expect(h.workspace.getState().canEdit).toBe(true); expect(h.workspace.getState().canSave).toBe(false);
    delayed.resolve(); await pending;
    expect(h.workspace.getState().media).toBe(before.media);
    expect(h.workspace.getState().sourceProject).toBe(before.sourceProject);
    expect(h.workspace.getState().currentProject).toBe(before.currentProject);
    expect(h.workspace.getState()).toMatchObject({ phase: "ready", canSave: true, revision: 7, accessGeneration: 0 });
    expect(h.workspace.getState().dirty).toBe(true);
});

test("dirty clears only for a confirmed save without later edits; a newer local edit retains the unload guard", async () => {
    const h = harness(); await h.workspace.load();
    h.workspace.renameProject(id, "first-edit");
    await h.workspace.save(h.workspace.getState().currentProject);
    expect(h.workspace.getState().dirty).toBe(false);
    h.workspace.renameProject(id, "second-edit"); const delayed = deferred<void>(); h.delaySave(delayed.promise);
    const acknowledgedAt = "2026-04-01T00:00:00Z"; h.setRemote({ ...h.remote(), updatedAt: acknowledgedAt });
    const pending = h.workspace.save(h.workspace.getState().currentProject);
    for (let count = 0; count < 8 && h.calls.length < 3; count++) await Promise.resolve();
    h.workspace.renameProject(id, "newer-local-edit"); delayed.resolve(); await pending;
    expect(h.workspace.getState().dirty).toBe(true);
    expect(h.workspace.getState().lastSavedAt).toBe(acknowledgedAt);
    expect(h.workspace.getState().currentProject?.title).toBe("newer-local-edit");
    h.workspace.renameProject(id, "second-edit"); expect(h.workspace.getState().dirty).toBe(false);
});

test("a CAS conflict never advances the baseline or unlocks a save on a later GET", async () => {
    const h = harness(); await h.workspace.load(); h.workspace.renameProject(id, "dirty");
    h.failSave(Response.json({ error: { code: "revision_conflict" }, currentRevision: 10 }, { status: 409 }));
    await expect(h.workspace.save(h.workspace.getState().currentProject)).rejects.toMatchObject({ code: "revision_conflict", outcome: "rejected" });
    h.setRemote({ ...h.remote(), revision: 10 }); await h.workspace.recheck();
    expect(h.workspace.getState()).toMatchObject({ phase: "conflict", revision: 7, canEdit: false, canSave: false });
    expect(h.workspace.getState().currentProject?.title).toBe("dirty");
    await expect(h.workspace.save(h.workspace.getState().currentProject)).rejects.toMatchObject({ outcome: "not-sent" });
    expect(h.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("a permission downgrade during save prevents an old success from advancing the baseline", async () => {
    const h = harness(); await h.workspace.load(); const delayed = deferred<void>(); h.delaySave(delayed.promise);
    const pending = h.workspace.save(h.workspace.getState().currentProject);
    for (let count = 0; count < 8 && h.calls.length < 2; count++) await Promise.resolve();
    expect(h.calls[1]?.method).toBe("PUT");
    h.role("viewer"); await h.workspace.recheck(); delayed.resolve();
    await expect(pending).rejects.toMatchObject({ code: "permission_denied", outcome: "unknown" });
    expect(h.workspace.getState()).toMatchObject({ phase: "unknown", revision: 7, canSave: false });
});

test("unknown saves retain content and stay read only after successful permission rechecks", async () => {
    const h = harness(); await h.workspace.load(); h.workspace.renameProject(id, "dirty"); h.failSave(new Error("offline"));
    await expect(h.workspace.save(h.workspace.getState().currentProject)).rejects.toBeInstanceOf(DraftError);
    expect(h.workspace.getState().phase).toBe("unknown"); await h.workspace.recheck();
    expect(h.workspace.getState()).toMatchObject({ phase: "unknown", canEdit: false, canSave: false, revision: 7 });
    expect(h.workspace.getState().currentProject?.title).toBe("dirty");
    await expect(h.workspace.save(h.workspace.getState().currentProject)).rejects.toMatchObject({ outcome: "not-sent" });
    expect(h.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("cloud status displays only confirmed saved time and prioritizes edits and failures", () => {
    const status: CanvasCloudSaveStatusProps = { phase: "ready", dirty: false, lastSavedAt: new Date(Date.now() - 120_000).toISOString(), revision: 7,
        access: { role: "editor", ownerId: "canvas-owner", readOnly: false } };
    const render = (patch: Partial<CanvasCloudSaveStatusProps> = {}) => renderToStaticMarkup(createElement(CanvasCloudSaveStatus, { ...status, ...patch }));
    expect(render()).toMatch(/云端已保存 · 2\s*分钟前/);
    expect(render({ dirty: true })).toContain("云端有未保存修改");
    for (const phase of ["saving", "blocked", "unknown", "conflict", "error", "loading"] as const) expect(render({ phase })).not.toContain("已保存");
    for (const lastSavedAt of [null, "invalid", new Date(Date.now() + 60_000).toISOString()]) expect(render({ lastSavedAt, revision: 100 })).not.toContain("已保存");
    const viewer = { role: "viewer" as const, ownerId: "canvas-owner", readOnly: true };
    expect(render({ access: viewer })).toMatch(/云端只读 · 上次保存 2\s*分钟前/);
    expect(render({ access: viewer, dirty: true })).toContain("云端有未保存修改");
    expect(render({ access: viewer, phase: "blocked" })).toContain("云端保存已暂停");
});
