import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";

import type { CodexRunOutcome } from "../agent/codex-protocol.js";
import { InteractionError, interactionKey, type Interaction, type InteractionScope, type ManagedRunSettings } from "./interactions.js";
import { CanvasSession } from "./session.js";

const settings: ManagedRunSettings = { cwd: "C:/synthetic-workspace", permissionMode: "request", model: "synthetic-model", effort: "high" };
const question = { questionId: "question-1", question: "选择哪一种风格？", placeholder: "请输入风格" };

test("ask_user只创建一次权威问题和原来源规范事件，工具重试不重复广播", async (t) => {
    const f = fixture(t);
    const other = connect(f.session, t, "other", "owner-1");
    const token = start(f, "turn-1");
    const first = await ask(f, token);
    assert.equal(first.kind, "question");
    assert.equal(first.status, "pending");
    assert.deepEqual(pending(f.session), [[interactionKey("thread-1", "question", question.questionId), { questionId: question.questionId, text: question.question }]]);
    const created = f.client.events("agent_interaction_created");
    const events = f.client.events("agent_question");
    assert.equal(created.length, 1);
    assert.equal(events.length, 1);
    assertCanonical(events[0]!, first);
    assert.ok(Number(events[0]!.seq) > Number(created[0]!.seq));
    assert.deepEqual(await ask(f, token), first);
    assert.equal(f.client.events("agent_interaction_created").length, 1);
    assert.equal(f.client.events("agent_question").length, 1);
    assert.equal(other.events("agent_interaction_created").length, 0);
    assert.equal(other.events("agent_question").length, 0);
    assert.equal(f.client.events("tool_call").length, 0);
});

test("有效直接问题从冻结run重建规范事件，原始字段和伪seq不能成为第二事实来源", (t) => {
    const f = fixture(t);
    const other = connect(f.session, t, "other", "owner-2");
    start(f, "turn-1");
    const payload = direct(f, "turn-1", { questionId: "  question-1  ", text: "  选择哪一种风格？  ", seq: -100, injected: "不可广播", conversationId: f.scope.conversationId, projectId: f.scope.projectId });
    assert.equal(f.session.trackCodexEvent("agent_question", payload), false);
    const interaction = f.session.interactionsForScope(f.scope)[0]!;
    assert.deepEqual(interaction.input, { questionId: question.questionId, question: question.question });
    assertCanonical(f.client.events("agent_question")[0]!, interaction);
    assert.equal(f.client.events("agent_interaction_created").length, 1);
    assert.equal(other.events("agent_question").length, 0);
    assert.deepEqual(pending(f.session), [[interactionKey("thread-1", "question", question.questionId), { questionId: question.questionId, text: question.question }]]);
    assert.equal(f.session.trackCodexEvent("agent_question", payload), false);
    assert.equal(f.client.events("agent_question").length, 1);
    assert.equal(f.session.interactionsForScope(f.scope).length, 1);
});

test("完整问题snapshot省略顶层placeholder仍可幂等echo，嵌套内容或scope矛盾不能建立卡片", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const snapshot = await ask(f, token);
    assert.equal(snapshot.kind, "question");
    assert.deepEqual(snapshot.input, question);
    assert.equal(f.session.trackCodexEvent("agent_question", direct(f, "turn-1", { interaction: snapshot })), false);
    assert.deepEqual(f.session.interactionsForScope(f.scope), [snapshot]);
    assert.deepEqual(await ask(f, token), snapshot);
    assert.equal(f.client.events("agent_interaction_created").length, 1);
    assert.equal(f.client.events("agent_question").length, 1);

    const fresh = fixture(t);
    start(fresh, "turn-1");
    const freshSnapshot = { ...snapshot, streamId: fresh.client.events("hello")[0]!.streamId };
    assert.equal(fresh.session.trackCodexEvent("agent_question", direct(fresh, "turn-1", { interaction: freshSnapshot })), false);
    assert.deepEqual(fresh.session.interactionsForScope(fresh.scope)[0]!.input, question);
    assert.equal(fresh.client.events("agent_question").length, 1);

    for (const patch of [
        { input: { ...question, question: "嵌套问题不一致" } },
        { input: { ...question, questionId: "other-question" } },
        { ownerContext: "owner-2" }, { projectId: "project-2" },
        { conversationId: "other-conversation" }, { sourceTurnId: "old-turn" },
        { topPlaceholder: "顶层占位不一致" },
    ]) {
        const invalid = fixture(t);
        start(invalid, "turn-1");
        const { topPlaceholder, ...nestedPatch } = patch;
        const nested = { ...snapshot, streamId: invalid.client.events("hello")[0]!.streamId, ...nestedPatch };
        const payload = direct(invalid, "turn-1", { interaction: nested, ...(topPlaceholder === undefined ? {} : { placeholder: topPlaceholder }) });
        assert.equal(invalid.session.trackCodexEvent("agent_question", payload), false);
        assert.deepEqual(invalid.session.interactionsForScope(invalid.scope), []);
        assert.deepEqual(pending(invalid.session), []);
        assert.equal(invalid.client.events("agent_interaction_created").length, 0);
        assert.equal(invalid.client.events("agent_question").length, 0);
    }
});

