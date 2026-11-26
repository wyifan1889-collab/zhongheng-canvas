import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";

import type { CodexRunOutcome } from "../agent/codex-protocol.js";
import { InteractionError, interactionKey, type Interaction, type InteractionScope, type ManagedRunSettings } from "./interactions.js";
import { CanvasSession } from "./session.js";

const settings: ManagedRunSettings = { cwd: "C:/synthetic-workspace", permissionMode: "request", model: "synthetic-model", effort: "high" };
const proposal = { proposalId: "proposal-1", summary: "建立三张草稿", estimatedCost: 12, actions: ["建立草稿", "保留原节点"] };

test("proposal工具创建权威卡片和原来源规范事件，工具与直接echo都不重复广播", async (t) => {
    const f = fixture(t);
    const other = connect(f.session, t, "other", "owner-1");
    const token = start(f, "turn-1");
    const interaction = await propose(f, token);
    assert.equal(interaction.kind, "proposal");
    assert.equal(interaction.status, "pending");
    assert.deepEqual(interaction.input, proposal);
    assert.deepEqual(pendingKeys(f.session), [interactionKey("thread-1", "proposal", proposal.proposalId)]);
    assert.deepEqual([...(f.session as unknown as { pendingProposals: Map<string, unknown> }).pendingProposals], [[interactionKey("thread-1", "proposal", proposal.proposalId), { proposalId: proposal.proposalId, summary: proposal.summary, estimatedCost: 12 }]]);
    assert.equal(f.client.events("agent_interaction_created").length, 1);
    assert.equal(f.client.events("agent_proposal").length, 1);
    assertCanonical(f.client.events("agent_proposal")[0]!, interaction);
    assert.ok(Number(f.client.events("agent_proposal")[0]!.seq) > Number(f.client.events("agent_interaction_created")[0]!.seq));
    assert.deepEqual(await propose(f, token), interaction);
    assert.equal(f.session.trackCodexEvent("agent_proposal", direct(f, "turn-1", { interaction })), false);
    assert.equal(f.client.events("agent_interaction_created").length, 1);
    assert.equal(f.client.events("agent_proposal").length, 1);
    assert.equal(other.events("agent_interaction_created").length, 0);
    assert.equal(other.events("agent_proposal").length, 0);
    assert.equal(f.client.events("tool_call").length, 0);
});

test("直接proposal保留actions和零费用，缺省actions为[]且缺省费用不伪装为0", (t) => {
    for (const fields of [{}, { estimatedCost: 0 }, { estimatedCost: 12, actions: proposal.actions }]) {
        const f = fixture(t);
        start(f, "turn-1");
        const payload = direct(f, "turn-1", { proposalId: "  proposal-1  ", summary: "  建立三张草稿  ", ...fields, seq: -99, injected: "不可广播" });
        assert.equal(f.session.trackCodexEvent("agent_proposal", payload), false);
        const interaction = f.session.interactionsForScope(f.scope)[0]!;
        assert.deepEqual(interaction.input, { proposalId: proposal.proposalId, summary: proposal.summary, actions: [], ...fields });
        assertCanonical(f.client.events("agent_proposal")[0]!, interaction);
        assert.equal(f.session.trackCodexEvent("agent_proposal", payload), false);
        assert.equal(f.client.events("agent_proposal").length, 1);
        assert.equal(f.session.interactionsForScope(f.scope).length, 1);
        assert.deepEqual(pendingKeys(f.session), [interactionKey("thread-1", "proposal", proposal.proposalId)]);
        assert.deepEqual([...(f.session as unknown as { pendingProposals: Map<string, unknown> }).pendingProposals.values()], [{ proposalId: proposal.proposalId, summary: proposal.summary, ...(fields.estimatedCost === undefined ? {} : { estimatedCost: fields.estimatedCost }) }]);
    }
});

