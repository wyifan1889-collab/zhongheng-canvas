import { describe, expect, test } from "bun:test";
import { insertGeneratedImage } from "./canvas-generated-image";
import type { GenerationTaskView } from "./generation";

const id = "68591890-0000-4000-9000-000000000001";
const blob = new Blob(["isolated bytes"], { type: "image/png" });
function fixture() {
    const view: GenerationTaskView = { task: { id, projectId: "canvas-a", modelId: "image-test", priceVersion: 1, quotedUnits: 7, executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured" },
        result: { taskId: id, status: "succeeded", resultSnapshot: { kind: "image", media: { mediaId: id, kind: "image", contentType: "image/png", sizeBytes: blob.size, etag: "fixture" } } } };
    const owned = { id, kind: "image" as const, contentType: "image/png", sizeBytes: blob.size, createdAt: new Date().toISOString(), url: `/api/v1/media/${id}` };
    let current = true, commits = 0;
    const revoked: string[] = [], images: unknown[] = [];
    const options = { view, media: { resolve: async (): Promise<{ items: typeof owned[]; missing: string[] }> => ({ items: [owned], missing: [] }), download: async () => blob },
        isCurrent: () => current, signal: new AbortController().signal,
        commit: (image: unknown) => { commits++; images.push(image); return true; },
        decode: async () => ({ width: 64, height: 48 }), createUrl: () => "blob:isolated", revokeUrl: (url: string) => revoked.push(url) };
    return { options, revoked, images, commits: () => commits, changeContext: () => { current = false; } };
}

test("a complete batch decodes all private images before one atomic canvas commit", async () => {
    const f = fixture(), ids = Array.from({ length: 4 }, (_, i) => `68591890-0000-4000-9000-00000000000${i + 1}`);
    f.options.view.task.imageSpecSnapshot = { status: "recorded", parameters: { size: "64x48", quality: "low", n: 4 } };
    f.options.view.result!.resultSnapshot.imageMedia = ids.map(mediaId => ({ ...f.options.view.result!.resultSnapshot.media!, mediaId }));
    f.options.media.resolve = async () => ({ items: ids.map(id => ({ id, kind: "image", contentType: "image/png", sizeBytes: blob.size, createdAt: new Date().toISOString(), url: "unused" })), missing: [] });
    let urls = 0;
    f.options.createUrl = () => `blob:batch-${++urls}`;
    expect(await insertGeneratedImage(f.options)).toBe(true);
    expect(f.commits()).toBe(1); expect((f.images[0] as any).images).toHaveLength(4); expect(f.revoked).toEqual([]);
    const bad = fixture();
    bad.options.view = structuredClone(f.options.view);
    bad.options.media.resolve = f.options.media.resolve;
    bad.options.createUrl = () => `blob:failed-${++urls}`;
    let decoded = 0;
    bad.options.decode = async () => { if (++decoded === 3) throw new Error("third image corrupt"); return { width: 64, height: 48 }; };
    await expect(insertGeneratedImage(bad.options)).rejects.toThrow("third image corrupt");
    expect(bad.commits()).toBe(0); expect(bad.revoked).toHaveLength(3);
});
describe("generated result insertion boundary (injected decoder, no browser or provider)", () => {
    test("commits an owned saved image with actual decoded ratio and transfers URL ownership", async () => {
        const f = fixture();
        expect(await insertGeneratedImage(f.options)).toBe(true);
        expect(f.images).toEqual([{ taskId: id, cloudMediaId: id, url: "blob:isolated", width: 64, height: 48, bytes: blob.size, mimeType: "image/png" }]);
        expect(f.revoked).toEqual([]);
    });
    test("account/project changed during download never decodes or inserts", async () => {
        const f = fixture(); let decoded = false;
        f.options.media.download = async () => { f.changeContext(); return blob; };
        f.options.decode = async () => { decoded = true; return { width: 64, height: 48 }; };
        await expect(insertGeneratedImage(f.options)).rejects.toThrow("已变化");
        expect(decoded).toBe(false); expect(f.commits()).toBe(0);
    });
    test("closed or changed context after decoding revokes the uncommitted URL", async () => {
        const f = fixture();
        f.options.decode = async () => { f.changeContext(); return { width: 64, height: 48 }; };
        await expect(insertGeneratedImage(f.options)).rejects.toThrow("已变化");
        expect(f.commits()).toBe(0); expect(f.revoked).toEqual(["blob:isolated"]);
    });
    test("failed decode is not replaced with made-up dimensions", async () => {
        const f = fixture(); f.options.decode = async () => { throw new Error("decode failed"); };
        await expect(insertGeneratedImage(f.options)).rejects.toThrow("decode failed");
        expect(f.commits()).toBe(0); expect(f.revoked).toEqual(["blob:isolated"]);
    });
    test("duplicate rejected by canvas releases new URL; incomplete delivery never downloads", async () => {
        const f = fixture(); f.options.commit = () => false;
        expect(await insertGeneratedImage(f.options)).toBe(false); expect(f.revoked).toEqual(["blob:isolated"]);
        const other = fixture(); other.options.view.task.deliveryStatus = "pending";
        let requested = false; other.options.media.download = async () => { requested = true; return blob; };
        await expect(insertGeneratedImage(other.options)).rejects.toThrow("尚未保存完成"); expect(requested).toBe(false);
    });
    test("wrong owner and mismatched bytes do not reach image decode", async () => {
        const f = fixture(); f.options.media.resolve = async () => ({ items: [], missing: [id] });
        await expect(insertGeneratedImage(f.options)).rejects.toThrow("核对未通过"); expect(f.commits()).toBe(0);
        const other = fixture(); other.options.media.download = async () => new Blob(["wrong"], { type: "image/png" });
        await expect(insertGeneratedImage(other.options)).rejects.toThrow("内容不完整"); expect(other.commits()).toBe(0);
    });
});
