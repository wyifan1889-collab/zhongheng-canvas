import { expect, test } from "bun:test";
import { App, ConfigProvider } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import type { AgentInteraction } from "@/lib/agent/agent-interactions";
import { interactionMessage } from "@/lib/agent/agent-interaction-session";
import { useAccountStore } from "@/stores/use-account-store";
import { useAgentStore, type AgentChatItem, type AgentPendingApproval } from "@/stores/use-agent-store";
import { LocalAgentPanel } from "./local-agent-panel";

const base = { id: "panel-request", streamId: "panel-stream", threadId: "panel-thread", conversationId: "panel-conversation", sourceTurnId: "panel-source-turn", sourceClientId: "panel-client", ownerContext: "local", projectId: null, revision: 1, status: "pending" as const };
const proposal: AgentInteraction = { ...base, kind: "proposal", input: { proposalId: base.id, summary: "原面板中的合成方案", actions: ["创建一个画布节点"] } };
const question: AgentInteraction = { ...base, kind: "question", input: { questionId: base.id, question: "原面板中的合成问题", placeholder: "请填写合成答案" } };
const generation: AgentInteraction = { ...base, kind: "generation_confirm", input: { confirmId: base.id, description: "历史生成确认，不应重新提交", estimatedCost: 4 } };
const draft = "用户后来输入的草稿，必须保留。";

function ownFields<T extends object>(state: T, patch: Partial<T>) {
    const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, Reflect.get(state, key)]));
    Object.assign(state, patch);
    return () => { Object.assign(state, previous); };
}

function panel(messages: AgentChatItem[], options: { autoConfirm?: boolean; approvals?: AgentPendingApproval[] } = {}) {
    const initial = useAgentStore.getInitialState();
    const patch: Partial<typeof initial> = {
        activeTab: "chat", activeThreadId: base.threadId, activeTurnId: "", url: "http://synthetic-agent.invalid", token: "synthetic-panel-token",
        connected: true, enabled: true, sending: false, waiting: false, loadingThreads: false,
        conversation: { revision: 1, conversationId: base.conversationId, threadId: base.threadId, status: "ready", mcpStatuses: {} },
        prompt: draft, attachments: [], canvasReferences: [], messages, pendingTool: null, pendingApprovals: options.approvals || [],
        bootstrapStatus: null, mcpStartupStatuses: {}, tokenUsage: null,
        autoConfirm: Boolean(options.autoConfirm), autoConfirmOwnerContext: "local", permissionMode: "request", canvasContext: null,
    };
    // Zustand SSR reads getInitialState; the panel's scope helpers read getState.
    // Own the same fixture fields on both snapshots and restore both afterwards.
    const restore = [...new Set([initial, useAgentStore.getState()])].map((state) => ownFields(state, patch));
    for (const state of new Set([useAccountStore.getInitialState(), useAccountStore.getState()])) {
        restore.push(ownFields(state, { status: "ready", busy: false, user: null, site: { registration: false, cloudCanvas: false, cloudMedia: false, captcha: null } }));
    }
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), method: init?.method || "GET" });
        throw new Error("Network access is forbidden in this panel SSR test");
    }, { preconnect: originalFetch.preconnect });
    try {
        const html = renderToStaticMarkup(<ConfigProvider><App><MemoryRouter initialEntries={["/canvas/synthetic-panel"]}><LocalAgentPanel embedded /></MemoryRouter></App></ConfigProvider>);
        expect(initial.prompt).toBe(draft);
        expect(useAgentStore.getState().prompt).toBe(draft);
        expect(initial.messages).toEqual(messages);
        expect(initial.permissionMode).toBe("request");
        expect(initial.pendingApprovals).toEqual(options.approvals || []);
        expect(fetchCalls).toEqual([]);
        return html;
    } finally {
        globalThis.fetch = originalFetch;
        restore.reverse().forEach((restoreState) => restoreState());
    }
}

function labeledButton(html: string, label: string) {
    return (html.match(/<button\b[\s\S]*?<\/button>/g) || []).find((element) => element.includes(label)) || "";
}

for (const record of [proposal, question]) {
    test(`real LocalAgentPanel renders its typed ${record.kind} in chat and preserves an editable draft without a request`, () => {
        const item = { ...interactionMessage(record, "original-mcp-item"), interaction: { record, authoritative: true } };
        const html = panel([item]);
        expect(html).toContain(`data-agent-interaction="${record.kind}"`);
        expect(html).toContain(record.kind === "proposal" ? proposal.input.summary : question.input.question);
        expect(html).toContain('role="textbox"');
        expect(html).toContain('contentEditable="true"');
        const send = (html.match(/<button\b[^>]*>/g) || []).find((tag) => tag.includes(`aria-label="${i18n.t("agent.composer.send")}"`));
        expect(send).toBeDefined();
        expect(send).not.toContain("disabled");
    });
}

test("autoConfirm does not submit an existing history card during real panel render or hide Codex permission approval", () => {
    const history = interactionMessage(generation, "historical-mcp-item");
    const approval: AgentPendingApproval = { requestId: "native-approval", method: "item/permissions/requestApproval", threadId: base.threadId, turnId: "native-approval-turn", itemId: "native-item", reason: "合成 Codex 权限请求" };
    const html = panel([history], { autoConfirm: true, approvals: [approval] });
    expect(html).toContain('data-agent-interaction="generation_confirm"');
    expect(html).toContain(generation.input.description);
    expect(html).toContain(i18n.t("agent.interactions.status.expired"));
    const autoSwitch = (html.match(/<button\b[^>]*>/g) || []).find((tag) => tag.includes(`aria-label="${i18n.t("agent.interactions.autoConfirmLabel")}"`));
    expect(autoSwitch).toContain('aria-checked="true"');
    expect(autoSwitch).not.toContain("disabled");
    expect(html).toContain(i18n.t("agent.message.permissionApproval"));
    expect(html).toContain(approval.reason!);
    for (const key of ["allowOnce", "allowSession", "decline"]) {
        const button = labeledButton(html, i18n.t(`agent.message.${key}`));
        expect(button).not.toBe("");
        expect(button.match(/^<button\b[^>]*>/)?.[0]).not.toContain("disabled");
    }
});
