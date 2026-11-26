import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, mock, spyOn, test } from "bun:test";
import actualExpress from "express";

import type { AgentAttachment, AgentEmit } from "../agent/types.js";
import type { CanvasSession } from "../canvas/session.js";

// Run alone in a fresh Bun process. The actual Express router, token checks,
// CanvasSession and metadata store remain real; config and external engines do not.
type Outcome = { status: "completed" | "interrupted" | "failed" | "unknown"; threadId: string; turnId: string; error?: string };
type RunOptions = {
    threadId?: string; cwd?: string; permissionMode?: string; model?: string; effort?: string;
    skill?: { name: string; path: string }; messageText?: string; strictThread?: boolean; appEmit?: AgentEmit;
    onStart?(): void; onThread?(id: string): void; onTurn?(id: string): void; onFinish?(outcome: Outcome): void;
};
type Run = { prompt: string; emit: AgentEmit; attachments: AgentAttachment[]; options: RunOptions; turnId: string; runToken: string; finished: boolean; finish(status?: Outcome["status"]): void };
type Interaction = {
    id: string; kind: "proposal" | "question" | "generation_confirm"; input: Record<string, unknown>;
    streamId: string; threadId: string; conversationId: string; sourceTurnId: string; sourceClientId: string;
    ownerContext: string; projectId: string | null; revision: number; status: string;
    decision?: Record<string, unknown>; continuationTurnId?: string; error?: string;
};
type Connection = { reader: ReadableStreamDefaultReader<Uint8Array>; abort: AbortController; hello: Record<string, unknown>; close(): Promise<void> };
const clientId = "synthetic-business-client", ownerContext = "synthetic-business-owner";
const runs: Run[] = [], connections = new Set<Connection>(), sockets = new Set<Socket>();
const externalCalls: string[] = [];
let directory = "", base = "", token = "", threadId = "", projectId = "", latestRunToken = "";
let caseNumber = 0, turnNumber = 0;
let server: Server | undefined, session: CanvasSession;
let workspace: { workspacePath: string; activeThreadId: string };
let store: InstanceType<typeof import("../agent/message-metadata.js").MessageMetadataStore>;

beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-http-interactions-"));
    token = randomUUID();
    workspace = { workspacePath: path.join(directory, "workspace"), activeThreadId: "synthetic-bootstrap-thread" };
    const config = { url: "http://127.0.0.1:0", token, workspace, origins: [] as string[] };
    mock.module("../config.js", () => ({
        DEFAULT_PORT: 17371, CONFIG_DIR: path.join(directory, "config"),
        loadConfig: () => config, saveConfig: () => {}, ensureSiteWorkspace: () => workspace,
        updateSiteWorkspace: (_config: unknown, patch: object) => Object.assign(workspace, patch),
    }));
    mock.module("../utils/logger.js", () => ({ logger: { enabled: false, filePath: "", info() {}, debug() {}, warn() {}, error() {} } }));
    const unexpected = (name: string) => mock(() => { externalCalls.push(name); throw new Error(`Unexpected external boundary: ${name}`); });
    mock.module("../agent/claude.js", () => ({ runClaudeTurn: unexpected("claude") }));
    mock.module("../version-check.js", () => ({ checkVersions: unexpected("versionCheck") }));
    class BoundaryError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
    mock.module("../skills/store.js", () => ({ SkillStore: class {}, SkillStoreError: BoundaryError }));
    const run = mock((prompt: string, _emit: AgentEmit, attachments: AgentAttachment[], options: RunOptions) => {
        const actualThreadId = options.threadId || "unexpected-new-thread";
        const actualTurnId = `synthetic-business-turn-${++turnNumber}`;
        let resolve!: (outcome: Outcome) => void;
        const result = new Promise<Outcome>((done) => { resolve = done; });
        const entry: Run = {
            prompt, emit: _emit, attachments, options, turnId: actualTurnId, runToken: latestRunToken, finished: false,
            finish(status = "completed") {
                if (entry.finished) return;
                entry.finished = true;
                const outcome: Outcome = { status, threadId: actualThreadId, turnId: actualTurnId, ...(status === "failed" ? { error: "synthetic engine failure" } : {}) };
                options.appEmit?.("agent_event", { type: "turn.completed", status, thread_id: actualThreadId, turn_id: actualTurnId });
                options.onFinish?.(outcome);
                resolve(outcome);
            },
        };
        runs.push(entry);
        options.onStart?.();
        options.onThread?.(actualThreadId);
        options.onTurn?.(actualTurnId);
        return result;
    });
    mock.module("../agent/codex.js", () => ({
        CodexSkillLookupError: BoundaryError, runCodexTurn: run,
        resolveCodexSkill: async (_emit: unknown, _cwd: string, selector: { name: string; path: string }) => selector,
        isRecoverableThreadError: () => false, summarizeCodexThread: (value: unknown) => value,
        resumeCodexThread: async (emit: AgentEmit, resumedThreadId: string) => {
            assert.equal(resumedThreadId, threadId);
            assert.match(resumedThreadId, /^synthetic-business-thread-/);
            emit("agent_bootstrap", { type: "mcp.complete", phase: "preheat", threadId: resumedThreadId, services: [{ name: "infinite-canvas", authStatus: "unsupported" }] });
            return { thread: { id: resumedThreadId }, messages: [], settledTurnIds: [], historyReady: true };
        },
        ...Object.fromEntries([
            "archiveCodexThread", "configureCodexSkill", "generateCodexSkillDraft", "interruptCodexTurn",
            "listCodexModels", "listCodexSkills", "listCodexThreads", "readCodexThread",
            "resolveCodexApproval", "startCodexThread",
        ].map((name) => [name, unexpected(name)])),
    }));
    const { MessageMetadataStore } = await import("../agent/message-metadata.js");
    store = new MessageMetadataStore(path.join(directory, "metadata"));
    mock.module("../agent/message-metadata.js", () => ({ MessageMetadataStore, messageMetadataStore: store }));
    const { CanvasSession: ActualSession } = await import("../canvas/session.js");
    const openEvents = ActualSession.prototype.openEvents;
    spyOn(ActualSession.prototype, "openEvents").mockImplementation(function (this: CanvasSession, ...args: Parameters<typeof openEvents>) {
        session = this;
        return openEvents.apply(this, args);
    });
    const startManagedRun = ActualSession.prototype.startManagedRun;
    spyOn(ActualSession.prototype, "startManagedRun").mockImplementation(function (this: CanvasSession, ...args: Parameters<typeof startManagedRun>) {
        latestRunToken = startManagedRun.apply(this, args);
        return latestRunToken;
    });
    let listening!: () => void, failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { listening = resolve; failed = reject; });
    const realExpress = actualExpress;
    const makeExpress = Object.assign(() => {
        const app = realExpress();
        app.listen = (() => {
            server = createServer(app);
            server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
            server.once("error", failed);
            return server.listen(0, "127.0.0.1", listening);
        }) as typeof app.listen;
        return app;
    }, { json: realExpress.json });
    mock.module("express", () => ({ default: makeExpress }));
    const { startHttpServer } = await import("./http.js");
    startHttpServer();
    await ready;
    const address = server!.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    const initial = await connect();
    assert.equal(initial.hello.protocolVersion, 7);
    await initial.close();
});

