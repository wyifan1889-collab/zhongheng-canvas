import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Space, Table, Tag, Typography } from "antd";
import { createAdminTextUsageDraftReview, getAdminGenerationScope, PRICE_METERS,
    type AdminGenerationScope, type AdminTextUsageDraftState, type PriceSampleResult, type TextUsageDraftReview, type TextUsageEvidence } from "@/services/saas/platform";

const reasons: Record<NonNullable<TextUsageEvidence["reason"]>, string> = {
    missing_usage: "上游未返回用量", missing_counts: "输入或输出计数缺失", invalid_counts: "计数格式无效",
    conflicting_counts: "同类计数字段相互冲突", inconsistent_total: "总量与输入、输出不一致", invalid_details: "缓存或推理子项无效",
};
const blockedReasons = {
    missing_usage: "缺少当前模板所需的完整用量，不能试算；缓存读取三项还需要明确读取和写入计数。", invalid_usage: "用量未通过校验，不能试算。",
    model_mismatch: "草稿与任务模型不一致，不能试算。", binding_changed: "草稿的渠道绑定已变化，请先核对并保存新草稿。",
    invalid_draft: "草稿不符合文本输入、输出计量规则，不能试算。",
    unsupported_usage: "检测到缓存写入，当前三项模板不支持该项收费，费用待核对。",
};
const count = (value: number | null) => value === null ? "未记录" : `${value} Token`;
const currency = (value: string) => value === "credit" ? "积分" : value === "CNY" ? "元（CNY）" : "美元（USD）";

export function TextUsageEvidenceSummary({ usage }: { usage: TextUsageEvidence | null }) {
    return <Space orientation="vertical" className="w-full">
        {usage === null ? <Typography.Text>未记录文本用量证据，不代表用量为 0。</Typography.Text> : <>
            <Tag>{usage.status === "complete" ? "输入、输出计数校验完整" : usage.status === "missing" ? "用量不完整" : "用量校验未通过"}</Tag>
            {usage.reason ? <Alert type="warning" showIcon title={reasons[usage.reason]} /> : null}
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
                { key: "input", label: "输入总量", children: count(usage.inputTokens) },
                { key: "output", label: "输出总量", children: count(usage.outputTokens) },
                { key: "cache", label: "其中缓存输入（已含输入）", children: count(usage.cachedInputTokens) },
                { key: "cache-write", label: "缓存写入", children: count(usage.cacheWriteTokens ?? null) },
                { key: "reasoning", label: "其中推理输出（已含输出）", children: count(usage.reasoningOutputTokens) },
                { key: "total", label: "总量", children: count(usage.totalTokens) },
                { key: "source", label: "总量来源", children: usage.totalSource === "reported" ? "上游返回" : usage.totalSource === "derived" ? "由输入与输出相加得到" : "未记录" },
            ]} />
        </>}
        <Typography.Text type="secondary">证据来源为平台保存的 {usage?.source === "responses" ? "Responses" : "Chat Completions"} 返回计数；格式与一致性校验不代表已核实供应商账单。缓存读取与推理是包含子项，不再加到输入、输出总量中。缓存三项计费需明确读取和写入计数，写入必须为 0；未知不补零。</Typography.Text>
    </Space>;
}

function SampleLines({ label, value }: { label: string; value: PriceSampleResult | null }) {
    if (value === null) return <Typography.Paragraph>{label}：尚未录入成本，不按 0 估算。</Typography.Paragraph>;
    if (value.status !== "calculated") return <Typography.Paragraph>{label}：当前用量或草稿不能计算。</Typography.Paragraph>;
    return <Space orientation="vertical" className="w-full">
        <Typography.Text strong>{label}：{value.total === null ? "包含未知单价，合计未知" : `${value.total} ${currency(value.currency)}`}</Typography.Text>
        <Table size="small" rowKey="meter" pagination={false} scroll={{ x: true }} dataSource={value.lines} columns={[
            { title: "计量项", dataIndex: "meter", render: (meter: keyof typeof PRICE_METERS) => meter === "input_token" && value.lines.some(line => line.meter === "cached_input_token") ? "非缓存输入" : PRICE_METERS[meter].label },
            { title: "用量（Token）", dataIndex: "quantity" },
            { title: `单价（${currency(value.currency)} / 百万 Token）`, dataIndex: "rate", render: (rate: string | null) => rate ?? "未知" },
            { title: `分项试算（${currency(value.currency)}）`, dataIndex: "total", render: (total: string | null) => total ?? "未知" },
        ]} />
    </Space>;
}

