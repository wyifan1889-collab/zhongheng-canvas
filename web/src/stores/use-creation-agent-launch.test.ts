import { expect, test } from "bun:test";
import { createCreationAgentLaunchStore, type CreationAgentComposerActions, type CreationAgentRuntime, type CreationAgentSavedDraft } from "./use-creation-agent-launch";

const scope = { accountId: "creation-a", epoch: 1 };
function runtime(): CreationAgentRuntime {
    return { scope: { ...scope }, pathname: "/", locationKey: "home-original", projectId: null,
        connection: { url: "http://127.0.0.1:60523", token: "synthetic-only", enabled: true, workspacePath: "/synthetic", threadId: "thread-a", conversationId: "conversation-a" },
        draft: { prompt: "创作一张海报", attachments: [], canvasReferences: [], skillRevision: 3, model: "synthetic", reasoningEffort: "high", permissionMode: "request" } };
}
function staged() {
    const store = createCreationAgentLaunchStore(), current = runtime();
    expect(store.getState().stage({ nonce: "launch-a", scope, projectId: "project-a", originKey: current.locationKey, connection: current.connection, draft: current.draft })).toBe(true);
    return { store, current, target: { ...current, pathname: "/canvas/project-a", locationKey: "canvas-a", projectId: "project-a" } };
}
const confirmation = { nonce: "launch-a", accepted: true, projectId: "project-a" };

test("the unified Agent origin survives until its acknowledged canvas; other create modes cancel without sending", () => {
    const { store, current, target } = staged();
    const origin = { ...current, pathname: "/create", search: "?mode=agent&source=legacy" };
    expect(store.getState().sync(origin)).toBeNull();
    expect(store.getState().claim(origin, confirmation)).toBeNull();
    expect(store.getState().sync(target)).toBeNull();
    expect(store.getState().claim(target, confirmation)?.nonce).toBe("launch-a");
    expect(store.getState().claim(target, confirmation)).toBeNull();
    for (const search of ["?mode=image", "?mode=audio", "?mode=agent&mode=image", ""]) {
        const next = staged();
        expect(next.store.getState().sync({ ...next.current, pathname: "/create", search })).toContain("取消");
        expect(next.store.getState().pending).toBeNull();
        expect(next.store.getState().claim(next.target, confirmation)).toBeNull();
    }
});

test("home to the real target project is allowed, but only an accepted matching state acknowledgement claims it once", () => {
    const { store, current, target } = staged();
    expect(store.getState().sync(current)).toBeNull();
    expect(store.getState().claim(current, confirmation)).toBeNull();
    expect(store.getState().sync({ ...target, projectId: null })).toBeNull();
    expect(store.getState().claim({ ...target, projectId: null }, confirmation)).toBeNull();
    expect(store.getState().claim(target, { ...confirmation, accepted: false })).toBeNull();
    expect(store.getState().claim(target, { ...confirmation, nonce: "old-post" })).toBeNull();
    expect(store.getState().claim(target, { ...confirmation, projectId: "old-project" })).toBeNull();
    expect(store.getState().claim(target, confirmation)?.nonce).toBe("launch-a");
    expect(store.getState().claim(target, confirmation)).toBeNull();
    expect(store.getState().notice).toContain("核对受理结果");
});

test("account replacement, logout and epoch changes invalidate the launch without mutating its draft", () => {
    for (const next of [null, { ...scope, epoch: 2 }, { accountId: "creation-b", epoch: 1 }]) {
        const { store, current, target } = staged(), draft = current.draft;
        expect(store.getState().sync({ ...target, scope: next })).toContain("账号");
        expect(store.getState().pending).toBeNull();
        expect(store.getState().claim(target, confirmation)).toBeNull();
        expect(current.draft).toBe(draft);
        expect(draft.prompt).toBe("创作一张海报");
    }
});

