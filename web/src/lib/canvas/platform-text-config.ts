import type { TextConfigBinding } from "../../services/saas/canvas-text-receipt";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasPlatformTextConfigRequest, type Position } from "../../types/canvas";
import { createCanvasNode } from "./canvas-node-factory";
import { platformTextInputSignature } from "./platform-text-input";
import { parsePlatformTextRequests } from "./platform-text-target";

export type TextConfigHistoryCache = ReadonlyMap<string, readonly CanvasPlatformTextConfigRequest[]>;
export type TextConfigProtectionReason = "invalid-target" | "invalid-records" | "missing-node" | "missing-guard" | "invalid-source" | "edited" | "already-used" | "invalid-result" | "occupied-result";
type ConfigRecords = CanvasPlatformTextConfigRequest[];
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ownData = (value: object, key: string) => { const entry = Object.getOwnPropertyDescriptor(value, key); return entry?.enumerable && Object.hasOwn(entry, "value") ? entry.value : undefined; };
const invalidRecords = () => new Error("文本配置任务关联无法核对，请保留原任务回执。");

/** Reuse the exact JSON record grammar, never the F1 target's write permission. */
export const parsePlatformTextConfigRequests = (value: unknown): ConfigRecords | null => parsePlatformTextRequests(value);
export function validTextConfigTarget(target: TextConfigBinding): boolean {
    return plain(target) && Reflect.ownKeys(target).length === 3 && Reflect.ownKeys(target).every(key => typeof key === "string" && ["schemaVersion", "nodeId", "guardId"].includes(key)) &&
        ownData(target, "schemaVersion") === 1 && typeof ownData(target, "nodeId") === "string" && target.nodeId.length > 0 && target.nodeId.trim() === target.nodeId &&
        !/[\u0000-\u001f\u007f]/.test(target.nodeId) && uuid(ownData(target, "guardId"));
}
export function textConfigRequests(node: CanvasNodeData): ConfigRecords | null {
    return node.metadata && Object.hasOwn(node.metadata, "platformTextConfigRequests") ? parsePlatformTextConfigRequests(node.metadata.platformTextConfigRequests) : [];
}
function mergeRecords(left: readonly CanvasPlatformTextConfigRequest[], right: readonly CanvasPlatformTextConfigRequest[]): ConfigRecords {
    const result = new Map<string, CanvasPlatformTextConfigRequest>();
    for (const list of [left, right]) for (const record of list) {
        const before = result.get(record.guardId);
        if (before?.taskId && record.taskId && before.taskId !== record.taskId) throw invalidRecords();
        result.set(record.guardId, { guardId: record.guardId, edited: !!before?.edited || record.edited,
            ...(before?.taskId || record.taskId ? { taskId: before?.taskId ?? record.taskId } : {}) });
    }
    return [...result.values()];
}
function withRecords(node: CanvasNodeData, records: ConfigRecords): CanvasNodeData {
    const previous = node.metadata?.platformTextConfigRequests;
    return previous?.length === records.length && previous.every((record, index) => record.guardId === records[index].guardId && record.edited === records[index].edited && record.taskId === records[index].taskId) ||
        !records.length && !Object.hasOwn(node.metadata ?? {}, "platformTextConfigRequests")
        ? node : { ...node, metadata: { ...node.metadata, platformTextConfigRequests: records } };
}
const pendingEdited = (records: ConfigRecords) => records.map(record => record.taskId ? record : { ...record, edited: true });
function inputSignature(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const node = nodes.find(item => item.id === nodeId);
    return platformTextInputSignature({ sourceNodeId: nodeId, draftPrompt: node?.metadata?.composerContent ?? node?.metadata?.prompt ?? "", nodes, connections,
        settings: { model: node?.metadata?.model ?? "", reasoningEffort: node?.metadata?.reasoningEffort ?? "auto", systemPrompt: "" } });
}