beforeEach(async () => {
    runs.length = 0;
    latestRunToken = "";
    threadId = `synthetic-business-thread-${++caseNumber}`;
    projectId = `synthetic-business-project-${caseNumber}`;
    workspace.activeThreadId = threadId;
    session.activateConversation(threadId, clientId);
    session.setCodexState({ busy: false, threadId, turnId: "" });
    await connect();
    await setProject(projectId);
});

afterEach(async () => {
    for (const run of runs) run.finish("interrupted");
    await settle();
    await Promise.all([...connections].map((connection) => connection.close()));
    assert.deepEqual(externalCalls, []);
});

afterAll(async () => {
    try {
        for (const run of runs) run.finish("interrupted");
        await Promise.all([...connections].map((connection) => connection.close()));
        if (server?.listening) {
            const closed = new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
            sockets.forEach((socket) => socket.destroy());
            await closed;
        } else sockets.forEach((socket) => socket.destroy());
    } finally {
        if (store) await store.mergeThread(threadId, []).catch(() => undefined);
        mock.restore();
        if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
});

test("three business routes queue locally, finish the source turn, and continue the same thread once", async () => {
    const cases = [
        { tool: "canvas_create_proposal", input: { proposalId: "proposal-normal", summary: "方案摘要", actions: ["引用动作展示"] }, decision: { approved: true, reason: "用户同意" }, path: "/agent/proposal/proposal-normal/decision", words: ["方案摘要", "用户同意"] },
        { tool: "canvas_ask_user", input: { questionId: "question-normal", question: "选择哪一种风格？", placeholder: "输入偏好" }, decision: { answer: "选择柔和风格" }, path: "/agent/question/question-normal/answer", words: ["选择哪一种风格", "选择柔和风格"] },
        { tool: "canvas_request_generation_confirm", input: { confirmId: "confirm-normal", description: "生成三张图片", estimatedCost: 2.5 }, decision: { confirmed: true, decisionSource: "auto" }, path: "/agent/generation-confirm/confirm-normal", words: ["生成三张图片", "自动"] },
    ];
    for (const [index, item] of cases.entries()) {
        const source = await startTurn({ permissionMode: ["request", "automatic", "full"][index], model: `synthetic-source-model-${index}` });
        const interaction = await createInteraction(source, item.tool, item.input);
        assert.equal(interaction.status, "pending");
        assert.equal(interaction.sourceTurnId, source.turnId);
        assert.equal(interaction.ownerContext, ownerContext);
        const response = await post(item.path, { ...scope(interaction), ...item.decision });
        assert.equal(response.status, 202);
        const accepted = await response.json() as { ok: boolean; interaction: Interaction };
        assert.equal(accepted.ok, true);
        assert.equal(accepted.interaction.status, "queued");
        assert.equal(runs.at(-1), source);
        const sourceWrite = await toolRequest(source, "canvas_create_text_node", { text: "must not write in source turn" });
        assert.equal(sourceWrite.status, 409);
        assert.equal((await sourceWrite.json() as { code: string }).code, "INTERACTION_PENDING");
        const blocked = await postTurn();
        assert.equal(blocked.status, 409);
        await blocked.arrayBuffer();
        source.finish();
        await settle();
        const continuation = runs.at(-1)!;
        assert.notEqual(continuation, source);
        const lateSourceWrite = await toolRequest(source, "canvas_create_text_node", { text: "late source cannot act on approved plan" });
        assert.equal(lateSourceWrite.status, 409);
        await lateSourceWrite.arrayBuffer();
        assert.equal(continuation.options.threadId, threadId);
        assert.equal(continuation.options.strictThread, true);
        assert.equal(continuation.options.model, source.options.model);
        assert.equal(continuation.options.effort, source.options.effort);
        assert.equal(continuation.options.permissionMode, source.options.permissionMode);
        assert.deepEqual(continuation.options.skill, source.options.skill);
        assert.deepEqual(continuation.attachments, []);
        for (const word of item.words) assert.ok(continuation.prompt.includes(word), continuation.prompt);
        const beforeRepeat = runs.length;
        const duplicate = await post(item.path, { ...scope(interaction), ...item.decision });
        assert.equal(duplicate.status, 200);
        await duplicate.arrayBuffer();
        assert.equal(runs.length, beforeRepeat);
        continuation.finish();
        await settle();
        const completed = (await interactions()).find((entry) => entry.id === interaction.id)!;
        assert.equal(completed.status, "completed");
        assert.equal(completed.continuationTurnId, continuation.turnId);
    }
});

test("decision replay is idempotent, opposite decisions conflict, and reads or reconnect do not dispatch", async () => {
    const source = await startTurn();
    const interaction = await createInteraction(source, "canvas_create_proposal", { proposalId: "proposal-repeat", summary: "只继续一次", estimatedCost: 12345, actions: ["展示动作"] });
    const decision = { ...scope(interaction), approved: true };
    const first = await post("/agent/proposal/proposal-repeat/decision", decision);
    assert.equal(first.status, 202);
    await first.arrayBuffer();
    const duplicate = await post("/agent/proposal/proposal-repeat/decision", decision);
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json() as { interaction: Interaction };
    assert.equal(duplicateBody.interaction.status, "queued");
    const conflict = await post("/agent/proposal/proposal-repeat/decision", { ...decision, approved: false });
    assert.equal(conflict.status, 409);
    await conflict.arrayBuffer();
    assert.equal((await interactions())[0]!.status, "queued");
    const recovered = await connect();
    assert.equal((recovered.hello.interactions as Interaction[]).find((entry) => entry.id === interaction.id)?.status, "queued");
    assert.equal(runs.length, 1);
    await setProject(projectId);
    source.finish();
    await settle();
    assert.equal(runs.length, 2);
    runs[1]!.finish();
    await settle();
    await interactions();
    await connect();
    assert.equal(runs.length, 2);
    assert.deepEqual(externalCalls, []); // An estimate never invokes quotes, providers or wallet code.
});

test("the authority requires token, live original client and complete unchanged scope", async () => {
    const source = await startTurn();
    const interaction = await createInteraction(source, "canvas_ask_user", { questionId: "question-scope", question: "作用域问题" });
    const route = "/agent/question/question-scope/answer", correct = { ...scope(interaction), answer: "原始回答" };
    const unauthenticated = await post(route, correct, "incorrect-token");
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.arrayBuffer();
    for (const patch of [
        { clientId: "other-client" }, { ownerContext: "other-owner" }, { projectId: "other-project" },
        { threadId: "other-thread" }, { conversationId: "other-conversation" }, { streamId: "other-stream" },
        { expectedInteractionRevision: 999 },
    ]) {
        const response = await post(route, { ...correct, ...patch });
        assert.equal(response.status, 409, JSON.stringify(patch));
        await response.arrayBuffer();
    }
    const badQuery = new URLSearchParams(queryScope());
    badQuery.set("ownerContext", "other-owner");
    const wrongRead = await fetch(`${base}/agent/interactions?${badQuery}`, { headers: auth() });
    assert.equal(wrongRead.status, 409);
    await wrongRead.arrayBuffer();
    assert.equal((await interactions())[0]!.status, "pending");
    assert.equal(runs.length, 1);
});

test("the real tool route rejects missing, mismatched and completed source turns instead of borrowing the active run", async () => {
    const first = await startTurn();
    const input = { questionId: "question-source-proof", question: "可靠来源" };
    for (const source of [undefined, { threadId: "different-thread", turnId: first.turnId }, { threadId, turnId: "different-turn" }]) {
        const response = await post("/api/tools", { name: "canvas_ask_user", input, ...(source ? { source } : {}) });
        assert.equal(response.status, 409);
        await response.arrayBuffer();
    }
    assert.deepEqual(await interactions(), []);
    first.finish();
    await settle();
    const current = await startTurn();
    for (const [name, staleInput] of [["canvas_ask_user", input], ["canvas_create_text_node", { text: "late old turn" }]] as const) {
        const stale = await toolRequest(first, name, staleInput);
        assert.equal(stale.status, 409);
        await stale.arrayBuffer();
    }
    await assert.rejects(session.callTool("canvas_create_text_node", { text: "old in-process capability" }, first.runToken));
    assert.deepEqual(await interactions(), []);
    const created = await createInteraction(current, "canvas_ask_user", input);
    assert.equal(created.sourceTurnId, current.turnId);
    assert.equal(runs.length, 2);
});

test("global question events require their own source and emit one canonical card only to that source", async () => {
    await connect(ownerContext, "synthetic-question-observer");
    const source = await startTurn();
    const original = captureEvents(clientId), observer = captureEvents("synthetic-question-observer");
    const payload = { questionId: "question-global-event", text: "选择哪一种色调？", threadId, turnId: source.turnId,
        sourceClientId: clientId, ownerContext, rawMarker: "must not be broadcast" };
    try {
        for (const invalid of [
            { questionId: payload.questionId, text: payload.text, ownerContext },
            { ...payload, sourceClientId: "synthetic-question-observer" },
            { ...payload, ownerContext: "different-owner" },
            { ...payload, turnId: "stale-turn" },
        ]) source.options.appEmit!("agent_question", invalid);
        assert.deepEqual(await interactions(), []);
        assert.deepEqual(original.events("agent_question"), []);
        assert.deepEqual(observer.events("agent_question"), []);

        source.options.appEmit!("agent_question", payload);
        const [interaction] = await interactions();
        assert.ok(interaction);
        const [event] = original.events("agent_question");
        assert.ok(event);
        assert.equal(event.questionId, payload.questionId);
        assert.equal(event.text, payload.text);
        assert.equal(typeof event.seq, "number");
        assert.equal(event.threadId, threadId);
        assert.equal(event.turnId, source.turnId);
        assert.equal(event.sourceClientId, clientId);
        assert.equal(event.ownerContext, ownerContext);
        assert.deepEqual(event.interaction, interaction);
        assert.equal(event.rawMarker, undefined);
        source.options.appEmit!("agent_question", payload);
        assert.equal((await interactions()).length, 1);
        assert.equal(original.events("agent_question").length, 1);
        assert.equal(original.events("agent_interaction_created").length, 1);
        assert.deepEqual(observer.events("agent_question"), []);
        assert.deepEqual(observer.events("agent_interaction_created"), []);
    } finally { original.restore(); observer.restore(); }
});

test("lifecycle questions use the frozen run source and a stale callback cannot borrow the next turn", async () => {
    await connect(ownerContext, "synthetic-lifecycle-observer");
    const source = await startTurn();
    const original = captureEvents(clientId), observer = captureEvents("synthetic-lifecycle-observer");
    try {
        const payload = { questionId: "question-lifecycle-event", text: "原任务的问题", threadId: "spoofed-thread", turnId: "spoofed-turn",
            sourceClientId: "synthetic-lifecycle-observer", ownerContext: "spoofed-owner", rawMarker: true };
        source.emit("agent_question", payload);
        const [interaction] = await interactions();
        assert.ok(interaction);
        assert.equal(interaction.threadId, threadId);
        assert.equal(interaction.sourceTurnId, source.turnId);
        assert.equal(interaction.sourceClientId, clientId);
        assert.equal(interaction.ownerContext, ownerContext);
        assert.equal(interaction.projectId, projectId);
        assert.deepEqual(original.events("agent_question").map((event) => event.interaction), [interaction]);
        assert.equal(original.events("agent_question")[0]!.rawMarker, undefined);
        assert.deepEqual(observer.events("agent_question"), []);
        source.finish("failed");
        await settle();
        const current = await startTurn();
        source.emit("agent_question", { questionId: "question-stale-callback", text: "迟到的问题", threadId, turnId: current.turnId,
            sourceClientId: clientId, ownerContext });
        assert.equal((await interactions()).some((entry) => entry.id === "question-stale-callback"), false);
        assert.equal(original.events("agent_question").length, 1);
        assert.deepEqual(observer.events("agent_question"), []);
    } finally { original.restore(); observer.restore(); }
});

test("global proposal events validate their source and preserve zero cost and nested actions in one scoped card", async () => {
    await connect(ownerContext, "synthetic-proposal-observer");
    const source = await startTurn();
    const original = captureEvents(clientId), observer = captureEvents("synthetic-proposal-observer");
    const input = { proposalId: "proposal-global-event", summary: "保留原稿并添加草稿", estimatedCost: 0, actions: ["保留原节点", "新增草稿"] };
    const snapshot = { id: input.proposalId, kind: "proposal", input, streamId: [...connections].find((connection) => connection.hello.clientId === clientId)!.hello.streamId,
        threadId, conversationId: queryScope().conversationId, sourceTurnId: source.turnId, sourceClientId: clientId, ownerContext, projectId, revision: 1, status: "pending" };
    const payload = { proposalId: input.proposalId, summary: input.summary, estimatedCost: 0, threadId, turnId: source.turnId,
        sourceClientId: clientId, ownerContext, interaction: snapshot, rawMarker: "must not be broadcast" };
    try {
        for (const invalid of [
            { proposalId: input.proposalId, summary: input.summary, ownerContext },
            { ...payload, sourceClientId: "synthetic-proposal-observer" },
            { ...payload, ownerContext: "different-owner" },
            { ...payload, turnId: "stale-turn" },
            { ...payload, actions: [...input.actions].reverse() },
            { ...payload, estimatedCost: 1 },
        ]) source.options.appEmit!("agent_proposal", invalid);
        assert.deepEqual(await interactions(), []);
        assert.deepEqual(original.events("agent_proposal"), []);
        assert.deepEqual(observer.events("agent_proposal"), []);
        source.options.appEmit!("agent_proposal", payload);
        const [interaction] = await interactions();
        assert.ok(interaction);
        assert.deepEqual(interaction.input, input);
        const [event] = original.events("agent_proposal");
        assert.ok(event);
        assert.equal(event.proposalId, input.proposalId);
        assert.equal(event.summary, input.summary);
        assert.equal(event.estimatedCost, 0);
        assert.equal(typeof event.seq, "number");
        assert.equal(event.threadId, threadId);
        assert.equal(event.turnId, source.turnId);
        assert.equal(event.sourceClientId, clientId);
        assert.equal(event.ownerContext, ownerContext);
        assert.deepEqual(event.interaction, interaction);
        assert.equal(event.rawMarker, undefined);
        source.options.appEmit!("agent_proposal", payload);
        assert.equal((await interactions()).length, 1);
        assert.equal(original.events("agent_proposal").length, 1);
        assert.equal(original.events("agent_interaction_created").length, 1);
        assert.deepEqual(observer.events("agent_proposal"), []);
        assert.deepEqual(observer.events("agent_interaction_created"), []);
    } finally { original.restore(); observer.restore(); }
});

test("lifecycle and tool proposals keep the frozen source while stale callbacks cannot borrow a new turn", async () => {
    await connect(ownerContext, "synthetic-proposal-lifecycle-observer");
    const source = await startTurn();
    const original = captureEvents(clientId), observer = captureEvents("synthetic-proposal-lifecycle-observer");
    try {
        source.emit("agent_proposal", { proposalId: "proposal-lifecycle-event", summary: "原任务的方案", estimatedCost: 0, actions: ["保留原稿"],
            threadId: "spoofed-thread", turnId: "spoofed-turn", sourceClientId: "synthetic-proposal-lifecycle-observer", ownerContext: "spoofed-owner", rawMarker: true });
        const [interaction] = await interactions();
        assert.ok(interaction);
        assert.equal(interaction.threadId, threadId);
        assert.equal(interaction.sourceTurnId, source.turnId);
        assert.equal(interaction.sourceClientId, clientId);
        assert.equal(interaction.ownerContext, ownerContext);
        assert.equal(interaction.projectId, projectId);
        assert.deepEqual(interaction.input, { proposalId: "proposal-lifecycle-event", summary: "原任务的方案", estimatedCost: 0, actions: ["保留原稿"] });
        assert.deepEqual(original.events("agent_proposal").map((event) => event.interaction), [interaction]);
        assert.equal(original.events("agent_proposal")[0]!.rawMarker, undefined);
        source.finish("failed");
        await settle();
        const current = await startTurn();
        source.emit("agent_proposal", { proposalId: "proposal-stale-callback", summary: "迟到的方案", threadId, turnId: current.turnId, sourceClientId: clientId, ownerContext });
        assert.equal((await interactions()).some((entry) => entry.id === "proposal-stale-callback"), false);
        assert.equal(original.events("agent_proposal").length, 1);
        const created = await createInteraction(current, "canvas_create_proposal", { proposalId: "proposal-real-tool-event", summary: "工具创建的方案", actions: ["继续原稿"] });
        assert.deepEqual(original.events("agent_proposal").map((event) => event.interaction), [interaction, created]);
        assert.equal(original.events("agent_interaction_created").length, 2);
        const decision = await post("/agent/proposal/proposal-real-tool-event/decision", { ...scope(created), approved: true });
        assert.equal(decision.status, 202);
        const accepted = await decision.json() as { interaction: Interaction };
        assert.deepEqual(original.events("agent_proposal_decided").map((event) => event.interaction), [accepted.interaction]);
        assert.equal(accepted.interaction.status, "queued");
        for (const type of ["agent_proposal", "agent_interaction_created", "agent_proposal_decided"]) assert.deepEqual(observer.events(type), []);
    } finally { original.restore(); observer.restore(); }
});

test("normal messages cannot bypass a pending interaction after source completion", async () => {
    const source = await startTurn();
    const interaction = await createInteraction(source, "canvas_ask_user", { questionId: "question-pending", question: "先回答" });
    source.finish();
    await settle();
    const response = await postTurn({ prompt: "后来的草稿保持原样", attachments: [], skill: undefined });
    assert.equal(response.status, 409);
    const body = await response.json() as { code: string };
    assert.equal(body.code, "INTERACTION_PENDING");
    assert.equal(runs.length, 1);
    const accepted = await post("/agent/question/question-pending/answer", { ...scope(interaction), answer: "现在可以继续" });
    assert.ok([200, 202].includes(accepted.status));
    await accepted.arrayBuffer();
    await settle();
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.prompt.includes("后来的草稿保持原样"), false);
});

