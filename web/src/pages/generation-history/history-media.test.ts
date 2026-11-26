import { expect, test } from "bun:test";
import type { CloudMediaResolve } from "@/services/api/media";
import type { GenerationHistoryItem } from "@/services/saas/generation-history";
import type { HistoryDetail } from "@/services/saas/generation-history-detail";
import { createHistoryReader } from "./history-reader";

const id = "11111111-1111-4111-8111-111111111111";
const thumbnailId = "22222222-2222-4222-8222-222222222222";
const scope = { accountId: "history-media-owner", epoch: 1 };
const stamp = "2026-10-28T00:00:00.000Z";
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(kind: "audio" | "video") {
    const contentType = kind === "audio" ? "audio/wav" : "video/mp4";
    const blob = new Blob([`${kind}-content`], { type: contentType });
    const row: GenerationHistoryItem = { taskId: id, type: kind, displayModel: "historical-model", executionStatus: "succeeded",
        deliveryStatus: "saved", billingStatus: "captured", credits: "1", createdAt: stamp, updatedAt: stamp,
        result: { url: `/api/v1/media/${id}`, thumbnailUrl: `/api/v1/media/${thumbnailId}` } };
    const value: HistoryDetail = { task: { id, projectId: null, modelId: row.displayModel, priceVersion: 1, quotedUnits: 1,
        executionStatus: row.executionStatus, deliveryStatus: row.deliveryStatus, billingStatus: row.billingStatus }, result: null };
    const resolved = (): CloudMediaResolve => ({ items: [{ id, kind, contentType, sizeBytes: blob.size, createdAt: stamp, url: `/api/v1/media/${id}` }], missing: [] });
    const hooks = { resolve: async (): Promise<CloudMediaResolve> => resolved(), download: async (): Promise<Blob> => blob };
    const signals: AbortSignal[] = [], resolves: string[][] = [], downloads: string[] = [], allocated: Blob[] = [], revoked: string[] = [];
    let detailReads = 0;
    const reader = createHistoryReader({ scope, getScope: () => scope, onState: () => {}, client: {
        read: async () => ({ items: [row], total: 1, pageNumber: 1, pageSize: 50 }),
        detail: async () => { detailReads++; return value; },
    }, mediaClient: signal => {
        signals.push(signal);
        return {
            resolve: ids => { resolves.push(ids); return hooks.resolve(); },
            download: mediaId => { downloads.push(mediaId); return hooks.download(); },
        };
    }, createObjectURL: data => { allocated.push(data); return `blob:history-media-${allocated.length}`; }, revokeObjectURL: url => { revoked.push(url); } });
    return { reader, blob, resolved, hooks, signals, resolves, downloads, allocated, revoked, detailReads: () => detailReads };
}

for (const kind of ["audio", "video"] as const) {
    test(`${kind} loads only its resolved full media and verifies the downloaded Blob before exposing a URL`, async () => {
        const f = fixture(kind);
        await f.reader.read(); await f.reader.detail(id);
        expect(f.resolves).toEqual([]); expect(f.downloads).toEqual([]);
        await f.reader.preview(id);
        expect(f.resolves).toEqual([[id]]); // Audio/video never download the image thumbnail.
        expect(f.downloads).toEqual([id]); expect(f.allocated).toEqual([f.blob]);
        expect(f.reader.snapshot().previews[id]).toEqual({ status: "ready", url: "blob:history-media-1" });
        await f.reader.preview(id);
        expect(f.downloads).toEqual([id]);
        f.reader.dispose(); expect(f.revoked).toEqual(["blob:history-media-1"]);
    });

    test(`${kind} refuses missing, mismatched or ambiguous resolution metadata before downloading`, async () => {
        for (const fault of ["kind", "mime", "url", "missing", "duplicate"] as const) {
            const f = fixture(kind), metadata = f.resolved();
            if (fault === "kind") metadata.items[0]!.kind = kind === "audio" ? "video" : "audio";
            if (fault === "mime") metadata.items[0]!.contentType = "text/plain";
            if (fault === "url") metadata.items[0]!.url = `https://private.invalid/api/v1/media/${id}`;
            if (fault === "missing") metadata.missing.push(id);
            if (fault === "duplicate") metadata.items.push({ ...metadata.items[0]! });
            f.hooks.resolve = async () => metadata;
            await f.reader.read(); await f.reader.preview(id);
            expect(f.downloads).toEqual([]); expect(f.allocated).toEqual([]);
            expect(f.reader.snapshot().previews[id]?.status).toBe("error");
            expect(f.reader.snapshot().items).toHaveLength(1);
            f.reader.dispose();
        }
    });

    test(`${kind} rejects a downloaded Blob whose MIME or byte count differs from resolved metadata`, async () => {
        for (const fault of ["mime", "bytes"] as const) {
            const f = fixture(kind);
            f.hooks.download = async () => fault === "mime"
                ? new Blob([`${kind}-content`], { type: "text/plain" })
                : new Blob(["different-byte-count"], { type: f.blob.type });
            await f.reader.read(); await f.reader.preview(id);
            expect(f.downloads).toEqual([id]); expect(f.allocated).toEqual([]);
            expect(f.reader.snapshot().previews[id]?.status).toBe("error");
            f.reader.dispose();
        }
    });

    test(`${kind} closing a ready detail revokes its URL and reopening explicitly reads fresh media`, async () => {
        const f = fixture(kind);
        await f.reader.read(); await f.reader.detail(id); await f.reader.preview(id);
        f.reader.closeDetail();
        expect(f.reader.snapshot().detail).toBeUndefined(); expect(f.reader.snapshot().previews[id]).toBeUndefined();
        expect(f.revoked).toEqual(["blob:history-media-1"]);
        f.reader.closeDetail(); expect(f.revoked).toHaveLength(1);
        await f.reader.detail(id); await f.reader.preview(id);
        expect(f.detailReads()).toBe(2); expect(f.resolves).toEqual([[id], [id]]); expect(f.downloads).toEqual([id, id]);
        expect(f.reader.snapshot().previews[id]?.url).toBe("blob:history-media-2");
        f.reader.dispose(); expect(f.revoked).toEqual(["blob:history-media-1", "blob:history-media-2"]);
    });

    test(`${kind} closing aborts a pending download and its late Blob cannot replace a reopened detail`, async () => {
        const f = fixture(kind), old = deferred<Blob>(), started = deferred<void>();
        f.hooks.download = () => { started.resolve(); return old.promise; };
        await f.reader.read(); await f.reader.detail(id);
        const pending = f.reader.preview(id); await started.promise;
        f.reader.closeDetail();
        expect(f.signals[0]?.aborted).toBe(true);
        expect(f.reader.snapshot().detail).toBeUndefined(); expect(f.reader.snapshot().previews[id]).toBeUndefined();
        f.hooks.download = async () => f.blob;
        await f.reader.detail(id); await f.reader.preview(id);
        expect(f.signals[1]?.aborted).toBe(false);
        old.resolve(f.blob); await pending; // The old transport deliberately ignores cancellation.
        expect(f.allocated).toEqual([f.blob]); expect(f.revoked).toEqual([]);
        expect(f.reader.snapshot().detail?.status).toBe("ready");
        expect(f.reader.snapshot().previews[id]).toEqual({ status: "ready", url: "blob:history-media-1" });
        expect(f.downloads).toEqual([id, id]);
        f.reader.dispose(); expect(f.revoked).toEqual(["blob:history-media-1"]);
    });
}
