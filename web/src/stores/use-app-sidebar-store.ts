import { create } from "zustand";
import { useLocation } from "react-router-dom";

const preferenceKey = "canvas-app-sidebar-collapsed";
const readCollapsed = () => { try { return localStorage.getItem(preferenceKey) === "true"; } catch { return false; } };
export const isCanvasEditorPath = (pathname: string) => /^\/canvas\/[^/]+\/?$/.test(pathname);
type SidebarLayout = { collapsed: boolean; expandedCanvasPath: string | null };
export const sidebarCollapsedAt = (state: SidebarLayout, pathname: string) => isCanvasEditorPath(pathname) ? state.expandedCanvasPath !== pathname : state.collapsed;

/** Only the normal-page preference persists; an editor always starts compact. */
export const useAppSidebarStore = create<SidebarLayout & { toggle: (pathname?: string) => void; resetCanvas: () => void }>((set) => ({
    collapsed: readCollapsed(), expandedCanvasPath: null,
    toggle: (pathname) => set((state) => {
        if (pathname && isCanvasEditorPath(pathname)) return { expandedCanvasPath: state.expandedCanvasPath === pathname ? null : pathname };
        const collapsed = !state.collapsed;
        try { localStorage.setItem(preferenceKey, String(collapsed)); } catch { /* In-memory layout remains usable. */ }
        return { collapsed };
    }),
    resetCanvas: () => set({ expandedCanvasPath: null }),
}));

export function useAppSidebarCollapsed() {
    const { pathname } = useLocation();
    return useAppSidebarStore((state) => sidebarCollapsedAt(state, pathname));
}
