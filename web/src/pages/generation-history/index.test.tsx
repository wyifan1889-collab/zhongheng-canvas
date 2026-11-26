import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import i18n from "@/i18n";
import type { GenerationHistoryItem } from "@/services/saas/generation-history";
import { useAccountStore } from "@/stores/use-account-store";
import { generationTrackingPresentation } from "@/stores/use-generation-tracker";
import GenerationHistoryPage, { GenerationHistoryContent } from "./index";
import { initialHistoryState, type HistoryState } from "./history-reader";

const mediaId = "11111111-1111-4111-8111-111111111111";
const row = (patch: Partial<GenerationHistoryItem> = {}): GenerationHistoryItem => ({ taskId: mediaId, type: "image", displayModel: "original-model", executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", credits: "0.000001", createdAt: "2026-10-26T01:02:03.000Z", updatedAt: "2026-10-26T01:02:03.000Z", result: null, ...patch });
const ready = (items: GenerationHistoryItem[] = []): HistoryState => ({ ...initialHistoryState(), phase: "ready", items, total: items.length });
const noop = () => {};
function render(state: HistoryState, onRead = noop) {
    return renderToStaticMarkup(<GenerationHistoryContent state={state} onRead={onRead} onPreview={noop} onPreviewError={noop} />);
}
const tr = (key: string) => i18n.t(`generationHistory.${key}`);

test("history offers type-based media returns without guessing text or unknown canvas locations or navigating on render", () => {
    let navigations = 0;
    const items = ["image", "video", "audio", "text", null].map((type, index) => row({ taskId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, type: type as GenerationHistoryItem["type"] }));
    const html = renderToStaticMarkup(<GenerationHistoryContent state={ready(items)} onRead={noop} onPreview={noop} onPreviewError={noop} onOpenWorkbench={() => { navigations++; }} />);
    for (const type of ["image", "video", "audio"]) expect(html).toContain(`返回${tr(`types.${type}`)}创作`);
    expect(html.match(/暂无原工作台定位信息/g)).toHaveLength(2);
    expect(html).not.toContain("/canvas/");
    expect(html).toContain("不会新建生成");
    expect(navigations).toBe(0);
});

test("real page content renders five type tabs, execution filter and fixed 50-row pagination without a read during render", () => {
    let reads = 0;
    const html = render({ ...ready(), total: 151, query: { pageNumber: 3, pageSize: 50 } }, () => { reads++; });
    for (const key of ["all", "image", "video", "audio", "text"]) expect(html).toContain(tr(`types.${key}`));
    expect(html).toContain(`aria-label="${tr("filterStatus")}"`);
    expect(html).toContain(tr("executionFilterNote"));
    expect(html).toContain(tr("pageSizeDescription"));
    expect(html).toContain(i18n.t("generationHistory.total", { total: 151 }));
    expect(html).not.toContain("ant-pagination-options-size-changer");
    expect(html).toContain('aria-label="创作历史分页"');
    expect(html).toContain('aria-label="第 3 页" aria-current="page"');
    const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)];
    expect(tabs).toHaveLength(5);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(5);
    for (const [tab] of tabs) {
        const panel = /aria-controls="([^"]+)"/.exec(tab)?.[1];
        expect(panel).toBeDefined();
        expect(html).toContain(`id="${panel}"`);
    }
    expect(reads).toBe(0);
});

test("all eight execution statuses remain in real rows and only T4's full success is green", () => {
    const statuses = ["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"] as const;
    const items = statuses.map((executionStatus, index) => row({ taskId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, executionStatus,
        deliveryStatus: executionStatus === "failed" || executionStatus === "cancelled" ? "failed" : executionStatus === "succeeded" ? "saved" : "pending",
        billingStatus: executionStatus === "cancelled" ? "released" : executionStatus === "succeeded" ? "captured" : "unbilled" }));
    const html = render(ready(items));
    for (const status of statuses) expect(html).toContain(tr(`execution.${status}`));
    for (const item of items) expect(html).toContain(generationTrackingPresentation(item).title);
    expect(html.match(/data-status-level="success"/g)).toHaveLength(2);
    expect(html.match(/data-mobile-row-key=/g)).toHaveLength(8);
    expect(html).toContain('aria-label="创作历史记录列表"');
    expect(html.match(/data-row-key=/g)).toHaveLength(8);
    expect(html).toContain("<caption");
    expect(html.match(/scope="col"/g)).toHaveLength(6);
    expect(html.match(/scope="row"/g)).toHaveLength(8);
    expect(html).toContain('role="region" aria-label="创作历史记录，可横向滚动查看全部列" tabindex="0"');
});

test("execution success alone never turns incomplete delivery or billing green", () => {
    for (const patch of [{ deliveryStatus: "pending" }, { deliveryStatus: "failed" }, { billingStatus: "reserved" }, { billingStatus: "released" }, { billingStatus: "pending_review" }] as const) {
        const item = row(patch), html = render(ready([item]));
        expect(html).toContain(tr("execution.succeeded"));
        expect(html).toContain(generationTrackingPresentation(item).title);
        expect(html).not.toContain('data-status-level="success"');
    }
});

