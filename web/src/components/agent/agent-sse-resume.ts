const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export type AgentSseCursor = Readonly<{ lastSeq: number; resumeId: string }>;

/** One EventSource effect owns this memory; refresh and connection replacement start fresh. */
export function createAgentSseResumeConsumer(clientId?: string) {
    let scope: string | null = null, streamId: string | null = null, scopeRevision = 0, committedSeq = 0, replaying = false;
    let resumeThreadId = "", cursor: AgentSseCursor = { lastSeq: -1, resumeId: "" };
    const partialReplaySeen = new Set<number>();
    const commitCursor = (seq: number, id?: string) => {
        if (clientId !== undefined && id === `v1:${streamId}:${encodeURIComponent(clientId)}:${encodeURIComponent(resumeThreadId)}:${seq}`) {
            cursor = { lastSeq: seq, resumeId: id };
        }
    };
    return {
        cursor: () => cursor,
        beginReplay(value: unknown): boolean {
            const hello = record(value);
            if (!hello || typeof hello.streamId !== "string" || !hello.streamId || typeof hello.resumeThreadId !== "string" ||
                hello.resumeAfter !== -1 && !sequence(hello.resumeAfter)) return false;
            const nextScope = JSON.stringify([hello.streamId, hello.resumeThreadId]);
            if (scope !== nextScope) {
                scope = nextScope;
                if (streamId !== hello.streamId) {
                    streamId = hello.streamId;
                    scopeRevision++;
                }
                committedSeq = 0;
                partialReplaySeen.clear();
                cursor = { lastSeq: -1, resumeId: "" };
            }
            resumeThreadId = hello.resumeThreadId;
            replaying = true;
            // resumeAfter describes the server's validation, never consumption by this page.
            return true;
        },
        // Live events for a new thread may already be queued before its reconnect hello.
        scopeRevision: () => scopeRevision,
        acceptEvent(type: string, value: unknown, lastEventId?: string): boolean {
            if (scope === null || type === "hello" || type === "ping" || type === "replay_complete") return false;
            const payload = record(value), seq = payload?.seq;
            if (!sequence(seq) || seq === 0 || seq <= committedSeq || partialReplaySeen.has(seq)) return false;
            if (replaying) partialReplaySeen.add(seq);
            else { committedSeq = seq; commitCursor(seq, lastEventId); }
            return true;
        },
        completeReplay(value: unknown, lastEventId?: string): boolean {
            const marker = record(value), lastSeq = marker?.lastSeq;
            if (scope === null || !replaying || !sequence(lastSeq) || lastSeq < committedSeq || [...partialReplaySeen].some(seq => seq > lastSeq)) return false;
            committedSeq = lastSeq;
            partialReplaySeen.clear();
            replaying = false;
            commitCursor(lastSeq, lastEventId);
            return true;
        },
    };
}
