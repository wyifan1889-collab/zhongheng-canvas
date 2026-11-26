import { expect, test } from "bun:test";
import { CloudMediaError, type CloudMediaResolve } from "@/services/api/media";
import { GenerationError } from "@/services/saas/generation";
import type { GenerationHistoryItem, GenerationHistoryQuery, GenerationHistoryResponse, GenerationHistoryScope } from "@/services/saas/generation-history";
import { createHistoryReader, historyMediaId, type HistoryState } from "./history-reader";
import { generationImageMediaId } from "../../../../apps/api/src/generation-image";
import type { HistoryDetail } from "@/services/saas/generation-history-detail";

const mediaId = "11111111-1111-4111-8111-111111111111";
const scope: GenerationHistoryScope = { accountId: "history-account", epoch: 1 };
const blob = new Blob(["png"], { type: "image/png" });
const row = (taskId = mediaId): GenerationHistoryItem => ({ taskId, type: "image", displayModel: "original-model", executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", credits: "0.000001", createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z", result: { url: `/api/v1/media/${mediaId}` } });
const page = (items = [row()], total = items.length, pageNumber = 1): GenerationHistoryResponse => ({ items, total, pageNumber, pageSize: 50 });
const resolved = (): CloudMediaResolve => ({ items: [{ id: mediaId, kind: "image", contentType: "image/png", sizeBytes: blob.size, createdAt: row().createdAt, url: `/api/v1/media/${mediaId}` }], missing: [] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

function fixture() {
    const current = { scope: { ...scope } as GenerationHistoryScope | null };
    const calls: Array<{ query: GenerationHistoryQuery; signal?: AbortSignal }> = [], mediaSignals: AbortSignal[] = [], downloads: string[] = [], publications: HistoryState[] = [], created: string[] = [], revoked: string[] = [];
    const hooks = {
        read: async (_query: GenerationHistoryQuery, _signal?: AbortSignal) => page(),
        resolve: async (_ids: string[]): Promise<CloudMediaResolve> => resolved(),
        download: async (_id: string): Promise<Blob> => blob,
        createUrl: (_value: Blob) => `blob:history-${created.length + 1}`,
    };
    const reader = createHistoryReader({ scope, getScope: () => current.scope, onState: (state) => publications.push(state),
        client: { read: (query = {}, signal) => { calls.push({ query: { ...query }, signal }); return hooks.read(query, signal); } },
        mediaClient: (signal) => { mediaSignals.push(signal); return { resolve: (ids) => hooks.resolve(ids), download: (id) => { downloads.push(id); return hooks.download(id); } }; },
        createObjectURL: (value) => { const url = hooks.createUrl(value); created.push(url); return url; }, revokeObjectURL: (url) => { revoked.push(url); },
    });
    return { reader, current, calls, mediaSignals, downloads, publications, hooks, created, revoked };
}

test("reader does no work before an explicit read and fixes page size to 50", async () => {
    const f = fixture();
    expect(f.calls).toHaveLength(0); expect(f.created).toHaveLength(0);
    await f.reader.read();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].query).toEqual({ pageNumber: 1, pageSize: 50 });
    expect(f.reader.snapshot().items).toEqual([row()]);
    expect(f.downloads).toHaveLength(0);
});

test("repeated refresh clicks share the pending query and a later refresh is still available", async () => {
    const f = fixture(), wait = deferred<GenerationHistoryResponse>();
    f.hooks.read = () => wait.promise;
    const request = f.reader.read();
    await f.reader.read(); await f.reader.read({ pageNumber: 1, pageSize: 50 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].signal?.aborted).toBe(false);
    wait.resolve(page()); await request;
    await f.reader.read();
    expect(f.calls).toHaveLength(2);
    expect(f.reader.snapshot().phase).toBe("ready");
});

