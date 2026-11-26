import { expect, test } from "bun:test";
import { createVideoWorkbenchSession, parseVideoReceipt, readPrivateVideo, type VideoReceipt } from "./platform-video-workbench";
import { parseVideoTaskView, type VideoGenerationClient, type VideoGenerationScope } from "@/services/saas/video-generation";
import type { PublicVideoQuote } from "../../../../packages/shared/src/generation-video";
import { createCreationMediaLaunchStore, type CreationMediaDraft } from "@/stores/use-creation-media-launch";
import { videoReferenceIssue } from "./use-platform-video-workbench";
import { historyOriginTarget, parseHistoryDetail } from "@/services/saas/generation-history-detail";
const scope = { accountId: "a", epoch: 1 }, id = "12345678-1234-4234-9234-123456789abc", key = `video:${id}`;
const parameters = { mode: "text" as const, resolution: "720p" as const, durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" as const };
const intent = { modelId: "video-model", input: { prompt: "合成镜头" }, parameters };
const quote: PublicVideoQuote = { modelId: intent.modelId, priceVersion: 1, parameters, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 3, usagePolicy: "delivered_video", quoteFingerprint: "a".repeat(64) };
const view = () => parseVideoTaskView({ task: { id, projectId: null, nodeId: null, modelId: intent.modelId, priceVersion: 1, quotedUnits: 3, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 3,
    executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", video: { parameters, usagePolicy: "delivered_video", quotedVideoUnits: 1, reservedCredits: 3, phase: "accepted" } }, result: null })!;
function fixture() {
    let current: VideoGenerationScope | null = scope, sent = 0, failStorage = false, recovered = 0;
    const rows = new Map<string, VideoReceipt>(), events: string[] = [];
    const receipts = { put: async (receipt: VideoReceipt) => { events.push("save"); if (failStorage) throw new Error("storage failed"); rows.set(receipt.id, structuredClone(receipt)); }, list: async () => [...rows.values()] };
    const client = { quote: async () => quote, submit: async () => { events.push("submit"); sent++; return view(); }, get: async () => { recovered++; return view(); }, recover: async () => { recovered++; return view(); } } as unknown as { -readonly [K in keyof VideoGenerationClient]: VideoGenerationClient[K] };
    const create = () => createVideoWorkbenchSession({ scope, getScope: () => current, client, receipts, isIntentCurrent: () => true, createKey: () => key });
    return { create, client, rows, events, receipts, sent: () => sent, recovered: () => recovered, change: (value: typeof current) => { current = value; }, fail: () => { failStorage = true; } };
}
test("receipt is durable before POST; double confirmation sends once", async () => {
    const data = fixture(), session = data.create(); await session.prepare(intent); await Promise.all([session.confirm(), session.confirm()]);
    expect(data.events.slice(0, 2)).toEqual(["save", "submit"]); expect(data.sent()).toBe(1); expect(session.getState().receipt?.taskId).toBe(id);
});
test("failed local persistence prevents submit", async () => {
    const data = fixture(), session = data.create(); await session.prepare(intent); data.fail(); await session.confirm();
    expect(data.sent()).toBe(0); expect(session.getState().phase).toBe("rejected");
});
test("lost ACK persists unknown and a fresh session only GETs original key", async () => {
    const data = fixture(); data.client.submit = async () => { throw new Error("ACK lost"); };
    const first = data.create(); await first.prepare(intent); await first.confirm(); first.close();
    const receipt = data.rows.get(key)!; expect(receipt.state).toBe("unconfirmed");
    const restored = data.create(); await restored.restore(receipt); await restored.confirm();
    expect(data.recovered()).toBe(1); expect(restored.getState().receipt?.taskId).toBe(id); expect(data.sent()).toBe(0);
});
test("same unresolved intent cannot obtain a second quote from a new session", async () => {
    const data = fixture(), first = data.create(); await first.prepare(intent); await first.confirm(); first.close();
    const second = data.create(); await second.prepare(intent); expect(second.getState().phase).toBe("idle"); expect(second.getState().error).toContain("未结束回执");
});
test("late account result is never persisted or registered in another epoch", async () => {
    const data = fixture(), session = data.create(); await session.prepare(intent);
    let release!: (value: ReturnType<typeof view>) => void;
    data.client.submit = () => new Promise(resolve => { release = resolve; });
    const pending = session.confirm(); await new Promise(resolve => setTimeout(resolve, 0)); data.change({ accountId: "b", epoch: 2 }); release(view()); await pending;
    expect(data.rows.get(key)?.taskId).toBeUndefined(); expect(session.getState().view).toBeNull();
});
test("private media requires delivered source, settlement and matching bytes; URL alone is insufficient", async () => {
    const blob = new Blob(["synthetic mp4 bytes"], { type: "video/mp4" });
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("");
    const ready = view(); ready.task.executionStatus = "succeeded"; ready.task.deliveryStatus = "visible"; ready.task.billingStatus = "captured"; ready.task.video.phase = "completed";
    ready.result = { taskId: id, status: "succeeded", resultSnapshot: { kind: "video", media: { mediaId: id, kind: "video", contentType: "video/mp4", sizeBytes: blob.size, etag: sha } } };
    expect(await readPrivateVideo(ready, { download: async () => blob }, () => true)).toBe(blob);
    await expect(readPrivateVideo(ready, { download: async () => new Blob(["different bytes"], { type: "video/mp4" }) }, () => true)).rejects.toThrow();
    ready.task.billingStatus = "pending_review"; await expect(readPrivateVideo(ready, { download: async () => blob }, () => true)).rejects.toThrow();
    expect(parseVideoReceipt({ id: key, accountId: "a", createdAt: 1, intent, quote: { ...quote, reservedCredits: -1 }, state: "accepted" })).toBeNull();
});

test("video draft persists complete platform selection, legacy settings and all 14 references without auto generation", async () => {
    const data = new Map<string, CreationMediaDraft>();
    const options = { getScope: () => scope, storage: () => ({ getItem: async (key: string) => data.get(key), setItem: async (key: string, value: CreationMediaDraft) => { data.set(key, structuredClone(value)); } }) };
    const store = createCreationMediaLaunchStore(options); await store.getState().load();
    const references = Array.from({ length: 14 }, (_, index) => ({ id: String(index), name: `图片${index}`, type: "image/png", dataUrl: "", storageKey: `image:${index}` }));
    const selection = { source: "platform-video" as const, modelId: intent.modelId, parameters, legacy: { videoModel: "old-personal-model", videoWatermark: "true" } };
    expect(await store.getState().edit({ kind: "video", prompt: intent.input.prompt, references, parameters: selection })).toBe(true);
    expect(await store.getState().stage("video")).toBe(false); expect(store.getState().drafts.video?.references).toHaveLength(14);
    expect(await store.getState().editPersonalParameter("video", "videoModel", "forged-personal", {})).toBe(false);
    const fresh = createCreationMediaLaunchStore(options); await fresh.getState().load();
    expect(fresh.getState().drafts.video?.parameters).toEqual(selection); expect(fresh.getState().pending).toBeNull();
    expect(videoReferenceIssue(13, selection)).toContain("12"); expect(videoReferenceIssue(8, selection)).toContain("7");
    expect(videoReferenceIssue(1, selection)).toContain("不支持参考");
    const firstFrame = { ...selection, parameters: { mode: "first_frame" as const, resolution: "720p" as const, durationSeconds: 5, generateAudio: false } };
    expect(videoReferenceIssue(2, firstFrame)).toContain("1张"); expect(videoReferenceIssue(1, firstFrame)).toBe("");
});

test("owner history returns video to legacy workbench route only with valid public video source", () => {
    const source = view(); const detail = parseHistoryDetail(source, id)!;
    expect(historyOriginTarget(detail, [])).toBe("/video");
    expect(parseHistoryDetail({ ...source, task: { ...source.task, video: { ...source.task.video, protocol: "private" } } }, id)).toBeNull();
    const noVideo = parseHistoryDetail({ ...source, task: { ...source.task, video: undefined } }, id)!;
    expect(historyOriginTarget(noVideo, [])).toBeNull();
});
