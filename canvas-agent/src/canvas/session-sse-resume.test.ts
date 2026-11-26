import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, get, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import test, { type TestContext } from "node:test";

import { CanvasSession } from "./session.js";

type Frame = { type: string; id?: string; data: Record<string, unknown>; raw: string };
type ResumeQuery = { after?: string | string[]; resumeId?: string | string[] };
const thread = "thread:/对话";
const client = "client:/网页";

function parseFrame(raw: string): Frame {
    assert.match(raw, /^event: /, "the existing event-first wire format is retained");
    const lines = raw.split("\n");
    const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    assert.ok(type && data);
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    return { type, data: JSON.parse(data) as Record<string, unknown>, ...(id === undefined ? {} : { id }), raw };
}

class Capture extends EventEmitter {
    frames: Frame[] = [];
    private closed = false;
    writeHead() { return this; }
    write(raw: string) { this.frames.push(parseFrame(raw.trimEnd())); return true; }
    close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
}

function addResumeQuery(url: URL, query: ResumeQuery) {
    for (const name of ["after", "resumeId"] as const) {
        const value = query[name];
        if (value !== undefined) for (const part of Array.isArray(value) ? value : [value]) url.searchParams.append(name, part);
    }
    return url;
}

function capture(t: TestContext, session: CanvasSession, options: ResumeQuery & { client?: string; thread?: string; header?: string; role?: string } = {}) {
    const response = new Capture();
    const url = addResumeQuery(new URL("http://127.0.0.1/events"), options);
    url.searchParams.set("clientId", options.client ?? client);
    if (options.role) url.searchParams.set("role", options.role);
    session.openEvents(url, response as unknown as ServerResponse, options.thread ?? thread, options.header);
    t.after(() => response.close());
    return response;
}

function frame(frames: Frame[], type: string): Frame {
    const value = frames.find((entry) => entry.type === type);
    assert.ok(value, `missing ${type}`);
    return value;
}
function replay(frames: Frame[]) { return frames.filter((entry) => entry.type === "agent_event"); }
function item(event: Frame) { return event.data.item as Record<string, unknown>; }
function sequence(event: Frame): number { assert.equal(typeof event.data.seq, "number"); return event.data.seq as number; }
function cursor(event: Frame, value: string): string { assert.ok(event.id); return event.id.replace(/[^:]*$/, value); }
function running() {
    const session = new CanvasSession(thread);
    session.setCodexState({ busy: true, threadId: thread, turnId: "turn-1" });
    return session;
}
function emitItem(session: CanvasSession, id: string, type = "item.started", value: Record<string, unknown> = {}) {
    session.emitThread("agent_event", thread, { turnId: "turn-1", type, item: { id, type: "agent_message", ...value } });
}

test("one logical broadcast or unicast owns one sequence; client IDs only scope the SSE cursor", async (t) => {
    const session = running();
    const first = capture(t, session), second = capture(t, session, { client: "second:/网页" });
    const start = frame(first.frames, "replay_complete").data.lastSeq as number;
    session.emitAll("agent_status", { message: "connected" });
    emitItem(session, "A");
    for (const type of ["agent_status", "agent_event"]) {
        const a = frame(first.frames, type), b = frame(second.frames, type);
        assert.deepEqual(a.data, b.data);
        assert.equal(sequence(a), start + (type === "agent_status" ? 1 : 2));
        assert.equal(a.id, `v1:${frame(first.frames, "hello").data.streamId}:${encodeURIComponent(client)}:${encodeURIComponent(thread)}:${sequence(a)}`);
        assert.notEqual(a.id, b.id);
    }
    session.activateClient("second:/网页");
    const result = session.callTool("canvas_create_text_node", { text: "Synthetic local tool" });
    const call = frame(second.frames, "tool_call");
    assert.equal(first.frames.some((entry) => entry.type === "tool_call"), false);
    assert.equal(sequence(call), start + 3);
    assert.equal(session.resolveResult("second:/网页", { requestId: String(call.data.requestId), result: { ok: true } }), true);
    assert.deepEqual(await result, { ok: true });
    session.emitAll("agent_status", { message: "done" });
    assert.equal(sequence(first.frames.filter((entry) => entry.type === "agent_status").at(-1)!), start + 4);
});