test("resuming the same thread preserves a distinct conversation identity and its pending card without dispatch", async () => {
    const conversationId = `synthetic-business-conversation-${caseNumber}`;
    assert.notEqual(conversationId, threadId);
    session.beginConversation({ threadId, conversationId, sourceClientId: clientId });
    session.completeConversationMcpInventory([{ name: "infinite-canvas", authStatus: "unsupported" }]);
    session.completeConversationPreparation(threadId);
    const source = await startTurn();
    const interaction = await createInteraction(source, "canvas_ask_user", { questionId: "question-resume", question: "刷新后继续显示的问题" });
    assert.equal(interaction.conversationId, conversationId);
    source.finish();
    await settle();
    const response = await post(`/agent/codex/threads/${encodeURIComponent(threadId)}/resume`, { clientId, ownerContext, projectId, permissionMode: "request" });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { conversation: { conversationId: string; status: string } };
    assert.equal(body.conversation.conversationId, conversationId);
    assert.equal(body.conversation.status, "ready");
    assert.equal(session.conversationStateSnapshot.conversationId, conversationId);
    const restored = (await interactions()).find((entry) => entry.id === interaction.id)!;
    assert.equal(restored.status, "pending");
    assert.equal(restored.conversationId, conversationId);
    assert.equal(runs.length, 1);
});

