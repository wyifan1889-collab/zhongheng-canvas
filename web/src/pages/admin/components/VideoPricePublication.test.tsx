import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicationPrice } from "./ModelPriceDraft";
import { VideoPricePolicyEditor } from "./VideoPricePublication";
import SpecificationPriceEditor from "./SpecificationPriceEditor";
import { parseModelPriceRules } from "../../../../../packages/shared/src/model-pricing-drafts";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY } from "../../../../../packages/shared/src/generation-video";
import type { PublishedVideoSpecPrice } from "../../../../../packages/shared/src/model-price-publications";

test("video publication displays each complete sound and aspect combination without guessed duration billing", () => {
    const price: PublishedVideoSpecPrice = { billingUnit: "video_specs", creditsPerUnit: null, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY,
        videoSpecs: [
            { parameters: { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" }, creditsPerVideo: 7 },
            { parameters: { mode: "first_frame", resolution: "1080p", durationSeconds: 10, generateAudio: true }, creditsPerVideo: 13 },
        ] };
    const html = renderToStaticMarkup(<PublicationPrice price={price} />);
    for (const text of ["文生视频", "720p", "5", "不生成声音", "16:9", "7", "一张首帧", "1080p", "10", "生成声音", "比例随首帧", "13", "积分 / 条", "未知保留冻结", "受理或供应商完成均不等于已交付"]) expect(html).toContain(text);
    for (const text of ["积分 / 秒", "默认", "null", "配置成本"]) expect(html).not.toContain(text);
});

test("protocol declaration is explicit and saving or selecting a channel cannot imply video activation", () => {
    const html = renderToStaticMarkup(<VideoPricePolicyEditor disabled={false} onChange={() => undefined} />);
    expect(html).not.toContain("checked=");
    for (const text of ["我已核对当前渠道", "按秒", "不可发布", "发布价目仍须另过运行配置与资源门槛", "不是供应商收费凭据"]) expect(html).toContain(text);
    const checked = renderToStaticMarkup(<VideoPricePolicyEditor value={{ schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY }} disabled onChange={() => undefined} />);
    expect(checked).toContain("checked="); expect(checked).toContain("disabled=");
});

test("video specification editor exposes sound and aspect as independent saved price fields", () => {
    const rules = parseModelPriceRules({ schemaVersion: 1, video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY }, cost: null,
        sale: { template: "video_count", currency: "credit", bands: [{ parameters: { mode: "text", resolution: "720p", durationSeconds: "5", generateAudio: "false", aspectRatio: "16:9" }, rates: { video: "7" } }] } }, "video")!;
    const html = renderToStaticMarkup(<SpecificationPriceEditor capability="video" rules={rules} disabled={false} onChange={() => undefined} />);
    for (const text of ["规格1生成声音", "规格1文生比例", "规格1模式", "规格1视频分辨率", "规格1时长（秒）", "不生成声音", "16:9"]) expect(html).toContain(text);
    expect(html).toContain("单张 / 单段售价试算");
});
