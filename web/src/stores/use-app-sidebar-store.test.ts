import { expect, test } from "bun:test";
import { isCanvasEditorPath, sidebarCollapsedAt, useAppSidebarStore } from "./use-app-sidebar-store";

test("manual canvas expansion does not overwrite the normal-page preference or expand another editor", () => {
    useAppSidebarStore.setState({ collapsed: false, expandedCanvasPath: null });
    const state = () => useAppSidebarStore.getState();
    expect(sidebarCollapsedAt(state(), "/")).toBe(false);
    expect(sidebarCollapsedAt(state(), "/canvas/first")).toBe(true);
    state().toggle("/canvas/first");
    expect(sidebarCollapsedAt(state(), "/canvas/first")).toBe(false);
    expect(sidebarCollapsedAt(state(), "/canvas/second")).toBe(true);
    expect(sidebarCollapsedAt(state(), "/projects")).toBe(false);
    state().toggle("/canvas/first");
    expect(sidebarCollapsedAt(state(), "/canvas/first")).toBe(true);
    state().toggle();
    expect(sidebarCollapsedAt(state(), "/projects")).toBe(true);
    state().toggle("/canvas/first"); state().resetCanvas();
    expect(sidebarCollapsedAt(state(), "/canvas/first")).toBe(true);
    expect(sidebarCollapsedAt(state(), "/projects")).toBe(true);
});

test("library and invitation routes remain normal pages rather than locked editor layouts", () => {
    expect(isCanvasEditorPath("/canvas")).toBe(false);
    expect(isCanvasEditorPath("/projects")).toBe(false);
    expect(isCanvasEditorPath("/canvas/join/invite")).toBe(false);
    expect(isCanvasEditorPath("/canvas/local-id/")).toBe(true);
    expect(isCanvasEditorPath("/canvas/00000000-0000-4000-8000-000000000001")).toBe(true);
});
