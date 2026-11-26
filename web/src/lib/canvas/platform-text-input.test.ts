import { expect, test } from "bun:test";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildPlatformTextPreview, platformTextInputSignature, type PlatformTextPreviewInput } from "./platform-text-input";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 300, height: 200, metadata });
const edge = (fromNodeId: string, toNodeId = "config", id = `${fromNodeId}-${toNodeId}`): CanvasConnection => ({ id, fromNodeId, toNodeId });
function fixture(metadata: CanvasNodeData["metadata"] = {}, refs: CanvasNodeData[] = [], connections = refs.filter(item => !item.metadata?.groupId).map(item => edge(item.id))): PlatformTextPreviewInput {
    const source = node("config", CanvasNodeType.Config, { generationMode: "text", ...metadata });
    return { sourceNodeId: source.id, draftPrompt: source.metadata?.composerContent ?? source.metadata?.prompt ?? "", nodes: [source, ...refs], connections,
        settings: { model: "personal-model", reasoningEffort: "auto", systemPrompt: "" } };
}
const reasons = (input: PlatformTextPreviewInput) => {
    const result = buildPlatformTextPreview(input);
    expect(result.status).toBe("blocked");
    return result.status === "blocked" ? result.blockers.map(item => item.reason) : [];
};

test("all-upstream preview preserves original connection/group ordering and prompt fallback", () => {
    const input = fixture({ prompt: "整合材料" }, [node("a", CanvasNodeType.Text, { content: "", prompt: "甲提示" }),
        node("g", CanvasNodeType.Group), node("b", CanvasNodeType.Text, { groupId: "g", content: "乙正文", prompt: "不使用" })]);
    const result = buildPlatformTextPreview(input);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.prompt).toBe(buildNodeGenerationContext("config", input.nodes, input.connections, input.draftPrompt).prompt.trim());
    expect(result.prompt).toContain("甲提示"); expect(result.prompt).toContain("乙正文"); expect(result.prompt).not.toContain("不使用");
    expect(result.references.map(item => [item.nodeId, item.textField, item.included])).toEqual([["a", "prompt", true], ["b", "content", true]]);
    expect(result.references[1].groupId).toBe("g"); expect(result.promptField).toBe("prompt"); expect(result.contextMode).toBe("all-upstream");
});

test("composer selects group tokens in original order and deduplicates repeated resources", () => {
    const input = fixture({ composerContent: "引用 @[node:g] 再引用 @[node:a]" }, [node("a", CanvasNodeType.Text, { content: "甲" }),
        node("g", CanvasNodeType.Group), node("b", CanvasNodeType.Text, { groupId: "g", content: "乙" }),
        node("c", CanvasNodeType.Text, { content: "未使用" })]);
    const result = buildPlatformTextPreview(input);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.prompt).toBe(buildNodeGenerationContext("config", input.nodes, input.connections, input.draftPrompt).prompt.trim());
    expect(result.prompt.indexOf("乙")).toBeLessThan(result.prompt.indexOf("甲")); expect(result.prompt).not.toContain("未使用");
    expect(result.references.map(item => [item.nodeId, item.included])).toEqual([["b", true], ["a", true], ["c", false]]);
    const repeated = fixture({ composerContent: "@[node:g] @[node:b] @[node:g]" }, [node("g", CanvasNodeType.Group), node("b", CanvasNodeType.Text, { content: "组材料", groupId: "g" })], [edge("g"), edge("b")]);
    const repeatedResult = buildPlatformTextPreview(repeated);
    expect(repeatedResult.status).toBe("ready");
    if (repeatedResult.status === "ready") expect(repeatedResult.prompt.match(/组材料/g)).toHaveLength(1);
});

test("composer without tokens does not silently append complete connected resources", () => {
    const result = buildPlatformTextPreview(fixture({ composerContent: "仅本句" }, [node("a", CanvasNodeType.Text, { content: "不应自动注入" })]));
    expect(result).toMatchObject({ status: "ready", prompt: "仅本句", promptField: "composerContent", contextMode: "composer-tokens", references: [{ nodeId: "a", included: false }] });
});

test("empty composer uses nullish source selection but the original all-upstream branch", () => {
    const result = buildPlatformTextPreview(fixture({ composerContent: "", prompt: "不能回退" }, [node("a", CanvasNodeType.Text, { content: "上游正文" })]));
    expect(result.status).toBe("ready");
    if (result.status === "ready") { expect(result.prompt).toContain("上游正文"); expect(result.prompt).not.toContain("不能回退"); }
    expect(result.promptField).toBe("composerContent"); expect(result.contextMode).toBe("all-upstream");
});

