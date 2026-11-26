import { expect, test } from "bun:test";
import { createCreationMediaLaunchStore, emptyAudioParameters, personalMediaParameters, type CreationMediaDraft, type CreationMediaKind, type CreationMediaScope } from "./use-creation-media-launch";

const owner = { accountId: "media-owner-a", epoch: 1 };
const input = (kind: CreationMediaKind = "image", prompt = "保留这份草稿") => ({ kind, prompt, references: [], parameters: kind === "audio" ? { ...emptyAudioParameters(), prompt, model: "speech-one", voice: "alloy" } : { model: "personal::image", quality: "high", size: "1024x1024" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
    let scope: CreationMediaScope | null = { ...owner }, sequence = 0;
    const rows = new Map<string, CreationMediaDraft>(), written: Array<{ accountId: string; draft: CreationMediaDraft }> = [];
    const hooks = { read: async (key: string): Promise<unknown> => rows.get(key) ?? null, write: async (key: string, value: CreationMediaDraft) => { rows.set(key, structuredClone(value)); } };
    const options = { getScope: () => scope, nonce: () => `nonce-${++sequence}`, storage: (account: CreationMediaScope) => ({
        getItem: (kind: CreationMediaKind) => hooks.read(`${account.accountId}:${kind}`),
        setItem: (kind: CreationMediaKind, draft: CreationMediaDraft) => { written.push({ accountId: account.accountId, draft }); return hooks.write(`${account.accountId}:${kind}`, draft); },
    }) };
    const store = createCreationMediaLaunchStore(options);
    return { store, rows, written, hooks, options, change(next: CreationMediaScope | null) { scope = next; return store.getState().load(); } };
}

test("a staged intent is taken once and refresh restores only the account draft", async () => {
    const f = fixture(); await f.store.getState().load();
    await f.store.getState().edit(input());
    expect(await f.store.getState().stage("image")).toBe(true);
    const launch = f.store.getState().take("image");
    expect(launch?.nonce).toBe("nonce-1");
    expect(f.store.getState().take("image")).toBeNull();
    expect(f.store.getState().drafts.image?.prompt).toBe("保留这份草稿");
    const refreshed = createCreationMediaLaunchStore(f.options); await refreshed.getState().load();
    expect(refreshed.getState().pending).toBeNull();
    expect(refreshed.getState().take("image")).toBeNull();
    expect(refreshed.getState().drafts.image?.prompt).toBe("保留这份草稿");
});

test("mapped image and video identities survive draft reload and never leak into personal provider parameters", async () => {
    const selections = {
        image: { model: "image-source", imageModel: "image-source", mappingModelId: "image-family", mappingSpecification: "1K", size: "1024x1024", quality: "high" },
        video: { source: "platform-video" as const, modelId: "video-source", mappingModelId: "video-family", specification: "720P", parameters: { mode: "text" as const, resolution: "720p" as const, durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" as const } },
    };
    for (const kind of ["image", "video"] as const) {
        const f = fixture(); await f.store.getState().load();
        expect(await f.store.getState().edit({ ...input(kind), parameters: selections[kind] })).toBe(true);
        const refreshed = createCreationMediaLaunchStore(f.options); await refreshed.getState().load();
        expect(refreshed.getState().drafts[kind]?.parameters).toEqual(selections[kind]);
        expect(refreshed.getState().pending).toBeNull();
        expect(personalMediaParameters(selections[kind])).not.toHaveProperty("mappingModelId");
        expect(personalMediaParameters(selections[kind])).not.toHaveProperty("mappingSpecification");
    }
});

test("double submission cannot create a second pending intent", async () => {
    const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input());
    expect(await Promise.all([f.store.getState().stage("image"), f.store.getState().stage("image")])).toEqual([true, false]);
    expect(f.store.getState().pending?.nonce).toBe("nonce-1");
});

test("one video resolution event retains both callbacks through persistence and launch", async () => {
    const f = fixture(), writing = deferred<void>(); await f.store.getState().load();
    const parameters = { model: "personal::video", videoModel: "personal::video", vquality: "720", size: "1280x720" };
    await f.store.getState().edit({ ...input("video"), parameters });
    f.hooks.write = async (key, draft) => { await writing.promise; f.rows.set(key, structuredClone(draft)); };
    // VideoSettingsPanel.applySize emits quality, then size before React renders again.
    const quality = f.store.getState().editPersonalParameter("video", "vquality", "1080", parameters);
    const size = f.store.getState().editPersonalParameter("video", "size", "1920x1080", parameters);
    const expected = { ...parameters, vquality: "1080", size: "1920x1080" };
    expect(f.store.getState().drafts.video?.parameters).toEqual(expected);
    writing.resolve(); await Promise.all([quality, size]);
    expect(await f.store.getState().stage("video")).toBe(true);
    expect(f.store.getState().take("video")?.draft.parameters).toEqual(expected);
    const reloaded = createCreationMediaLaunchStore(f.options); await reloaded.getState().load();
    expect(reloaded.getState().drafts.video?.parameters).toEqual(expected);
    expect(reloaded.getState().drafts.video?.prompt).toBe("保留这份草稿");
});

test("editing while an intent waits for persistence prevents the older revision from launching", async () => {
    const f = fixture(), writing = deferred<void>(); await f.store.getState().load();
    f.hooks.write = async (key, draft) => { await writing.promise; f.rows.set(key, structuredClone(draft)); };
    const firstWrite = f.store.getState().edit(input()), staging = f.store.getState().stage("image");
    const newWrite = f.store.getState().edit(input("image", "保存中的新输入"));
    writing.resolve(); await Promise.all([firstWrite, newWrite]);
    expect(await staging).toBe(false);
    expect(f.store.getState().pending).toBeNull();
    expect(f.store.getState().drafts.image?.prompt).toBe("保存中的新输入");
});

test("an outstanding draft write remains pinned to its originating account", async () => {
    const f = fixture(), writing = deferred<void>(); await f.store.getState().load();
    f.hooks.write = async (key, draft) => { await writing.promise; f.rows.set(key, structuredClone(draft)); };
    const pending = f.store.getState().edit(input());
    await f.change({ accountId: "media-owner-b", epoch: 2 });
    writing.resolve(); expect(await pending).toBe(false);
    expect(f.written.map(item => item.accountId)).toEqual([owner.accountId]);
    expect(f.rows.has("media-owner-b:image")).toBe(false);
    expect(f.store.getState().drafts).toEqual({});
});

test("edits invalidate the execution revision while retaining the edited draft", async () => {
    const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input()); await f.store.getState().stage("image");
    const launch = f.store.getState().take("image")!;
    await f.store.getState().edit(input("image", "随后编辑的内容"));
    expect(f.store.getState().isCurrent(launch)).toBe(false);
    expect(f.store.getState().pending).toBeNull();
    expect(f.store.getState().drafts.image?.prompt).toBe("随后编辑的内容");
});

test("account changes, logout and new epochs cancel intent and reject a claimed old scope", async () => {
    for (const next of [null, { accountId: "media-owner-b", epoch: 1 }, { ...owner, epoch: 2 }]) {
        const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input()); await f.store.getState().stage("image");
        const launch = f.store.getState().pending!;
        await f.change(next);
        expect(f.store.getState().pending).toBeNull();
        expect(f.store.getState().isCurrent(launch)).toBe(false);
        expect(f.store.getState().take("image")).toBeNull();
        if (next?.accountId === "media-owner-b") expect(f.store.getState().drafts.image).toBeUndefined();
    }
});

test("a late previous-account read cannot publish its draft over the new account", async () => {
    const f = fixture(), oldRead = deferred<unknown>();
    f.hooks.read = key => key === `${owner.accountId}:image` ? oldRead.promise : Promise.resolve(null);
    const first = f.store.getState().load();
    await f.change({ accountId: "media-owner-b", epoch: 2 });
    oldRead.resolve({ ...input(), revision: 4 }); await first;
    expect(f.store.getState().scope?.accountId).toBe("media-owner-b");
    expect(f.store.getState().drafts).toEqual({});
    expect(f.store.getState().ready).toBe(true);
});

test("the first inspiration click waits for hydration and only fills its own media tab", async () => {
    const f = fixture(), reading = deferred<unknown>();
    f.rows.set(`${owner.accountId}:audio`, { ...input("audio", "原朗读稿"), revision: 3 });
    f.hooks.read = key => key === `${owner.accountId}:image` ? reading.promise : Promise.resolve(f.rows.get(key) ?? null);
    const inspiring = f.store.getState().inspire("video", "新的分镜想法");
    expect(f.store.getState().loading).toBe(true); reading.resolve(null);
    expect(await inspiring).toBe(true);
    expect(f.store.getState().drafts.video?.prompt).toBe("新的分镜想法");
    expect(f.store.getState().drafts.audio?.prompt).toBe("原朗读稿");
    expect(f.store.getState().pending).toBeNull();
});

test("an inspiration callback cannot overwrite an edit made while it yields", async () => {
    const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input());
    const inspiring = f.store.getState().inspire("image", "旧捷径");
    const editing = f.store.getState().edit(input("image", "本人最新输入"));
    expect(await inspiring).toBe(false); await editing;
    expect(f.store.getState().drafts.image?.prompt).toBe("本人最新输入");
});

