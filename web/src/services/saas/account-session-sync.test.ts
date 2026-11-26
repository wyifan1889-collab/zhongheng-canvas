import { expect, spyOn, test } from "bun:test";
import { createAccountSessionSync, type AccountSessionSync } from "./account-session-sync";

// Synchronous fake browser surfaces dispatch native events through the real adapter.
// No await occurs while these globals are installed, and no real channel is opened.
function withBrowser(transport: "channel" | "missing" | "throws", run: (browser: {
    document: EventTarget; window: EventTarget; sync: AccountSessionSync;
    setVisibility: (state: DocumentVisibilityState) => void;
    channel: () => TestChannel;
}) => void) {
    let visibility: DocumentVisibilityState = "hidden";
    const document = new EventTarget();
    Object.defineProperty(document, "visibilityState", { get: () => visibility });
    const window = new EventTarget();
    let channel: TestChannel | undefined;
    class Channel extends TestChannel {
        constructor(name: string) {
            super(name);
            if (transport === "throws") throw new Error("synthetic unsupported channel");
            channel = this;
        }
    }
    const replacements = { window, document, BroadcastChannel: transport === "missing" ? undefined : Channel };
    const descriptors = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let sync: AccountSessionSync | undefined;
    try {
        for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        sync = createAccountSessionSync();
        run({ document, window, sync, setVisibility: (state) => { visibility = state; }, channel: () => channel! });
    } finally {
        // close() resolves window/document dynamically: detach before restoring globals.
        try { sync?.close(); }
        finally {
            for (const [key, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    }
}

class TestChannel extends EventTarget {
    closed = 0;
    constructor(readonly name: string) { super(); }
    postMessage(_value: unknown) {}
    close() { this.closed++; }
}

test("real session sync adapter filters hidden events, unsubscribes and closes its channel/listeners", () => {
    withBrowser("channel", ({ document, window, sync, setVisibility, channel }) => {
        const documentRemove = spyOn(document, "removeEventListener");
        const channelRemove = spyOn(channel(), "removeEventListener");
        let first = 0, second = 0, invalidated = 0;
        const unsubscribe = sync.subscribeVisible(() => { first++; });
        sync.subscribeVisible(() => { second++; });
        const stopInvalidated = sync.subscribeInvalidated(() => { invalidated++; });
        try {
            expect(channel().name).toBe("infinite-canvas:account-session");
            document.dispatchEvent(new Event("visibilitychange"));
            expect([first, second]).toEqual([0, 0]);
            setVisibility("visible");
            window.dispatchEvent(new Event("focus"));
            expect([first, second]).toEqual([0, 0]);
            document.dispatchEvent(new Event("visibilitychange"));
            expect([first, second]).toEqual([1, 1]);
            setVisibility("hidden");
            document.dispatchEvent(new Event("visibilitychange"));
            expect([first, second]).toEqual([1, 1]);
            unsubscribe();
            setVisibility("visible");
            document.dispatchEvent(new Event("visibilitychange"));
            expect([first, second]).toEqual([1, 2]);
            channel().dispatchEvent(new MessageEvent("message", { data: { type: "session-invalidated", at: 1 } }));
            expect(invalidated).toBe(1);
            stopInvalidated();
            channel().dispatchEvent(new MessageEvent("message", { data: { type: "session-invalidated", at: 2 } }));
            expect(invalidated).toBe(1);
            sync.close();
            sync.close();
            expect(channel().closed).toBe(1);
            expect(documentRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
            expect(channelRemove).toHaveBeenCalledWith("message", expect.any(Function));
            document.dispatchEvent(new Event("visibilitychange"));
            channel().dispatchEvent(new MessageEvent("message", { data: { type: "session-invalidated", at: 3 } }));
            expect([first, second, invalidated]).toEqual([1, 2, 1]);
        } finally { documentRemove.mockRestore(); channelRemove.mockRestore(); }
    });
});

for (const transport of ["missing", "throws"] as const) test(`real session sync adapter cleans storage fallback when channel is ${transport}`, () => {
    withBrowser(transport, ({ document, window, sync, setVisibility }) => {
        const windowRemove = spyOn(window, "removeEventListener");
        const documentRemove = spyOn(document, "removeEventListener");
        let invalidated = 0, visible = 0;
        const unsubscribe = sync.subscribeInvalidated(() => { invalidated++; });
        sync.subscribeVisible(() => { visible++; });
        const storage = (key: string, newValue: string | null) => {
            const event = new Event("storage");
            Object.defineProperties(event, { key: { value: key }, newValue: { value: newValue } });
            window.dispatchEvent(event);
        };
        const key = "infinite-canvas:account-session-invalidated";
        const signal = JSON.stringify({ type: "session-invalidated", at: 1 });
        try {
            const ignored: [string, string | null][] = [["unrelated", signal], [key, null], [key, "invalid JSON"], [key, JSON.stringify({ type: "session-invalidated", at: "invalid" })]];
            for (const [eventKey, value] of ignored) storage(eventKey, value);
            expect(invalidated).toBe(0);
            storage(key, signal);
            expect(invalidated).toBe(1);
            unsubscribe();
            storage(key, signal);
            expect(invalidated).toBe(1);
            sync.subscribeInvalidated(() => { invalidated++; });
            document.dispatchEvent(new Event("visibilitychange"));
            expect(visible).toBe(0);
            setVisibility("visible");
            document.dispatchEvent(new Event("visibilitychange"));
            expect(visible).toBe(1);
            sync.close();
            expect(windowRemove).toHaveBeenCalledWith("storage", expect.any(Function));
            expect(documentRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
            storage(key, signal);
            document.dispatchEvent(new Event("visibilitychange"));
            expect([invalidated, visible]).toEqual([1, 1]);
        } finally { windowRemove.mockRestore(); documentRemove.mockRestore(); }
    });
});
