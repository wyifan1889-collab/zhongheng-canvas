import { expect, test } from "bun:test";
import { createCreationShortcutRegistry } from "./creation-shortcut-target";

type Kind = "image" | "video" | "audio";
function fixture(kind: Kind = "image") {
    const scope = { accountId: "shortcut-owner", epoch: 3 }, references = [{ id: "kept-reference" }], parameters = { model: "kept-model" };
    let account: typeof scope | null = { ...scope };
    const drafts = Object.fromEntries((["image", "video", "audio"] as const).map(value => [value, { prompt: "原输入", revision: 7 }])) as Record<Kind, { prompt: string; revision: number }>;
    const state = { scope: { ...scope }, ready: true, error: "", pending: null as unknown, drafts };
    const local = { scope: { ...scope }, locationKey: "original-route", ready: true, watch: ["原输入", references, parameters] as unknown[] };
    const applied: string[] = [];
    const registry = createCreationShortcutRegistry({ getScope: () => account, getDraftState: () => state });
    const target = { read: () => local, apply: (prompt: string) => { applied.push(prompt); } };
    const unregister = registry.register(kind, target);
    return { kind, registry, local, state, applied, references, parameters, unregister, target,
        account: (next: typeof scope | null) => { account = next; },
        write: (prompt = "卡片提示词", revision = 8) => { drafts[kind] = { prompt, revision }; } };
}
function ticket(f: ReturnType<typeof fixture>) {
    const result = f.registry.capture(f.kind);
    if (result.status !== "captured") throw new Error(`Expected ready target, got ${result.status}`);
    return result;
}

test.each(["image", "video", "audio"] as const)("%s applies exactly its persisted shortcut once without replacing other editor state", kind => {
    const f = fixture(kind), captured = ticket(f);
    expect(f.applied).toEqual([]);
    f.write();
    expect(captured.apply("卡片提示词")).toBe(true);
    expect(captured.apply("卡片提示词")).toBe(false);
    expect(f.applied).toEqual(["卡片提示词"]);
    expect(f.local.watch[1]).toBe(f.references);
    expect(f.local.watch[2]).toBe(f.parameters);
});

test("an absent cross-mode editor keeps navigation available, while a registered unready editor blocks capture", () => {
    const f = fixture();
    expect(f.registry.capture("video").status).toBe("absent");
    f.local.ready = false;
    expect(f.registry.capture("image").status).toBe("blocked");
    f.local.ready = true; f.state.pending = { nonce: "sending" };
    expect(f.registry.capture("image").status).toBe("blocked");
    f.state.pending = null; f.state.error = "保存未完成";
    expect(f.registry.capture("image").status).toBe("blocked");
    expect(f.applied).toEqual([]);
});

test.each(["prompt", "references", "parameters"])("a %s edit during persistence cannot be overwritten", field => {
    const f = fixture(), captured = ticket(f);
    f.local.watch[field === "prompt" ? 0 : field === "references" ? 1 : 2] = field === "prompt" ? "用户新输入" : {};
    f.write();
    expect(captured.apply("卡片提示词")).toBe(false);
    expect(f.applied).toEqual([]);
});

test.each(["epoch", "account", "signout", "route", "unready", "storeScope", "error", "pending", "revision", "prompt"])("a late shortcut rejects the %s boundary", boundary => {
    const f = fixture(), captured = ticket(f); f.write();
    if (boundary === "epoch") f.account({ ...f.local.scope, epoch: 4 });
    if (boundary === "account") f.account({ accountId: "different-owner", epoch: 3 });
    if (boundary === "signout") f.account(null);
    if (boundary === "route") f.local.locationKey = "different-route";
    if (boundary === "unready") f.local.ready = false;
    if (boundary === "storeScope") f.state.scope = { accountId: "different-owner", epoch: 3 };
    if (boundary === "error") f.state.error = "本机保存失败";
    if (boundary === "pending") f.state.pending = { nonce: "new-send" };
    if (boundary === "revision") f.write("卡片提示词", 9);
    if (boundary === "prompt") f.write("另一次填入", 8);
    expect(captured.apply("卡片提示词")).toBe(false);
    expect(f.applied).toEqual([]);
});

test("unmounting or replacing a registration invalidates its old ticket and cleanup cannot remove its replacement", () => {
    const f = fixture(), old = ticket(f); f.unregister(); f.write();
    expect(old.apply("卡片提示词")).toBe(false);
    const previousCleanup = f.registry.register(f.kind, f.target), replaced = ticket(f);
    const replacement = { ...f.target };
    f.registry.register(f.kind, replacement); previousCleanup();
    expect(replaced.apply("卡片提示词")).toBe(false);
    expect(f.registry.capture(f.kind).status).toBe("captured");
    expect(f.applied).toEqual([]);
});

test("out-of-order shortcut writes accept only the ticket for the exact final revision", () => {
    const f = fixture(), first = ticket(f); f.write("第一张卡");
    const second = ticket(f); f.write("第二张卡", 9);
    expect(first.apply("第一张卡")).toBe(false);
    expect(second.apply("第二张卡")).toBe(true);
    expect(f.applied).toEqual(["第二张卡"]);
});
