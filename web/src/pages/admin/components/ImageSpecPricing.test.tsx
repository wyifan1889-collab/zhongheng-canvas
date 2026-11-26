import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformPriceDetails } from "@/components/account/platform-overview";
import { PublicationPrice } from "./ModelPriceDraft";
import AcceptedTaskPrice from "./AcceptedTaskPrice";
import type { PlatformPricing, TaskPriceSnapshot } from "@/services/saas/platform";

const price: Extract<PlatformPricing, { billingUnit: "image_specs" }> = {
    modelId: "image-specs", displayName: "合成规格图片", capability: "image", version: 9, effectiveFrom: "2026-10-25T00:00:00Z", effectiveTo: null,
    billingUnit: "image_specs", creditsPerUnit: null, imageSpecs: [
        { parameters: { size: "1024x1024", quality: "low" }, creditsPerRequest: 7 },
        { parameters: { size: "1536x1024", quality: "high" }, creditsPerRequest: 19 },
    ],
};

test("image specification price blocks retain exact combinations and defer executable availability to the original canvas directory", () => {
    for (const html of [renderToStaticMarkup(<PlatformPriceDetails price={price} />), renderToStaticMarkup(<PublicationPrice price={price} />)]) {
        for (const expected of ["尺寸 1024x1024 · 质量 low", "7 积分 / 次", "尺寸 1536x1024 · 质量 high", "19 积分 / 次", "实际可用模型与规格以原画布平台目录"]) expect(html).toContain(expected);
        expect((html.match(/<li(?:\s|>)/g) ?? []).length).toBe(2);
        for (const invented of ["null 积分", "最低", "起", "默认", "1024x1024 · 质量 high", "1536x1024 · 质量 low"]) expect(html).not.toContain(invented);
    }
    const partial = { ...price, imageSpecs: [{ parameters: { quality: "medium" as const }, creditsPerRequest: 11 }] };
    const html = renderToStaticMarkup(<PublicationPrice price={partial} />);
    expect(html).toContain("质量 medium"); expect(html).not.toContain("尺寸"); expect(html).not.toContain("默认");
});

test("image task source retains historical rules independently of current specifications and invalid history stays rejected", () => {
    const snapshot: Extract<TaskPriceSnapshot, { status: "recorded" }> = {
        status: "recorded", publicationId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222",
        draftVersion: 1, priceVersion: 2, publicPriceNote: "旧规格公开说明", publishedAt: "2026-10-01T00:00:00Z",
        binding: { providerId: "old-channel", providerModel: "old-image", adapter: "openai-compatible", endpoint: "https://old.example.invalid/v1", capability: "image" },
        rules: { schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands: [
            { parameters: { size: "768x1024", quality: "medium" }, rates: { request: "5" } },
            { parameters: { size: "1024x768", quality: "high" }, rates: { request: "13" } },
        ] } },
    };
    const history = renderToStaticMarkup(<AcceptedTaskPrice snapshot={snapshot} />);
    for (const expected of ["尺寸：768x1024；质量：medium", "尺寸：1024x768；质量：high", ">5<", ">13<", "旧规格公开说明", "后续改价不会替换"]) expect(history).toContain(expected);
    expect(history).not.toContain("1536x1024"); expect(history).not.toContain("选中规格");
    const rejected = renderToStaticMarkup(<AcceptedTaskPrice snapshot={{ status: "invalid" }} />);
    expect(rejected).toContain("固定价目来源未通过校验"); expect(rejected).not.toContain("768x1024"); expect(rejected).not.toContain("积分售价规则");
});
