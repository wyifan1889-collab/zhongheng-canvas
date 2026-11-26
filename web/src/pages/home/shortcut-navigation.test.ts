import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile("home/index.tsx", readFileSync(new URL("./index.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function fixture(mounted?: "ready" | "blocked" | "changed") {
    let resolve!: (value: boolean) => void, navigations = 0, warnings = 0, writes = 0, applied = 0;
    let account: { accountId: string; epoch: number } | null = { accountId: "shortcut-owner", epoch: 1 };
    const waiting = new Promise<boolean>(done => { resolve = done; });
    const locationRef = { current: { pathname: "/create", search: "?mode=agent" } }, live = { current: true };
    let initializer: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === "applyShortcut") initializer = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!initializer) throw new Error("Missing homepage shortcut callback");
    const environment = { useAccountStore: { getState: () => ({ getDraftScope: () => account }) },
        shortcutTargets: { capture: () => !mounted ? { status: "absent" } : mounted === "blocked" ? { status: "blocked" } : { status: "captured", apply: () => { applied++; return mounted === "ready"; } } },
        locationRef, live, applyCreationAgentInspiration: () => { writes++; return waiting; }, applyCreationMediaInspiration: () => { writes++; return waiting; },
        changeMode: () => { navigations++; }, message: { info: () => { warnings++; } } };
    const javascript = ts.transpileModule(`return (${initializer.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const apply = new Function(...Object.keys(environment), javascript)(...Object.values(environment)) as (item: { kind: string; prompt: string }) => Promise<void>;
    return { apply, locationRef, live, resolve, setAccount: (value: typeof account) => { account = value; }, operations: () => ({ writes, applied }), counts: () => ({ navigations, warnings }) };
}

test("a shortcut changes mode only after its draft write succeeds", async () => {
    const f = fixture(), applying = f.apply({ kind: "image", prompt: "保留的灵感" });
    expect(f.counts().navigations).toBe(0);
    f.resolve(true); await applying;
    expect(f.counts()).toEqual({ navigations: 1, warnings: 0 });
    const failed = fixture(), rejected = failed.apply({ kind: "video", prompt: "保留的灵感" });
    failed.resolve(false); await rejected;
    expect(failed.counts()).toEqual({ navigations: 0, warnings: 1 });
});

test.each(["image", "video", "audio"])("a mounted %s editor receives its shortcut only after persistence", kind => {
    const f = fixture("ready"), applying = f.apply({ kind, prompt: "同模式灵感" });
    expect(f.operations()).toEqual({ writes: 1, applied: 0 });
    f.resolve(true);
    return applying.then(() => {
        expect(f.operations()).toEqual({ writes: 1, applied: 1 });
        expect(f.counts()).toEqual({ navigations: 1, warnings: 0 });
    });
});

test("a registered unready editor warns before touching its draft store", async () => {
    const f = fixture("blocked"); await f.apply({ kind: "image", prompt: "尚不可填入" });
    expect(f.operations()).toEqual({ writes: 0, applied: 0 });
    expect(f.counts()).toEqual({ navigations: 0, warnings: 1 });
});

test("a local edit race or failed persistence cannot apply a mounted shortcut", async () => {
    const changed = fixture("changed"), updating = changed.apply({ kind: "image", prompt: "不覆盖手工输入" });
    changed.resolve(true); await updating;
    expect(changed.counts()).toEqual({ navigations: 0, warnings: 1 });
    const failed = fixture("ready"), saving = failed.apply({ kind: "audio", prompt: "保存失败" });
    failed.resolve(false); await saving;
    expect(failed.operations()).toEqual({ writes: 1, applied: 0 });
    expect(failed.counts()).toEqual({ navigations: 0, warnings: 1 });
});

test("account changes while saving cannot apply or navigate a late shortcut", async () => {
    const f = fixture("ready"), applying = f.apply({ kind: "video", prompt: "原账号草稿" });
    f.setAccount({ accountId: "other-owner", epoch: 2 }); f.resolve(true); await applying;
    expect(f.operations()).toEqual({ writes: 1, applied: 0 });
    expect(f.counts()).toEqual({ navigations: 0, warnings: 0 });
});

test("a late successful shortcut cannot navigate after a mode change or page unmount", async () => {
    for (const boundary of ["mode", "unmount"]) {
        const f = fixture(), applying = f.apply({ kind: "audio", prompt: "仍按原账号保存的灵感" });
        if (boundary === "mode") f.locationRef.current = { pathname: "/create", search: "?mode=video" };
        else f.live.current = false;
        f.resolve(true); await applying;
        expect(f.counts()).toEqual({ navigations: 0, warnings: 0 });
    }
});

type Shortcut = { kind: "agent" | "image" | "video" | "audio"; title: string; prompt: string };
function shortcutCatalog() {
    const names = ["defaults", "modeDefaults", "selectModeShortcuts"];
    const declarations = names.map(name => {
        const statement = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === name));
        if (!statement) throw new Error(`Missing real shortcut catalog declaration: ${name}`);
        return statement.getText(source);
    });
    const javascript = ts.transpileModule(`${declarations.join("\n")}\nreturn { defaults, modeDefaults, selectModeShortcuts };`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function(javascript)() as { defaults: Shortcut[]; modeDefaults: Record<Shortcut["kind"], Shortcut[]>; selectModeShortcuts: (items: Shortcut[], kind: Shortcut["kind"]) => Shortcut[] };
}

test.each(["agent", "image", "video", "audio"] as const)("%s has four distinct same-mode drafts without changing stored shortcuts", kind => {
    const catalog = shortcutCatalog(), stored = structuredClone(catalog.defaults), before = JSON.stringify(stored);
    const cards = catalog.selectModeShortcuts(stored, kind);
    expect(cards).toHaveLength(4);
    expect(cards.every(item => item.kind === kind && item.title.trim() && item.prompt.trim())).toBe(true);
    expect(new Set(cards.map(item => item.prompt)).size).toBe(4);
    expect(JSON.stringify(stored)).toBe(before);
    expect(catalog.selectModeShortcuts([], kind)).toEqual(catalog.modeDefaults[kind]);
});

test("custom shortcuts keep their order and duplicate entries while only matching built-ins are skipped", () => {
    const catalog = shortcutCatalog(), repeated = catalog.modeDefaults.image[0].prompt;
    const stored: Shortcut[] = [
        { kind: "image", title: "我的海报一", prompt: repeated },
        { kind: "audio", title: "我的欢迎语", prompt: "保留其他模式的配置。" },
        { kind: "image", title: "我的海报二", prompt: repeated },
        { kind: "video", title: "我的镜头", prompt: "保留视频草稿。" },
    ];
    const before = JSON.stringify(stored), cards = catalog.selectModeShortcuts(stored, "image");
    expect(cards.slice(0, 2)).toEqual([stored[0], stored[2]]);
    expect(cards).toHaveLength(4);
    expect(cards.slice(2).map(item => item.prompt)).not.toContain(repeated);
    expect(catalog.selectModeShortcuts(stored, "audio")[0]).toEqual(stored[1]);
    expect(JSON.stringify(stored)).toBe(before);
});

test("four saved shortcuts for one mode are not replaced by built-ins", () => {
    const catalog = shortcutCatalog(), stored: Shortcut[] = [1, 2, 3, 4].map(index => ({ kind: "agent", title: `自定义 ${index}`, prompt: `保留任务 ${index}` }));
    expect(catalog.selectModeShortcuts(stored, "agent")).toEqual(stored);
    expect(catalog.selectModeShortcuts(stored, "audio")).toEqual(catalog.modeDefaults.audio);
});