test("A/B/A replay preserves item-start order and original sequences with a scoped legacy header", (t) => {
    const session = running(), live = capture(t, session);
    const initial = frame(live.frames, "replay_complete");
    emitItem(session, "A", "item.started", { text: "first" });
    emitItem(session, "B", "item.started", { text: "second" });
    emitItem(session, "A", "item.updated", { delta: " continued" });
    const [aStart, bStart, aUpdate] = replay(live.frames);
    live.close();
    const resumed = capture(t, session, { header: initial.id });
    const snapshots = replay(resumed.frames);
    assert.deepEqual(snapshots.map((entry) => item(entry).id), ["A", "B"]);
    assert.deepEqual(snapshots.map(sequence), [sequence(aUpdate!), sequence(bStart!)]);
    assert.equal(item(snapshots[0]!).text, "first continued");
    assert.equal(snapshots.every((entry) => entry.id === undefined && entry.data.replayed === true), true);
    assert.equal(frame(resumed.frames, "replay_complete").data.lastSeq, sequence(aUpdate!));
    assert.equal(cursor(frame(resumed.frames, "replay_complete"), String(sequence(aStart!))), aStart!.id);
    const filtered = capture(t, session, { header: bStart!.id });
    assert.equal(frame(filtered.frames, "hello").data.resumeAfter, sequence(bStart!));
    assert.deepEqual(replay(filtered.frames).map((entry) => item(entry).id), ["A"]);
    assert.equal(sequence(replay(filtered.frames)[0]!), sequence(aUpdate!));
    const caughtUp = capture(t, session, { header: frame(resumed.frames, "replay_complete").id });
    assert.deepEqual(replay(caughtUp.frames), []);
});

test("legacy header-only invalid cursors fall back to fresh replay and zero remains valid", (t) => {
    const session = running(), live = capture(t, session);
    emitItem(session, "A");
    const accepted = frame(live.frames, "agent_event");
    const invalid = ["", "2", "v2:wrong:client:thread:1", ...["-1", "01", "1.0", "1e0", " 1", "1 ", "", "9007199254740992", String(sequence(accepted) + 1)].map((value) => cursor(accepted, value)),
        accepted.id!.replace(String(frame(live.frames, "hello").data.streamId), "old-epoch"), accepted.id!.replace("%2F", "%2f")];
    for (const header of invalid) {
        const response = capture(t, session, { header });
        assert.equal(frame(response.frames, "hello").data.resumeAfter, -1, header);
        assert.deepEqual(replay(response.frames).map((entry) => item(entry).id), ["A"], header);
        response.close();
    }
    const zero = capture(t, session, { header: cursor(accepted, "0") });
    assert.equal(frame(zero.frames, "hello").data.resumeAfter, 0);
    assert.equal(replay(zero.frames).length, 1);
});

