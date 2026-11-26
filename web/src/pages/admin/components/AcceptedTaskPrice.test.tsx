import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskPriceSnapshot } from "@/services/saas/platform";
import AcceptedTaskPrice from "./AcceptedTaskPrice";

const snapshot: Extract<TaskPriceSnapshot, { status: "recorded" }> = { status: "recorded",
    publicationId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222",
    draftVersion: 3, priceVersion: 2, publicPriceNote: "每次单张", publishedAt: "2026-01-01T00:00:00.000Z",
    binding: { providerId: "old-channel", providerModel: "old-image", endpoint: "https://old.example.invalid/v1", adapter: "openai-compatible", capability: "image" },
    rules: { schemaVersion: 1,
        cost: { template: "image_tokens", currency: "USD", bands: [{ parameters: { quality: "high" }, rates: { input_token: "0.12", output_token: null, image_input_token: "0", image_output_token: "2" } }] },
        sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } } };

test("fixed source shows independent cost and sale meters with unknown distinct from configured zero", () => {
    const html = renderToStaticMarkup(<AcceptedTaskPrice snapshot={snapshot} />);
    for (const text of ["受理时固定价目", "查看价目来源与渠道", "配置成本规则", "积分售价规则",
        "美元（USD） / 百万 Token", "积分 / 次", "质量：high", "未知", ">0<", "0.12", "每次单张", "实际扣款见下方账本", "币种不自动换算"]) expect(html).toContain(text);
    expect(html.indexOf("配置成本规则")).toBeLessThan(html.indexOf("查看价目来源与渠道"));
    expect(html).not.toContain(snapshot.publicationId);
    expect(html).not.toContain("使用此草稿只读试算");
    expect(html).not.toContain("已结算");
});

test("legacy, invalid and wholly unknown cost remain distinct and do not fabricate historical prices", () => {
    const legacy = renderToStaticMarkup(<AcceptedTaskPrice snapshot={{ status: "not_recorded" }} />);
    expect(legacy).toContain("未记录完整价目来源"); expect(legacy).toContain("不能用当前草稿或最新价格"); expect(legacy).not.toContain("积分售价规则");
    const invalid = renderToStaticMarkup(<AcceptedTaskPrice snapshot={{ status: "invalid" }} />);
    expect(invalid).toContain("固定价目来源未通过校验"); expect(invalid).toContain("不能据此调整积分"); expect(invalid).not.toContain("积分售价规则");
    const unknown = renderToStaticMarkup(<AcceptedTaskPrice snapshot={{ ...snapshot, rules: { ...snapshot.rules, cost: null } }} />);
    expect(unknown).toContain("受理时未配置成本，未知不按 0 计算"); expect(unknown).toContain("积分售价规则"); expect(unknown).not.toContain("美元（USD）");
});
