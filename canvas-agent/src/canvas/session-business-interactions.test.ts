import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";

import type { CodexRunOutcome } from "../agent/codex-protocol.js";
import { InteractionError, type Interaction, type InteractionScope, type ManagedRunSettings } from "./interactions.js";
import { CanvasSession } from "./session.js";

const settings: ManagedRunSettings = { cwd: "C:/synthetic-workspace", permissionMode: "request", model: "synthetic-model", effort: "high", skill: { name: "synthetic", path: "C:/synthetic-workspace/skills/synthetic/SKILL.md" } };
const cases = [
    { name: "canvas_create_proposal", kind: "proposal", input: { proposalId: "proposal-1", summary: "建立三张草稿", estimatedCost: 12, actions: ["建立草稿", "保留原节点"] }, decision: { approved: true } },
    { name: "canvas_ask_user", kind: "question", input: { questionId: "question-1", question: "选择哪一种风格？", placeholder: "请输入风格" }, decision: { answer: "简洁风格" } },
    { name: "canvas_request_generation_confirm", kind: "generation_confirm", input: { confirmId: "confirm-1", description: "生成一张图片", estimatedCost: 3 }, decision: { confirmed: true, decisionSource: "auto" } },
] as const;

test("三工具立即返回本机权威记录，业务事件仅发原client/owner而不执行网页工具", async (t) => {
    for (const item of cases) {
        const f = fixture(t);
        const other = connect(f.session, t, "other", "owner-2");
        const token = start(f, "turn-1");
        const result = await f.session.callTool(item.name, item.input, token) as { ok: boolean; interaction: Interaction };
        assert.equal(result.ok, true);
        assert.equal(result.interaction.kind, item.kind);
        assert.equal(result.interaction.status, "pending");
        assert.equal(result.interaction.sourceTurnId, "turn-1");
        assert.equal(result.interaction.ownerContext, "owner-1");
        assert.equal(result.interaction.projectId, "project-1");
        assert.equal(f.client.events("agent_interaction_created").length, 1);
        assert.equal(other.events("agent_interaction_created").length, 0);
        assert.equal(f.client.events("tool_call").length, 0);
        assert.equal(f.session.interactionsForScope(f.scope).length, 1);
        assert.throws(() => f.session.assertNoPendingInteraction(f.scope), errorCode("INTERACTION_PENDING"));
    }
});

test("未托管、缺来源与旧MCP来源均拒绝，新工具不能使用模型伪造scope", async (t) => {
    const f = fixture(t);
    await assert.rejects(f.session.callTool(cases[0].name, cases[0].input), errorCode("INTERACTION_UNMANAGED_RUN"));
    const token = start(f, "turn-1");
    assert.equal(f.session.managedToolToken(undefined), undefined);
    await assert.rejects(f.session.callTool("canvas_create_text_node", { text: "缺少来源" }), errorCode("INTERACTION_RUN_REQUIRED"));
    assert.throws(() => f.session.managedToolToken({ invalid: true }), errorCode("INTERACTION_RUN_STALE"));
    assert.throws(() => f.session.managedToolToken({ threadId: "other-thread", turnId: "turn-1" }), errorCode("INTERACTION_RUN_STALE"));
    assert.equal(f.session.managedToolToken({ threadId: "thread-1", turnId: "turn-1" }), token);
    await assert.rejects(f.session.callTool(cases[0].name, { ...cases[0].input, sourceClientId: "other" }, token));
    assert.equal(f.session.interactionsForScope(f.scope).length, 0);
    finish(f, token, "turn-1");
    assert.throws(() => f.session.managedToolToken({ threadId: "thread-1", turnId: "turn-1" }), errorCode("INTERACTION_RUN_STALE"));
    await assert.rejects(f.session.callTool("canvas_create_text_node", { text: "迟到写入" }, token), errorCode("INTERACTION_RUN_STALE"));
    assert.throws(() => f.session.managedToolToken({ invalid: true }), errorCode("INTERACTION_RUN_STALE"));
    assert.equal(f.session.managedToolToken(undefined), undefined);
    const legacyWrite = f.session.callTool("canvas_create_text_node", { text: "普通run完成后保留个人MCP写入" });
    const request = f.client.events("tool_call").at(-1)!;
    f.session.resolveResult("client-1", { requestId: String(request.requestId), result: { ok: true } });
    assert.deepEqual(await legacyWrite, { ok: true });
    assert.equal((await f.session.callTool("canvas_get_state", {}) as { projectId: string }).projectId, "project-1");
});