test("new prompt, uploads, references, skill or model parameters cancel automatic intent and retain current edits", () => {
    for (const patch of [{ prompt: "用户继续编辑" }, { attachments: [] }, { canvasReferences: [] }, { skillRevision: 4 },
        { model: "other" }, { reasoningEffort: "ultra" as const }, { permissionMode: "automatic" as const }]) {
        const { store, target } = staged(), next = { ...target, draft: { ...target.draft, ...patch } };
        expect(store.getState().sync(next)).toContain("草稿或参数");
        expect(store.getState().pending).toBeNull();
        expect(next.draft).toMatchObject(patch);
    }
});

test("connection, workspace and conversation changes cancel without an automatic retry", () => {
    for (const patch of [{ url: "http://127.0.0.1:1" }, { token: "changed-synthetic" }, { enabled: false }, { workspacePath: "/other" }, { threadId: "thread-b" }, { conversationId: "conversation-b" }]) {
        const { store, target } = staged();
        expect(store.getState().sync({ ...target, connection: { ...target.connection, ...patch } })).toContain("连接或会话");
        expect(store.getState().claim(target, confirmation)).toBeNull();
    }
});

test("leaving the target or revisiting home through a different history entry cancels the launch", () => {
    const first = staged();
    expect(first.store.getState().sync({ ...first.current, locationKey: "home-after-back" })).toContain("离开");
    const second = staged();
    second.store.getState().sync(second.target);
    expect(second.store.getState().sync(second.current)).toContain("离开");
    expect(second.store.getState().claim(second.target, confirmation)).toBeNull();
});

test("refresh creates no pending action and an older controller cleanup cannot unregister the live owner", () => {
    const { store } = staged(), refreshed = createCreationAgentLaunchStore();
    expect(refreshed.getState().pending).toBeNull();
    const action = (): CreationAgentComposerActions => ({ addFiles() {}, removeAttachment() {}, stop() {}, changePermissionMode() {}, unavailableReason: () => null, send: async () => {} });
    const older = action(), newer = action(), close = store.getState().register(older);
    store.getState().register(newer); close();
    expect(store.getState().actions).toBe(newer);
    const live = store.getState().register(action()); live();
    expect(store.getState().pending).toBeNull();
    expect(store.getState().notice).toContain("离开 Agent 页面");
});

test("a manual attempt cancels the pending launch before any unknown response, so a later acknowledgement cannot resend", () => {
    const { store, target } = staged(), draft = target.draft;
    store.getState().sync(target);
    expect(store.getState().cancel("已改为手动发送，已取消首页自动发送；请核对原会话。 ")).toBe(true);
    // The manual response is intentionally unknown: the original editable draft still exists.
    expect(draft.prompt).toBe("创作一张海报");
    expect(store.getState().claim(target, confirmation)).toBeNull();
    expect(store.getState().sync(target)).toBeNull();
    expect(store.getState().claim(target, confirmation)).toBeNull();
});

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const empty = (): CreationAgentSavedDraft => ({ prompt: "", attachments: [], canvasReferences: [], skill: null, autoPrompt: "" });
function draftFixture() {
    let currentScope: typeof scope | null = { ...scope }, visible = empty();
    const saved = new Map<string, CreationAgentSavedDraft>(), writes: Array<{ accountId: string; draft: CreationAgentSavedDraft }> = [], publications: CreationAgentSavedDraft[] = [];
    const hooks = { read: async (accountId: string): Promise<unknown> => saved.get(accountId) ?? null, write: async (_accountId: string, _draft: CreationAgentSavedDraft): Promise<void> => {} };
    const store = createCreationAgentLaunchStore({ getScope: () => currentScope, current: () => visible,
        publish: draft => { visible = draft; publications.push(draft); void store.getState().saveDraft(); },
        storage: ({ accountId }) => ({ getItem: () => hooks.read(accountId), setItem: async (_key, draft) => { writes.push({ accountId, draft }); await hooks.write(accountId, draft); saved.set(accountId, draft); } }) });
    return { store, hooks, writes, saved, publications, scope: (next: typeof scope | null) => { currentScope = next; },
        edit: (prompt: string) => { visible = { ...visible, prompt }; return store.getState().saveDraft(); }, visible: () => visible };
}

