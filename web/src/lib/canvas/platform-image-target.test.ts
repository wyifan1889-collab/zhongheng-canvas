import { expect, test } from "bun:test";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "../../types/canvas";
import { applyImageTargetResult, blockPendingImageTargets, imageTargetRequests, isEmptyImageTarget, mergeImageTargetHistory, parsePlatformImageRequests,
    protectImageTargetChanges, registerImageTarget, rememberImageTargets, stripImageTarget, validImageTarget, type ImageTargetBinding, type ImageTargetResult } from "./platform-image-target";
import { inspectCanvasDocument, prepareCanvasDocumentForCloudSave } from "../../services/saas/canvas-document";
import { validateCanvasDocumentMount } from "../../services/saas/canvas-document-mount";

const guardId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secondGuard = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const taskId = "11111111-1111-4111-8111-111111111111", secondTask = "22222222-2222-4222-8222-222222222222", mediaId = "33333333-3333-4333-8333-333333333333";
const center = { x: 850, y: 440 };
const target = (sourceType: ImageTargetBinding["sourceType"] = "image", guard = guardId): ImageTargetBinding => ({ schemaVersion: 1, nodeId: "source", guardId: guard, sourceType });
const source = (type: CanvasNodeType = CanvasNodeType.Image, metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id: "source", type, title: "原节点", position: { x: 650, y: 110 }, width: 360, height: 300,
    metadata: { content: "", prompt: "原要求", ...(type === CanvasNodeType.Config ? { generationMode: "image" as const } : {}), ...metadata } });