test("a queued decision survives a refresh gap and dispatches once after the original client reconnects", async () => {
    const source = await startTurn();
    const interaction = await createInteraction(source, "canvas_ask_user", { questionId: "question-refresh-gap", question: "刷新间隙收到完成信号" });
    const response = await post("/agent/question/question-refresh-gap/answer", { ...scope(interaction), answer: "原账号回答" });
    assert.equal(response.status, 202);
    await response.arrayBuffer();
    await Promise.all([...connections].map((connection) => connection.close()));
    await settle();
    assert.equal(session.hasClient(clientId), false);
    source.finish();
    await settle();
    assert.equal(runs.length, 1);
    const reconnected = await connect();
    assert.equal((reconnected.hello.interactions as Interaction[]).find((entry) => entry.id === interaction.id)?.status, "queued");
    await settle();
    assert.equal(runs.length, 1);
    await setProject(projectId);
    await settle();
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.options.strictThread, true);
    assert.equal(runs[1]!.options.threadId, threadId);
    await connect();
    await setProject(projectId);
    await interactions();
    assert.equal(runs.length, 2);
    runs[1]!.finish();
    await settle();
    assert.equal((await interactions()).find((entry) => entry.id === interaction.id)?.status, "completed");
});

test("interrupted, failed or unknown source completion never runs a queued continuation", async () => {
    for (const status of ["interrupted", "failed", "unknown"] as const) {
        const source = await startTurn();
        const interaction = await createInteraction(source, "canvas_request_generation_confirm", { confirmId: `confirm-${status}`, description: "不能在异常结束后生成", estimatedCost: 1 });
        const response = await post(`/agent/generation-confirm/confirm-${status}`, { ...scope(interaction), confirmed: true, decisionSource: "manual" });
        assert.equal(response.status, 202);
        await response.arrayBuffer();
        const before = runs.length;
        source.finish(status);
        await settle();
        assert.equal(runs.length, before);
        const latest = (await interactions()).find((entry) => entry.id === interaction.id)!;
        assert.ok(["expired", "continuation_failed"].includes(latest.status));
    }
});

