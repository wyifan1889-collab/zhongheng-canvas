import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasPlatformImageRequest, type Position } from "../../types/canvas";
import { createCanvasNode } from "./canvas-node-factory";
import { fitNodeSize } from "./canvas-node-size";
import { platformTextInputSignature } from "./platform-text-input";
import { parsePlatformTextRequests } from "./platform-text-target";

export type ImageTargetBinding = Readonly<{ schemaVersion: 1; nodeId: string; guardId: string; sourceType: "image" | "config" }>;
export type ImageTargetHistoryCache = ReadonlyMap<string, readonly CanvasPlatformImageRequest[]>;
export type ImageTargetProtectionReason = "invalid-target" | "invalid-records" | "missing-node" | "missing-guard" | "invalid-source" | "occupied-node" | "edited" | "already-used" | "invalid-result" | "occupied-result";
export type ImageTargetResult = { taskId: string; cloudMediaId: string; url: string; width: number; height: number; bytes: number; mimeType: "image/png"; target?: ImageTargetBinding;
    images?: Array<{ cloudMediaId: string; url: string; width: number; height: number; bytes: number; mimeType: "image/png" }> };
export type ImageTargetApplication = {
    nodes: CanvasNodeData[]; connections: CanvasConnection[]; nodeId?: string; connectionId?: string;
    status: "filled-original" | "added-linked" | "saved-new" | "already-applied" | "protected"; reason?: ImageTargetProtectionReason;
};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ownData = (value: object, key: string) => { const entry = Object.getOwnPropertyDescriptor(value, key); return entry?.enumerable && Object.hasOwn(entry, "value") ? entry.value : undefined; };
const invalidRecords = () => new Error("图片任务关联无法核对，请保留原任务回执。");

