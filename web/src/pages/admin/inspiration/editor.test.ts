import { expect, test } from "bun:test";
import type { InspirationCatalog, InspirationItem } from "@/services/saas/inspiration";
import type { AdminGenerationScope } from "@/services/saas/platform";
import { createInspirationEditor, type InspirationEditorState } from "./editor";

const item = (prompt = "已保存提示词"): InspirationItem => ({ id: "sample", type: "image", title: "示例灵感", prompt, imageUrl: "/inspiration-assets/sample.png", tags: ["示例"] });
const catalog = (revision: InspirationCatalog["revision"], prompt?: string): InspirationCatalog => ({ revision, items: [item(prompt)] });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(client: Parameters<typeof createInspirationEditor>[0]["client"]) {
    let scope: AdminGenerationScope | null = { accountId: "admin-a", epoch: 3, role: "admin" };
    const states: InspirationEditorState[] = [];
    const editor = createInspirationEditor({ client, getScope: () => scope, onState: state => states.push(state) });
    return { editor, states, replaceScope: (next: AdminGenerationScope | null) => { scope = next; } };
}

test("editing is local until an explicit save uses the read revision and accepts the server receipt", async () => {
    const writes: unknown[] = [];
    const { editor } = fixture({ read: async () => catalog(1), save: async input => { writes.push(input); return catalog(2, input.items[0].prompt); } });
    await editor.read();
    const changed = [item("新提示词")];
    editor.edit(changed); changed[0].prompt = "外部数组变化";
    expect(editor.getState().items[0].prompt).toBe("新提示词");
    expect(writes).toHaveLength(0);
    expect(editor.getState().dirty).toBe(true);
    await editor.save();
    expect(writes).toEqual([{ expectedRevision: 1, items: [item("新提示词")] }]);
    expect(editor.getState().baseline?.revision).toBe(2);
    expect(editor.getState().dirty).toBe(false);
    expect(editor.getState().phase).toBe("ready");
});

test("reading while dirty preserves the draft and requires an explicit choice before saving against the newer version", async () => {
    let version = 1; const writes: unknown[] = [];
    const { editor } = fixture({ read: async () => catalog(version, `服务器${version}`), save: async input => { writes.push(input); return { revision: version + 1, items: input.items }; } });
    await editor.read(); editor.edit([item("本机编辑")]); version = 2;
    await editor.read();
    expect(editor.getState().items[0].prompt).toBe("本机编辑");
    expect(editor.getState().verification?.items[0].prompt).toBe("服务器2");
    await editor.save(); expect(writes).toHaveLength(0);
    editor.keepDraft();
    expect(editor.getState().baseline?.revision).toBe(2);
    expect(editor.getState().dirty).toBe(true);
    await editor.save(); expect(writes).toEqual([{ expectedRevision: 2, items: [item("本机编辑")] }]);
});

test("adopting a verified server list replaces local edits only after the explicit choice", async () => {
    let version = 1;
    const { editor } = fixture({ read: async () => catalog(version, `服务器${version}`), save: async () => { throw Error("unexpected save"); } });
    await editor.read(); editor.edit([item("本机编辑")]); version = 2; await editor.read();
    expect(editor.getState().items[0].prompt).toBe("本机编辑");
    editor.adoptVerified();
    expect(editor.getState().items[0].prompt).toBe("服务器2");
    expect(editor.getState().dirty).toBe(false);
    expect(editor.getState().phase).toBe("ready");
});

test.each(["unknown", "conflict", "permission"])("%s save results retain edits and never resend without a read and explicit decision", async kind => {
    let writes = 0, reads = 0;
    const failure = Object.assign(new Error("请先核对"), { outcome: kind === "unknown" ? "unknown" : "rejected", status: kind === "conflict" ? 409 : kind === "permission" ? 403 : 0 });
    const { editor } = fixture({ read: async () => { reads++; return catalog(1); }, save: async () => { writes++; throw failure; } });
    await editor.read(); editor.edit([item("保留的编辑")]); await editor.save();
    expect(editor.getState().phase).toBe("check-required");
    expect(editor.getState().items[0].prompt).toBe("保留的编辑");
    await editor.save(); editor.keepDraft(); await editor.save();
    expect(writes).toBe(1); expect(reads).toBe(1);
    await editor.read();
    expect(editor.getState().items[0].prompt).toBe("保留的编辑");
    expect(editor.getState().phase).toBe("check-required");
    expect(writes).toBe(1);
});

test("a failed recheck clears the previous verification and cannot unlock a save", async () => {
    let reads = 0, writes = 0;
    const { editor } = fixture({ read: async () => { if (++reads === 3) throw Error("读取未完成"); return catalog(reads); }, save: async () => { writes++; return catalog(4); } });
    await editor.read(); editor.edit([item("仍然保留")]); await editor.read(); expect(editor.getState().verification).not.toBeNull();
    await editor.read(); editor.keepDraft(); await editor.save();
    expect(editor.getState().verification).toBeNull();
    expect(editor.getState().phase).toBe("check-required");
    expect(editor.getState().items[0].prompt).toBe("仍然保留");
    expect(writes).toBe(0);
});

test("account, epoch, or role invalidation suppresses late reads and prevents subsequent writes", async () => {
    for (const next of [null, { accountId: "admin-b", epoch: 3, role: "admin" as const }, { accountId: "admin-a", epoch: 4, role: "admin" as const }]) {
        const pending = deferred<InspirationCatalog>(); let writes = 0;
        const { editor, states, replaceScope } = fixture({ read: () => pending.promise, save: async () => { writes++; return catalog(2); } });
        const reading = editor.read(), published = states.length;
        replaceScope(next); pending.resolve(catalog(1)); await reading;
        expect(states).toHaveLength(published);
        editor.edit([item("禁止的编辑")]); await editor.save();
        expect(writes).toBe(0);
        expect(editor.getState().baseline).toBeNull();
    }
});

test("closing or changing account during a write prevents the receipt from changing the displayed draft", async () => {
    for (const close of [true, false]) {
        const pending = deferred<InspirationCatalog>();
        const { editor, states, replaceScope } = fixture({ read: async () => catalog(1), save: () => pending.promise });
        await editor.read(); editor.edit([item("旧账号编辑")]);
        const saving = editor.save(), published = states.length;
        if (close) editor.close(); else replaceScope(null);
        pending.resolve(catalog(2, "迟到回执")); await saving;
        expect(states).toHaveLength(published);
        expect(editor.getState().items[0].prompt).toBe("旧账号编辑");
        expect(editor.getState().baseline?.revision).toBe(1);
    }
});

test("known input rejection allows correction, and busy operations ignore double submits and edits", async () => {
    let writes = 0; const pending = deferred<InspirationCatalog>();
    const { editor } = fixture({ read: async () => catalog(1), save: async () => { if (++writes === 1) throw Object.assign(new Error("字段无效"), { outcome: "not-sent", status: 0 }); return pending.promise; } });
    await editor.read(); editor.edit([item("待修正")]); await editor.save();
    expect(editor.getState().phase).toBe("ready"); editor.edit([item("已修正")]);
    const saving = editor.save(); await editor.save(); editor.edit([item("在途编辑")]);
    expect(writes).toBe(2); expect(editor.getState().items[0].prompt).toBe("已修正");
    pending.resolve(catalog(2, "已修正")); await saving;
    expect(editor.getState().items[0].prompt).toBe("已修正");
    expect(editor.getState().dirty).toBe(false);
});
