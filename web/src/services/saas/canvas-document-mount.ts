import type {
    CanvasAssistantMessage,
    CanvasAssistantReference,
    CanvasAssistantSession,
    CanvasNodeData,
    CanvasNodeImage,
    CanvasNodeText,
} from "../../types/canvas";
import type { CanvasProject } from "../../stores/canvas/use-canvas-store";
import { CanvasDocumentError, inspectCanvasDocument, type CanvasMediaReference } from "./canvas-document";
import { isCloudMediaId } from "./cloud-media-reference";
import { parsePlatformTextRequests } from "../../lib/canvas/platform-text-target";
import { parsePlatformImageRequests, stripImageTarget } from "../../lib/canvas/platform-image-target";

type JsonRecord = Record<string, unknown>;

type MountErrorCode =
    | "unsupported_version"
    | "invalid_document"
    | "invalid_node"
    | "invalid_connection"
    | "invalid_chat"
    | "invalid_metadata";

/** A malformed cloud document never includes the original value in its error. */
export class CanvasDocumentMountError extends Error {
    constructor(public readonly code: MountErrorCode, public readonly path: string) {
        super(code === "unsupported_version" ? "暂不支持此画布文档版本。" : "云端画布不能安全挂载到原版编辑器，当前内容未替换。");
        this.name = "CanvasDocumentMountError";
    }
}

export type CanvasDocumentMountReference = CanvasMediaReference;