test("a pending manual retry retains its error and rows until the successful response", async () => {
    const f = fixture(); await f.reader.read();
    f.hooks.read = async () => { throw new Error("read-failed"); };
    await f.reader.read();
    const wait = deferred<GenerationHistoryResponse>(); f.hooks.read = () => wait.promise;
    const retry = f.reader.read();
    expect(f.reader.snapshot().phase).toBe("loading");
    expect(f.reader.snapshot().error).toBe("readFailed");
    expect(f.reader.snapshot().items).toEqual([row()]);
    await f.reader.read(); expect(f.calls).toHaveLength(3);
    wait.resolve(page()); await retry;
    expect(f.reader.snapshot().error).toBeUndefined();
});

test("same-scope later page wins even when the old transport ignores its aborted signal", async () => {
    const f = fixture(), old = deferred<GenerationHistoryResponse>(), latest = deferred<GenerationHistoryResponse>();
    f.hooks.read = (query) => query.pageNumber === 1 ? old.promise : latest.promise;
    const first = f.reader.read(), second = f.reader.read({ pageNumber: 2 });
    expect(f.calls[0].signal?.aborted).toBe(true);
    const newer = { ...row(), displayModel: "page-two" };
    latest.resolve(page([newer], 80, 2)); await second;
    old.resolve(page([{ ...row(), displayModel: "stale-first" }], 900)); await first;
    expect(f.reader.snapshot().items).toEqual([newer]);
    expect(f.reader.snapshot().total).toBe(80);
    expect(f.reader.snapshot().query.pageNumber).toBe(2);
});

test("a stale filter error cannot replace a newer filter response", async () => {
    const f = fixture(), old = deferred<GenerationHistoryResponse>();
    f.hooks.read = (query) => query.type === "image" ? old.promise : Promise.resolve(page([{ ...row(), type: "text", result: null }], 1));
    const first = f.reader.read({ pageNumber: 1, type: "image", status: "succeeded" });
    await f.reader.read({ pageNumber: 1, type: "text", status: "failed" });
    old.reject(new Error("old-filter-error")); await first;
    expect(f.reader.snapshot().phase).toBe("ready");
    expect(f.reader.snapshot().query.type).toBe("text");
    expect(f.reader.snapshot().error).toBeUndefined();
    expect(f.reader.snapshot().items[0].type).toBe("text");
});

test("filter/page changes clear old rows and revoke their Blob before the next list reply", async () => {
    const f = fixture(); await f.reader.read(); await f.reader.preview(mediaId);
    expect(f.reader.snapshot().previews[mediaId].url).toBe("blob:history-1");
    const wait = deferred<GenerationHistoryResponse>(); f.hooks.read = () => wait.promise;
    const next = f.reader.read({ pageNumber: 1, type: "audio", status: "queued" });
    expect(f.revoked).toEqual(["blob:history-1"]);
    expect(f.reader.snapshot().items).toEqual([]);
    expect(f.reader.snapshot().total).toBe(0);
    expect(f.reader.snapshot().previews).toEqual({});
    wait.resolve(page([], 0)); await next;
});

test("ordinary refresh failure retains same-scope rows and never retries itself", async () => {
    const f = fixture(); await f.reader.read(); await f.reader.preview(mediaId);
    f.hooks.read = async () => { throw new GenerationError("unconfirmed", "private-upstream-error", "not-sent", 503); };
    await f.reader.read();
    expect(f.reader.snapshot().phase).toBe("error");
    expect(f.reader.snapshot().error).toBe("readFailed");
    expect(f.reader.snapshot().items).toEqual([row()]);
    expect(f.reader.snapshot().total).toBe(1);
    expect(f.calls).toHaveLength(2);
    expect(f.revoked).toEqual(["blob:history-1"]);
});

test("service-disabled code stays distinct from generic failed reads", async () => {
    const f = fixture();
    f.hooks.read = async () => { throw new GenerationError("generation_unavailable", "disabled", "not-sent", 503); };
    await f.reader.read();
    expect(f.reader.snapshot().error).toBe("serviceUnavailable");
    expect(f.reader.snapshot().items).toEqual([]);
});

