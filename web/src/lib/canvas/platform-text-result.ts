import { createCanvasNode } from "./canvas-node-factory";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import type { TextTargetBinding } from "../../services/saas/canvas-text-receipt";
import { textTargetRequests, validTextTarget, type TextTargetProtectionReason } from "./platform-text-target";

export type PlatformTextApplication = {
    nodes: CanvasNodeData[];
    nodeId?: string;
    status: "filled" | "saved-new" | "already-applied" | "protected";
    reason?: TextTargetProtectionReason | "invalid-result";
};

/** A task always maps to one original Text node. Reopening a receipt preserves edits to that node. */
export function appendPlatformTextResult(nodes: CanvasNodeData[], result: { taskId: string; text: string }, center: Position) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.taskId) || !result.text.trim()) throw new Error("文本结果无效，请核对原任务。");
    const nodeId = `platform-text-${result.taskId}`;
    if (nodes.some(node => node.id === nodeId)) return { nodes, nodeId, inserted: false };
    const node = { ...createCanvasNode(CanvasNodeType.Text, center, { content: result.text, status: "success" }), id: nodeId, title: "平台生成文本" };
    return { nodes: [...nodes, node], nodeId, inserted: true };
}

/** A receipt's original target is immutable. A protected target never falls back to a new node. */
export function applyResult(nodes: CanvasNodeData[], result: { taskId: string; text: string; target?: TextTargetBinding }, center: Position, destination: "original" | "new"): PlatformTextApplication {
    const protect = (reason: PlatformTextApplication["reason"]): PlatformTextApplication => ({ nodes, status: "protected", reason });
    if (destination !== "original" && destination !== "new") return protect("invalid-target");
    if (typeof result.taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.taskId) ||
        typeof result.text !== "string" || !result.text.trim()) return protect("invalid-result");
    if (result.target !== undefined && !validTextTarget(result.target)) return protect("invalid-target");
    const taskId = result.taskId.toLowerCase(), records = new Map(nodes.map(node => [node, textTargetRequests(node)]));
    if ([...records.values()].some(value => value === null)) return protect("invalid-records");
    const applied = nodes.find(node => node.id.toLowerCase() === `platform-text-${taskId}` || records.get(node)!.some(item => item.taskId === taskId));
    if (applied) return { nodes, nodeId: applied.id, status: "already-applied" };
    const target = result.target, sources = target ? nodes.filter(node => node.id === target.nodeId) : [];
    if (sources.length > 1) return protect("invalid-target");
    const source = sources[0], requests = source ? records.get(source)! : [], guard = target ? requests.find(item => item.guardId === target.guardId.toLowerCase()) : undefined;
    if (guard?.taskId) return protect("already-used");
    const markApplied = (node: CanvasNodeData): CanvasNodeData => ({ ...node, metadata: { ...node.metadata,
        platformTextRequests: requests.map(item => item.guardId === guard!.guardId ? { ...item, taskId } : item) } });
    if (destination === "original") {
        if (!target) return protect("invalid-target");
        if (!source) return protect("missing-node");
        if (!guard) return protect("missing-guard");
        if (guard.edited) return protect("edited");
        if (source.type !== CanvasNodeType.Text || (source.metadata?.content ?? "") !== "" || source.metadata?.texts?.length) return protect("occupied-node");
        const next = markApplied(source);
        const filled = { ...next, metadata: { ...next.metadata, content: result.text, status: "success" as const } };
        return { nodes: nodes.map(node => node === source ? filled : node), nodeId: source.id, status: "filled" };
    }
    const appended = appendPlatformTextResult(nodes, { taskId, text: result.text }, center);
    return { nodes: source && guard ? appended.nodes.map(node => node === source ? markApplied(node) : node) : appended.nodes,
        nodeId: appended.nodeId, status: "saved-new" };
}
