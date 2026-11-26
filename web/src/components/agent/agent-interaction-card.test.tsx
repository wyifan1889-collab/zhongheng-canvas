import { expect, test } from "bun:test";
import { ConfigProvider } from "antd";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import i18n from "@/i18n";
import type { AgentInteraction, AgentInteractionView } from "@/lib/agent/agent-interactions";
import { canvasThemes } from "@/lib/canvas-theme";
import { AgentGenerationConfirmCard, AgentInteractionCard, type AgentInteractionCardProps } from "./agent-interaction-card";
import { AgentQuestionCard } from "./agent-question-card";
import { AgentProposalCard } from "./agent-proposal-card";

const base = { id: "request-1", streamId: "stream-1", threadId: "thread-1", conversationId: "conversation-1", sourceTurnId: "turn-1", sourceClientId: "client-1", ownerContext: "local", projectId: "project-1", revision: 1, status: "pending" as const };
const proposal: AgentInteraction = { ...base, kind: "proposal", input: { proposalId: base.id, summary: "先确认这份方案", actions: ["创建图片节点", "按布局连接"], estimatedCost: 12.5 } };
const question: AgentInteraction = { ...base, kind: "question", input: { questionId: base.id, question: "希望使用什么风格？", placeholder: "例如水彩" } };
const generation: AgentInteraction = { ...base, kind: "generation_confirm", input: { confirmId: base.id, description: "生成两张图片", estimatedCost: 0 } };
const decide = () => {};

function render(view: AgentInteractionView, props: Partial<AgentInteractionCardProps> = {}, Card: ComponentType<AgentInteractionCardProps> = AgentInteractionCard) {
    return renderToStaticMarkup(<ConfigProvider theme={{ token: { colorSuccess: "#135724" } }}><Card view={view} theme={canvasThemes.dark} onDecision={decide} {...props} /></ConfigProvider>);
}

function interactiveButtons(html: string) {
    return html.match(/<button\b[^>]*>/g) || [];
}

test("T5/T6/T7 proposal preserves summary, actions, estimate disclaimer and theme success color", () => {
    const html = render({ record: proposal, authoritative: true });
    expect(html).toContain('data-agent-interaction="proposal"');
    expect(html).toContain("先确认这份方案");
    expect(html).toContain("创建图片节点");
    expect(html).toContain("按布局连接");
    expect(html).toContain("预估 12.5 积分");
    expect(html).toContain("模型预估仅供参考，不代表正式报价或扣费授权。");
    expect(html).toContain("同意方案");
    expect(html).toContain("拒绝方案");
    expect(html).toContain('aria-label="拒绝原因"');
    expect(html).toContain("#135724");
    expect(html).not.toContain("ant-btn-dangerous");
    expect(interactiveButtons(html)).toHaveLength(2);
});

test("T6 proposal omits optional estimate and its disclaimer together", () => {
    const record: AgentInteraction = { ...proposal, kind: "proposal", input: { proposalId: base.id, summary: "无估价方案", actions: [] } };
    const html = render({ record, authoritative: true });
    expect(html).toContain("无估价方案");
    expect(html).not.toContain("积分");
    expect(html).not.toContain("扣费授权");
});

test("T7 extracted proposal card binds its authority aliases and displays a zero estimate", () => {
    const record: AgentInteraction = { ...proposal, kind: "proposal", input: { ...proposal.input, estimatedCost: 0 } };
    let decisions = 0, decided = 0;
    const html = renderToStaticMarkup(<ConfigProvider><AgentProposalCard view={{ record, authoritative: true }} theme={canvasThemes.dark} proposalId={record.id} summary={record.input.summary} estimatedCost={0} onDecision={() => { decisions++; }} onDecided={() => { decided++; }} /></ConfigProvider>);
    expect(html).toContain("预估 0 积分");
    expect(html).toContain("创建图片节点");
    expect(html).toContain("按布局连接");
    expect(html).toContain("同意方案");
    expect(html).toContain("拒绝方案");
    expect(interactiveButtons(html)).toHaveLength(2);
    expect(decisions).toBe(0);
    expect(decided).toBe(0);
});

