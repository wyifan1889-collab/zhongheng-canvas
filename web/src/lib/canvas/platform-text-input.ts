import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type PlatformTextPreviewInput = {
    sourceNodeId: string;
    draftPrompt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    settings: Pick<AiConfig, "model" | "reasoningEffort" | "systemPrompt">;
};
type Blocker = { reason: "invalid-source" | "invalid-token" | "missing-reference" | "empty-reference" | "unsupported-reference" | "unsupported-setting" | "empty-prompt"; nodeIds: string[]; message: string };
type Reference = { nodeId: string; title: string; groupId?: string; connectionId?: string; textField: "content" | "prompt"; text: string; included: boolean };
export type PlatformTextPreview = {
    sourceNodeId: string;
    rawPrompt: string;
    promptField: "composerContent" | "prompt" | "none";
    contextMode: "composer-tokens" | "all-upstream";
    references: readonly Reference[];
    localSettings: { model: string; systemPrompt: string; reasoningEffort: string; textCount: number };
} & ({ status: "ready"; prompt: string } | { status: "blocked"; candidatePrompt: string; blockers: readonly Blocker[] });

const tokenPattern = /@\[node:([^\]]+)\]/g;
const textOf = (node: CanvasNodeData) => node.metadata?.content || node.metadata?.prompt || "";
const fieldOf = (node: CanvasNodeData) => node.metadata?.content ? "content" as const : "prompt" as const;
const safeType = (node: CanvasNodeData) => (Object.values(CanvasNodeType) as string[]).includes(node.type);
const readableBuiltin = (node: CanvasNodeData) => node.type === CanvasNodeType.Text ? Boolean(textOf(node))
    : [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType) && Boolean(node.metadata?.content);

function readInputs(input: PlatformTextPreviewInput) {
    const source = input.nodes.find(node => node.id === input.sourceNodeId);
    // The original helper prefers another Config only when it has readable resources, then falls back to own inputs.
    const configEdge = input.connections.find(edge => edge.fromNodeId === input.sourceNodeId && input.nodes.find(node => node.id === edge.toNodeId)?.type === CanvasNodeType.Config);
    const ownEdges = input.connections.filter(edge => edge.toNodeId === input.sourceNodeId);
    const configEdges = configEdge ? input.connections.filter(edge => edge.toNodeId === configEdge.toNodeId && edge.fromNodeId !== input.sourceNodeId) : [];
    const usesConfig = configEdges.some(edge => {
        const node = input.nodes.find(item => item.id === edge.fromNodeId);
        return node && (readableBuiltin(node) || node.type === CanvasNodeType.Group && input.nodes.some(child => child.metadata?.groupId === node.id && readableBuiltin(child)));
    });
    const edges = usesConfig ? configEdges : ownEdges;
    // Retain invalid raw edges that the resource helper would filter before choosing its fallback.
    const diagnosticEdges = [...new Set(usesConfig ? edges : [...configEdges, ...ownEdges])];
    const tokenIds = Array.from(input.draftPrompt.matchAll(tokenPattern), match => match[1]);
    return { source, configEdge, edges, diagnosticEdges, tokenIds };
}

/** Transient comparison value, not a receipt/hash: geometry, status and unrelated nodes cannot invalidate a preview. */
export function platformTextInputSignature(input: PlatformTextPreviewInput): string {
    const { source, configEdge, edges, diagnosticEdges, tokenIds } = readInputs(input);
    const ids = new Set([input.sourceNodeId, configEdge?.toNodeId, ...diagnosticEdges.map(edge => edge.fromNodeId), ...tokenIds]);
    const groups = new Set(input.nodes.filter(node => ids.has(node.id) && node.type === CanvasNodeType.Group).map(node => node.id));
    // The validator checks all instances of a group child's ID, including those outside the group.
    for (const node of input.nodes) if (groups.has(node.metadata?.groupId ?? "")) ids.add(node.id);
    return JSON.stringify({
        sourceNodeId: input.sourceNodeId, draftPrompt: input.draftPrompt, settings: input.settings, configEdge, edges, diagnosticEdges,
        source: source && { type: source.type, generationMode: source.metadata?.generationMode, composerMode: Boolean(source.metadata?.composerContent?.trim()),
            promptField: source.metadata?.composerContent != null ? "composerContent" : source.metadata?.prompt != null ? "prompt" : "none",
            rawPrompt: source.metadata?.composerContent ?? source.metadata?.prompt ?? "", textCount: source.metadata?.textCount ?? 1, references: source.metadata?.references },
        nodes: input.nodes.filter(node => ids.has(node.id) || groups.has(node.metadata?.groupId ?? "")).map(node => ({
            id: node.id, type: node.type, title: node.title, groupId: node.metadata?.groupId,
            ...(node.type === CanvasNodeType.Text ? { text: textOf(node), textField: fieldOf(node) } : {}),
        })),
    }, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value);
}