test("a matching query pair skips through its watermark including zero and a caught-up head", (t) => {
    const session = running(), live = capture(t, session);
    emitItem(session, "A", "item.started", { text: "first" });
    emitItem(session, "B", "item.started", { text: "second" });
    emitItem(session, "A", "item.updated", { delta: " continued" });
    const [aStart, bStart, aUpdate] = replay(live.frames);
    const head = sequence(aUpdate!);
    const cases = [
        { after: "0", resumeId: cursor(aStart!, "0"), expected: ["A", "B"] },
        { after: String(sequence(bStart!)), resumeId: bStart!.id!, expected: ["A"] },
        { after: String(head), resumeId: aUpdate!.id!, expected: [] },
    ];
    for (const { after, resumeId, expected } of cases) {
        // A conflicting native header must not override explicit query intent.
        const response = capture(t, session, { after, resumeId, header: aUpdate!.id });
        assert.equal(frame(response.frames, "hello").data.resumeAfter, Number(after));
        assert.deepEqual(replay(response.frames).map((entry) => item(entry).id), expected);
        assert.equal(replay(response.frames).every((entry) => sequence(entry) > Number(after) && entry.id === undefined && entry.data.replayed === true), true);
        if (expected.includes("A")) {
            assert.equal(sequence(replay(response.frames)[0]!), head);
            assert.equal(item(replay(response.frames)[0]!).text, "first continued");
        }
        const complete = frame(response.frames, "replay_complete");
        assert.equal(complete.data.lastSeq, head);
        assert.equal(complete.id, aUpdate!.id);
        response.close();
    }
    assert.equal(frame(capture(t, session).frames, "replay_complete").data.lastSeq, head);
});

test("incomplete, duplicate, malformed and out-of-scope query pairs fail closed even with a valid header", (t) => {
    const session = running(), live = capture(t, session);
    emitItem(session, "A");
    emitItem(session, "B");
    emitItem(session, "A", "item.updated", { delta: " continued" });
    const [aStart, bStart, accepted] = replay(live.frames);
    const after = String(sequence(accepted!)), resumeId = accepted!.id!;
    const cases: Array<{ name: string; query: ResumeQuery }> = [
        { name: "after only", query: { after } },
        { name: "resumeId only", query: { resumeId } },
        { name: "duplicate after", query: { after: [after, after], resumeId } },
        { name: "duplicate resumeId", query: { after, resumeId: [resumeId, resumeId] } },
        { name: "duplicate pairs", query: { after: [after, "0"], resumeId: [resumeId, cursor(accepted!, "0")] } },
        { name: "mismatched sequence", query: { after: String(sequence(bStart!)), resumeId } },
        { name: "ahead of head", query: { after: String(sequence(accepted!) + 1), resumeId: cursor(accepted!, String(sequence(accepted!) + 1)) } },
        ...[`+${after}`, `0${after}`, `${after}.0`, `${after}e0`, ` ${after}`, `${after} `, `\t${after}`, "-1", "1.5", "garbage", "NaN", "Infinity", "9007199254740992", String(Number.MAX_SAFE_INTEGER)].map((value) => ({ name: `after ${JSON.stringify(value)}`, query: { after: value, resumeId } })),
        ...["", "-0", "+0", "00"].map((value) => ({ name: `zero after ${JSON.stringify(value)}`, query: { after: value, resumeId: cursor(accepted!, "0") } })),
        ...["", "garbage", "v2:wrong:client:thread:1", cursor(accepted!, "01"),
            resumeId.replace(String(frame(live.frames, "hello").data.streamId), "old-epoch"),
            resumeId.replace(encodeURIComponent(client), encodeURIComponent("different-client")),
            resumeId.replace(encodeURIComponent(thread), encodeURIComponent("different-thread")),
            resumeId.replace("%2F", "%2f"), aStart!.id!,
        ].map((value) => ({ name: `resumeId ${value}`, query: { after, resumeId: value } })),
    ];
    for (const { name, query } of cases) {
        const response = capture(t, session, { ...query, header: resumeId });
        assert.equal(frame(response.frames, "hello").data.resumeAfter, -1, name);
        assert.deepEqual(replay(response.frames).map((entry) => item(entry).id), ["A", "B"], name);
        assert.deepEqual(replay(response.frames).map(sequence), [sequence(accepted!), sequence(bStart!)], name);
        assert.equal(replay(response.frames).every((entry) => entry.id === undefined && entry.data.replayed === true), true, name);
        assert.equal(frame(response.frames, "replay_complete").data.lastSeq, sequence(accepted!), name);
        response.close();
    }
    const restarted = running();
    emitItem(restarted, "new-A");
    emitItem(restarted, "new-B");
    emitItem(restarted, "new-A", "item.updated", { delta: " continued" });
    const newLive = capture(t, restarted), newHead = frame(newLive.frames, "replay_complete");
    const oldStream = capture(t, restarted, { after, resumeId, header: newHead.id });
    assert.equal(frame(oldStream.frames, "hello").data.resumeAfter, -1);
    assert.deepEqual(replay(oldStream.frames).map((entry) => item(entry).id), ["new-A", "new-B"]);
});

