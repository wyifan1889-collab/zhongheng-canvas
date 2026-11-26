import { expect, test } from "bun:test";
import type { TextTargetBinding } from "../../services/saas/canvas-text-receipt";
import { CanvasNodeType, type CanvasNodeData, type CanvasPlatformTextRequest } from "../../types/canvas";
import { blockTextTargetsForMount, mergeTextTargetHistory, parsePlatformTextRequests, protectTextNodeChanges, registerTarget, rememberTextTargets, stripTarget } from "./platform-text-target";

const guardId = "11111111-1111-4111-8111-111111111111", otherGuard = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333", otherTask = "44444444-4444-4444-8444-444444444444";
const target: TextTargetBinding = { schemaVersion: 1, nodeId: "source", guardId };
const source = (): CanvasNodeData => ({ id: "source", type: CanvasNodeType.Text, title: "用户节点", position: { x: 12, y: 34 }, width: 230, height: 150, metadata: { content: "", fontSize: 18 } });
const requests = (node: CanvasNodeData) => node.metadata?.platformTextRequests;

test("reserved records accept exact detached JSON and reject duplicates, unknown fields and lossy values", () => {
    const value = [{ guardId, edited: false }, { guardId: otherGuard, edited: true, taskId }];
    const parsed = parsePlatformTextRequests(value);
    expect(parsed).toEqual(value); expect(parsed).not.toBe(value); expect(parsed![0]).not.toBe(value[0]);
    const sparse = new Array(1), extended = [...value]; Object.assign(extended, { extension: true });
    let getterCalls = 0;
    const getter = { guardId, get edited() { getterCalls++; return false; } };
    for (const invalid of [null, {}, sparse, extended, [{ guardId, edited: "false" }], [{ guardId: "bad", edited: false }],
        [{ guardId, edited: false, taskId: "bad" }], [{ guardId, edited: false, taskId: undefined }], [{ guardId, edited: false, private: "not-retained" }],
        [{ guardId, edited: false }, { guardId, edited: true }], [getter], [Object.defineProperty({ guardId }, "edited", { value: false })]]) {
        expect(parsePlatformTextRequests(invalid)).toBeNull();
    }
    expect(getterCalls).toBe(0);
});

test("registration keeps source identity and never resets an existing edited/applied guard", () => {
    const initial = [source()], registered = registerTarget(initial, target);
    expect(registered.status).toBe("registered"); expect(initial[0].metadata).not.toHaveProperty("platformTextRequests");
    expect(registered.nodes[0]).toMatchObject({ id: "source", position: initial[0].position, width: 230, height: 150, metadata: { platformTextRequests: [{ guardId, edited: false }] } });
    expect(registerTarget(registered.nodes, target).nodes).toBe(registered.nodes);
    for (const record of [{ guardId, edited: true }, { guardId, edited: false, taskId }]) {
        const nodes = [{ ...source(), metadata: { platformTextRequests: [record] } }];
        const result = registerTarget(nodes, target);
        expect(result.status).toBe("protected"); expect(result.nodes).toBe(nodes); expect(requests(nodes[0])).toEqual([record]);
    }
    expect(registerTarget([{ ...source(), metadata: { content: "正文" } }], target).reason).toBe("occupied-node");
    expect(registerTarget([], target).reason).toBe("missing-node");
    expect(registerTarget([source(), source()], target).reason).toBe("invalid-target");
});

test("edit then clear preserves durable protection even if an incoming patch drops or resets records", () => {
    const initial = registerTarget([source()], target).nodes;
    const edited = protectTextNodeChanges(initial, [{ ...initial[0], metadata: { ...initial[0].metadata, content: "用户编辑" } }]);
    expect(requests(edited[0])).toEqual([{ guardId, edited: true }]);
    const cleared = protectTextNodeChanges(edited, [{ ...edited[0], metadata: { content: "" } }]);
    expect(requests(cleared[0])).toEqual([{ guardId, edited: true }]);
    const stale = protectTextNodeChanges(cleared, initial);
    expect(requests(stale[0])).toEqual([{ guardId, edited: true }]);
    expect(requests(initial[0])).toEqual([{ guardId, edited: false }]);
});

test("atomic result patches keep their applied guard while body changes invalidate every other pending guard", () => {
    const initial = registerTarget(registerTarget([source()], target).nodes, { ...target, guardId: otherGuard }).nodes;
    const applied = protectTextNodeChanges(initial, [{ ...initial[0], metadata: { content: "生成正文", platformTextRequests: [{ guardId, edited: false, taskId }] } }]);
    expect(requests(applied[0])).toEqual([{ guardId, edited: false, taskId }, { guardId: otherGuard, edited: true }]);
    const cleared = protectTextNodeChanges(applied, [{ ...source(), metadata: { content: "" } }]);
    expect(requests(cleared[0])![0].taskId).toBe(taskId);
    const conflicting = [{ ...source(), metadata: { platformTextRequests: [{ guardId, edited: false, taskId: otherTask }] } }];
    expect(() => protectTextNodeChanges(applied, conflicting)).toThrow("文本回填关联无法核对");
});

