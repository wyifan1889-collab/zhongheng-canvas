import type { CloudCanvasWorkspaceState } from "./cloud-canvas-workspace";

/** Permission failures may retain recovery content; retained access is not current authority. */
export function canvasSharingView(workspace: Pick<CloudCanvasWorkspaceState, "phase" | "access" | "currentProject">): "manage" | "information" | null {
    if (!workspace.currentProject || !workspace.access || !["ready", "saving", "conflict"].includes(workspace.phase)) return null;
    return workspace.access.role === "owner" ? "manage" : "information";
}
