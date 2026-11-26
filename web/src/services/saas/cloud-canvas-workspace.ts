import type { CanvasDraft, JsonObject } from "../../../../packages/shared/src/index";
import type { CanvasProject } from "../../stores/canvas/use-canvas-store";
import { blockTextTargetsForMount } from "../../lib/canvas/platform-text-target";
import { blockTextConfigTargetsForMount } from "../../lib/canvas/platform-text-config";
import { stripImageTarget } from "../../lib/canvas/platform-image-target";
import { CloudMediaError, createMediaClient } from "../api/media";
import { inspectCanvasDocument, prepareCanvasDocumentForCloudSave } from "./canvas-document";
import { validateCanvasDocumentMount } from "./canvas-document-mount";
import { verifyCanvasCloudMediaOwnership, type CanvasCloudMediaResolver } from "./cloud-media-ownership";
import type { CanvasCloudMediaHydrator } from "./cloud-media-hydration";
import { createDraftClient, DraftError, type CanvasDraftAccess, type DraftAccountScope } from "./drafts";

export type CloudCanvasContext = DraftAccountScope & { cloudCanvas: boolean; cloudMedia: boolean };
export type CloudCanvasWorkspaceState = Readonly<{
    phase: "loading" | "ready" | "saving" | "conflict" | "unknown" | "blocked" | "error";
    sourceProject: CanvasProject | null;
    currentProject: CanvasProject | null;
    access: CanvasDraftAccess | null;
    revision: number | null;
    lastSavedAt: string | null;
    accessGeneration: number;
    canEdit: boolean;
    canSave: boolean;
    dirty: boolean;
    error: string;
    media: CanvasCloudMediaHydrator | null;
}>;
type DraftClient = Pick<ReturnType<typeof createDraftClient>, "getWithAccess" | "save">;
type Patch = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>;
type Options = {
    clientFactory?: (getScope: () => DraftAccountScope | null) => DraftClient;
    mediaFactory?: (getScope: () => DraftAccountScope | null, canvasId: string, isCurrent: () => boolean) => CanvasCloudMediaHydrator;
    ownMediaFactory?: (getScope: () => DraftAccountScope | null) => CanvasCloudMediaResolver;
};
const copy = <T>(value: T): T => structuredClone(value);
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const permissionFailure = (error: unknown) => error instanceof DraftError && (error.status === 401 || error.status === 404 || error.code === "permission_denied" || error.code === "account_changed" || error.code === "account_context_required");

