import { expect, test } from "bun:test";
import { appendPlatformVideo } from "./platform-video-result";
import type { VideoReceipt } from "@/pages/video/platform-video-workbench";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const id = "12345678-1234-4234-9234-123456789abc";
const parameters = { mode: "text" as const, resolution: "720p" as const, durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" as const };
const receipt = (): VideoReceipt => ({ id: `video:${id}`, taskId: id, accountId: "account-a", createdAt: 1, state: "accepted",
    intent: { modelId: "video-model", input: { prompt: "原视频描述" }, parameters },
    quote: { modelId: "video-model", priceVersion: 2, parameters, reservedCredits: 12, quotedVideoUnits: 1, maxVideoUnits: 1, usagePolicy: "delivered_video", quoteFingerprint: "a".repeat(64) },
    view: { task: { id, projectId: null, nodeId: null, modelId: "video-model", priceVersion: 2, quotedUnits: 12, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 12,
        executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", video: { parameters, usagePolicy: "delivered_video", quotedVideoUnits: 1, reservedCredits: 12, phase: "completed" } },
        result: { taskId: id, status: "succeeded", resultSnapshot: { media: { mediaId: id, kind: "video", contentType: "video/mp4", sizeBytes: 16, etag: "b".repeat(64) } } } } });
const media = { url: "blob:local-video", storageKey: "video:local", bytes: 16, mimeType: "video/mp4", width: 1280, height: 720 };
const bounds = { width: 420, height: 420 }, center = { x: 200, y: 200 };

test("delivered video appends an original video node, preserving existing nodes and preventing duplicate application", () => {
    const existing: CanvasNodeData = { id: "original", type: CanvasNodeType.Text, title: "原内容", position: center, width: 200, height: 120, metadata: { content: "不得覆盖" } };
    const first = appendPlatformVideo([existing], center, receipt(), media, bounds);
    expect(first.added).toBe(true); expect(first.nodes[0]).toBe(existing);
    expect(first.nodes[1].type).toBe(CanvasNodeType.Video); expect(first.nodes[1].metadata?.prompt).toBe("原视频描述");
    expect(first.nodes[1].metadata?.videoTaskId).toBeUndefined(); expect(first.nodes[1].metadata?.cloudMediaId).toBe(id);
    expect(first.nodes[1].width / first.nodes[1].height).toBe(1280 / 720);
    const second = appendPlatformVideo(first.nodes, center, receipt(), media, bounds);
    expect(second.added).toBe(false); expect(second.nodes).toBe(first.nodes);
});

test("incomplete settlement, another task, modified quote or mismatched local media cannot become canvas content", () => {
    for (const change of [
        (r: VideoReceipt) => { r.view!.task.billingStatus = "reserved"; },
        (r: VideoReceipt) => { r.view!.task.deliveryStatus = "pending"; },
        (r: VideoReceipt) => { r.view!.task.id = "22345678-1234-4234-9234-123456789abc"; },
        (r: VideoReceipt) => { r.quote.priceVersion = 3; },
    ]) { const r = receipt(); change(r); expect(() => appendPlatformVideo([], center, r, media, bounds)).toThrow(); }
    expect(() => appendPlatformVideo([], center, receipt(), { ...media, bytes: 17 }, bounds)).toThrow();
    expect(() => appendPlatformVideo([], center, receipt(), { ...media, mimeType: "text/html" }, bounds)).toThrow();
});
