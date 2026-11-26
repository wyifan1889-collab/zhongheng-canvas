import { expect, test } from "bun:test";
import { hydrateCanvasCloudMediaDocument, CloudMediaHydrationError } from "./cloud-media-hydration";
import type { JsonObject } from "../../../../packages/shared/src/index";

const imageId = "11111111-1111-4111-8111-111111111111";
const audioId = "22222222-2222-4222-8222-222222222222";
const base = (): JsonObject => ({
    id: "project", title: "云稿", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [{ id: "image", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { cloudMediaId: imageId, content: "blob:stale-preview-after-refresh" } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});

function item(id: string, kind: "image" | "audio" = "image", sizeBytes = 1) {
    return { id, kind, contentType: kind === "image" ? "image/png" : "audio/mpeg", sizeBytes, createdAt: "2026-01-01T00:00:00.000Z", url: `/api/v1/media/${id}` };
}

test("resolves and hydrates node media while retaining the durable cloudMediaId", async () => {
    const calls: string[] = [];
    const result = await hydrateCanvasCloudMediaDocument(base(), {
        async resolve(ids) { expect(ids).toEqual([imageId]); return { items: [item(imageId, "image", 5)], missing: [] }; },
        async download(id) { calls.push(id); return new Blob(["image"], { type: "image/png" }); },
    }, (blob) => `blob:hydrated-${blob.size}`);
    expect(calls).toEqual([imageId]);
    expect((result.document.nodes as any[])[0].metadata).toEqual({ cloudMediaId: imageId, content: "blob:hydrated-5" });
    expect(result.objectUrls).toEqual(["blob:hydrated-5"]);
});

test("hydrates assistant references through dataUrl and deduplicates downloads", async () => {
    const body = base();
    (body.chatSessions as any[]).push({ id: "chat", title: "对话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messages: [{ id: "message", role: "user", text: "x", references: [{ id: "ref", type: "image", title: "图片", cloudMediaId: imageId, dataUrl: "placeholder" }] }] });
    (body.nodes as any[])[0].metadata = { cloudMediaId: imageId, content: "placeholder" };
    let downloads = 0;
    const result = await hydrateCanvasCloudMediaDocument(body, {
        async resolve(ids) { expect(ids).toEqual([imageId]); return { items: [item(imageId)], missing: [] }; },
        async download() { downloads++; return new Blob(["x"], { type: "image/png" }); },
    }, () => `blob:shared-${downloads + 1}`);
    expect(downloads).toBe(1);
    expect((result.document.chatSessions as any[])[0].messages[0].references[0].dataUrl).toBe("blob:shared-2");
});

test("missing media never returns a partial document", async () => {
    await expect(hydrateCanvasCloudMediaDocument(base(), {
        async resolve() { return { items: [], missing: [imageId] }; },
        async download() { throw new Error("must not download"); },
    })).rejects.toBeInstanceOf(CloudMediaHydrationError);
});

test("a failed download revokes already created object URLs", async () => {
    const revoked: string[] = [];
    const body = base();
    (body.nodes as any[]).push({ id: "audio", type: "audio", title: "音频", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { cloudMediaId: audioId, content: "placeholder" } });
    await expect(hydrateCanvasCloudMediaDocument(body, {
        async resolve() { return { items: [item(imageId), item(audioId, "audio")], missing: [] }; },
        async download(id) { if (id === audioId) throw new Error("private media unavailable"); return new Blob(["x"], { type: "image/png" }); },
    }, () => "blob:first", (url) => revoked.push(url))).rejects.toBeInstanceOf(CloudMediaHydrationError);
    expect(revoked).toEqual(["blob:first"]);
});

for (const mismatch of ["size", "content-type"] as const) {
    test(`a ${mismatch} mismatch rejects the entire document and revokes prior media`, async () => {
        const body = base();
        (body.nodes as any[]).push({ id: "audio", type: "audio", title: "音频", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { cloudMediaId: audioId, content: "placeholder" } });
        const original = structuredClone(body);
        const downloads: string[] = [];
        const revoked: string[] = [];
        let created = 0;
        await expect(hydrateCanvasCloudMediaDocument(body, {
            async resolve() { return { items: [item(imageId), item(audioId, "audio")], missing: [] }; },
            async download(id) {
                downloads.push(id);
                return id === imageId ? new Blob(["x"], { type: "image/png" })
                    : new Blob([mismatch === "size" ? "xx" : "x"], { type: mismatch === "size" ? "audio/mpeg" : "image/png" });
            },
        }, () => `blob:valid-${++created}`, (url) => revoked.push(url))).rejects.toMatchObject({ code: "download_failed" });
        expect(downloads).toEqual([imageId, audioId]);
        expect(created).toBe(1);
        expect(revoked).toEqual(["blob:valid-1"]);
        expect(body).toEqual(original);
    });
}