/** Called only after the page has revalidated the complete Config request preview. */
export function registerConfigTarget(nodes: CanvasNodeData[], target: TextConfigBinding): { nodes: CanvasNodeData[]; nodeId?: string; status: "registered" | "protected"; reason?: TextConfigProtectionReason } {
    const protect = (reason: TextConfigProtectionReason) => ({ nodes, status: "protected" as const, reason });
    if (!validTextConfigTarget(target)) return protect("invalid-target");
    const matches = nodes.filter(node => node.id === target.nodeId), source = matches[0];
    if (matches.length > 1) return protect("invalid-target");
    if (!source) return protect("missing-node");
    const records = textConfigRequests(source);
    if (!records) return protect("invalid-records");
    const previous = records.find(record => record.guardId === target.guardId.toLowerCase());
    if (previous?.taskId) return protect("already-used");
    if (previous?.edited) return protect("edited");
    if (source.type !== CanvasNodeType.Config || source.metadata?.generationMode !== "text" || (source.metadata?.textCount ?? 1) !== 1) return protect("invalid-source");
    if (previous) return { nodes, nodeId: source.id, status: "registered" };
    const next = withRecords(source, [...records, { guardId: target.guardId.toLowerCase(), edited: false }]);
    return { nodes: nodes.map(node => node === source ? next : node), nodeId: source.id, status: "registered" };
}

/** A copy owns its content, not another Config request's authority or applied-task marker. */
export function stripTextConfigTarget(node: CanvasNodeData): CanvasNodeData {
    if (!node.metadata || !Object.hasOwn(node.metadata, "platformTextConfigRequests")) return node;
    const { platformTextConfigRequests: _records, ...metadata } = node.metadata;
    return { ...node, metadata };
}

/** Ordinary node/connection edits latch changes to the captured source and its actual input graph. */
export function protectTextConfigChanges(previous: CanvasNodeData[], next: CanvasNodeData[], previousConnections: CanvasConnection[], nextConnections: CanvasConnection[], cache?: TextConfigHistoryCache): CanvasNodeData[] {
    const old = new Map(previous.map(node => [node.id, node]));
    let changed = false;
    const protectedNodes = next.map(node => {
        const before = old.get(node.id), restored = !before && cache?.has(node.id) === true;
        const prior = before ? textConfigRequests(before) : restored ? parsePlatformTextConfigRequests(cache!.get(node.id)) : [], proposed = textConfigRequests(node);
        if (!prior || !proposed) throw invalidRecords();
        let records = mergeRecords(prior, proposed);
        const lostGuard = prior.some(record => !proposed.some(item => item.guardId === record.guardId));
        if (restored || lostGuard || before && records.some(record => !record.taskId) && inputSignature(node.id, previous, previousConnections) !== inputSignature(node.id, next, nextConnections)) records = pendingEdited(records);
        const result = withRecords(node, records);
        changed ||= result !== node;
        return result;
    });
    return changed ? protectedNodes : next;
}

/** The page scopes this monotonic cache to one project/mount; the input cache is never mutated. */
export function rememberTextConfigTargets(nodes: CanvasNodeData[], cache: TextConfigHistoryCache = new Map()): Map<string, ConfigRecords> {
    const next = new Map<string, ConfigRecords>();
    for (const [nodeId, value] of cache) {
        const records = parsePlatformTextConfigRequests(value);
        if (!records) throw invalidRecords();
        next.set(nodeId, records);
    }
    for (const node of nodes) {
        const records = textConfigRequests(node);
        if (!records) throw invalidRecords();
        if (records.length) next.set(node.id, mergeRecords(next.get(node.id) ?? [], records));
    }
    return next;
}
export function mergeTextConfigHistory(previous: CanvasNodeData[], next: CanvasNodeData[], previousConnections: CanvasConnection[], nextConnections: CanvasConnection[], cache: TextConfigHistoryCache = new Map()) {
    const remembered = rememberTextConfigTargets(next, rememberTextConfigTargets(previous, cache));
    const nodes = protectTextConfigChanges(previous, next, previousConnections, nextConnections, remembered);
    return { nodes, cache: rememberTextConfigTargets(nodes, remembered) };
}
/** Document replacement and explicit global-setting invalidation never inherit pending Config authority. */
export function blockPendingTextConfigTargets(nodes: CanvasNodeData[]): CanvasNodeData[] {
    let changed = false;
    const blocked = nodes.map(node => {
        const records = textConfigRequests(node);
        if (!records) throw invalidRecords();
        const result = withRecords(node, pendingEdited(records));
        changed ||= result !== node;
        return result;
    });
    return changed ? blocked : nodes;
}
export const blockTextConfigTargetsForMount = blockPendingTextConfigTargets;

