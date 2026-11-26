import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeEach, mock, spyOn, test } from "bun:test";

import type { CodexAppClient as CodexClientType } from "./codex-client.js";
import type { CodexRunOutcome } from "./codex-protocol.js";

// Run in a separate Bun process: no configuration, history files or CLI is used.
mock.module("../config.js", () => ({ VERSION: "synthetic", CONFIG_DIR: path.join(os.tmpdir(), "unused-codex-outcome"), AGENT_PROMPT: "synthetic" }));
mock.module("../utils/logger.js", () => ({ logger: { info() {}, debug() {}, warn() {}, error() {} } }));
mock.module("./codex-event-history.js", () => ({ codexEventHistory: { record: async () => {}, recordTurn: async () => {} } }));
mock.module("./message-metadata.js", () => ({ messageMetadataStore: {} }));

const { CodexAppClient, CodexReportedError, codexRunOutcome } = await import("./codex-client.js");
const { runCodexTurn } = await import("./codex.js");
const emit = () => {};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
let exitClient: (() => void) | undefined;
let resumeError: Error | undefined, turnError: Error | undefined;
let resumedId = "", terminalStatus = "completed";
let holdTurn: Promise<void> | undefined;
let turnCount = 0;
const calls: Array<{ method: string; args: unknown[] }> = [];
const fakeApp = {
    async resumeThread(...args: unknown[]) {
        calls.push({ method: "thread/resume", args });
        if (resumeError) throw resumeError;
        return { id: resumedId || args[0] };
    },
    async startThread(...args: unknown[]) {
        calls.push({ method: "thread/start", args });
        return { id: "unexpected-new-thread" };
    },
    async startTurn(...args: unknown[]) {
        calls.push({ method: "turn/start", args });
        const turnId = `synthetic-turn-${++turnCount}`;
        (args[6] as ((id: string) => void) | undefined)?.(turnId);
        if (turnError) throw turnError;
        await holdTurn;
        return { type: "turn.completed", status: terminalStatus, thread_id: args[0], turn_id: turnId };
    },
};
const start = spyOn(CodexAppClient, "start").mockImplementation(async (_emit, onExit) => {
    exitClient = onExit;
    return fakeApp as unknown as CodexClientType;
});
beforeEach(() => {
    exitClient?.();
    exitClient = undefined;
    calls.length = 0;
    resumeError = turnError = undefined;
    resumedId = "";
    terminalStatus = "completed";
    holdTurn = undefined;
    turnCount = 0;
});
afterAll(() => start.mockRestore());

test("strict continuation rejects a missing original thread without creating another thread", async () => {
    resumeError = new Error("no rollout found for original-thread");
    const finishes: CodexRunOutcome[] = [];
    const outcome = await runCodexTurn("continue", emit, [], { threadId: "original-thread", strictThread: true, onFinish: (value) => finishes.push(value) });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.threadId, "original-thread");
    assert.equal(outcome.turnId, "");
    assert.deepEqual(calls.map(({ method }) => method), ["thread/resume"]);
    assert.deepEqual(finishes, [outcome]);
});

test("strict continuation requires an original thread and rejects a different resumed id", async () => {
    const absent = await runCodexTurn("continue", emit, [], { strictThread: true });
    assert.equal(absent.status, "failed");
    assert.deepEqual(calls, []);
    resumedId = "different-thread";
    const mismatch = await runCodexTurn("continue", emit, [], { threadId: "original-thread", strictThread: true });
    assert.equal(mismatch.status, "failed");
    assert.match(mismatch.error || "", /原续接线程不一致/);
    assert.deepEqual(calls.map(({ method }) => method), ["thread/resume"]);
});

test("strict continuation does not repeat turn/start or create a thread after a recoverable turn error", async () => {
    turnError = new Error("thread not loaded");
    const outcome = await runCodexTurn("continue", emit, [], { threadId: "original-thread", strictThread: true });
    assert.equal(outcome.status, "unknown");
    assert.equal(outcome.threadId, "original-thread");
    assert.equal(outcome.turnId, "synthetic-turn-1");
    assert.deepEqual(calls.map(({ method }) => method), ["thread/resume", "turn/start"]);
});

for (const [status, expected] of [["completed", "completed"], ["interrupted", "interrupted"], ["failed", "failed"], ["inProgress", "unknown"]] as const) {
    test(`run completion reports explicit ${expected} outcome for ${status}`, async () => {
        terminalStatus = status;
        const finishes: CodexRunOutcome[] = [];
        const outcome = await runCodexTurn("continue", emit, [], { threadId: "original-thread", strictThread: true, permissionMode: "request", model: "original-model", effort: "high", onFinish: (value) => finishes.push(value) });
        assert.deepEqual(outcome, { status: expected, threadId: "original-thread", turnId: "synthetic-turn-1" });
        assert.deepEqual(finishes, [outcome]);
        assert.deepEqual(calls.find(({ method }) => method === "turn/start")?.args.slice(0, 6), ["original-thread", "continue", [], "request", "original-model", "high"]);
    });
}