test("cursors bind client, active thread and session epoch; refresh leaves durable history authoritative", (t) => {
    const session = running(), live = capture(t, session);
    emitItem(session, "A");
    const old = frame(live.frames, "agent_event");
    const otherClient = capture(t, session, { client: "other", header: old.id });
    assert.equal(frame(otherClient.frames, "hello").data.resumeAfter, -1);
    assert.equal(replay(otherClient.frames).length, 1);
    const otherThread = capture(t, session, { thread: "different-thread", header: old.id });
    assert.equal(frame(otherThread.frames, "hello").data.resumeAfter, -1);
    assert.deepEqual(replay(otherThread.frames), []);
    session.emitThread("agent_event", "different-thread", { turnId: "turn-1", type: "item.started", item: { id: "foreign-thread" } });
    session.emitThread("agent_event", thread, { turnId: "other-turn", type: "item.started", item: { id: "foreign-turn" } });
    assert.deepEqual(replay(capture(t, session).frames).map((entry) => item(entry).id), ["A"]);
    const restarted = running();
    emitItem(restarted, "new-session");
    const newEpoch = capture(t, restarted, { header: old.id });
    assert.equal(frame(newEpoch.frames, "replay_complete").data.lastSeq, sequence(old));
    assert.equal(frame(newEpoch.frames, "hello").data.resumeAfter, -1);
    assert.deepEqual(replay(newEpoch.frames).map((entry) => item(entry).id), ["new-session"]);
    session.acknowledgeCodexHistory(thread, ["turn-1"]);
    assert.deepEqual(replay(capture(t, session).frames), []);
    // A fresh process can identify the durable thread but cannot manufacture
    // its historical messages from the bounded in-memory transport replay.
    const refreshed = capture(t, new CanvasSession(thread), { header: old.id });
    const hello = frame(refreshed.frames, "hello").data;
    assert.equal(hello.resumeAfter, -1);
    assert.equal((hello.workspace as Record<string, unknown>).activeThreadId, thread);
    assert.equal((hello.conversation as Record<string, unknown>).threadId, thread);
    assert.deepEqual(replay(refreshed.frames), []);
    assert.notEqual(hello.streamId, frame(live.frames, "hello").data.streamId);
});

test("hello, status-only connections and ping do not allocate transport sequences or IDs", (t) => {
    const ticks: Array<() => void> = [];
    t.mock.method(globalThis, "setInterval", (callback: () => void) => { ticks.push(callback); return {} as ReturnType<typeof setInterval>; });
    t.mock.method(globalThis, "clearInterval", () => {});
    const session = running();
    emitItem(session, "A");
    const live = capture(t, session);
    const initial = frame(live.frames, "replay_complete");
    const status = capture(t, session, { role: "status", header: initial.id, after: "0", resumeId: cursor(initial, "0") });
    ticks.forEach((tick) => tick());
    for (const event of [...live.frames, ...status.frames].filter((entry) => ["hello", "ping"].includes(entry.type))) {
        assert.equal(event.id, undefined);
        assert.equal(Object.hasOwn(event.data, "seq"), false);
    }
    assert.deepEqual(status.frames.map((entry) => entry.type), ["hello", "ping"]);
    assert.equal(frame(status.frames, "hello").data.resumeAfter, -1);
    assert.equal(session.health().clients, 1);
    const next = capture(t, session, { client: "next" });
    assert.equal(frame(next.frames, "replay_complete").data.lastSeq, initial.data.lastSeq);
    session.emitAll("agent_status", { message: "first numbered event" });
    assert.equal(sequence(frame(live.frames, "agent_status")), Number(initial.data.lastSeq) + 1);
});

