import { expect, test } from "bun:test";
import { createCreationMediaLaunchStore, emptyAudioParameters, type CreationMediaDraft, type CreationMediaKind, type CreationMediaScope } from "@/stores/use-creation-media-launch";
import { applyPreparedInspiration, buildInspirationHref, prepareInspirationDraft, readInspirationDraftIntent } from "./inspiration-draft-handoff";

const owner = { accountId: "inspiration-owner", epoch: 1 };
const input = (kind: CreationMediaKind = "image", prompt = "我的原草稿") => ({ kind, prompt, references: [{ id: "reference", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AAA" }], parameters: kind === "audio" ? { ...emptyAudioParameters(), model: "speech-one", voice: "alloy" } : { model: "personal::image", size: "1024x1024" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
    let scope: CreationMediaScope | null = { ...owner };
    const rows = new Map<string, CreationMediaDraft>(), writes: Array<{ scope: CreationMediaScope; draft: CreationMediaDraft }> = [];
    const hooks = { read: async (key: string): Promise<unknown> => rows.get(key) ?? null, write: async () => {} };
    const getScope = () => scope;
    const store = createCreationMediaLaunchStore({ getScope, storage: account => ({ getItem: kind => hooks.read(`${account.accountId}:${kind}`), setItem: async (kind, draft) => { writes.push({ scope: account, draft }); await hooks.write(); rows.set(`${account.accountId}:${kind}`, structuredClone(draft)); } }) });
    return { store, getScope, rows, writes, hooks, change(next: CreationMediaScope | null) { scope = next; return store.getState().load(); } };
}

test("public inspiration links round-trip prompt characters and never accept ambiguous or unsupported modes", () => {
    const prompt = "金色包装 & A+B /? # @图片1\n下一行";
    const href = buildInspirationHref("video", prompt);
    expect(new URL(href, "https://canvas.invalid").pathname).toBe("/create");
    expect(readInspirationDraftIntent(new URL(href, "https://canvas.invalid").search)).toEqual({ intent: { kind: "video", prompt }, invalid: false });
    for (const search of ["?mode=agent&prompt=one", "?mode=image&mode=audio&prompt=one", "?mode=image&prompt=one&prompt=two", "?prompt=one", "?mode=video&prompt=%20%20", "?mode=bogus", "?mode=image&mode=video"]) {
        expect(readInspirationDraftIntent(search)).toEqual({ intent: null, invalid: true });
    }
    expect(readInspirationDraftIntent("?unrelated=value")).toEqual({ intent: null, invalid: false });
    for (const mode of ["image", "video", "audio", "agent"]) expect(readInspirationDraftIntent(`?mode=${mode}&receipt=retained`)).toEqual({ intent: null, invalid: false });
    const longPrompt = "完整公开提示词".repeat(5_000);
    expect(readInspirationDraftIntent(new URL(buildInspirationHref("audio", longPrompt), "https://canvas.invalid").search).intent?.prompt).toBe(longPrompt);
});

test("preparation only reads existing drafts; keeping or revisiting the URL does not edit, stage or cancel them", async () => {
    const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input()); await f.store.getState().stage("image");
    const before = f.store.getState().drafts.image, pending = f.store.getState().pending, written = f.writes.length;
    const prepared = await prepareInspirationDraft({ kind: "image", prompt: "管理员灵感" }, f);
    expect(prepared?.existingPrompt).toBe("我的原草稿"); expect(prepared?.referenceCount).toBe(1);
    expect(f.store.getState().drafts.image).toBe(before); expect(f.store.getState().pending).toBe(pending); expect(f.writes).toHaveLength(written);
    await prepareInspirationDraft({ kind: "image", prompt: "管理员灵感" }, f);
    expect(f.store.getState().drafts.image).toBe(before); expect(f.writes).toHaveLength(written);
});

test.each(["image", "video", "audio"] as const)("only explicit confirmation fills %s and preserves references and parameters without staging generation", async kind => {
    const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input(kind)); await f.store.getState().edit(input(kind === "image" ? "video" : "image", "另一模式原稿"));
    const before = f.store.getState().drafts[kind]!;
    const prepared = (await prepareInspirationDraft({ kind, prompt: "管理员灵感" }, f))!;
    await f.store.getState().stage(kind);
    expect(await applyPreparedInspiration(prepared, f)).toBe("applied");
    const after = f.store.getState().drafts[kind]!;
    expect(after.prompt).toBe("管理员灵感"); expect(after.references).toEqual(before.references);
    expect(after.parameters).toEqual(kind === "audio" ? { ...before.parameters, prompt: "管理员灵感" } : before.parameters);
    expect(f.store.getState().drafts[kind === "image" ? "video" : "image"]?.prompt).toBe("另一模式原稿");
    expect(f.store.getState().pending).toBeNull();
});

test("new edits after confirmation was prepared invalidate it without replacing the new draft", async () => {
    const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input());
    const prepared = (await prepareInspirationDraft({ kind: "image", prompt: "旧灵感" }, f))!;
    await f.store.getState().edit(input("image", "用户新输入")); const written = f.writes.length;
    expect(await applyPreparedInspiration(prepared, f)).toBe("changed");
    expect(f.store.getState().drafts.image?.prompt).toBe("用户新输入"); expect(f.writes).toHaveLength(written);
});

