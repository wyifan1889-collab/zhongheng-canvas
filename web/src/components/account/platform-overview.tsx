import { useEffect, useState } from "react";
import { Card, Col, List, Row, Space, Typography as AntTypography } from "antd";
import { ChevronDown } from "lucide-react";
import { Alert, Empty, Spin, Tag, Typography } from "@/components/creation/ui";
import { useCreationUi } from "@/components/creation/ui/context";

import { fetchPlatformModels, fetchPlatformPricing, fetchPlatformWallet, type PlatformModel, type PlatformPricing, type PlatformWallet } from "@/services/saas/platform";
import { fetchPublicOfficialPriceReferences, type PublicOfficialPriceReference } from "@/services/saas/official-price-references";
import type { DraftAccountScope } from "@/services/saas/drafts";
import { useAccountStore } from "@/stores/use-account-store";
import { OfficialPriceReference } from "./official-price-reference";
import { ImageSpecPriceLines } from "./image-spec-price-lines";
import { VideoSpecPriceLines } from "./video-spec-price-lines";

const capabilityLabels: Record<PlatformModel["capability"], string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };

export function PlatformPriceDetails({ price }: { price: PlatformPricing }) {
    return <div className="space-y-1 break-words text-sm tabular-nums">
        {price.billingUnit === "video_specs" ? <><VideoSpecPriceLines price={price} /><Typography.Text type="secondary">选择完整视频规格并确认本次报价后才会生成；仅已交付的视频按每条价格结算。</Typography.Text></>
            : price.billingUnit === "image_specs" ? <><ImageSpecPriceLines price={price} /><Typography.Text type="secondary">实际可用模型与规格以原画布平台目录为准；选择完整组合并确认本次报价后才会生成。</Typography.Text></>
            : price.billingUnit === "text_tokens" ? <><Typography.Text type="secondary">已发布报价费率基准</Typography.Text><div>{price.cachedInputCreditsPerMillion === undefined ? "输入" : "非缓存输入"} {price.inputCreditsPerMillion} 积分 / 百万 Token</div>{price.cachedInputCreditsPerMillion !== undefined && <div>缓存读取 {price.cachedInputCreditsPerMillion} 积分 / 百万 Token</div>}<div>输出 {price.outputCreditsPerMillion} 积分 / 百万 Token</div>
            <Typography.Text type="secondary">{price.cachedInputCreditsPerMillion === undefined ? "缓存读取已含输入，推理已含输出，不重复计量。" : "输入总量先减缓存读取，剩余按非缓存输入计价；缓存读取和输出分别计价。需明确读取和写入计数且写入为 0，否则费用待核对。"}</Typography.Text></>
            : <div>{price.creditsPerUnit} 积分 / {{ request: "次", input_token: "输入 Token", output_token: "输出 Token", second: "秒", megapixel: "百万像素" }[price.billingUnit]}</div>}
        <Typography.Text type="secondary">价格版本 {price.version}</Typography.Text>
        {price.textPriceDerivation && <div><Typography.Text type="secondary">官方基价 × 渠道模型倍率 {price.textPriceDerivation.saleMultiplier} × 100 积分（USD:CNY 数值 1:1）；来源 {price.textPriceDerivation.sourceId} · 基准版本 {price.textPriceDerivation.sourceVersion}。</Typography.Text></div>}
        {price.priceNote ? <div className="whitespace-pre-wrap">{price.priceNote}</div> : null}
        {price.capability === "text" ? <div><Typography.Text type="secondary">是否可生成以原画布实时可用目录和正式报价为准；确认预算后才会冻结积分，实际费用按原任务价格版本核算。</Typography.Text></div> : null}
    </div>;
}

