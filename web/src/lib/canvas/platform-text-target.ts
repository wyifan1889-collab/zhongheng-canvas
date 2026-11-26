import type { TextTargetBinding } from "../../services/saas/canvas-text-receipt";
import { CanvasNodeType, type CanvasNodeData, type CanvasPlatformTextRequest } from "../../types/canvas";

export type TextTargetHistoryCache = ReadonlyMap<string, readonly CanvasPlatformTextRequest[]>;
export type TextTargetProtectionReason = "invalid-target" | "invalid-records" | "missing-node" | "missing-guard" | "occupied-node" | "edited" | "already-used";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const ownData = (value: object, key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
};
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null &&
    !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalidRecords = () => new Error("文本回填关联无法核对，请保留原任务回执。");

/** Reserved metadata is exact JSON, not a plugin extension or a place for output text. */
export function parsePlatformTextRequests(value: unknown): CanvasPlatformTextRequest[] | null {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return null;
    const result: CanvasPlatformTextRequest[] = [], ids = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const item = ownData(value, String(index));
        if (!plain(item)) return null;
        const guardId = ownData(item, "guardId"), edited = ownData(item, "edited"), hasTask = Object.hasOwn(item, "taskId"), taskId = ownData(item, "taskId");
        const keys = Reflect.ownKeys(item);
        if (keys.length !== (hasTask ? 3 : 2) || keys.some(key => typeof key !== "string" || !["guardId", "edited", "taskId"].includes(key)) ||
            !uuid(guardId) || typeof edited !== "boolean" || hasTask && !uuid(taskId) || ids.has(guardId.toLowerCase())) return null;
        ids.add(guardId.toLowerCase());
        result.push({ guardId: guardId.toLowerCase(), edited, ...(hasTask ? { taskId: (taskId as string).toLowerCase() } : {}) });
    }
    return result;
}

export function validTextTarget(target: TextTargetBinding): boolean {
    return plain(target) && Reflect.ownKeys(target).length === 3 && Reflect.ownKeys(target).every(key => typeof key === "string" && ["schemaVersion", "nodeId", "guardId"].includes(key)) &&
        ownData(target, "schemaVersion") === 1 && typeof ownData(target, "nodeId") === "string" && target.nodeId.length > 0 && target.nodeId.trim() === target.nodeId &&
        !/[\u0000-\u001f\u007f]/.test(target.nodeId) && uuid(ownData(target, "guardId"));
}

export function textTargetRequests(node: CanvasNodeData): CanvasPlatformTextRequest[] | null {
    return node.metadata && Object.hasOwn(node.metadata, "platformTextRequests") ? parsePlatformTextRequests(node.metadata.platformTextRequests) : [];
}

function sameRequests(left: readonly CanvasPlatformTextRequest[] | undefined, right: readonly CanvasPlatformTextRequest[]) {
    return !!left && left.length === right.length && left.every((item, index) => item.guardId === right[index].guardId && item.edited === right[index].edited && item.taskId === right[index].taskId);
}
function withRequests(node: CanvasNodeData, requests: CanvasPlatformTextRequest[]) {
    return sameRequests(node.metadata?.platformTextRequests, requests) || !requests.length && !Object.hasOwn(node.metadata ?? {}, "platformTextRequests")
        ? node : { ...node, metadata: { ...node.metadata, platformTextRequests: requests } };
}
function mergeRequests(left: readonly CanvasPlatformTextRequest[], right: readonly CanvasPlatformTextRequest[]): CanvasPlatformTextRequest[] {
    const records = new Map<string, CanvasPlatformTextRequest>();
    for (const group of [left, right]) for (const item of group) {
        const previous = records.get(item.guardId);
        if (previous?.taskId && item.taskId && previous.taskId !== item.taskId) throw invalidRecords();
        records.set(item.guardId, { guardId: item.guardId, edited: !!previous?.edited || item.edited,
            ...(previous?.taskId || item.taskId ? { taskId: previous?.taskId ?? item.taskId } : {}) });
    }
    return [...records.values()];
}

