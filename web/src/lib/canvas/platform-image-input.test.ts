import { expect, test } from "bun:test";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildPlatformImageInput, platformImageInputSignature, type PlatformImageInput } from "./platform-image-input";

const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 340, height: 240, metadata });
const edge = (fromNodeId: string, toNodeId = "source", id = `${fromNodeId}-${toNodeId}`): CanvasConnection => ({ id, fromNodeId, toNodeId });
function fixture(type = CanvasNodeType.Image, metadata: CanvasNodeData["metadata"] = {}, refs: CanvasNodeData[] = [], connections = refs.filter(item => !item.metadata?.groupId).map(item => edge(item.id))): PlatformImageInput {
    return { sourceNodeId: "source", nodes: [node("source", type, { prompt: "纸艺灯塔", count: 1, ...metadata }), ...refs], connections,
        config: { ...structuredClone(defaultConfig), imageModel: "personal-image-model", apiKey: "", systemPrompt: "" } };
}
const blocked = (input: PlatformImageInput) => { const result = buildPlatformImageInput(input); expect(result.status).toBe("unsupported"); return result.status === "unsupported" ? result.reason : ""; };

test("I3b image input is one immutable text-to-image description without a personal key", () => {
    const input = fixture(), before = JSON.stringify(input), result = buildPlatformImageInput(input);
    expect(result).toEqual({ status: "ready", prompt: "纸艺灯塔", sourceType: "image", localSettings: { count: 1, model: "personal-image-model", size: "1:1", quality: "auto", background: "", systemPrompt: "" } });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.localSettings)).toBe(true); expect(JSON.stringify(input)).toBe(before);
    const existing = fixture(CanvasNodeType.Image, { content: "existing-image-url", images: [{ id: "existing", content: "existing-image-url", status: "success", naturalWidth: 1, naturalHeight: 1, bytes: 12, mimeType: "image/png" }] });
    expect(buildPlatformImageInput(existing)).toMatchObject({ status: "ready", prompt: "纸艺灯塔", sourceType: "image" });
    expect(buildPlatformImageInput({ ...input, draftPrompt: "可见编辑器尚未落入 metadata 的描述" })).toMatchObject({ status: "ready", prompt: "可见编辑器尚未落入 metadata 的描述" });
});

test("I3b preserves raw whitespace from Image and Config context while trimming only the empty check", () => {
    const rawPrompt = "  \n纸艺灯塔\t\n  ";
    expect(buildPlatformImageInput(fixture(CanvasNodeType.Image, { prompt: rawPrompt }))).toMatchObject({ status: "ready", prompt: rawPrompt });
    expect(buildPlatformImageInput({ ...fixture(), draftPrompt: rawPrompt })).toMatchObject({ status: "ready", prompt: rawPrompt });
    expect(buildPlatformImageInput(fixture(CanvasNodeType.Config, { composerContent: rawPrompt }))).toMatchObject({ status: "ready", prompt: rawPrompt });
    const upstream = fixture(CanvasNodeType.Config, { composerContent: "", prompt: "不得回退" }, [node("a", CanvasNodeType.Text, { content: "  原文本\n  " })]);
    const context = buildNodeGenerationContext("source", upstream.nodes, upstream.connections, "").prompt;
    expect(context.startsWith("\n\n")).toBe(true);
    expect(buildPlatformImageInput(upstream)).toMatchObject({ status: "ready", prompt: context });
    expect(buildPlatformImageInput({ ...fixture(), draftPrompt: " \n\t " }).status).toBe("unsupported");
});

test("I3b Config keeps original token/group order, repeated resource deduplication and unselected C", () => {
    const input = fixture(CanvasNodeType.Config, { generationMode: "image", composerContent: "依据 @[node:g] 和 @[node:a] 再 @[node:g]", prompt: "旧要求不应加入" }, [
        node("a", CanvasNodeType.Text, { content: "甲当前正文", prompt: "甲旧prompt" }), node("g", CanvasNodeType.Group),
        node("b", CanvasNodeType.Text, { groupId: "g", content: "乙当前正文" }), node("c", CanvasNodeType.Text, { content: "未选丙正文" }),
    ]);
    const result = buildPlatformImageInput(input);
    expect(result.status).toBe("ready"); if (result.status !== "ready") return;
    expect(result.sourceType).toBe("config"); expect(result.prompt).toBe(buildNodeGenerationContext("source", input.nodes, input.connections, input.nodes[0].metadata!.composerContent!).prompt.trim());
    expect(result.prompt.indexOf("乙当前正文")).toBeLessThan(result.prompt.indexOf("甲当前正文")); expect(result.prompt.match(/乙当前正文/g)).toHaveLength(1);
    expect(result.prompt).not.toContain("未选丙正文"); expect(result.prompt).not.toContain("甲旧prompt"); expect(result.prompt).not.toContain("旧要求不应加入");
});

