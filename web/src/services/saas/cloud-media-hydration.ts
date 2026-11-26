import type { JsonObject } from "../../../../packages/shared/src/index";
import type { CloudMedia } from "../api/media";
import { inspectCanvasDocument, type CanvasMediaReference } from "./canvas-document";
import { isCloudMediaId } from "./cloud-media-reference";

export type CanvasCloudMediaHydrator = Readonly<{
    resolve(ids: string[]): Promise<{ items: CloudMedia[]; missing: string[] }>;
    download(id: string): Promise<Blob>;
}>;

export type CloudMediaHydrationResult = Readonly<{
    document: JsonObject;
    objectUrls: readonly string[];
}>;

type HydrationErrorCode = "invalid_reference" | "missing" | "download_failed" | "invalid_response";

/** Does not expose provider details or the failing media ID to the editor. */
export class CloudMediaHydrationError extends Error {
    constructor(public readonly code: HydrationErrorCode) {
        super("云稿中的云端素材未能完整读取，当前云稿保持只读；请稍后重试或保留本机内容。");
        this.name = "CloudMediaHydrationError";
    }
}

const pointerPart = (value: string) => value.replace(/~1/g, "/").replace(/~0/g, "~");
const pointerParts = (path: string) => path.split("/").slice(1).map(pointerPart);

function atPath(value: unknown, path: string): { parent: Record<string, unknown>; key: string } | null {
    const parts = pointerParts(path);
    if (!parts.length) return null;
    let current: unknown = value;
    for (const part of parts.slice(0, -1)) {
        if (typeof current !== "object" || current === null) return null;
        current = (current as Record<string, unknown>)[part];
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    return { parent: current as Record<string, unknown>, key: parts.at(-1)! };
}

function revoke(urls: readonly string[], revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url)) {
    urls.forEach((url) => { try { revokeObjectUrl(url); } catch { /* best effort cleanup */ } });
}

function applyMediaUrl(document: JsonObject, reference: CanvasMediaReference, url: string): void {
    if (!reference.cloudMediaId) throw new CloudMediaHydrationError("invalid_reference");
    const location = atPath(document, reference.path);
    if (!location || location.parent[location.key] !== reference.cloudMediaId) throw new CloudMediaHydrationError("invalid_reference");

    // Node media uses `content`; assistant references use `dataUrl`. Keep the
    // cloudMediaId in place so a later save still sends the durable reference.
    if (Object.hasOwn(location.parent, "dataUrl") || reference.path.startsWith("/chatSessions/")) location.parent.dataUrl = url;
    else location.parent.content = url;
}

/**
 * Resolves and downloads every cloud media reference before a document is
 * exposed to the editor. A partial document is never returned.
 */
export async function hydrateCanvasCloudMediaDocument(
    source: JsonObject,
    hydrator: CanvasCloudMediaHydrator,
    createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
): Promise<CloudMediaHydrationResult> {
    let inspection: ReturnType<typeof inspectCanvasDocument>;
    try { inspection = inspectCanvasDocument(source); }
    catch { throw new CloudMediaHydrationError("invalid_reference"); }
    const references = inspection.mediaReferences.filter((reference) => reference.kind === "cloud-media");
    const ids = [...new Set(references.map((reference) => reference.cloudMediaId?.toLowerCase() ?? ""))];
    if (!ids.length) return { document: inspection.snapshot, objectUrls: [] };
    if (ids.some((id) => !isCloudMediaId(id))) throw new CloudMediaHydrationError("invalid_reference");

    let resolved: { items: CloudMedia[]; missing: string[] };
    try { resolved = await hydrator.resolve(ids); }
    catch { throw new CloudMediaHydrationError("invalid_response"); }
    const items = new Map<string, CloudMedia>();
    if (!Array.isArray(resolved.items) || !Array.isArray(resolved.missing)) throw new CloudMediaHydrationError("invalid_response");
    resolved.items.forEach((item) => {
        if (item && isCloudMediaId(item.id) && ids.includes(item.id.toLowerCase())) items.set(item.id.toLowerCase(), item);
    });
    if (resolved.missing.some((id) => ids.includes(id.toLowerCase())) || ids.some((id) => !items.has(id))) throw new CloudMediaHydrationError("missing");

    const objectUrls: string[] = [];
    const urls = new Map<string, string>();
    try {
        for (const id of ids) {
            const blob = await hydrator.download(id);
            const item = items.get(id)!;
            if (!(blob instanceof Blob) || blob.size <= 0 || blob.size !== item.sizeBytes ||
                blob.type !== item.contentType.toLowerCase()) throw new CloudMediaHydrationError("download_failed");
            const url = createObjectUrl(blob);
            if (typeof url !== "string" || !url) throw new CloudMediaHydrationError("download_failed");
            objectUrls.push(url); urls.set(id, url);
        }
        const document = JSON.parse(JSON.stringify(inspection.snapshot)) as JsonObject;
        references.forEach((reference) => applyMediaUrl(document, reference, urls.get(reference.cloudMediaId!.toLowerCase())!));
        return { document, objectUrls };
    } catch (error) {
        revoke(objectUrls, revokeObjectUrl);
        if (error instanceof CloudMediaHydrationError) throw error;
        throw new CloudMediaHydrationError("download_failed");
    }
}

export function revokeCloudMediaObjectUrls(urls: readonly string[]) { revoke(urls); }