export function usePlatformOverview() {
    const account = useAccountStore(), scope = account.getDraftScope();
    const [overview, setOverview] = useState<({ scope: DraftAccountScope } & (
        { status: "loading" | "unavailable" }
        | { status: "ready"; wallet: PlatformWallet; models: PlatformModel[]; pricing: PlatformPricing[] }
    )) | null>(null);
    const [references, setReferences] = useState<PublicOfficialPriceReference[] | null>(null), [referenceFailed, setReferenceFailed] = useState(false);
    useEffect(() => {
        const operation = new AbortController(), accountId = scope?.accountId, epoch = scope?.epoch, status = account.status, busy = account.busy;
        const current = () => { const state = useAccountStore.getState(), now = state.getDraftScope(); return !operation.signal.aborted && state.status === status && state.busy === busy && now?.accountId === accountId && now?.epoch === epoch; };
        setReferences(null); setReferenceFailed(false);
        void fetchPublicOfficialPriceReferences({ signal: operation.signal, isCurrent: current }).then(items => { if (items && current()) setReferences(items); })
            .catch(() => { if (current()) setReferenceFailed(true); });
        return () => operation.abort();
    }, [scope?.accountId, scope?.epoch, account.status, account.busy]);

    useEffect(() => {
        if (!scope) return;
        let active = true;
        const current = () => {
            const now = useAccountStore.getState().getDraftScope();
            return active && now?.accountId === scope.accountId && now.epoch === scope.epoch;
        };
        if (!current()) return;
        setOverview({ scope, status: "loading" });
        void Promise.all([fetchPlatformWallet(), fetchPlatformModels(), fetchPlatformPricing()]).then(([nextWallet, nextModels, nextPricing]) => {
            if (current()) setOverview({ scope, status: "ready", wallet: nextWallet, models: nextModels, pricing: nextPricing });
        }).catch(() => {
            if (current()) setOverview({ scope, status: "unavailable" });
        });
        return () => { active = false; };
    }, [scope?.accountId, scope?.epoch]);

    // Guard the render too: effects run after the first frame of a changed account.
    const current = scope && overview?.scope.accountId === scope.accountId && overview.scope.epoch === scope.epoch ? overview : null;
    return { current, references, referenceFailed };
}

export function PlatformModelCatalog({ models, pricing, references, referenceFailed }: {
    models: PlatformModel[]; pricing: PlatformPricing[]; references: PublicOfficialPriceReference[] | null; referenceFailed: boolean;
}) {
    if (!models.length) return <Empty description="管理员尚未发布可用模型" />;
    return <div className="divide-y divide-border">{models.map(model => <details key={model.id} className="group py-4">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1 break-words text-sm font-medium">{model.displayName}</span>
            <Tag>{capabilityLabels[model.capability]}</Tag>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className={`mt-4 ${model.capability === "text" ? "grid gap-6 md:grid-cols-2" : "min-w-0"}`}>
            <div className="min-w-0 space-y-2"><h3 className="m-0 text-sm font-semibold">平台积分价</h3>
                {pricing.filter(price => price.modelId === model.id && price.capability === model.capability).map(price => <PlatformPriceDetails key={`${price.modelId}-${price.version}`} price={price} />)}
            </div>
            {model.capability === "text" ? <div className="min-w-0 space-y-2"><h3 className="m-0 text-sm font-semibold">官方参考价 · USD</h3>
                {(() => { const reference = references?.find(item => item.modelId === model.id); return reference ? <OfficialPriceReference {...reference} />
                    : <Typography.Text type="secondary">{referenceFailed ? "官方参考价暂时无法读取；平台价目与余额不受影响。" : references === null ? "正在读取官方参考价…" : "暂无有效官方对照；可能尚未设置、型号绑定已变化或来源未收录，未知不按 0 处理。"}</Typography.Text>; })()}
            </div> : null}
        </div>
    </details>)}</div>;
}

