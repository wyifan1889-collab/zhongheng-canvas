import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { ImageMappingSelection } from "@/services/saas/mapped-image-generation";
import { validImageGenerationCount } from "../../../../packages/shared/src/model-price-publications";

export type PlatformImageInput = {
    sourceNodeId: string;
    draftPrompt?: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    config: AiConfig;
};
export type PlatformImageLocalSettings = Readonly<{ count: number | string; model: string; size: string; quality: string; background: string; systemPrompt: string; platformSelection?: ImageMappingSelection }>;
export type PlatformImageInputResult = Readonly<{ localSettings: PlatformImageLocalSettings } & (
    { status: "ready"; prompt: string; sourceType: "image" | "config" }
    | { status: "unsupported"; reason: string }
)>;
const tokenPattern = /@\[node:([^\]]+)\]/g;
const textOf = (node: CanvasNodeData) => node.metadata?.content || node.metadata?.prompt || "";
const builtIn = (node: CanvasNodeData) => (Object.values(CanvasNodeType) as string[]).includes(node.type);
const readable = (node: CanvasNodeData) => node.type === CanvasNodeType.Text ? Boolean(textOf(node))
    : [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType) && Boolean(node.metadata?.content);

function read(input: PlatformImageInput) {
    const source = input.nodes.find(node => node.id === input.sourceNodeId), metadata = source?.metadata;
    const rawPrompt = input.draftPrompt ?? metadata?.composerContent ?? metadata?.prompt ?? "";
    const outgoing = input.connections.filter(edge => edge.fromNodeId === input.sourceNodeId && input.nodes.some(node => node.id === edge.toNodeId && node.type === CanvasNodeType.Config));
    const configEdge = outgoing[0], ownEdges = input.connections.filter(edge => edge.toNodeId === input.sourceNodeId);
    const configEdges = configEdge ? input.connections.filter(edge => edge.toNodeId === configEdge.toNodeId && edge.fromNodeId !== input.sourceNodeId) : [];
    // Match the original readable-resource preference; retain filtered raw inputs for diagnostics.
    const usesConfig = configEdges.some(edge => {
        const node = input.nodes.find(item => item.id === edge.fromNodeId);
        return node && (readable(node) || node.type === CanvasNodeType.Group && input.nodes.some(child => child.metadata?.groupId === node.id && readable(child)));
    });
    const edges = usesConfig ? configEdges : ownEdges;
    const diagnosticEdges = usesConfig ? edges : [...configEdges, ...ownEdges];
    const count = metadata?.count !== undefined ? metadata.count : input.config.canvasImageCount !== undefined ? input.config.canvasImageCount
        : input.config.count !== undefined ? input.config.count : defaultConfig.count;
    const localSettings: PlatformImageLocalSettings = Object.freeze({ count, model: resolveModelForCapability(input.config, metadata?.model, "image"),
        size: metadata?.size || input.config.size || defaultConfig.size, quality: metadata?.quality || input.config.quality || defaultConfig.quality,
        background: metadata?.background ?? input.config.background ?? defaultConfig.background, systemPrompt: input.config.systemPrompt,
        ...(metadata?.platformImageSelection ? { platformSelection: Object.freeze({ ...metadata.platformImageSelection }) } : {}) });
    const tokenIds = Array.from(rawPrompt.matchAll(tokenPattern), match => match[1]);
    return { source, rawPrompt, outgoing, configEdge, edges, diagnosticEdges, localSettings, tokenIds };
}

/** Transient source comparison only. It grants no task, target, or write permission. */
export function platformImageInputSignature(input: PlatformImageInput): string {
    const value = read(input);
    const ids = new Set([input.sourceNodeId, ...value.outgoing.map(edge => edge.toNodeId), ...value.diagnosticEdges.map(edge => edge.fromNodeId), ...value.tokenIds]);
    const groups = new Set(input.nodes.filter(node => ids.has(node.id) && node.type === CanvasNodeType.Group).map(node => node.id));
    for (const node of input.nodes) if (groups.has(node.metadata?.groupId ?? "")) ids.add(node.id);
    const edgeIds = new Set([...value.outgoing, ...value.diagnosticEdges].map(edge => edge.id));
    return JSON.stringify({ sourceNodeId: input.sourceNodeId, draftPrompt: input.draftPrompt, rawPrompt: value.rawPrompt, localSettings: value.localSettings,
        edges: input.connections.filter(edge => edgeIds.has(edge.id)),
        nodes: input.nodes.filter(node => ids.has(node.id)).map(node => ({ id: node.id, type: node.type, title: node.title,
            groupId: node.metadata?.groupId, content: node.metadata?.content, prompt: node.metadata?.prompt, composerContent: node.metadata?.composerContent,
            generationMode: node.metadata?.generationMode, generationType: node.metadata?.generationType, references: node.metadata?.references,
            ...(node.id === input.sourceNodeId ? { storageKey: node.metadata?.storageKey, cloudMediaId: node.metadata?.cloudMediaId,
                images: node.metadata?.images, primaryImageId: node.metadata?.primaryImageId, naturalWidth: node.metadata?.naturalWidth,
                naturalHeight: node.metadata?.naturalHeight, mimeType: node.metadata?.mimeType, bytes: node.metadata?.bytes } : {}),
            mask: (node.metadata as Record<string, unknown> | undefined)?.mask, maskDataUrl: (node.metadata as Record<string, unknown> | undefined)?.maskDataUrl,
            maskUrl: (node.metadata as Record<string, unknown> | undefined)?.maskUrl,
        })),
    }, (_key, value) => typeof value === "number" && !Number.isFinite(value) ? String(value) : value);
}

