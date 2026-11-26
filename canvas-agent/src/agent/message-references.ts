import type { AgentAttachment, AgentCanvasReference } from "./types.js";

type Reference = Record<string, unknown> & { nodeId: string; kind: AgentCanvasReference["kind"] };
type Attachment = AgentAttachment & { id: string; type: string; dataUrl: string };
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function list(value: unknown): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("参考素材必须是数组");
    return value;
}

function identity(value: unknown): string {
    // Match the existing metadata identity boundary, but never truncate and merge sources.
    if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new Error("参考素材身份无效");
    return value.trim();
}

function normalizeAttachment(value: unknown): Attachment {
    const item = record(value);
    if (!item || typeof item.id !== "string") throw new Error("参考附件身份无效");
    const rawId = item.id.trim();
    const id = rawId.startsWith("canvas:") ? `canvas:${identity(rawId.slice(7))}` : identity(rawId);
    // Keep the session's image filter and the engine's existing dataURL syntax.
    // This is not base64 decoding, image verification, or a new format/byte policy.
    const dataUrl = item.dataUrl;
    const parsed = typeof dataUrl === "string" && dataUrl.startsWith("data:image/")
        ? dataUrl.match(/^data:([^;]+);base64,(.+)$/) : null;
    if (!parsed || typeof dataUrl !== "string" || item.type != null && typeof item.type !== "string") throw new Error("参考图片附件无效");
    const type = typeof item.type === "string" && item.type.startsWith("image/") ? item.type : parsed[1];
    return { ...item, id, type, dataUrl } as Attachment;
}

/** Normalize the same inputs used for counting, engine attachments, and pending history. */
export function normalizeMessageReferences(attachments: unknown, messageMetadata: unknown): {
    attachments: AgentAttachment[]; messageMetadata: unknown; total: number;
} {
    const metadata = messageMetadata == null ? null : record(messageMetadata);
    if (messageMetadata != null && !metadata) throw new Error("Message metadata must be an object.");
    const references = new Map<string, Reference>();
    for (const value of list(metadata?.canvasReferences)) {
        const item = record(value);
        if (!item || typeof item.kind !== "string" || !["image", "video", "audio", "text"].includes(item.kind)) throw new Error("画布引用身份无效");
        const nodeId = identity(item.nodeId), kind = item.kind as Reference["kind"];
        const prior = references.get(nodeId);
        if (prior && prior.kind !== kind) throw new Error("同一画布引用身份的类型冲突");
        if (!prior) references.set(nodeId, { ...item, nodeId, kind });
    }
    const images = new Map<string, Attachment>();
    for (const value of list(attachments)) {
        const item = normalizeAttachment(value), prior = images.get(item.id);
        if (prior && (prior.dataUrl !== item.dataUrl || prior.type !== item.type)) throw new Error("同一参考附件身份的图片或媒体类型冲突");
        if (!prior) images.set(item.id, item);
    }
    let uploads = 0;
    for (const item of images.values()) {
        if (!item.id.startsWith("canvas:")) { uploads++; continue; }
        if (references.get(item.id.slice(7))?.kind !== "image") throw new Error("画布图片附件没有对应的图片引用");
    }
    for (const item of references.values()) {
        if (item.kind === "image" && !images.has(`canvas:${item.nodeId}`)) throw new Error("画布图片引用缺少图片附件");
    }
    const total = references.size + uploads;
    if (total > 12) throw new Error("参考素材最多 12 个");
    return { attachments: [...images.values()],
        messageMetadata: metadata && metadata.canvasReferences !== undefined ? { ...metadata, canvasReferences: [...references.values()] } : messageMetadata,
        total };
}
