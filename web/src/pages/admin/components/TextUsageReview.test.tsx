import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluateTextUsageDraft } from "../../../../../packages/shared/src/text-usage-review";
import type { AdminGenerationTaskDetail, AdminModelPriceDraft, TextUsageEvidence } from "@/services/saas/platform";
import { TaskDetail } from "./GenerationTaskReview";
import { TextUsageCalculation, TextUsageEvidenceSummary } from "./TextUsageReview";

const usage: TextUsageEvidence = { schemaVersion: 1, source: "chat_completions", status: "complete", inputTokens: 1000, outputTokens: 500,
    totalTokens: 1500, totalSource: "reported", cachedInputTokens: 400, reasoningOutputTokens: 200, reason: null };
const missing: TextUsageEvidence = { schemaVersion: 1, source: "chat_completions", status: "missing", inputTokens: null, outputTokens: null,
    totalTokens: null, totalSource: null, cachedInputTokens: null, reasoningOutputTokens: null, reason: "missing_usage" };
const stamp = "2026-01-01T00:00:00.000Z";
const draft: AdminModelPriceDraft = { id: "11111111-1111-4111-8111-111111111111", modelId: "synthetic-text", version: 2,
    binding: { providerId: "synthetic-channel", providerModel: "synthetic-upstream", adapter: "openai-compatible", endpoint: "https://synthetic.invalid/v1", capability: "text" },
    bindingMatchesCurrent: true, priceNote: "private-note", createdAt: stamp,
    rules: { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] } } };
function taskDetail(textUsage: TextUsageEvidence | null): AdminGenerationTaskDetail {
    return { observedAt: stamp, priceSnapshot: { status: "not_recorded" }, task: { id: draft.id, ownerId: "synthetic-user", projectId: null, nodeId: null, modelId: "synthetic-model",
        priceVersion: null, quotedUnits: null, billingUnitSnapshot: null, creditsPerUnitSnapshot: null, executionStatus: "unknown",
        deliveryStatus: "unknown", billingStatus: "pending_review", unknownReason: null, createdAt: stamp, updatedAt: stamp, finishedAt: null },
        result: { status: "unknown", consumedUnits: null, textUsage, errorCode: null, unknownReason: null, createdAt: stamp, updatedAt: stamp },
        reservation: { linkStatus: "none", details: null }, ledger: [] };
}

test("actual task detail renders text review only with text evidence, including missing text usage", () => {
    const scope = { accountId: "synthetic-admin", epoch: 1, role: "admin" as const };
    for (const detail of [taskDetail(null), { ...taskDetail(null), result: null }]) {
        const html = renderToStaticMarkup(<TaskDetail detail={detail} scope={scope} />);
        expect(html).not.toContain("文本用量与草稿试算");
        expect(html).not.toContain("读取同模型已保存文本草稿");
        expect(html).toContain("结算待核对");
    }
    const html = renderToStaticMarkup(<TaskDetail detail={taskDetail(missing)} scope={scope} />);
    expect(html).toContain("文本用量与草稿试算"); expect(html).toContain("上游未返回用量");
    expect(html).toContain("读取同模型已保存文本草稿"); expect(html).not.toContain("已结算");
});

test("actual task ledger renders tiny and large exact credits without rounding or scientific notation", () => {
    const detail = taskDetail(null);
    detail.task.quotedUnits = 7;
    detail.reservation = { linkStatus: "linked", details: { id: draft.id, status: "pending", requestedUnits: "9007199254740993.000006",
        capturedUnits: "9007199254740993", releasedUnits: "0.000002", remainingUnits: "0.000004", createdAt: stamp, updatedAt: stamp } };
    detail.ledger = [{ id: draft.id, kind: "reserve", deltaAvailableUnits: "-0.000004", deltaReservedUnits: "0.000004", createdAt: stamp }];
    const html = renderToStaticMarkup(<TaskDetail detail={detail} scope={{ accountId: "synthetic-admin", role: "admin", epoch: 1 }} />);
    for (const text of ["9007199254740993.000006 积分", "9007199254740993 积分", "0.000002 积分", "0.000004 积分", "-0.000004", "+0.000004", "7 积分"]) expect(html).toContain(text);
    expect(html).not.toContain("4e-6"); expect(html).not.toContain("9007199254740992");
});