/** Local-only preview. Diagnostics precede the original context builder; no media hydration or requests occur. */
export function buildPlatformTextPreview(input: PlatformTextPreviewInput): PlatformTextPreview {
    const { source, edges, diagnosticEdges, tokenIds } = readInputs(input), blockers: Blocker[] = [];
    const add = (reason: Blocker["reason"], nodeIds: string[], message: string) => { blockers.push({ reason, nodeIds, message }); };
    const composer = Boolean(source?.metadata?.composerContent?.trim());
    const selected = new Set(tokenIds), references = new Map<string, Reference>(), available = new Set<string>(), resourcesByInput = new Map<string, string[]>();
    if (!source || input.nodes.filter(node => node.id === input.sourceNodeId).length !== 1 || source.type !== CanvasNodeType.Config || source.metadata?.generationMode !== "text") {
        add("invalid-source", [input.sourceNodeId], "原文本配置节点不存在、编号重复或模式已变化，请重新打开预览。");
    }
    const textCount = source?.metadata?.textCount ?? 1;
    if (textCount !== 1) add("unsupported-setting", [input.sourceNodeId], "本次预览只支持一份文本，已保留原数量设置。");
    if (input.settings.systemPrompt.trim()) add("unsupported-setting", [input.sourceNodeId], "当前平台单 prompt 不支持全局系统提示词，未将其丢弃或拼入用户要求。");
    if (input.settings.reasoningEffort !== "auto") add("unsupported-setting", [input.sourceNodeId], "当前平台文本合同不支持该推理参数，已保留原设置。");
    if (source?.metadata?.references?.length) add("unsupported-reference", [input.sourceNodeId], "配置节点仍有媒体引用记录，本次纯文本预览不支持此输入。");

    const readText = (node: CanvasNodeData, connectionId: string, groupId: string | undefined, included: boolean) => {
        if (input.nodes.filter(item => item.id === node.id).length !== 1) add("missing-reference", [node.id], "引用节点编号重复，无法核对输入。");
        if (node.type !== CanvasNodeType.Text) { add("unsupported-reference", [node.id], "本次只支持原文本引用，媒体、配置和插件资源均未接入。"); return; }
        const text = textOf(node);
        if (!text.trim()) add("empty-reference", [node.id], "引用文本为空，未把它过滤后作为完整请求。");
        const previous = references.get(node.id);
        references.set(node.id, { nodeId: node.id, title: node.title, ...(groupId ? { groupId } : {}), connectionId,
            textField: fieldOf(node), text, included: included || !!previous?.included });
    };
    for (const edge of diagnosticEdges) {
        const node = input.nodes.find(item => item.id === edge.fromNodeId);
        if (!node) { add("missing-reference", [edge.fromNodeId], "原连线引用的节点已不存在，请修复连线后重新预览。"); continue; }
        const active = edges.includes(edge);
        if (active) available.add(node.id);
        const included = active && (!composer || selected.has(node.id));
        if (node.type === CanvasNodeType.Group) {
            const children = input.nodes.filter(child => child.metadata?.groupId === node.id);
            if (!children.length) add("empty-reference", [node.id], "引用组为空，未把它过滤后作为完整请求。");
            if (input.nodes.filter(item => item.id === node.id).length !== 1) add("missing-reference", [node.id], "引用组编号重复，无法核对输入。");
            children.forEach(child => readText(child, edge.id, node.id, included));
            if (active) resourcesByInput.set(node.id, children.filter(child => child.type === CanvasNodeType.Text).map(child => child.id));
        } else {
            readText(node, edge.id, undefined, included);
            if (active) resourcesByInput.set(node.id, [node.id]);
        }
    }
    if (input.draftPrompt.replace(tokenPattern, "").includes("@[node:") || tokenIds.some(id => id.trim() !== id || /[\[\u0000-\u001f\u007f]/.test(id))) {
        add("invalid-token", tokenIds, "引用标记格式不完整或编号无效，请在原编辑器修复。");
    }
    for (const id of new Set(tokenIds)) if (!available.has(id)) add("missing-reference", [id], "引用标记不属于当前可核对的入向节点或引用组。");
    if (!composer && tokenIds.length) add("invalid-token", tokenIds, "当前要求不是组合编辑模式，原逻辑不会解析这些引用标记，请在组合编辑器中修复。");

    // Omit plugins only from this explicitly blocked candidate; built-in media is read without hydration/download.
    const candidatePrompt = source?.type === CanvasNodeType.Config
        ? buildNodeGenerationContext(input.sourceNodeId, input.nodes.filter(safeType), input.connections, input.draftPrompt).prompt.trim()
        : input.draftPrompt.trim();
    if (!candidatePrompt) add("empty-prompt", [input.sourceNodeId], "解析后的完整文本为空，请先填写要求或可用文本引用。");
    const includedOrder = composer ? tokenIds.flatMap(id => resourcesByInput.get(id) ?? []) : edges.flatMap(edge => resourcesByInput.get(edge.fromNodeId) ?? []);
    const ordered = [...new Set(includedOrder)].flatMap(id => references.get(id)?.included ? [references.get(id)!] : []);
    const common = { sourceNodeId: input.sourceNodeId, rawPrompt: input.draftPrompt,
        promptField: source?.metadata?.composerContent != null ? "composerContent" as const : source?.metadata?.prompt != null ? "prompt" as const : "none" as const,
        contextMode: composer ? "composer-tokens" as const : "all-upstream" as const, references: [...ordered, ...[...references.values()].filter(reference => !reference.included)],
        localSettings: { ...input.settings, textCount } };
    return blockers.length ? { ...common, status: "blocked", candidatePrompt, blockers } : { ...common, status: "ready", prompt: candidatePrompt };
}
