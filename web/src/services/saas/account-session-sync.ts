export type AccountSessionSync = {
    publishInvalidated: () => void;
    subscribeInvalidated: (listener: () => void) => () => void;
    subscribeVisible: (listener: () => void) => () => void;
    close: () => void;
};

type SessionSignal = { type: "session-invalidated"; at: number };

const channelName = "infinite-canvas:account-session";
const storageKey = "infinite-canvas:account-session-invalidated";

function parseSignal(value: unknown): SessionSignal | null {
    if (!value || typeof value !== "object") return null;
    const signal = value as Record<string, unknown>;
    return signal.type === "session-invalidated" && typeof signal.at === "number" && Number.isFinite(signal.at)
        ? { type: "session-invalidated", at: signal.at }
        : null;
}

function noOpSubscribe(_listener: () => void): () => void { return () => {}; }

/**
 * Keeps account session state aligned between browser tabs without putting
 * identity, cookies, passwords, or provider credentials into the message.
 */
export function createAccountSessionSync(): AccountSessionSync {
    if (typeof window === "undefined") {
        return { publishInvalidated: () => {}, subscribeInvalidated: noOpSubscribe, subscribeVisible: noOpSubscribe, close: () => {} };
    }

    const invalidatedListeners = new Set<() => void>();
    const visibleListeners = new Set<() => void>();
    let channel: BroadcastChannel | null = null;
    let useStorageFallback = false;

    const notifyInvalidated = (value: unknown) => {
        if (!parseSignal(value)) return;
        for (const listener of invalidatedListeners) listener();
    };
    const onChannelMessage = (event: MessageEvent<unknown>) => notifyInvalidated(event.data);
    const onStorage = (event: StorageEvent) => {
        if (event.key !== storageKey || !event.newValue) return;
        try { notifyInvalidated(JSON.parse(event.newValue)); } catch { /* Ignore unrelated storage content. */ }
    };
    const onVisibility = () => {
        if (document.visibilityState !== "visible") return;
        for (const listener of visibleListeners) listener();
    };

    try {
        if (typeof BroadcastChannel === "function") {
            channel = new BroadcastChannel(channelName);
            channel.addEventListener("message", onChannelMessage);
        } else useStorageFallback = true;
    } catch {
        channel = null;
        useStorageFallback = true;
    }
    if (useStorageFallback) window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);

    return {
        publishInvalidated: () => {
            const signal: SessionSignal = { type: "session-invalidated", at: Date.now() };
            if (channel) {
                try { channel.postMessage(signal); } catch { /* The next visibility check will repair this tab. */ }
                return;
            }
            try {
                window.localStorage.setItem(storageKey, JSON.stringify(signal));
                window.localStorage.removeItem(storageKey);
            } catch { /* Private or blocked storage has no cross-tab fallback. */ }
        },
        subscribeInvalidated: (listener) => {
            invalidatedListeners.add(listener);
            return () => invalidatedListeners.delete(listener);
        },
        subscribeVisible: (listener) => {
            visibleListeners.add(listener);
            return () => visibleListeners.delete(listener);
        },
        close: () => {
            if (channel) {
                channel.removeEventListener("message", onChannelMessage);
                channel.close();
                channel = null;
            }
            if (useStorageFallback) window.removeEventListener("storage", onStorage);
            document.removeEventListener("visibilitychange", onVisibility);
            invalidatedListeners.clear();
            visibleListeners.clear();
        },
    };
}
