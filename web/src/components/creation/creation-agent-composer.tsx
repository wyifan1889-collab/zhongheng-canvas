import { Alert, App, Button } from "@/components/creation/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PlugZap, Sparkles } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { AgentChatComposer } from "@/components/agent/agent-chat-composer";
import { agentAttachmentToChatAttachment } from "@/components/agent/agent-event-formatters";
import { normalizeAgentDraftReferences } from "@/lib/agent/message-references";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAccountStore } from "@/stores/use-account-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { initializeCreationAgentDrafts, useCreationAgentLaunch, type CreationAgentDraft } from "@/stores/use-creation-agent-launch";
import { useThemeStore } from "@/stores/use-theme-store";

export function CreationAgentComposer({ modeTabs }: { modeTabs?: ReactNode }) {
    const { message } = App.useApp(), navigate = useNavigate(), location = useLocation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const account = useAccountStore(), scope = account.getDraftScope();
    const agent = useAgentStore(useShallow((state) => ({ prompt: state.prompt, attachments: state.attachments, connected: state.connected,
        sending: state.sending, waiting: state.waiting, loadingThreads: state.loadingThreads, conversation: state.conversation,
        models: state.models, model: state.model, reasoningEffort: state.reasoningEffort, permissionMode: state.permissionMode,
        confirmTools: state.confirmTools, autoConfirm: state.autoConfirm, autoConfirmOwnerContext: state.autoConfirmOwnerContext,
        url: state.url, token: state.token, setAgentState: state.setAgentState })));
    const { actions, pending, notice, draftReady, draftLoading, draftError } = useCreationAgentLaunch();
    const startingRef = useRef(false), mountedRef = useRef(true), [starting, setStarting] = useState(false);
    useEffect(() => { mountedRef.current = true; void initializeCreationAgentDrafts(); return () => { mountedRef.current = false; }; }, []);
    const openSetup = () => { useAgentStore.getState().setAgentState({ activeTab: "setup" }); useAgentStore.getState().openPanel(); };
    const warn = (text: string) => { useCreationAgentLaunch.getState().setNotice(text); message.warning(text); };

    const submit = async () => {
        const current = useAgentStore.getState(), currentScope = useAccountStore.getState().getDraftScope();
        if (startingRef.current || useCreationAgentLaunch.getState().pending) return;
        if (!currentScope) { warn("请先确认登录账号，当前草稿已保留。"); return; }
        if (!actions || !current.connected) { warn("请先连接 AI，当前草稿已保留；连接完成后请再次点击发送。"); openSetup(); return; }
        const unavailable = actions.unavailableReason();
        if (unavailable) { warn(unavailable); return; }
        try { normalizeAgentDraftReferences({ attachments: current.attachments, canvasReferences: current.canvasReferences }); }
        catch (error) { warn(error instanceof Error ? error.message : "参考素材无效，当前草稿已保留。"); return; }
        if (!(current.prompt.trim() || current.attachments.length || current.canvasReferences.length)) return;
        if (current.canvasReferences.length) { warn("当前草稿含其他画布的引用，请回到原画布发送，或移除引用后再创建新画布；草稿已保留。"); return; }
        if (!draftReady || draftError) { warn(draftError || "当前账号草稿仍在加载，请稍后发送。"); return; }
        const canvas = useCanvasStore.getState();
        if (!canvas.hydrated) { warn("本地画布仍在加载，当前草稿已保留，请稍后重试。"); return; }
        const draft: CreationAgentDraft = { prompt: current.prompt, attachments: current.attachments, canvasReferences: current.canvasReferences,
            skillRevision: useAgentSkillStore.getState().selectionRevision, model: current.model, reasoningEffort: current.reasoningEffort, permissionMode: current.permissionMode };
        startingRef.current = true; setStarting(true);
        try {
            const saving = useCreationAgentLaunch.getState().saveDraft(), revision = useCreationAgentLaunch.getState().draftRevision;
            await saving;
            if (!mountedRef.current) return;
            const latest = useAccountStore.getState().getDraftScope(), state = useAgentStore.getState(), launch = useCreationAgentLaunch.getState();
            if (!latest || latest.accountId !== currentScope.accountId || latest.epoch !== currentScope.epoch || launch.draftRevision !== revision
                || launch.draftError || state.prompt !== draft.prompt || state.attachments !== draft.attachments || state.canvasReferences !== draft.canvasReferences
                || useAgentSkillStore.getState().selectionRevision !== draft.skillRevision || state.model !== draft.model || state.reasoningEffort !== draft.reasoningEffort
                || state.permissionMode !== draft.permissionMode || state.url !== current.url || state.token !== current.token || state.activeThreadId !== current.activeThreadId
                || state.conversation.conversationId !== current.conversation.conversationId || !state.connected) {
                warn(launch.draftError || "草稿、账号或连接已变化，当前内容已保留，请重新核对后发送。"); return;
            }
            const unavailable = actions.unavailableReason();
            if (unavailable) { warn(unavailable); return; }
            const projectId = canvas.createProject();
            if (!launch.stage({ nonce: crypto.randomUUID(), scope: currentScope, projectId, originKey: location.key, draft,
                connection: { url: current.url, token: current.token, enabled: current.enabled, workspacePath: current.workspacePath,
                    threadId: current.activeThreadId, conversationId: current.conversation.conversationId } })) return;
            current.setAgentState({ activeTab: "chat" }); current.openPanel(); navigate(`/canvas/${projectId}`);
        } finally { startingRef.current = false; if (mountedRef.current) setStarting(false); }
    };

    return <div data-canvas-shortcuts-ignore>
        {draftError || notice ? <Alert className="mb-3" type={draftError ? "error" : "info"} showIcon title={draftError || notice}
            action={draftError ? <Button size="small" onClick={() => {
                const state = useCreationAgentLaunch.getState(); void (state.draftReady ? state.saveDraft() : state.loadDraft(true));
            }}>重试草稿保存</Button> : undefined} /> : null}
        <AgentChatComposer
            variant="workbench"
            workbenchParametersPopover
            modeTabs={modeTabs}
            workbenchTools={[
                { key: "skills", label: "技能", icon: <Sparkles className="size-4" />, onSelect: () => { useAgentStore.getState().setAgentState({ activeTab: "skills" }); useAgentStore.getState().openPanel(); } },
                { key: "connect", label: "连接 AI", icon: <PlugZap className="size-4" />, onSelect: openSetup },
            ]}
            prompt={agent.prompt}
            attachments={agent.attachments.map((attachment) => agentAttachmentToChatAttachment(attachment, agent.url.trim().replace(/\/$/, ""), agent.token))}
            disabled={Boolean(pending) || starting || draftLoading || !draftReady} sending={agent.sending || agent.waiting}
            placeholder="描述你的想法，输入 / 添加技能，或添加参考素材…" theme={theme}
            onPromptChange={(prompt) => agent.setAgentState({ prompt })} onSubmit={submit}
            onStop={() => { void actions?.stop(); }}
            onAddFiles={(files) => {
                if (!scope) { warn("请先确认登录账号，当前草稿已保留。"); return; }
                if (!agent.connected || !actions) { warn("连接 AI 后可以添加参考素材，当前文字草稿已保留。"); openSetup(); return; }
                return actions.addFiles(files);
            }}
            onRemoveAttachment={(id) => actions?.removeAttachment(id)}
            confirmTools={agent.confirmTools} onConfirmToolsChange={(confirmTools) => agent.setAgentState({ confirmTools })}
            autoConfirm={agent.autoConfirm} autoConfirmDisabled={!agent.autoConfirmOwnerContext}
            onAutoConfirmChange={(value) => useAgentStore.getState().setAutoConfirm(value)}
            permissionMode={agent.permissionMode} onPermissionModeChange={(mode) => actions?.changePermissionMode(mode)}
            models={agent.models} model={agent.model} reasoningEffort={agent.reasoningEffort}
            onModelChange={(model) => {
                const selected = agent.models.find((item) => item.model === model);
                if (!selected) return;
                const effort = selected.defaultReasoningEffort || selected.supportedReasoningEfforts[0]?.reasoningEffort;
                localStorage.setItem("canvas-agent-model", model);
                if (effort) localStorage.setItem("canvas-agent-reasoning-effort", effort);
                agent.setAgentState({ model, ...(effort ? { reasoningEffort: effort } : {}) });
            }}
            onReasoningEffortChange={(reasoningEffort) => { localStorage.setItem("canvas-agent-reasoning-effort", reasoningEffort); agent.setAgentState({ reasoningEffort }); }}
        />
    </div>;
}
