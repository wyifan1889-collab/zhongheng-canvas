import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { JsonObject } from "../../../../packages/shared/src/index";
import { AccountDraftStorageError, createAccountDraftStore } from "./account-draft-store";
import { AccountDraftWorkspaceError, createAccountDraftWorkspace, type AccountDraftContext } from "./account-draft-workspace";
import { createDraftClient } from "./drafts";

const cloudId = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const secondCloudId = "b1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const A: AccountDraftContext = { accountId: "synthetic-A", epoch: 1, cloudCanvas: true };
const B: AccountDraftContext = { accountId: "synthetic-B", epoch: 2, cloudCanvas: true };
const project = (id = "source-device-id", title = "合成草稿"): JsonObject => ({
    id, title, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [{ id: "text-1", type: "text", title: "文本", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { content: "synthetic-private-body" } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});
const cloud = (id = cloudId, revision = 7, document = project()) => ({
    id, revision, title: document.title, documentVersion: 1, document,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: undefined }), (error) => ({ value: undefined, error }));
function check(error: unknown, code: string) {
    expect(error).toBeInstanceOf(AccountDraftWorkspaceError);
    expect((error as AccountDraftWorkspaceError).code).toBe(code);
    expect(String(error)).not.toContain("synthetic-private");
    expect(error).not.toHaveProperty("cause");
}
async function rejects(promise: Promise<unknown>, code: string) { check((await outcome(promise)).error, code); }
function harness() {
    const factory = new IDBFactory();
    let opens = 0;
    const open = () => new Promise<IDBDatabase>((resolve, reject) => {
        opens++;
        const request = factory.open("synthetic-account-workspaces", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("canvas_drafts");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const store = createAccountDraftStore(open);
    let current: AccountDraftContext | null = { ...A };
    const calls: { method: string; path: string; account: string | null }[] = [];
    const hooks: { fetch?: (url: string) => Promise<Response> } = {};
    const clientFactory = (scope: () => { accountId: string; epoch: number } | null) => createDraftClient(scope, (async (url, init) => {
        calls.push({ method: init!.method!, path: String(url), account: new Headers(init!.headers).get("x-canvas-account-id") });
        expect(init!.method).toBe("GET"); expect(init!.body).toBeUndefined();
        expect(init!.credentials).toBe("same-origin"); expect(init!.redirect).toBe("error");
        return hooks.fetch ? hooks.fetch(String(url)) : Response.json({ draft: cloud() });
    }) as typeof fetch);
    const workspace = (backing = store) => createAccountDraftWorkspace(() => current, backing, clientFactory);
    return { store, open, opens: () => opens, calls, hooks, clientFactory, workspace, setContext: (value: AccountDraftContext | null) => { current = value; } };
}

test("workspace construction, memory edit and state reads do no I/O; explicit local save survives workspace recreation", async () => {
    const h = harness(), workspace = h.workspace();
    expect(workspace.getState()).toEqual({ phase: "idle", draft: null, project: null, dirty: false });
    const input = project(); workspace.createLocal(input);
    input.title = "mutated caller";
    expect(workspace.getState().project!.title).toBe("合成草稿");
    expect(h.opens()).toBe(0); expect(h.calls).toEqual([]);
    const saved = await workspace.saveLocal();
    expect(saved.revision).toBe(1); expect(saved.cloud).toBeNull(); expect(workspace.getState().dirty).toBe(false);
    workspace.dispose();
    const recreated = h.workspace();
    expect((await recreated.openLocal("source-device-id")).project).toEqual(project());
    expect(await recreated.listLocal()).toHaveLength(1);
    expect(h.calls).toEqual([]);
});

test("logout hides the previous account; same project ID in B cannot read or overwrite A", async () => {
    const h = harness(), first = h.workspace();
    first.createLocal(project()); await first.saveLocal();
    h.setContext(null);
    expect(first.getState()).toEqual({ phase: "blocked", draft: null, project: null, dirty: false });
    await rejects(first.saveLocal(), "account_changed");
    h.setContext(B);
    const second = h.workspace();
    expect(await second.listLocal()).toEqual([]);
    await rejects(second.openLocal("source-device-id"), "not_found");
    second.createLocal(project("source-device-id", "B的合成作品")); await second.saveLocal();
    expect((await h.store.read(A.accountId, "source-device-id"))!.project.title).toBe("合成草稿");
    expect((await h.store.read(B.accountId, "source-device-id"))!.project.title).toBe("B的合成作品");
    h.setContext({ ...A, epoch: 3 });
    await rejects(first.listLocal(), "account_changed");
    expect((await h.workspace().openLocal("source-device-id")).project.title).toBe("合成草稿");
});

test("fresh cloud GET stages the original body and its own cloud revision atomically; matching directory revision preserves local edits without GET", async () => {
    const h = harness(), first = h.workspace();
    const remoteBody = project();
    remoteBody.plugin = { nested: [null, true, "retained"] };
    h.hooks.fetch = async () => Response.json({ draft: cloud(cloudId, 7, remoteBody) });
    const loaded = await first.openCloud(cloudId.toUpperCase());
    expect(loaded.project).toEqual(remoteBody);
    expect(loaded.localProjectId).toBe(cloudId);
    expect(loaded.project.id).toBe("source-device-id");
    expect(loaded.cloud).toEqual({ id: cloudId, revision: 7 }); expect(loaded.revision).toBe(1);
    first.edit({ ...remoteBody, title: "未上传的新修改" });
    expect((await first.saveLocal()).cloud).toEqual({ id: cloudId, revision: 7 });
    const reopened = await h.workspace().openCloud(cloudId, 7);
    expect(reopened.project.title).toBe("未上传的新修改"); expect(reopened.revision).toBe(2);
    expect(reopened.cloud!.revision).toBe(7);
    expect(h.calls).toEqual([{ method: "GET", path: `/api/v1/canvases/${cloudId}`, account: A.accountId }]);
});

test("a directory revision change refreshes a cached cloud draft before staging", async () => {
    const h = harness();
    h.hooks.fetch = async () => Response.json({ draft: cloud(cloudId, 7) });
    await h.workspace().openCloud(cloudId, 7);

    const refreshed = project("source-device-id", "服务器上的新版本");
    h.hooks.fetch = async () => Response.json({ draft: cloud(cloudId, 8, refreshed) });
    const reopened = await h.workspace().openCloud(cloudId, 8);

    expect(reopened.project.title).toBe("服务器上的新版本");
    expect(reopened.cloud).toEqual({ id: cloudId, revision: 8 });
    expect(h.calls).toEqual([
        { method: "GET", path: `/api/v1/canvases/${cloudId}`, account: A.accountId },
        { method: "GET", path: `/api/v1/canvases/${cloudId}`, account: A.accountId },
    ]);
});

test("two cloud records containing the same source project ID occupy distinct account slots", async () => {
    const h = harness();
    h.hooks.fetch = async (url) => Response.json({ draft: cloud(url.endsWith(secondCloudId) ? secondCloudId : cloudId, 3) });
    await h.workspace().openCloud(cloudId); await h.workspace().openCloud(secondCloudId);
    const entries = await h.store.list(A.accountId);
    expect(entries.map((entry) => entry.localProjectId).sort()).toEqual([cloudId, secondCloudId].sort());
    expect(entries.every((entry) => !Object.hasOwn(entry, "project"))).toBe(true);
});

test("cloud media and interrupted-task references remain inert document data, preserved without resolution", async () => {
    const h = harness(), body = project();
    body.nodes = [{ id: "video-1", type: "video", title: "待核验媒体", position: { x: 0, y: 0 }, width: 200, height: 100,
        metadata: { content: "blob:synthetic-source-device", storageKey: "video:synthetic-source", status: "loading", videoTaskId: "synthetic-job" } }];
    body.plugin = { reference: "file:///synthetic-path", payload: "data:text/plain,synthetic" };
    h.hooks.fetch = async () => Response.json({ draft: cloud(cloudId, 7, body) });
    const saved = await h.workspace().openCloud(cloudId);
    expect(saved.project).toEqual(body);
    expect((await h.store.read(A.accountId, cloudId))!.project).toEqual(body);
    expect(h.calls).toEqual([{ method: "GET", path: `/api/v1/canvases/${cloudId}`, account: A.accountId }]);
});

test("opening a cloud draft hydrates owned media before staging it", async () => {
    const h = harness(), body = project(), cloudMediaId = "11111111-1111-4111-8111-111111111111";
    (body.nodes as any[])[0].type = "image";
    (body.nodes as any[])[0].metadata = { cloudMediaId, content: "placeholder" };
    h.hooks.fetch = async () => Response.json({ draft: cloud(cloudId, 7, body) });
    let resolves = 0, downloads = 0;
    const media = {
        async resolve(ids: string[]) { resolves++; expect(ids).toEqual([cloudMediaId]); return { items: [{ id: cloudMediaId, kind: "image" as const, contentType: "image/png", sizeBytes: 1, createdAt: "2026-01-01T00:00:00.000Z", url: `/api/v1/media/${cloudMediaId}` }], missing: [] }; },
        async download(id: string) { downloads++; expect(id).toBe(cloudMediaId); return new Blob(["x"], { type: "image/png" }); },
    };
    const workspace = createAccountDraftWorkspace(() => ({ ...A }), h.store, h.clientFactory, () => media);
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
    try {
        const loaded = await workspace.openCloud(cloudId);
        expect(resolves).toBe(1); expect(downloads).toBe(1);
        expect((loaded.project.nodes as any[])[0].metadata.content).toMatch(/^blob:/);
        expect((loaded.project.nodes as any[])[0].metadata.cloudMediaId).toBe(cloudMediaId);
        expect((await h.store.read(A.accountId, cloudId))!.project).toEqual(loaded.project);
        const urls = workspace.getCloudMediaObjectUrls();
        expect(urls).toHaveLength(1);
        expect(workspace.takeCloudMediaObjectUrls()).toEqual(urls);
        expect(workspace.getCloudMediaObjectUrls()).toEqual([]);
        workspace.dispose();
        expect(revoked).toEqual([]);
        const response = await fetch(urls[0]!);
        expect(response.ok).toBe(true);
        expect(await response.text()).toBe("x");
    } finally {
        URL.revokeObjectURL = originalRevoke;
        workspace.dispose();
    }
});

test("a cloud media failure leaves the cloud workspace empty and read-only", async () => {
    const h = harness(), body = project(), cloudMediaId = "11111111-1111-4111-8111-111111111111";
    (body.nodes as any[])[0].type = "image";
    (body.nodes as any[])[0].metadata = { cloudMediaId, content: "placeholder" };
    h.hooks.fetch = async () => Response.json({ draft: cloud(cloudId, 7, body) });
    const media = {
        async resolve() { return { items: [], missing: [cloudMediaId] }; },
        async download() { throw new Error("must not download"); },
    };
    const workspace = createAccountDraftWorkspace(() => ({ ...A }), h.store, h.clientFactory, () => media);
    await rejects(workspace.openCloud(cloudId), "media_unavailable");
    expect(workspace.getState().project).toBeNull();
    expect(await h.store.read(A.accountId, cloudId)).toBeNull();
});

test("an account-local copy of mounted cloud media owns fresh URLs even after the editor releases its previews", async () => {
    const h = harness(), body = project(), mediaId = "11111111-1111-4111-8111-111111111111";
    (body.nodes as any[])[0].type = "image";
    (body.nodes as any[])[0].metadata = { cloudMediaId: mediaId, content: "" };
    h.hooks.fetch = async () => Response.json({ draft: cloud(cloudId, 7, body) });
    let resolves = 0, downloads = 0;
    const media = {
        async resolve(ids: string[]) {
            resolves++; expect(ids).toEqual([mediaId]);
            return { items: [{ id: mediaId, kind: "image" as const, contentType: "image/png", sizeBytes: 1, createdAt: "2026-01-01T00:00:00.000Z", url: `/api/v1/media/${mediaId}` }], missing: [] };
        },
        async download() { downloads++; return new Blob(["x"], { type: "image/png" }); },
    };
    const open = () => createAccountDraftWorkspace(() => ({ ...A }), h.store, h.clientFactory, () => media);
    const source = open(), local = open();
    const ownedUrls: string[] = [];
    try {
        const mounted = await source.openCloud(cloudId);
        const editorUrls = source.takeCloudMediaObjectUrls(); ownedUrls.push(...editorUrls);
        source.dispose();
        local.createLocal(mounted.project);
        const saved = await local.saveLocal();
        expect(saved.cloud).toBeNull();
        const reopened = await local.openLocal(saved.localProjectId);
        const fresh = (reopened.project.nodes as any[])[0].metadata.content as string;
        expect(fresh).not.toBe(editorUrls[0]);
        expect(local.takeCloudMediaObjectUrls()).toEqual([fresh]); ownedUrls.push(fresh);
        editorUrls.forEach((url) => URL.revokeObjectURL(url));
        local.dispose();
        expect(await (await fetch(fresh)).text()).toBe("x");
        expect(await h.store.read(A.accountId, saved.localProjectId)).toEqual(saved);

        URL.revokeObjectURL(fresh);
        const next = open();
        try {
            const afterClose = await next.openLocal(saved.localProjectId);
            const nextUrl = (afterClose.project.nodes as any[])[0].metadata.content as string;
            expect(nextUrl).not.toBe(fresh);
            expect(await (await fetch(nextUrl)).text()).toBe("x");
            expect(afterClose.cloud).toBeNull();
        } finally { next.dispose(); }
        expect(resolves).toBe(3); expect(downloads).toBe(3);
        expect(h.calls).toHaveLength(1);
    } finally {
        source.dispose(); local.dispose();
        ownedUrls.forEach((url) => URL.revokeObjectURL(url));
    }
});

function localMediaFixture() {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const body = project("local-media");
    body.nodes = ids.map((id, index) => ({ id: `image-${index}`, type: "image", title: "图片", position: { x: index * 200, y: 0 }, width: 200, height: 100,
        metadata: { cloudMediaId: id, content: `blob:stale-${index}` } }));
    const items = ids.map((id) => ({ id, kind: "image" as const, contentType: "image/png", sizeBytes: 1, createdAt: "2026-01-01T00:00:00.000Z", url: `/api/v1/media/${id}` }));
    return { body, items };
}

test("local references without cloud media stay inert while cloud media requires the enabled feature", async () => {
    const h = harness(), fixture = localMediaFixture();
    const local = project("local-only");
    (local.nodes as any[])[0] = { ...(local.nodes as any[])[0], type: "video", metadata: { content: "blob:local-preview", storageKey: "video:local", videoTaskId: "local-task" } };
    await h.store.write({ accountId: A.accountId, localProjectId: "local-only", project: local, cloud: null }, null);
    const saved = await h.store.write({ accountId: A.accountId, localProjectId: "local-media", project: fixture.body, cloud: null }, null);
    let mediaCalls = 0;
    const workspace = createAccountDraftWorkspace(() => ({ ...A, cloudCanvas: false }), h.store, h.clientFactory, () => {
        mediaCalls++; throw new Error("must not resolve media");
    });
    try {
        expect((await workspace.openLocal("local-only")).project).toEqual(local);
        await rejects(workspace.openLocal("local-media"), "cloud_unavailable");
        expect(workspace.getState().project).toEqual(local);
        expect(await h.store.read(A.accountId, "local-media")).toEqual(saved);
        expect(mediaCalls).toBe(0); expect(h.calls).toEqual([]);
    } finally { workspace.dispose(); }
});

for (const change of ["other-account", "same-account-epoch", "logout", "closed", "cloud-disabled", "edited", "invalid-second-blob"] as const) {
    test(`local cloud media finishing after ${change} releases previews without replacing or rewriting content`, async () => {
        const h = harness(), fixture = localMediaFixture(), entered = deferred<void>(), gate = deferred<Blob>();
        const saved = await h.store.write({ accountId: A.accountId, localProjectId: "local-media", project: fixture.body, cloud: null }, null);
        let current: AccountDraftContext | null = { ...A }, resolves = 0, downloads = 0;
        const workspace = createAccountDraftWorkspace(() => current, h.store, h.clientFactory, () => ({
            async resolve(ids) { resolves++; expect(ids).toEqual(fixture.items.map((item) => item.id)); return { items: fixture.items, missing: [] }; },
            async download(id) {
                downloads++;
                if (id === fixture.items[1]!.id) { entered.resolve(); return gate.promise; }
                return new Blob(["x"], { type: "image/png" });
            },
        }));
        workspace.createLocal(project("keep")); await workspace.saveLocal();
        const create = URL.createObjectURL, revoke = URL.revokeObjectURL, created: string[] = [], revoked: string[] = [];
        URL.createObjectURL = (blob) => { const url = create(blob); created.push(url); return url; };
        URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
        const pending = outcome(workspace.openLocal("local-media"));
        try {
            await entered.promise;
            expect(created).toHaveLength(1);
            if (change === "other-account") current = { ...B };
            else if (change === "same-account-epoch") current = { ...A, epoch: 4 };
            else if (change === "logout") current = null;
            else if (change === "closed") workspace.dispose();
            else if (change === "cloud-disabled") current = { ...A, cloudCanvas: false };
            else if (change === "edited") workspace.edit(project("keep", "保留读取期间修改"));
            gate.resolve(new Blob([change === "invalid-second-blob" ? "xx" : "x"], { type: "image/png" }));
            check((await pending).error, change === "closed" ? "closed" : change === "cloud-disabled" ? "cloud_unavailable"
                : change === "edited" ? "context_changed" : change === "invalid-second-blob" ? "media_unavailable" : "account_changed");
            expect(resolves).toBe(1); expect(downloads).toBe(2);
            expect(created).toHaveLength(change === "invalid-second-blob" ? 1 : 2);
            expect(revoked).toEqual(created);
            expect(workspace.getCloudMediaObjectUrls()).toEqual([]);
            expect(workspace.getState().project?.title ?? null).toBe(change === "edited" ? "保留读取期间修改"
                : change === "cloud-disabled" || change === "invalid-second-blob" ? "合成草稿" : null);
            expect(await h.store.read(A.accountId, "local-media")).toEqual(saved);
            expect(await h.store.read(B.accountId, "local-media")).toBeNull();
            expect(h.calls).toEqual([]);
        } finally {
            gate.resolve(new Blob(["x"], { type: "image/png" })); await pending;
            workspace.dispose();
            URL.createObjectURL = create; URL.revokeObjectURL = revoke;
            created.forEach((url) => revoke(url));
        }
    });
}

test("an existing unrelated local slot is not presented as the requested cloud draft", async () => {
    const h = harness(), local = h.workspace();
    local.createLocal(project(cloudId)); await local.saveLocal();
    const other = h.workspace();
    await rejects(other.openCloud(cloudId), "invalid_data");
    expect(other.getState().draft).toBeNull(); expect(h.calls).toEqual([]);
});

test("two workspaces edit the same local baseline: conflict retains the losing body's unsaved copy and pauses writes", async () => {
    const h = harness(), first = h.workspace(), second = h.workspace();
    first.createLocal(project()); await first.saveLocal(); await second.openLocal("source-device-id");
    first.edit(project("source-device-id", "已保存一方")); second.edit(project("source-device-id", "冲突一方"));
    await first.saveLocal(); await rejects(second.saveLocal(), "conflict");
    expect(second.getState().phase).toBe("conflict"); expect(second.getState().project!.title).toBe("冲突一方");
    expect(second.getState().draft!.revision).toBe(1); expect(second.getState().dirty).toBe(true);
    second.edit(project("source-device-id", "冲突后的编辑"));
    await rejects(second.saveLocal(), "unsaved_changes");
    await rejects(second.openCloud(cloudId), "unsaved_changes");
    expect((await h.store.read(A.accountId, "source-device-id"))!.project.title).toBe("已保存一方");
});

test("edits made during local commit remain dirty instead of becoming an acknowledged baseline", async () => {
    const h = harness(), gate = deferred<void>(), entered = deferred<void>();
    const workspace = h.workspace({ ...h.store, async write(...args) { entered.resolve(); await gate.promise; return h.store.write(...args); } });
    workspace.createLocal(project());
    const pending = workspace.saveLocal(); await entered.promise;
    workspace.edit(project("source-device-id", "提交期间的新编辑"));
    await rejects(workspace.saveLocal(), "busy");
    gate.resolve(); await pending;
    expect(workspace.getState().project!.title).toBe("提交期间的新编辑");
    expect(workspace.getState().draft!.project.title).toBe("合成草稿"); expect(workspace.getState().dirty).toBe(true);
    await workspace.saveLocal();
    expect(workspace.getState().dirty).toBe(false);
    expect((await h.store.read(A.accountId, "source-device-id"))!.project.title).toBe("提交期间的新编辑");
});

test("local open that returns after an edit does not replace that edit", async () => {
    const h = harness(), initial = h.workspace();
    initial.createLocal(project()); await initial.saveLocal();
    const second = h.workspace(); second.createLocal(project("another-id")); await second.saveLocal();
    const gate = deferred<void>(), entered = deferred<void>();
    const workspace = h.workspace({ ...h.store, async read(...args) { if (args[1] === "another-id") { entered.resolve(); await gate.promise; } return h.store.read(...args); } });
    await workspace.openLocal("source-device-id");
    const pending = outcome(workspace.openLocal("another-id")); await entered.promise;
    workspace.edit(project("source-device-id", "读取时新增内容")); gate.resolve();
    check((await pending).error, "context_changed");
    expect(workspace.getState().project!.title).toBe("读取时新增内容");
});

for (const change of ["other-account", "same-account-epoch", "logout", "closed", "cloud-disabled"] as const) {
    test(`cloud response arriving after ${change} is not staged or exposed`, async () => {
        const h = harness(), workspace = h.workspace(), waiting = deferred<Response>(), entered = deferred<void>();
        h.hooks.fetch = () => { entered.resolve(); return waiting.promise; };
        const pending = outcome(workspace.openCloud(cloudId)); await entered.promise;
        if (change === "other-account") h.setContext(B);
        else if (change === "same-account-epoch") h.setContext({ ...A, epoch: 4 });
        else if (change === "logout") h.setContext(null);
        else if (change === "cloud-disabled") h.setContext({ ...A, cloudCanvas: false });
        else workspace.dispose();
        waiting.resolve(Response.json({ draft: cloud() }));
        check((await pending).error, change === "closed" ? "closed" : change === "cloud-disabled" ? "cloud_unavailable" : "account_changed");
        expect(workspace.getState().project).toBeNull();
        expect(await h.store.read(A.accountId, cloudId)).toBeNull(); expect(await h.store.read(B.accountId, cloudId)).toBeNull();
    });
}

test("cloud fetch racing a second local creator cannot overwrite its saved body", async () => {
    const h = harness(), workspace = h.workspace(), waiting = deferred<Response>(), entered = deferred<void>();
    h.hooks.fetch = () => { entered.resolve(); return waiting.promise; };
    const pending = outcome(workspace.openCloud(cloudId)); await entered.promise;
    await h.store.write({ accountId: A.accountId, localProjectId: cloudId, project: project("source-device-id", "另一个窗口的正文"), cloud: { id: cloudId, revision: 2 } }, null);
    waiting.resolve(Response.json({ draft: cloud() }));
    check((await pending).error, "conflict");
    expect(workspace.getState().project).toBeNull();
    const persisted = await h.store.read(A.accountId, cloudId);
    expect(persisted!.project.title).toBe("另一个窗口的正文"); expect(persisted!.cloud!.revision).toBe(2);
});

test("editing the current local draft during a different cloud read keeps the edit and prevents cloud staging", async () => {
    const h = harness(), workspace = h.workspace(), waiting = deferred<Response>(), entered = deferred<void>();
    workspace.createLocal(project()); await workspace.saveLocal();
    h.hooks.fetch = () => { entered.resolve(); return waiting.promise; };
    const pending = outcome(workspace.openCloud(cloudId)); await entered.promise;
    workspace.edit(project("source-device-id", "保留当前编辑")); waiting.resolve(Response.json({ draft: cloud() }));
    check((await pending).error, "context_changed");
    expect(workspace.getState().project!.title).toBe("保留当前编辑");
    expect(await h.store.read(A.accountId, cloudId)).toBeNull();
});

test("a storage failure keeps current content, does not confirm a revision, and does not silently retry", async () => {
    const h = harness(); let writes = 0;
    const workspace = h.workspace({ ...h.store, async write() { writes++; throw new AccountDraftStorageError("unavailable"); } });
    workspace.createLocal(project());
    await rejects(workspace.saveLocal(), "unavailable");
    expect(workspace.getState().project).toEqual(project()); expect(workspace.getState().draft).toBeNull();
    await rejects(workspace.saveLocal(), "unsaved_changes"); expect(writes).toBe(1);
});

test("identity changing after a committed write hides its response but leaves the record under its original account", async () => {
    const h = harness();
    const workspace = h.workspace({ ...h.store, async write(...args) { const saved = await h.store.write(...args); h.setContext(B); return saved; } });
    workspace.createLocal(project());
    await rejects(workspace.saveLocal(), "account_changed");
    expect(workspace.getState().project).toBeNull();
    expect((await h.store.read(A.accountId, "source-device-id"))!.revision).toBe(1);
    expect(await h.store.read(B.accountId, "source-device-id")).toBeNull();
});

test("closing after cloud staging committed does not expose the body or erase the committed account record", async () => {
    const h = harness();
    let workspace: ReturnType<typeof createAccountDraftWorkspace>;
    workspace = h.workspace({ ...h.store, async write(...args) { const saved = await h.store.write(...args); workspace.dispose(); return saved; } });
    await rejects(workspace.openCloud(cloudId), "closed");
    expect(workspace.getState()).toEqual({ phase: "closed", draft: null, project: null, dirty: false });
    expect((await h.store.read(A.accountId, cloudId))!.cloud).toEqual({ id: cloudId, revision: 7 });
});

test("unauthorized cloud response invalidates the entire workspace without keeping the previously opened body", async () => {
    const h = harness(), workspace = h.workspace();
    workspace.createLocal(project()); await workspace.saveLocal();
    h.hooks.fetch = async () => Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    await rejects(workspace.openCloud(cloudId), "account_changed");
    expect(workspace.getState()).toEqual({ phase: "blocked", draft: null, project: null, dirty: false });
    await rejects(workspace.openLocal("source-device-id"), "account_changed");
});

test("malformed, unknown-version, mismatched-title and unavailable cloud results leave local records untouched", async () => {
    for (const response of [
        () => Response.json({ draft: { ...cloud(), documentVersion: 2 } }),
        () => Response.json({ draft: cloud(cloudId, 7, { damaged: true }) }),
        () => Response.json({ draft: { ...cloud(), title: "与正文不一致" } }),
        () => Response.json({ draft: cloud(secondCloudId) }),
        () => Response.json({ error: { code: "internal", detail: "synthetic-private-body" } }, { status: 503 }),
        () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
    ]) {
        const h = harness(), workspace = h.workspace();
        h.hooks.fetch = async () => response();
        const result = await outcome(workspace.openCloud(cloudId));
        expect(result.error).toBeInstanceOf(AccountDraftWorkspaceError);
        expect(String(result.error)).not.toContain("synthetic-private");
        expect(workspace.getState().draft).toBeNull(); expect(await h.store.list(A.accountId)).toEqual([]);
        expect(h.calls).toHaveLength(1);
    }
});

test("return values are detached from editable state and acknowledged baselines", async () => {
    const h = harness(), workspace = h.workspace();
    const loaded = await workspace.openCloud(cloudId);
    loaded.project.title = "caller mutation"; loaded.cloud!.revision = 900;
    const state = workspace.getState(); state.project!.title = "state mutation"; state.draft!.revision = 700;
    expect(workspace.getState().project!.title).toBe("合成草稿");
    expect(workspace.getState().draft!.revision).toBe(1); expect(workspace.getState().draft!.cloud!.revision).toBe(7);
    const list = await workspace.listLocal(); list[0]!.cloud!.revision = 800;
    expect((await workspace.listLocal())[0]!.cloud!.revision).toBe(7);
});

test("closed cloud feature still permits account-local work without any cloud requests", async () => {
    const h = harness(); h.setContext({ ...A, cloudCanvas: false });
    const workspace = h.workspace();
    await rejects(workspace.openCloud(cloudId), "cloud_unavailable");
    workspace.createLocal(project()); await workspace.saveLocal();
    expect(workspace.getState().draft!.revision).toBe(1); expect(h.calls).toEqual([]);
});

test("a failed list is not an empty success; a late list cannot reveal another account's titles", async () => {
    const h = harness(), waiting = deferred<void>(), entered = deferred<void>();
    const bad = h.workspace({ ...h.store, async list() { throw new Error("synthetic-private-body"); } });
    await rejects(bad.listLocal(), "unavailable");
    const seed = h.workspace(); seed.createLocal(project()); await seed.saveLocal();
    const workspace = h.workspace({ ...h.store, async list(...args) { const result = await h.store.list(...args); entered.resolve(); await waiting.promise; return result; } });
    const pending = outcome(workspace.listLocal()); await entered.promise; h.setContext(B); waiting.resolve();
    check((await pending).error, "account_changed"); expect(workspace.getState().project).toBeNull();
});