test("project or owner changes expire the original source instead of retargeting continuation", async () => {
    for (const change of ["project", "owner"] as const) {
        const source = await startTurn();
        const interaction = await createInteraction(source, "canvas_create_proposal", { proposalId: `proposal-${change}`, summary: "原画布方案", actions: ["原画布动作"] });
        const response = await post(`/agent/proposal/proposal-${change}/decision`, { ...scope(interaction), approved: true });
        assert.equal(response.status, 202);
        await response.arrayBuffer();
        if (change === "project") await setProject(`${projectId}-changed`);
        else await connect("other-owner");
        const before = runs.length;
        source.finish();
        await settle();
        assert.equal(runs.length, before);
        const stale = await post(`/agent/proposal/proposal-${change}/decision`, { ...scope(interaction), approved: true });
        assert.equal(stale.status, 409);
        await stale.arrayBuffer();
        await connect();
        await setProject(projectId);
    }
});

test("rejection and generation cancellation continue only to explain, without write or generation permission", async () => {
    const cases = [
        { tool: "canvas_create_proposal", input: { proposalId: "proposal-refused", summary: "不要执行的方案", actions: ["删除所有内容"] }, path: "/agent/proposal/proposal-refused/decision", decision: { approved: false, reason: "保留原稿" }, word: "保留原稿" },
        { tool: "canvas_request_generation_confirm", input: { confirmId: "confirm-cancelled", description: "取消的生成", estimatedCost: 8 }, path: "/agent/generation-confirm/confirm-cancelled", decision: { confirmed: false, decisionSource: "manual" }, word: "取消" },
    ];
    for (const item of cases) {
        const source = await startTurn();
        const interaction = await createInteraction(source, item.tool, item.input);
        const response = await post(item.path, { ...scope(interaction), ...item.decision });
        assert.equal(response.status, 202);
        await response.arrayBuffer();
        source.finish();
        await settle();
        const continuation = runs.at(-1)!;
        assert.notEqual(continuation, source);
        assert.ok(continuation.prompt.includes(item.word));
        for (const [name, input] of [["canvas_create_text_node", { text: "must stay read only" }], ["workbench_image_generate", { prompt: "valid but refused generation", run: true }]] as const) {
            const blocked = await toolRequest(continuation, name, input);
            assert.equal(blocked.status, 409);
            assert.equal((await blocked.json() as { code: string }).code, "INTERACTION_READ_ONLY");
        }
        const state = await toolResult(continuation, "canvas_get_state", {}) as Record<string, unknown>;
        assert.equal(state.projectId, projectId);
        continuation.finish();
        await settle();
    }
});