test("I3b Config preserves nullish composer selection, all-upstream fallback and text prompt fallback", () => {
    const input = fixture(CanvasNodeType.Config, { generationMode: "image", composerContent: "", prompt: "旧要求不能回退" }, [node("a", CanvasNodeType.Text, { content: "", prompt: "甲的可用prompt" })]);
    const result = buildPlatformImageInput(input); expect(result.status).toBe("ready");
    if (result.status === "ready") { expect(result.prompt).toContain("甲的可用prompt"); expect(result.prompt).not.toContain("旧要求不能回退"); }
    const composerOnly = fixture(CanvasNodeType.Config, { composerContent: "仅本句", generationMode: "image" }, [node("a", CanvasNodeType.Text, { content: "不自动加入" })]);
    expect(buildPlatformImageInput(composerOnly)).toMatchObject({ status: "ready", prompt: "仅本句" });
    const plain = fixture(CanvasNodeType.Config, { generationMode: "image" }, [node("a", CanvasNodeType.Text, { content: "原文" })]);
    const outgoing = node("next", CanvasNodeType.Config), shared = node("shared", CanvasNodeType.Text, { content: "共享原文" });
    plain.nodes.push(outgoing, shared); plain.connections.push(edge("source", "next"), edge("shared", "next"));
    expect(buildPlatformImageInput(plain)).toMatchObject({ status: "ready", prompt: buildNodeGenerationContext("source", plain.nodes, plain.connections, "纸艺灯塔").prompt.trim() });
    plain.connections = plain.connections.filter(item => item.fromNodeId !== "shared");
    expect(buildPlatformImageInput(plain)).toMatchObject({ status: "ready", prompt: buildNodeGenerationContext("source", plain.nodes, plain.connections, "纸艺灯塔").prompt.trim() });
    plain.connections.push(edge("missing", "next")); expect(blocked(plain)).toContain("缺失");
});

test("I3b actual count keeps inherited default3 and never clamps invalid node or config values", () => {
    const input = fixture(); delete input.nodes[0].metadata!.count;
    expect(input.config.canvasImageCount).toBe("3"); expect(buildPlatformImageInput(input).status).toBe("ready");
    expect(buildPlatformImageInput(input).localSettings.count).toBe("3");
    input.config.canvasImageCount = "1"; expect(buildPlatformImageInput(input)).toMatchObject({ status: "ready", localSettings: { count: "1" } });
    for (const count of [0, 11, -1, 1.1, NaN, Infinity]) { const value = fixture(CanvasNodeType.Image, { count }); expect(blocked(value)).toContain("数量"); expect(buildPlatformImageInput(value).localSettings.count).toBe(count); }
    for (const count of ["", "0", "11", "-1", "1.0", "01", " 1 ", 0, NaN]) { input.config.canvasImageCount = count as string; expect(blocked(input)).toContain("数量"); }
    for (const count of [2, 4, 10]) expect(buildPlatformImageInput(fixture(CanvasNodeType.Image, { count }))).toMatchObject({ status: "ready", localSettings: { count } });
    delete (input.config as Partial<typeof input.config>).canvasImageCount; input.config.count = "1";
    expect(buildPlatformImageInput(input)).toMatchObject({ status: "ready", localSettings: { count: "1" } });
    delete (input.config as Partial<typeof input.config>).count;
    expect(buildPlatformImageInput(input)).toMatchObject({ status: "ready", localSettings: { count: "1" } });
});