export function PlatformOverview() {
    const owned = useCreationUi();
    const { current, references, referenceFailed } = usePlatformOverview();
    if (!current || current.status === "loading") return owned
        ? <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4"><Spin size="small" /><Typography.Text type="secondary">正在读取平台余额和模型目录…</Typography.Text></div>
        : <Card size="small"><Spin size="small" /> <Typography.Text type="secondary">正在读取平台余额和模型目录…</Typography.Text></Card>;
    if (current.status !== "ready") return <Alert type="info" showIcon title="平台余额和模型目录尚未接通" description="账户登录已可用；生成网关、充值和管理员配置仍在接入中。" />;
    const { wallet, models, pricing } = current;

    if (owned) return <section aria-label="平台服务" className="min-w-0 rounded-xl border border-border bg-card text-card-foreground">
        <h2 className="m-0 border-b border-border px-4 py-3 text-base font-semibold">平台服务</h2>
        <div className="space-y-5 p-4">
            <div>
                <div className="text-sm text-muted-foreground">积分余额</div>
                <p className="mb-1 mt-2 break-all text-xl font-semibold tabular-nums">{wallet?.availableUnits ?? "—"} 积分</p>
                <p className="m-0 break-all text-sm text-muted-foreground tabular-nums">冻结中 {wallet?.reservedUnits ?? "—"} 积分，充值功能尚未开放。</p>
            </div>
            <div>
                <h3 className="m-0 text-sm font-medium text-muted-foreground">平台模型目录</h3>
                {models.length ? <ul className="m-0 list-none divide-y divide-border p-0">{models.map(model => <li key={model.id} className="space-y-3 py-4">
                    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-words font-semibold">{model.displayName}</span><Tag>{capabilityLabels[model.capability]}</Tag></div>
                    <div className={model.capability === "text" ? "grid gap-4 md:grid-cols-2" : "min-w-0"}>
                        <div className="min-w-0 space-y-2"><h4 className="m-0 text-sm font-semibold">平台积分价</h4>
                            {pricing.filter(price => price.modelId === model.id && price.capability === model.capability).map(price => <PlatformPriceDetails key={`${price.modelId}-${price.version}`} price={price} />)}
                        </div>
                        {model.capability === "text" ? <div className="min-w-0 space-y-2"><h4 className="m-0 text-sm font-semibold">官方参考价 · USD</h4>
                            {(() => { const reference = references?.find(item => item.modelId === model.id); return reference ? <OfficialPriceReference {...reference} />
                                : <Typography.Text type="secondary">{referenceFailed ? "官方参考价暂时无法读取；平台价目与余额不受影响。" : references === null ? "正在读取官方参考价…" : "暂无有效官方对照；可能尚未设置、型号绑定已变化或来源未收录，未知不按 0 处理。"}</Typography.Text>; })()}
                        </div> : null}
                    </div>
                </li>)}</ul> : <Empty description="管理员尚未发布可用模型" />}
            </div>
        </div>
    </section>;

    return <Card size="small" title="平台服务">
        <Space orientation="vertical" size="middle" className="w-full">
            <div>
                <Typography.Text type="secondary">积分余额</Typography.Text>
                <AntTypography.Title level={4} className="!mb-0 break-all tabular-nums">{wallet?.availableUnits ?? "—"} 积分</AntTypography.Title>
                <Typography.Text type="secondary" className="break-all tabular-nums">冻结中 {wallet?.reservedUnits ?? "—"} 积分，充值功能尚未开放。</Typography.Text>
            </div>
            <div>
                <Typography.Text type="secondary">平台模型目录</Typography.Text>
                {models.length ? <List size="small" dataSource={models} renderItem={(model) => <List.Item>
                    <div className="w-full space-y-2"><div><Typography.Text strong>{model.displayName}</Typography.Text> <Tag>{capabilityLabels[model.capability]}</Tag></div>
                    <Row gutter={[24, 12]}><Col xs={24} md={model.capability === "text" ? 12 : 24}><Typography.Paragraph className="!mb-1" strong>平台积分价</Typography.Paragraph>
                        {pricing.filter((price) => price.modelId === model.id && price.capability === model.capability).map((price) => <PlatformPriceDetails key={`${price.modelId}-${price.version}`} price={price} />)}</Col>
                        {model.capability === "text" ? <Col xs={24} md={12}><Typography.Paragraph className="!mb-1" strong>官方参考价 · USD</Typography.Paragraph>
                            {(() => { const reference = references?.find(item => item.modelId === model.id); return reference ? <OfficialPriceReference {...reference} />
                                : <Typography.Text type="secondary">{referenceFailed ? "官方参考价暂时无法读取；平台价目与余额不受影响。" : references === null ? "正在读取官方参考价…" : "暂无有效官方对照；可能尚未设置、型号绑定已变化或来源未收录，未知不按 0 处理。"}</Typography.Text>; })()}</Col> : null}
                    </Row></div>
                </List.Item>} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="管理员尚未发布可用模型" />}
            </div>
        </Space>
    </Card>;
}