test("closing a replaced connection preserves the current client, canvas state and pending tool", async (t) => {
    const session = running(), old = capture(t, session);
    session.updateState({ projectId: "old-project", nodes: [], connections: [] }, client);
    const checkpoint = frame(old.frames, "replay_complete");
    const current = capture(t, session, { after: String(checkpoint.data.lastSeq), resumeId: checkpoint.id });
    const state = { projectId: "current-project", nodes: [{ id: "current-node", type: "text", text: "current canvas", position: { x: 0, y: 0 }, width: 200, height: 100 }], connections: [] };
    session.updateState(state, client);
    session.activateClient(client);
    const result = session.callTool("canvas_create_text_node", { text: "Synthetic replacement tool" });
    const outcome = result.then((value) => ({ value }), (error: unknown) => ({ error }));
    const request = frame(current.frames, "tool_call");
    const oldCount = old.frames.length;
    old.close();
    assert.equal(session.hasClient(client), true);
    assert.equal(session.health().clients, 1);
    assert.equal(session.health().hasCanvas, true);
    assert.deepEqual(session.canvasStateForClient(client), { ...state, clientId: client });
    emitItem(session, "still-current");
    assert.equal(old.frames.length, oldCount);
    assert.equal(item(frame(current.frames, "agent_event")).id, "still-current");
    assert.equal(session.resolveResult(client, { requestId: String(request.data.requestId), result: { ok: true } }), true);
    assert.deepEqual(await outcome, { value: { ok: true } });
    current.close();
    assert.equal(session.hasClient(client), false);
    assert.equal(session.canvasStateForClient(client), null);
});

test("a real HTTP query reconnect after a partial out-of-order replay keeps the committed batch watermark", { timeout: 10_000 }, async () => {
    const session = running(), http = await serve(session);
    try {
        const initial = await http.connect();
        const checkpoint = await initial.until((entry) => entry.type === "replay_complete");
        initial.close(); await initial.closed;
        emitItem(session, "A", "item.started", { text: "first" });
        emitItem(session, "B", "item.started", { text: "second" });
        emitItem(session, "A", "item.updated", { delta: " continued" });
        const query = { after: String(checkpoint.data.lastSeq), resumeId: checkpoint.id! };
        const partial = await http.connect(undefined, true, query);
        const first = await partial.until((entry) => entry.type === "agent_event");
        await partial.closed;
        assert.equal(frame(partial.frames, "hello").data.resumeAfter, Number(query.after));
        assert.equal(item(first).id, "A");
        assert.equal(first.id, undefined);
        assert.equal(partial.frames.some((entry) => entry.type === "replay_complete"), false);
        // The high sequence on A has no SSE ID and cannot replace the committed
        // query pair until the complete replay batch has arrived.
        const resumed = await http.connect(undefined, false, query);
        const complete = await resumed.until((entry) => entry.type === "replay_complete");
        const restored = replay(resumed.frames);
        assert.deepEqual(restored.map((entry) => item(entry).id), ["A", "B"]);
        assert.ok(sequence(restored[0]!) > sequence(restored[1]!));
        assert.equal(item(restored[0]!).text, "first continued");
        assert.equal(restored.every((entry) => entry.id === undefined && entry.data.replayed === true), true);
        assert.equal(complete.data.lastSeq, sequence(first));
        assert.equal(complete.id, cursor(checkpoint, String(sequence(first))));
        resumed.close(); await resumed.closed;
        const caughtUp = await http.connect(undefined, false, { after: String(complete.data.lastSeq), resumeId: complete.id! });
        await caughtUp.until((entry) => entry.type === "replay_complete");
        assert.deepEqual(replay(caughtUp.frames), []);
        assert.deepEqual(http.requests.map((request) => request.lastEventId), [undefined, undefined, undefined, undefined]);
        assert.deepEqual(http.requests[1]?.after, [query.after]);
        assert.deepEqual(http.requests[1]?.resumeId, [query.resumeId]);
        assert.deepEqual(http.requests[2]?.after, [query.after]);
        assert.deepEqual(http.requests[2]?.resumeId, [query.resumeId]);
    } finally { await http.close(); }
});

