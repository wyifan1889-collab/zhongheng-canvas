import type { JsonObject, JsonValue } from "../../../../packages/shared/src/index";
import type { CanvasNodeMetadata } from "../../types/canvas";
import { parsePlatformTextRequests } from "../../lib/canvas/platform-text-target";
import { parsePlatformImageRequests } from "../../lib/canvas/platform-image-target";
import { isCloudMediaId } from "./cloud-media-reference";

type Path = Array<string | number>;
export type CanvasMediaReference = {
    kind: "storage-key" | "cloud-media" | "blob-url" | "data-url" | "file-url" | "video-task" | "remote-url";
    path: string;
    storageKey?: string;
    cloudMediaId?: string;
    videoTaskId?: string;
};
export type CanvasDocumentInspection = {
    status: "inspection-only";
    documentVersion: 1;
    snapshot: JsonObject;
    mediaReferences: CanvasMediaReference[];
    omittedOptionalPaths: string[];
};

const hydratedPreviewKinds = new Set<CanvasMediaReference["kind"]>(["storage-key", "blob-url", "data-url", "file-url", "remote-url"]);

export class CanvasDocumentError extends Error {
    constructor(public code: "unsupported_version" | "invalid_project" | "non_json_value", public path: string) {
        super(code === "unsupported_version" ? "暂不支持此画布文档版本。" : code === "invalid_project" ? "画布项目结构不完整，未生成快照。" : "画布含不能完整保存为 JSON 的数据，未生成快照。");
    }
}

// Same prefixes as the upstream app-sync collector, including references stored as plain strings.
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;
const remoteUrlPattern = /^https?:\/\//i;
const optionalMetadata = new Set<string>([
    "content", "composerContent", "prompt", "status", "errorDetails", "fontSize", "generationMode", "generationType", "model", "reasoningEffort",
    "size", "quality", "background", "count", "textCount", "texts", "primaryTextId", "seconds", "vquality", "generateAudio", "watermark", "videoMode",
    "audioVoice", "audioFormat", "audioSpeed", "audioInstructions", "references", "naturalWidth", "naturalHeight", "freeResize", "images", "primaryImageId",
    "storageKey", "cloudMediaId", "mimeType", "bytes", "durationMs", "videoTaskId", "videoTaskProvider", "groupId", "interactive", "platformTextRequests", "platformTextConfigRequests", "platformImageRequests", "platformImageSelection",
] satisfies Array<keyof CanvasNodeMetadata>);
const pointer = (path: Path) => path.length ? `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` : "";
const object = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: JsonValue | undefined): value is JsonObject => object(value);

function pathLocation(value: unknown, path: string): { parent: Record<string, unknown>; key: string } | null {
    const parts = path.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!parts.length) return null;
    let current: unknown = value;
    for (const part of parts.slice(0, -1)) {
        if (typeof current !== "object" || current === null) return null;
        current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "object" && current !== null && !Array.isArray(current)
        ? { parent: current as Record<string, unknown>, key: parts.at(-1)! } : null;
}

/**
 * Removes tab-local preview values from a cloud-save payload while leaving the
 * live editor document untouched. Durable cloudMediaId references remain.
 */
export function prepareCanvasDocumentForCloudSave(inspection: CanvasDocumentInspection): CanvasDocumentInspection {
    const snapshot = JSON.parse(JSON.stringify(inspection.snapshot)) as JsonObject;
    const cloudParents = new Set<string>();
    inspection.mediaReferences.filter((reference) => reference.kind === "cloud-media" && reference.cloudMediaId).forEach((reference) => {
        const slash = reference.path.lastIndexOf("/");
        const parentPath = slash > 0 ? reference.path.slice(0, slash) : "";
        const location = pathLocation(snapshot, reference.path);
        if (location && typeof location.parent[location.key] === "string" && isCloudMediaId(location.parent[location.key])) cloudParents.add(parentPath);
    });
    cloudParents.forEach((parentPath) => {
        const location = pathLocation(snapshot, `${parentPath}/cloudMediaId`);
        if (!location) return;
        delete location.parent.storageKey;
        if (Object.hasOwn(location.parent, "content")) location.parent.content = "";
        if (Object.hasOwn(location.parent, "dataUrl")) location.parent.dataUrl = "";
    });
    return {
        ...inspection,
        snapshot,
        mediaReferences: inspection.mediaReferences.filter((reference) => {
            if (!hydratedPreviewKinds.has(reference.kind)) return true;
            const slash = reference.path.lastIndexOf("/");
            return !cloudParents.has(slash > 0 ? reference.path.slice(0, slash) : "");
        }),
    };
}