test("evidence presentation distinguishes missing counts and zero, and labels included subsets", () => {
    const html = renderToStaticMarkup(<TextUsageEvidenceSummary usage={usage} />);
    for (const text of ["1000 Token", "500 Token", "400 Token", "200 Token", "其中缓存输入（已含输入）", "其中推理输出（已含输出）", "不代表已核实供应商账单"]) expect(html).toContain(text);
    expect(renderToStaticMarkup(<TextUsageEvidenceSummary usage={null} />)).toContain("不代表用量为 0");
    const zero = { ...usage, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalSource: "derived" as const };
    const zeroHtml = renderToStaticMarkup(<TextUsageEvidenceSummary usage={zero} />);
    expect(zeroHtml).toContain("0 Token"); expect(zeroHtml).toContain("由输入与输出相加得到");
    expect(renderToStaticMarkup(<TextUsageEvidenceSummary usage={{ ...missing, status: "invalid", reason: "inconsistent_total" }} />)).toContain("总量与输入、输出不一致");
});

test("actual draft calculation renders exact what-if totals without recasting them as paid charges", () => {
    const review = evaluateTextUsageDraft(draft.modelId, usage, draft);
    expect(review).toMatchObject({ status: "calculated", sale: { total: "0.004" }, cost: null });
    const html = renderToStaticMarkup(<TextUsageCalculation review={review} />);
    for (const text of ["0.004 积分", "尚未录入成本，不按 0 估算", "非任务历史价格", "双项模板按全部输入", "推理已含输出", "不是实际扣款或供应商账单"]) expect(html).toContain(text);
    expect(html).not.toContain("private-note");
    const withCost: AdminModelPriceDraft = { ...draft, rules: { ...draft.rules, cost: { ...draft.rules.sale, currency: "USD" } } };
    const costHtml = renderToStaticMarkup(<TextUsageCalculation review={evaluateTextUsageDraft(draft.modelId, usage, withCost)} />);
    expect(costHtml).toContain("0.004 美元（USD）"); expect(costHtml).toContain("0.004 积分"); expect(costHtml).toContain("不换算或计算利润");
    const blocked = renderToStaticMarkup(<TextUsageCalculation review={evaluateTextUsageDraft(draft.modelId, usage, { ...draft, bindingMatchesCurrent: false })} />);
    expect(blocked).toContain("草稿的渠道绑定已变化"); expect(blocked).not.toContain("0.004");
});

test("cached read what-if shows exclusive input lines and treats missing or positive writes as unbillable", () => {
    const cachedDraft: AdminModelPriceDraft = { ...draft, rules: { schemaVersion: 1, cost: null, sale: { template: "text_cached_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.5", output_token: "4" } }] } } };
    const cachedUsage = { ...usage, cacheWriteTokens: 0 };
    const calculated = evaluateTextUsageDraft(draft.modelId, cachedUsage, cachedDraft);
    expect(calculated).toMatchObject({ status: "calculated", sale: { total: "0.0034" } });
    const html = renderToStaticMarkup(<TextUsageCalculation review={calculated} />);
    for (const text of ["非缓存输入", "缓存读取", "600", "400", "0.0034 积分"]) expect(html).toContain(text);
    const missing = renderToStaticMarkup(<TextUsageCalculation review={evaluateTextUsageDraft(draft.modelId, usage, cachedDraft)} />);
    expect(missing).toContain("需要明确读取和写入计数");
    const unsupported = renderToStaticMarkup(<TextUsageCalculation review={evaluateTextUsageDraft(draft.modelId, { ...cachedUsage, cacheWriteTokens: 2 }, cachedDraft)} />);
    expect(unsupported).toContain("检测到缓存写入"); expect(unsupported).toContain("费用待核对");
    const evidence = renderToStaticMarkup(<TextUsageEvidenceSummary usage={{ ...cachedUsage, cacheWriteTokens: 2 }} />);
    expect(evidence).toContain("缓存写入"); expect(evidence).toContain("2 Token");
});