/** Binding never clears a prior edit or an applied task, including when a receipt is reopened. */
export function registerTarget(nodes: CanvasNodeData[], target: TextTargetBinding): { nodes: CanvasNodeData[]; nodeId?: string; status: "registered" | "protected"; reason?: TextTargetProtectionReason } {
    const protect = (reason: TextTargetProtectionReason) => ({ nodes, status: "protected" as const, reason });
    if (!validTextTarget(target)) return protect("invalid-target");
    const sources = nodes.filter(node => node.id === target.nodeId), source = sources[0];
    if (sources.length > 1) return protect("invalid-target");
    if (!source) return protect("missing-node");
    const requests = textTargetRequests(source);
    if (!requests) return protect("invalid-records");
    const existing = requests.find(item => item.guardId === target.guardId.toLowerCase());
    if (existing?.taskId) return protect("already-used");
    if (existing?.edited) return protect("edited");
    if (source.type !== CanvasNodeType.Text || (source.metadata?.content ?? "") !== "" || source.metadata?.texts?.length) return protect("occupied-node");
    if (existing) return { nodes, nodeId: source.id, status: "registered" };
    const next = withRequests(source, [...requests, { guardId: target.guardId.toLowerCase(), edited: false }]);
    return { nodes: nodes.map(node => node === source ? next : node), nodeId: source.id, status: "registered" };
}

/** Copies retain content without inheriting the original receipt's authority. */
export function stripTarget(node: CanvasNodeData): CanvasNodeData {
    if (!node.metadata || !Object.hasOwn(node.metadata, "platformTextRequests")) return node;
    const { platformTextRequests: _requests, ...metadata } = node.metadata;
    return { ...node, metadata };
}

function sameBody(left: CanvasNodeData, right: CanvasNodeData) {
    const a = left.metadata, b = right.metadata, aTexts = a?.texts ?? [], bTexts = b?.texts ?? [];
    return left.type === right.type && (a?.content ?? "") === (b?.content ?? "") && a?.primaryTextId === b?.primaryTextId && aTexts.length === bTexts.length &&
        aTexts.every((item, index) => item.id === bTexts[index].id && item.content === bTexts[index].content);
}

/** Used for ordinary edits, agent/plugin patches and legacy generation; mounts deliberately bypass it. */
export function protectTextNodeChanges(previous: CanvasNodeData[], next: CanvasNodeData[], cache?: TextTargetHistoryCache): CanvasNodeData[] {
    const old = new Map(previous.map(node => [node.id, node]));
    let changed = false;
    const protectedNodes = next.map(node => {
        const before = old.get(node.id), restored = !before && cache?.has(node.id) === true;
        const prior = before ? textTargetRequests(before) : restored ? parsePlatformTextRequests(cache!.get(node.id)) : [], proposed = textTargetRequests(node);
        if (!prior || !proposed) throw invalidRecords();
        let requests = mergeRequests(prior, proposed);
        if (restored || before && !sameBody(before, node)) requests = requests.map(item => item.taskId ? item : { ...item, edited: true });
        const result = withRequests(node, requests);
        changed ||= result !== node;
        return result;
    });
    return changed ? protectedNodes : next;
}

/** The caller owns this cache's project/mount lifetime; no input map or node is mutated. */
export function rememberTextTargets(nodes: CanvasNodeData[], cache: TextTargetHistoryCache = new Map()): Map<string, CanvasPlatformTextRequest[]> {
    const next = new Map<string, CanvasPlatformTextRequest[]>();
    for (const [nodeId, stored] of cache) {
        const requests = parsePlatformTextRequests(stored);
        if (!requests) throw invalidRecords();
        next.set(nodeId, requests);
    }
    for (const node of nodes) {
        const requests = textTargetRequests(node);
        if (!requests) throw invalidRecords();
        if (requests.length) next.set(node.id, mergeRequests(next.get(node.id) ?? [], requests));
    }
    return next;
}

/** Only body changes and restored/deleted nodes invalidate a pending target during undo/redo. */
export function mergeTextTargetHistory(previous: CanvasNodeData[], next: CanvasNodeData[], cache: TextTargetHistoryCache = new Map()) {
    const remembered = rememberTextTargets(next, rememberTextTargets(previous, cache)), old = new Map(previous.map(node => [node.id, node]));
    const nodes = next.map(node => {
        const requests = remembered.get(node.id), before = old.get(node.id);
        const bodyChanged = !before || !sameBody(before, node);
        return requests ? withRequests(node, requests.map(item => bodyChanged && !item.taskId ? { ...item, edited: true } : item)) : node;
    });
    return { nodes, cache: rememberTextTargets(nodes, remembered) };
}

/** A document replacement never inherits pending write permission, even with matching IDs and guards. */
export function blockTextTargetsForMount(nodes: CanvasNodeData[]): CanvasNodeData[] {
    let changed = false;
    const blocked = nodes.map(node => {
        const requests = textTargetRequests(node);
        if (!requests) throw invalidRecords();
        const result = withRequests(node, requests.map(item => item.taskId ? item : { ...item, edited: true }));
        changed ||= result !== node;
        return result;
    });
    return changed ? blocked : nodes;
}
