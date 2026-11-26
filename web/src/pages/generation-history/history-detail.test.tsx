import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import "@/i18n";
import { createGenerationHistoryClient, type GenerationHistoryItem, type GenerationHistoryScope } from "@/services/saas/generation-history";
import { historyOriginTarget, parseHistoryDetail, type HistoryDetail } from "@/services/saas/generation-history-detail";
import { GenerationError } from "@/services/saas/generation";
import { createHistoryReader } from "./history-reader";
import { HistoryDetailBody } from "./index";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-111111111111", other = "aaaaaaaa-aaaa-4aaa-8aaa-222222222222";
const scope = { accountId: "records-owner", epoch: 1 };
const detail = (task = {}): HistoryDetail => ({ task: { id, projectId: "original-project", nodeId: "original-node", modelId: "original-model", priceVersion: 2,
    quotedUnits: 7, executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review", ...task }, result: null });
const row = (taskId = id): GenerationHistoryItem => ({ taskId, type: "image", displayModel: "original-model", executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review",
    credits: "0", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z", result: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("owner detail GET uses real task path, no project guess, write, quote or retry", async () => {
    const calls: RequestInit[] = [], abort = new AbortController();
    const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: (async (path: RequestInfo | URL, init?: RequestInit) => {
        expect(String(path)).toBe(`/api/v1/generation/tasks/${id}`); calls.push(init!); return Response.json(detail());
    }) as unknown as typeof fetch });
    expect(await client.detail(id, abort.signal)).toEqual(detail());
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ method: "GET", credentials: "same-origin", signal: abort.signal });
    expect(new Headers(calls[0].headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(calls[0].body).toBeUndefined();
    await expect(client.detail("../other")).rejects.toMatchObject({ code: "invalid_input" }); expect(calls).toHaveLength(1);
});

test("detail projects only public fields, preserves missing snapshots, rejects mismatched identities and malformed amounts", () => {
    const source = { ...detail(), privateProvider: "hidden", task: { ...detail().task, providerKey: "hidden" } };
    expect(parseHistoryDetail(source, id)).toEqual(detail());
    expect(parseHistoryDetail(source, other)).toBeNull();
    expect(parseHistoryDetail({ ...detail(), result: { taskId: other, status: "succeeded", resultSnapshot: {} } }, id)).toBeNull();
    expect(parseHistoryDetail(detail({ billing: { reservedCredits: "7", capturedCredits: 0, releasedCredits: "0" } }), id)).toBeNull();
    expect(parseHistoryDetail(detail({ imageSpecSnapshot: { status: "recorded", parameters: { fake: "guessed" } } }), id)).toBeNull();
    expect(historyOriginTarget(detail(), ["original-project"])).toBe("/canvas/original-project");
    expect(historyOriginTarget(detail(), ["different-project"])).toBeNull();
    expect(historyOriginTarget(detail({ projectId: null }), ["original-project"])).toBeNull();
});

test("history detail accepts the original published image protocol, total count and channel batch cap", () => {
    const snapshot = { status: "recorded", protocol: "openai-image-v1", parameters: { size: "1536x864", quality: "medium", n: 10 }, maxImagesPerRequest: 4 };
    expect(parseHistoryDetail(detail({ imageSpecSnapshot: snapshot }), id)?.task.imageSpecSnapshot).toEqual(snapshot);
    expect(parseHistoryDetail(detail({ imageSpecSnapshot: { ...snapshot, parameters: { ...snapshot.parameters, n: 11 } } }), id)).toBeNull();
    expect(parseHistoryDetail(detail({ imageSpecSnapshot: { ...snapshot, maxImagesPerRequest: 0 } }), id)).toBeNull();
});

test("legacy tasks with no price version or quote still open; a recorded zero quote never fills unverified actual charges", async () => {
    for (const quotedUnits of [null, 0]) {
        const legacy = detail({ priceVersion: null, quotedUnits });
        const client = createGenerationHistoryClient({ scope, getScope: () => scope, fetcher: (async () => Response.json(legacy)) as unknown as typeof fetch });
        expect(await client.detail(id)).toEqual(legacy);
        const html = renderToStaticMarkup(<HistoryDetailBody detail={legacy} row={{ ...row(), credits: null }} onPreview={() => {}} onPreviewError={() => {}} />);
        expect(html).toContain("待核实");
        expect(html).toContain("价格版本</dt><dd class=\"mt-1 break-all whitespace-pre-wrap\">未记录");
        expect(html).toContain(`正式报价（非实扣）</dt><dd class="mt-1 break-all whitespace-pre-wrap">${quotedUnits === null ? "未记录" : "0 积分"}`);
    }
});

test("recorded video detail shows its complete specification without inventing a first-frame ratio or actual charge", () => {
    const hydrated = useCanvasStore.getState().hydrated;
    useCanvasStore.setState({ hydrated: true });
    try {
    for (const mode of ["text", "first_frame"] as const) {
        const parsed = parseHistoryDetail(detail({ projectId: null, nodeId: null, video: {
            parameters: { mode, resolution: "480p", durationSeconds: 1, generateAudio: mode === "first_frame", ...(mode === "text" ? { aspectRatio: "16:9" } : {}) },
            usagePolicy: "delivered_video", quotedVideoUnits: 1, reservedCredits: 7, phase: "unknown",
        } }), id);
        expect(parsed).not.toBeNull();
        const html = renderToStaticMarkup(<HistoryDetailBody detail={parsed!} row={{ ...row(), type: "video", credits: null }} onPreview={() => {}} onPreviewError={() => {}} onOpenWorkbench={() => {}} onOpenOrigin={() => {}} />);
        expect(html).toContain(mode === "text" ? "文生视频" : "单张首帧");
        expect(html).toContain(mode === "text" ? "无声音" : "带声音");
        expect(html).toContain("480p"); expect(html).toContain("时长（秒）</dt><dd class=\"mt-1 break-all whitespace-pre-wrap\">1");
        expect(html).toContain("正式报价（非实扣）</dt><dd class=\"mt-1 break-all whitespace-pre-wrap\">7 积分");
        expect(html).toContain("实扣积分（历史已核实）</dt><dd class=\"mt-1 break-all whitespace-pre-wrap\">待核实");
        expect(html.includes("画幅比例")).toBe(mode === "text");
        expect(html).toContain("返回视频创作"); expect(html).not.toContain("回到原画布");
    }
    } finally { useCanvasStore.setState({ hydrated }); }
});

for (const stage of ["fetch", "json"] as const) test(`late detail ${stage} is discarded after account epoch changes`, async () => {
    const wait = deferred<any>(); let current: GenerationHistoryScope = scope;
    const client = createGenerationHistoryClient({ scope, getScope: () => current, fetcher: (async () => stage === "fetch" ? wait.promise : { ok: true, status: 200, json: () => wait.promise }) as unknown as typeof fetch });
    const pending = client.detail(id); await Promise.resolve(); current = { ...scope, epoch: 2 };
    wait.resolve(stage === "fetch" ? Response.json(detail()) : detail());
    await expect(pending).rejects.toMatchObject({ code: "context_changed" });
});

test("closing, paging and changing scope suppress pending details even if transport ignores AbortSignal", async () => {
    for (const action of ["close", "page", "scope", "dispose"] as const) {
        const wait = deferred<HistoryDetail>(); let current: GenerationHistoryScope | null = scope, signal: AbortSignal | undefined;
        const reader = createHistoryReader({ scope, getScope: () => current, onState: () => {}, client: {
            read: async () => ({ items: [row()], total: 1, pageNumber: 1, pageSize: 50 }), detail: async (_id, received) => { signal = received; return wait.promise; },
        } });
        await reader.read(); const pending = reader.detail(id);
        expect(reader.snapshot().detail?.status).toBe("loading");
        if (action === "close") reader.closeDetail();
        if (action === "page") await reader.read();
        if (action === "scope") { current = null; reader.syncScope(); }
        if (action === "dispose") reader.dispose();
        expect(signal?.aborted).toBe(true); wait.resolve(detail()); await pending;
        expect(reader.snapshot().detail).toBeUndefined(); reader.dispose();
    }
});

test("detail authentication failure clears every row and preview, while ordinary failure allows explicit retry", async () => {
    for (const auth of [false, true]) {
        const reader = createHistoryReader({ scope, getScope: () => scope, onState: () => {}, client: {
            read: async () => ({ items: [row()], total: 1, pageNumber: 1, pageSize: 50 }),
            detail: async () => { throw auth ? new GenerationError("unauthorized", "sign in", "not-sent", 401) : new Error("network"); },
        } });
        await reader.read(); await reader.detail(id);
        expect(reader.snapshot().items).toHaveLength(auth ? 0 : 1);
        expect(reader.snapshot().error).toBe(auth ? "accountChanged" : undefined);
        expect(reader.snapshot().detail?.status).toBe(auth ? undefined : "error"); reader.dispose();
    }
});

test("detail separates quote, budget, verified actual charge, all three statuses and unrecorded parameters", () => {
    const html = renderToStaticMarkup(<HistoryDetailBody detail={detail()} row={row()} onPreview={() => {}} onPreviewError={() => {}} />);
    for (const text of ["正式报价（非实扣）", "7 积分", "实扣积分（历史已核实）", "0 积分", "任务执行", "结果交付", "计费状态", "未记录", "原画布不在当前浏览器"]) expect(html).toContain(text);
    const audio = detail({ projectId: null, audioSnapshot: { status: "recorded", input: { text: "已记录语音文本" }, parameters: { voice: "default", format: "wav" } } });
    const recorded = renderToStaticMarkup(<HistoryDetailBody detail={audio} row={{ ...row(), type: "audio", credits: null }} onPreview={() => {}} onPreviewError={() => {}} />);
    for (const text of ["已记录语音文本", "default", "wav", "待核实"]) expect(recorded).toContain(text);
    expect(recorded).not.toContain("回到原画布");
});

test("a retained result from the list never overrides the detail's latest incomplete delivery", () => {
    const saved = { ...row(), result: { url: `/api/v1/media/${id}` }, executionStatus: "succeeded" as const, deliveryStatus: "saved" as const };
    const html = renderToStaticMarkup(<HistoryDetailBody detail={detail()} row={saved} preview={{ status: "ready", url: "blob:previous-preview" }} onPreview={() => {}} onPreviewError={() => {}} />);
    expect(html).not.toContain("blob:previous-preview"); expect(html).not.toContain("<img");
    expect(html).toContain("暂无可读取结果");
});