export type CanvasDocumentMount = Readonly<{
    status: "mountable";
    documentVersion: 1;
    project: Readonly<CanvasProject>;
    unresolvedReferences: ReadonlyArray<CanvasDocumentMountReference>;
}>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const pointer = (parts: Array<string | number>) => parts.length ? `/${parts.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` : "";
const child = (base: string, key: string | number) => `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown): value is string => nonEmpty(value) && Number.isFinite(Date.parse(value));
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T => typeof value === "string" && choices.includes(value as T);
const freeze = <T>(value: T, seen = new WeakSet<object>()): T => {
    if (typeof value !== "object" || value === null || seen.has(value)) return value;
    seen.add(value);
    for (const item of Object.values(value as JsonRecord)) freeze(item, seen);
    return Object.freeze(value);
};
const fail: (code: MountErrorCode, path: string) => never = (code, path) => { throw new CanvasDocumentMountError(code, path); };

function requiredString(value: unknown, path: string, code: MountErrorCode): asserts value is string {
    if (!nonEmpty(value)) fail(code, path);
}
function requiredTimestamp(value: unknown, path: string, code: MountErrorCode): asserts value is string {
    if (!timestamp(value)) fail(code, path);
}
function requiredFinite(value: unknown, path: string, code: MountErrorCode, positive = false): asserts value is number {
    if (!finite(value) || (positive && value <= 0)) fail(code, path);
}
function optionalString(record: JsonRecord, key: string, path: string, code: MountErrorCode, nonemptyValue = false) {
    if (!Object.hasOwn(record, key)) return;
    if (typeof record[key] !== "string" || (nonemptyValue && !nonEmpty(record[key]))) fail(code, child(path, key));
}
function optionalNumber(record: JsonRecord, key: string, path: string, code: MountErrorCode) {
    if (Object.hasOwn(record, key)) requiredFinite(record[key], child(path, key), code);
}
function optionalBoolean(record: JsonRecord, key: string, path: string, code: MountErrorCode) {
    if (Object.hasOwn(record, key) && typeof record[key] !== "boolean") fail(code, child(path, key));
}

function validateNodeText(value: unknown, path: string): asserts value is CanvasNodeText {
    if (!isRecord(value)) fail("invalid_metadata", path);
    requiredString(value.id, child(path, "id"), "invalid_metadata");
    if (!oneOf(value.status, ["idle", "success", "loading", "error"] as const)) fail("invalid_metadata", child(path, "status"));
    if (typeof value.content !== "string") fail("invalid_metadata", child(path, "content"));
    optionalString(value, "errorDetails", path, "invalid_metadata");
}
function validateNodeImage(value: unknown, path: string): asserts value is CanvasNodeImage {
    if (!isRecord(value)) fail("invalid_metadata", path);
    requiredString(value.id, child(path, "id"), "invalid_metadata");
    if (!oneOf(value.status, ["idle", "success", "loading", "error"] as const)) fail("invalid_metadata", child(path, "status"));
    if (typeof value.content !== "string") fail("invalid_metadata", child(path, "content"));
    optionalString(value, "errorDetails", path, "invalid_metadata");
    optionalString(value, "storageKey", path, "invalid_metadata", true);
    if (Object.hasOwn(value, "cloudMediaId") && !isCloudMediaId(value.cloudMediaId)) fail("invalid_metadata", child(path, "cloudMediaId"));
    for (const key of ["naturalWidth", "naturalHeight", "bytes"] as const) requiredFinite(value[key], child(path, key), "invalid_metadata");
    requiredString(value.mimeType, child(path, "mimeType"), "invalid_metadata");
}
function validateMetadata(value: unknown, path: string, unresolved: CanvasDocumentMountReference[]) {
    if (value === undefined) return;
    if (!isRecord(value)) fail("invalid_metadata", path);
    const stringKeys = ["content", "composerContent", "prompt", "model", "size", "quality", "background", "seconds", "vquality", "generateAudio", "watermark", "videoMode", "audioVoice", "audioFormat", "audioSpeed", "audioInstructions", "primaryTextId", "primaryImageId", "mimeType", "videoTaskId", "videoTaskProvider", "groupId"] as const;
    for (const key of stringKeys) optionalString(value, key, path, "invalid_metadata", ["videoTaskId", "storageKey", "primaryTextId", "primaryImageId", "groupId"].includes(key));
    if (Object.hasOwn(value, "cloudMediaId") && !isCloudMediaId(value.cloudMediaId)) fail("invalid_metadata", child(path, "cloudMediaId"));
    for (const key of ["fontSize", "count", "textCount", "naturalWidth", "naturalHeight", "bytes", "durationMs"] as const) optionalNumber(value, key, path, "invalid_metadata");
    for (const key of ["freeResize", "interactive"] as const) optionalBoolean(value, key, path, "invalid_metadata");
    if (Object.hasOwn(value, "status") && !oneOf(value.status, ["idle", "success", "loading", "error"] as const)) fail("invalid_metadata", child(path, "status"));
    if (Object.hasOwn(value, "generationMode") && !oneOf(value.generationMode, ["text", "image", "video", "audio"] as const)) fail("invalid_metadata", child(path, "generationMode"));
    if (Object.hasOwn(value, "generationType") && !oneOf(value.generationType, ["generation", "edit"] as const)) fail("invalid_metadata", child(path, "generationType"));
    if (Object.hasOwn(value, "reasoningEffort") && !oneOf(value.reasoningEffort, ["auto", "low", "medium", "high", "xhigh"] as const)) fail("invalid_metadata", child(path, "reasoningEffort"));
    if (Object.hasOwn(value, "references")) {
        if (!Array.isArray(value.references) || value.references.some((item) => !nonEmpty(item))) fail("invalid_metadata", child(path, "references"));
    }
    if (Object.hasOwn(value, "texts")) {
        if (!Array.isArray(value.texts)) fail("invalid_metadata", child(path, "texts"));
        const ids = new Set<string>();
        value.texts.forEach((item, index) => { validateNodeText(item, child(child(path, "texts"), index)); if (ids.has(item.id)) fail("invalid_metadata", child(child(path, "texts"), index) + "/id"); ids.add(item.id); });
    }
    if (Object.hasOwn(value, "images")) {
        if (!Array.isArray(value.images)) fail("invalid_metadata", child(path, "images"));
        const ids = new Set<string>();
        value.images.forEach((item, index) => { validateNodeImage(item, child(child(path, "images"), index)); if (ids.has(item.id)) fail("invalid_metadata", child(child(path, "images"), index) + "/id"); ids.add(item.id); });
    }
    if (Object.hasOwn(value, "platformTextRequests") && !parsePlatformTextRequests(value.platformTextRequests)) fail("invalid_metadata", child(path, "platformTextRequests"));
    if (Object.hasOwn(value, "platformTextConfigRequests") && !parsePlatformTextRequests(value.platformTextConfigRequests)) fail("invalid_metadata", child(path, "platformTextConfigRequests"));
    if (Object.hasOwn(value, "platformImageRequests") && !parsePlatformImageRequests(value.platformImageRequests)) fail("invalid_metadata", child(path, "platformImageRequests"));
    optionalString(value, "storageKey", path, "invalid_metadata", true);
}

function validateMessageReference(value: unknown, path: string): asserts value is CanvasAssistantReference {
    if (!isRecord(value)) fail("invalid_chat", path);
    requiredString(value.id, child(path, "id"), "invalid_chat");
    requiredString(value.type, child(path, "type"), "invalid_chat");
    requiredString(value.title, child(path, "title"), "invalid_chat");
    optionalString(value, "dataUrl", path, "invalid_chat"); optionalString(value, "storageKey", path, "invalid_chat", true); optionalString(value, "text", path, "invalid_chat");
    if (Object.hasOwn(value, "cloudMediaId") && !isCloudMediaId(value.cloudMediaId)) fail("invalid_chat", child(path, "cloudMediaId"));
}
function validateMessage(value: unknown, path: string, messageIds: Set<string>) {
    if (!isRecord(value)) fail("invalid_chat", path);
    requiredString(value.id, child(path, "id"), "invalid_chat");
    if (messageIds.has(value.id)) fail("invalid_chat", child(path, "id"));
    messageIds.add(value.id);
    if (!oneOf(value.role, ["user", "assistant", "system", "tool", "error"] as const)) fail("invalid_chat", child(path, "role"));
    if (typeof value.text !== "string") fail("invalid_chat", child(path, "text"));
    optionalString(value, "title", path, "invalid_chat"); optionalString(value, "meta", path, "invalid_chat");
    if (Object.hasOwn(value, "references")) {
        if (!Array.isArray(value.references)) fail("invalid_chat", child(path, "references"));
        const ids = new Set<string>();
        value.references.forEach((item, index) => { validateMessageReference(item, child(child(path, "references"), index)); if (ids.has(item.id)) fail("invalid_chat", child(child(path, "references"), index) + "/id"); ids.add(item.id); });
    }
}
function validateSession(value: unknown, path: string, sessionIds: Set<string>, messageIds: Set<string>): asserts value is CanvasAssistantSession {
    if (!isRecord(value)) fail("invalid_chat", path);
    requiredString(value.id, child(path, "id"), "invalid_chat");
    if (sessionIds.has(value.id)) fail("invalid_chat", child(path, "id"));
    sessionIds.add(value.id);
    requiredString(value.title, child(path, "title"), "invalid_chat"); requiredTimestamp(value.createdAt, child(path, "createdAt"), "invalid_chat"); requiredTimestamp(value.updatedAt, child(path, "updatedAt"), "invalid_chat");
    if (!Array.isArray(value.messages)) fail("invalid_chat", child(path, "messages"));
    value.messages.forEach((item, index) => validateMessage(item, child(child(path, "messages"), index), messageIds));
}

/**
 * Validates a cloud JSON document for direct handoff to the original editor.
 * This is deliberately stricter than inspectCanvasDocument: it never repairs
 * data, never hydrates media, and never follows video tasks or URLs.
 * Validated image task authority is stripped for an external document mount.
 */
export function validateCanvasDocumentMount(project: unknown, documentVersion: unknown = 1): CanvasDocumentMount {
    let inspection: ReturnType<typeof inspectCanvasDocument>;
    try { inspection = inspectCanvasDocument(project, documentVersion); }
    catch (error) {
        if (error instanceof CanvasDocumentError && error.code === "unsupported_version") throw new CanvasDocumentMountError("unsupported_version", error.path);
        throw new CanvasDocumentMountError("invalid_document", error instanceof CanvasDocumentError ? error.path : "");
    }
    if (inspection.omittedOptionalPaths.length) throw new CanvasDocumentMountError("invalid_document", inspection.omittedOptionalPaths[0]);
    const snapshot = inspection.snapshot;
    if (!isRecord(snapshot)) fail("invalid_document", "");
    requiredString(snapshot.id, "/id", "invalid_document"); requiredString(snapshot.title, "/title", "invalid_document");
    requiredTimestamp(snapshot.createdAt, "/createdAt", "invalid_document"); requiredTimestamp(snapshot.updatedAt, "/updatedAt", "invalid_document");
    if (!Array.isArray(snapshot.nodes)) fail("invalid_document", "/nodes");
    if (!Array.isArray(snapshot.connections)) fail("invalid_document", "/connections");
    if (!Array.isArray(snapshot.chatSessions)) fail("invalid_document", "/chatSessions");
    if (!oneOf(snapshot.backgroundMode, ["dots", "lines", "blank"] as const)) fail("invalid_document", "/backgroundMode");
    if (typeof snapshot.showImageInfo !== "boolean") fail("invalid_document", "/showImageInfo");
    if (!isRecord(snapshot.viewport)) fail("invalid_document", "/viewport");
    requiredFinite(snapshot.viewport.x, "/viewport/x", "invalid_document"); requiredFinite(snapshot.viewport.y, "/viewport/y", "invalid_document"); requiredFinite(snapshot.viewport.k, "/viewport/k", "invalid_document", true);
    if (!(snapshot.activeChatId === null || nonEmpty(snapshot.activeChatId))) fail("invalid_chat", "/activeChatId");

    const unresolvedReferences: CanvasDocumentMountReference[] = [...inspection.mediaReferences];
    const nodeIds = new Set<string>();
    snapshot.nodes.forEach((value, index) => {
        const path = `/nodes/${index}`;
        if (!isRecord(value)) fail("invalid_node", path);
        requiredString(value.id, child(path, "id"), "invalid_node");
        if (nodeIds.has(value.id)) fail("invalid_node", child(path, "id"));
        nodeIds.add(value.id);
        requiredString(value.type, child(path, "type"), "invalid_node");
        requiredString(value.title, child(path, "title"), "invalid_node");
        if (!isRecord(value.position)) fail("invalid_node", child(path, "position"));
        requiredFinite(value.position.x, child(child(path, "position"), "x"), "invalid_node"); requiredFinite(value.position.y, child(child(path, "position"), "y"), "invalid_node");
        requiredFinite(value.width, child(path, "width"), "invalid_node"); requiredFinite(value.height, child(path, "height"), "invalid_node");
        if (value.width < 0 || value.height < 0) fail("invalid_node", path);
        validateMetadata(value.metadata, child(path, "metadata"), unresolvedReferences);
    });
    const connectionIds = new Set<string>();
    snapshot.connections.forEach((value, index) => {
        const path = `/connections/${index}`;
        if (!isRecord(value)) fail("invalid_connection", path);
        requiredString(value.id, child(path, "id"), "invalid_connection");
        if (connectionIds.has(value.id)) fail("invalid_connection", child(path, "id"));
        connectionIds.add(value.id);
        requiredString(value.fromNodeId, child(path, "fromNodeId"), "invalid_connection"); requiredString(value.toNodeId, child(path, "toNodeId"), "invalid_connection");
        if (!nodeIds.has(value.fromNodeId)) fail("invalid_connection", child(path, "fromNodeId"));
        if (!nodeIds.has(value.toNodeId)) fail("invalid_connection", child(path, "toNodeId"));
    });
    const sessionIds = new Set<string>(), messageIds = new Set<string>();
    snapshot.chatSessions.forEach((value, index) => validateSession(value, `/chatSessions/${index}`, sessionIds, messageIds));
    if (snapshot.activeChatId !== null && !sessionIds.has(snapshot.activeChatId)) fail("invalid_chat", "/activeChatId");
    snapshot.nodes = (snapshot.nodes as unknown as CanvasNodeData[]).map(stripImageTarget) as unknown as typeof snapshot.nodes;
    return Object.freeze({ status: "mountable", documentVersion: 1, project: freeze(snapshot) as Readonly<CanvasProject>, unresolvedReferences: freeze(unresolvedReferences) as ReadonlyArray<CanvasDocumentMountReference> });
}

/** Alias used by callers that name the operation rather than its validation phase. */
export const mountCanvasDocument = validateCanvasDocumentMount;