test("I3b nondefault personal settings are disclosed and blocked instead of mapped to a platform spec", () => {
    for (const [field, value] of [["size", "1024x1024"], ["quality", "high"], ["background", "transparent"], ["systemPrompt", "个人系统要求"]] as const) {
        const input = fixture(); input.config[field] = value; const result = buildPlatformImageInput(input);
        expect(result.status).toBe("unsupported"); expect(result.localSettings[field]).toBe(value);
        if (result.status === "unsupported") expect(result.reason).toContain("个人");
    }
    for (const metadata of [{ size: "1024x1024" }, { quality: "high" }, { background: "opaque" }]) expect(blocked(fixture(CanvasNodeType.Image, metadata))).toContain("个人");
    const override = fixture(CanvasNodeType.Image, { size: "1:1", quality: "auto", background: "" }); override.config.size = "1024x1024"; override.config.quality = "high"; override.config.background = "opaque";
    expect(buildPlatformImageInput(override)).toMatchObject({ status: "ready", localSettings: { size: "1:1", quality: "auto", background: "" } });
});

test("I3b explicit edits, mask and recorded media references cannot become text-to-image", () => {
    for (const metadata of [{ generationType: "edit" }, { references: ["stored-media-reference"] }, { maskDataUrl: "data:image/png;base64,mask" }]) {
        const input = fixture(CanvasNodeType.Image, metadata as CanvasNodeData["metadata"]); expect(buildPlatformImageInput(input).status).toBe("unsupported");
    }
    for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config, "fixture:plugin"]) {
        const input = fixture(CanvasNodeType.Config, { generationMode: "image", composerContent: "仅文字要求" }, [node("ref", type, { prompt: "伪文本", content: "" })]);
        expect(blocked(input)).toContain("媒体");
        const grouped = fixture(CanvasNodeType.Config, { composerContent: "@[node:g]" }, [node("g", CanvasNodeType.Group), node("ref", type, { groupId: "g", content: "资源" })]);
        expect(blocked(grouped)).toContain("媒体");
    }
});

test("I3b raw missing/empty/ambiguous resources and malformed/out-of-scope tokens block before filtering", () => {
    expect(blocked(fixture(CanvasNodeType.Config, {}, [], [edge("missing")]))).toContain("缺失");
    expect(blocked(fixture(CanvasNodeType.Config, {}, [node("a", CanvasNodeType.Text, { content: "  ", prompt: "被原逻辑忽略" })]))).toContain("为空");
    expect(blocked(fixture(CanvasNodeType.Config, { composerContent: "@[node:g]" }, [node("g", CanvasNodeType.Group)]))).toContain("为空");
    for (const composerContent of ["@[node:missing]", "@[node:", "@[node:]", "@[node: a]", "@[node:a[node:b]"]) expect(buildPlatformImageInput(fixture(CanvasNodeType.Config, { composerContent }, [node("a", CanvasNodeType.Text, { content: "甲" })])).status).toBe("unsupported");
    expect(blocked(fixture(CanvasNodeType.Config, { composerContent: "@[node:child]" }, [node("g", CanvasNodeType.Group), node("child", CanvasNodeType.Text, { groupId: "g", content: "子文本" })]))).toContain("引用标记");
    expect(blocked(fixture(CanvasNodeType.Image, { prompt: "@[node:a]" }, [node("a", CanvasNodeType.Text, { content: "甲" })]))).toContain("不会解析");
    const duplicate = fixture(); duplicate.nodes.push(structuredClone(duplicate.nodes[0])); expect(blocked(duplicate)).toContain("编号重复");
    const connection = fixture(CanvasNodeType.Config, {}, [node("a", CanvasNodeType.Text, { content: "甲" })]); connection.connections.push({ ...connection.connections[0] }); expect(blocked(connection)).toContain("连线编号重复");
    const configs = fixture(); configs.nodes.push(node("first", CanvasNodeType.Config), node("second", CanvasNodeType.Config)); configs.connections.push(edge("source", "first"), edge("source", "second")); expect(blocked(configs)).toContain("歧义");
});