test("list authentication refusals block old rows and total even before the account store changes", async () => {
    for (const [code, status] of [["unauthorized", 401], ["account_changed", 409], ["account_context_required", 400]] as const) {
        const f = fixture(); await f.reader.read(); await f.reader.preview(mediaId);
        f.hooks.read = async () => { throw new GenerationError(code, "confirm login", "not-sent", status); };
        await f.reader.read();
        expect(f.reader.snapshot().error).toBe("accountChanged");
        expect(f.reader.snapshot().items).toEqual([]); expect(f.reader.snapshot().total).toBe(0);
        expect(f.revoked).toEqual(["blob:history-1"]);
        await f.reader.read(); expect(f.calls).toHaveLength(2);
    }
});

test("a scope change hides old rows synchronously and aborts a pending image download", async () => {
    for (const next of [null, { accountId: "other-account", epoch: 1 }, { ...scope, epoch: 2 }]) {
        const f = fixture(), wait = deferred<Blob>(); await f.reader.read();
        f.hooks.download = () => wait.promise;
        const preview = f.reader.preview(mediaId); await Promise.resolve();
        f.current.scope = next;
        expect(f.reader.snapshot().items).toEqual([]); expect(f.reader.snapshot().total).toBe(0);
        f.reader.syncScope();
        expect(f.mediaSignals[0].aborted).toBe(true);
        wait.resolve(blob); await preview;
        expect(f.created).toEqual([]);
        expect(f.reader.snapshot().items).toEqual([]);
    }
});

test("scope change revokes ready Blobs and an old list reply cannot restore them", async () => {
    const f = fixture(); await f.reader.read(); await f.reader.preview(mediaId);
    const wait = deferred<GenerationHistoryResponse>(); f.hooks.read = () => wait.promise;
    const request = f.reader.read({ pageNumber: 2 });
    f.current.scope = { ...scope, epoch: 2 }; f.reader.syncScope();
    expect(f.calls[1].signal?.aborted).toBe(true);
    wait.resolve(page([row()], 500, 2)); await request;
    expect(f.revoked).toEqual(["blob:history-1"]);
    expect(f.reader.snapshot().total).toBe(0);
});

test("exact private URL validation rejects external, encoded, suffixed and query paths without media I/O", async () => {
    for (const url of [`https://same.invalid/api/v1/media/${mediaId}`, `//same.invalid/api/v1/media/${mediaId}`, `/api/v1/media/${mediaId}?token=x`, `/api/v1/media/${mediaId}#x`, `/api/v1/media/${mediaId}/extra`, `/api/v1/media/%31${mediaId.slice(1)}`, `/api/v1/media/../${mediaId}`]) {
        expect(historyMediaId(url)).toBeNull();
        const f = fixture(); f.hooks.read = async () => page([{ ...row(), result: { url } }]);
        await f.reader.read(); await f.reader.preview(mediaId);
        expect(f.mediaSignals).toHaveLength(0); expect(f.downloads).toHaveLength(0);
        expect(f.reader.snapshot().items).toHaveLength(1);
        expect(f.reader.snapshot().previews[mediaId].status).toBe("error");
    }
});

test("history preview accepts the deterministic second-image media ID", async () => {
    const id = generationImageMediaId(mediaId, 1), url = `/api/v1/media/${id}`, f = fixture();
    expect(historyMediaId(url)).toBe(id);
    f.hooks.read = async () => page([{ ...row(), result: { url } }]);
    f.hooks.resolve = async ids => { expect(ids).toEqual([id]); return { items: [{ ...resolved().items[0], id, url }], missing: [] }; };
    await f.reader.read(); await f.reader.preview(mediaId);
    expect(f.reader.snapshot().previews[mediaId].status).toBe("ready"); expect(f.downloads).toEqual([id]);
});