test("reported engine failure preserves its terminal outcome instead of treating finally as completion", async () => {
    const terminal: CodexRunOutcome = { status: "failed", threadId: "original-thread", turnId: "synthetic-turn-1", error: "engine rejected turn" };
    turnError = new CodexReportedError(terminal.error!, terminal);
    const finishes: CodexRunOutcome[] = [];
    const outcome = await runCodexTurn("continue", emit, [], { threadId: "original-thread", strictThread: true, onFinish: (value) => finishes.push(value) });
    assert.deepEqual(outcome, terminal);
    assert.deepEqual(finishes, [terminal]);
});

test("an ordinary run cannot replay its prompt after an already started turn reports a recoverable-looking failure", async () => {
    const terminal: CodexRunOutcome = { status: "failed", threadId: "original-thread", turnId: "synthetic-turn-1", error: "thread not loaded after business request" };
    turnError = new CodexReportedError(terminal.error!, terminal);
    const outcome = await runCodexTurn("original prompt", emit, [], { threadId: "original-thread" });
    assert.deepEqual(outcome, terminal);
    assert.deepEqual(calls.map(({ method }) => method), ["thread/resume", "turn/start"]);
});

test("new run starts only after the previous run and finish callback complete", async () => {
    let release!: () => void;
    holdTurn = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = runCodexTurn("first", emit, [], { threadId: "original-thread", strictThread: true, onStart: () => order.push("first:start"), onFinish: () => order.push("first:finish") });
    const second = runCodexTurn("second", emit, [], { threadId: "original-thread", strictThread: true, onStart: () => order.push("second:start"), onFinish: () => order.push("second:finish") });
    await tick();
    assert.deepEqual(order, ["first:start"]);
    assert.equal(calls.filter(({ method }) => method === "turn/start").length, 1);
    holdTurn = undefined;
    release();
    const outcomes = await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:finish", "second:start", "second:finish"]);
    assert.deepEqual(outcomes.map(({ status, turnId }) => ({ status, turnId })), [{ status: "completed", turnId: "synthetic-turn-1" }, { status: "completed", turnId: "synthetic-turn-2" }]);
});

type ProtocolClient = { handle(message: Record<string, unknown>): void; handleNotification(method: string, params: Record<string, unknown>): void; failAll(message: string): void };
function protocolFixture() {
    const writes: Array<Record<string, unknown>> = [];
    const child = { stdin: { write: (line: string) => (writes.push(JSON.parse(line)), true) } };
    const client = Reflect.construct(CodexAppClient, [child, emit, { record: async () => {}, recordTurn: async () => {} }]) as CodexClientType;
    return { client, protocol: client as unknown as ProtocolClient, writes };
}

for (const early of [false, true]) {
    for (const status of ["completed", "interrupted", "failed", undefined] as const) {
        test(`protocol preserves ${status || "missing"} terminal status when completion is ${early ? "before" : "after"} start response`, async () => {
            const { client, protocol, writes } = protocolFixture();
            const running = client.startTurn("original-thread", "continue", [], "request");
            const observed = running.then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
            const respond = () => protocol.handle({ id: writes[0]!.id, result: { turn: { id: "turn-1" } } });
            if (!early) { respond(); await tick(); }
            protocol.handleNotification("turn/started", { threadId: "original-thread", turn: { id: "turn-1" } });
            protocol.handleNotification("turn/completed", { threadId: "original-thread", turn: { id: "turn-1", ...(status ? { status } : {}) } });
            await tick();
            if (early) respond();
            const { result, error } = await observed;
            const expected: CodexRunOutcome = { status: status || "unknown", threadId: "original-thread", turnId: "turn-1" };
            if (status === "failed") {
                assert.ok(error instanceof CodexReportedError);
                assert.deepEqual(error.outcome, expected);
            } else {
                assert.equal(error, undefined);
                assert.deepEqual(codexRunOutcome(result, "original-thread", "turn-1"), expected);
            }
            assert.equal(writes.filter(({ method }) => method === "turn/start").length, 1);
        });
    }
}

test("protocol process loss after dispatch is unknown and cannot authorize continuation", async () => {
    const { client, protocol, writes } = protocolFixture();
    const running = client.startTurn("original-thread", "continue", [], "request");
    const observed = running.catch((error: unknown) => error);
    protocol.handle({ id: writes[0]!.id, result: { turn: { id: "turn-1" } } });
    await tick();
    protocol.failAll("synthetic process lost");
    const error = await observed;
    assert.ok(error instanceof CodexReportedError);
    assert.deepEqual(error.outcome, { status: "unknown", threadId: "original-thread", turnId: "turn-1", error: "synthetic process lost" });
});

test("protocol terminal error without a message cannot count as completed", async () => {
    const { client, protocol, writes } = protocolFixture();
    const running = client.startTurn("original-thread", "continue", [], "request");
    const observed = running.catch((error: unknown) => error);
    protocol.handle({ id: writes[0]!.id, result: { turn: { id: "turn-1" } } });
    await tick();
    protocol.handleNotification("turn/completed", { threadId: "original-thread", turn: { id: "turn-1", status: "completed", error: {} } });
    const error = await observed;
    assert.ok(error instanceof CodexReportedError);
    assert.deepEqual(error.outcome, { status: "failed", threadId: "original-thread", turnId: "turn-1", error: "Codex turn failed" });
});
