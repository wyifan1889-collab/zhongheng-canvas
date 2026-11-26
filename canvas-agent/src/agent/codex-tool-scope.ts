export type CodexToolScope = { threadId: string; turnId: string };

/** Explicitly malformed metadata must never become an unscoped legacy call. */
export function codexToolSource(meta: unknown): CodexToolScope | { invalid: true } | undefined {
    if (meta === undefined) return undefined;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { invalid: true };
    if (!["x-codex-turn-metadata", "threadId", "turnId", "thread_id", "turn_id"].some((key) => key in meta)) return undefined;
    return codexToolScope(meta) || { invalid: true };
}

/** The runtime supplies this MCP metadata; tool arguments never supply routing. */
export function codexToolScope(meta: unknown): CodexToolScope | undefined {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
    const value = (meta as Record<string, unknown>)["x-codex-turn-metadata"];
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { thread_id, turn_id } = value as Record<string, unknown>;
    if (typeof thread_id !== "string" || !thread_id || typeof turn_id !== "string" || !turn_id) return undefined;
    if ("threadId" in meta && (meta as Record<string, unknown>).threadId !== thread_id) return undefined;
    return { threadId: thread_id, turnId: turn_id };
}