test("fourteen references survive storage and reload while a single request still refuses thirteen or fourteen", async () => {
    const f = fixture(); await f.store.getState().load();
    const references = Array.from({ length: 14 }, (_, i) => ({ id: `ref-${i}`, name: `${i}.png`, type: "image/png", dataUrl: `data:image/png;base64,${i}` }));
    expect(await f.store.getState().edit({ ...input(), references })).toBe(true);
    expect(await f.store.getState().stage("image")).toBe(false);
    expect(f.store.getState().pending).toBeNull();
    expect(f.store.getState().drafts.image?.references).toEqual(references);
    const reloaded = createCreationMediaLaunchStore(f.options); await reloaded.getState().load();
    expect(reloaded.getState().drafts.image?.references).toEqual(references);
    expect(await reloaded.getState().edit({ ...input(), references: references.slice(0, 13) })).toBe(true);
    expect(await reloaded.getState().stage("image")).toBe(false);
    expect(await reloaded.getState().edit({ ...input(), references: references.slice(0, 12) })).toBe(true);
    expect(await reloaded.getState().stage("image")).toBe(true);
    expect(reloaded.getState().take("image")?.draft.references).toHaveLength(12);
    expect(await f.store.getState().edit({ ...input(), references: [...references, { ...references[0], id: "ref-15" }] })).toBe(false);
    expect(f.store.getState().drafts.image?.references).toEqual(references);
    expect(f.store.getState().error).toContain("14");
});