test("缺少元数据、伪造scope和无效问题均静默忽略，不建立卡片或索引", (t) => {
    const f = fixture(t);
    start(f, "turn-1");
    const valid = direct(f, "turn-1");
    const invalid: Record<string, unknown>[] = [
        { questionId: question.questionId, text: question.question },
        ...["threadId", "turnId", "sourceClientId", "ownerContext"].flatMap((field) => [
            Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field)),
            { ...valid, [field]: "   " },
        ]),
        ...[{ threadId: "other-thread" }, { turnId: "old-turn" }, { sourceClientId: "other" }, { ownerContext: "owner-2" }, { streamId: "old-process" }, { conversationId: "other-conversation" }, { projectId: "project-2" }, { projectId: null }, { questionId: " " }, { questionId: 1 }, { text: " " }, { text: 1 }, { placeholder: 1 }].map((patch) => ({ ...valid, ...patch })),
    ];
    for (const payload of invalid) assert.equal(f.session.trackCodexEvent("agent_question", payload), false);
    assert.deepEqual(f.session.interactionsForScope(f.scope), []);
    assert.deepEqual(pending(f.session), []);
    assert.equal(f.client.events("agent_interaction_created").length, 0);
    assert.equal(f.client.events("agent_question").length, 0);
});

test("迟到run的问题被丢弃，同client重连须重新确认state才能接收直接问题", (t) => {
    const late = fixture(t);
    const oldToken = start(late, "turn-1");
    finish(late, oldToken, "turn-1");
    assert.equal(late.session.trackCodexEvent("agent_question", direct(late, "turn-1")), false);
    start(late, "turn-2");
    assert.equal(late.session.trackCodexEvent("agent_question", direct(late, "turn-1")), false);
    assert.deepEqual(pending(late.session), []);
    assert.equal(late.client.events("agent_question").length, 0);

    const f = fixture(t);
    start(f, "turn-1");
    const refreshed = connect(f.session, t, "client-1", "owner-1");
    assert.equal(f.session.trackCodexEvent("agent_question", direct(f, "turn-1")), false);
    assert.deepEqual(pending(f.session), []);
    assert.equal(refreshed.events("agent_question").length, 0);
    f.session.updateState({ projectId: "project-1", nodes: [], connections: [] }, "client-1");
    assert.equal(f.session.trackCodexEvent("agent_question", direct(f, "turn-1")), false);
    assert.equal(refreshed.events("agent_question").length, 1);
    assert.equal(pending(f.session).length, 1);
});

test("回答必须非空且匹配来源，trim后重复POST只返回已存决定，不重复事件或恢复索引", async (t) => {
    const f = fixture(t);
    const other = connect(f.session, t, "other", "owner-1");
    f.session.updateState({ projectId: "project-1" }, "other");
    const token = start(f, "turn-1");
    const interaction = await ask(f, token);
    const body = decisionBody(f.scope, interaction, "  简洁风格  ");
    for (const answer of ["", "  \n  ", undefined, 1]) assert.throws(() => f.session.decideInteraction("question", interaction.id, { ...body, answer }), errorCode("INVALID_INTERACTION_DECISION"));
    assert.throws(() => f.session.decideInteraction("question", "unknown", body), errorCode("INTERACTION_STALE"));
    for (const patch of [{ clientId: "other" }, { ownerContext: "owner-2" }, { streamId: "old-process" }, { expectedInteractionRevision: 99 }]) assert.throws(() => f.session.decideInteraction("question", interaction.id, { ...body, ...patch }), InteractionError);
    assert.equal(pending(f.session).length, 1);
    const accepted = f.session.decideInteraction("question", interaction.id, body);
    assert.equal(accepted.duplicate, false);
    assert.equal(accepted.interaction.status, "queued");
    assert.deepEqual(accepted.interaction.decision, { answer: "简洁风格", decisionSource: "manual" });
    assert.deepEqual(pending(f.session), []);
    assert.equal(f.session.claimQueuedInteraction(), null);
    const replay = f.session.decideInteraction("question", interaction.id, { ...body, answer: "简洁风格" });
    assert.deepEqual(replay, { interaction: accepted.interaction, duplicate: true });
    assert.throws(() => f.session.decideInteraction("question", interaction.id, { ...body, answer: "不同回答" }), errorCode("INTERACTION_DECISION_CONFLICT"));
    assert.equal(f.session.trackCodexEvent("agent_question", direct(f, "turn-1", { placeholder: question.placeholder })), false);
    assert.equal((await ask(f, token)).status, "queued");
    assert.deepEqual(pending(f.session), []);
    assert.equal(f.client.events("agent_question").length, 1);
    assert.equal(f.client.events("agent_question_answered").length, 1);
    assert.equal(other.events("agent_question_answered").length, 0);
    assert.equal(f.client.events("agent_question_answered")[0]!.answer, "简洁风格");
});

