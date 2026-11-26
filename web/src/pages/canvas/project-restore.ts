import type { DraftAccountScope } from "../../services/saas/drafts";
import type { JsonObject } from "../../../../packages/shared/src/index";
import { inspectCanvasDocument } from "../../services/saas/canvas-document";
import { CloudMediaHydrationError, hydrateCanvasCloudMediaDocument, revokeCloudMediaObjectUrls, type CanvasCloudMediaHydrator } from "../../services/saas/cloud-media-hydration";

/** The page owns returned preview URLs until they are adopted or discarded. */
export async function loadProjectCloudMedia<T>(project: T, isCurrent: () => boolean, media?: CanvasCloudMediaHydrator): Promise<{ project: T; objectUrls: readonly string[] }> {
    let hasCloudMedia = false;
    try { hasCloudMedia = inspectCanvasDocument(project as unknown as JsonObject).mediaReferences.some((reference) => reference.kind === "cloud-media"); }
    catch { /* Keep malformed/local document handling in the existing restore path. */ }
    if (!hasCloudMedia) return { project, objectUrls: [] };
    // Disabled cloud access must use the existing failure UI, not stale previews.
    if (!media) throw new CloudMediaHydrationError("invalid_response");
    // A failed cloud read must reach the restore failure UI, even when the
    // local account has not rechecked its session yet. Never adopt old blob URLs.
    const hydrated = await hydrateCanvasCloudMediaDocument(project as unknown as JsonObject, media);
    if (!isCurrent()) {
        revokeCloudMediaObjectUrls(hydrated.objectUrls);
        throw new Error("canvas restore canceled");
    }
    return { project: hydrated.document as unknown as T, objectUrls: hydrated.objectUrls };
}

/** Route changes must stop old render state being saved under the new project ID. */
export function isProjectRestored(loadedProjectId: string | null, projectId: string) {
    return loadedProjectId !== null && loadedProjectId === projectId;
}

/** Cancels application, not in-flight I/O; the caller still owns temporary media cleanup. */
export function startProjectRestore<T>(load: (isCurrent: () => boolean) => Promise<T>, apply: (value: T) => void, onError: () => void,
    scope?: { getScope: () => DraftAccountScope | null; discard: (value: T) => void }) {
    let active = true;
    const initial = scope?.getScope();
    const bound = initial ? { ...initial } : null;
    const isCurrent = () => {
        if (!active) return false;
        if (!scope) return true;
        const current = scope.getScope();
        return Boolean(bound && current && bound.accountId === current.accountId && bound.epoch === current.epoch);
    };
    const settled = (async () => {
        try {
            if (!isCurrent()) throw new Error("canvas restore scope changed");
            const value = await load(isCurrent);
            if (!isCurrent()) {
                scope?.discard(value);
                if (active) onError();
                return;
            }
            apply(value);
        } catch {
            if (active) onError();
        }
    })();
    return { settled, cancel: () => { active = false; } };
}
