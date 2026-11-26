import { Alert, Card, Collapse, Descriptions, Space, Table, Tag, Typography } from "antd";
import { PRICE_METERS, PRICE_TEMPLATES, type ModelPriceRule, type PriceMeter, type TaskPriceSnapshot } from "@/services/saas/platform";

const currencies = { CNY: "元（CNY）", USD: "美元（USD）", credit: "积分" };
const parameterLabels: Record<string, string> = { size: "尺寸", quality: "质量", mode: "模式", resolution: "分辨率", durationSeconds: "时长（秒）", aspectRatio: "比例", imageSize: "分辨率档位" };

function FixedRule({ title, rule }: { title: string; rule: ModelPriceRule | null }) {
    if (rule === null) return <Card size="small" title={title}><Typography.Text>受理时未配置成本，未知不按 0 计算。</Typography.Text></Card>;
    const rows = rule.bands.flatMap((band, index) => Object.entries(band.rates).map(([meter, rate]) => ({
        key: `${index}:${meter}`, meter: meter as PriceMeter, rate,
        parameters: Object.keys(band.parameters).length ? Object.entries(band.parameters).map(([key, value]) => `${parameterLabels[key] ?? key}：${value}`).join("；") : "无附加条件",
    })));
    return <Card size="small" title={title} extra={<Tag>{PRICE_TEMPLATES[rule.template].label}</Tag>}>
        <Table size="small" rowKey="key" pagination={false} scroll={{ x: true }} dataSource={rows} columns={[
            { title: "适用参数", dataIndex: "parameters" },
            { title: "计量项", dataIndex: "meter", render: (meter: PriceMeter) => PRICE_METERS[meter].label },
            { title: "受理时单价", dataIndex: "rate", render: (rate: string | null | undefined) => rate == null ? "未知" : rate },
            { title: "币种与计量单位", dataIndex: "meter", render: (meter: PriceMeter) => `${currencies[rule.currency]} / ${PRICE_METERS[meter].unit}` },
        ]} />
    </Card>;
}

/** Administrative immutable source only; current drafts and actual ledger stay separate. */
export default function AcceptedTaskPrice({ snapshot }: { snapshot: TaskPriceSnapshot }) {
    if (snapshot.status !== "recorded") return <Card size="small" title="受理时固定价目" extra={<Tag>只读来源</Tag>}>
        {snapshot.status === "not_recorded" ? <Typography.Paragraph className="!mb-0">此任务未记录完整价目来源，不能用当前草稿或最新价格补作历史快照。原任务报价、冻结记录和账本仍在下方独立展示。</Typography.Paragraph>
            : <Alert type="warning" showIcon title="固定价目来源未通过校验"
                description="暂不能按此来源核对成本或售价；请保留任务号核对原始记录，不使用当前草稿替代，也不能据此调整积分。" />}
    </Card>;
    return <Card size="small" title="受理时固定价目" extra={<Tag>只读来源</Tag>}>
                <Space orientation="vertical" className="w-full" size="middle">
                    <FixedRule title="配置成本规则" rule={snapshot.rules.cost} />
                    <FixedRule title="积分售价规则" rule={snapshot.rules.sale} />
                    <Typography.Paragraph className="!mb-0">当时的公开价格说明：{snapshot.publicPriceNote || "未填写"}</Typography.Paragraph>
                    <Collapse items={[{ key: "source", label: "查看价目来源与渠道", children: <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
                        { key: "publication", label: "发布记录编号", children: snapshot.publicationId },
                        { key: "price", label: "任务价格版本", children: snapshot.priceVersion },
                        { key: "draft", label: "来源草稿编号", children: snapshot.draftId },
                        { key: "version", label: "来源草稿版本", children: snapshot.draftVersion },
                        { key: "published", label: "价目发布时间", children: new Date(snapshot.publishedAt).toLocaleString() },
                        { key: "provider", label: "受理时渠道ID", children: snapshot.binding.providerId },
                        { key: "model", label: "受理时上游型号", children: snapshot.binding.providerModel },
                        { key: "adapter", label: "受理时接口协议", children: snapshot.binding.adapter },
                        { key: "endpoint", label: "受理时渠道地址", children: <Typography.Text className="break-all">{snapshot.binding.endpoint}</Typography.Text> },
                    ]} /> }]} />
                    <Typography.Text type="secondary">本任务使用受理时价目，后续改价不会替换。实际扣款见下方账本；配置成本不代表供应商账单，币种不自动换算。</Typography.Text>
                </Space>
    </Card>;
}
