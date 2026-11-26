import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TextBillingExplanationLines } from "./canvas-platform-text-modal";
import { PlatformPriceDetails } from "../account/platform-overview";
import type { TextGenerationTaskView } from "../../services/saas/text-generation";

const task = (): TextGenerationTaskView["task"] => ({ id: "11111111-1111-4111-8111-111111111111", projectId: "fixture-project", modelId: "fixture-model", priceVersion: 2,
    textQuoteSnapshot: { schemaVersion: 1, budgetCredits: "50", inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360", usageSource: "responses" },
    executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", billing: { reservedCredits: "50", capturedCredits: "25.48854", releasedCredits: "24.51146" },
    textBillingExplanation: { schemaVersion: 1, taskId: "11111111-1111-4111-8111-111111111111", modelId: "fixture-model", priceVersion: 2,
        policy: "context_tiers", tier: "long", thresholdTokens: 272000, totalTokens: 272001,
        rates: { inputCreditsPerMillion: "144", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "540" },
        quantities: { inputTokens: 272000, cachedInputTokens: 100000, outputTokens: 1 }, expectedCredits: "25.48854" } });

test("read-only long receipt labels actual rates, total, cache subset and expected charge without presenting it as captured", () => {
    const html = renderToStaticMarkup(<TextBillingExplanationLines task={task()} />);
    for (const text of ["原价格版本 2", "实际采用长档", "272001", "272000", "172000", "100000", "144", "7.2", "540", "25.48854", "不代表已经扣款"]) expect(html).toContain(text);
    expect(html).not.toMatch(/<(?:input|select|button)\b/);
});
test("missing, invalid and uncertain policy never render short quote rates as actual settlement", () => {
    for (const explanation of [undefined, null, { ...task().textBillingExplanation!, policy: "invalid" as const, tier: null, thresholdTokens: null, totalTokens: null, rates: null, quantities: null, expectedCredits: null },
        { ...task().textBillingExplanation!, tier: null, totalTokens: null, rates: null, quantities: null, expectedCredits: null }]) {
        const html = renderToStaticMarkup(<TextBillingExplanationLines task={{ ...task(), textBillingExplanation: explanation }} />);
        expect(html).toContain("无法核对"); expect(html).not.toContain("72 积分"); expect(html).not.toContain("采用短档"); expect(html).not.toContain("应扣 0");
    }
});
test("legacy original fixed rates are distinct from context tiering", () => {
    const original = task(); original.textBillingExplanation = { ...original.textBillingExplanation!, policy: "legacy_fixed", tier: "fixed", thresholdTokens: null };
    const html = renderToStaticMarkup(<TextBillingExplanationLines task={original} />);
    expect(html).toContain("原固定费率，不追溯切档"); expect(html).not.toContain("采用长档");
});
test("account price renders the original mandatory note without asserting generation is globally disabled", () => {
    const html = renderToStaticMarkup(<PlatformPriceDetails price={{ modelId: "fixture-model", displayName: "Fixture", capability: "text", version: 2,
        billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360",
        effectiveFrom: "2026-10-29T00:00:00.000Z", effectiveTo: null, priceNote: "超过272K按长档计价；本平台以输入+输出总量判档。" }} />);
    expect(html).toContain("超过272K按长档计价"); expect(html).toContain("已发布报价费率基准"); expect(html).toContain("正式报价为准"); expect(html).not.toContain("尚未开放平台文本生成");
});
