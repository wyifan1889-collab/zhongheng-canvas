import type { AgentSseCursor } from "./agent-sse-resume";

type Source = Pick<EventSource, "addEventListener" | "close">;
type Listener = (event: Event, isCurrentSource: () => boolean) => void;

/** One effect owns the transport; accepted work stays in its existing consumer queue. */
export function createAgentSseConnection(options: {
    endpoint: string; token: string; clientId: string; ownerContext: string;
    getCursor: () => AgentSseCursor; isCurrent: () => boolean;
    createSource?: (url: string) => Source;
    setTimer?: (callback: () => void, delay: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}) {
    const createSource = options.createSource ?? (url => new EventSource(url));
    const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const listeners = new Map<string, Set<Listener>>();
    let source: Source | null = null, stopped = false, timer: unknown, timerSet = false;
    const owns = (candidate: Source) => !stopped && source === candidate && options.isCurrent();
    const bind = (candidate: Source, type: string, listener: Listener) => candidate.addEventListener(type, event => {
        if (owns(candidate)) listener(event, () => owns(candidate));
    });
    const connection = {
        onerror: null as ((event: Event) => void) | null,
        addEventListener(type: string, listener: Listener) {
            let registered = listeners.get(type);
            if (!registered) listeners.set(type, registered = new Set());
            if (registered.has(listener)) return;
            registered.add(listener);
            if (source) bind(source, type, listener);
        },
        close() {
            stopped = true;
            if (timerSet) clearTimer(timer);
            timerSet = false; timer = undefined;
            const previous = source; source = null; previous?.close();
        },
    };
    function open() {
        if (stopped || !options.isCurrent()) { connection.close(); return; }
        // Read the pair once: a partially consumed replay never lends its native ID.
        const cursor = options.getCursor(), valid = Number.isSafeInteger(cursor.lastSeq) && cursor.lastSeq >= 0 && !!cursor.resumeId;
        const url = new URL(options.endpoint);
        url.pathname = `${url.pathname.replace(/\/$/, "")}/events`;
        url.hash = "";
        for (const [name, value] of Object.entries({ token: options.token, clientId: options.clientId, ownerContext: options.ownerContext,
            after: String(valid ? cursor.lastSeq : -1), resumeId: valid ? cursor.resumeId : "" })) url.searchParams.set(name, value);
        const next = createSource(url.toString()); source = next;
        next.addEventListener("error", event => {
            if (!owns(next)) return;
            source = null; next.close(); // Disable native reconnect before scheduling our replacement URL.
            connection.onerror?.(event);
            if (stopped || !options.isCurrent() || timerSet) return;
            timerSet = true; timer = setTimer(() => { timerSet = false; timer = undefined; open(); }, 3000);
        });
        for (const [type, registered] of listeners) for (const listener of registered) bind(next, type, listener);
    }
    open();
    return connection;
}