test("raw dangling edges, empty text and empty groups block before resource filtering", () => {
    expect(reasons(fixture({ prompt: "要求" }, [], [edge("deleted")]))).toContain("missing-reference");
    expect(reasons(fixture({ prompt: "要求" }, [node("empty", CanvasNodeType.Text, { content: "", prompt: "" })]))).toContain("empty-reference");
    expect(reasons(fixture({ prompt: "要求" }, [node("space", CanvasNodeType.Text, { content: "  ", prompt: "不会被原逻辑使用" })]))).toContain("empty-reference");
    expect(reasons(fixture({ composerContent: "@[node:g]" }, [node("g", CanvasNodeType.Group)]))).toContain("empty-reference");
});

test("missing and malformed tokens block while preserving raw text and a candidate", () => {
    for (const composerContent of ["要求 @[node:missing]", "要求 @[node:", "要求 @[node:]", "要求 @[node: a]", "@[node:a[node:b]"]) {
        const input = fixture({ composerContent }, [node("a", CanvasNodeType.Text, { content: "甲" })]);
        const result = buildPlatformTextPreview(input);
        expect(result.status).toBe("blocked"); expect(result.rawPrompt).toBe(composerContent);
        if (result.status === "blocked") { expect(result.candidatePrompt).toBeString(); expect(result.blockers.length).toBeGreaterThan(0); }
    }
    expect(reasons(fixture({ prompt: "@[node:a]" }, [node("a", CanvasNodeType.Text, { content: "甲" })]))).toContain("invalid-token");
});

test("group-child tokens cannot bypass the original top-level token scope", () => {
    const input = fixture({ composerContent: "@[node:child]" }, [node("g", CanvasNodeType.Group), node("child", CanvasNodeType.Text, { content: "子材料", groupId: "g" })]);
    expect(reasons(input)).toContain("missing-reference");
});

test("media, plugins and unsupported group members block even when unselected or empty", () => {
    for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, "plugin:custom", CanvasNodeType.Config]) {
        expect(reasons(fixture({ composerContent: "不选择引用" }, [node("ref", type, { prompt: "伪文本", content: "" })]))).toContain("unsupported-reference");
        expect(reasons(fixture({ composerContent: "@[node:g]" }, [node("g", CanvasNodeType.Group), node("ref", type, { groupId: "g", content: "资源" })]))).toContain("unsupported-reference");
    }
    expect(reasons(fixture({ prompt: "要求", references: ["prior-media-url"] }))).toContain("unsupported-reference");
});

test("source, batch, reasoning, system and final-empty requests cannot become ready", () => {
    const invalid = fixture({ prompt: "要求" }); invalid.nodes[0].type = CanvasNodeType.Text;
    expect(reasons(invalid)).toContain("invalid-source");
    expect(reasons({ ...fixture({ prompt: "要求" }), nodes: [] })).toContain("invalid-source");
    for (const textCount of [0, 2, -1, NaN, 1.5]) expect(reasons(fixture({ prompt: "要求", textCount }))).toContain("unsupported-setting");
    const reasoning = fixture({ prompt: "要求" }); reasoning.settings.reasoningEffort = "high";
    expect(reasons(reasoning)).toContain("unsupported-setting");
    const system = fixture({ prompt: "要求" }); system.settings.systemPrompt = "系统要求";
    expect(reasons(system)).toContain("unsupported-setting");
    expect(reasons(fixture())).toContain("empty-prompt");
    const result = buildPlatformTextPreview(system); if (result.status === "blocked") expect(result.candidatePrompt).not.toContain("系统要求");
});

test("duplicate source and reference ids cannot silently choose one record", () => {
    const source = fixture({ prompt: "要求" }); source.nodes.push({ ...source.nodes[0] });
    expect(reasons(source)).toContain("invalid-source");
    expect(reasons(fixture({ prompt: "要求" }, [node("a", CanvasNodeType.Text, { content: "甲" }), node("a", CanvasNodeType.Text, { content: "乙" })], [edge("a")]))).toContain("missing-reference");
});