test("T7 unknown rejection restores its read-only reason and exposes only GET reconciliation", () => {
    let decisions = 0, decided = 0;
    const view: AgentInteractionView = { record: proposal, authoritative: true, submission: "unknown", proposalReasonDraft: "请保留原构图", error: "POST result unknown" };
    const html = renderToStaticMarkup(<ConfigProvider><AgentProposalCard view={view} theme={canvasThemes.dark} proposalId={proposal.id} summary={proposal.input.summary} estimatedCost={proposal.input.estimatedCost} onDecision={() => { decisions++; }} onReconcile={() => {}} onDecided={() => { decided++; }} /></ConfigProvider>);
    expect(html).toContain("请保留原构图");
    expect(html).toContain('readOnly=""');
    expect(html).toContain("POST result unknown");
    expect(html).toContain("核对处理结果");
    expect(html).not.toContain("同意方案");
    expect(html).not.toContain("拒绝方案");
    expect(interactiveButtons(html)).toHaveLength(1);
    expect(decisions).toBe(0);
    expect(decided).toBe(0);
});

test("T7 proposal aliases cannot substitute another id, summary or estimate", () => {
    for (const patch of [{ proposalId: "another-proposal" }, { summary: "another summary" }, { estimatedCost: 0 }]) {
        const html = renderToStaticMarkup(<ConfigProvider><AgentProposalCard view={{ record: proposal, authoritative: true }} theme={canvasThemes.dark} proposalId={proposal.id} summary={proposal.input.summary} estimatedCost={proposal.input.estimatedCost} onDecision={decide} onDecided={() => {}} {...patch} /></ConfigProvider>);
        expect(html).toBe("");
    }
});

test("T6 question uses one single-line input, the fixed placeholder and a disabled blank submit", () => {
    const html = render({ record: question, authoritative: true });
    expect(html).toContain("希望使用什么风格？");
    expect(html).toContain('aria-label="你的回答"');
    expect(html).toContain('placeholder="输入你的回答…"');
    expect(html).toContain('lucide-circle-question-mark');
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html).not.toContain("textarea");
    expect(html).toContain("提交回答");
    expect(interactiveButtons(html)).toHaveLength(1);
    expect(interactiveButtons(html)[0]).toContain("disabled");
});

test("unknown question remount restores its read-only draft and exposes only the original GET reconciliation", () => {
    let decisions = 0, answered = 0;
    const view: AgentInteractionView = { record: question, authoritative: true, submission: "unknown", answerDraft: "保留的水彩回答", error: "POST result unknown" };
    const html = renderToStaticMarkup(<ConfigProvider><AgentQuestionCard view={view} theme={canvasThemes.dark} questionId={question.id} text={question.input.question} onDecision={() => { decisions++; }} onReconcile={() => {}} onAnswered={() => { answered++; }} /></ConfigProvider>);
    expect(html).toContain('value="保留的水彩回答"');
    expect(html).toContain('readOnly=""');
    expect(html).toContain("POST result unknown");
    expect(html).toContain("核对处理结果");
    expect(html).not.toContain("提交回答");
    expect(interactiveButtons(html)).toHaveLength(1);
    expect(decisions).toBe(0);
    expect(answered).toBe(0);
});

test("question identity aliases cannot render controls for a different authority record", () => {
    const html = renderToStaticMarkup(<ConfigProvider><AgentQuestionCard view={{ record: question, authoritative: true }} theme={canvasThemes.dark} questionId="other-question" text={question.input.question} onDecision={decide} onAnswered={() => {}} /></ConfigProvider>);
    expect(html).toBe("");
});

test("T5 generation confirmation shares decision styling and keeps a zero estimate visible", () => {
    const html = render({ record: generation, authoritative: true }, {}, AgentGenerationConfirmCard);
    expect(html).toContain('data-agent-interaction="generation_confirm"');
    expect(html).toContain("生成两张图片");
    expect(html).toContain("预估 0 积分");
    expect(html).toContain("确认生成");
    expect(html).toContain("取消生成");
    expect(html).not.toContain("textarea");
    expect(interactiveButtons(html)).toHaveLength(2);
});

test("history-only cards are expired and cannot expose decisions for any kind", () => {
    for (const record of [proposal, question, generation]) {
        const html = render({ record, authoritative: false });
        expect(html).toContain("请求已失效，无法继续操作");
        expect(html).not.toContain("textarea");
        expect(interactiveButtons(html)).toHaveLength(0);
    }
});

