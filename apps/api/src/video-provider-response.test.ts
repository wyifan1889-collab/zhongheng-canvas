import { expect, test } from "bun:test";
import { normalizeVideoProviderResponse, type VideoProviderResponseInput } from "./video-provider-response";

const source = "yunfei-grok-video-v1";
// Public documentation format examples, not captured provider responses.
const queued = () => ({ id: "task_example", object: "video", model: "grok-imagine-video-1.5", status: "queued", progress: 0 });
const completed = () => ({ ...queued(), status: "completed", progress: 100, seconds: "6" });
const create = (payload: unknown, httpStatus: number | null = 200) => normalizeVideoProviderResponse({ operation: "create", payload, httpStatus });
const inspect = (payload: unknown, httpStatus: number | null = 200, expectedTaskId = "task_example") =>
    normalizeVideoProviderResponse({ operation: "inspect", expectedTaskId, payload, httpStatus });

test("documented queued create is accepted; queued and in_progress inspect remain pending", () => {
    expect(create(queued(), 201)).toEqual({ source, status: "accepted", providerTaskId: "task_example", phase: "queued" });
    expect(inspect(queued())).toEqual({ source, status: "pending", providerTaskId: "task_example", phase: "queued" });
    expect(create({ ...queued(), status: "in_progress" })).toEqual({ source, status: "accepted", providerTaskId: "task_example", phase: "in_progress" });
    expect(inspect({ ...queued(), status: "in_progress" })).toEqual({ source, status: "pending", providerTaskId: "task_example", phase: "in_progress" });
});

test("documented completion provides authenticated content intent and reported duration, never delivery or billing", () => {
    const expected = { source, status: "completed", providerTaskId: "task_example", durationEvidence: { status: "reported", rawSeconds: "6" },
        asset: { kind: "authenticated_content", path: "videos/task_example/content", expectedContentType: "video/mp4" } };
    expect(inspect(completed())).toEqual(expected);
    expect(create(completed())).toEqual(expected);
    expect(inspect({ ...completed(), progress: 0 })).toEqual(expected);
});

test("failed is synthesized from the documented state table; no captured failure body or refund is claimed", () => {
    for (const error of [undefined, "synthetic failure", { code: "synthetic", message: "private details" }]) {
        const response = { source, status: "failed", providerTaskId: "task_example", errorCode: "provider_video_failed" };
        expect(inspect({ ...queued(), status: "failed", error })).toEqual(response);
        expect(create({ ...queued(), status: "failed", error })).toEqual(response);
    }
});

test("HTTP or transport uncertainty is never turned into an execution failure, even with a terminal-looking body", () => {
    for (const status of [null, 0, 199, 300, 401, 403, 404, 429, 500, 502, NaN, 200.5]) {
        expect(inspect({ ...queued(), status: "failed" }, status)).toEqual({ source, status: "unknown", reason: "http_or_transport_unknown", providerTaskId: "task_example" });
        expect(create(completed(), status)).toEqual({ source, status: "unknown", reason: "http_or_transport_unknown", providerTaskId: "task_example" });
    }
    expect(create("<html>gateway error</html>", 502)).toEqual({ source, status: "unknown", reason: "http_or_transport_unknown" });
});

test("unverified payloads and envelopes do not become accepted or terminal results", () => {
    for (const payload of [null, [], "<html>not JSON</html>", {}, { id: "task_example" }, { ...queued(), object: "image" },
        { code: 0, data: queued() }, { ...queued(), id: undefined }, { ...queued(), id: 42 }]) {
        expect(create(payload)).toEqual({ source, status: "unknown", reason: "invalid_response" });
        expect(inspect(payload)).toEqual({ source, status: "unknown", reason: "invalid_response", providerTaskId: "task_example" });
    }
});

test("inspect binds the exact persisted task identity and never adopts a different response id", () => {
    expect(inspect({ ...completed(), id: "other-task" })).toEqual({ source, status: "unknown", reason: "task_id_mismatch", providerTaskId: "task_example" });
    expect(inspect(completed(), 200, "")).toEqual({ source, status: "unknown", reason: "invalid_response" });
});