test("signature invalidates when a group child gains an out-of-group duplicate id", () => {
    const input = fixture({ composerContent: "@[node:g]" }, [node("g", CanvasNodeType.Group),
        node("a", CanvasNodeType.Text, { groupId: "g", content: "组内正文" })], [edge("g")]);
    const before = platformTextInputSignature(input);
    expect(buildPlatformTextPreview(input).status).toBe("ready");
    input.nodes.push(node("a", CanvasNodeType.Text, { content: "组外同编号正文" }));
    const reparsed = buildPlatformTextPreview(input);
    expect(reparsed.status).toBe("blocked");
    if (reparsed.status === "blocked") expect(reparsed.blockers.some(blocker =>
        blocker.reason === "missing-reference" && blocker.nodeIds.includes("a"))).toBe(true);
    expect(platformTextInputSignature(input)).not.toBe(before);
});

test("existing outgoing-Config precedence is retained rather than combining unrelated inputs", () => {
    const input = fixture({ prompt: "要求" }, [node("own", CanvasNodeType.Text, { content: "不选自己输入" }), node("next", CanvasNodeType.Config), node("shared", CanvasNodeType.Text, { content: "共享输入" })], [edge("own"), edge("config", "next"), edge("shared", "next")]);
    const result = buildPlatformTextPreview(input);
    expect(result.status).toBe("ready");
    if (result.status === "ready") { expect(result.prompt).toContain("共享输入"); expect(result.prompt).not.toContain("不选自己输入"); }
    expect(result.references.map(item => item.nodeId)).toEqual(["shared"]);
});

test("an outgoing Config without readable inputs falls back to own inputs and retains invalid raw diagnostics", () => {
    const input = fixture({ prompt: "要求" }, [node("own", CanvasNodeType.Text, { content: "自身上游" }), node("next", CanvasNodeType.Config)], [edge("own"), edge("config", "next")]);
    const result = buildPlatformTextPreview(input);
    expect(result.status).toBe("ready"); expect(result.references.map(item => item.nodeId)).toEqual(["own"]);
    if (result.status === "ready") expect(result.prompt).toBe(buildNodeGenerationContext("config", input.nodes, input.connections, input.draftPrompt).prompt.trim());
    const before = platformTextInputSignature(input);
    input.connections.push(edge("missing", "next"));
    expect(reasons(input)).toContain("missing-reference"); expect(platformTextInputSignature(input)).not.toBe(before);
    const empty = fixture({ prompt: "要求" }, [node("own", CanvasNodeType.Image, { content: "" }), node("next", CanvasNodeType.Config)], [edge("own"), edge("config", "next")]);
    expect(reasons(empty)).toContain("unsupported-reference");
});

test("signature tracks relevant source, raw graph, groups and settings while ignoring geometry", () => {
    const input = fixture({ composerContent: "@[node:g]" }, [node("g", CanvasNodeType.Group), node("a", CanvasNodeType.Text, { content: "甲", groupId: "g" }), node("unrelated", CanvasNodeType.Text, { content: "无关" })], [edge("g")]);
    const signature = platformTextInputSignature(input), changed = structuredClone(input);
    changed.nodes[0].position.x = 99; changed.nodes[1].width = 77; changed.nodes[2].metadata!.status = "loading";
    changed.nodes[3].metadata!.content = "无关修改"; changed.connections.push(edge("unrelated", "elsewhere"));
    expect(platformTextInputSignature(changed)).toBe(signature);
    for (const mutate of [
        (value: PlatformTextPreviewInput) => { value.nodes[2].metadata!.content = "新正文"; },
        (value: PlatformTextPreviewInput) => { value.nodes[2].metadata!.groupId = "other"; },
        (value: PlatformTextPreviewInput) => { value.draftPrompt = "新要求"; },
        (value: PlatformTextPreviewInput) => { value.settings.systemPrompt = "新系统要求"; },
        (value: PlatformTextPreviewInput) => { value.connections[0].fromNodeId = "missing"; },
        (value: PlatformTextPreviewInput) => { value.nodes[0].metadata!.generationMode = "image"; },
    ]) { const value = structuredClone(input); mutate(value); expect(platformTextInputSignature(value)).not.toBe(signature); }
});

test("preview is synchronous and leaves source nodes, connections and settings untouched", () => {
    const input = fixture({ composerContent: "@[node:a]" }, [node("a", CanvasNodeType.Text, { content: "保留文本" })]), before = structuredClone(input);
    const freeze = (value: unknown): void => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(input);
    const result = buildPlatformTextPreview(input);
    expect(result.status).toBe("ready"); expect(result).not.toBeInstanceOf(Promise); expect(input).toEqual(before);
});
