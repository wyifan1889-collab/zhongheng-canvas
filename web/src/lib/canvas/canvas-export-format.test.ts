import { describe, expect, test } from "bun:test";

import { CanvasExportFormatError, parseCanvasExportFile, validateCanvasExportArchive } from "./canvas-export-format";

function project() {
    return {
        id: "project-1",
        title: "备份",
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
        nodes: [],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

function manifest(path = "projects/project-1/files/image_primary.png", bytes = 4) {
    return {
        app: "infinite-canvas",
        version: 3,
        exportedAt: "2026-10-10T00:00:00.000Z",
        projects: [{ project: project(), files: [{ storageKey: "image:primary", path, mimeType: "image/png", bytes }] }],
    };
}

describe("canvas export package validation", () => {
    test("accepts a valid manifest and archive without changing the document", () => {
        const source = manifest();
        const before = structuredClone(source);
        const data = parseCanvasExportFile(source);
        expect(source).toEqual(before);
        validateCanvasExportArchive(data, new Map([["projects/project-1/files/image_primary.png", new Blob(["test"], { type: "image/png" })]]));
        expect(data.projects).toHaveLength(1);
    });

    test("rejects malformed project data before import", () => {
        expect(() => parseCanvasExportFile({ ...manifest(), projects: [{ project: { ...project(), viewport: {} }, files: [] }] })).toThrow(CanvasExportFormatError);
        expect(() => parseCanvasExportFile({ ...manifest(), version: 2 })).toThrow(CanvasExportFormatError);
    });

    test("rejects traversal, duplicate, and cross-project media paths", () => {
        expect(() => parseCanvasExportFile(manifest("projects/project-1/files/../escape.bin"))).toThrow(CanvasExportFormatError);
        expect(() =>
            parseCanvasExportFile({
                ...manifest(),
                projects: [
                    {
                        project: project(),
                        files: [
                            { storageKey: "image:a", path: "projects/project-1/files/a", mimeType: "image/png", bytes: 1 },
                            { storageKey: "image:b", path: "projects/project-1/files/a", mimeType: "image/png", bytes: 1 },
                        ],
                    },
                ],
            }),
        ).toThrow(CanvasExportFormatError);
        expect(() => parseCanvasExportFile(manifest("projects/other/files/image.png"))).toThrow(CanvasExportFormatError);
    });

    test("rejects missing or truncated media and unsafe archive entries", () => {
        const data = parseCanvasExportFile(manifest());
        expect(() => validateCanvasExportArchive(data, new Map())).toThrow(CanvasExportFormatError);
        expect(() => validateCanvasExportArchive(data, new Map([["projects/project-1/files/image_primary.png", new Blob(["x"])]]))).toThrow(CanvasExportFormatError);
        expect(() =>
            validateCanvasExportArchive(
                data,
                new Map([
                    ["projects/project-1/files/image_primary.png", new Blob(["test"])],
                    ["../unexpected", new Blob(["x"])],
                ]),
            ),
        ).toThrow(CanvasExportFormatError);
    });
});