test("switching accounts hides the previous draft synchronously, rejects late reads and restores only its own account", async () => {
    const f = draftFixture(), oldRead = deferred<unknown>();
    f.hooks.read = accountId => accountId === scope.accountId ? oldRead.promise : Promise.resolve({ ...empty(), prompt: "B 的草稿" });
    const first = f.store.getState().loadDraft();
    f.scope({ accountId: "creation-b", epoch: 2 }); const second = f.store.getState().loadDraft();
    expect(f.visible().prompt).toBe("");
    await second;
    expect(f.visible().prompt).toBe("B 的草稿");
    oldRead.resolve({ ...empty(), prompt: "迟到的 A 草稿" }); await first;
    expect(f.visible().prompt).toBe("B 的草稿");
    await f.edit("B 的新编辑");
    f.scope({ ...scope, epoch: 3 });
    f.hooks.read = async accountId => f.saved.get(accountId) ?? { ...empty(), prompt: "A 的草稿" };
    await f.store.getState().loadDraft();
    expect(f.visible().prompt).toBe("A 的草稿");
    expect(f.writes.every(write => write.accountId === "creation-b")).toBe(true);
    f.scope(null); const logout = f.store.getState().loadDraft();
    expect(f.visible().prompt).toBe(""); await logout;
    expect(f.store.getState().draftReady).toBe(false);
});

test("draft writes retain owner during switches, restore after refresh and never persist the launch nonce", async () => {
    const f = draftFixture(); await f.store.getState().loadDraft();
    const write = deferred<void>(); f.hooks.write = () => write.promise;
    const saving = f.edit("A 的尚在保存草稿");
    f.scope({ accountId: "creation-b", epoch: 2 }); await f.store.getState().loadDraft();
    expect(f.visible().prompt).toBe("");
    write.resolve(); await saving;
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].accountId).toBe(scope.accountId);
    expect(Object.keys(f.writes[0].draft).sort()).toEqual(["attachments", "autoPrompt", "canvasReferences", "prompt", "skill"]);
    expect(f.saved.get(scope.accountId)?.prompt).toBe("A 的尚在保存草稿");
    f.scope({ ...scope, epoch: 4 }); await f.store.getState().loadDraft();
    expect(f.visible().prompt).toBe("A 的尚在保存草稿");
    const fresh = createCreationAgentLaunchStore({ getScope: () => scope, current: empty, publish() {}, storage: () => ({ getItem: async () => f.saved.get(scope.accountId), setItem: async () => {} }) });
    await fresh.getState().loadDraft();
    expect(fresh.getState().draftReady).toBe(true);
    expect(fresh.getState().pending).toBeNull();
});

test("inspiration awaits initialization and an intervening account change cannot overwrite the new draft", async () => {
    const f = draftFixture(), reading = deferred<unknown>(); f.hooks.read = () => reading.promise;
    const inspired = f.store.getState().inspire("灵感提示词");
    expect(f.visible().prompt).toBe("");
    f.scope({ accountId: "creation-b", epoch: 2 });
    f.hooks.read = async () => ({ ...empty(), prompt: "B 保留内容" }); await f.store.getState().loadDraft();
    reading.resolve(empty());
    expect(await inspired).toBe(false);
    expect(f.visible().prompt).toBe("B 保留内容");
    expect(await f.store.getState().inspire("B 的灵感")).toBe(true);
    expect(f.visible().prompt).toBe("B 的灵感");
    expect(f.store.getState().pending).toBeNull();
});