test("double confirmation cannot replace twice while the first draft write is pending", async () => {
    const f = fixture(); await f.store.getState().load(); const writing = deferred<void>(); f.hooks.write = () => writing.promise;
    const prepared = (await prepareInspirationDraft({ kind: "image", prompt: "只填一次" }, f))!;
    const first = applyPreparedInspiration(prepared, f), second = applyPreparedInspiration(prepared, f);
    expect(await second).toBe("changed"); writing.resolve(); expect(await first).toBe("applied");
    expect(f.writes).toHaveLength(1); expect(f.store.getState().pending).toBeNull();
});

test("logout, replacement account and new epochs refuse old explicit confirmations", async () => {
    for (const scope of [null, { accountId: "another", epoch: 1 }, { ...owner, epoch: 2 }]) {
        const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input());
        const prepared = (await prepareInspirationDraft({ kind: "image", prompt: "旧账号灵感" }, f))!;
        await f.change(scope); const written = f.writes.length;
        expect(await applyPreparedInspiration(prepared, f)).toBe("changed"); expect(f.writes).toHaveLength(written);
        expect(f.store.getState().pending).toBeNull();
    }
});

test("an outstanding preparation cannot publish a previous-account draft after account replacement", async () => {
    const f = fixture(), reading = deferred<unknown>();
    f.hooks.read = key => key === `${owner.accountId}:image` ? reading.promise : Promise.resolve(null);
    const preparing = prepareInspirationDraft({ kind: "image", prompt: "灵感" }, f);
    await f.change({ accountId: "another", epoch: 2 }); reading.resolve({ ...input(), revision: 2 });
    expect(await preparing).toBeNull(); expect(f.writes).toHaveLength(0); expect(f.store.getState().drafts).toEqual({});
});

test("anonymous links do not read or write any account draft", async () => {
    const f = fixture(); await f.change(null);
    f.hooks.read = async () => { throw new Error("anonymous draft access"); };
    expect(await prepareInspirationDraft({ kind: "audio", prompt: "公开灵感" }, f)).toBeNull();
    expect(f.writes).toHaveLength(0); expect(f.store.getState().drafts).toEqual({});
});

test("an accepted draft write stays pinned to its old account and cannot report success after a switch", async () => {
    const f = fixture(); await f.store.getState().load(); const writing = deferred<void>();
    const prepared = (await prepareInspirationDraft({ kind: "video", prompt: "原账号明确确认" }, f))!;
    f.hooks.write = () => writing.promise;
    const confirming = applyPreparedInspiration(prepared, f);
    await f.change({ accountId: "another", epoch: 2 }); writing.resolve();
    expect(await confirming).toBe("changed"); expect(f.writes.map(row => row.scope.accountId)).toEqual([owner.accountId]);
    expect(f.rows.get(`${owner.accountId}:video`)?.prompt).toBe("原账号明确确认");
    expect(f.rows.has("another:video")).toBe(false); expect(f.store.getState().drafts).toEqual({}); expect(f.store.getState().pending).toBeNull();
});

test("failed persistence keeps the confirmed prompt visible and never creates a generation intent", async () => {
    const f = fixture(); await f.store.getState().load(); await f.store.getState().edit(input());
    const prepared = (await prepareInspirationDraft({ kind: "image", prompt: "已确认的新提示词" }, f))!;
    f.hooks.write = async () => { throw new Error("storage failure"); };
    expect(await applyPreparedInspiration(prepared, f)).toBe("save-failed");
    expect(f.store.getState().drafts.image?.prompt).toBe("已确认的新提示词"); expect(f.store.getState().drafts.image?.references).toEqual(input().references);
    expect(f.store.getState().error).toContain("保存失败"); expect(f.store.getState().pending).toBeNull();
});