test("body-changing undo blocks pending guards and a monotonic cache preserves deleted or applied associations", () => {
    const initial = registerTarget([source()], target).nodes;
    const applied = [{ ...initial[0], metadata: { ...initial[0].metadata, content: "已应用", platformTextRequests: [{ guardId, edited: false, taskId }] } }];
    const cached = rememberTextTargets(applied), restored = mergeTextTargetHistory([], initial, cached);
    expect(requests(restored.nodes[0])).toEqual([{ guardId, edited: false, taskId }]);
    expect(cached.get("source")).toEqual([{ guardId, edited: false, taskId }]);
    const edited = [{ ...initial[0], metadata: { ...initial[0].metadata, content: "用户编辑" } }];
    const pending = mergeTextTargetHistory(edited, initial);
    expect(requests(pending.nodes[0])).toEqual([{ guardId, edited: true }]);
    const deleted = mergeTextTargetHistory(pending.nodes, [], pending.cache);
    expect(deleted.nodes).toEqual([]);
    expect(requests(mergeTextTargetHistory([], initial, deleted.cache).nodes[0])).toEqual([{ guardId, edited: true }]);
    const conflict = new Map<string, CanvasPlatformTextRequest[]>([["source", [{ guardId, edited: false, taskId: otherTask }]]]);
    expect(() => mergeTextTargetHistory(applied, initial, conflict)).toThrow();
});

test("undoing another node's movement leaves an untouched pending source eligible for original fill", () => {
    const a = registerTarget([source()], target).nodes[0], b = { ...source(), id: "other", position: { x: 500, y: 600 } };
    const previous = [a, { ...b, position: { x: 700, y: 800 } }], snapshot = [a, b];
    const restored = mergeTextTargetHistory(previous, snapshot, rememberTextTargets(previous));
    expect(requests(restored.nodes[0])).toEqual([{ guardId, edited: false }]);
    expect(registerTarget(restored.nodes, target).status).toBe("registered");
    expect(restored.nodes[1].position).toEqual(b.position);
    const movedSource = [{ ...a, position: { x: 99, y: 100 } }, b];
    expect(requests(mergeTextTargetHistory(movedSource, snapshot).nodes[0])).toEqual([{ guardId, edited: false }]);
    const implicitBlank = { ...a, metadata: { platformTextRequests: a.metadata!.platformTextRequests } };
    expect(requests(mergeTextTargetHistory([implicitBlank, b], snapshot).nodes[0])).toEqual([{ guardId, edited: false }]);
});

test("edit then clear and undo keeps prior protection while mounting always blocks pending guards", () => {
    const initial = registerTarget([source()], target).nodes;
    const edited = protectTextNodeChanges(initial, [{ ...initial[0], metadata: { ...initial[0].metadata, content: "编辑" } }]);
    const cleared = protectTextNodeChanges(edited, initial), undone = mergeTextTargetHistory(cleared, initial, rememberTextTargets(cleared));
    expect(requests(undone.nodes[0])).toEqual([{ guardId, edited: true }]);
    expect(registerTarget(undone.nodes, target).reason).toBe("edited");
    const mixed = [{ ...source(), metadata: { platformTextRequests: [{ guardId, edited: false }, { guardId: otherGuard, edited: false, taskId }] } }];
    const mounted = blockTextTargetsForMount(mixed);
    expect(requests(mounted[0])).toEqual([{ guardId, edited: true }, { guardId: otherGuard, edited: false, taskId }]);
    expect(requests(mixed[0])![0].edited).toBe(false);
    expect(blockTextTargetsForMount(mounted)).toBe(mounted);
});

test("agent undo and same-ID recreation cannot revive a deleted pending guard through the ordinary setter", () => {
    const initial = registerTarget([source()], target).nodes, cache = rememberTextTargets(initial);
    expect(protectTextNodeChanges(initial, [], cache)).toEqual([]);
    const restored = protectTextNodeChanges([], initial, cache);
    expect(requests(restored[0])).toEqual([{ guardId, edited: true }]);
    const recreated = protectTextNodeChanges([], [source()], cache);
    expect(requests(recreated[0])).toEqual([{ guardId, edited: true }]);
    expect(requests(initial[0])).toEqual([{ guardId, edited: false }]);
    expect(cache.get("source")).toEqual([{ guardId, edited: false }]);
    const appliedCache = new Map<string, CanvasPlatformTextRequest[]>([["source", [{ guardId, edited: false, taskId }]]]);
    expect(requests(protectTextNodeChanges([], [source()], appliedCache)[0])).toEqual([{ guardId, edited: false, taskId }]);
    const firstRegistration = registerTarget([source()], target).nodes;
    expect(requests(protectTextNodeChanges([source()], firstRegistration, cache)[0])).toEqual([{ guardId, edited: false }]);
});

test("duplicate/mount stripping removes all authority without mutating original metadata", () => {
    const node = registerTarget([source()], target).nodes[0], stripped = stripTarget(node);
    expect(stripped.id).toBe(node.id); expect(stripped.metadata).toEqual({ content: "", fontSize: 18 });
    expect(stripped.metadata).not.toBe(node.metadata); expect(node.metadata).toHaveProperty("platformTextRequests");
    expect(stripTarget(source()).metadata).toEqual(source().metadata);
});
