import { expect, test } from "bun:test";
import { createAgentSseConnection } from "./agent-sse-connection";
import { createAgentSseResumeConsumer } from "./agent-sse-resume";

type Cursor = { lastSeq: number; resumeId: string };
type Timer = { callback: () => void; delay: number };

class FakeSource {
    readonly listeners = new Map<string, EventListenerOrEventListenerObject[]>();
    closeCalls = 0;
    constructor(readonly url: string) {}
    addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
        this.listeners.set(type, [...this.listeners.get(type) || [], listener]);
    }) as EventSource["addEventListener"];
    close() { this.closeCalls++; }
    // Closed sources deliberately retain their callbacks to exercise late delivery.
    emit(type: string, payload: unknown = {}, lastEventId = "") {
        const event = { type, data: JSON.stringify(payload), lastEventId } as MessageEvent;
        for (const listener of this.listeners.get(type) || []) {
            if (typeof listener === "function") listener(event);
            else listener.handleEvent(event);
        }
    }
}

function fakeConnection(getCursor?: () => Cursor) {
    const sources: FakeSource[] = [], timers = new Set<Timer>(), cleared: Timer[] = [];
    let current = true, cursor: Cursor = { lastSeq: -1, resumeId: "" };
    const connection = createAgentSseConnection({
        endpoint: "http://synthetic-agent.invalid/prefix",
        token: "synthetic token +/&?=中文",
        clientId: "synthetic client +/&?=中文",
        ownerContext: "synthetic owner +/&?=中文",
        getCursor: getCursor || (() => cursor),
        isCurrent: () => current,
        createSource: (url) => {
            const source = new FakeSource(url);
            sources.push(source);
            return source;
        },
        setTimer: (callback, delay) => {
            const timer = { callback, delay };
            timers.add(timer);
            return timer;
        },
        clearTimer: (handle) => {
            const timer = handle as Timer;
            timers.delete(timer);
            cleared.push(timer);
        },
    });
    return {
        connection, sources, timers, cleared,
        setCurrent: (value: boolean) => { current = value; },
        setCursor: (value: Cursor) => { cursor = value; },
        fireTimer: () => {
            const timer = timers.values().next().value;
            if (!timer) throw new Error("Expected one pending reconnect timer");
            timers.delete(timer);
            timer.callback();
        },
    };
}

const clientId = "synthetic client +/&?=中文", streamId = "synthetic-stream", threadId = "synthetic thread:/中文";
const hello = (resumeAfter = -1) => ({ streamId, resumeThreadId: threadId, resumeAfter });
const eventId = (seq: number) => `v1:${streamId}:${encodeURIComponent(clientId)}:${encodeURIComponent(threadId)}:${seq}`;
const data = (event: Event) => JSON.parse((event as MessageEvent).data) as Record<string, unknown>;

function bindConsumer(env: ReturnType<typeof fakeConnection>, consumer: ReturnType<typeof createAgentSseResumeConsumer>, accepted: (payload: Record<string, unknown>) => void = () => {}) {
    env.connection.addEventListener("hello", (event) => { consumer.beginReplay(data(event)); });
    env.connection.addEventListener("replay_complete", (event) => { consumer.completeReplay(data(event), (event as MessageEvent).lastEventId); });
    for (const kind of ["agent_event", "ping"]) env.connection.addEventListener(kind, (event) => {
        const payload = data(event);
        if (consumer.acceptEvent(kind, payload, (event as MessageEvent).lastEventId)) accepted(payload);
    });
}

test("initial and reconnect URLs preserve encoded credentials, owner and client while adding the cursor pair", () => {
    const env = fakeConnection();
    const initial = new URL(env.sources[0].url);
    expect(initial.pathname).toBe("/prefix/events");
    expect(initial.searchParams.get("token")).toBe("synthetic token +/&?=中文");
    expect(initial.searchParams.get("clientId")).toBe(clientId);
    expect(initial.searchParams.get("ownerContext")).toBe("synthetic owner +/&?=中文");
    expect(initial.searchParams.get("after")).toBe("-1");
    expect(initial.searchParams.has("resumeId")).toBe(true);
    expect(initial.searchParams.get("resumeId")).toBe("");
    env.setCursor({ lastSeq: 7, resumeId: eventId(7) });
    env.sources[0].emit("error");
    env.fireTimer();
    const resumed = new URL(env.sources[1].url);
    for (const key of ["token", "clientId", "ownerContext"]) expect(resumed.searchParams.get(key)).toBe(initial.searchParams.get(key));
    expect(resumed.searchParams.getAll("after")).toEqual(["7"]);
    expect(resumed.searchParams.getAll("resumeId")).toEqual([eventId(7)]);
    env.connection.close();
});

