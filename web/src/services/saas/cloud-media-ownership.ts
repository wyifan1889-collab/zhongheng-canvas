import { isCloudMediaId } from "./cloud-media-reference";
import type { CanvasMediaReference } from "./canvas-document";

export type CanvasCloudMediaResolver = {
    resolve(ids: string[]): Promise<{ items: ReadonlyArray<{ id: string }>; missing: ReadonlyArray<string> }>;
};

export class CanvasCloudMediaOwnershipError extends Error {
    constructor() {
        super("cloud media ownership could not be confirmed");
        this.name = "CanvasCloudMediaOwnershipError";
    }
}

/**
 * A cloud-media ID is usable in a cloud document only after the current
 * account has proved ownership. This helper deliberately keeps the response
 * contract to IDs; provider keys and URLs never cross into the document saver.
 */
export async function verifyCanvasCloudMediaOwnership(
    references: ReadonlyArray<CanvasMediaReference>,
    resolver: CanvasCloudMediaResolver | undefined,
): Promise<void> {
    const ids = [...new Set(references
        .filter((reference) => reference.kind === "cloud-media")
        .map((reference) => reference.cloudMediaId?.toLowerCase() ?? ""))];
    if (!ids.length) return;
    if (ids.some((id) => !isCloudMediaId(id))) throw new CanvasCloudMediaOwnershipError();
    if (!resolver) throw new CanvasCloudMediaOwnershipError();
    let result: Awaited<ReturnType<CanvasCloudMediaResolver["resolve"]>>;
    try { result = await resolver.resolve(ids); } catch { throw new CanvasCloudMediaOwnershipError(); }
    if (!result || !Array.isArray(result.items) || !Array.isArray(result.missing)) throw new CanvasCloudMediaOwnershipError();
    const requested = new Set(ids);
    const owned = new Set<string>();
    for (const item of result.items) {
        if (!item || typeof item.id !== "string" || !isCloudMediaId(item.id) || !requested.has(item.id.toLowerCase())) {
            throw new CanvasCloudMediaOwnershipError();
        }
        owned.add(item.id.toLowerCase());
    }
    for (const missing of result.missing) {
        if (typeof missing !== "string" || !isCloudMediaId(missing) || !requested.has(missing.toLowerCase())) {
            throw new CanvasCloudMediaOwnershipError();
        }
    }
    if (ids.some((id) => !owned.has(id))) throw new CanvasCloudMediaOwnershipError();
}
