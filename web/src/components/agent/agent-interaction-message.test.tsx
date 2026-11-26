import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { agentInteractionScope, type AgentInteraction, type AgentInteractionView } from "@/lib/agent/agent-interactions";
import { interactionMessage, projectAgentInteractionMessages } from "@/lib/agent/agent-interaction-session";
import type { AgentChatItem } from "@/stores/use-agent-store";
import { AgentChatMessage } from "./agent-chat-message";
import { agentMessageToChatMessage, mergeAgentMessages, normalizeHistoryMessages } from "./agent-event-formatters";

const base = { id: "message-request", streamId: "message-stream", threadId: "message-thread", conversationId: "message-conversation", sourceTurnId: "source-turn", sourceClientId: "message-client", ownerContext: "message-owner", projectId: "message-project", revision: 1, status: "pending" as const };
const proposal: AgentInteraction = { ...base, kind: "proposal", input: { proposalId: base.id, summary: "真实消息入口方案", actions: ["创建画布内容"], estimatedCost: 3 } };
const question: AgentInteraction = { ...base, kind: "question", input: { questionId: base.id, question: "真实消息入口问题" } };
const generation: AgentInteraction = { ...base, kind: "generation_confirm", input: { confirmId: base.id, description: "真实消息入口生成", estimatedCost: 5 } };
const noop = () => {};

function message(record: AgentInteraction, authoritative = true): AgentChatItem {
    return { ...interactionMessage(record, "mcp-original"), interaction: { record, authoritative }, detail: { kind: "tool", status: "pending" } };
}

function render(item: AgentChatItem) {
    return renderToStaticMarkup(<AgentChatMessage item={agentMessageToChatMessage(item, "http://synthetic.invalid", "synthetic-token")} theme={canvasThemes.dark} onInteractionDecision={noop} onInteractionReconcile={noop} onApproveTool={noop} onRejectTool={noop} />);
}

test("typed interaction wins over the legacy pending-tool branch at the real message entry for all three kinds", () => {
    for (const record of [proposal, question, generation]) {
        const html = render(message(record));
        expect(html).toContain(`data-agent-interaction="${record.kind}"`);
        expect(html).not.toContain(i18n.t("agent.message.awaitingConfirmation"));
        expect(html.match(/data-agent-interaction=/g)).toHaveLength(1);
    }
});

test("a legacy pending tool without typed interaction still uses the existing pending-tool card", () => {
    const { interaction: _interaction, ...legacy } = message(proposal);
    const html = render(legacy);
    expect(html).not.toContain("data-agent-interaction=");
    expect(html).toContain(i18n.t("agent.message.awaitingConfirmation"));
    expect(html).toContain(i18n.t("agent.message.approve"));
    expect(html).toContain(i18n.t("agent.message.reject"));
});

test("history normalization retains the typed card identity but revokes disk authority and streaming state", () => {
    const source = { ...message(proposal), streamId: "old-live-stream" };
    const [normalized] = normalizeHistoryMessages([source]);
    expect(normalized.id).toBe(source.id);
    expect(normalized.itemId).toBe("mcp-original");
    expect(normalized.threadId).toBe(proposal.threadId);
    expect(normalized.turnId).toBe(proposal.sourceTurnId);
    expect(normalized.streamId).toBeUndefined();
    expect(normalized.interaction).toEqual({ record: proposal, authoritative: false });
    const html = render(normalized);
    expect(html).toContain('data-agent-interaction="proposal"');
    expect(html).toContain(i18n.t("agent.interactions.status.expired"));
    expect(html).not.toContain("<button");
});

test("a settled history item lacking typed data keeps its locally identified card through metadata merge", () => {
    const current = message(proposal, false);
    const { interaction: _interaction, ...plainHistory } = current;
    const merged = mergeAgentMessages(normalizeHistoryMessages([plainHistory]), [current], proposal.threadId, new Set());
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(current.id);
    expect(merged[0].interaction?.record).toEqual(proposal);
    expect(merged[0].interaction?.authoritative).toBe(false);
    expect(render(merged[0])).toContain('data-agent-interaction="proposal"');
});

test("authority projection restores queued revision after stale pending history and live metadata merge", () => {
    const queued: AgentInteraction = { ...proposal, kind: "proposal", status: "queued", revision: 2, decision: { approved: true } };
    const authority: AgentInteractionView = { record: queued, authoritative: true };
    const old = message(proposal);
    let items = projectAgentInteractionMessages(
        mergeAgentMessages(normalizeHistoryMessages([old]), [old], proposal.threadId, new Set([`${proposal.threadId}\0${proposal.sourceTurnId}`])),
        [authority], agentInteractionScope(proposal),
    );
    expect(items).toHaveLength(1);
    expect(items[0].itemId).toBe("mcp-original");
    expect(items[0].interaction).toEqual(authority);
    const html = render(items[0]);
    expect(html).toContain(i18n.t("agent.interactions.status.queued"));
    expect(html).toContain(i18n.t("agent.interactions.approved"));
    expect(html).not.toContain("<button");
    expect(html).not.toContain(i18n.t("agent.interactions.status.pending"));
    // A second history refresh must apply the same authority even when a stale
    // live copy is still available at the original scoped message identity.
    items = projectAgentInteractionMessages(mergeAgentMessages(normalizeHistoryMessages(items), [old], proposal.threadId, new Set()), [authority], agentInteractionScope(proposal));
    expect(items).toHaveLength(1);
    expect(items[0].interaction).toEqual(authority);
    expect(render(items[0])).toContain(i18n.t("agent.interactions.status.queued"));
});

test("MCP placement and synthetic placement render a single queued card at the original source item", () => {
    const queued: AgentInteraction = { ...generation, kind: "generation_confirm", status: "queued", revision: 2, decision: { confirmed: true, decisionSource: "auto" } };
    const source = message(generation, false), duplicate = interactionMessage(generation);
    const projected = projectAgentInteractionMessages(normalizeHistoryMessages([source, duplicate]), [{ record: queued, authoritative: true }], agentInteractionScope(generation));
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe(source.id);
    expect(projected[0].turnId).toBe(generation.sourceTurnId);
    expect(render(projected[0])).toContain(i18n.t("agent.interactions.autoConfirmed"));
    expect(render(projected[0])).not.toContain("<button");
});

test("a pending card from an old Agent process remains visible and expired after current-scope projection", () => {
    const historical = message({ ...question, streamId: "old-process" }, false);
    const [projected] = projectAgentInteractionMessages(normalizeHistoryMessages([historical]), [], agentInteractionScope(question));
    expect(projected.interaction?.record.streamId).toBe("old-process");
    const html = render(projected);
    expect(html).toContain('data-agent-interaction="question"');
    expect(html).toContain(i18n.t("agent.interactions.status.expired"));
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<button");
});