/** One cloud route lifetime. It never reads or writes the ordinary local artwork store. */
export function createCloudCanvasWorkspace(canvasId: string, getContext: () => CloudCanvasContext | null, options: Options = {}) {
    const id = canvasId.toLowerCase(), bound = getContext();
    let active = true, loaded = false, reading = false, terminal = false, operation = 0, lifetime = 0;
    let state: CloudCanvasWorkspaceState = { phase: "loading", sourceProject: null, currentProject: null, access: null,
        revision: null, lastSavedAt: null, accessGeneration: 0, canEdit: false, canSave: false, dirty: false, error: "", media: null };
    const listeners = new Set<() => void>();
    let authoritativeMedia = new Set<string>();
    let baselineContent: string | null = "", editVersion = 0;
    function contentKey(project: unknown): string | null {
        // Cloud-preview blob URLs and updatedAt are view details, not unsaved edits.
        try {
            const document = prepareCanvasDocumentForCloudSave(inspectCanvasDocument(project)).snapshot;
            const { updatedAt: _updatedAt, ...body } = document;
            return JSON.stringify(body);
        } catch { return null; } // Invalid plugin edits stay dirty and can be repaired before a save.
    }
    function publish(patch: Partial<CloudCanvasWorkspaceState>) {
        const next = { ...state, ...patch };
        const editable = active && !terminal && next.phase !== "loading" && next.phase !== "error" &&
            !!next.currentProject && !!next.access && next.access.role !== "viewer";
        state = { ...next, canEdit: editable, canSave: editable && !reading && next.phase === "ready" };
        listeners.forEach((notify) => notify());
    }
    function contextCurrent() {
        const current = getContext();
        return active && !!bound && !!current && current.accountId === bound.accountId && current.epoch === bound.epoch &&
            bound.cloudCanvas && current.cloudCanvas && bound.cloudMedia === current.cloudMedia;
    }
    function invalidate(clear = false) {
        terminal = true;
        publish({ phase: "blocked", accessGeneration: state.accessGeneration + 1, media: null,
            error: clear ? "账户状态已变化，请重新打开共享画布。" : "画布访问权限未能确认，编辑和保存已暂停。请保留当前修改并重新核对。",
            ...(clear ? { sourceProject: null, currentProject: null, access: null, revision: null, lastSavedAt: null, dirty: false } : {}) });
    }
    function assertCurrent() {
        if (!contextCurrent()) {
            if (active) invalidate(true);
            throw new DraftError("account_changed", "账号或画布会话已变化，本次结果未采用。", 0, "not-sent");
        }
    }
    const scope = () => contextCurrent() && bound ? { accountId: bound.accountId, epoch: bound.epoch } : null;
    const client = (options.clientFactory ?? createDraftClient)(scope);
    function makeMedia(generation: number): CanvasCloudMediaHydrator | null {
        if (!bound?.cloudMedia) return null;
        const current = () => contextCurrent() && !terminal && generation === state.accessGeneration;
        return options.mediaFactory?.(scope, id, current) ?? createMediaClient(() => current() ? scope()?.accountId ?? null : null,
            fetch, { canvasId: id, isCurrent: current });
    }
    function checkedProject(draft: CanvasDraft): CanvasProject {
        if (draft.id.toLowerCase() !== id || draft.documentVersion !== 1) throw new Error("invalid cloud document");
        const checked = validateCanvasDocumentMount(draft.document, draft.documentVersion);
        const project = copy(checked.project) as CanvasProject;
        // Cloud identity and local source-device identity are deliberately distinct.
        project.id = id;
        project.title = draft.title;
        project.nodes = blockTextConfigTargetsForMount(blockTextTargetsForMount(project.nodes)).map(stripImageTarget);
        return project;
    }
    async function read(initial: boolean) {
        assertCurrent();
        if (reading || (!initial && !loaded)) return;
        if (initial && loaded) return;
        if (!uuid(id)) { terminal = true; publish({ phase: "error", error: "云画布编号不正确。" }); return; }
        const request = ++operation;
        reading = true; publish({ ...(initial ? { phase: "loading" as const } : {}), ...(!terminal ? { error: "" } : {}) });
        try {
            const found = await client.getWithAccess(id);
            assertCurrent();
            if (request !== operation) return;
            if (found.access.role === "owner" && found.access.ownerId !== bound!.accountId ||
                found.access.role !== "owner" && found.access.ownerId === bound!.accountId) throw new Error("invalid canvas access");
            const oldAccess = state.access;
            if (oldAccess && oldAccess.ownerId !== found.access.ownerId) throw new Error("invalid canvas owner");
            const changed = oldAccess !== null && oldAccess.role !== found.access.role;
            const project = initial ? checkedProject(found.draft) : null;
            if (project) { baselineContent = contentKey(project); editVersion = 0; }
            authoritativeMedia = new Set(inspectCanvasDocument(found.draft.document).mediaReferences
                .filter((reference) => reference.kind === "cloud-media").map((reference) => reference.cloudMediaId!.toLowerCase()));
            loaded = true;
            reading = false;
            const generation = state.accessGeneration + (changed ? 1 : 0);
            publish({ access: { ...found.access }, accessGeneration: generation, media: !initial && !changed ? state.media : terminal ? null : makeMedia(generation),
                ...(initial ? { sourceProject: project, currentProject: project, revision: found.draft.revision, lastSavedAt: found.draft.updatedAt, phase: "ready" as const } : {}) });
        } catch (error) {
            if (!active) return;
            if (!contextCurrent()) { invalidate(true); return; }
            if (request !== operation) return;
            reading = false;
            // A failed authorization recheck cannot leave an old editor writable.
            if (!initial || permissionFailure(error)) invalidate();
            else { terminal = true; publish({ phase: "error", error: "云画布或当前成员权限未能完整读取，请重新打开。" }); }
        } finally {
            if (active && request === operation) { reading = false; publish({}); }
        }
    }
    return Object.freeze({
        getState: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        load() {
            // React development StrictMode runs setup/cleanup/setup on one memo.
            // Each setup gets a fresh read; disposed operations retain old serials.
            if (!active) {
                active = true; terminal = false; loaded = false;
                state = { phase: "loading", sourceProject: null, currentProject: null, access: null, revision: null, lastSavedAt: null,
                    accessGeneration: state.accessGeneration + 1, canEdit: false, canSave: false, dirty: false, error: "", media: null };
            }
            return read(true);
        },
        recheck: () => read(false),
        openProject(projectId: string) { return projectId.toLowerCase() === id && contextCurrent() ? state.currentProject : null; },
        updateProject(projectId: string, patch: Patch) {
            assertCurrent();
            if (projectId.toLowerCase() !== id || !state.canEdit || !state.currentProject) return;
            const next = { ...state.currentProject, ...patch, id, updatedAt: new Date().toISOString() };
            const nextContent = contentKey(next);
            if (nextContent !== null && nextContent === contentKey(state.currentProject)) return;
            editVersion++;
            publish({ currentProject: next, dirty: nextContent === null || nextContent !== baselineContent });
        },
        renameProject(projectId: string, title: string) {
            assertCurrent();
            if (projectId.toLowerCase() !== id || !state.canEdit || !state.currentProject || !title.trim()) return;
            if (title.trim() === state.currentProject.title) return;
            const next = { ...state.currentProject, title: title.trim(), updatedAt: new Date().toISOString() };
            editVersion++;
            publish({ currentProject: next, dirty: contentKey(next) !== baselineContent });
        },
        async save(snapshot: unknown): Promise<CanvasDraft> {
            assertCurrent();
            if (!state.canSave || state.revision === null) {
                const error = new DraftError("permission_denied", "当前画布只可查看或核对，不能保存。", 403, "not-sent");
                publish({ error: error.message }); throw error;
            }
            let inspection: ReturnType<typeof prepareCanvasDocumentForCloudSave>;
            try {
                inspection = prepareCanvasDocumentForCloudSave(inspectCanvasDocument(snapshot));
                if (inspection.snapshot.id !== id || inspection.mediaReferences.some((reference) => reference.kind !== "cloud-media")) throw new Error();
            } catch {
                const error = new DraftError("invalid_input", "画布格式或素材尚不符合云保存要求，请先保留并处理本机素材、外部地址和未完成任务。", 400, "not-sent");
                publish({ error: error.message }); throw error;
            }
            const revision = state.revision, generation = state.accessGeneration, saveLifetime = lifetime, submittedVersion = editVersion;
            const submittedContent = contentKey(inspection.snapshot);
            const assertWrite = (outcome: "not-sent" | "unknown") => {
                assertCurrent();
                if (saveLifetime !== lifetime || terminal || state.access?.role === "viewer" || generation !== state.accessGeneration) {
                    throw new DraftError("permission_denied", "画布权限已变化，本次保存返回未采用；请保留修改并主动核对。", 403, outcome);
                }
            };
            publish({ phase: "saving", error: "", dirty: state.dirty || submittedContent !== baselineContent });
            let sent = false, mediaPermissionRejected = false;
            try {
                const existing = inspection.mediaReferences.filter((reference) => authoritativeMedia.has(reference.cloudMediaId?.toLowerCase() ?? ""));
                const added = inspection.mediaReferences.filter((reference) => !authoritativeMedia.has(reference.cloudMediaId?.toLowerCase() ?? ""));
                await verifyCanvasCloudMediaOwnership(existing, state.media ? { resolve: async (ids) => {
                    try { return await state.media!.resolve(ids); }
                    catch (error) {
                        mediaPermissionRejected = error instanceof CloudMediaError && (error.status === 401 || error.status === 404 || error.code === "account_changed");
                        throw error;
                    }
                } } : undefined);
                assertWrite("not-sent");
                const own = (options.ownMediaFactory ?? ((getScope) => createMediaClient(() => getScope()?.accountId ?? null)))(() => {
                    try { assertWrite("not-sent"); return scope(); } catch { return null; }
                });
                await verifyCanvasCloudMediaOwnership(added, own);
                assertWrite("not-sent");
                sent = true;
                const saved = await client.save(id, { title: inspection.snapshot.title as string, documentVersion: 1,
                    document: inspection.snapshot as JsonObject, expectedRevision: revision });
                assertWrite("unknown");
                if (saved.revision !== revision + 1) throw new DraftError("unavailable", "保存结果尚未确认，请保留修改并主动核对。", 0, "unknown");
                authoritativeMedia = new Set(inspection.mediaReferences.map((reference) => reference.cloudMediaId!.toLowerCase()));
                baselineContent = submittedContent;
                // Later local edits remain in memory; only this submitted baseline advances.
                publish({ revision: saved.revision, lastSavedAt: saved.updatedAt, phase: "ready", dirty: editVersion !== submittedVersion && contentKey(state.currentProject) !== baselineContent });
                return saved;
            } catch (error) {
                if (!active || saveLifetime !== lifetime) throw error;
                if (!contextCurrent()) { invalidate(true); throw error; }
                if (!sent && !terminal && !mediaPermissionRejected && generation === state.accessGeneration && state.access?.role !== "viewer") {
                    publish({ phase: "ready", error: "本次未发送保存；云端素材未能完整核对，请修正素材或稍后手动重试。" });
                    throw error;
                }
                if (!terminal && error instanceof DraftError && error.outcome === "rejected" && !permissionFailure(error) && error.code !== "revision_conflict") {
                    publish({ phase: "ready", error: error.message }); throw error;
                }
                terminal = true;
                const phase = error instanceof DraftError && error.code === "revision_conflict" ? "conflict"
                    : sent && (!(error instanceof DraftError) || error.outcome === "unknown") ? "unknown" : "blocked";
                publish({ phase, error: error instanceof DraftError ? error.message : "素材或保存结果未能确认，请保留当前修改；不会自动重新提交。" });
                throw error;
            }
        },
        dispose() {
            active = false; operation++; lifetime++; reading = false; terminal = true;
            state = { ...state, sourceProject: null, currentProject: null, access: null, media: null, lastSavedAt: null, canEdit: false, canSave: false, dirty: false, phase: "blocked" };
        },
    });
}