export function TextUsageCalculation({ review }: { review: TextUsageDraftReview }) {
    if (review.status === "blocked") return <Alert type="warning" showIcon title={blockedReasons[review.reason]} />;
    return <Space orientation="vertical" className="w-full" size="middle">
        <Typography.Text strong>按草稿版本 {review.draftVersion} 试算（非任务历史价格）</Typography.Text>
        <SampleLines label="配置成本试算" value={review.cost} />
        <SampleLines label="积分售价试算" value={review.sale} />
        <Typography.Text type="secondary">双项模板按全部输入与全部输出各计算一次；缓存三项模板先从输入总量扣除缓存读取，再分别计价。推理已含输出；成本保留原币种，不换算或计算利润。本结果不是实际扣款或供应商账单，实际积分仍以该任务的冻结记录和账本为准。</Typography.Text>
    </Space>;
}

export default function TextUsageReview({ scope, modelId, usage }: { scope: AdminGenerationScope; modelId: string; usage: TextUsageEvidence | null }) {
    const [state, setState] = useState<AdminTextUsageDraftState>({ status: "idle" });
    const controller = useRef<ReturnType<typeof createAdminTextUsageDraftReview> | null>(null);
    useLayoutEffect(() => {
        const owner = createAdminTextUsageDraftReview({ scope, getScope: getAdminGenerationScope, modelId, usage, onState: setState });
        setState({ status: "idle" });
        controller.current = owner;
        return () => { owner.close(); if (controller.current === owner) controller.current = null; };
    // Parent keys this component to one displayed task and one administrator epoch.
    }, [scope.accountId, scope.epoch, modelId, usage]);
    const draft = state.status === "ready" ? state.draft : null;
    return <Card size="small" title="文本用量与草稿试算" extra={<Tag>只读核对</Tag>}>
        <Space orientation="vertical" className="w-full" size="middle">
            <TextUsageEvidenceSummary usage={usage} />
            <Typography.Paragraph className="!mb-0" type="secondary">仅适用于文本任务。手动读取任务同模型的已保存草稿，再明确试算；所选草稿不是任务受理时的历史价格，读取和试算不会发布价格、生成文本或调整积分。</Typography.Paragraph>
            <Button loading={state.status === "loading"} disabled={state.status === "loading"} onClick={() => { void controller.current?.read(); }}>读取同模型已保存文本草稿</Button>
            {state.status === "error" ? <Alert type="error" showIcon title="草稿核对未完成" description={state.message} /> : null}
            {draft ? <>
                <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
                    { key: "id", label: "草稿编号", children: draft.id }, { key: "version", label: "草稿版本", children: draft.version },
                    { key: "model", label: "公开模型ID", children: draft.modelId }, { key: "provider", label: "渠道ID", children: draft.binding.providerId },
                    { key: "upstream", label: "上游型号", children: draft.binding.providerModel }, { key: "adapter", label: "接口协议", children: draft.binding.adapter },
                    { key: "endpoint", label: "渠道地址", children: <Typography.Text className="break-all">{draft.binding.endpoint}</Typography.Text> },
                    { key: "binding", label: "与当前目录绑定", children: draft.bindingMatchesCurrent ? "一致（不代表该任务历史绑定）" : "已变化，请先核对" },
                ]} />
                <Button onClick={() => controller.current?.calculate()}>使用此草稿只读试算</Button>
                {state.status === "ready" && state.calculation ? <TextUsageCalculation review={state.calculation} /> : null}
            </> : null}
        </Space>
    </Card>;
}