test("未知external来源仅在无保护流程时保留legacy读写，已知旧run永不降级", async (t) => {
    const f = fixture(t);
    const external = { threadId: "external-thread", turnId: "external-turn" };
    const legacyToken = f.session.managedToolToken(external);
    assert.equal(legacyToken, undefined);
    assert.equal((await f.session.callTool("canvas_get_state", {}, legacyToken) as { projectId: string }).projectId, "project-1");
    const initialWrite = f.session.callTool("canvas_create_text_node", { text: "external个人MCP初始写入" }, legacyToken);
    const initialRequest = f.client.events("tool_call").at(-1)!;
    f.session.resolveResult("client-1", { requestId: String(initialRequest.requestId), result: { stage: "initial" } });
    assert.deepEqual(await initialWrite, { stage: "initial" });
    for (const item of cases) await assert.rejects(f.session.callTool(item.name, item.input, f.session.managedToolToken(external)), errorCode("INTERACTION_UNMANAGED_RUN"));
    for (const source of [{ invalid: true }, { threadId: "", turnId: "external-turn" }, { threadId: "   ", turnId: "external-turn" }]) assert.throws(() => f.session.managedToolToken(source), errorCode("INTERACTION_RUN_STALE"));
    const token = start(f, "turn-1");
    assert.throws(() => f.session.managedToolToken(external), errorCode("INTERACTION_RUN_STALE"));
    const interaction = await create(f, token);
    finish(f, token, "turn-1");
    assert.throws(() => f.session.managedToolToken(external), errorCode("INTERACTION_RUN_STALE"));
    f.session.decideInteraction("proposal", interaction.id, decisionBody(f.scope, interaction, { approved: true }));
    assert.throws(() => f.session.managedToolToken(external), errorCode("INTERACTION_RUN_STALE"));
    const claimed = f.session.claimQueuedInteraction()!;
    const continuation = start(f, "turn-2", claimed.interaction);
    assert.throws(() => f.session.managedToolToken(external), errorCode("INTERACTION_RUN_STALE"));
    finish(f, continuation, "turn-2");
    assert.equal(f.session.managedToolToken(external), undefined);
    const finalWrite = f.session.callTool("canvas_create_text_node", { text: "保护流程结束后恢复external个人MCP" }, f.session.managedToolToken(external));
    const finalRequest = f.client.events("tool_call").at(-1)!;
    f.session.resolveResult("client-1", { requestId: String(finalRequest.requestId), result: { stage: "final" } });
    assert.deepEqual(await finalWrite, { stage: "final" });
    for (const turnId of ["turn-1", "turn-2"]) assert.throws(() => f.session.managedToolToken({ threadId: "thread-1", turnId }), errorCode("INTERACTION_RUN_STALE"));
});

test("同工具内容重放幂等，变更内容及同turn第二个请求冲突", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const first = await create(f, token);
    const replay = await create(f, token);
    assert.deepEqual(replay, first);
    assert.equal(f.client.events("agent_interaction_created").length, 1);
    await assert.rejects(f.session.callTool(cases[0].name, { ...cases[0].input, summary: "不同内容" }, token), errorCode("INTERACTION_ID_CONFLICT"));
    await assert.rejects(f.session.callTool(cases[1].name, cases[1].input, token), errorCode("INTERACTION_TURN_CONFLICT"));
    first.input = { proposalId: "spoof", summary: "修改返回值", actions: [] };
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.id, "proposal-1");
    assert.equal((f.session.interactionsForScope(f.scope)[0]!.input as { summary: string }).summary, "建立三张草稿");
});