test("decision schema validation is explicit and separate from Codex permission approval", async () => {
    const source = await startTurn();
    const interaction = await createInteraction(source, "canvas_request_generation_confirm", { confirmId: "confirm-schema", description: "合法预估", estimatedCost: 0 });
    for (const patch of [{ confirmed: "true" }, { confirmed: true, decisionSource: "synthetic-invalid" }]) {
        const response = await post("/agent/generation-confirm/confirm-schema", { ...scope(interaction), ...patch });
        assert.equal(response.status, 400);
        await response.arrayBuffer();
    }
    assert.equal((await interactions())[0]!.status, "pending");
    assert.equal(runs.length, 1);
    assert.equal(externalCalls.includes("resolveCodexApproval"), false);
});

test("continuation display text stays concise in live chat and merged history while engine context is intact", async () => {
    const { threadMessages } = await import("../agent/codex-history.js");
    const liveUsers: Array<{ turnId: string; text: string }> = [];
    const emitThread = session.emitThread.bind(session);
    const chat = spyOn(session, "emitThread").mockImplementation((type, eventThreadId, payload) => {
        if (type === "chat_message" && payload.message && typeof payload.message === "object") {
            const message = payload.message as Record<string, unknown>;
            if (message.role === "user") liveUsers.push({ turnId: String(message.turnId || ""), text: String(message.text || "") });
        }
        return emitThread(type, eventThreadId, payload);
    });
    const cases = [
        { tool: "canvas_create_proposal", input: { proposalId: "display-approved", summary: "保留原稿并新增图片", estimatedCost: 2, actions: ["新增图片节点", "连接原说明"] }, route: "/agent/proposal/display-approved/decision", decision: { approved: true }, words: ["同意方案", "保留原稿并新增图片"], readOnly: false },
        { tool: "canvas_create_proposal", input: { proposalId: "display-rejected", summary: "替换画布内容", actions: ["替换节点"] }, route: "/agent/proposal/display-rejected/decision", decision: { approved: false, reason: "请保留原稿" }, words: ["拒绝方案", "替换画布内容", "请保留原稿"], readOnly: true },
        { tool: "canvas_ask_user", input: { questionId: "display-answer", question: "需要哪一种风格？" }, route: "/agent/question/display-answer/answer", decision: { answer: "保留柔和的手绘风格" }, words: ["需要哪一种风格？", "保留柔和的手绘风格"], readOnly: false },
        { tool: "canvas_request_generation_confirm", input: { confirmId: "display-auto", description: "生成两张封面图片", estimatedCost: 3 }, route: "/agent/generation-confirm/display-auto", decision: { confirmed: true, decisionSource: "auto" }, words: ["确认生成", "生成两张封面图片", "免确认生成", "自动"], readOnly: false },
        { tool: "canvas_request_generation_confirm", input: { confirmId: "display-cancelled", description: "生成一段旁白", estimatedCost: 1 }, route: "/agent/generation-confirm/display-cancelled", decision: { confirmed: false }, words: ["取消生成", "生成一段旁白"], readOnly: true },
    ];
    try {
        for (const [index, item] of cases.entries()) {
            const ordinaryText = `普通Composer原文${index}，保留用户自己的表达`;
            const source = await startTurn({ prompt: `引擎收到的普通任务${index}`, messageText: ordinaryText });
            assert.equal(source.options.messageText, ordinaryText);
            assert.deepEqual(liveUsers.filter((message) => message.turnId === source.turnId).map((message) => message.text), [ordinaryText]);
            const interaction = await createInteraction(source, item.tool, item.input);
            const response = await post(item.route, { ...scope(interaction), ...item.decision });
            assert.equal(response.status, 202);
            const accepted = await response.json() as { interaction: Interaction };
            assert.ok(accepted.interaction.decision);
            source.finish();
            await settle();
            const continuation = runs.at(-1)!;
            assert.notEqual(continuation, source);
            assert.ok(continuation.prompt.includes(JSON.stringify(accepted.interaction.input)));
            assert.ok(continuation.prompt.includes(JSON.stringify(accepted.interaction.decision)));
            assert.ok(continuation.prompt.includes("actions不是可由HTTP执行的程序"));
            assert.ok(continuation.prompt.includes("estimatedCost仅为展示预估，不代表正式报价或钱包授权"));
            assert.ok(continuation.prompt.includes(item.readOnly ? "不得执行被拒绝/取消的动作" : "原Codex权限要求"));
            assert.equal(continuation.options.permissionMode, source.options.permissionMode);
            const display = continuation.options.messageText;
            assert.ok(typeof display === "string" && display.trim());
            assert.notEqual(display, continuation.prompt);
            assert.ok(display.length < continuation.prompt.length);
            for (const word of item.words) assert.ok(display.includes(word), display);
            for (const internal of [interaction.id, '"kind"', '"input"', '"decision"', '"actions"', "原交互引用", "estimatedCost", "钱包授权", "原Codex权限要求"]) assert.equal(display.includes(internal), false, internal);
            assert.deepEqual(liveUsers.filter((message) => message.turnId === continuation.turnId).map((message) => message.text), [display]);
            for (const [run, expectedText] of [[source, ordinaryText], [continuation, display]] as const) {
                const restored = threadMessages({ id: threadId, turns: [{ id: run.turnId, status: "completed", items: [{ id: `raw-user-${run.turnId}`, type: "userMessage", content: [{ type: "text", text: run.prompt }] }] }] }, [], {
                    items: [], turns: [{ threadId, turnId: run.turnId, turn: { id: run.turnId, status: "completed", input: run.prompt, messageText: run.options.messageText } }],
                });
                const users = restored.filter((message) => message.role === "user");
                assert.equal(users.length, 1);
                assert.equal(users[0]!.text, expectedText);
                assert.equal(users[0]!.text, liveUsers.find((message) => message.turnId === run.turnId)!.text);
            }
            continuation.finish();
            await settle();
        }
    } finally {
        chat.mockRestore();
    }
});

