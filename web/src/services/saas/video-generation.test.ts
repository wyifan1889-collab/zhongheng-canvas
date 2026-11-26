import { describe, expect, test } from "bun:test";
import { createVideoGenerationClient, parseVideoTaskView, type VideoGenerationIntent } from "./video-generation";
const scope = { accountId: "account-a", epoch: 1 };
const parameters = { mode: "text" as const, resolution: "720p" as const, durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" as const };
const intent: VideoGenerationIntent = { modelId: "video-model", input: { prompt: "合成测试镜头" }, parameters };
const quote = { modelId: intent.modelId, priceVersion: 1, parameters, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 3, usagePolicy: "delivered_video", quoteFingerprint: "a".repeat(64) };
const catalog = { items: [{ id: intent.modelId, displayName: "合成视频", capability: "video", group: null, videoPricing: { priceVersion: 1, billingUnit: "video_specs", creditsPerUnit: null,
    protocol: "yunfei-grok-video-v1", usagePolicy: "delivered_video", videoSpecs: [{ parameters, creditsPerVideo: 3 }] } }] };
const id = "12345678-1234-4234-9234-123456789abc";
const key = `video:${id}`;
export const videoView = () => ({ task: { id, projectId: null, nodeId: null, modelId: intent.modelId, priceVersion: 1, quotedUnits: 3, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 3,
    executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", video: { parameters, usagePolicy: "delivered_video", quotedVideoUnits: 1, reservedCredits: 3, phase: "accepted" } }, result: null });
function fixture() {
    let current: typeof scope | null = scope;
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createVideoGenerationClient({ scope, getScope: () => current, fetcher: (async (path, init) => {
        calls.push({ path: String(path), init });
        return Response.json(String(path).endsWith("/models") ? catalog : String(path).endsWith("/quote") ? { quote } : videoView());
    }) as typeof fetch });
    return { client, calls, change: (next: typeof current) => { current = next; } };
}
describe("platform video client", () => {
    test("exact catalogue and quote consumed once, same-origin confirmed request only", async () => {
        const { client, calls } = fixture(); await client.models(); const confirmed = await client.quote(intent);
        const result = await client.submit(intent, confirmed, key); expect(result.task.id).toBe(id);
        await expect(client.submit(intent, confirmed, key)).rejects.toThrow();
        expect(calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(1);
        const sent = calls.at(-1)!; expect(sent.init?.credentials).toBe("same-origin"); expect(sent.init?.redirect).toBe("error");
        expect(JSON.parse(String(sent.init?.body))).toEqual({ ...intent, confirmedPriceVersion: 1, confirmedQuoteFingerprint: quote.quoteFingerprint });
        expect(new Headers(sent.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    });
    test("changed price catalogue/intent cannot reuse confirmation", async () => {
        const { client, calls } = fixture(); await client.models(); const confirmed = await client.quote(intent);
        await expect(client.submit({ ...intent, input: { prompt: "另一个描述" } }, confirmed, key)).rejects.toThrow();
        await client.models(); await expect(client.submit(intent, confirmed, key)).rejects.toThrow();
        expect(calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(0);
    });
    test("account epoch change never sends or accepts an old request", async () => {
        const instance = fixture(); await instance.client.models(); const confirmed = await instance.client.quote(intent);
        instance.change({ ...scope, epoch: 2 }); await expect(instance.client.submit(intent, confirmed, key)).rejects.toThrow();
        instance.change(scope); await expect(instance.client.get(id)).rejects.toThrow();
        expect(instance.calls).toHaveLength(2);
    });
    test("uncertain create ACK has no retry; recovery is GET by original key", async () => {
        let posts = 0; const methods: string[] = [];
        const client = createVideoGenerationClient({ scope, getScope: () => scope, fetcher: (async (path, init) => {
            methods.push(init?.method ?? "GET");
            if (String(path).endsWith("/models")) return Response.json(catalog);
            if (String(path).endsWith("/quote")) return Response.json({ quote });
            if (init?.method === "POST") { posts++; throw new Error("ACK lost"); }
            expect(String(path)).toContain(encodeURIComponent(key)); return Response.json(videoView());
        }) as typeof fetch });
        await client.models(); const confirmed = await client.quote(intent);
        await expect(client.submit(intent, confirmed, key)).rejects.toMatchObject({ outcome: "unknown" });
        await client.recover(key); expect(posts).toBe(1); expect(methods.at(-1)).toBe("GET");
    });
    test("missing video source, forged unit totals or foreign result cannot be delivered", () => {
        expect(parseVideoTaskView({ ...videoView(), task: { ...videoView().task, video: undefined } })).toBeNull();
        expect(parseVideoTaskView({ ...videoView(), task: { ...videoView().task, quotedUnits: 2 } })).toBeNull();
        expect(parseVideoTaskView({ ...videoView(), result: { taskId: crypto.randomUUID(), status: "succeeded", resultSnapshot: { kind: "video" } } })).toBeNull();
    });
});