test("I3b signatures track group child duplicates, refs, source content and effective settings without geometry noise", () => {
    const input = fixture(CanvasNodeType.Config, { composerContent: "@[node:g]" }, [node("g", CanvasNodeType.Group), node("child", CanvasNodeType.Text, { groupId: "g", content: "原文" })]);
    const original = platformImageInputSignature(input); expect(buildPlatformImageInput(input).status).toBe("ready");
    input.nodes.push(node("unrelated", CanvasNodeType.Text, { content: "无关" })); input.nodes[0].position.x = 90; input.nodes[0].metadata!.status = "loading";
    expect(platformImageInputSignature(input)).toBe(original);
    input.nodes.push(node("child", CanvasNodeType.Text, { content: "组外同ID" })); expect(platformImageInputSignature(input)).not.toBe(original); expect(blocked(input)).toContain("编号重复");
    input.nodes.pop(); input.nodes[2].metadata!.content = "改后正文"; expect(platformImageInputSignature(input)).not.toBe(original);
    const plain = fixture(), plainSignature = platformImageInputSignature(plain); plain.nodes[0].metadata!.content = "换图"; expect(platformImageInputSignature(plain)).not.toBe(plainSignature);
    for (const patch of [{ storageKey: "new-storage" }, { cloudMediaId: "new-cloud" }, { primaryImageId: "new-primary" }, { images: [] }]) {
        const body = fixture(), before = platformImageInputSignature(body); Object.assign(body.nodes[0].metadata!, patch); expect(platformImageInputSignature(body)).not.toBe(before);
    }
    const fields = ["size", "quality", "background", "systemPrompt", "canvasImageCount"] as const;
    for (const field of fields) { const value = fixture(); delete value.nodes[0].metadata!.count; const before = platformImageInputSignature(value); value.config[field] = "changed"; expect(platformImageInputSignature(value)).not.toBe(before); }
    const ref = fixture(CanvasNodeType.Config, {}, [node("a", CanvasNodeType.Text, { content: "甲" })]); const before = platformImageInputSignature(ref); ref.nodes[1].metadata!.references = ["media"]; expect(platformImageInputSignature(ref)).not.toBe(before); expect(blocked(ref)).toContain("媒体引用");
});

test("I3b invalid source modes and final empty descriptions never become ready", () => {
    const missing = fixture(); missing.nodes = []; expect(blocked(missing)).toContain("不存在");
    const text = fixture(CanvasNodeType.Text); expect(blocked(text)).toContain("模式");
    expect(blocked(fixture(CanvasNodeType.Config, { generationMode: "text" }))).toContain("模式");
    expect(blocked(fixture(CanvasNodeType.Image, { prompt: "   " }))).toContain("描述为空");
});

test("node platform selection is preserved separately and changes invalidate the frozen input", () => {
    const input = fixture(CanvasNodeType.Image, { platformImageSelection: { modelId: "image-2.5", specification: "1K", combination: "complete-choice" } });
    const before = platformImageInputSignature(input), result = buildPlatformImageInput(input);
    expect(result).toMatchObject({ status: "ready", localSettings: { model: "personal-image-model", size: "1:1", quality: "auto",
        platformSelection: { modelId: "image-2.5", specification: "1K", combination: "complete-choice" } } });
    expect(Object.isFrozen(result.localSettings.platformSelection)).toBe(true);
    input.nodes[0].metadata!.platformImageSelection!.combination = "different-choice";
    expect(platformImageInputSignature(input)).not.toBe(before);
    expect(result.localSettings.platformSelection!.combination).toBe("complete-choice");
});

test("explicit node platform specs do not inherit personal dimensions or discard unsupported advanced input", () => {
    const input = fixture(CanvasNodeType.Image, { size: "1536x1024", quality: "high",
        platformImageSelection: { modelId: "image-2.5", specification: "1K", combination: "complete-choice" } });
    const original = JSON.stringify(input);
    expect(buildPlatformImageInput(input)).toMatchObject({ status: "ready", localSettings: { size: "1536x1024", quality: "high" } });
    expect(JSON.stringify(input)).toBe(original);
    input.nodes[0].metadata!.background = "transparent";
    expect(blocked(input)).toContain("背景");
    input.nodes[0].metadata!.background = ""; input.config.systemPrompt = "保留的个人要求";
    expect(blocked(input)).toContain("系统提示词");
    input.config.systemPrompt = ""; input.nodes[0].metadata!.platformImageSelection = { modelId: "image-2.5" };
    expect(blocked(input)).toContain("个人尺寸");
});