test("提前决定只排队，原turn写栅栏持续至finish，新turn只能claim一次", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const interaction = await create(f, token);
    const body = decisionBody(f.scope, interaction, { approved: true });
    const accepted = f.session.decideInteraction("proposal", interaction.id, body);
    assert.equal(accepted.interaction.status, "queued");
    assert.equal(accepted.duplicate, false);
    assert.equal(f.session.claimQueuedInteraction(), null);
    await assert.rejects(f.session.callTool("canvas_create_text_node", { text: "有待处理请求时legacy也不能越过" }), errorCode("INTERACTION_RUN_REQUIRED"));
    for (const [name, input] of [
        ["canvas_create_text_node", { text: "不能写" }],
        ["canvas_apply_ops", { ops: [{ type: "run_generation", nodeId: "node-1" }] }],
        ["canvas_generate_image", { prompt: "不能生成" }],
        ["canvas_create_attachment_nodes", { attachmentIds: ["attachment-1"] }],
        ["workbench_image_generate", { prompt: "不能转工作台" }],
        ["assets_add", { kind: "text", title: "受保护的素材", content: "不能加素材" }],
        ["site_navigate", { path: "/image" }],
    ] as const) await assert.rejects(f.session.callTool(name, input, token), errorCode("INTERACTION_PENDING"));
    assert.equal((await f.session.callTool("canvas_get_state", {}, token) as { projectId: string }).projectId, "project-1");
    finish(f, token, "turn-1");
    const claimed = f.session.claimQueuedInteraction()!;
    assert.equal(claimed.interaction.status, "continuing");
    assert.equal(claimed.prompt.includes("批准"), true);
    assert.deepEqual(claimed.settings, settings);
    assert.equal(f.session.claimQueuedInteraction(), null);
    assert.equal(f.session.decideInteraction("proposal", interaction.id, body).duplicate, true);
    assert.throws(() => f.session.decideInteraction("proposal", interaction.id, { ...body, approved: false }), errorCode("INTERACTION_DECISION_CONFLICT"));
    const continuation = start(f, "turn-2", claimed.interaction);
    await assert.rejects(f.session.callTool("canvas_create_text_node", { text: "旧turn不能借批准写入" }, token), errorCode("INTERACTION_RUN_STALE"));
    finish(f, continuation, "turn-2");
    const completed = f.session.interactionsForScope(f.scope)[0]!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.continuationTurnId, "turn-2");
    assert.equal(f.session.decideInteraction("proposal", interaction.id, body).duplicate, true);
    assert.equal(f.session.claimQueuedInteraction(), null);
});

test("拒绝和取消的续接只读；不能篡改claim副本解除拒绝，仍可提出下一问题", async (t) => {
    for (const item of [cases[0], cases[2]]) {
        const f = fixture(t);
        const token = start(f, "turn-1");
        const interaction = (await f.session.callTool(item.name, item.input, token) as { interaction: Interaction }).interaction;
        f.session.decideInteraction(item.kind, interaction.id, decisionBody(f.scope, interaction, item.kind === "proposal" ? { approved: false, reason: "保留原样" } : { confirmed: false }));
        finish(f, token, "turn-1");
        const claimed = f.session.claimQueuedInteraction()!;
        assert.equal(claimed.prompt.includes("不得执行"), true);
        claimed.interaction.decision = item.kind === "proposal" ? { approved: true, decisionSource: "manual" } : { confirmed: true, decisionSource: "manual" };
        const continuation = start(f, "turn-2", claimed.interaction);
        await assert.rejects(f.session.callTool("canvas_create_text_node", { text: "越过拒绝" }, continuation), errorCode("INTERACTION_READ_ONLY"));
        assert.equal((await f.session.callTool("canvas_get_selection", {}, continuation) as { nodes: unknown[] }).nodes.length, 0);
        const next = await f.session.callTool(cases[1].name, cases[1].input, continuation) as { interaction: Interaction };
        assert.equal(next.interaction.status, "pending");
        assert.equal(next.interaction.sourceTurnId, "turn-2");
        finish(f, continuation, "turn-2");
        assert.equal(f.session.interactionsForScope(f.scope).find((entry) => entry.id === interaction.id)!.status, "completed");
    }
});