test("完整nested snapshot可继承actions和费用，内容或来源矛盾不能产生卡片", async (t) => {
    const source = fixture(t);
    const snapshot = await propose(source, start(source, "turn-1"));
    const f = fixture(t);
    start(f, "turn-1");
    const nested = { ...snapshot, streamId: streamId(f) };
    assert.equal(f.session.trackCodexEvent("agent_proposal", direct(f, "turn-1", { interaction: nested })), false);
    assert.deepEqual(f.session.interactionsForScope(f.scope)[0]!.input, proposal);
    assert.equal(f.session.trackCodexEvent("agent_proposal", direct(f, "turn-1", { interaction: nested, actions: proposal.actions, estimatedCost: 12 })), false);
    assert.equal(f.client.events("agent_proposal").length, 1);

    const invalidCases: { nested?: Record<string, unknown>; top?: Record<string, unknown> }[] = [
        { nested: { input: { ...proposal, proposalId: "other-proposal" } } },
        { nested: { input: { ...proposal, summary: "篡改的方案" } } },
        { nested: { input: { ...proposal, actions: [1] } } },
        { nested: { input: { proposalId: proposal.proposalId, summary: proposal.summary, estimatedCost: 12 } } },
        { nested: { input: { ...proposal, estimatedCost: -1 } } },
        { nested: { input: { proposalId: proposal.proposalId, summary: proposal.summary, actions: proposal.actions } }, top: { estimatedCost: 12 } },
        { nested: { ownerContext: "owner-2" } }, { nested: { projectId: "project-2" } },
        { nested: { conversationId: "other-conversation" } }, { nested: { sourceTurnId: "old-turn" } },
        { top: { actions: ["不同动作"] } }, { top: { estimatedCost: 0 } },
    ];
    for (const item of invalidCases) {
        const invalid = fixture(t);
        start(invalid, "turn-1");
        const interaction = { ...snapshot, streamId: streamId(invalid), ...item.nested };
        assert.equal(invalid.session.trackCodexEvent("agent_proposal", direct(invalid, "turn-1", { interaction, ...item.top })), false);
        assert.deepEqual(invalid.session.interactionsForScope(invalid.scope), []);
        assert.deepEqual(pendingKeys(invalid.session), []);
        assert.equal(invalid.client.events("agent_interaction_created").length, 0);
        assert.equal(invalid.client.events("agent_proposal").length, 0);
    }
});

test("直接proposal拒绝缺少元数据、伪造scope、无效费用和迟到run，重连须确认state", (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const valid = direct(f, "turn-1");
    const invalid: Record<string, unknown>[] = [
        { proposalId: proposal.proposalId, summary: proposal.summary },
        ...["threadId", "turnId", "sourceClientId", "ownerContext"].flatMap((field) => [
            Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field)), { ...valid, [field]: " " },
        ]),
        ...[{ threadId: "other-thread" }, { turnId: "old-turn" }, { sourceClientId: "other" }, { ownerContext: "owner-2" }, { streamId: "old-process" }, { conversationId: "other-conversation" }, { projectId: "project-2" }, { summary: " " }, { proposalId: " " }, { estimatedCost: -1 }, { estimatedCost: Infinity }, { estimatedCost: NaN }, { estimatedCost: "0" }, { actions: null }, { actions: "动作" }, { actions: [""] }].map((patch) => ({ ...valid, ...patch })),
    ];
    for (const payload of invalid) assert.equal(f.session.trackCodexEvent("agent_proposal", payload), false);
    assert.deepEqual(f.session.interactionsForScope(f.scope), []);
    assert.deepEqual(pendingKeys(f.session), []);
    finish(f, token, "turn-1");
    assert.equal(f.session.trackCodexEvent("agent_proposal", valid), false);
    start(f, "turn-2");
    assert.equal(f.session.trackCodexEvent("agent_proposal", valid), false);
    const refreshed = connect(f.session, t, "client-1", "owner-1");
    assert.equal(f.session.trackCodexEvent("agent_proposal", direct(f, "turn-2")), false);
    assert.deepEqual(pendingKeys(f.session), []);
    assert.equal(refreshed.events("agent_proposal").length, 0);
    f.session.updateState({ projectId: "project-1" }, "client-1");
    assert.equal(f.session.trackCodexEvent("agent_proposal", direct(f, "turn-2")), false);
    assert.equal(refreshed.events("agent_proposal").length, 1);
});

test("方案决定严格要求boolean和原来源，同决定幂等且不同决定冲突，不自动claim", async (t) => {
    const f = fixture(t);
    const other = connect(f.session, t, "other", "owner-1");
    f.session.updateState({ projectId: "project-1" }, "other");
    const token = start(f, "turn-1");
    const interaction = await propose(f, token);
    const body = decisionBody(f.scope, interaction, true);
    for (const approved of [undefined, "true", 1, null]) assert.throws(() => f.session.decideInteraction("proposal", interaction.id, { ...body, approved }), errorCode("INVALID_INTERACTION_DECISION"));
    assert.throws(() => f.session.decideInteraction("proposal", "unknown", body), errorCode("INTERACTION_STALE"));
    for (const patch of [{ clientId: "other" }, { ownerContext: "owner-2" }, { streamId: "old-process" }, { expectedInteractionRevision: 99 }]) assert.throws(() => f.session.decideInteraction("proposal", interaction.id, { ...body, ...patch }), InteractionError);
    const accepted = f.session.decideInteraction("proposal", interaction.id, body);
    assert.equal(accepted.duplicate, false);
    assert.equal(accepted.interaction.status, "queued");
    assert.deepEqual(accepted.interaction.decision, { approved: true, decisionSource: "manual" });
    assert.deepEqual(pendingKeys(f.session), []);
    assert.equal(f.session.claimQueuedInteraction(), null);
    assert.deepEqual(f.session.decideInteraction("proposal", interaction.id, body), { interaction: accepted.interaction, duplicate: true });
    assert.throws(() => f.session.decideInteraction("proposal", interaction.id, { ...body, approved: false }), errorCode("INTERACTION_DECISION_CONFLICT"));
    assert.equal(f.session.trackCodexEvent("agent_proposal", direct(f, "turn-1", { interaction })), false);
    assert.equal((await propose(f, token)).status, "queued");
    assert.deepEqual(pendingKeys(f.session), []);
    assert.equal(f.client.events("agent_proposal").length, 1);
    assert.equal(f.client.events("agent_proposal_decided").length, 1);
    assert.equal(other.events("agent_proposal_decided").length, 0);
});