test("an error closes its source before notifying business code and schedules only one 3000ms reconnect", () => {
    const env = fakeConnection(), old = env.sources[0];
    let errors = 0;
    env.connection.onerror = () => {
        errors++;
        expect(old.closeCalls).toBe(1);
        expect(env.timers.size).toBe(0);
        expect(env.sources).toHaveLength(1);
    };
    old.emit("error");
    old.emit("error");
    expect(errors).toBe(1);
    expect(old.closeCalls).toBe(1);
    expect(env.timers.size).toBe(1);
    expect([...env.timers][0].delay).toBe(3000);
    env.fireTimer();
    expect(env.timers.size).toBe(0);
    expect(env.sources).toHaveLength(2);
    expect(env.sources.filter((source) => source.closeCalls === 0)).toHaveLength(1);
    env.connection.close();
});

test("listeners follow replacement sources while old events, errors and captured guards become stale", () => {
    const env = fakeConnection(), values: number[] = [], guards: Array<() => boolean> = [];
    env.connection.addEventListener("agent_event", (event, isCurrentSource) => {
        values.push(Number(data(event).seq));
        guards.push(isCurrentSource);
    });
    const old = env.sources[0];
    old.emit("agent_event", { seq: 1 });
    expect(guards[0]()).toBe(true);
    old.emit("error");
    expect(guards[0]()).toBe(false);
    old.emit("agent_event", { seq: 99 });
    env.fireTimer();
    old.emit("error");
    old.emit("agent_event", { seq: 100 });
    env.sources[1].emit("agent_event", { seq: 2 });
    expect(values).toEqual([1, 2]);
    expect(guards[1]()).toBe(true);
    expect(env.timers.size).toBe(0);
    env.connection.close();
    expect(guards[1]()).toBe(false);
    env.sources[1].emit("agent_event", { seq: 101 });
    expect(values).toEqual([1, 2]);
});

test("cleanup cancels the reconnect timer and a previously dispatched timer cannot reopen the connection", () => {
    const env = fakeConnection();
    env.sources[0].emit("error");
    const timer = [...env.timers][0];
    env.connection.close();
    env.connection.close();
    expect(env.timers.size).toBe(0);
    expect(env.cleared).toContain(timer);
    timer.callback();
    env.sources[0].emit("error");
    expect(env.sources).toHaveLength(1);
    expect(env.sources[0].closeCalls).toBe(1);
    expect(env.timers.size).toBe(0);
});

test("a protocol-rejection listener can permanently close its source without scheduling reconnect", () => {
    const env = fakeConnection();
    let guard: (() => boolean) | undefined;
    env.connection.addEventListener("hello", (_event, isCurrentSource) => {
        guard = isCurrentSource;
        env.connection.close();
    });
    env.sources[0].emit("hello", { protocolVersion: -1 });
    expect(guard?.()).toBe(false);
    env.sources[0].emit("error");
    expect(env.sources[0].closeCalls).toBe(1);
    expect(env.timers.size).toBe(0);
    expect(env.sources).toHaveLength(1);
});

test("business error handling can stop an initial failed connection before a retry is scheduled", () => {
    const env = fakeConnection();
    env.connection.onerror = () => { env.connection.close(); };
    env.sources[0].emit("error");
    expect(env.sources[0].closeCalls).toBe(1);
    expect(env.timers.size).toBe(0);
});

test("an obsolete account scope suppresses source callbacks and a pending reconnect", () => {
    const env = fakeConnection();
    let events = 0, errors = 0;
    env.connection.addEventListener("agent_event", () => { events++; });
    env.connection.onerror = () => { errors++; };
    env.sources[0].emit("error");
    expect(errors).toBe(1);
    env.setCurrent(false);
    env.fireTimer();
    env.sources[0].emit("agent_event", { seq: 1 });
    env.sources[0].emit("error");
    expect(events).toBe(0);
    expect(errors).toBe(1);
    expect(env.sources).toHaveLength(1);
    expect(env.timers.size).toBe(0);
    env.connection.close();
});