test("中断、失败、不明结果以及伪completed轮次均不续接", async (t) => {
    for (const status of ["interrupted", "failed", "unknown", "completed"] as const) {
        const f = fixture(t);
        const token = start(f, "turn-1");
        const interaction = await create(f, token);
        const body = decisionBody(f.scope, interaction, { approved: true });
        f.session.decideInteraction("proposal", interaction.id, body);
        finish(f, token, status === "completed" ? "wrong-turn" : "turn-1", status);
        assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "expired");
        assert.equal(f.session.decideInteraction("proposal", interaction.id, body).duplicate, true);
        assert.throws(() => f.session.decideInteraction("proposal", interaction.id, { ...body, approved: false }), errorCode("INTERACTION_DECISION_CONFLICT"));
        assert.equal(f.session.claimQueuedInteraction(), null);
    }
});

test("owner/project/conversation变化永久失效，切回原范围也不会复活", async (t) => {
    for (const change of ["owner", "project", "conversation"] as const) {
        const f = fixture(t);
        const token = start(f, "turn-1");
        const interaction = await create(f, token);
        finish(f, token, "turn-1");
        if (change === "owner") {
            connect(f.session, t, "client-1", "owner-2");
            connect(f.session, t, "client-1", "owner-1");
        } else if (change === "project") {
            f.session.updateState({ projectId: "project-2" }, "client-1");
            f.session.updateState({ projectId: "project-1" }, "client-1");
        } else {
            f.session.activateConversation("thread-2", "client-1");
            f.session.activateConversation("thread-1", "client-1");
        }
        assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "expired");
        assert.throws(() => f.session.decideInteraction("proposal", interaction.id, decisionBody(f.scope, interaction, { approved: true })), errorCode("INTERACTION_EXPIRED"));
        assert.equal(f.session.claimQueuedInteraction(), null);
    }
});

test("同scope刷新保留权威快照，GET/hello/重放不会决定或自动claim", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const interaction = await create(f, token);
    finish(f, token, "turn-1");
    f.client.close();
    const refreshed = connect(f.session, t, "client-1", "owner-1");
    const hello = refreshed.events("hello")[0]!;
    assert.equal(hello.protocolVersion, 7);
    assert.equal((hello.interactions as Interaction[])[0]!.status, "pending");
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.revision, 1);
    assert.equal(refreshed.events("agent_interaction_created").length, 0);
    f.session.decideInteraction("proposal", interaction.id, decisionBody(f.scope, interaction, { approved: true }));
    const again = connect(f.session, t, "client-1", "owner-1");
    assert.equal((again.events("hello")[0]!.interactions as Interaction[])[0]!.status, "queued");
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "queued");
    assert.equal(f.session.claimQueuedInteraction(), null);
    f.session.updateState({ projectId: "project-1", nodes: [], connections: [] }, "client-1");
    assert.equal(f.session.claimQueuedInteraction()!.interaction.status, "continuing");
    assert.equal(f.session.claimQueuedInteraction(), null);
});

test("已决定且原turn完成后暂时断线仍保持queued，同scope重连仅claim一次", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const interaction = await create(f, token);
    f.session.decideInteraction("proposal", interaction.id, decisionBody(f.scope, interaction, { approved: true }));
    finish(f, token, "turn-1");
    f.client.close();
    assert.equal(f.session.claimQueuedInteraction(), null);
    assert.equal(f.session.claimQueuedInteraction(), null);
    const refreshed = connect(f.session, t, "client-1", "owner-1");
    assert.equal((refreshed.events("hello")[0]!.interactions as Interaction[])[0]!.status, "queued");
    assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "queued");
    assert.equal(f.session.claimQueuedInteraction(), null);
    f.session.updateState({ projectId: "project-1", nodes: [], connections: [] }, "client-1");
    const claimed = f.session.claimQueuedInteraction()!;
    const continuation = start(f, "turn-2", claimed.interaction);
    refreshed.close();
    finish(f, continuation, "turn-2");
    const completed = connect(f.session, t, "client-1", "owner-1");
    assert.equal((completed.events("hello")[0]!.interactions as Interaction[])[0]!.status, "completed");
    assert.equal(f.session.claimQueuedInteraction(), null);
});

