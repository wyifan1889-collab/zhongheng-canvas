import { expect, test } from "bun:test";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types/canvas";
import type { CanvasProject } from "../../stores/canvas/use-canvas-store";
import { inspectCanvasDocument } from "../../services/saas/canvas-document";
import { validateCanvasDocumentMount } from "../../services/saas/canvas-document-mount";
import { applyTextConfigResult, blockPendingTextConfigTargets, blockTextConfigTargetsForMount, mergeTextConfigHistory, parsePlatformTextConfigRequests,
    protectTextConfigChanges, registerConfigTarget, rememberTextConfigTargets, stripTextConfigTarget, textConfigRequests } from "./platform-text-config";

const guardId = "11111111-1111-4111-8111-111111111111", secondGuard = "22222222-2222-4222-8222-222222222222", taskId = "33333333-3333-4333-8333-333333333333";
const target = { schemaVersion: 1 as const, nodeId: "config", guardId };
const source = (): CanvasNodeData => ({ id: "config", type: CanvasNodeType.Config, title: "原配置", position: { x: 40, y: 60 }, width: 340, height: 240,
    metadata: { generationMode: "text", composerContent: "整理 @[node:input]", textCount: 1 } });
const input = (): CanvasNodeData => ({ id: "input", type: CanvasNodeType.Text, title: "材料", position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: "原材料" } });
const edges = (): CanvasConnection[] => [{ id: "input-edge", fromNodeId: "input", toNodeId: "config" }];
const registered = () => registerConfigTarget([source(), input()], target).nodes;
const delivered = () => ({ taskId, text: "生成正文", target });
const records = (node: CanvasNodeData) => node.metadata?.platformTextConfigRequests;
function project(nodes: CanvasNodeData[], connections = edges()): CanvasProject {
    return { id: "project", title: "配置文本测试", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z", nodes, connections,
        chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
}

test("Config records use exact JSON without inheriting F1 node-fill permission", () => {
    expect(parsePlatformTextConfigRequests([{ guardId, edited: false }, { guardId: secondGuard, edited: true, taskId }])).toEqual([{ guardId, edited: false }, { guardId: secondGuard, edited: true, taskId }]);
    let calls = 0;
    const getter = { guardId, get edited() { calls++; return false; } };
    for (const value of [null, {}, [getter], [{ guardId, edited: false, extra: true }], [{ guardId, edited: false }, { guardId, edited: true }], [{ guardId, edited: false, taskId: undefined }]]) expect(parsePlatformTextConfigRequests(value)).toBeNull();
    expect(calls).toBe(0);
    const f1Only = [{ ...source(), metadata: { ...source().metadata, platformTextRequests: [{ guardId, edited: false }] } }, input()];
    expect(applyTextConfigResult(f1Only, edges(), delivered(), { x: 0, y: 0 }, "linked").reason).toBe("missing-guard");
});

test("registration preserves Config inputs and existing authority cannot be reset", () => {
    const original = [source(), input()], result = registerConfigTarget(original, target);
    expect(result.status).toBe("registered"); expect(result.nodes[0]).toMatchObject(source()); expect(records(original[0])).toBeUndefined();
    expect(records(result.nodes[0])).toEqual([{ guardId, edited: false }]);
    expect(registerConfigTarget(result.nodes, target).nodes).toBe(result.nodes);
    for (const record of [{ guardId, edited: true }, { guardId, edited: false, taskId }]) {
        const nodes = [{ ...source(), metadata: { ...source().metadata, platformTextConfigRequests: [record] } }];
        expect(registerConfigTarget(nodes, target).status).toBe("protected");
    }
    expect(registerConfigTarget([input()], { ...target, nodeId: "input" }).reason).toBe("invalid-source");
    expect(registerConfigTarget([], target).reason).toBe("missing-node");
    expect(registerConfigTarget([source(), source()], target).reason).toBe("invalid-target");
});

test("ordinary source and upstream edits irreversibly protect a pending Config request", () => {
    const original = registered(), connections = edges();
    const changedInput = original.map(node => node.id === "input" ? { ...node, metadata: { ...node.metadata, content: "手工改写材料" } } : node);
    const protectedInput = protectTextConfigChanges(original, changedInput, connections, connections);
    expect(records(protectedInput[0])).toEqual([{ guardId, edited: true }]);
    const restoredInput = protectTextConfigChanges(protectedInput, original, connections, connections);
    expect(records(restoredInput[0])).toEqual([{ guardId, edited: true }]);
    expect(applyTextConfigResult(restoredInput, connections, delivered(), { x: 0, y: 0 }, "linked").reason).toBe("edited");
    const changedSource = original.map(node => node.id === "config" ? { ...node, metadata: { ...node.metadata, composerContent: "新要求" } } : node);
    expect(records(protectTextConfigChanges(original, changedSource, connections, connections)[0])![0].edited).toBe(true);
});

test("connection and group membership changes protect Config but geometry and status do not", () => {
    const original = registered(), connections = edges();
    const moved = original.map(node => ({ ...node, position: { x: 700, y: 800 }, width: 200, metadata: { ...node.metadata, status: "loading" as const } }));
    expect(protectTextConfigChanges(original, moved, connections, connections)).toBe(moved);
    expect(records(protectTextConfigChanges(original, original, connections, [])[0])![0].edited).toBe(true);
    const grouped = registered().map(node => node.id === "config" ? { ...node, metadata: { ...node.metadata, composerContent: "@[node:group]" } } : node.id === "input" ? { ...node, metadata: { ...node.metadata, groupId: "group" } } : node);
    grouped.push({ ...source(), id: "group", type: CanvasNodeType.Group, metadata: {} });
    const groupEdges = [{ id: "group-edge", fromNodeId: "group", toNodeId: "config" }];
    const ungrouped = grouped.map(node => node.id === "input" ? { ...node, metadata: { ...node.metadata, groupId: undefined } } : node);
    expect(records(protectTextConfigChanges(grouped, ungrouped, groupEdges, groupEdges)[0])![0].edited).toBe(true);
});

test("same-ID replacement that drops guards, delete/undo and document mounts never regain pending authority", () => {
    const original = registered(), connections = edges(), cache = rememberTextConfigTargets(original);
    const replaced = protectTextConfigChanges(original, [source(), input()], connections, connections, cache);
    expect(records(replaced[0])).toEqual([{ guardId, edited: true }]);
    const restored = mergeTextConfigHistory([input()], original, [], connections, cache);
    expect(records(restored.nodes[0])).toEqual([{ guardId, edited: true }]);
    for (const nodes of [blockTextConfigTargetsForMount(original), blockPendingTextConfigTargets(original)]) expect(applyTextConfigResult(nodes, connections, delivered(), { x: 0, y: 0 }, "linked").reason).toBe("edited");
    expect(records(original[0])).toEqual([{ guardId, edited: false }]);
    const stripped = stripTextConfigTarget(original[0]);
    expect(records(stripped)).toBeUndefined(); expect(stripped.metadata?.composerContent).toBe(source().metadata?.composerContent);
});

test("unrelated movement undo retains authority while input undo and cleared guards remain protected", () => {
    const original = registered(), connections = edges(), moved = original.map(node => ({ ...node, position: { x: 500, y: 600 } }));
    const movementUndo = mergeTextConfigHistory(moved, original, connections, connections);
    expect(applyTextConfigResult(movementUndo.nodes, connections, delivered(), { x: 0, y: 0 }, "linked").status).toBe("added-linked");
    const edited = protectTextConfigChanges(original, original.map(node => node.id === "input" ? { ...node, metadata: { content: "编辑" } } : node), connections, connections);
    const editUndo = mergeTextConfigHistory(edited, original, connections, connections);
    expect(records(editUndo.nodes[0])![0].edited).toBe(true);
});

test("linked result returns one Text and deterministic edge while preserving source and all prior data", () => {
    const original = registered(), connections = edges(), result = applyTextConfigResult(original, connections, delivered(), { x: 0, y: 0 }, "linked");
    expect(result.status).toBe("added-linked"); expect(result.nodes).toHaveLength(3); expect(result.connections).toHaveLength(2);
    expect(result.nodeId).toBe(`platform-text-${taskId}`); expect(result.connectionId).toBe(`platform-text-config-link-${taskId}`);
    expect(result.nodes[0]).toMatchObject({ ...source(), metadata: { platformTextConfigRequests: [{ guardId, edited: false, taskId }] } });
    expect(result.nodes[1]).toBe(original[1]); expect(result.connections[0]).toBe(connections[0]);
    expect(result.connections[1]).toEqual({ id: result.connectionId!, fromNodeId: "config", toNodeId: result.nodeId! });
    expect(result.nodes[2]).toMatchObject({ id: result.nodeId, type: CanvasNodeType.Text, metadata: { content: "生成正文", status: "success" } });
    expect(records(original[0])![0].taskId).toBeUndefined(); expect(connections).toHaveLength(1);
});

test("replay preserves edited result and never repairs user-deleted result or edge", () => {
    const first = applyTextConfigResult(registered(), edges(), delivered(), { x: 0, y: 0 }, "linked");
    const edited = first.nodes.map(node => node.id === first.nodeId ? { ...node, metadata: { ...node.metadata, content: "用户结果编辑" } } : node);
    expect(applyTextConfigResult(edited, first.connections, delivered(), { x: 0, y: 0 }, "linked")).toMatchObject({ status: "already-applied", nodes: edited, connections: first.connections });
    const noResult = first.nodes.filter(node => node.id !== first.nodeId), noEdge = edges();
    expect(applyTextConfigResult(noResult, noEdge, delivered(), { x: 0, y: 0 }, "linked")).toMatchObject({ status: "already-applied", nodes: noResult, connections: noEdge });
    const cache = rememberTextConfigTargets(first.nodes);
    expect(applyTextConfigResult([], [], delivered(), { x: 0, y: 0 }, "new", cache).status).toBe("already-applied");
    expect(applyTextConfigResult([first.nodes[2]], [], delivered(), { x: 0, y: 0 }, "linked").status).toBe("already-applied");
    expect(applyTextConfigResult([], [first.connections[1]], delivered(), { x: 0, y: 0 }, "linked").status).toBe("already-applied");
});

test("unsafe Config association is protected and explicit save creates only an unlinked result", () => {
    const original = registered(), connections = edges(), edited = blockPendingTextConfigTargets(original);
    const blocked = applyTextConfigResult(edited, connections, delivered(), { x: 400, y: 500 }, "linked");
    expect(blocked).toMatchObject({ status: "protected", nodes: edited, connections, reason: "edited" });
    const saved = applyTextConfigResult(edited, connections, delivered(), { x: 400, y: 500 }, "new");
    expect(saved.status).toBe("saved-new"); expect(saved.connections).toBe(connections); expect(saved.connectionId).toBeUndefined();
    expect(saved.nodes[0].metadata?.composerContent).toBe(original[0].metadata?.composerContent); expect(records(saved.nodes[0])![0]).toEqual({ guardId, edited: true, taskId });
    expect(applyTextConfigResult(saved.nodes, connections, delivered(), { x: 0, y: 0 }, "new").status).toBe("already-applied");
    expect(applyTextConfigResult([input()], [], delivered(), { x: 400, y: 500 }, "linked").reason).toBe("missing-node");
    expect(applyTextConfigResult([input()], [], delivered(), { x: 400, y: 500 }, "new").status).toBe("saved-new");
});

test("malformed guards, conflicting task assignments and occupied deterministic identities fail closed", () => {
    const original = registered(), connections = edges();
    expect(applyTextConfigResult(original, connections, { ...delivered(), taskId: "bad" }, { x: 0, y: 0 }, "linked").reason).toBe("invalid-result");
    expect(applyTextConfigResult(original, connections, { ...delivered(), target: { ...target, guardId: "bad" } }, { x: 0, y: 0 }, "linked").reason).toBe("invalid-target");
    const invalid = [{ ...source(), metadata: { ...source().metadata, platformTextConfigRequests: [{ guardId, edited: false, private: true }] } } as unknown as CanvasNodeData];
    expect(applyTextConfigResult(invalid, [], delivered(), { x: 0, y: 0 }, "linked").reason).toBe("invalid-records");
    const used = original.map(node => node.id === "config" ? { ...node, metadata: { ...node.metadata, platformTextConfigRequests: [{ guardId, edited: false, taskId: secondGuard }] } } : node);
    expect(applyTextConfigResult(used, connections, delivered(), { x: 0, y: 0 }, "new").reason).toBe("already-used");
    expect(() => protectTextConfigChanges(used, original.map(node => node.id === "config" ? { ...node, metadata: { ...node.metadata, platformTextConfigRequests: [{ guardId, edited: false, taskId }] } } : node), connections, connections)).toThrow();
    const occupied = [...original, { ...input(), id: `platform-text-${taskId}`, type: CanvasNodeType.Image }];
    expect(applyTextConfigResult(occupied, connections, delivered(), { x: 0, y: 0 }, "linked").reason).toBe("occupied-result");
});

test("strict snapshot and mount preserve only well-formed Config request records", () => {
    const original = project(registered()), inspected = inspectCanvasDocument(original);
    expect((inspected.snapshot.nodes as CanvasNodeData[])[0].metadata?.platformTextConfigRequests).toEqual([{ guardId, edited: false }]);
    expect(validateCanvasDocumentMount(inspected.snapshot).project.nodes[0].metadata?.platformTextConfigRequests).toEqual([{ guardId, edited: false }]);
    for (const value of [null, {}, [{ guardId, edited: "false" }], [{ guardId, edited: false, taskId: "bad" }], [{ guardId, edited: false, extra: true }]]) {
        const invalid = project([{ ...source(), metadata: { ...source().metadata, platformTextConfigRequests: value } } as CanvasNodeData, input()]);
        expect(() => inspectCanvasDocument(invalid)).toThrow(); expect(() => validateCanvasDocumentMount(invalid)).toThrow();
    }
    const withUndefined = project([{ ...source(), metadata: { ...source().metadata, platformTextConfigRequests: undefined } }, input()]);
    expect(inspectCanvasDocument(withUndefined).omittedOptionalPaths).toContain("/nodes/0/metadata/platformTextConfigRequests");
    expect(() => validateCanvasDocumentMount(withUndefined)).toThrow();
});

test("Config result placement avoids occupied rectangles without moving existing nodes", () => {
    const original = registered().map(node => node.id === "config"
        ? { ...node, position: { x: 650, y: 110 }, width: 360, height: 300 }
        : { ...node, position: { x: 75, y: 85 }, width: 420, height: 165 });
    original.push({ ...input(), id: "note", position: { x: 1120, y: 140 }, width: 340, height: 210 },
        { ...input(), id: "lower", position: { x: 650, y: 500 }, width: 420, height: 170 },
        { ...input(), id: "group", type: CanvasNodeType.Group, position: { x: 40, y: 30 }, width: 500, height: 490 },
        { ...input(), id: "b", position: { x: 75, y: 290 }, width: 420, height: 165 });
    const overlap = (a: CanvasNodeData, b: CanvasNodeData) => a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x &&
        a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
    const first = applyTextConfigResult(original, edges(), delivered(), { x: 850, y: 440 }, "linked");
    const secondTarget = { ...target, guardId: secondGuard };
    const beforeSecond = registerConfigTarget(first.nodes, secondTarget).nodes;
    const second = applyTextConfigResult(beforeSecond, first.connections,
        { taskId: "44444444-4444-4444-8444-444444444444", text: "第二份结果", target: secondTarget }, { x: 850, y: 440 }, "linked");
    const saved = applyTextConfigResult(blockPendingTextConfigTargets(original), edges(), delivered(), { x: 850, y: 440 }, "new");
    const firstNode = first.nodes.find(node => node.id === first.nodeId)!, secondNode = second.nodes.find(node => node.id === second.nodeId)!, savedNode = saved.nodes.find(node => node.id === saved.nodeId)!;
    const unchanged = (nodes: CanvasNodeData[]) => original.every(before => {
        const after = nodes.find(node => node.id === before.id)!;
        return JSON.stringify([after.position, after.width, after.height, after.metadata?.content, after.metadata?.prompt, after.metadata?.composerContent]) ===
            JSON.stringify([before.position, before.width, before.height, before.metadata?.content, before.metadata?.prompt, before.metadata?.composerContent]);
    });
    const clearLinked = applyTextConfigResult(registered(), edges(), delivered(), { x: 2000, y: 1500 }, "linked");
    const clearNew = applyTextConfigResult(registered(), edges(), delivered(), { x: 2000, y: 1500 }, "new");
    const clearLinkedNode = clearLinked.nodes.find(node => node.id === clearLinked.nodeId)!, clearNewNode = clearNew.nodes.find(node => node.id === clearNew.nodeId)!;
    expect({
        linkedOverlaps: original.some(node => overlap(firstNode, node)),
        repeatedLinkedOverlaps: beforeSecond.some(node => overlap(secondNode, node)),
        explicitNewOverlaps: original.some(node => overlap(savedNode, node)),
        oldNodesUnmoved: [first.nodes, second.nodes, saved.nodes].every(unchanged),
        clearLinkedPreferred: clearLinkedNode.position.x === source().position.x + source().width + 96 && clearLinkedNode.position.y === source().position.y + source().height / 2 - clearLinkedNode.height / 2,
        clearNewPreferred: clearNewNode.position.x === 2000 - clearNewNode.width / 2 && clearNewNode.position.y === 1500 - clearNewNode.height / 2,
        existingEdgeUnchanged: first.connections[0] === edges()[0] || JSON.stringify(first.connections[0]) === JSON.stringify(edges()[0]),
        explicitNewUnlinked: saved.connections.length === edges().length && saved.connectionId === undefined,
    }).toEqual({ linkedOverlaps: false, repeatedLinkedOverlaps: false, explicitNewOverlaps: false, oldNodesUnmoved: true,
        clearLinkedPreferred: true, clearNewPreferred: true, existingEdgeUnchanged: true, explicitNewUnlinked: true });
});