test("scope changes invalidate guards even before cleanup of an otherwise live source", () => {
    const env = fakeConnection();
    let guard: (() => boolean) | undefined, events = 0, errors = 0;
    env.connection.addEventListener("agent_event", (_event, isCurrentSource) => { guard = isCurrentSource; events++; });
    env.connection.onerror = () => { errors++; };
    env.sources[0].emit("agent_event", { seq: 1 });
    env.setCurrent(false);
    expect(guard?.()).toBe(false);
    env.sources[0].emit("agent_event", { seq: 2 });
    env.sources[0].emit("error");
    expect(events).toBe(1);
    expect(errors).toBe(0);
    expect(env.timers.size).toBe(0);
    env.connection.close();
});

test("a partial out-of-order replay reconnects from its previous safe cursor and retains both items once", () => {
    const consumer = createAgentSseResumeConsumer(clientId), env = fakeConnection(() => consumer.cursor());
    const items: unknown[] = [];
    bindConsumer(env, consumer, (payload) => { items.push(payload.item); });
    expect(consumer.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
    env.sources[0].emit("hello", hello());
    env.sources[0].emit("replay_complete", { lastSeq: 4 }, eventId(4));
    env.sources[0].emit("error");
    env.fireTimer();
    env.sources[1].emit("hello", hello(4));
    env.sources[1].emit("agent_event", { seq: 9, replayed: true, item: "item-a" });
    expect(consumer.cursor()).toEqual({ lastSeq: 4, resumeId: eventId(4) });
    env.sources[1].emit("error");
    env.fireTimer();
    const resumed = new URL(env.sources[2].url);
    expect(resumed.searchParams.get("after")).toBe("4");
    expect(resumed.searchParams.get("resumeId")).toBe(eventId(4));
    env.sources[2].emit("hello", hello(4));
    env.sources[2].emit("agent_event", { seq: 9, replayed: true, item: "item-a" });
    env.sources[2].emit("agent_event", { seq: 6, replayed: true, item: "item-b" });
    env.sources[2].emit("replay_complete", { lastSeq: 8 }, eventId(8));
    expect(consumer.cursor()).toEqual({ lastSeq: 4, resumeId: eventId(4) });
    env.sources[2].emit("replay_complete", { lastSeq: 9 }, eventId(9));
    expect(items).toEqual(["item-a", "item-b"]);
    expect(consumer.cursor()).toEqual({ lastSeq: 9, resumeId: eventId(9) });
    env.connection.close();
});

test("only an accepted live event advances the cursor pair used by the next connection", () => {
    const consumer = createAgentSseResumeConsumer(clientId), env = fakeConnection(() => consumer.cursor());
    bindConsumer(env, consumer);
    env.sources[0].emit("hello", hello(), eventId(100));
    env.sources[0].emit("ping", { seq: 100 }, eventId(100));
    expect(consumer.cursor()).toEqual({ lastSeq: -1, resumeId: "" });
    env.sources[0].emit("replay_complete", { lastSeq: 0 }, eventId(0));
    env.sources[0].emit("agent_event", { seq: 1 }, eventId(1));
    env.sources[0].emit("agent_event", { seq: 1 }, eventId(100));
    env.sources[0].emit("agent_event", { seq: "2" }, eventId(2));
    env.sources[0].emit("ping", { seq: 100 }, eventId(100));
    expect(consumer.cursor()).toEqual({ lastSeq: 1, resumeId: eventId(1) });
    env.sources[0].emit("error");
    env.fireTimer();
    const resumed = new URL(env.sources[1].url);
    expect(resumed.searchParams.get("after")).toBe("1");
    expect(resumed.searchParams.get("resumeId")).toBe(eventId(1));
    env.connection.close();
});

test("an accepted queued event survives source replacement and its replay is not queued twice", async () => {
    const consumer = createAgentSseResumeConsumer(clientId), env = fakeConnection(() => consumer.cursor());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let queue = held, consumed = 0, accepted = 0;
    bindConsumer(env, consumer, () => {
        accepted++;
        const revision = consumer.scopeRevision();
        queue = queue.then(() => { if (consumer.scopeRevision() === revision) consumed++; });
    });
    env.sources[0].emit("hello", hello());
    env.sources[0].emit("agent_event", { seq: 1, replayed: true });
    env.sources[0].emit("error");
    env.fireTimer();
    env.sources[1].emit("hello", hello());
    env.sources[1].emit("agent_event", { seq: 1, replayed: true });
    env.sources[1].emit("replay_complete", { lastSeq: 1 }, eventId(1));
    expect(accepted).toBe(1);
    expect(consumed).toBe(0);
    release();
    await queue;
    expect(consumed).toBe(1);
    env.connection.close();
});
