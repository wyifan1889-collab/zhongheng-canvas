import { expect, test } from "bun:test";
import { insertGeneratedImage } from "./canvas-generated-image";
import type { GenerationTaskView } from "./generation";

const id = "11111111-1111-4111-8111-111111111111";
function fixture() {
    const blob = new Blob(["synthetic bytes; injected decoder"], { type: "image/png" }), revoked: string[] = [];
    const view: GenerationTaskView = { task: { id, projectId: "canvas", modelId: "image", priceVersion: 1, quotedUnits: 7,
        imageSpecSnapshot: { status: "recorded", protocol: "openai-image-v1", parameters: { size: "64x48", quality: "low" } }, executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured" },
        result: { taskId: id, status: "succeeded", resultSnapshot: { kind: "image", media: { mediaId: id, kind: "image", contentType: "image/png", sizeBytes: blob.size, etag: "synthetic" } } } };
    const media = { resolve: async () => ({ items: [{ id, kind: "image" as const, contentType: "image/png", sizeBytes: blob.size, createdAt: "2026-10-25T00:00:00Z", url: `/api/v1/media/${id}` }], missing: [] }), download: async () => blob };
    return { view, media, revoked, isCurrent: () => true, signal: new AbortController().signal, decode: async () => ({ width: 64, height: 48 }), createUrl: () => "blob:synthetic", revokeUrl: (url: string) => { revoked.push(url); } };
}

test("I3b media URL ownership waits for the asynchronous canvas receipt and persistence commit", async () => {
    const f = fixture(); let enter!: () => void, finish!: (value: boolean) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), commit = new Promise<boolean>(resolve => { finish = resolve; });
    const result = insertGeneratedImage({ ...f, commit: async () => { enter(); return commit; } });
    await entered; expect(f.revoked).toEqual([]); finish(true);
    expect(await result).toBe(true); expect(f.revoked).toEqual([]);
});

test("I3b a context lost during asynchronous application returns URL ownership and never commits", async () => {
    const f = fixture(); let current = true, enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), waiting = new Promise<void>(resolve => { finish = resolve; });
    const result = insertGeneratedImage({ ...f, isCurrent: () => current, commit: async () => { enter(); await waiting; return current; } });
    await entered; current = false; finish();
    expect(await result).toBe(false); expect(f.revoked).toEqual(["blob:synthetic"]);
});

test("I3b original specification dimensions and invalid history gate private result application", async () => {
    const f = fixture(); let commits = 0;
    await expect(insertGeneratedImage({ ...f, decode: async () => ({ width: 48, height: 64 }), commit: () => { commits++; return true; } })).rejects.toThrow("原规格尺寸不一致");
    expect(commits).toBe(0); expect(f.revoked).toEqual(["blob:synthetic"]);
    const invalid = fixture(); invalid.view.task.imageSpecSnapshot = { status: "invalid" }; let resolved = false;
    await expect(insertGeneratedImage({ ...invalid, media: { ...invalid.media, resolve: async () => { resolved = true; return { items: [], missing: [] }; } }, commit: () => true })).rejects.toThrow("原图片规格未通过核对");
    expect(resolved).toBe(false); expect(invalid.revoked).toEqual([]);
});
