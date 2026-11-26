import { inspectCanvasDocument } from "@/services/saas/canvas-document";
import type { CanvasExportFile, CanvasExportAsset } from "@/types/canvas-export";

const unsafePathSegment = /(^|\/)(?:\.{1,2})(?:\/|$)/;

export class CanvasExportFormatError extends Error {
    constructor(message = "Invalid canvas export package") {
        super(message);
        this.name = "CanvasExportFormatError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, message: string): string {
    if (typeof value !== "string" || !value.trim()) throw new CanvasExportFormatError(message);
    return value;
}

function assertSafeArchivePath(path: string) {
    if (!path || path.startsWith("/") || path.includes("\\") || unsafePathSegment.test(path) || /[\u0000-\u001f\u007f]/.test(path)) {
        throw new CanvasExportFormatError("Unsafe archive path");
    }
}

function validateAsset(value: unknown, projectId: string): CanvasExportAsset {
    if (!isRecord(value)) throw new CanvasExportFormatError("Invalid media entry");
    const storageKey = requireString(value.storageKey, "Invalid media storage key");
    const path = requireString(value.path, "Invalid media path");
    const mimeType = requireString(value.mimeType, "Invalid media type");
    if (!storageKey.includes(":")) throw new CanvasExportFormatError("Invalid media storage key");
    assertSafeArchivePath(path);
    if (!path.startsWith(`projects/${projectId}/files/`) || path.endsWith("/")) throw new CanvasExportFormatError("Media path does not belong to its project");
    if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) throw new CanvasExportFormatError("Invalid media size");
    return { storageKey, path, mimeType, bytes: value.bytes as number };
}

/**
 * Validates the JSON manifest before it is allowed to mutate local storage.
 * The project validator is intentionally shared with cloud-save preflight so
 * backup/restore cannot accept a weaker document shape than cloud persistence.
 */
export function parseCanvasExportFile(value: unknown): CanvasExportFile {
    if (!isRecord(value) || value.app !== "infinite-canvas" || value.version !== 3 || typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt)) || !Array.isArray(value.projects)) {
        throw new CanvasExportFormatError("Invalid canvas export manifest");
    }
    const seenPaths = new Set<string>();
    const projects = value.projects.map((item) => {
        if (!isRecord(item) || !isRecord(item.project) || !Array.isArray(item.files)) throw new CanvasExportFormatError("Invalid canvas project entry");
        let inspection: ReturnType<typeof inspectCanvasDocument>;
        try {
            inspection = inspectCanvasDocument(item.project, 1);
        } catch {
            throw new CanvasExportFormatError("Invalid canvas project");
        }
        const projectId = typeof item.project.id === "string" ? item.project.id : "";
        if (!projectId || projectId.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(projectId)) throw new CanvasExportFormatError("Canvas project has an invalid id");
        const files = item.files.map((asset) => {
            const validated = validateAsset(asset, projectId);
            if (seenPaths.has(validated.path)) throw new CanvasExportFormatError("Duplicate media path");
            seenPaths.add(validated.path);
            return validated;
        });
        // Keep the original JSON object for importProject; inspection is a
        // read-only check and deliberately does not rewrite extension fields.
        void inspection;
        return { project: item.project as CanvasExportFile["projects"][number]["project"], files };
    });
    return { app: "infinite-canvas", version: 3, exportedAt: value.exportedAt, projects };
}

/** Ensures every manifest reference is present and has the declared size. */
export function validateCanvasExportArchive(data: CanvasExportFile, archive: ReadonlyMap<string, Blob>) {
    for (const [name, file] of archive) {
        assertSafeArchivePath(name);
        if (name !== "projects.json" && !(file instanceof Blob)) throw new CanvasExportFormatError("Invalid archive entry");
    }
    for (const project of data.projects)
        for (const asset of project.files) {
            const blob = archive.get(asset.path);
            if (!blob || blob.size !== asset.bytes) throw new CanvasExportFormatError("Missing or truncated media entry");
        }
}