function auth(secret = token) { return { "x-canvas-agent-token": secret }; }
function queryScope() { return { clientId, ownerContext, threadId, conversationId: session.conversationStateSnapshot.conversationId, projectId }; }
function scope(interaction: Interaction) {
    return { clientId: interaction.sourceClientId, ownerContext: interaction.ownerContext, threadId: interaction.threadId,
        conversationId: interaction.conversationId, projectId: interaction.projectId, streamId: interaction.streamId,
        expectedInteractionRevision: interaction.revision };
}
async function post(route: string, body: unknown, secret = token) {
    return await fetch(`${base}${route}`, { method: "POST", headers: { ...auth(secret), "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function toolRequest(run: Run, name: string, input: object) {
    return await post("/api/tools", { name, input, source: { threadId: run.options.threadId, turnId: run.turnId } });
}
async function toolResult(run: Run, name: string, input: object) {
    const response = await toolRequest(run, name, input);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { ok: boolean; result: unknown };
    assert.equal(body.ok, true);
    return body.result;
}
async function postTurn(patch: Record<string, unknown> = {}) {
    const conversation = session.conversationStateSnapshot;
    return await post("/agent/codex/turn", {
        clientId, ownerContext, projectId, threadId, conversationId: conversation.conversationId, expectedRevision: conversation.revision,
        prompt: "Synthetic business source task", messageId: randomUUID(), attachments: [], permissionMode: "request",
        model: "synthetic-model", effort: "high", skill: { name: "synthetic-source-skill", path: path.join(directory, "SKILL.md") }, ...patch,
    });
}
async function startTurn(patch: Record<string, unknown> = {}) {
    const before = runs.length, response = await postTurn(patch);
    assert.equal(response.status, 200, await response.text());
    assert.equal(runs.length, before + 1);
    const run = runs.at(-1)!;
    assert.ok(run.runToken);
    return run;
}
async function createInteraction(run: Run, tool: string, input: object) {
    const result = await toolResult(run, tool, input) as { ok: boolean; interaction: Interaction };
    assert.equal(result.ok, true);
    assert.ok(result.interaction);
    assert.equal(result.interaction.sourceClientId, clientId);
    assert.equal(result.interaction.projectId, projectId);
    return result.interaction;
}
async function interactions() {
    const response = await fetch(`${base}/agent/interactions?${new URLSearchParams(queryScope())}`, { headers: auth() });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { ok: boolean; interactions: Interaction[] };
    assert.equal(body.ok, true);
    return body.interactions;
}
async function setProject(id: string) {
    const response = await post(`/canvas/state?clientId=${encodeURIComponent(clientId)}`, { projectId: id, projectName: id, nodes: [], edges: [], selectedNodeIds: [] });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
}
async function connect(owner = ownerContext, id = clientId): Promise<Connection> {
    const abort = new AbortController();
    const response = await fetch(`${base}/events?${new URLSearchParams({ clientId: id, ownerContext: owner })}`, { headers: auth(), signal: abort.signal });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let frame = "";
    while (!frame.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        frame += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(frame, /^event: hello\n/);
    const hello = JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<string, unknown>;
    const connection: Connection = { reader, abort, hello, async close() {
        connections.delete(connection);
        abort.abort();
        await reader.cancel().catch(() => undefined);
    } };
    connections.add(connection);
    return connection;
}
function captureEvents(id: string) {
    const response = (session as unknown as { clients: Map<string, ServerResponse> }).clients.get(id);
    assert.ok(response);
    const write = spyOn(response, "write");
    return {
        events(type: string) {
            return write.mock.calls.flatMap(([chunk]) => {
                const frame = String(chunk);
                return frame.startsWith(`event: ${type}\n`) ? [JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<string, unknown>] : [];
            });
        },
        restore() { write.mockRestore(); },
    };
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve)); }