test("the video execution limit stays separate from fourteen-reference draft capacity", async () => {
    const f = fixture(); await f.store.getState().load();
    const references = Array.from({ length: 8 }, (_, i) => ({ id: `ref-${i}`, name: `${i}.png`, type: "image/png", dataUrl: `data:image/png;base64,${i}` }));
    expect(await f.store.getState().edit({ ...input("video"), references })).toBe(true);
    expect(await f.store.getState().stage("video")).toBe(false);
    expect(f.store.getState().drafts.video?.references).toEqual(references);
    expect(await f.store.getState().edit({ ...input("video"), references: references.slice(0, 7) })).toBe(true);
    expect(await f.store.getState().stage("video")).toBe(true);
});

test("failed draft persistence keeps the editable draft and prevents an automatic intent", async () => {
    const f = fixture(); await f.store.getState().load(); f.hooks.write = async () => { throw new Error("quota"); };
    expect(await f.store.getState().edit(input())).toBe(false);
    expect(f.store.getState().drafts.image?.prompt).toBe("保留这份草稿");
    expect(await f.store.getState().stage("image")).toBe(false);
    expect(f.store.getState().pending).toBeNull();
    expect(f.store.getState().error).toContain("保存失败");
});

test("draft persistence excludes provider credentials and ephemeral image URLs and rebuilds references", async () => {
    const f = fixture(); await f.store.getState().load();
    await f.store.getState().edit({ ...input(), parameters: { model: "personal::image", apiKey: "must-not-persist", baseUrl: "https://example.invalid" } as never,
        references: [{ id: "ref-1", name: "one.png", type: "image/png", dataUrl: "blob:old-preview", storageKey: "local-image-one" }] });
    expect(f.written[0].draft.parameters).toEqual({ model: "personal::image" });
    expect(f.written[0].draft.references[0].dataUrl).toBe("");
    const refreshed = createCreationMediaLaunchStore({ ...f.options, resolveReferences: async references => references.map(reference => ({ ...reference, dataUrl: `blob:resolved-${reference.storageKey}` })) });
    await refreshed.getState().load();
    expect(refreshed.getState().drafts.image?.references[0].dataUrl).toBe("blob:resolved-local-image-one");
    expect(refreshed.getState().pending).toBeNull();
});