test("native EventSource reconnects automatically with the last committed SSE ID", { timeout: 30_000 }, async (t) => {
    type NativeMessage = { data: string; lastEventId: string };
    type NativeSource = { addEventListener(type: string, listener: (event: NativeMessage) => void): void; close(): void };
    const NativeEventSource = (globalThis as unknown as { EventSource?: new (url: string) => NativeSource }).EventSource;
    assert.ok(NativeEventSource, "run this test with Node's --experimental-eventsource flag");
    const session = running(), http = await serve(session);
    const source = new NativeEventSource(http.url);
    const observed: Array<{ type: string; data: Record<string, unknown>; lastEventId: string }> = [];
    const updates = new EventEmitter();
    let failure: Error | undefined;
    for (const type of ["agent_event", "replay_complete"]) source.addEventListener(type, (event) => {
        try { observed.push({ type, data: JSON.parse(event.data) as Record<string, unknown>, lastEventId: event.lastEventId }); }
        catch (error) { failure = error as Error; }
        updates.emit("frame");
    });
    const disconnected = new Promise<void>((resolve) => source.addEventListener("error", () => resolve()));
    function until(match: (entry: typeof observed[number]) => boolean): Promise<typeof observed[number]> {
        return new Promise((resolve, reject) => {
            const check = () => {
                const found = observed.find(match);
                if (!failure && !found) return;
                updates.off("frame", check);
                if (failure) reject(failure); else resolve(found!);
            };
            updates.on("frame", check);
            check();
        });
    }
    const cleanup = async () => { source.close(); await http.close(); };
    t.after(cleanup);
    try {
        const initial = await until((entry) => entry.type === "replay_complete");
        emitItem(session, "A");
        const before = await until((entry) => entry.type === "agent_event" && (entry.data.item as Record<string, unknown>).id === "A");
        http.disconnectLatest();
        await disconnected;
        emitItem(session, "B");
        const after = await until((entry) => entry.type === "agent_event" && (entry.data.item as Record<string, unknown>).id === "B");
        const complete = await until((entry) => entry.type === "replay_complete" && entry.data.lastSeq === after.data.seq);
        assert.equal(http.requests[0]?.lastEventId, undefined);
        assert.equal(http.requests[1]?.lastEventId, before.lastEventId);
        assert.deepEqual(observed.filter((entry) => entry.type === "agent_event").map((entry) => (entry.data.item as Record<string, unknown>).id), ["A", "B"]);
        assert.equal(Number(before.data.seq), Number(initial.data.lastSeq) + 1);
        assert.equal(Number(after.data.seq), Number(before.data.seq) + 1);
        // An ID-less replay event inherits the previous committed ID in the
        // native client; only replay_complete advances its reconnect cursor.
        assert.equal(after.lastEventId, before.lastEventId);
        assert.equal(complete.lastEventId, before.lastEventId.replace(/[^:]*$/, String(after.data.seq)));
    } finally { await cleanup(); }
});