function collectRemoteMediaReferences(snapshot: JsonObject, mediaReferences: CanvasMediaReference[]) {
    const add = (path: string) => mediaReferences.push({ kind: "remote-url", path });
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
    nodes.forEach((node, nodeIndex) => {
        if (!record(node) || !record(node.metadata)) return;
        const metadata = node.metadata;
        const nodeType = typeof node.type === "string" ? node.type : "";
        if (["image", "video", "audio"].includes(nodeType) && typeof metadata.content === "string" && remoteUrlPattern.test(metadata.content)) {
            add(`/nodes/${nodeIndex}/metadata/content`);
        }
        if (Array.isArray(metadata.images)) metadata.images.forEach((image, imageIndex) => {
            if (record(image) && typeof image.content === "string" && remoteUrlPattern.test(image.content)) add(`/nodes/${nodeIndex}/metadata/images/${imageIndex}/content`);
        });
        if (Array.isArray(metadata.references)) metadata.references.forEach((reference, referenceIndex) => {
            if (typeof reference === "string" && remoteUrlPattern.test(reference)) add(`/nodes/${nodeIndex}/metadata/references/${referenceIndex}`);
        });
        // Unknown/plugin nodes may expose media through a conventional URL field.
        // Built-in text prompts remain ordinary text and are deliberately excluded.
        if (nodeType !== "text") ["url", "src", "dataUrl"].forEach((key) => {
            if (typeof metadata[key] === "string" && remoteUrlPattern.test(metadata[key] as string)) add(`/nodes/${nodeIndex}/metadata/${key}`);
        });
    });
    const sessions = Array.isArray(snapshot.chatSessions) ? snapshot.chatSessions : [];
    sessions.forEach((session, sessionIndex) => {
        if (!record(session) || !Array.isArray(session.messages)) return;
        session.messages.forEach((message, messageIndex) => {
            if (!record(message) || !Array.isArray(message.references)) return;
            message.references.forEach((reference, referenceIndex) => {
                if (record(reference) && typeof reference.dataUrl === "string" && remoteUrlPattern.test(reference.dataUrl)) {
                    add(`/chatSessions/${sessionIndex}/messages/${messageIndex}/references/${referenceIndex}/dataUrl`);
                }
            });
        });
    });
}

function optionalUndefined(path: Path): boolean {
    if (path[0] === "nodes" && typeof path[1] === "number" && path[2] === "metadata") {
        if (path.length === 3) return true;
        if (path.length === 4) return optionalMetadata.has(String(path[3]));
        if (path.length === 6 && typeof path[4] === "number") {
            return path[3] === "images" ? ["errorDetails", "storageKey", "cloudMediaId"].includes(String(path[5])) : path[3] === "texts" && path[5] === "errorDetails";
        }
    }
    if (path[0] === "chatSessions" && typeof path[1] === "number" && path[2] === "messages" && typeof path[3] === "number") {
        if (path.length === 5) return ["title", "meta", "detail", "references"].includes(String(path[4]));
        if (path.length === 7 && path[4] === "references" && typeof path[5] === "number") return ["dataUrl", "storageKey", "cloudMediaId", "text"].includes(String(path[6]));
    }
    return false;
}

/**
 * Pure preflight, not an upload payload or a cloud-save success check. No storage/network access.
 * Preserves JSON extensions; it does not sanitize provider secrets in arbitrary plugin/message data.
 * Known optional fields set to undefined by upstream (e.g. errorDetails/groupId) mean absent;
 * each omission is reported. Unknown extension values and array entries must be actual JSON.
 */