test("同意和拒绝均只续接一次原线程，拒绝续接只读并保存手动决定", async (t) => {
    for (const approved of [true, false]) {
        const f = fixture(t);
        const token = start(f, "turn-1");
        const interaction = await propose(f, token);
        const body = { ...decisionBody(f.scope, interaction, approved), reason: "  保留原有风格  " };
        f.session.decideInteraction("proposal", interaction.id, body);
        assert.equal(f.session.claimQueuedInteraction(), null);
        finish(f, token, "turn-1");
        const claimed = f.session.claimQueuedInteraction()!;
        assert.deepEqual(claimed.scope, f.scope);
        assert.deepEqual(claimed.settings, settings);
        assert.deepEqual(claimed.interaction.decision, { approved, reason: "保留原有风格", decisionSource: "manual" });
        assert.equal(f.session.claimQueuedInteraction(), null);
        const continuation = start(f, "turn-2", claimed.interaction);
        if (!approved) {
            assert.ok(claimed.prompt.includes("不得执行"));
            await assert.rejects(f.session.callTool("canvas_create_text_node", { text: "拒绝后不得写入" }, continuation), errorCode("INTERACTION_READ_ONLY"));
        }
        assert.equal((await f.session.callTool("canvas_get_state", {}, continuation) as { projectId: string }).projectId, "project-1");
        finish(f, continuation, "turn-2");
        const completed = f.session.interactionsForScope(f.scope)[0]!;
        assert.equal(completed.status, "completed");
        assert.equal(completed.continuationTurnId, "turn-2");
        assert.deepEqual(f.session.decideInteraction("proposal", interaction.id, body), { interaction: completed, duplicate: true });
        assert.deepEqual(pendingKeys(f.session), []);
        assert.equal(f.session.claimQueuedInteraction(), null);
        assert.equal(f.client.events("agent_proposal_decided").length, 1);
    }
});

test("scope变化和失败终态清空方案索引，旧echo不会使expired或failed方案复活", async (t) => {
    for (const change of ["owner", "project", "conversation", "failed", "interrupted", "unknown"] as const) {
        const f = fixture(t);
        const token = start(f, "turn-1");
        const interaction = await propose(f, token);
        if (change === "owner") {
            connect(f.session, t, "client-1", "owner-2");
            connect(f.session, t, "client-1", "owner-1");
            f.session.updateState({ projectId: "project-1" }, "client-1");
        } else if (change === "project") {
            f.session.updateState({ projectId: "project-2" }, "client-1");
            f.session.updateState({ projectId: "project-1" }, "client-1");
        } else if (change === "conversation") {
            f.session.activateConversation("thread-2", "client-1");
            f.session.activateConversation("thread-1", "client-1");
        } else finish(f, token, "turn-1", change);
        assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "expired");
        assert.deepEqual(pendingKeys(f.session), []);
        assert.equal(f.session.trackCodexEvent("agent_proposal", direct(f, "turn-1", { interaction })), false);
        assert.deepEqual(pendingKeys(f.session), []);
        assert.throws(() => f.session.decideInteraction("proposal", interaction.id, decisionBody(f.scope, interaction, true)), errorCode("INTERACTION_EXPIRED"));
        assert.equal(f.session.claimQueuedInteraction(), null);
    }
    const f = fixture(t);
    const token = start(f, "turn-1");
    const interaction = await propose(f, token);
    const body = decisionBody(f.scope, interaction, true);
    f.session.decideInteraction("proposal", interaction.id, body);
    finish(f, token, "turn-1");
    const claimed = f.session.claimQueuedInteraction()!;
    f.session.failClaimedInteraction(claimed.interaction, "合成续接启动失败");
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "continuation_failed");
    assert.deepEqual(pendingKeys(f.session), []);
    assert.equal(f.session.decideInteraction("proposal", interaction.id, body).duplicate, true);
    assert.equal(f.session.claimQueuedInteraction(), null);
});

