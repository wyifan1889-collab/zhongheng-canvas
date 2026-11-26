import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { CANVAS_STORE_KEY, CanvasStorageConflict, createCanvasDatabase, createCanvasPersistence, type CanvasSaveStatus, type CanvasSnapshot } from "./canvas-persistence";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[], expected?: CanvasSnapshot) => Promise<void>;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
export const useCanvasSaveStatus = create<CanvasSaveStatus>(() => ({ phase: "loading" }));
const canvasPersistence = createCanvasPersistence(createCanvasDatabase(), (status) => useCanvasSaveStatus.setState(status, true));
export const flushCanvasStorage = canvasPersistence.flush;
/** Confirm the recovery copy's transaction before the editor may replace its view. */
export async function saveCanvasMountRecovery(source: Partial<CanvasProject>): Promise<string> {
    await flushCanvasStorage();
    const id = useCanvasStore.getState().importProject({ ...structuredClone(source), title: `${source.title || "当前画布"}（挂载前恢复副本）` });
    await flushCanvasStorage();
    return id;
}
export function getCanvasRecoveryProjects() {
    const projects = useCanvasStore.getState().projects;
    const recovery = canvasPersistence.recoveryProjects().filter((old) => !projects.some((item) => JSON.stringify(item) === JSON.stringify(old)));
    return [...projects, ...recovery.map((project, index) => ({ ...project, id: `${project.id}-recovery-${index}`, title: `${project.title}（操作前恢复副本）` }))];
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            deletedProjects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                })),
            deleteProjects: (ids) =>
                set((state) => {
                    const now = new Date().toISOString();
                    const removing = new Set(ids);
                    canvasPersistence.retain(state.projects.filter((project) => removing.has(project.id)));
                    const projects = state.projects.filter((project) => !removing.has(project.id));
                    const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
                    return { projects, deletedProjects };
                }),
            replaceProjects: async (projects, deletedProjects = [], expected) => {
                if (expected && (get().projects !== expected.projects || get().deletedProjects !== expected.deletedProjects)) {
                    throw new CanvasStorageConflict();
                }
                await flushCanvasStorage();
                if (expected && (get().projects !== expected.projects || get().deletedProjects !== expected.deletedProjects)) {
                    throw new CanvasStorageConflict();
                }
                canvasPersistence.retain(get().projects);
                set({ projects, deletedProjects });
                await flushCanvasStorage();
            },
            updateProject: (id, patch) =>
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                })),
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasPersistence.storage as PersistStorage<CanvasStore>,
            partialize: (state) =>
                ({
                    projects: state.projects,
                    deletedProjects: state.deletedProjects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                if (!error) useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);