test("问题回答等待原turn正常结束，只claim一次并以原设置续接，完成后重复决定仍幂等", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const interaction = await ask(f, token);
    const body = decisionBody(f.scope, interaction, "简洁风格");
    f.session.decideInteraction("question", interaction.id, body);
    assert.equal(f.session.claimQueuedInteraction(), null);
    finish(f, token, "turn-1");
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "queued");
    const claimed = f.session.claimQueuedInteraction()!;
    assert.equal(claimed.interaction.status, "continuing");
    assert.deepEqual(claimed.settings, settings);
    assert.deepEqual(claimed.scope, f.scope);
    assert.ok(claimed.prompt.includes(question.question));
    assert.ok(claimed.prompt.includes("简洁风格"));
    assert.equal(f.session.claimQueuedInteraction(), null);
    const continuation = start(f, "turn-2", claimed.interaction);
    finish(f, continuation, "turn-2");
    const completed = f.session.interactionsForScope(f.scope)[0]!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.continuationTurnId, "turn-2");
    assert.deepEqual(f.session.decideInteraction("question", interaction.id, body), { interaction: completed, duplicate: true });
    assert.deepEqual(pending(f.session), []);
    assert.equal(f.session.claimQueuedInteraction(), null);
    assert.equal(f.client.events("agent_question_answered").length, 1);
});

test("不同thread可复用问题ID，旧thread回答不能命中新thread的问题", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const old = await ask(f, token);
    const oldBody = decisionBody(f.scope, old, "旧回答");
    finish(f, token, "turn-1");
    f.session.activateConversation("thread-2", "client-1");
    f.scope = { ...f.scope, threadId: "thread-2", conversationId: "thread-2" };
    const nextToken = start(f, "turn-2");
    const current = await ask(f, nextToken);
    assert.equal(current.id, old.id);
    assert.equal(current.threadId, "thread-2");
    assert.deepEqual(pending(f.session), [[interactionKey("thread-2", "question", question.questionId), { questionId: question.questionId, text: question.question }]]);
    assert.throws(() => f.session.decideInteraction("question", old.id, oldBody), errorCode("INTERACTION_SCOPE_STALE"));
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "pending");
    assert.equal(f.client.events("agent_question_answered").length, 0);
});

test("owner/project/conversation变化和失败终态清除索引，旧事件不使问题复活", async (t) => {
    for (const change of ["owner", "project", "conversation", "failed", "interrupted", "unknown"] as const) {
        const f = fixture(t);
        const token = start(f, "turn-1");
        const interaction = await ask(f, token);
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
        assert.deepEqual(pending(f.session), []);
        assert.equal(f.session.trackCodexEvent("agent_question", direct(f, "turn-1", { placeholder: question.placeholder })), false);
        assert.deepEqual(pending(f.session), []);
        assert.throws(() => f.session.decideInteraction("question", interaction.id, decisionBody(f.scope, interaction, "迟到回答")), errorCode("INTERACTION_EXPIRED"));
        assert.equal(f.session.claimQueuedInteraction(), null);
    }
    const f = fixture(t);
    const token = start(f, "turn-1");
    const interaction = await ask(f, token);
    const body = decisionBody(f.scope, interaction, "简洁风格");
    f.session.decideInteraction("question", interaction.id, body);
    finish(f, token, "turn-1");
    const claimed = f.session.claimQueuedInteraction()!;
    f.session.failClaimedInteraction(claimed.interaction, "合成续接启动失败");
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "continuation_failed");
    assert.deepEqual(pending(f.session), []);
    assert.equal(f.session.decideInteraction("question", interaction.id, body).duplicate, true);
    assert.equal(f.session.claimQueuedInteraction(), null);
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

async function ask(f: ReturnType<typeof fixture>, token: string) {
    return (await f.session.callTool("canvas_ask_user", question, token) as { interaction: Interaction }).interaction;
}

function direct(f: ReturnType<typeof fixture>, turnId: string, patch: Record<string, unknown> = {}) {
    return { questionId: question.questionId, text: question.question, threadId: f.scope.threadId, turnId, sourceClientId: f.scope.clientId, ownerContext: f.scope.ownerContext, ...patch };
}

function decisionBody(scope: InteractionScope, interaction: Interaction, answer: string) {
    return { ...scope, streamId: interaction.streamId, expectedInteractionRevision: interaction.revision, answer };
}

function pending(session: CanvasSession) {
    return [...(session as unknown as { pendingQuestions: Map<string, { questionId: string; text: string }> }).pendingQuestions.entries()];
}

function assertCanonical(event: Record<string, unknown>, interaction: Interaction) {
    assert.deepEqual(Object.keys(event).sort(), ["questionId", "text", "interaction", "seq", "threadId", "turnId", "sourceClientId", "ownerContext"].sort());
    assert.deepEqual(event.interaction, interaction);
    assert.equal(event.questionId, interaction.id);
    assert.equal(event.text, question.question);
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
