import type { AgentAttachment, AgentCanvasReference } from "@/stores/use-agent-store";

export const AGENT_MESSAGE_REFERENCE_LIMIT = 12;

export type AgentMessageReferencesInput = { attachments?: unknown; canvasReferences?: unknown };
export type NormalizedAgentMessageReferences = {
    attachments: AgentAttachment[];
    canvasReferences: AgentCanvasReference[];
    count: number;
};
type ReferenceErrorCode = "invalid_input" | "invalid_array" | "invalid_attachment" | "invalid_reference" | "attachment_conflict" | "reference_conflict" | "invalid_pair" | "missing_carrier" | "limit";

export class AgentMessageReferenceError extends Error {
    constructor(public readonly code: ReferenceErrorCode, message: string) {
        super(message);
        this.name = "AgentMessageReferenceError";
    }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const identity = (value: unknown): value is string => text(value) && value.trim().length <= 200;
const kinds = new Set(["image", "video", "audio", "text"]);

function list(value: unknown, field: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new AgentMessageReferenceError("invalid_array", `${field} 必须是数组`);
    return value;
}

function normalize(input: AgentMessageReferencesInput, requireCarriers: boolean, enforceLimit: boolean): NormalizedAgentMessageReferences {
    if (!object(input)) throw new AgentMessageReferenceError("invalid_input", "参考素材输入必须是对象");
    const references = new Map<string, AgentCanvasReference>();
    for (const item of list(input.canvasReferences, "canvasReferences")) {
        if (!object(item) || !identity(item.nodeId) || typeof item.kind !== "string" || !kinds.has(item.kind)) {
            throw new AgentMessageReferenceError("invalid_reference", "画布引用的 nodeId 或 kind 无效");
        }
        const nodeId = item.nodeId.trim(), previous = references.get(nodeId);
        if (previous && previous.kind !== item.kind) throw new AgentMessageReferenceError("reference_conflict", `画布引用 ${nodeId} 的 kind 冲突`);
        if (!previous) references.set(nodeId, (nodeId === item.nodeId ? item : { ...item, nodeId }) as AgentCanvasReference);
    }
    const attachments = new Map<string, AgentAttachment>();
    for (const item of list(input.attachments, "attachments")) {
        if (!object(item) || typeof item.id !== "string") throw new AgentMessageReferenceError("invalid_attachment", "附件的 ID 无效");
        const rawId = item.id.trim(), canvas = rawId.startsWith("canvas:"), sourceId = canvas ? rawId.slice(7) : rawId;
        if (!identity(sourceId)) throw new AgentMessageReferenceError("invalid_attachment", "附件的 ID 无效");
        const id = canvas ? `canvas:${sourceId.trim()}` : sourceId.trim();
        // Keep the existing session image filter and engine dataURL syntax; do not decode or inspect image content.
        const dataUrl = item.dataUrl;
        const parsed = typeof dataUrl === "string" && dataUrl.startsWith("data:image/") ? dataUrl.match(/^data:([^;]+);base64,(.+)$/) : null;
        if (!parsed || typeof dataUrl !== "string" || item.type != null && typeof item.type !== "string") {
            throw new AgentMessageReferenceError("invalid_attachment", "图片附件的 type 或 dataUrl 无效");
        }
        const type = typeof item.type === "string" && item.type.startsWith("image/") ? item.type : parsed[1];
        const previous = attachments.get(id);
        if (previous && (previous.type !== type || previous.dataUrl !== dataUrl)) {
            throw new AgentMessageReferenceError("attachment_conflict", `附件 ${id} 的 type 或 dataUrl 冲突`);
        }
        if (!previous) attachments.set(id, (id === item.id && type === item.type ? item : { ...item, id, type, dataUrl }) as AgentAttachment);
    }
    let uploads = 0;
    const carriers = new Set<string>();
    for (const attachment of attachments.values()) {
        if (!attachment.id.startsWith("canvas:")) { uploads++; continue; }
        const nodeId = attachment.id.slice("canvas:".length);
        if (references.get(nodeId)?.kind !== "image" || carriers.has(nodeId)) {
            throw new AgentMessageReferenceError("invalid_pair", `画布附件 ${attachment.id} 必须唯一配对同 nodeId 的图片引用`);
        }
        carriers.add(nodeId);
    }
    const count = references.size + uploads;
    if (enforceLimit && count > AGENT_MESSAGE_REFERENCE_LIMIT) throw new AgentMessageReferenceError("limit", "参考素材最多 12 个");
    if (requireCarriers && [...references.values()].some(reference => reference.kind === "image" && !carriers.has(reference.nodeId))) {
        throw new AgentMessageReferenceError("missing_carrier", "每个画布图片引用必须有唯一的 canvas: 图片附件载体");
    }
    return { attachments: [...attachments.values()], canvasReferences: [...references.values()], count };
}

/** Draft images are unresolved; carriers already present must still have a valid source pairing. */
export function normalizeAgentDraftReferences<A extends AgentAttachment, R extends AgentCanvasReference>(input: { attachments?: A[]; canvasReferences?: R[] }): { attachments: A[]; canvasReferences: R[]; count: number };
export function normalizeAgentDraftReferences(input?: AgentMessageReferencesInput): NormalizedAgentMessageReferences;
export function normalizeAgentDraftReferences(input: AgentMessageReferencesInput = {}): NormalizedAgentMessageReferences {
    return normalize(input, false, true);
}

/** Count an existing draft without truncating or hiding an over-limit state. */
export function countAgentDraftReferences(input: AgentMessageReferencesInput = {}): number {
    return normalizeAgentStoredDraftReferences(input).count;
}

/** Validate stored sources without applying the separate single-request limit. */
export function normalizeAgentStoredDraftReferences<A extends AgentAttachment, R extends AgentCanvasReference>(input: { attachments?: A[]; canvasReferences?: R[] }): { attachments: A[]; canvasReferences: R[]; count: number };
export function normalizeAgentStoredDraftReferences(input?: AgentMessageReferencesInput): NormalizedAgentMessageReferences;
export function normalizeAgentStoredDraftReferences(input: AgentMessageReferencesInput = {}): NormalizedAgentMessageReferences {
    return normalize(input, false, false);
}

/** Use these same normalized arrays to build the prompt and the actual turn request. */
export function normalizeAgentMessageReferences<A extends AgentAttachment, R extends AgentCanvasReference>(input: { attachments?: A[]; canvasReferences?: R[] }): { attachments: A[]; canvasReferences: R[]; count: number };
export function normalizeAgentMessageReferences(input?: AgentMessageReferencesInput): NormalizedAgentMessageReferences;
export function normalizeAgentMessageReferences(input: AgentMessageReferencesInput = {}): NormalizedAgentMessageReferences {
    return normalize(input, true, true);
}

/** HTTP success alone does not prove that the submitted turn was accepted. */
export function acknowledgedAgentThreadId(value: unknown): string | null {
    return object(value) && value.ok === true && text(value.threadId) ? value.threadId.trim() : null;
}
