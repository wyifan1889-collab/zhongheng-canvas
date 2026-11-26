import { expect, test } from "bun:test";
import { createAgentSseResumeConsumer } from "./agent-sse-resume";

const hello = (streamId = "synthetic-stream", resumeThreadId = "synthetic-thread", resumeAfter = -1) => ({ streamId, resumeThreadId, resumeAfter });

test("a fresh or invalid native cursor reports minus one without rejecting the new stream", () => {
    const consumer = createAgentSseResumeConsumer();
    expect(consumer.beginReplay(hello())).toBe(true);
    expect(consumer.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(true);
    expect(consumer.completeReplay({ lastSeq: 1 })).toBe(true);
    consumer.beginReplay(hello());
    expect(consumer.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(false);
});

test("hello and ping never advance consumption, including a server-reported resume position", () => {
    const consumer = createAgentSseResumeConsumer();
    expect(consumer.beginReplay(hello(undefined, undefined, 100))).toBe(true);
    expect(consumer.acceptEvent("hello", { seq: 200 })).toBe(false);
    expect(consumer.acceptEvent("ping", { seq: 200 })).toBe(false);
    expect(consumer.acceptEvent("replay_complete", { seq: 200 })).toBe(false);
    expect(consumer.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(true);
    expect(consumer.completeReplay({ lastSeq: 1 })).toBe(true);
    expect(consumer.acceptEvent("agent_event", { seq: 2 })).toBe(true);
});

test("a replay keeps Map item order without treating a higher sequence as a per-frame watermark", () => {
    const consumer = createAgentSseResumeConsumer();
    consumer.beginReplay(hello());
    expect(consumer.acceptEvent("agent_event", { seq: 9, replayed: true })).toBe(true);
    expect(consumer.acceptEvent("chat_message", { seq: 3, replayed: true })).toBe(true);
    expect(consumer.acceptEvent("agent_error", { seq: 7, replayed: true })).toBe(true);
    expect(consumer.acceptEvent("chat_message", { seq: 3, replayed: true })).toBe(false);
    expect(consumer.completeReplay({ lastSeq: 9 })).toBe(true);
    for (const seq of [3, 7, 9]) expect(consumer.acceptEvent("agent_event", { seq, replayed: true })).toBe(false);
});

test("same-scope reconnect retains both its committed cursor and a partly received replay", () => {
    const consumer = createAgentSseResumeConsumer();
    consumer.beginReplay(hello());
    consumer.completeReplay({ lastSeq: 4 });
    expect(consumer.acceptEvent("agent_event", { seq: 5 })).toBe(true);
    consumer.beginReplay(hello(undefined, undefined, 5));
    expect(consumer.acceptEvent("agent_event", { seq: 8, replayed: true })).toBe(true);
    consumer.beginReplay(hello(undefined, undefined, 5));
    expect(consumer.acceptEvent("agent_event", { seq: 5, replayed: true })).toBe(false);
    expect(consumer.acceptEvent("agent_event", { seq: 8, replayed: true })).toBe(false);
    expect(consumer.acceptEvent("agent_event", { seq: 6, replayed: true })).toBe(true);
    expect(consumer.completeReplay({ lastSeq: 8 })).toBe(true);
    expect(consumer.acceptEvent("agent_event", { seq: 9 })).toBe(true);
});

test("equal live deltas with different sequences are consumed, while an identical sequence is consumed once", () => {
    const consumer = createAgentSseResumeConsumer();
    consumer.beginReplay(hello());
    consumer.completeReplay({ lastSeq: 0 });
    let text = "";
    for (const seq of [1, 1, 2]) if (consumer.acceptEvent("agent_event", { seq, item: { delta: "ha" } })) text += "ha";
    expect(text).toBe("haha");
});

test("all business event kinds share the same once-only consumption boundary", () => {
    const consumer = createAgentSseResumeConsumer();
    consumer.beginReplay(hello());
    consumer.completeReplay({ lastSeq: 0 });
    const kinds = ["codex_state", "tool_call", "codex_approval", "codex_approval_resolved", "agent_event", "agent_bootstrap",
        "conversation_changed", "workspace_changed", "chat_message", "agent_log", "skills_changed", "agent_error"];
    for (const [index, kind] of kinds.entries()) {
        expect(consumer.acceptEvent(kind, { seq: index + 1 })).toBe(true);
        expect(consumer.acceptEvent(kind, { seq: index + 1 })).toBe(false);
    }
});

test("service and thread scope changes reset cursor and partial replay identities", () => {
    const consumer = createAgentSseResumeConsumer();
    for (const scope of [hello(), hello("other-synthetic-stream"), hello("other-synthetic-stream", "other-synthetic-thread"), hello("other-synthetic-stream", "")]) {
        expect(consumer.beginReplay(scope)).toBe(true);
        expect(consumer.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(true);
        expect(consumer.completeReplay({ lastSeq: 1 })).toBe(true);
        expect(consumer.acceptEvent("agent_event", { seq: 2 })).toBe(true);
    }
});

test("a new effect or refreshed page starts without a transport cursor", () => {
    const original = createAgentSseResumeConsumer();
    original.beginReplay(hello());
    original.completeReplay({ lastSeq: 20 });
    expect(original.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(false);
    const replacement = createAgentSseResumeConsumer();
    replacement.beginReplay(hello());
    expect(replacement.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(true);
});

test("malformed payloads and incomplete replay markers cannot discard accepted replay entries", () => {
    const consumer = createAgentSseResumeConsumer();
    expect(consumer.acceptEvent("agent_event", { seq: 1 })).toBe(false);
    for (const value of [null, {}, { ...hello(), streamId: "" }, { ...hello(), resumeThreadId: null }, { ...hello(), resumeAfter: -2 }]) {
        expect(consumer.beginReplay(value)).toBe(false);
    }
    consumer.beginReplay(hello());
    for (const seq of [undefined, null, "1", 0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(consumer.acceptEvent("agent_event", { seq })).toBe(false);
    }
    expect(consumer.acceptEvent("agent_event", { seq: 5, replayed: true })).toBe(true);
    for (const value of [null, {}, { lastSeq: 4 }, { lastSeq: "5" }, { lastSeq: -1 }, { lastSeq: Infinity }]) {
        expect(consumer.completeReplay(value)).toBe(false);
    }
    expect(consumer.acceptEvent("agent_event", { seq: 5, replayed: true })).toBe(false);
    expect(consumer.acceptEvent("agent_event", { seq: 3, replayed: true })).toBe(true);
    expect(consumer.completeReplay({ lastSeq: 5 })).toBe(true);
    expect(consumer.completeReplay({ lastSeq: 6 })).toBe(false);
});

test("an event accepted into the surviving queue is not enqueued again during automatic reconnect", async () => {
    const consumer = createAgentSseResumeConsumer();
    consumer.beginReplay(hello());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let queue = held, consumed = 0;
    const receive = () => {
        if (consumer.acceptEvent("agent_event", { seq: 1, replayed: true })) {
            const revision = consumer.scopeRevision();
            queue = queue.then(() => { if (consumer.scopeRevision() === revision) consumed++; });
        }
    };
    receive();
    consumer.beginReplay(hello());
    receive();
    expect(consumer.completeReplay({ lastSeq: 1 })).toBe(true);
    expect(consumed).toBe(0);
    release();
    await queue;
    expect(consumed).toBe(1);
});

test("a restarted service invalidates an old accepted event still waiting in the queue", async () => {
    const consumer = createAgentSseResumeConsumer();
    consumer.beginReplay(hello());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let consumed = 0;
    expect(consumer.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(true);
    const revision = consumer.scopeRevision();
    const queue = held.then(() => { if (consumer.scopeRevision() === revision) consumed++; });
    consumer.beginReplay(hello("restarted-synthetic-stream"));
    expect(consumer.scopeRevision()).not.toBe(revision);
    release();
    await queue;
    expect(consumed).toBe(0);
    expect(consumer.acceptEvent("agent_event", { seq: 1, replayed: true })).toBe(true);
});

test("a same-instance thread reconnect preserves its already accepted live event queue", async () => {
    const consumer = createAgentSseResumeConsumer();
    consumer.beginReplay(hello("synthetic-stream", "thread-a"));
    consumer.completeReplay({ lastSeq: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let consumed = 0;
    // The native live-frame ID already belongs to B although the latest hello was A.
    expect(consumer.acceptEvent("agent_event", { seq: 2, threadId: "thread-b" })).toBe(true);
    const revision = consumer.scopeRevision();
    const queue = held.then(() => { if (consumer.scopeRevision() === revision) consumed++; });
    expect(consumer.beginReplay(hello("synthetic-stream", "thread-b", 2))).toBe(true);
    expect(consumer.scopeRevision()).toBe(revision);
    expect(consumer.completeReplay({ lastSeq: 2 })).toBe(true);
    release();
    await queue;
    expect(consumed).toBe(1);
    expect(consumer.acceptEvent("agent_event", { seq: 2, threadId: "thread-b" })).toBe(false);
});

test("transport cursor commits a matching scope-bound ID atomically and ignores invalid live or replay IDs", () => {
    const client = "client:/中文", thread = "thread:/中文", consumer = createAgentSseResumeConsumer(client);
    const id = (seq: number) => `v1:synthetic-stream:${encodeURIComponent(client)}:${encodeURIComponent(thread)}:${seq}`;
    consumer.beginReplay(hello("synthetic-stream", thread));
    expect(consumer.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
    consumer.acceptEvent("agent_event", { seq: 3, replayed: true }, id(3));
    expect(consumer.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
    expect(consumer.completeReplay({ lastSeq: 3 }, id(3))).toBe(true);
    expect(consumer.cursor()).toEqual({ lastSeq: 3, resumeId: id(3) });
    expect(consumer.acceptEvent("agent_event", { seq: 4 }, "v1:other-stream:client:thread:4")).toBe(true);
    expect(consumer.cursor()).toEqual({ lastSeq: 3, resumeId: id(3) });
    expect(consumer.acceptEvent("agent_event", { seq: 5 }, id(6))).toBe(true);
    expect(consumer.cursor()).toEqual({ lastSeq: 3, resumeId: id(3) });
    expect(consumer.acceptEvent("agent_event", { seq: 6 }, id(6))).toBe(true);
    expect(consumer.cursor()).toEqual({ lastSeq: 6, resumeId: id(6) });
    consumer.beginReplay(hello("synthetic-stream", thread, 6));
    expect(consumer.completeReplay({ lastSeq: 7 }, "")).toBe(true);
    expect(consumer.cursor()).toEqual({ lastSeq: 6, resumeId: id(6) });
    consumer.beginReplay(hello("synthetic-stream", "new-thread"));
    expect(consumer.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
    consumer.completeReplay({ lastSeq: 0 }, "v1:synthetic-stream:client:old-thread:0");
    expect(consumer.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
    consumer.beginReplay(hello("new-stream", "new-thread"));
    expect(consumer.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
    const replacement = createAgentSseResumeConsumer("new-client");
    expect(replacement.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
});
