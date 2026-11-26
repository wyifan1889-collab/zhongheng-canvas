import { create } from "zustand";
import localforage from "localforage";

import type { DraftAccountScope } from "@/services/saas/drafts";
import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import { useAgentStore, type AgentAttachment, type AgentPermissionMode, type AgentReasoningEffort } from "@/stores/use-agent-store";
import { useAccountStore } from "@/stores/use-account-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import type { AgentSkillSummary } from "@/services/api/canvas-agent";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { countAgentDraftReferences } from "@/lib/agent/message-references";
import { CREATION_DRAFT_REFERENCE_LIMIT, creationReferenceSendIssue } from "@/lib/creation-reference-limits";
import { isAgentCreationOrigin } from "@/lib/creation-routes";

export type CreationAgentDraft = {
    prompt: string;
    attachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    skillRevision: number;
    model: string;
    reasoningEffort: AgentReasoningEffort | "";
    permissionMode: AgentPermissionMode;
};
export type CreationAgentConnection = { url: string; token: string; enabled: boolean; workspacePath: string; threadId: string; conversationId: string };
export type CreationAgentComposerActions = {
    addFiles: (files: FileList | File[] | null) => void | Promise<void>;
    removeAttachment: (id: string) => void;
    stop: () => void | Promise<void>;
    changePermissionMode: (mode: AgentPermissionMode) => void;
    unavailableReason: () => string | null;
    send: () => Promise<void>;
};
type Launch = {
    nonce: string;
    scope: DraftAccountScope;
    projectId: string;
    originKey: string;
    draft: CreationAgentDraft;
    connection: CreationAgentConnection;
    arrived: boolean;
};
export type CreationAgentRuntime = {
    scope: DraftAccountScope | null;
    pathname: string;
    search?: string;
    locationKey: string;
    projectId: string | null;
    draft: CreationAgentDraft;
    connection: CreationAgentConnection;
};
type CreationAgentLaunchStore = {
    actions: CreationAgentComposerActions | null;
    pending: Launch | null;
    notice: string;
    draftScope: DraftAccountScope | null;
    draftReady: boolean;
    draftLoading: boolean;
    draftRevision: number;
    draftError: string;
    loadDraft: (retry?: boolean) => Promise<void>;
    saveDraft: () => Promise<void>;
    inspire: (prompt: string) => Promise<boolean>;
    register: (actions: CreationAgentComposerActions) => () => void;
    stage: (launch: Omit<Launch, "arrived">) => boolean;
    sync: (runtime: CreationAgentRuntime) => string | null;
    claim: (runtime: CreationAgentRuntime, confirmation: { nonce: string; accepted: boolean; projectId: string | null }) => Launch | null;
    cancel: (notice: string) => boolean;
    setNotice: (notice: string) => void;
};

const sameScope = (left: DraftAccountScope, right: DraftAccountScope | null) => Boolean(right && left.accountId === right.accountId && left.epoch === right.epoch);
const sameConnection = (left: CreationAgentConnection, right: CreationAgentConnection) => left.url === right.url && left.token === right.token
    && left.enabled === right.enabled && left.workspacePath === right.workspacePath && left.threadId === right.threadId && left.conversationId === right.conversationId;
const sameDraft = (left: CreationAgentDraft, right: CreationAgentDraft) => left.prompt === right.prompt && left.attachments === right.attachments
    && left.canvasReferences === right.canvasReferences && left.skillRevision === right.skillRevision && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort && left.permissionMode === right.permissionMode;

function invalidReason(launch: Launch, runtime: CreationAgentRuntime) {
    if (!sameScope(launch.scope, runtime.scope)) return "账号状态已变化，已取消自动发送；原草稿已保留，请重新核对。";
    if (!sameConnection(launch.connection, runtime.connection)) return "Agent 连接或会话已变化，已取消自动发送；原草稿已保留。";
    if (!sameDraft(launch.draft, runtime.draft)) return "草稿或参数已变化，已取消自动发送；当前编辑内容已保留，请手动发送。";
    const target = `/canvas/${launch.projectId}`;
    if (runtime.pathname !== target && (launch.arrived || !isAgentCreationOrigin(runtime.pathname, runtime.search) || runtime.locationKey !== launch.originKey)) {
        return "已离开目标画布，已取消自动发送；原草稿已保留。";
    }
    return null;
}

