import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoSpecPriceLines } from "./video-spec-price-lines";
import type { PublishedVideoSpecPrice } from "../../../../packages/shared/src/model-price-publications";

test("video price display preserves each complete specification and per-delivered-video amount", () => {
    const price: PublishedVideoSpecPrice = { billingUnit: "video_specs", creditsPerUnit: null, protocol: "yunfei-grok-video-v1", usagePolicy: "delivered_video", videoSpecs: [
        { parameters: { mode: "text", resolution: "720p", durationSeconds: 7, generateAudio: false, aspectRatio: "16:9" }, creditsPerVideo: 13 },
        { parameters: { mode: "first_frame", resolution: "1080p", durationSeconds: 11, generateAudio: true }, creditsPerVideo: 29 },
    ] };
    const html = renderToStaticMarkup(<VideoSpecPriceLines price={price} />);
    expect(html).toContain("视频规格与单条价"); expect((html.match(/<li(?:\s|>)/g) ?? []).length).toBe(2);
    for (const text of ["文生视频", "720p", "7秒", "无声音", "16:9", "13 积分 / 条", "单张首帧", "1080p", "11秒", "带声音", "29 积分 / 条"]) expect(html).toContain(text);
    expect(html).not.toMatch(/null|undefined|USD|积分 \/ 秒/);
});