test("task ids retain the existing generation-task identifier limit at both observed and expected boundaries", () => {
    const validId = "x".repeat(200), oversizedId = "x".repeat(201);
    expect(create({ ...queued(), id: validId })).toMatchObject({ status: "accepted", providerTaskId: validId });
    expect(inspect({ ...queued(), id: validId }, 200, validId)).toMatchObject({ status: "pending", providerTaskId: validId });
    expect(create({ ...queued(), id: oversizedId })).toEqual({ source, status: "unknown", reason: "invalid_response" });
    expect(inspect({ ...queued(), id: oversizedId })).toEqual({ source, status: "unknown", reason: "invalid_response", providerTaskId: "task_example" });
    expect(inspect({ ...queued(), id: validId }, 200, oversizedId)).toEqual({ source, status: "unknown", reason: "invalid_response" });
});

test("opaque ids cannot inject an extra path segment or produce malformed percent encoding", () => {
    const id = "task/a?access=private#fragment";
    const result = inspect({ ...completed(), id }, 200, id);
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.asset.path).toBe("videos/task%2Fa%3Faccess%3Dprivate%23fragment/content");
    for (const id of ["", " task_example", "task_example ", "task\nexample", "task\u007fexample", ".", "..", "task\ud800"]) {
        expect(create({ ...completed(), id })).toEqual({ source, status: "unknown", reason: "invalid_response" });
    }
});

test("opaque id encoding fits the existing provider gateway path whitelist without changing provider identity", () => {
    const id = "task..!''()*~";
    const result = inspect({ ...completed(), id }, 200, id);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
        expect(result.providerTaskId).toBe(id);
        expect(result.asset.path).toBe("videos/task%2E%2E%21%27%27%28%29%2A%7E/content");
        expect(result.asset.path).not.toContain("..");
        // provider-gateway.ts providerUrl uses this whitelist before sending.
        expect(result.asset.path).toMatch(/^[A-Za-z0-9/_:.%-]+$/);
    }
});

test("undocumented aliases and unknown statuses stay unknown despite progress or URL fields", () => {
    for (const status of [undefined, null, "pending", "processing", "cancelled", "succeeded", "COMPLETED", "future_status"]) {
        expect(inspect({ ...completed(), status, url: "https://example.test/video.mp4" })).toEqual({ source, status: "unknown", reason: "unsupported_status", providerTaskId: "task_example" });
    }
    expect(inspect({ ...queued(), progress: 100, url: "https://example.test/video.mp4" })).toEqual({ source, status: "pending", providerTaskId: "task_example", phase: "queued" });
});

test("non-null errors contradict non-failed states instead of being silently accepted", () => {
    for (const status of ["queued", "in_progress", "completed"]) {
        for (const error of ["failure", {}, false, 0]) expect(inspect({ ...queued(), status, error })).toEqual({
            source, status: "unknown", reason: "contradictory_response", providerTaskId: "task_example" });
    }
    expect(inspect({ ...queued(), error: null }).status).toBe("pending");
});

test("completion remains an execution fact when duration evidence is absent or invalid", () => {
    const missing = { ...completed() } as Record<string, unknown>;
    delete missing.seconds;
    expect(inspect(missing)).toMatchObject({ status: "completed", durationEvidence: { status: "missing" } });
    for (const seconds of [null, 6, "", "0", "0.00", "-6", "+6", " 6 ", "6e1", "06", "NaN", {}, []]) {
        expect(inspect({ ...completed(), seconds })).toMatchObject({ status: "completed", durationEvidence: { status: "invalid" } });
    }
    for (const seconds of ["6", "6.00", "0.25"]) {
        expect(inspect({ ...completed(), seconds })).toMatchObject({ status: "completed", durationEvidence: { status: "reported", rawSeconds: seconds } });
    }
});

test("normalization projects no provider secrets, raw errors or unverified asset URLs and does not mutate input", () => {
    const payload = { ...completed(), url: "https://example.test/video.mp4?access=private", apiKey: "synthetic-secret", headers: { Authorization: "Bearer synthetic" },
        output: [{ url: "https://example.test/other.mp4" }], arbitrary: { secret: "private" } };
    const before = JSON.stringify(payload);
    const input: VideoProviderResponseInput = { operation: "inspect", expectedTaskId: "task_example", httpStatus: 200, payload };
    const first = normalizeVideoProviderResponse(input);
    expect(normalizeVideoProviderResponse(input)).toEqual(first);
    expect(JSON.stringify(payload)).toBe(before);
    expect(JSON.stringify(first)).not.toContain("private");
    expect(JSON.stringify(first)).not.toContain("synthetic");
    expect(first).toEqual(inspect(completed()));
});