export type CreationAgentSavedDraft = { prompt: string; attachments: AgentAttachment[]; canvasReferences: CanvasResourceReference[]; skill: AgentSkillSummary | null; autoPrompt: string };
type DraftOptions = {
    getScope: () => DraftAccountScope | null;
    current: () => CreationAgentSavedDraft;
    publish: (draft: CreationAgentSavedDraft) => void;
    storage: (scope: DraftAccountScope) => { getItem(key: string): Promise<unknown>; setItem(key: string, value: CreationAgentSavedDraft): Promise<unknown> };
};
const emptyDraft = (): CreationAgentSavedDraft => ({ prompt: "", attachments: [], canvasReferences: [], skill: null, autoPrompt: "" });
function readSavedDraft(value: unknown): CreationAgentSavedDraft {
    if (value == null) return emptyDraft();
    const draft = value as CreationAgentSavedDraft;
    if (!draft || typeof draft.prompt !== "string" || !Array.isArray(draft.attachments) || !Array.isArray(draft.canvasReferences)
        || typeof draft.autoPrompt !== "string" || draft.skill !== null && (!draft.skill || typeof draft.skill.name !== "string" || typeof draft.skill.path !== "string")) throw new Error("Agent 草稿无法读取，请保留本机数据。");
    if (draft.attachments.some(item => !item || typeof item.dataUrl !== "string" || !item.dataUrl.startsWith("data:image/"))) throw new Error("Agent 参考素材无法读取，请保留本机数据。");
    if (countAgentDraftReferences(draft) > CREATION_DRAFT_REFERENCE_LIMIT) throw new Error("Agent 草稿超过14个参考素材，请保留本机数据并移除多余素材。");
    return { ...draft, attachments: draft.attachments.map(item => ({ ...item, url: item.dataUrl })) };
}

/** Only drafts are persisted per account. A reload can never replay a homepage launch. */
export function createCreationAgentLaunchStore(options?: DraftOptions) {
    let readVersion = 0, hydration: Promise<void> | null = null, applying = false;
    const writes = new Map<string, Promise<unknown>>(), cached = new Map<string, CreationAgentSavedDraft>();
    const publish = (draft: CreationAgentSavedDraft) => { applying = true; try { options?.publish(draft); } finally { applying = false; } };
    return create<CreationAgentLaunchStore>((set, get) => ({
        actions: null, pending: null, notice: "", draftScope: null, draftReady: !options, draftLoading: false, draftRevision: 0, draftError: "",
        loadDraft(retry = false) {
            if (!options) return Promise.resolve();
            const scope = options.getScope(), previous = get();
            if (!retry && sameScope(previous.draftScope ?? { accountId: "", epoch: -1 }, scope)) return hydration ?? Promise.resolve();
            if (!scope && !previous.draftScope && !previous.draftLoading) return Promise.resolve();
            const version = ++readVersion;
            set({ draftScope: scope ? { ...scope } : null, draftReady: false, draftLoading: Boolean(scope), draftError: "", pending: null,
                draftRevision: previous.draftRevision + 1, ...(previous.pending ? { notice: "账号状态已变化，已取消自动发送；原账号草稿已单独保留。" } : {}) });
            publish(emptyDraft());
            if (!scope) { hydration = null; return Promise.resolve(); }
            const operation = (async () => {
                try {
                    await writes.get(scope.accountId)?.catch(() => {});
                    const draft = cached.get(scope.accountId) ?? readSavedDraft(await options.storage(scope).getItem("draft"));
                    if (version !== readVersion || !sameScope(scope, options.getScope())) return;
                    cached.set(scope.accountId, draft); publish(draft);
                    set({ draftLoading: false, draftReady: true });
                } catch (error) {
                    if (version === readVersion && sameScope(scope, options.getScope())) set({ draftLoading: false, draftError: error instanceof Error ? error.message : "Agent 草稿读取失败，请保留本机数据。" });
                } finally { if (version === readVersion) hydration = null; }
            })();
            hydration = operation; return operation;
        },
        async saveDraft() {
            if (!options || applying) return;
            const state = get(), scope = options.getScope();
            if (!state.draftReady || !scope || !state.draftScope || !sameScope(state.draftScope, scope)) return;
            const draft = options.current(); cached.set(scope.accountId, draft);
            set({ draftRevision: state.draftRevision + 1 });
            const saved = { ...draft, attachments: draft.attachments.map(({ url: _url, ...attachment }) => ({ ...attachment, url: attachment.dataUrl })) };
            const write = (writes.get(scope.accountId) ?? Promise.resolve()).catch(() => {}).then(() => options.storage(scope).setItem("draft", saved));
            writes.set(scope.accountId, write);
            try { await write; if (sameScope(scope, options.getScope())) set({ draftError: "" }); }
            catch { if (sameScope(scope, options.getScope())) set({ draftError: "Agent 草稿保存失败，当前输入仍在页面中，请保留此页。" }); }
        },
        async inspire(prompt) {
            const scope = options?.getScope(), loading = get().loadDraft(), revision = get().draftRevision;
            await loading;
            const state = get();
            if (!options || !scope || !sameScope(scope, options.getScope()) || !state.draftReady || state.draftError
                || revision !== state.draftRevision) return false;
            get().cancel("已填入新灵感，已取消之前的自动发送；请核对当前草稿。");
            publish({ ...options.current(), prompt, skill: null, autoPrompt: "" });
            await get().saveDraft();
            return sameScope(scope, options.getScope()) && !get().draftError;
        },
        register(actions) {
            set({ actions });
            return () => {
                if (get().actions !== actions) return;
                get().cancel("已离开 Agent 页面，已取消自动发送；原账号草稿已保留。");
                set({ actions: null });
            };
        },
        stage(launch) {
            if (get().pending || !get().draftReady || get().draftError) return false;
            try {
                const issue = creationReferenceSendIssue(countAgentDraftReferences(launch.draft), "agent");
                if (issue) { set({ notice: issue }); return false; }
            } catch (error) {
                set({ notice: error instanceof Error ? error.message : "参考素材无效，当前草稿已保留。" });
                return false;
            }
            set({ pending: { ...launch, arrived: false }, notice: "正在打开画布；画布状态确认后将由原 Agent 发送一次。" });
            return true;
        },
        sync(runtime) {
            const pending = get().pending;
            if (!pending) return null;
            const reason = invalidReason(pending, runtime);
            if (reason) { set({ pending: null, notice: reason }); return reason; }
            if (!pending.arrived && runtime.pathname === `/canvas/${pending.projectId}`) set({ pending: { ...pending, arrived: true } });
            return null;
        },
        claim(runtime, confirmation) {
            if (get().sync(runtime)) return null;
            const pending = get().pending;
            if (!pending || !confirmation.accepted || confirmation.nonce !== pending.nonce || confirmation.projectId !== pending.projectId
                || !pending.arrived || runtime.projectId !== pending.projectId || runtime.pathname !== `/canvas/${pending.projectId}`) return null;
            set({ pending: null, notice: "已交给原 Agent 发送流程，请在对话中核对受理结果。" });
            return pending;
        },
        cancel(notice) {
            if (!get().pending) return false;
            set({ pending: null, notice });
            return true;
        },
        setNotice: (notice) => set({ notice }),
    }));
}

