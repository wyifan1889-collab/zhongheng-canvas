import { expect, test } from "bun:test";
import { appendPlatformTextResult, applyResult } from "./platform-text-result";
import { blockTextTargetsForMount, mergeTextTargetHistory, protectTextNodeChanges, registerTarget, stripTarget } from "./platform-text-target";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("delivered text uses an original Text node and restoring its receipt preserves edited content", () => {
    const initial: CanvasNodeData[] = [];
    const value = { taskId: crypto.randomUUID(), text: "Text from accepted task" };
    const first = appendPlatformTextResult(initial, value, { x: 400, y: 300 });
    expect(initial).toHaveLength(0); expect(first.inserted).toBe(true);
    expect(first.nodes[0]).toMatchObject({ type: CanvasNodeType.Text, id: first.nodeId, title: "平台生成文本", metadata: { content: value.text, status: "success" } });
    const edited = [{ ...first.nodes[0], metadata: { ...first.nodes[0].metadata, content: "Local edits" } }];
    const restored = appendPlatformTextResult(edited, value, { x: 0, y: 0 });
    expect(restored.inserted).toBe(false); expect(restored.nodes).toBe(edited); expect(restored.nodes[0].metadata?.content).toBe("Local edits");
    expect(() => appendPlatformTextResult(initial, { ...value, text: " " }, { x: 0, y: 0 })).toThrow();
});

const target = { schemaVersion: 1 as const, nodeId: "original-text", guardId: "11111111-1111-4111-8111-111111111111" };
const blank = (): CanvasNodeData => ({ id: target.nodeId, type: CanvasNodeType.Text, title: "保留用户标题", position: { x: 40, y: 50 }, width: 210, height: 160, metadata: { content: "", fontSize: 20 } });
const delivered = () => ({ taskId: crypto.randomUUID(), text: "正式任务正文", target });

test("original fill patches content and task marker together without replacing the original node", () => {
    const initial = registerTarget([blank()], target).nodes, result = delivered();
    const applied = applyResult(initial, result, { x: 900, y: 800 }, "original");
    expect(applied.status).toBe("filled"); expect(applied.nodes).toHaveLength(1);
    expect(applied.nodes[0]).toMatchObject({ ...blank(), metadata: { content: result.text, fontSize: 20, status: "success", platformTextRequests: [{ guardId: target.guardId, edited: false, taskId: result.taskId }] } });
    expect(initial[0].metadata?.content).toBe("");
    const edited = [{ ...applied.nodes[0], metadata: { ...applied.nodes[0].metadata, content: "" } }];
    expect(applyResult(edited, result, { x: 0, y: 0 }, "original")).toMatchObject({ status: "already-applied", nodes: edited });
    expect(applyResult(edited, result, { x: 0, y: 0 }, "new").status).toBe("already-applied");
});

test("edited, missing, occupied and mounted targets never fall back to insertion", () => {
    const initial = registerTarget([blank()], target).nodes, value = delivered();
    const changed = protectTextNodeChanges(initial, [{ ...initial[0], metadata: { ...initial[0].metadata, content: "用户编辑" } }]);
    const cleared = protectTextNodeChanges(changed, [{ ...changed[0], metadata: { ...changed[0].metadata, content: "" } }]);
    for (const nodes of [cleared, [], [blank()], initial.map(stripTarget), blockTextTargetsForMount(initial), mergeTextTargetHistory(cleared, initial).nodes,
        [{ ...initial[0], metadata: { ...initial[0].metadata, content: "已有正文" } }]]) {
        const applied = applyResult(nodes, value, { x: 0, y: 0 }, "original");
        expect(applied.status).toBe("protected"); expect(applied.nodes).toBe(nodes);
    }
});

test("undoing unrelated movement still permits original fill, while deleting and restoring the source protects it", () => {
    const initial = registerTarget([blank()], target).nodes, value = delivered();
    const b = { ...blank(), id: "other-text", position: { x: 400, y: 500 } };
    const previous = [...initial, { ...b, position: { x: 600, y: 700 } }];
    const restored = mergeTextTargetHistory(previous, [...initial, b]);
    expect(applyResult(restored.nodes, value, { x: 0, y: 0 }, "original").status).toBe("filled");
    const deletedRestore = mergeTextTargetHistory([b], [...initial, b], restored.cache);
    expect(applyResult(deletedRestore.nodes, value, { x: 0, y: 0 }, "original").status).toBe("protected");
});

test("explicit save creates one deterministic node and stamps an existing source guard in the same patch", () => {
    const value = delivered(), initial = registerTarget([blank()], target).nodes;
    const edited = protectTextNodeChanges(initial, [{ ...initial[0], metadata: { ...initial[0].metadata, content: "保留我的正文" } }]);
    const saved = applyResult(edited, value, { x: 500, y: 600 }, "new");
    expect(saved.status).toBe("saved-new"); expect(saved.nodeId).toBe(`platform-text-${value.taskId}`); expect(saved.nodes).toHaveLength(2);
    expect(saved.nodes[0].metadata).toMatchObject({ content: "保留我的正文", platformTextRequests: [{ guardId: target.guardId, edited: true, taskId: value.taskId }] });
    expect(saved.nodes[1].metadata?.content).toBe(value.text); expect(edited[0].metadata?.platformTextRequests![0].taskId).toBeUndefined();
    expect(applyResult(saved.nodes, value, { x: 0, y: 0 }, "new").status).toBe("already-applied");
    expect(applyResult(saved.nodes.slice(0, 1), value, { x: 0, y: 0 }, "new").status).toBe("already-applied");
    expect(applyResult([], value, { x: 0, y: 0 }, "new").nodes).toHaveLength(1);
});

test("unbound toolbar results retain deterministic append and malformed or reused guards fail closed", () => {
    const value = delivered(), { target: _target, ...unbound } = value;
    const first = applyResult([], unbound, { x: 20, y: 30 }, "new");
    expect(first.status).toBe("saved-new"); expect(applyResult(first.nodes, unbound, { x: 1, y: 2 }, "new").status).toBe("already-applied");
    expect(applyResult([], unbound, { x: 0, y: 0 }, "original").status).toBe("protected");
    const occupied = [{ ...blank(), metadata: { platformTextRequests: [{ guardId: target.guardId, edited: false, taskId: crypto.randomUUID() }] } }];
    expect(applyResult(occupied, value, { x: 0, y: 0 }, "new").status).toBe("protected");
    expect(applyResult([], { ...value, taskId: "invalid" }, { x: 0, y: 0 }, "new").reason).toBe("invalid-result");
});