/** Shared exact JSON grammar only; Image authority is never a Text target permission. */
export const parsePlatformImageRequests = (value: unknown): CanvasPlatformImageRequest[] | null => parsePlatformTextRequests(value);
export function validImageTarget(target: ImageTargetBinding): boolean {
    return plain(target) && Reflect.ownKeys(target).length === 4 && Reflect.ownKeys(target).every(key => typeof key === "string" && ["schemaVersion", "nodeId", "guardId", "sourceType"].includes(key)) &&
        ownData(target, "schemaVersion") === 1 && typeof ownData(target, "nodeId") === "string" && !!target.nodeId && target.nodeId.trim() === target.nodeId &&
        !/[\u0000-\u001f\u007f]/.test(target.nodeId) && uuid(ownData(target, "guardId")) && (ownData(target, "sourceType") === "image" || ownData(target, "sourceType") === "config");
}
export function imageTargetRequests(node: CanvasNodeData): CanvasPlatformImageRequest[] | null {
    return node.metadata && Object.hasOwn(node.metadata, "platformImageRequests") ? parsePlatformImageRequests(node.metadata.platformImageRequests) : [];
}
export function isEmptyImageTarget(node: CanvasNodeData | undefined): boolean {
    const metadata = node?.metadata;
    return node?.type === CanvasNodeType.Image && (metadata?.content ?? "") === "" && !metadata?.cloudMediaId && !metadata?.storageKey && !metadata?.primaryImageId && !metadata?.images?.length;
}
const matchesSource = (node: CanvasNodeData, target: ImageTargetBinding) => target.sourceType === "image" ? node.type === CanvasNodeType.Image : node.type === CanvasNodeType.Config && node.metadata?.generationMode === "image";
function withRecords(node: CanvasNodeData, records: CanvasPlatformImageRequest[]): CanvasNodeData {
    const previous = node.metadata?.platformImageRequests;
    return previous?.length === records.length && previous.every((item, index) => item.guardId === records[index].guardId && item.edited === records[index].edited && item.taskId === records[index].taskId) ||
        !records.length && !Object.hasOwn(node.metadata ?? {}, "platformImageRequests") ? node : { ...node, metadata: { ...node.metadata, platformImageRequests: records } };
}
function mergeRecords(left: readonly CanvasPlatformImageRequest[], right: readonly CanvasPlatformImageRequest[]): CanvasPlatformImageRequest[] {
    const result = new Map<string, CanvasPlatformImageRequest>();
    for (const list of [left, right]) for (const item of list) {
        const before = result.get(item.guardId);
        if (before?.taskId && item.taskId && before.taskId !== item.taskId) throw invalidRecords();
        result.set(item.guardId, { guardId: item.guardId, edited: !!before?.edited || item.edited, ...(before?.taskId || item.taskId ? { taskId: before?.taskId ?? item.taskId } : {}) });
    }
    return [...result.values()];
}
const pendingEdited = (records: CanvasPlatformImageRequest[]) => records.map(item => item.taskId ? item : { ...item, edited: true });
function inputSignature(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const source = nodes.find(node => node.id === nodeId), metadata = source?.metadata;
    // The Text context chooses one Config edge. Image qualification also rejects
    // ambiguous outgoing Config edges and unsupported edit/mask input, so retain
    // their full raw identity here even when that context would ignore them.
    const outgoing = connections.filter(edge => edge.fromNodeId === nodeId && nodes.some(node => node.id === edge.toNodeId && node.type === CanvasNodeType.Config));
    const configIds = new Set(outgoing.map(edge => edge.toNodeId));
    const relevantEdges = connections.filter(edge => outgoing.includes(edge) || edge.toNodeId === nodeId || configIds.has(edge.toNodeId));
    const ids = new Set([nodeId, ...configIds, ...relevantEdges.map(edge => edge.fromNodeId),
        ...Array.from((metadata?.composerContent ?? metadata?.prompt ?? "").matchAll(/@\[node:([^\]]+)\]/g), match => match[1])]);
    const groups = new Set(nodes.filter(node => ids.has(node.id) && node.type === CanvasNodeType.Group).map(node => node.id));
    for (const node of nodes) if (groups.has(node.metadata?.groupId ?? "")) ids.add(node.id);
    return JSON.stringify({
        context: platformTextInputSignature({ sourceNodeId: nodeId, draftPrompt: metadata?.composerContent ?? metadata?.prompt ?? "", nodes, connections,
            settings: { model: metadata?.model ?? "", reasoningEffort: metadata?.reasoningEffort ?? "auto", systemPrompt: "" } }),
        relevantEdges,
        inputs: nodes.filter(node => ids.has(node.id)).map(node => ({ id: node.id, type: node.type, title: node.title, groupId: node.metadata?.groupId,
            content: node.metadata?.content, prompt: node.metadata?.prompt, composerContent: node.metadata?.composerContent,
            generationMode: node.metadata?.generationMode, generationType: node.metadata?.generationType, references: node.metadata?.references,
            mask: (node.metadata as Record<string, unknown> | undefined)?.mask, maskDataUrl: (node.metadata as Record<string, unknown> | undefined)?.maskDataUrl,
            maskUrl: (node.metadata as Record<string, unknown> | undefined)?.maskUrl })),
        source: source && { type: source.type, content: metadata?.content ?? "", cloudMediaId: metadata?.cloudMediaId, storageKey: metadata?.storageKey,
            naturalWidth: metadata?.naturalWidth, naturalHeight: metadata?.naturalHeight, bytes: metadata?.bytes, mimeType: metadata?.mimeType,
            primaryImageId: metadata?.primaryImageId, images: metadata?.images?.map(image => ({ id: image.id, content: image.content, cloudMediaId: image.cloudMediaId, storageKey: image.storageKey,
                naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, bytes: image.bytes, mimeType: image.mimeType })),
            model: metadata?.model, size: metadata?.size, quality: metadata?.quality, background: metadata?.background, count: metadata?.count, references: metadata?.references,
            platformImageSelection: metadata?.platformImageSelection },
    });
}