/** Synchronous pure-text preparation. Never reads a personal key, hydrates media, or sends a request. */
export function buildPlatformImageInput(input: PlatformImageInput): PlatformImageInputResult {
    const { source, rawPrompt, outgoing, configEdge, diagnosticEdges, edges, localSettings, tokenIds } = read(input);
    const unsupported = (reason: string): PlatformImageInputResult => Object.freeze({ status: "unsupported", reason, localSettings });
    if (!source || input.nodes.filter(node => node.id === input.sourceNodeId).length !== 1 ||
        source.type !== CanvasNodeType.Image && source.type !== CanvasNodeType.Config ||
        source.metadata?.generationMode && source.metadata.generationMode !== "image") return unsupported("原图片或图片 Config 不存在、编号重复或模式已变化，请重新打开入口。");
    if (!validImageGenerationCount(Number(localSettings.count)) || String(Number(localSettings.count)) !== String(localSettings.count)) return unsupported("图片数量无效，请在参数面板选择模型支持的张数。");
    const explicitPlatformSpec = source.type === CanvasNodeType.Image && localSettings.platformSelection?.modelId
        && localSettings.platformSelection.specification && localSettings.platformSelection.combination;
    if (!explicitPlatformSpec && (localSettings.size !== "1:1" || localSettings.quality !== "auto"))
        return unsupported("当前个人尺寸或质量尚不支持平台生成，请恢复个人默认设置，或在图片节点选择完整平台规格。");
    if (localSettings.background.trim() || localSettings.systemPrompt.trim())
        return unsupported("当前个人背景或系统提示词尚不支持平台生成，请先在节点清除背景设置或在设置中处理系统提示词。");
    const metadata = source.metadata as Record<string, unknown> | undefined;
    if (source.metadata?.generationType === "edit" || ["mask", "maskDataUrl", "maskUrl"].some(key => Boolean(metadata?.[key]))) return unsupported("平台首版只支持文生图另存，尚不支持蒙版或图片编辑。");
    if (source.metadata?.references !== undefined && (!Array.isArray(source.metadata.references) || source.metadata.references.length > 0)) return unsupported("原节点仍有媒体引用；平台首版不支持媒体参考，未将其去掉后生成。");
    if (outgoing.length > 1 || configEdge && input.nodes.filter(node => node.id === configEdge.toNodeId).length !== 1) return unsupported("关联 Config 编号或连线有歧义，无法核对原输入。");
    const relevantEdges = [...outgoing, ...diagnosticEdges];
    if (relevantEdges.some(edge => input.connections.filter(item => item.id === edge.id).length !== 1)) return unsupported("原输入连线编号重复，无法核对原输入。");
    const available = new Set(edges.map(edge => edge.fromNodeId));
    for (const edge of diagnosticEdges) {
        const matches = input.nodes.filter(node => node.id === edge.fromNodeId), node = matches[0];
        if (matches.length !== 1) return unsupported("原输入节点缺失或编号重复，未过滤后继续生成。");
        const resources = node.type === CanvasNodeType.Group ? input.nodes.filter(child => child.metadata?.groupId === node.id) : [node];
        if (!resources.length) return unsupported("原输入引用组为空，未过滤后继续生成。");
        for (const resource of resources) {
            if (input.nodes.filter(node => node.id === resource.id).length !== 1) return unsupported("原输入组成员编号重复，无法核对原输入。");
            if (resource.type !== CanvasNodeType.Text) return unsupported("本入口只支持纯文本描述；媒体、Config 和插件引用尚不支持，未过滤后继续生成。");
            if (!textOf(resource).trim()) return unsupported("原输入文本为空，未过滤后继续生成。");
            if (resource.metadata?.references?.length) return unsupported("原输入文本仍有媒体引用记录，无法作为纯文本输入。");
        }
    }
    if (rawPrompt.replace(tokenPattern, "").includes("@[node:") || tokenIds.some(id => id.trim() !== id || /[\[\u0000-\u001f\u007f]/.test(id))) return unsupported("引用标记格式不完整或编号无效，请在原编辑器修复。");
    const composer = source.type === CanvasNodeType.Config && Boolean(source.metadata?.composerContent?.trim());
    if (!composer && tokenIds.length) return unsupported("当前原入口不会解析这些引用标记，请在 Config 组合编辑器修复。");
    if (tokenIds.some(id => !available.has(id))) return unsupported("引用标记不属于当前可核对的入向节点或引用组。");
    // Existing Image content belongs to the source. It is deliberately never an edit reference here.
    const context = buildNodeGenerationContext(input.sourceNodeId, input.nodes.filter(builtIn), input.connections, rawPrompt);
    if (context.referenceImages.length || context.referenceVideos.length || context.referenceAudios.length) return unsupported("解析后的输入含媒体参考，平台首版尚不支持。");
    const prompt = context.prompt;
    if (!prompt.trim()) return unsupported("完整图片描述为空，请先填写描述或可用文本引用。");
    return Object.freeze({ status: "ready", prompt, sourceType: source.type === CanvasNodeType.Image ? "image" : "config", localSettings });
}