test("storage errors retain the current input, block automatic launch and can recover on a manual save", async () => {
    const f = draftFixture(); await f.store.getState().loadDraft();
    f.hooks.write = async () => { throw new Error("synthetic storage failure"); };
    await f.edit("保存失败也不能清除");
    expect(f.visible().prompt).toBe("保存失败也不能清除");
    expect(f.store.getState().draftError).toContain("保存失败");
    const input = runtime();
    expect(f.store.getState().stage({ nonce: "blocked", scope, projectId: "project-a", originKey: input.locationKey, draft: input.draft, connection: input.connection })).toBe(false);
    f.hooks.write = async () => {}; await f.store.getState().saveDraft();
    expect(f.store.getState().draftError).toBe("");
});

test("inspiration cannot overwrite an edit made while its initialization promise settles", async () => {
    const f = draftFixture(); await f.store.getState().loadDraft();
    const inspired = f.store.getState().inspire("迟到灵感");
    await f.edit("刚输入的新内容");
    expect(await inspired).toBe(false);
    expect(f.visible().prompt).toBe("刚输入的新内容");
});

test("a failed draft read preserves storage and only an explicit read retry restores the account draft", async () => {
    const f = draftFixture(); f.hooks.read = async () => { throw new Error("synthetic read failure"); };
    await f.store.getState().loadDraft();
    expect(f.store.getState().draftReady).toBe(false);
    expect(f.store.getState().draftError).toContain("synthetic read failure");
    expect(f.writes).toHaveLength(0);
    f.hooks.read = async () => ({ ...empty(), prompt: "原来保存的草稿" });
    await f.store.getState().loadDraft(true);
    expect(f.store.getState().draftReady).toBe(true);
    expect(f.visible().prompt).toBe("原来保存的草稿");
    expect(f.writes).toHaveLength(0);
});

test("fourteen account draft images reload intact and thirteen or fourteen never stage an AI request", async () => {
    const attachments = Array.from({ length: 14 }, (_, index) => ({ id: `upload-${index}`, name: `${index}.png`, type: "image/png", size: 1, width: 1, height: 1,
        dataUrl: "data:image/png;base64,AA==", url: "blob:old-preview" }));
    const saved = { ...empty(), prompt: "保留14张图片", attachments };
    let visible = empty();
    const store = createCreationAgentLaunchStore({ getScope: () => scope, current: () => visible, publish(draft) { visible = draft; },
        storage: () => ({ getItem: async () => saved, setItem: async () => {} }) });
    await store.getState().loadDraft();
    expect(store.getState().draftReady).toBe(true);
    expect(visible.attachments).toHaveLength(14);
    expect(visible.attachments.map(item => item.id)).toEqual(attachments.map(item => item.id));
    expect(visible.attachments.every(item => item.url === item.dataUrl)).toBe(true);
    const current = runtime(), launch = { nonce: "limit-test", scope, projectId: "project-a", originKey: current.locationKey, connection: current.connection, draft: current.draft };
    for (const count of [13, 14]) {
        expect(store.getState().stage({ ...launch, draft: { ...current.draft, attachments: visible.attachments.slice(0, count) } })).toBe(false);
        expect(store.getState().pending).toBeNull();
        expect(store.getState().notice).toContain("单次发送给 AI 最多 12");
        expect(visible.attachments).toHaveLength(14);
    }
    expect(store.getState().stage({ ...launch, draft: { ...current.draft, attachments: visible.attachments.slice(0, 12) } })).toBe(true);
    expect(store.getState().pending?.draft.attachments).toHaveLength(12);
});

test("invalid draft sources return false from stage while leaving the source draft untouched", () => {
    const current = runtime(), store = createCreationAgentLaunchStore();
    const draft = { ...current.draft, attachments: [{ id: "invalid", dataUrl: "not-an-image" }] } as unknown as CreationAgentRuntime["draft"];
    expect(store.getState().stage({ nonce: "invalid-source", scope, projectId: "project-a", originKey: current.locationKey, connection: current.connection, draft })).toBe(false);
    expect(store.getState().pending).toBeNull();
    expect(store.getState().notice).toContain("无效");
    expect(draft.attachments[0].dataUrl).toBe("not-an-image");
});
