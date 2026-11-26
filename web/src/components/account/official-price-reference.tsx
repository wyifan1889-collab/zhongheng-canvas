import { Typography as AntTypography } from "antd";
import { Tag, Typography } from "@/components/creation/ui";
import { useCreationUi } from "@/components/creation/ui/context";
import { OFFICIAL_PRICE_SOURCES, type OfficialPriceEntry, type OfficialPriceSource, type OfficialPriceSourceId } from "@/services/saas/official-price-references";

export function OfficialPriceSourceUpdates({ sources }: { sources: OfficialPriceSource[] }) {
    const updated = sources.filter(source => source.changedEntryIds.length > 0);
    return updated.length ? <div role="status" className="space-y-1">{updated.map(source => <div key={source.id}>
        <Tag color="blue">官方目录更新</Tag><Typography.Text>{OFFICIAL_PRICE_SOURCES[source.id].name}：{source.changedEntryIds.length} 项参考条目有变化{source.changedAt ? `（${new Date(source.changedAt).toLocaleString()}）` : ""}，可选择型号查看；平台售价未随之修改。</Typography.Text>
    </div>)}</div> : null;
}

export function OfficialPriceReference({ sourceId, entry, version, checkedAt, changedAt, stale, changed = false }: {
    sourceId: OfficialPriceSourceId; entry: OfficialPriceEntry; version: number; checkedAt: string; changedAt: string | null; stale: boolean; changed?: boolean;
}) {
    const owned = useCreationUi();
    const source = OFFICIAL_PRICE_SOURCES[sourceId];
    return <div className="space-y-2 break-words text-sm">
        <div><Typography.Text strong>{source.name} · {entry.modelName}</Typography.Text> <Tag>官方参考 · USD</Tag>{stale ? <Tag color="orange">旧参考价，最近核对未成功</Tag> : null}{changed ? <Tag color="blue">此条目有更新</Tag> : null}</div>
        <Typography.Paragraph className="!mb-0">{entry.context}</Typography.Paragraph>
        <dl className="m-0 space-y-1 tabular-nums">{entry.rates.map(rate => <div className="flex flex-wrap justify-between gap-x-4" key={rate.label}><dt>{rate.label}</dt><dd className="m-0">{rate.usdPerMillion === null ? "官方未提供 / 不适用" : `${rate.usdPerMillion} USD / 百万 Token`}</dd></div>)}</dl>
        <Typography.Paragraph type="secondary" className="!mb-0">参考版本 {version} · 最近成功核对：{new Date(checkedAt).toLocaleString()}{changedAt ? ` · 来源最近变更：${new Date(changedAt).toLocaleString()}` : ""}</Typography.Paragraph>
        {owned ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-block rounded text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看官方来源</a> : <AntTypography.Link href={source.url} target="_blank" rel="noopener noreferrer">查看官方来源</AntTypography.Link>}
        <Typography.Paragraph type="secondary" className="!mb-0">美元官方价与平台积分价分别列示；未作汇率换算，不计算折扣。缓存读写按官方条件分别展示，不与包含它们的输入量重复相加。参考更新不会改动平台售价。</Typography.Paragraph>
    </div>;
}
