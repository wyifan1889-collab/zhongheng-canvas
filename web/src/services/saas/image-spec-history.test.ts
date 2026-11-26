import { expect, test } from "bun:test";
import { createGenerationClient, type GenerationIntent, type GenerationScope } from "./generation";

const taskId = "11111111-1111-4111-8111-111111111111";
const scope: GenerationScope = { accountId: "synthetic-owner", epoch: 2, projectId: "synthetic-project" };
const intent: GenerationIntent = { modelId: "synthetic-image", input: { prompt: "synthetic prompt" }, parameters: {}, projectId: scope.projectId };
function history(specification?: unknown, present = true) {
    return { task: { id: taskId, projectId: scope.projectId, modelId: "original-image-model", priceVersion: 3, quotedUnits: 7,
        executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured", billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
        ...(present ? { imageSpecSnapshot: specification && typeof specification === "object" && !Array.isArray(specification) && "status" in specification && specification.status === "recorded"
            ? { protocol: "openai-image-v1", ...specification } : specification } : {}), parameterSnapshot: { secret: "private-not-for-owner" } },
        result: { taskId, status: "succeeded", resultSnapshot: { kind: "image", media: { mediaId: taskId, kind: "image", contentType: "image/png", sizeBytes: 232, etag: "synthetic-etag" } } } };
}
function fixture(value: unknown) {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(input), init }); return Response.json(value); }, { preconnect: fetch.preconnect });
    return { calls, client: createGenerationClient({ scope, getScope: () => scope, fetcher }) };
}

test("owner history without a specification stays legacy and uses only original task GET", async () => {
    const f = fixture(history(undefined, false)), value = await f.client.get(taskId);
    expect(Object.hasOwn(value.task, "imageSpecSnapshot")).toBe(false);
    expect(value.task.modelId).toBe("original-image-model"); expect(value.task.priceVersion).toBe(3);
    expect(JSON.stringify(value)).not.toContain("private-not-for-owner");
    expect(f.calls.map(call => [call.path, call.init?.method])).toEqual([[`/api/v1/generation/tasks/${taskId}`, "GET"]]);
});

test("recorded owner history preserves exact original size/quality through ID and by-key reads", async () => {
    for (const parameters of [{ size: "2048x2048", quality: "high" }, { size: "1024x1536" }, { quality: "low" }] as const) {
        const f = fixture(history({ status: "recorded", parameters }));
        expect((await f.client.get(taskId)).task.imageSpecSnapshot).toEqual({ status: "recorded", protocol: "openai-image-v1", parameters });
        expect((await f.client.getByKey("synthetic-original-key")).task.imageSpecSnapshot).toEqual({ status: "recorded", protocol: "openai-image-v1", parameters });
        expect(f.calls.map(call => call.init?.method)).toEqual(["GET", "GET"]);
        expect(f.calls.map(call => call.path)).toEqual([`/api/v1/generation/tasks/${taskId}`, "/api/v1/generation/tasks/by-key/synthetic-original-key"]);
    }
});

test("valid invalid marker remains visible history without inventing original parameters", async () => {
    const f = fixture(history({ status: "invalid" })), value = await f.client.get(taskId);
    expect(value.task.imageSpecSnapshot).toEqual({ status: "invalid" });
    expect(value.result?.resultSnapshot.media?.mediaId).toBe(taskId);
    expect(f.calls).toHaveLength(1); expect(f.calls.every(call => call.init?.method === "GET")).toBe(true);
});

test("batch history retains the frozen request limit without loading the current catalog", async () => {
    const snapshot = { status: "recorded", protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "high", n: 10 }, maxImagesPerRequest: 4 };
    const response = { ...history(snapshot), result: null };
    const f = fixture(response);
    expect((await f.client.get(taskId)).task.imageSpecSnapshot).toEqual(snapshot);
    expect(f.calls.map(call => call.path)).toEqual([`/api/v1/generation/tasks/${taskId}`]);
    for (const maxImagesPerRequest of [0, 11, 1.5, "4", null]) {
        const bad = fixture({ ...response, task: { ...response.task, imageSpecSnapshot: { ...snapshot, maxImagesPerRequest } } });
        await expect(bad.client.get(taskId)).rejects.toMatchObject({ outcome: "not-sent" });
    }
});

test("present malformed specification unions or noncanonical parameters reject the task read", async () => {
    const malformed = [null, "recorded", [], {}, { status: "legacy" }, { status: "invalid", parameters: { size: "1024x1024" } },
        { status: "invalid", source: "private-extra" }, { status: "recorded" }, { status: "recorded", parameters: {} },
        { status: "recorded", parameters: { size: "auto" } }, { status: "recorded", parameters: { size: "0x1024" } },
        { status: "recorded", parameters: { quality: "auto" } }, { status: "recorded", parameters: { quality: "high", n: 0 } },
        { status: "recorded", parameters: { quality: "high", n: 11 } }, { status: "recorded", parameters: { quality: "high", n: "4" } },
        { status: "recorded", parameters: { size: "1024x1024", output_format: "png" } },
        { status: "recorded", parameters: { quality: "high" }, source: "private-extra" }];
    for (const snapshot of malformed) {
        const f = fixture(history(snapshot));
        await expect(f.client.get(taskId)).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
        expect(f.calls).toHaveLength(1); expect(f.calls.every(call => call.init?.method === "GET")).toBe(true);
    }
});

test("a corrupt history field on an accepted POST stays uncertain and never auto-resubmits", async () => {
    const response = history({ status: "recorded", parameters: { quality: "auto" } }); response.task.modelId = intent.modelId;
    const f = fixture(response);
    await expect(f.client.submit(intent, 3, "synthetic-original-key")).rejects.toMatchObject({ code: "unconfirmed", outcome: "unknown" });
    expect(f.calls).toHaveLength(1); expect(f.calls.find(() => true)?.init?.method).toBe("POST");
});

test("history alone does not authorize specification quote or unconfirmed submit", async () => {
    const f = fixture(history({ status: "recorded", parameters: { quality: "high" } }));
    const unsupported = { ...intent, parameters: { quality: "high" } } as unknown as GenerationIntent;
    await expect(f.client.quote(unsupported)).rejects.toMatchObject({ code: "catalog_changed", outcome: "not-sent" });
    await expect(f.client.submit(unsupported, 3, "synthetic-original-key")).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    expect(f.calls).toHaveLength(0);
});
