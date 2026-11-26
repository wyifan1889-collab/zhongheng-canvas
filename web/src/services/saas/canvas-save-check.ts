import type { JsonValue } from "../../../../packages/shared/src/index";
import { inspectCanvasDocument } from "./canvas-document";

export type CanvasSaveCheck =
    | { status: "checked"; nodes: number; connections: number; chats: number; localMediaReferences: number; omittedOptionalFields: number }
    | { status: "unavailable" };

/** Only retain counts for the UI, never project contents, paths, URLs or raw errors. */
export function checkCanvasSave(project: unknown): CanvasSaveCheck {
    try {
        const inspection = inspectCanvasDocument(project);
        return {
            status: "checked",
            nodes: (inspection.snapshot.nodes as JsonValue[]).length,
            connections: (inspection.snapshot.connections as JsonValue[]).length,
            chats: (inspection.snapshot.chatSessions as JsonValue[]).length,
            localMediaReferences: inspection.mediaReferences.length,
            omittedOptionalFields: inspection.omittedOptionalPaths.length,
        };
    } catch {
        return { status: "unavailable" };
    }
}