const reference = (): CanvasNodeData => ({ id: "reference", type: CanvasNodeType.Text, title: "引用文本", position: { x: 40, y: 30 }, width: 400, height: 200, metadata: { content: "原引用正文" } });
const edges: CanvasConnection[] = [{ id: "reference-to-source", fromNodeId: "reference", toNodeId: "source" }];
const result = (binding: ImageTargetBinding | undefined = target(), id = taskId): ImageTargetResult => ({ taskId: id, cloudMediaId: mediaId, url: "blob:synthetic-owned-image", width: 1024, height: 512, bytes: 232, mimeType: "image/png", ...(binding ? { target: binding } : {}) });
const find = (nodes: CanvasNodeData[], id = "source") => nodes.find(node => node.id === id)!;
const register = (nodes = [source()], binding = target()) => { const value = registerImageTarget(nodes, binding); expect(value.status).toBe("registered"); return value.nodes; };
const project = (nodes: CanvasNodeData[]) => ({ id: "synthetic-project", title: "Synthetic", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z", nodes, connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } });
const overlap = (left: CanvasNodeData, right: CanvasNodeData) => left.position.x < right.position.x + right.width && left.position.x + left.width > right.position.x && left.position.y < right.position.y + right.height && left.position.y + left.height > right.position.y;

test("multiple delivered images fill one original gallery and retain one task guard", () => {
    const first = result(), { taskId: _task, target: _target, ...image } = first;
    const images = [image, { ...image, cloudMediaId: secondTask, url: "blob:second" }];
    const applied = applyImageTargetResult(register(), edges, { ...first, images }, center, "original");
    expect(applied.status).toBe("filled-original"); expect(applied.nodes).toHaveLength(1);
    expect(applied.nodes[0]!.metadata!.images).toHaveLength(2);
    expect(applied.nodes[0]!.metadata!.primaryImageId).toBe(mediaId);
    expect(applyImageTargetResult(applied.nodes, edges, { ...first, images }, center, "original").status).toBe("already-applied");
    expect(applyImageTargetResult(register(), edges, { ...first, images: [image, image] }, center, "original").reason).toBe("invalid-result");
    const saved = prepareCanvasDocumentForCloudSave(inspectCanvasDocument(project(applied.nodes)));
    expect(JSON.stringify(saved.snapshot)).not.toContain("blob:");
    const mounted = validateCanvasDocumentMount(saved.snapshot).project.nodes as CanvasNodeData[];
    expect(mounted[0]!.metadata!.primaryImageId).toBe(mediaId);
    expect(mounted[0]!.metadata!.images?.map(item => item.cloudMediaId)).toEqual([mediaId, secondTask]);
});

test("image request records have the exact grammar and Image bindings cannot borrow Text target authority", () => {
    expect(parsePlatformImageRequests([{ guardId: guardId.toUpperCase(), edited: false, taskId: taskId.toUpperCase() }])).toEqual([{ guardId, edited: false, taskId }]);
    const sparse = new Array(1), extra = Object.assign([{ guardId, edited: false }], { hidden: true });
    for (const records of [null, {}, sparse, extra, [{ guardId, edited: false, extra: true }], [{ guardId, edited: false, taskId: undefined }], [{ guardId, edited: false }, { guardId: guardId.toUpperCase(), edited: true }]]) expect(parsePlatformImageRequests(records)).toBeNull();
    expect(validImageTarget(target())).toBe(true);
    for (const value of [{ schemaVersion: 1, nodeId: "source", guardId }, { ...target(), sourceType: "text" }, { ...target(), extra: true }, { ...target(), sourceType: { toString: () => "image" } }]) expect(validImageTarget(value as ImageTargetBinding)).toBe(false);
    expect(registerImageTarget([source(CanvasNodeType.Text)], target()).reason).toBe("invalid-source");
    expect(registerImageTarget([source()], target("config")).reason).toBe("invalid-source");
});

test("empty Image fills original identity, geometry and edges with actual media once", () => {
    const nodes = register(), before = structuredClone(nodes), value = applyImageTargetResult(nodes, edges, result(), center, "original");
    expect(value.status).toBe("filled-original"); expect(value.nodeId).toBe("source"); expect(value.nodes).toHaveLength(1); expect(value.connections).toBe(edges);
    const filled = find(value.nodes); for (const key of ["id", "type", "title", "position", "width", "height"] as const) expect(filled[key]).toEqual(find(before)[key]);
    expect(filled.metadata).toMatchObject({ content: "blob:synthetic-owned-image", cloudMediaId: mediaId, naturalWidth: 1024, naturalHeight: 512, bytes: 232, mimeType: "image/png", status: "success", prompt: "原要求", platformImageRequests: [{ guardId, edited: false, taskId }] });
    expect(nodes).toEqual(before);
    const manuallyEdited = value.nodes.map(node => ({ ...node, metadata: { ...node.metadata, content: "blob:manual-replacement" } }));
    const again = applyImageTargetResult(manuallyEdited, edges, result(), center, "original"); expect(again.status).toBe("already-applied"); expect(again.nodes).toBe(manuallyEdited);
});

test("Config creates distinct linked Image nodes with true ratio and bounded nonoverlapping placement", () => {
    const binding = target("config"), note: CanvasNodeData = { id: "note", type: CanvasNodeType.Text, title: "原说明", position: { x: 1120, y: 140 }, width: 340, height: 210, metadata: { content: "保持原文" } };
    const original = [source(CanvasNodeType.Config), note], firstNodes = register(original, binding);
    const first = applyImageTargetResult(firstNodes, [], result(binding), center, "linked"); expect(first.status).toBe("added-linked");
    expect(first.connectionId).toBe(`platform-image-config-link-${taskId}`); expect(first.connections).toEqual([{ id: first.connectionId!, fromNodeId: "source", toNodeId: `platform-image-${taskId}` }]);
    const firstImage = find(first.nodes, `platform-image-${taskId}`); expect(firstImage.width / firstImage.height).toBe(2); expect(overlap(firstImage, note)).toBe(false);
    const secondBinding = target("config", secondGuard), secondNodes = register(first.nodes, secondBinding), second = applyImageTargetResult(secondNodes, first.connections, result(secondBinding, secondTask), center, "linked");
    expect(second.status).toBe("added-linked"); expect(second.nodes).toHaveLength(4); expect(second.connections).toHaveLength(2); const secondImage = find(second.nodes, `platform-image-${secondTask}`);
    expect(overlap(firstImage, secondImage)).toBe(false); expect(overlap(secondImage, note)).toBe(false); expect(find(second.nodes, "note")).toEqual(note);
    expect(find(second.nodes).position).toEqual(original.find(node => node.id === "source")!.position);
});

test("occupied Image never implicitly overwrites or falls back; explicit new preserves it", () => {
    const original = source(CanvasNodeType.Image, { content: "blob:original", cloudMediaId: mediaId, naturalWidth: 320, naturalHeight: 240 });
    expect(isEmptyImageTarget(original)).toBe(false); expect(isEmptyImageTarget(source(CanvasNodeType.Image, { storageKey: "image:old" }))).toBe(false);
    const nodes = register([original]); expect(applyImageTargetResult(nodes, [], result(), center, "original")).toMatchObject({ status: "protected", reason: "occupied-node" });
    const value = applyImageTargetResult(nodes, [], result(), center, "new"); expect(value.status).toBe("saved-new"); expect(value.connections).toEqual([]); expect(find(value.nodes).metadata?.content).toBe("blob:original"); expect(value.nodes).toHaveLength(2);
});

test("real media replacement fields latch pending edits while geometry/status alone do not", () => {
    const nodes = register();
    const moved = nodes.map(node => ({ ...node, position: { x: 900, y: 800 }, width: 400, height: 250, metadata: { ...node.metadata, status: "loading" as const, errorDetails: "loading" } }));
    expect(imageTargetRequests(find(protectImageTargetChanges(nodes, moved, [], [])))?.find(item => item.guardId === guardId)?.edited).toBe(false);
    for (const patch of [{ content: "blob:new" }, { cloudMediaId: mediaId }, { naturalWidth: 100 }, { storageKey: "image:new" }, { references: ["image:new"] },
        { images: [{ id: "nested", content: "blob:nested", status: "success" as const, naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" }] }]) {
        const changed = nodes.map(node => ({ ...node, metadata: { ...node.metadata, ...patch } }));
        const protectedNodes = protectImageTargetChanges(nodes, changed, [], []); expect(imageTargetRequests(find(protectedNodes))?.find(item => item.guardId === guardId)?.edited).toBe(true);
    }
    const edited = protectImageTargetChanges(nodes, nodes.map(node => ({ ...node, metadata: { ...node.metadata, content: "blob:manual" } })), [], []);
    const restored = protectImageTargetChanges(edited, nodes, [], []); expect(applyImageTargetResult(restored, [], result(), center, "original").reason).toBe("edited");
    expect(applyImageTargetResult(restored, [], result(), center, "new").status).toBe("saved-new");
});

test("changing the node platform selection protects the prior task even after restoring its value", () => {
    const selection = { modelId: "image-2.5", specification: "1K", combination: "first-combination" };
    const nodes = register([source(CanvasNodeType.Image, { platformImageSelection: selection })]);
    const changed = nodes.map(node => ({ ...node, metadata: { ...node.metadata, platformImageSelection: { ...selection, combination: "second-combination" } } }));
    const protectedNodes = protectImageTargetChanges(nodes, changed, [], []);
    expect(imageTargetRequests(find(protectedNodes))?.[0].edited).toBe(true);
    const restored = protectImageTargetChanges(protectedNodes, nodes, [], []);
    expect(applyImageTargetResult(restored, [], result(), center, "original").reason).toBe("edited");
});

test("Config upstream text and connection changes protect pending Image authority", () => {
    const binding = target("config"), nodes = register([source(CanvasNodeType.Config), reference()], binding);
    const changed = nodes.map(node => node.id === "reference" ? { ...node, metadata: { content: "手工改过的上游正文" } } : node);
    expect(imageTargetRequests(find(protectImageTargetChanges(nodes, changed, edges, edges)))?.find(item => item.guardId === guardId)?.edited).toBe(true);
    expect(imageTargetRequests(find(protectImageTargetChanges(nodes, nodes, edges, [])))?.find(item => item.guardId === guardId)?.edited).toBe(true);
    const moved = nodes.map(node => node.id === "reference" ? { ...node, position: { x: 300, y: 300 } } : node);
    expect(imageTargetRequests(find(protectImageTargetChanges(nodes, moved, edges, edges)))?.find(item => item.guardId === guardId)?.edited).toBe(false);
});

test("edit or mask source changes latch authority across restored values and cached history", () => {
    const nodes = register([source(CanvasNodeType.Image, { generationType: "generation" })]);
    for (const patch of [{ generationType: "edit" as const }, { mask: "synthetic-mask" }, { maskDataUrl: "data:image/png;base64,synthetic" }, { maskUrl: "blob:synthetic-mask" }]) {
        const changed = nodes.map(node => ({ ...node, metadata: { ...node.metadata, ...patch } }));
        const blocked = protectImageTargetChanges(nodes, changed, [], []), restored = protectImageTargetChanges(blocked, nodes, [], []);
        expect(imageTargetRequests(find(blocked))?.find(item => item.guardId === guardId)?.edited).toBe(true);
        expect(applyImageTargetResult(restored, [], result(), center, "original").reason).toBe("edited");
        const cached = rememberImageTargets(restored);
        expect(applyImageTargetResult(nodes, [], result(), center, "original", cached).reason).toBe("edited");
    }
});

test("all source-to-Config edge identities and ambiguous Config endpoints latch pending authority", () => {
    const firstConfig = { ...source(CanvasNodeType.Config), id: "config-first" }, secondConfig = { ...source(CanvasNodeType.Config), id: "config-second" };
    const nodes = register([source(), firstConfig, secondConfig]);
    const beforeEdges = [{ id: "source-to-first", fromNodeId: "source", toNodeId: "config-first" }];
    const afterEdges = [...beforeEdges, { id: "source-to-second", fromNodeId: "source", toNodeId: "config-second" }];
    const blocked = protectImageTargetChanges(nodes, nodes, beforeEdges, afterEdges), restored = protectImageTargetChanges(blocked, nodes, afterEdges, beforeEdges);
    expect(imageTargetRequests(find(blocked))?.find(item => item.guardId === guardId)?.edited).toBe(true);
    expect(applyImageTargetResult(restored, beforeEdges, result(), center, "original").reason).toBe("edited");
    const duplicated = protectImageTargetChanges(nodes, [...nodes, { ...firstConfig }], beforeEdges, beforeEdges);
    expect(imageTargetRequests(find(duplicated))?.find(item => item.guardId === guardId)?.edited).toBe(true);
    const geometric = nodes.map(node => node.id === "config-second" ? { ...node, position: { x: 900, y: 900 }, metadata: { ...node.metadata, status: "loading" as const } } : node);
    expect(imageTargetRequests(find(protectImageTargetChanges(nodes, geometric, afterEdges, afterEdges)))?.find(item => item.guardId === guardId)?.edited).toBe(false);
});

test("delete/Undo and same-ID replacement cannot restore pending write permission", () => {
    const nodes = register(), cache = rememberImageTargets(nodes), restored = mergeImageTargetHistory([], nodes, [], [], cache);
    expect(applyImageTargetResult(restored.nodes, [], result(), center, "original").reason).toBe("edited");
    const replaced = protectImageTargetChanges(nodes, [source()], [], [], cache); expect(imageTargetRequests(find(replaced))?.find(item => item.guardId === guardId)?.edited).toBe(true);
    expect(applyImageTargetResult(replaced, [], result(), center, "original").status).toBe("protected");
    const applied = applyImageTargetResult(nodes, [], result(), center, "original"), remembered = rememberImageTargets(applied.nodes, cache);
    expect(applyImageTargetResult([], [], result(), center, "new", remembered).status).toBe("already-applied"); expect(cache.get("source")?.find(item => item.guardId === guardId)?.taskId).toBeUndefined();
});

test("pending blocks latch monotonically but ordinary preserved guard needs no reauthorization", () => {
    const nodes = register(); expect(registerImageTarget(nodes, target()).nodes).toBe(nodes);
    expect(applyImageTargetResult(nodes, [], result(), center, "original").status).toBe("filled-original");
    const blocked = blockPendingImageTargets(nodes); expect(applyImageTargetResult(blocked, [], result(), center, "original").reason).toBe("edited"); expect(registerImageTarget(blocked, target()).reason).toBe("edited");
    const editedCache = rememberImageTargets(blocked);
    expect(applyImageTargetResult(nodes, [], result(), center, "original", editedCache).reason).toBe("edited");
    expect(imageTargetRequests(find(protectImageTargetChanges(nodes, nodes, [], [], editedCache)))?.find(item => item.guardId === guardId)?.edited).toBe(true);
});

test("legacy results never acquire a target and explicit new cannot overwrite deterministic result identity", () => {
    const legacy = { ...result() }; delete legacy.target;
    expect(applyImageTargetResult([source()], [], legacy, center, "original").reason).toBe("invalid-target");
    const value = applyImageTargetResult([source()], [], legacy, center, "new"); expect(value.status).toBe("saved-new"); expect(find(value.nodes).metadata?.platformImageRequests).toBeUndefined();
    const edited = value.nodes.map(node => node.id === value.nodeId ? { ...node, metadata: { ...node.metadata, content: "blob:user-edit" } } : node);
    expect(applyImageTargetResult(edited, [], legacy, center, "new")).toMatchObject({ status: "already-applied", nodes: edited });
    expect(applyImageTargetResult([{ ...source(CanvasNodeType.Text), id: `platform-image-${taskId}` }], [], legacy, center, "new").reason).toBe("occupied-result");
    for (const patch of [{ width: 0 }, { height: Number.NaN }, { bytes: 0 }, { mimeType: "image/jpeg" }, { cloudMediaId: "not-media-id" }]) expect(applyImageTargetResult([], [], { ...legacy, ...patch } as ImageTargetResult, center, "new").reason).toBe("invalid-result");
});

test("ordinary serialization keeps exact Image records; copies and external mount strip only Image authority", () => {
    const nodes = register(), record = { guardId, edited: false }, copied = stripImageTarget(find(nodes));
    expect(copied.metadata?.platformImageRequests).toBeUndefined(); expect(copied.metadata?.prompt).toBe("原要求"); expect(find(nodes).metadata?.platformImageRequests).toEqual([record]);
    const document = project(nodes), inspected = inspectCanvasDocument(document); expect((inspected.snapshot.nodes as any[]).find(node => node.id === "source").metadata.platformImageRequests).toEqual([record]);
    const mounted = validateCanvasDocumentMount(document); expect(find(mounted.project.nodes as CanvasNodeData[]).metadata?.platformImageRequests).toBeUndefined(); expect(find(nodes).metadata?.platformImageRequests).toEqual([record]);
    const invalid = project([source(CanvasNodeType.Image, { platformImageRequests: [{ guardId, edited: false }, { guardId, edited: true }] })]);
    expect(() => inspectCanvasDocument(invalid)).toThrow(expect.objectContaining({ code: "invalid_project", path: "/nodes/0/metadata/platformImageRequests" }));
    expect(() => validateCanvasDocumentMount(invalid)).toThrow();
});