export type TextConfigApplication = {
    nodes: CanvasNodeData[]; connections: CanvasConnection[]; nodeId?: string; connectionId?: string;
    status: "added-linked" | "saved-new" | "already-applied" | "protected"; reason?: TextConfigProtectionReason;
};

function textConfigResultPosition(nodes: CanvasNodeData[], preferred: Position, width: number, height: number): Position {
    let y = preferred.y;
    const column = nodes.filter(node => node.position.x < preferred.x + width && node.position.x + node.width > preferred.x)
        .sort((left, right) => left.position.y - right.position.y);
    // Keep the preferred column and pass each occupied rectangle once, using the canvas's existing 24px result gap.
    for (const node of column) {
        if (node.position.y < y + height && node.position.y + node.height > y) y = node.position.y + node.height + 24;
    }
    return { x: preferred.x, y };
}

/** Returns one atomic canvas patch. The page must claim the receipt before committing it and flush before completing it. */
export function applyTextConfigResult(nodes: CanvasNodeData[], connections: CanvasConnection[], result: { taskId: string; text: string; target: TextConfigBinding }, center: Position,
    destination: "linked" | "new", cache: TextConfigHistoryCache = new Map()): TextConfigApplication {
    const protect = (reason: TextConfigProtectionReason): TextConfigApplication => ({ nodes, connections, status: "protected", reason });
    if (!validTextConfigTarget(result.target) || destination !== "linked" && destination !== "new") return protect("invalid-target");
    if (!uuid(result.taskId) || typeof result.text !== "string" || !result.text.trim()) return protect("invalid-result");
    const taskId = result.taskId.toLowerCase(), nodeId = `platform-text-${taskId}`, connectionId = `platform-text-config-link-${taskId}`;
    let remembered: Map<string, ConfigRecords>;
    try { remembered = rememberTextConfigTargets(nodes, cache); } catch { return protect("invalid-records"); }
    if ([...remembered.values()].some(records => records.some(record => record.taskId === taskId))) return { nodes, connections, nodeId, connectionId, status: "already-applied" };
    const existingNodes = nodes.filter(node => node.id.toLowerCase() === nodeId), existingConnections = connections.filter(connection => connection.id.toLowerCase() === connectionId);
    if (existingNodes.length || existingConnections.length) {
        if (existingNodes.length > 1 || existingNodes.some(node => node.type !== CanvasNodeType.Text) || existingConnections.length > 1 ||
            existingConnections.some(connection => connection.fromNodeId !== result.target.nodeId || connection.toNodeId.toLowerCase() !== nodeId)) return protect("occupied-result");
        return { nodes, connections, nodeId, connectionId, status: "already-applied" };
    }
    const matches = nodes.filter(node => node.id === result.target.nodeId), source = matches[0];
    if (matches.length > 1) return protect("invalid-target");
    const records = source ? textConfigRequests(source)! : [], guard = records.find(record => record.guardId === result.target.guardId.toLowerCase());
    if (guard?.taskId) return protect("already-used");
    if (destination === "linked") {
        if (!source) return protect("missing-node");
        if (!guard) return protect("missing-guard");
        if (guard.edited) return protect("edited");
        if (source.type !== CanvasNodeType.Config || source.metadata?.generationMode !== "text" || (source.metadata?.textCount ?? 1) !== 1) return protect("invalid-source");
    }
    const created = createCanvasNode(CanvasNodeType.Text, center, { content: result.text, status: "success" });
    const preferred = destination === "linked" && source
        ? { x: source.position.x + source.width + 96, y: source.position.y + source.height / 2 - created.height / 2 } : created.position;
    const node = { ...created, id: nodeId, title: "平台生成文本", position: textConfigResultPosition(nodes, preferred, created.width, created.height) };
    const next = [...nodes.map(item => item === source && guard ? withRecords(item, records.map(record => record.guardId === guard.guardId ? { ...record, taskId } : record)) : item), node];
    return { nodes: next, connections: destination === "linked" ? [...connections, { id: connectionId, fromNodeId: source!.id, toNodeId: nodeId }] : connections,
        nodeId, ...(destination === "linked" ? { connectionId } : {}), status: destination === "linked" ? "added-linked" : "saved-new" };
}