test("multi-image detail opens each full owner-verified image and rejects IDs outside the task", async () => {
    const cover = row(), second = generationImageMediaId(mediaId, 1), thumbnail = crypto.randomUUID();
    const ids: string[] = [], revoked: string[] = [];
    cover.result!.thumbnailUrl = `/api/v1/media/${thumbnail}`;
    const assets = [mediaId, second].map(id => ({ mediaId: id, kind: "image" as const, contentType: "image/png", sizeBytes: blob.size, etag: "example-etag" }));
    const detail: HistoryDetail = { task: { id: mediaId, modelId: cover.displayModel, projectId: null, priceVersion: null, quotedUnits: null,
        executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured" },
        result: { taskId: mediaId, status: "succeeded", resultSnapshot: { kind: "image", media: assets[0], imageMedia: assets } } };
    const reader = createHistoryReader({ scope, getScope: () => scope, onState: () => {},
        client: { read: async () => page([cover]), detail: async () => detail },
        mediaClient: () => ({ resolve: async ([id]) => ({ items: [{ ...resolved().items[0]!, id: id!, url: `/api/v1/media/${id}` }], missing: [] }),
            download: async id => { ids.push(id); return blob; } }),
        createObjectURL: () => `blob:original-${ids.length}`, revokeObjectURL: url => revoked.push(url) });
    await reader.read();
    await reader.preview(mediaId, second); // Not selectable from the cover row alone.
    await reader.preview(mediaId);
    await reader.detail(mediaId);
    await reader.preview(mediaId, thumbnail);
    await reader.preview(mediaId, second);
    expect(ids).toEqual([mediaId, second]);
    expect(reader.snapshot().previews[mediaId]).toMatchObject({ imageId: second, imageExtension: "png", url: "blob:original-2" });
    reader.previewFailed(mediaId, "blob:original-1");
    expect(reader.snapshot().previews[mediaId]?.status).toBe("ready");
    reader.closeDetail();
    expect(revoked).toEqual(["blob:original-1", "blob:original-2"]);
    reader.dispose();
});

test("image media failure retains the row and a manual preview retry only repeats readonly media access", async () => {
    const f = fixture(); await f.reader.read();
    f.hooks.download = async () => { throw new CloudMediaError("unavailable", "read failed"); };
    await f.reader.preview(mediaId);
    expect(f.reader.snapshot().previews[mediaId].status).toBe("error");
    expect(f.reader.snapshot().items).toHaveLength(1);
    f.hooks.download = async () => blob; await f.reader.preview(mediaId);
    expect(f.reader.snapshot().previews[mediaId].status).toBe("ready");
    expect(f.calls).toHaveLength(1); expect(f.downloads).toEqual([mediaId, mediaId]);
});

test("wrong kind, ownership, content type or byte count never produces a Blob URL", async () => {
    for (const kind of ["wrong-kind", "missing", "wrong-url", "mime", "bytes"]) {
        const f = fixture(); await f.reader.read();
        if (kind === "wrong-kind") f.hooks.resolve = async () => ({ ...resolved(), items: [{ ...resolved().items[0], kind: "video" }] });
        if (kind === "missing") f.hooks.resolve = async () => ({ items: [], missing: [mediaId] });
        if (kind === "wrong-url") f.hooks.resolve = async () => ({ ...resolved(), items: [{ ...resolved().items[0], url: "https://private.invalid/image" }] });
        if (kind === "mime") f.hooks.download = async () => new Blob(["png"], { type: "text/plain" });
        if (kind === "bytes") f.hooks.download = async () => new Blob(["not-the-same-length"], { type: "image/png" });
        await f.reader.preview(mediaId);
        expect(f.created).toEqual([]);
        expect(f.reader.snapshot().previews[mediaId].status).toBe("error");
    }
});

test("media auth refusal, including download's unavailable plus 401, blocks the complete old scope", async () => {
    for (const stage of ["resolve", "download"]) {
        const f = fixture(); await f.reader.read();
        if (stage === "resolve") f.hooks.resolve = async () => { throw new CloudMediaError("account_changed", "changed", 409); };
        else f.hooks.download = async () => { throw new CloudMediaError("unavailable", "changed", 401); };
        await f.reader.preview(mediaId);
        expect(f.reader.snapshot().error).toBe("accountChanged");
        expect(f.reader.snapshot().items).toEqual([]); expect(f.reader.snapshot().total).toBe(0);
        await f.reader.read(); expect(f.calls).toHaveLength(1);
    }
});

test("a scope change during object URL allocation immediately revokes the allocated URL", async () => {
    const f = fixture(); await f.reader.read();
    f.hooks.createUrl = () => { f.current.scope = null; return "blob:allocated-during-change"; };
    await f.reader.preview(mediaId);
    expect(f.revoked).toEqual(["blob:allocated-during-change"]);
    expect(f.reader.snapshot().items).toEqual([]);
});

test("dispose cancels preview reads, revokes ready URLs, and suppresses delayed publications", async () => {
    const f = fixture(); await f.reader.read(); await f.reader.preview(mediaId);
    f.reader.previewFailed(mediaId);
    expect(f.revoked).toEqual(["blob:history-1"]);
    const wait = deferred<CloudMediaResolve>(); f.hooks.resolve = () => wait.promise;
    const request = f.reader.preview(mediaId), publications = f.publications.length;
    f.reader.dispose(); expect(f.mediaSignals.at(-1)?.aborted).toBe(true);
    wait.resolve(resolved()); await request;
    expect(f.publications).toHaveLength(publications);
    expect(f.created).toHaveLength(1);
});

test("lifecycle unit representation creates a fresh reader after cleanup; this is not a DOM StrictMode mount", async () => {
    const first = fixture(), second = fixture(), stale = deferred<GenerationHistoryResponse>();
    first.hooks.read = () => stale.promise;
    const old = first.reader.read(); first.reader.dispose();
    await second.reader.read();
    expect(second.reader.snapshot().phase).toBe("ready");
    expect(first.calls[0].signal?.aborted).toBe(true);
    const oldPublications = first.publications.length;
    stale.resolve(page([{ ...row(), displayModel: "disposed-first-setup" }], 400)); await old;
    expect(first.publications).toHaveLength(oldPublications);
    expect(second.reader.snapshot().items[0].displayModel).toBe("original-model");
});

test("production media adapter reuses resolve/download with account headers and the same cancellable signal", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input); calls.push({ path, init });
        return path.endsWith("/resolve") ? Response.json(resolved()) : new Response(blob);
    }, { preconnect: originalFetch.preconnect });
    const reader = createHistoryReader({ scope, getScope: () => scope, onState: () => {}, client: { read: async () => page() }, createObjectURL: () => "blob:actual-media-adapter", revokeObjectURL: () => {} });
    try {
        await reader.read(); await reader.preview(mediaId);
        expect(calls.map((call) => call.path)).toEqual(["/api/v1/media/resolve", `/api/v1/media/${mediaId}`]);
        expect(calls[0].init?.method).toBe("POST");
        expect(calls[1].init?.method ?? "GET").toBe("GET");
        expect(calls[0].init?.signal).toBe(calls[1].init?.signal);
        for (const call of calls) {
            expect(call.init?.signal).toBeInstanceOf(AbortSignal);
            expect(call.init?.credentials).toBe("same-origin");
            expect(new Headers(call.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
        }
        expect(reader.snapshot().previews[mediaId]).toEqual({ status: "ready", url: "blob:actual-media-adapter", imageId: mediaId, imageExtension: "png" });
    } finally { reader.dispose(); globalThis.fetch = originalFetch; }
});
