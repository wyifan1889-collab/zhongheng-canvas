import { describe, expect, test } from "bun:test";
import { createMediaClient } from "../api/media";
import { insertCanvasAssetImage, readCloudAssetData } from "./canvas-asset-insert";

const id = "68591890-0000-4000-9000-000000000001";
const blob = new Blob(["synthetic image bytes"], { type: "image/png" });
const stored = { url: "blob:synthetic", storageKey: "image:synthetic", width: 64, height: 48, bytes: blob.size, mimeType: blob.type };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
function context() {
    const captured = { accountId: "owner-a", epoch: 1, project: {}, window: {} };
    let current = { ...captured };
    return { isCurrent: () => current.accountId === captured.accountId && current.epoch === captured.epoch &&
        current.project === captured.project && current.window === captured.window,
    change: (patch: Partial<typeof captured>) => { current = { ...current, ...patch }; } };
}

describe("cloud asset selection handoff (real media client, injected conversion/preparation, no React/IDB)", () => {
    for (const change of ["closed and reopened", "account epoch changed"] as const) {
        test(`late download after ${change} never reaches conversion or insertion`, async () => {
            const c = context(), response = deferred<Response>(); let encoded = 0, inserted = 0;
            const client = createMediaClient(() => "owner-a", async (_path, init) => {
                expect(init?.credentials).toBe("same-origin");
                expect(new Headers(init?.headers).get("x-canvas-account-id")).toBe("owner-a");
                return response.promise;
            });
            const pending = readCloudAssetData({ mediaId: id, isCurrent: c.isCurrent, download: client.download,
                toDataUrl: async () => { encoded++; return "data:image/png;base64,c3ludGhldGlj"; } }).then(() => { inserted++; }, () => {});
            c.change(change === "closed and reopened" ? { window: {} } : { epoch: 2 });
            response.resolve(new Response(blob)); await pending;
            expect(encoded).toBe(0); expect(inserted).toBe(0);
        });
    }
    test("closing during asynchronous data conversion does not hand the result to the canvas", async () => {
        const c = context(), conversion = deferred<string>(), entered = deferred<void>(); let inserted = 0;
        const pending = readCloudAssetData({ mediaId: id, isCurrent: c.isCurrent, download: async () => blob,
            toDataUrl: () => { entered.resolve(); return conversion.promise; } }).then(() => { inserted++; }, () => {});
        await entered.promise; c.change({ window: {} }); conversion.resolve("data:image/png;base64,c3ludGhldGlj"); await pending;
        expect(inserted).toBe(0);
    });
    test("unchanged context preserves media data and original local-image metadata", async () => {
        const c = context(); const committed: unknown[] = [];
        const dataUrl = await readCloudAssetData({ mediaId: id, isCurrent: c.isCurrent, download: async () => blob,
            toDataUrl: async (value) => { expect(value).toBe(blob); return "data:image/png;base64,c3ludGhldGlj"; } });
        await insertCanvasAssetImage({ image: { dataUrl }, isCurrent: c.isCurrent, upload: async () => stored,
            ensurePreview: async (key) => { expect(key).toBe(stored.storageKey); }, readMeta: async () => { throw new Error("unexpected metadata read"); },
            commit: (image) => committed.push(image) });
        expect(committed).toEqual([stored]);
    });
    test("existing local image still inserts without a cloud account or another upload", async () => {
        const committed: unknown[] = [];
        await insertCanvasAssetImage({ image: { dataUrl: stored.url, storageKey: stored.storageKey }, isCurrent: () => true,
            upload: async () => { throw new Error("unexpected upload"); }, ensurePreview: async () => {},
            readMeta: async () => ({ width: 64, height: 48 }), commit: (image) => committed.push(image) });
        expect(committed).toEqual([{ ...stored, bytes: 0 }]);
    });
    for (const stage of ["upload", "preview", "metadata"] as const) {
        test(`project remount during ${stage} never commits to either canvas`, async () => {
            const c = context(), entered = deferred<void>(), release = deferred<void>(); let commits = 0;
            const pause = async () => { entered.resolve(); await release.promise; };
            const pending = insertCanvasAssetImage({ image: { dataUrl: "data:image/png;base64,c3ludGhldGlj", ...(stage === "metadata" ? { storageKey: stored.storageKey } : {}) },
                isCurrent: c.isCurrent, upload: async () => { if (stage === "upload") await pause(); return stored; },
                ensurePreview: async () => { if (stage === "preview") await pause(); },
                readMeta: async () => { await pause(); return { width: 64, height: 48 }; }, commit: () => { commits++; } }).catch(() => {});
            await entered.promise; c.change({ project: {} }); release.resolve(); await pending;
            expect(commits).toBe(0);
        });
    }
    test("picker guard remains effective after handoff while canvas image upload is pending", async () => {
        const c = context(); let commits = 0;
        await expect(insertCanvasAssetImage({ image: { dataUrl: "data:image/png;base64,c3ludGhldGlj" }, isCurrent: c.isCurrent,
            upload: async () => { c.change({ window: {} }); return stored; }, ensurePreview: async () => {},
            readMeta: async () => ({ width: 64, height: 48 }), commit: () => { commits++; } })).rejects.toThrow("已变化");
        expect(commits).toBe(0);
    });
});