test("every settled or in-flight status preserves card content and removes decision controls", () => {
    const labels = { queued: "已记录决定，等待当前轮次结束后续接", continuing: "正在原对话中续接", completed: "续接轮次已完成，不代表生成交付或扣款成功", expired: "请求已失效，无法继续操作", continuation_failed: "续接失败，未自动重试" } as const;
    for (const [status, label] of Object.entries(labels)) {
        const html = render({ record: { ...proposal, status: status as AgentInteraction["status"] }, authoritative: true });
        expect(html).toContain("先确认这份方案");
        expect(html).toContain(label);
        expect(interactiveButtons(html)).toHaveLength(0);
    }
});

test("pending submissions are read-only and render without submitting from render", () => {
    let decisions = 0;
    const html = render({ record: generation, authoritative: true, submission: "submitting" }, { onDecision: () => { decisions += 1; } });
    expect(html).toContain("正在提交决定…");
    expect(interactiveButtons(html)).toHaveLength(0);
    expect(decisions).toBe(0);
});

test("unknown submission offers only read-only reconciliation and never resubmits during render", () => {
    let decisions = 0, reconciliations = 0;
    const html = render({ record: proposal, authoritative: true, submission: "unknown", error: "连接中断，尚未确认" }, { onDecision: () => { decisions += 1; }, onReconcile: () => { reconciliations += 1; } });
    expect(html).toContain("提交结果待核对");
    expect(html).toContain("连接中断，尚未确认");
    expect(html).toContain("核对处理结果");
    expect(html).not.toContain("同意方案");
    expect(html).not.toContain("拒绝方案");
    expect(html).not.toContain("textarea");
    expect(interactiveButtons(html)).toHaveLength(1);
    expect(decisions).toBe(0);
    expect(reconciliations).toBe(0);
});

test("a rejected proposal preserves the outcome and the rejection reason", () => {
    const record: AgentInteraction = { ...proposal, kind: "proposal", status: "queued", decision: { approved: false, reason: "请调整构图" } };
    const html = render({ record, authoritative: true });
    expect(html).toContain("已拒绝方案");
    expect(html).toContain("原因：请调整构图");
    expect(interactiveButtons(html)).toHaveLength(0);
});

test("an answered question preserves the original question and submitted answer", () => {
    const record: AgentInteraction = { ...question, kind: "question", status: "completed", decision: { answer: "水彩\n暖色" } };
    const html = render({ record, authoritative: true });
    expect(html).toContain("希望使用什么风格？");
    expect(html).toContain("已回答：水彩\n暖色");
    expect(html).not.toContain("textarea");
    expect(interactiveButtons(html)).toHaveLength(0);
});

test("automatic confirmation and manual cancellation stay visible without interactive confirmation", () => {
    const automatic: AgentInteraction = { ...generation, kind: "generation_confirm", status: "queued", decision: { confirmed: true, decisionSource: "auto" } };
    const canceled: AgentInteraction = { ...generation, kind: "generation_confirm", status: "continuing", decision: { confirmed: false, decisionSource: "manual" } };
    expect(render({ record: automatic, authoritative: true })).toContain("已自动确认生成");
    expect(render({ record: canceled, authoritative: true })).toContain("已取消生成");
    expect(interactiveButtons(render({ record: automatic, authoritative: true }))).toHaveLength(0);
    expect(interactiveButtons(render({ record: canceled, authoritative: true }))).toHaveLength(0);
});

test("authority alone does not enable a card without an available action callback", () => {
    expect(interactiveButtons(render({ record: proposal, authoritative: true }, { onDecision: undefined }))).toHaveLength(0);
});

test("model strings and errors are rendered as escaped text", () => {
    const record: AgentInteraction = { ...question, kind: "question", input: { questionId: base.id, question: '<script>alert("question")</script>' }, status: "continuation_failed", error: "<img src=x onerror=alert(1)>" };
    const html = render({ record, authoritative: true });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
});

test("English interaction labels resolve without exposing untranslated keys", () => {
    const previous = i18n.language;
    i18n.changeLanguage("en-US");
    try {
        const html = render({ record: generation, authoritative: true });
        expect(html).toContain("Generation confirmation");
        expect(html).toContain("Estimated 0 credits");
        expect(html).not.toContain("agent.interactions.");
    } finally { i18n.changeLanguage(previous); }
});