test("相同proposalId在不同thread独立索引，旧线程决定不能命中新卡片", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const old = await propose(f, token);
    const oldBody = decisionBody(f.scope, old, true);
    finish(f, token, "turn-1");
    f.session.activateConversation("thread-2", "client-1");
    f.scope = { ...f.scope, threadId: "thread-2", conversationId: "thread-2" };
    const current = await propose(f, start(f, "turn-2"));
    assert.equal(current.id, old.id);
    assert.equal(current.threadId, "thread-2");
    assert.deepEqual(pendingKeys(f.session), [interactionKey("thread-2", "proposal", proposal.proposalId)]);
    assert.throws(() => f.session.decideInteraction("proposal", old.id, oldBody), errorCode("INTERACTION_SCOPE_STALE"));
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "pending");
    assert.equal(f.client.events("agent_proposal_decided").length, 0);
});

function fixture(t: TestContext) {
    const session = new CanvasSession("thread-1");
    const client = connect(session, t, "client-1", "owner-1");
    session.updateState({ projectId: "project-1", nodes: [], connections: [], selectedNodeIds: [] }, "client-1");
    const scope: InteractionScope = { clientId: "client-1", ownerContext: "owner-1", threadId: "thread-1", conversationId: "thread-1", projectId: "project-1" };
    return { session, client, scope };
}

function start(f: ReturnType<typeof fixture>, turnId: string, interaction?: Interaction) {
    const token = f.session.startManagedRun(f.scope, settings, { interaction });
    f.session.bindClient(f.scope.clientId);
    f.session.setCodexState({ busy: true, threadId: f.scope.threadId, turnId: "" });
    f.session.bindManagedTurn(turnId, token);
    f.session.setCodexState({ turnId });
    return token;
}

function finish(f: ReturnType<typeof fixture>, token: string, turnId: string, status: CodexRunOutcome["status"] = "completed") {
    f.session.finishManagedRun({ status, threadId: f.scope.threadId, turnId }, token);
    f.session.releaseClient(f.scope.clientId);
    f.session.setCodexState({ busy: false, threadId: f.scope.threadId, turnId });
    f.session.finishConversationRun(f.scope.threadId);
}

async function propose(f: ReturnType<typeof fixture>, token: string) {
    return (await f.session.callTool("canvas_create_proposal", proposal, token) as { interaction: Interaction }).interaction;
}

function direct(f: ReturnType<typeof fixture>, turnId: string, patch: Record<string, unknown> = {}) {
    return { proposalId: proposal.proposalId, summary: proposal.summary, threadId: f.scope.threadId, turnId, sourceClientId: f.scope.clientId, ownerContext: f.scope.ownerContext, ...patch };
}

function streamId(f: ReturnType<typeof fixture>) {
    return f.client.events("hello")[0]!.streamId;
}

function decisionBody(scope: InteractionScope, interaction: Interaction, approved: boolean) {
    return { ...scope, streamId: interaction.streamId, expectedInteractionRevision: interaction.revision, approved };
}

function pendingKeys(session: CanvasSession) {
    return [...(session as unknown as { pendingProposals: Map<string, unknown> }).pendingProposals.keys()];
}

function assertCanonical(event: Record<string, unknown>, interaction: Interaction) {
    assert.equal(interaction.kind, "proposal");
    if (interaction.kind !== "proposal") return;
    assert.deepEqual(Object.keys(event).sort(), ["proposalId", "summary", "interaction", "seq", "threadId", "turnId", "sourceClientId", "ownerContext", ...(interaction.input.estimatedCost === undefined ? [] : ["estimatedCost"])].sort());
    assert.deepEqual(event.interaction, interaction);
    assert.equal(event.proposalId, interaction.id);
    assert.equal(event.summary, interaction.input.summary);
    assert.equal(event.estimatedCost, interaction.input.estimatedCost);
    assert.equal(event.threadId, interaction.threadId);
    assert.equal(event.turnId, interaction.sourceTurnId);
    assert.equal(event.sourceClientId, interaction.sourceClientId);
    assert.equal(event.ownerContext, interaction.ownerContext);
    assert.ok(Number.isInteger(event.seq) && Number(event.seq) > 0);
}

function errorCode(code: string) {
    return (error: unknown) => error instanceof InteractionError && error.code === code;
}

function connect(session: CanvasSession, t: TestContext, clientId: string, ownerContext: string) {
    const response = new SseResponse();
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}&ownerContext=${ownerContext}`), response as unknown as ServerResponse, session.conversationStateSnapshot.threadId);
    t.after(() => response.close());
    return response;
}

class SseResponse extends EventEmitter {
    chunks: string[] = [];
    writeHead() { return this; }
    write(chunk: string) { this.chunks.push(chunk); return true; }
    close() { this.emit("close"); }
    events(type: string): Record<string, unknown>[] {
        return this.chunks.flatMap((chunk) => chunk.startsWith(`event: ${type}\n`) ? [JSON.parse(chunk.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<string, unknown>] : []);
    }
}