/** The caller has validated the full request; existing content is registered only for explicit new placement. */
export function registerImageTarget(nodes: CanvasNodeData[], target: ImageTargetBinding): { nodes: CanvasNodeData[]; nodeId?: string; status: "registered" | "protected"; reason?: ImageTargetProtectionReason } {
    const protect = (reason: ImageTargetProtectionReason) => ({ nodes, status: "protected" as const, reason });
    if (!validImageTarget(target)) return protect("invalid-target");
    const sources = nodes.filter(node => node.id === target.nodeId), source = sources.find(() => true);
    if (sources.length > 1) return protect("invalid-target");
    if (!source) return protect("missing-node");
    if (!matchesSource(source, target)) return protect("invalid-source");
    const records = imageTargetRequests(source);
    if (!records) return protect("invalid-records");
    const previous = records.find(item => item.guardId === target.guardId.toLowerCase());
    if (previous?.taskId) return protect("already-used");
    if (previous?.edited) return protect("edited");
    if (previous) return { nodes, nodeId: source.id, status: "registered" };
    const next = withRecords(source, [...records, { guardId: target.guardId.toLowerCase(), edited: false }]);
    return { nodes: nodes.map(node => node === source ? next : node), nodeId: source.id, status: "registered" };
}
export function stripImageTarget(node: CanvasNodeData): CanvasNodeData {
    if (!node.metadata || !Object.hasOwn(node.metadata, "platformImageRequests")) return node;
    const { platformImageRequests: _records, ...metadata } = node.metadata;
    return { ...node, metadata };
}
/** Body swaps and actual input graph changes latch edits; geometry and status changes do not. */
export function protectImageTargetChanges(previous: CanvasNodeData[], next: CanvasNodeData[], previousConnections: CanvasConnection[], nextConnections: CanvasConnection[], cache?: ImageTargetHistoryCache): CanvasNodeData[] {
    const old = new Map(previous.map(node => [node.id, node]));
    let changed = false;
    const protectedNodes = next.map(node => {
        const before = old.get(node.id), restored = !before && cache?.has(node.id) === true;
        const previousRecords = before ? imageTargetRequests(before) : [], stored = cache?.has(node.id) ? parsePlatformImageRequests(cache.get(node.id)) : [], proposed = imageTargetRequests(node);
        if (!previousRecords || !stored || !proposed) throw invalidRecords();
        const prior = mergeRecords(stored, previousRecords);
        let records = mergeRecords(prior, proposed);
        const lostGuard = prior.some(item => !proposed.some(record => record.guardId === item.guardId));
        if (restored || lostGuard || before && records.some(item => !item.taskId) && inputSignature(node.id, previous, previousConnections) !== inputSignature(node.id, next, nextConnections)) records = pendingEdited(records);
        const result = withRecords(node, records); changed ||= result !== node; return result;
    });
    return changed ? protectedNodes : next;
}
export function rememberImageTargets(nodes: CanvasNodeData[], cache: ImageTargetHistoryCache = new Map()): Map<string, CanvasPlatformImageRequest[]> {
    const next = new Map<string, CanvasPlatformImageRequest[]>();
    for (const [nodeId, value] of cache) { const records = parsePlatformImageRequests(value); if (!records) throw invalidRecords(); next.set(nodeId, records); }
    for (const node of nodes) { const records = imageTargetRequests(node); if (!records) throw invalidRecords(); if (records.length) next.set(node.id, mergeRecords(next.get(node.id) ?? [], records)); }
    return next;
}
export function mergeImageTargetHistory(previous: CanvasNodeData[], next: CanvasNodeData[], previousConnections: CanvasConnection[], nextConnections: CanvasConnection[], cache: ImageTargetHistoryCache = new Map()) {
    const remembered = rememberImageTargets(next, rememberImageTargets(previous, cache));
    const nodes = protectImageTargetChanges(previous, next, previousConnections, nextConnections, remembered);
    return { nodes, cache: rememberImageTargets(nodes, remembered) };
}
/** Explicit source/global changes invalidate pending authority, not the ordinary initial project restore. */
export function blockPendingImageTargets(nodes: CanvasNodeData[]): CanvasNodeData[] {
    let changed = false;
    const next = nodes.map(node => { const records = imageTargetRequests(node); if (!records) throw invalidRecords(); const result = withRecords(node, pendingEdited(records)); changed ||= result !== node; return result; });
    return changed ? next : nodes;
}
function imageResultPosition(nodes: CanvasNodeData[], preferred: Position, width: number, height: number): Position {
    let y = preferred.y;
    const column = nodes.filter(node => node.position.x < preferred.x + width && node.position.x + node.width > preferred.x).sort((left, right) => left.position.y - right.position.y);
    for (const node of column) if (node.position.y < y + height && node.position.y + node.height > y) y = node.position.y + node.height + 24;
    return { x: preferred.x, y };
}