/** Ephemeral local transport only: no agent, configuration, token or provider. */
async function serve(session: CanvasSession) {
    const sockets = new Set<Socket>(), clients = new Set<HttpStream>();
    const responses = new Set<ServerResponse>();
    const requests: Array<{ lastEventId: string | undefined; after: string[]; resumeId: string[] }> = [];
    const server = createServer((req, res) => {
        const header = req.headers["last-event-id"];
        const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
        requests.push({ lastEventId: typeof header === "string" ? header : undefined, after: requestUrl.searchParams.getAll("after"), resumeId: requestUrl.searchParams.getAll("resumeId") });
        responses.add(res);
        res.once("close", () => responses.delete(res));
        session.openEvents(requestUrl, res, thread, typeof header === "string" ? header : undefined);
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/events?clientId=${encodeURIComponent(client)}`;
    let stopped: Promise<void> | undefined;
    return {
        url, requests,
        async connect(header?: string, stopAfterFirstReplay = false, query: ResumeQuery = {}) {
            const stream = new HttpStream(addResumeQuery(new URL(url), query).toString(), header, stopAfterFirstReplay);
            clients.add(stream);
            await stream.opened;
            return stream;
        },
        disconnectLatest() {
            const response = [...responses].at(-1);
            assert.ok(response, "there is an active local SSE connection to interrupt");
            response.destroy();
        },
        async close() {
            if (!stopped) {
                clients.forEach((stream) => stream.close());
                stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                sockets.forEach((socket) => socket.destroy());
            }
            await stopped;
        },
    };
}

class HttpStream {
    frames: Frame[] = [];
    opened: Promise<void>;
    closed: Promise<void>;
    private request: ClientRequest;
    private response?: IncomingMessage;
    private stopping = false;
    private ended = false;
    private pending = "";
    private waiters: Array<{ match: (entry: Frame) => boolean; resolve: (entry: Frame) => void; reject: (error: Error) => void }> = [];
    constructor(url: string, header?: string, stopAfterFirstReplay = false) {
        let opened!: () => void, failed!: (error: Error) => void, closed!: () => void;
        this.opened = new Promise<void>((resolve, reject) => { opened = resolve; failed = reject; });
        this.closed = new Promise<void>((resolve) => { closed = resolve; });
        this.request = get(url, { agent: false, headers: header === undefined ? {} : { "Last-Event-ID": header } }, (response) => {
            this.response = response;
            response.once("close", () => { this.ended = true; this.fail(new Error("SSE connection closed")); closed(); });
            response.on("error", (error: Error) => { if (!this.stopping) this.fail(error); });
            try {
                assert.equal(response.statusCode, 200);
                assert.match(String(response.headers["content-type"]), /^text\/event-stream/);
            } catch (error) { failed(error as Error); this.close(); return; }
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
                try {
                    this.pending += chunk;
                    let boundary: number;
                    while (!this.stopping && (boundary = this.pending.indexOf("\n\n")) !== -1) {
                        const entry = parseFrame(this.pending.slice(0, boundary));
                        this.pending = this.pending.slice(boundary + 2);
                        this.frames.push(entry);
                        this.waiters = this.waiters.filter((waiter) => { if (!waiter.match(entry)) return true; waiter.resolve(entry); return false; });
                        if (stopAfterFirstReplay && entry.type === "agent_event") this.close();
                    }
                } catch (error) { this.fail(error as Error); this.close(); }
            });
            opened();
        });
        this.request.on("error", (error: Error) => { failed(error); if (!this.stopping) this.fail(error); });
        this.request.once("close", () => { if (!this.response) { this.ended = true; closed(); } });
    }
    until(match: (entry: Frame) => boolean): Promise<Frame> {
        const existing = this.frames.find(match);
        if (existing) return Promise.resolve(existing);
        if (this.ended) return Promise.reject(new Error("SSE ended before the expected frame"));
        return new Promise((resolve, reject) => this.waiters.push({ match, resolve, reject }));
    }
    close() { this.stopping = true; this.response?.destroy(); this.request.destroy(); }
    private fail(error: Error) { this.waiters.splice(0).forEach((waiter) => waiter.reject(error)); }
}