const storage = new Map<string, ReturnType<typeof localforage.createInstance>>();
export const useCreationAgentLaunch = createCreationAgentLaunchStore({
    getScope: () => useAccountStore.getState().getDraftScope(),
    current: () => { const agent = useAgentStore.getState(), skills = useAgentSkillStore.getState(); return { prompt: agent.prompt, attachments: agent.attachments,
        canvasReferences: agent.canvasReferences, skill: skills.selectedSkill, autoPrompt: skills.autoPrompt }; },
    publish: (draft) => {
        useAgentStore.getState().setAgentState({ prompt: draft.prompt, attachments: draft.attachments, canvasReferences: draft.canvasReferences });
        const skill = useAgentSkillStore.getState();
        useAgentSkillStore.setState({ selectedSkill: draft.skill, autoPrompt: draft.autoPrompt, selectionRevision: skill.selectionRevision + 1 });
    },
    storage: (scope) => {
        const name = accountScopedStoreName("creation_agent_drafts", scope);
        let instance = storage.get(name);
        if (!instance) { instance = localforage.createInstance({ name: "infinite-canvas", storeName: name }); storage.set(name, instance); }
        return instance;
    },
});
let initialized = false;
export function initializeCreationAgentDrafts() {
    if (!initialized) {
        initialized = true;
        useAccountStore.subscribe(() => { void useCreationAgentLaunch.getState().loadDraft(); });
        useAgentStore.subscribe((state, previous) => {
            if (state.prompt !== previous.prompt || state.attachments !== previous.attachments || state.canvasReferences !== previous.canvasReferences) void useCreationAgentLaunch.getState().saveDraft();
        });
        useAgentSkillStore.subscribe((state, previous) => {
            if (state.selectedSkill !== previous.selectedSkill || state.autoPrompt !== previous.autoPrompt) void useCreationAgentLaunch.getState().saveDraft();
        });
    }
    return useCreationAgentLaunch.getState().loadDraft();
}
export async function applyCreationAgentInspiration(prompt: string) {
    void initializeCreationAgentDrafts();
    return useCreationAgentLaunch.getState().inspire(prompt);
}