/** Atomic patch only. The page claims the receipt, re-reads latest refs, commits/flushes, then completes it. */
export function applyImageTargetResult(nodes: CanvasNodeData[], connections: CanvasConnection[], result: ImageTargetResult, center: Position,
    destination: "original" | "linked" | "new", cache: ImageTargetHistoryCache = new Map()): ImageTargetApplication {
    const protect = (reason: ImageTargetProtectionReason): ImageTargetApplication => ({ nodes, connections, status: "protected", reason });
    if (!plain(result)) return protect("invalid-result");
    if (!["original", "linked", "new"].includes(destination) || result.target !== undefined && !validImageTarget(result.target)) return protect("invalid-target");
    if (!uuid(result.taskId) || !uuid(result.cloudMediaId) || typeof result.url !== "string" || !result.url || result.mimeType !== "image/png" ||
        ![result.width, result.height, result.bytes].every(value => Number.isSafeInteger(value) && value > 0)) return protect("invalid-result");
    if (result.images !== undefined && (!Array.isArray(result.images) || result.images.length < 2 || result.images.length > 10 ||
        result.images.some(image => !plain(image) || !uuid(image.cloudMediaId) || !image.url || typeof image.url !== "string" || image.mimeType !== "image/png" ||
            ![image.width, image.height, image.bytes].every(value => Number.isSafeInteger(value) && value > 0)) ||
        new Set(result.images.map(image => image.cloudMediaId)).size !== result.images.length ||
        (["cloudMediaId", "url", "width", "height", "bytes", "mimeType"] as const).some(key => result.images![0]![key] !== result[key]))) return protect("invalid-result");
    const taskId = result.taskId.toLowerCase(), nodeId = `platform-image-${taskId}`, connectionId = `platform-image-config-link-${taskId}`;
    let remembered: Map<string, CanvasPlatformImageRequest[]>;
    try { remembered = rememberImageTargets(nodes, cache); } catch { return protect("invalid-records"); }
    const appliedNode = nodes.find(node => imageTargetRequests(node)!.some(item => item.taskId === taskId));
    if ([...remembered.values()].some(records => records.some(item => item.taskId === taskId))) return { nodes, connections, ...(appliedNode ? { nodeId: appliedNode.id } : {}), status: "already-applied" };
    const existingNodes = nodes.filter(node => node.id.toLowerCase() === nodeId), existingConnections = connections.filter(edge => edge.id.toLowerCase() === connectionId);
    if (existingNodes.length || existingConnections.length) {
        if (existingNodes.length !== 1 || existingNodes.some(node => node.type !== CanvasNodeType.Image) || existingConnections.length > 1 ||
            existingConnections.some(edge => edge.fromNodeId !== result.target?.nodeId || edge.toNodeId.toLowerCase() !== nodeId)) return protect("occupied-result");
        return { nodes, connections, nodeId: existingNodes.find(() => true)!.id, status: "already-applied" };
    }
    const target = result.target, sources = target ? nodes.filter(node => node.id === target.nodeId) : [], source = sources.find(() => true);
    if (sources.length > 1) return protect("invalid-target");
    const records = source ? remembered.get(source.id) ?? imageTargetRequests(source)! : [], guard = target ? records.find(item => item.guardId === target.guardId.toLowerCase()) : undefined;
    if (guard?.taskId) return protect("already-used");
    if (destination !== "new") {
        if (!target) return protect("invalid-target");
        if (!source) return protect("missing-node");
        if (!matchesSource(source, target) || destination === "original" && target.sourceType !== "image" || destination === "linked" && target.sourceType !== "config") return protect("invalid-source");
        if (!guard) return protect("missing-guard");
        if (guard.edited) return protect("edited");
        if (destination === "original" && !isEmptyImageTarget(source)) return protect("occupied-node");
    }
    const mark = (node: CanvasNodeData) => withRecords(node, records.map(item => item.guardId === guard!.guardId ? { ...item, taskId } : item));
    const media = { content: result.url, cloudMediaId: result.cloudMediaId, naturalWidth: result.width, naturalHeight: result.height, bytes: result.bytes, mimeType: result.mimeType, status: "success" as const,
        ...(result.images ? { primaryImageId: result.cloudMediaId, images: result.images.map(image => ({ id: image.cloudMediaId, status: "success" as const,
            content: image.url, cloudMediaId: image.cloudMediaId, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType })) } : {}) };
    if (destination === "original") {
        const marked = mark(source!), filled = { ...marked, metadata: { ...marked.metadata, ...media, errorDetails: undefined } };
        return { nodes: nodes.map(node => node === source ? filled : node), connections, nodeId: source!.id, status: "filled-original" };
    }
    const size = fitNodeSize(result.width, result.height), created = createCanvasNode(CanvasNodeType.Image, center, media);
    const preferred = destination === "linked" && source ? { x: source.position.x + source.width + 96, y: source.position.y + source.height / 2 - size.height / 2 } : { x: center.x - size.width / 2, y: center.y - size.height / 2 };
    const node = { ...created, id: nodeId, title: "平台生成图片", ...size, position: imageResultPosition(nodes, preferred, size.width, size.height) };
    const next = [...nodes.map(node => node === source && guard && target && matchesSource(node, target) ? mark(node) : node), node];
    return { nodes: next, connections: destination === "linked" ? [...connections, { id: connectionId, fromNodeId: source!.id, toNodeId: nodeId }] : connections,
        nodeId, ...(destination === "linked" ? { connectionId } : {}), status: destination === "linked" ? "added-linked" : "saved-new" };
}
