import { beforeEach, describe, expect, test } from "bun:test";
import {
    createPreviewData, getPublishedModels, quotePreviewPrice, useModelManagementPreview, validateAssignment,
    type DiscoveredModel,
} from "./state";

beforeEach(() => useModelManagementPreview.getState().reset());

describe("模型管理本机预览", () => {
    test("视频同规格按秒与整段分别报价，不重复乘时长", () => {
        const models = getPublishedModels(createPreviewData(), "video");
        const perSecond = models.find(model => model.sale.template === "video_second")!;
        const perVideo = models.find(model => model.sale.template === "video_count")!;
        expect(quotePreviewPrice(perSecond, { resolution: "1080p", durationSeconds: "5" }, { second: "5" })).toMatchObject({ status: "calculated", total: "4" });
        expect(quotePreviewPrice(perSecond, { resolution: "1080p", durationSeconds: "10" }, { second: "10" })).toMatchObject({ status: "calculated", total: "8" });
        expect(quotePreviewPrice(perVideo, { resolution: "1080p", durationSeconds: "10" }, { video: "1" })).toMatchObject({ status: "calculated", total: "10" });
        expect(quotePreviewPrice(perSecond, { resolution: "1080p", durationSeconds: "10" }, { second: "5" })).toMatchObject({ status: "invalid_sample" });
    });

    test("不存在的规格和缺少时长拒绝报价，不套用低价档", () => {
        const video = getPublishedModels(createPreviewData(), "video").find(model => model.sale.template === "video_count")!;
        expect(quotePreviewPrice(video, { resolution: "4K", durationSeconds: "10" }, { video: "1" })).toMatchObject({ status: "no_matching_band" });
        expect(quotePreviewPrice(video, { resolution: "720p", durationSeconds: "7" }, { video: "1" })).toMatchObject({ status: "no_matching_band" });
        expect(quotePreviewPrice(video, { resolution: "720p" }, { video: "1" })).toMatchObject({ status: "missing_parameters" });
    });

    test("文本按输入输出分别精确计算，图片按尺寸切换售价，公开投影不含成本渠道", () => {
        const data = createPreviewData(), text = getPublishedModels(data, "text")[0], image = getPublishedModels(data, "image")[0];
        expect(quotePreviewPrice(text, {}, { input_token: "125000", output_token: "25000" })).toMatchObject({ status: "calculated", total: "0.45" });
        expect(quotePreviewPrice(image, { size: "2K" }, { image: "2" })).toMatchObject({ status: "calculated", total: "4" });
        expect(Object.keys(image).sort()).toEqual(["brand", "groupId", "id", "kind", "name", "note", "sale", "version"]);
        expect(JSON.stringify(image)).not.toContain("channel-a");
    });

    test("未定价不能上线，明确零售价可以上线，未知成本不变成零", () => {
        const store = useModelManagementPreview.getState();
        const added = store.addAssignment("a-gemini", "text", "text-gemini");
        expect(added.ok).toBe(true);
        if (!added.ok) throw new Error("fixture");
        expect(store.publishAssignment(added.id!)).toMatchObject({ ok: false });
        const assignment = useModelManagementPreview.getState().assignments.find(item => item.id === added.id)!;
        const rules = structuredClone(assignment.rules);
        rules.sale.bands[0].rates = { input_token: "0", output_token: "0" };
        store.updateAssignment(assignment.id, { rules });
        expect(store.publishAssignment(assignment.id)).toEqual({ ok: true });
        const published = useModelManagementPreview.getState().assignments.find(item => item.id === assignment.id)!.published!;
        expect(published.rules.cost!.bands[0].rates).toEqual({ input_token: null, output_token: null });
        expect(published.rules.sale.bands[0].rates).toEqual({ input_token: "0", output_token: "0" });
    });

    test("草稿调价不影响已发布用户价格，确认发布后才形成新版本", () => {
        const store = useModelManagementPreview.getState();
        const original = store.assignments.find(item => item.id === "assigned-video")!;
        const rules = structuredClone(original.rules);
        rules.sale.bands[0].rates.second = "9";
        store.updateAssignment(original.id, { rules, name: "新展示名称" });
        const before = getPublishedModels(useModelManagementPreview.getState(), "video").find(item => item.id === original.id)!;
        expect(before.name).toBe("Grok 视频示例");
        expect(quotePreviewPrice(before, { resolution: "720p", durationSeconds: "5" }, { second: "5" })).toMatchObject({ total: "2" });
        expect(store.publishAssignment(original.id)).toEqual({ ok: true });
        const after = getPublishedModels(useModelManagementPreview.getState(), "video").find(item => item.id === original.id)!;
        expect(after).toMatchObject({ name: "新展示名称", version: 2 });
        expect(quotePreviewPrice(after, { resolution: "720p", durationSeconds: "5" }, { second: "5" })).toMatchObject({ total: "45" });
        rules.sale.bands[0].rates.second = "999";
        expect(after.sale.bands[0].rates.second).toBe("9");
    });

    test("重叠和不完整视频规格、成本售价规格不匹配均拒绝上线", () => {
        const original = createPreviewData().assignments.find(item => item.id === "assigned-video")!;
        const duplicate = structuredClone(original);
        duplicate.rules.sale.bands.push(structuredClone(duplicate.rules.sale.bands[0]));
        expect(validateAssignment(duplicate)).not.toBeNull();
        const missing = structuredClone(original);
        missing.rules.sale.bands = [{ parameters: { resolution: "720p" }, rates: { second: "1" } }];
        expect(validateAssignment(missing)).toContain("时长");
        const mismatch = structuredClone(original);
        mismatch.rules.cost!.bands[0].parameters.resolution = "4K";
        expect(validateAssignment(mismatch)).toContain("相同的规格组合");
    });

    test("发布规范化草稿名称和金额，未改动时不留下虚假的待发布差异", () => {
        const store = useModelManagementPreview.getState();
        const original = store.assignments.find(item => item.id === "assigned-image")!;
        const rules = structuredClone(original.rules);
        rules.sale.bands[0].rates.image = "1.00";
        store.updateAssignment(original.id, { name: "  图片展示名称  ", rules });
        expect(store.publishAssignment(original.id)).toEqual({ ok: true });
        const saved = useModelManagementPreview.getState().assignments.find(item => item.id === original.id)!;
        expect(saved.name).toBe("图片展示名称");
        expect(saved.rules.sale.bands[0].rates.image).toBe("1");
        expect([saved.name, saved.groupId, saved.rules, saved.note]).toEqual([saved.published!.name, saved.published!.groupId, saved.published!.rules, saved.published!.note]);
        expect(saved.rules).not.toBe(saved.published!.rules);
    });

    test("渠道成本可按整段而用户售价按秒，图片支持按次且只计一次", () => {
        const store = useModelManagementPreview.getState();
        const video = structuredClone(store.assignments.find(item => item.id === "assigned-video")!);
        video.rules.cost = { template: "video_count", currency: "CNY", bands: video.rules.sale.bands.map(band => ({ parameters: { ...band.parameters }, rates: { video: "0.5" } })) };
        expect(validateAssignment(video)).toBeNull();
        store.updateAssignment(video.id, { rules: video.rules });
        expect(store.publishAssignment(video.id)).toEqual({ ok: true });
        const publishedVideo = getPublishedModels(useModelManagementPreview.getState(), "video").find(item => item.id === video.id)!;
        expect(quotePreviewPrice(publishedVideo, { resolution: "720p", durationSeconds: "10" }, { second: "10", video: "1" })).toMatchObject({ total: "4" });

        const image = structuredClone(store.assignments.find(item => item.id === "assigned-image")!);
        image.rules.sale.template = "image_request";
        image.rules.sale.bands.forEach(band => { band.rates = { request: "1.25" }; });
        expect(validateAssignment(image)).toBeNull();
        store.updateAssignment(image.id, { rules: image.rules });
        expect(store.publishAssignment(image.id)).toEqual({ ok: true });
        const publishedImage = getPublishedModels(useModelManagementPreview.getState(), "image")[0];
        expect(quotePreviewPrice(publishedImage, { size: "4K" }, { request: "1", image: "1" })).toMatchObject({ total: "1.25" });
    });

    test("目录更新保留分配和价格，同名跨渠道不合并，未知类型须先确认", () => {
        const store = useModelManagementPreview.getState();
        expect(store.catalog.filter(model => model.upstreamId === "gpt-demo-text")).toHaveLength(2);
        expect(store.addAssignment("b-unknown", "video", "video-other")).toMatchObject({ ok: false });
        expect(store.classifyModel("b-unknown", "video", "示例厂商")).toEqual({ ok: true });
        expect(store.addAssignment("b-unknown", "video", "video-other")).toMatchObject({ ok: true });
        const saved = structuredClone(useModelManagementPreview.getState().assignments);
        const incoming: DiscoveredModel[] = [{ upstreamId: "new-demo", name: "新增示例", brand: "待确认", kind: "unknown" }];
        expect(store.updateCatalog("demo-a", incoming)).toEqual({ ok: true });
        const updated = useModelManagementPreview.getState();
        expect(updated.assignments).toEqual(saved);
        expect(updated.catalog.find(model => model.id === "a-gpt")!.available).toBe(false);
        expect(updated.catalog.find(model => model.id === "b-gpt")!.available).toBe(true);
        expect(getPublishedModels(updated, "text")).toHaveLength(2);
        expect(store.publishAssignment("assigned-text")).toMatchObject({ ok: false });
        store.toggleChannel("demo-a", false);
        expect(getPublishedModels(useModelManagementPreview.getState(), "text")).toHaveLength(0);
        store.toggleChannel("demo-b", false);
        expect(store.addAssignment("b-gpt", "text", "text-gpt")).toMatchObject({ ok: false });
    });
});