test("原run遇同client新连接，重新上报state前不能写入新页面", async (t) => {
    const f = fixture(t);
    const token = start(f, "turn-1");
    const refreshed = connect(f.session, t, "client-1", "owner-1");
    await assert.rejects(f.session.callTool("canvas_create_text_node", { text: "未知新页面" }, token), errorCode("INTERACTION_SCOPE_UNCONFIRMED"));
    await assert.rejects(f.session.callTool(cases[0].name, cases[0].input, token), errorCode("INTERACTION_SCOPE_UNCONFIRMED"));
    assert.equal(refreshed.events("tool_call").length, 0);
    f.session.updateState({ projectId: "project-1", nodes: [], connections: [] }, "client-1");
    const writing = f.session.callTool("canvas_create_text_node", { text: "同项目状态已确认" }, token);
    const request = refreshed.events("tool_call").at(-1)!;
    f.session.resolveResult("client-1", { requestId: String(request.requestId), result: { ok: true } });
    assert.deepEqual(await writing, { ok: true });
});

test("决定严格校验scope/stream/revision；客户端隔离并保留未知POST结果的幂等结论", async (t) => {
    const f = fixture(t);
    const other = connect(f.session, t, "other", "owner-1");
    f.session.updateState({ projectId: "project-1" }, "other");
    const token = start(f, "turn-1");
    const interaction = await create(f, token);
    const body = decisionBody(f.scope, interaction, { approved: true });
    for (const patch of [{ streamId: "old-process" }, { expectedInteractionRevision: 2 }, { clientId: "other" }, { ownerContext: "owner-2" }, { projectId: "project-2" }, { threadId: "thread-2" }, { conversationId: "other-conversation" }]) assert.throws(() => f.session.decideInteraction("proposal", interaction.id, { ...body, ...patch }), InteractionError);
    assert.equal(f.session.interactionsForScope({ ...f.scope, clientId: "other" }).length, 0);
    assert.equal(other.events("agent_interaction_created").length, 0);
    f.session.decideInteraction("proposal", interaction.id, body);
    const recovered = f.session.interactionsForScope(f.scope)[0]!;
    assert.equal(recovered.status, "queued");
    assert.equal((recovered.decision as { approved: boolean }).approved, true);
    assert.equal(f.session.decideInteraction("proposal", interaction.id, body).duplicate, true);
    assert.equal(f.client.events("agent_proposal_decided").length, 1);
    assert.equal(other.events("agent_proposal_decided").length, 0);
});

test("claim后的启动失败与续接失败保持终态，重复决定不再次claim", async (t) => {
    for (const beforeStart of [true, false]) {
        const f = fixture(t);
        const token = start(f, "turn-1");
        const interaction = await create(f, token);
        const body = decisionBody(f.scope, interaction, { approved: true });
        f.session.decideInteraction("proposal", interaction.id, body);
        finish(f, token, "turn-1");
        const claimed = f.session.claimQueuedInteraction()!;
        if (beforeStart) f.session.failClaimedInteraction(claimed.interaction, "合成派发失败");
        else {
            const continuation = start(f, "turn-2", claimed.interaction);
            f.session.failClaimedInteraction(claimed.interaction, "已绑定run不能被此入口覆盖");
            assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "continuing");
            finish(f, continuation, "turn-2", "failed");
        }
        assert.equal(f.session.interactionsForScope(f.scope)[0]!.status, "continuation_failed");
        assert.equal(f.session.decideInteraction("proposal", interaction.id, body).duplicate, true);
        assert.equal(f.session.claimQueuedInteraction(), null);
    }
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

async function create(f: ReturnType<typeof fixture>, token: string) {
    return (await f.session.callTool(cases[0].name, cases[0].input, token) as { interaction: Interaction }).interaction;
}

function decisionBody(scope: InteractionScope, interaction: Interaction, decision: Record<string, unknown>) {
    return { ...scope, streamId: interaction.streamId, expectedInteractionRevision: interaction.revision, ...decision };
}

function errorCode(code: string) {
    return (error: unknown) => error instanceof InteractionError && error.code === code;
}

function connect(session: CanvasSession, t: TestContext, clientId: string, ownerContext: string) {
    const response = new SseResponse();
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}&ownerContext=${ownerContext}`), response as unknown as ServerResponse, "thread-1");
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
