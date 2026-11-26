/** Pure mapping of the Grok section at https://doc.yunfei.best/#grok-doc.
 * This protocol observation is not media delivery, usage approval, or settlement.
 * No alias/envelope fallback: other video protocols require separate evidence.
 */
const source = "yunfei-grok-video-v1" as const;

export type VideoProviderResponseInput = {
    httpStatus: number | null;
    payload: unknown;
} & ({ operation: "create" } | { operation: "inspect"; expectedTaskId: string });

export type VideoDurationEvidence =
    | { status: "reported"; rawSeconds: string }
    | { status: "missing" }
    | { status: "invalid" };

type UnknownReason = "http_or_transport_unknown" | "invalid_response" | "task_id_mismatch" | "unsupported_status" | "contradictory_response";
export type VideoProviderResponse = { source: typeof source } & (
    | { status: "accepted" | "pending"; providerTaskId: string; phase: "queued" | "in_progress" }
    | { status: "completed"; providerTaskId: string; durationEvidence: VideoDurationEvidence;
        asset: { kind: "authenticated_content"; path: string; expectedContentType: "video/mp4" } }
    | { status: "failed"; providerTaskId: string; errorCode: "provider_video_failed" }
    | { status: "unknown"; reason: UnknownReason; providerTaskId?: string }
);

const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function validTaskId(value: unknown): value is string {
    if (typeof value !== "string" || !value || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value === "." || value === "..") return false;
    try { encodeURIComponent(value); return true; } catch { return false; }
}

function durationEvidence(value: unknown): VideoDurationEvidence {
    if (value === undefined) return { status: "missing" };
    return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && /[1-9]/.test(value)
        ? { status: "reported", rawSeconds: value }
        : { status: "invalid" };
}

export function normalizeVideoProviderResponse(input: VideoProviderResponseInput): VideoProviderResponse {
    const data = record(input.payload);
    const observedId = data?.object === "video" && validTaskId(data.id) ? data.id : undefined;
    const expectedId = input.operation === "inspect" && validTaskId(input.expectedTaskId) ? input.expectedTaskId : undefined;
    const providerTaskId = input.operation === "inspect" ? expectedId : observedId;
    const unknown = (reason: UnknownReason): VideoProviderResponse => ({
        source, status: "unknown", reason, ...(providerTaskId === undefined ? {} : { providerTaskId }),
    });
    if (!Number.isInteger(input.httpStatus) || input.httpStatus === null || input.httpStatus < 200 || input.httpStatus >= 300) {
        return unknown("http_or_transport_unknown");
    }
    if (!data || !observedId || input.operation === "inspect" && !expectedId) return unknown("invalid_response");
    if (input.operation === "inspect" && observedId !== expectedId) return unknown("task_id_mismatch");
    if (data.error !== undefined && data.error !== null && data.status !== "failed") return unknown("contradictory_response");
    switch (data.status) {
        case "queued":
        case "in_progress":
            return { source, status: input.operation === "create" ? "accepted" : "pending", providerTaskId: observedId, phase: data.status };
        case "completed":
            return { source, status: "completed", providerTaskId: observedId, durationEvidence: durationEvidence(data.seconds),
                asset: { kind: "authenticated_content", path: `videos/${encodeURIComponent(observedId).replace(/[.!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}/content`, expectedContentType: "video/mp4" } };
        case "failed":
            return { source, status: "failed", providerTaskId: observedId, errorCode: "provider_video_failed" };
        default:
            return unknown("unsupported_status");
    }
}