test("exact credits stay unchanged as strings, reliable zero is visible and null remains unverified", () => {
    for (const credits of ["0", "0.000001", "9007199254740993.123456"]) {
        const html = render(ready([row({ credits })]));
        expect(html).toContain(i18n.t("generationHistory.creditsValue", { credits }));
        expect(html).not.toContain("9.007199");
    }
    const html = render(ready([row({ credits: null })]));
    expect(html).toContain(tr("unverified"));
    expect(html).not.toContain(i18n.t("generationHistory.creditsValue", { credits: "0" }));
    expect(html).toContain(tr("creditsExplanation"));
});

test("unknown type stays visible and model/time use historical fields", () => {
    const item = row({ type: null, displayModel: "old-model-id" }), html = render(ready([item]));
    expect(html).toContain(tr("types.unknown"));
    expect(html).toContain("old-model-id");
    expect(html).toContain(`dateTime="${item.createdAt}"`);
    expect(html).toContain(tr("columns.credits"));
});

test("only validated Blob previews become img sources; audio and video remain icons and saved-result text", () => {
    const image = row({ result: { url: `/api/v1/media/${mediaId}` } });
    const video = row({ taskId: "22222222-2222-4222-8222-222222222222", type: "video", result: { url: `/api/v1/media/${mediaId}` } });
    const audio = row({ taskId: "33333333-3333-4333-8333-333333333333", type: "audio", result: { url: `/api/v1/media/${mediaId}` } });
    const state = ready([image, video, audio]); state.previews = { [image.taskId]: { status: "ready", url: "blob:controlled-history-preview" } };
    const html = render(state);
    expect(html).toContain('src="blob:controlled-history-preview"');
    expect(html).not.toContain(`/api/v1/media/${mediaId}`);
    expect(html).not.toContain("<video"); expect(html).not.toContain("<audio");
    expect(html).toContain("lucide-video"); expect(html).toContain("lucide-audio-lines");
    expect(html).toContain(tr("savedResult"));
});

test("preview failure leaves its row visible with a readonly retry and never fetches while rendering", () => {
    const state = ready([row({ result: { url: `/api/v1/media/${mediaId}` } })]);
    state.previews = { [mediaId]: { status: "error" } };
    const html = render(state);
    expect(html).toContain("original-model");
    expect(html).toContain(tr("previewFailed")); expect(html).toContain(tr("retryPreview"));
    expect(html).not.toContain("<img");
});

test("loading, empty history, empty filtered results, empty page and failed reads are distinct", () => {
    expect(render(initialHistoryState())).toContain(tr("loading"));
    expect(render(initialHistoryState())).not.toContain(tr("empty"));
    expect(render(ready())).toContain(tr("empty"));
    expect(render({ ...ready(), query: { pageNumber: 1, type: "text" } })).toContain(tr("filteredEmpty"));
    expect(render({ ...ready(), query: { pageNumber: 3 }, total: 100 })).toContain(tr("emptyPage"));
    for (const error of ["readFailed", "serviceUnavailable", "accountChanged"] as const) {
        const html = render({ ...ready(), phase: "error", error });
        expect(html).toContain(tr(error));
        expect(html).not.toContain(tr("empty"));
    }
});

test("same-scope failed refresh labels retained rows as stale instead of presenting an empty history", () => {
    const html = render({ ...ready([row()]), phase: "error", error: "readFailed" });
    expect(html).toContain(tr("retainedRows")); expect(html).toContain("original-model");
    expect(html).toContain(tr("retry")); expect(html).not.toContain(tr("empty"));
});

test("the real page distinguishes pending account checks, logged-out and unavailable accounts without requests", () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => { calls.push(String(input)); throw new Error("No network in SSR"); }, { preconnect: originalFetch.preconnect });
    const snapshots = [...new Set([useAccountStore.getInitialState(), useAccountStore.getState()])];
    const previous = snapshots.map((snapshot) => ({ status: snapshot.status, busy: snapshot.busy, user: snapshot.user, site: snapshot.site }));
    try {
        const renderPage = () => renderToStaticMarkup(<MemoryRouter initialEntries={["/generation/history"]}><GenerationHistoryPage /></MemoryRouter>);
        for (const snapshot of snapshots) Object.assign(snapshot, { status: "loading", busy: false, user: null });
        expect(renderPage()).toContain(tr("accountLoading"));
        for (const snapshot of snapshots) Object.assign(snapshot, { status: "ready", busy: true, user: { id: "old-owner", name: "old", role: "user" } });
        expect(renderPage()).toContain(tr("accountLoading"));
        for (const snapshot of snapshots) Object.assign(snapshot, { status: "ready", busy: false, user: null });
        expect(renderPage()).toContain(tr("signInRequired"));
        for (const snapshot of snapshots) Object.assign(snapshot, { status: "unavailable", busy: false, user: null });
        expect(renderPage()).toContain(tr("accountUnavailable"));
        for (const snapshot of snapshots) Object.assign(snapshot, { status: "ready", busy: false, user: { id: "confirmed-owner", name: "owner", role: "user" } });
        const html = renderPage();
        expect(html).toContain(tr("loading")); expect(html).toContain('role="tablist"');
        expect(calls).toEqual([]);
    } finally { snapshots.forEach((snapshot, index) => Object.assign(snapshot, previous[index])); globalThis.fetch = originalFetch; }
});