export function inspectCanvasDocument(project: unknown, documentVersion: unknown = 1): CanvasDocumentInspection {
    if (documentVersion !== 1) throw new CanvasDocumentError("unsupported_version", "");
    const ancestors = new WeakSet<object>();
    const mediaReferences: CanvasMediaReference[] = [];
    const omittedOptionalPaths: string[] = [];
    function copy(value: unknown, path: Path): JsonValue {
        const location = pointer(path);
        const refuse = (): never => { throw new CanvasDocumentError("non_json_value", location); };
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : refuse();
        if (typeof value === "string") {
            const scheme = /^(blob|data):/i.exec(value)?.[1].toLowerCase() ?? (/^file:[/\\]/i.test(value) ? "file" : undefined);
            if (value && path.at(-1) === "cloudMediaId") mediaReferences.push({ kind: "cloud-media", path: location, cloudMediaId: value });
            if (value && (path.at(-1) === "storageKey" || (!scheme && storageKeyPattern.test(value)))) mediaReferences.push({ kind: "storage-key", path: location, storageKey: value });
            if (scheme) mediaReferences.push({ kind: `${scheme}-url` as CanvasMediaReference["kind"], path: location });
            if (value && path.at(-1) === "videoTaskId") mediaReferences.push({ kind: "video-task", path: location, videoTaskId: value });
            return value;
        }
        if (typeof value !== "object" || ancestors.has(value)) return refuse();
        const array = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return refuse();
        ancestors.add(value);
        const output: JsonValue[] | JsonObject = array ? [] : {};
        const keys = Reflect.ownKeys(value);
        if (array && keys.length !== value.length + 1) return refuse(); // Holes or extra properties would be lost.
        for (const key of keys) {
            if (array && key === "length") continue;
            if (typeof key !== "string") return refuse();
            if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return refuse();
            const childPath = [...path, array ? Number(key) : key];
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new CanvasDocumentError("non_json_value", pointer(childPath));
            if (descriptor.value === undefined && optionalUndefined(childPath)) {
                omittedOptionalPaths.push(pointer(childPath));
                continue;
            }
            Object.defineProperty(output, key, { value: copy(descriptor.value, childPath), enumerable: true, writable: true, configurable: true });
        }
        ancestors.delete(value);
        return output;
    }
    const snapshot = copy(project, []);
    if (!object(snapshot) || !["id", "title", "createdAt", "updatedAt"].every((key) => typeof snapshot[key] === "string") ||
        !["nodes", "connections", "chatSessions"].every((key) => Array.isArray(snapshot[key])) ||
        !(snapshot.activeChatId === null || typeof snapshot.activeChatId === "string") ||
        !["dots", "lines", "blank"].includes(String(snapshot.backgroundMode)) || typeof snapshot.showImageInfo !== "boolean" ||
        !object(snapshot.viewport) || !["x", "y", "k"].every((key) => typeof (snapshot.viewport as JsonObject)[key] === "number")) {
        throw new CanvasDocumentError("invalid_project", "");
    }
    collectRemoteMediaReferences(snapshot, mediaReferences);
    (snapshot.nodes as JsonValue[]).forEach((node, index) => {
        if (record(node) && record(node.metadata) && Object.hasOwn(node.metadata, "platformTextRequests") && !parsePlatformTextRequests(node.metadata.platformTextRequests)) {
            throw new CanvasDocumentError("invalid_project", `/nodes/${index}/metadata/platformTextRequests`);
        }
        if (record(node) && record(node.metadata) && Object.hasOwn(node.metadata, "platformTextConfigRequests") && !parsePlatformTextRequests(node.metadata.platformTextConfigRequests)) {
            throw new CanvasDocumentError("invalid_project", `/nodes/${index}/metadata/platformTextConfigRequests`);
        }
        if (record(node) && record(node.metadata) && Object.hasOwn(node.metadata, "platformImageRequests") && !parsePlatformImageRequests(node.metadata.platformImageRequests)) {
            throw new CanvasDocumentError("invalid_project", `/nodes/${index}/metadata/platformImageRequests`);
        }
    });
    return { status: "inspection-only", documentVersion: 1, snapshot, mediaReferences, omittedOptionalPaths };
}
