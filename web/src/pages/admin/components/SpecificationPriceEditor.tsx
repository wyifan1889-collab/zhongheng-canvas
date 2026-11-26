import { useState } from "react";
import { Button, Checkbox, Input, Modal, Select, Space, Table, Typography } from "antd";
import { PRICE_METERS, PRICE_PARAMETERS, PRICE_TEMPLATES, type ModelPriceRule, type ModelPriceRules, type PriceMeter, type PriceTemplate, type PricingCapability } from "@/services/saas/platform";
import { pairSpecificationCosts, replaceSpecificationUnit, specificationSample } from "./specification-pricing";
import type { GeminiImageOptions, GeminiImageSpecification } from "../../../../../packages/shared/src/generation-gemini-image";
import { GEMINI_IMAGE_PRICE_PARAMETERS } from "../../../../../packages/shared/src/model-pricing-drafts";

const labels: Record<string, string> = { size: "图片尺寸 / 分辨率", quality: "质量", mode: "模式", resolution: "视频分辨率", durationSeconds: "时长（秒）", generateAudio: "生成声音", aspectRatio: "文生比例", imageSize: "分辨率档位" };
const units: Partial<Record<PriceTemplate, string>> = { image_request: "按次（单张任务）", image_count: "按张", video_second: "按秒", video_count: "按整段视频" };
const videoOptions: Record<string, { value: string; label: string }[]> = {
    mode: [{ value: "text", label: "文生视频" }, { value: "first_frame", label: "一张首帧" }],
    resolution: ["480p", "720p", "1080p"].map(value => ({ value, label: value })),
    generateAudio: [{ value: "true", label: "生成声音" }, { value: "false", label: "不生成声音" }],
    aspectRatio: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].map(value => ({ value, label: value })),
};

export default function SpecificationPriceEditor({ capability, rules, disabled, gemini, onChange }: {
    capability: PricingCapability; rules: ModelPriceRules; disabled: boolean; onChange: (rules: ModelPriceRules) => void;
    gemini?: GeminiImageOptions | null;
}) {
    const cost = pairSpecificationCosts(rules);
    const [replacement, setReplacement] = useState<{ side: "cost" | "sale"; template: PriceTemplate; currency: ModelPriceRule["currency"] } | null>(null);
    if (cost === undefined) return null;
    const paired = { ...rules, cost };
    const native = gemini && rules.sale.template === "image_count" && (!cost || cost.template === "image_count") &&
        rules.sale.bands.every(band => !PRICE_PARAMETERS.image.some(key => Object.hasOwn(band.parameters, key))) ? gemini : null;
    const templates: PriceTemplate[] = capability === "image" ? native ? ["image_count"] : ["image_request", "image_count"] : ["video_second", "video_count"];
    const fields = native ? GEMINI_IMAGE_PRICE_PARAMETERS : PRICE_PARAMETERS[capability];
    const label = (key: string) => native && key === "aspectRatio" ? "画面比例" : labels[key];
    const editBand = (index: number, key: string, value: string) => {
        const update = (rule: ModelPriceRule) => ({ ...rule, bands: rule.bands.map((band, i) => {
            if (i !== index) return band;
            const parameters = { ...band.parameters }; if (value) parameters[key] = value; else delete parameters[key];
            return { ...band, parameters };
        }) });
        onChange({ ...paired, sale: update(paired.sale), cost: cost ? update(cost) : null });
    };
    const editRate = (side: "cost" | "sale", index: number, meter: PriceMeter, value: string) => {
        const rule = paired[side]; if (!rule) return;
        onChange({ ...paired, [side]: { ...rule, bands: rule.bands.map((band, i) => i === index ? { ...band, rates: { ...band.rates, [meter]: value === "" && side === "cost" ? null : value } } : band) } });
    };
    const changeRows = (transform: (rule: ModelPriceRule) => ModelPriceRule) => onChange({ ...paired, sale: transform(paired.sale), cost: cost ? transform(cost) : null });
    const changeUnit = (side: "cost" | "sale", template: PriceTemplate, currency: ModelPriceRule["currency"]) => setReplacement({ side, template, currency });
    return <Space orientation="vertical" className="w-full" size="middle">
        <Typography.Text type="secondary">每行是一种规格组合，成本和售价分别填写；两侧可以使用不同计量单位。参数按渠道实际支持的值填写，读取型号不会自动验证这些规格。</Typography.Text>
        <Space wrap>
            <span>用户售价</span><Select aria-label="规格售价单位" disabled={disabled} value={rules.sale.template} style={{ minWidth: 160 }} options={templates.map(value => ({ value, label: units[value] }))} onChange={value => changeUnit("sale", value, "credit")} />
            <Checkbox disabled={disabled} checked={!!cost} onChange={event => onChange({ ...paired, cost: event.target.checked ? replaceSpecificationUnit(paired.sale, paired.sale.template, "CNY") : null })}>录入渠道成本</Checkbox>
            {cost && <><Select aria-label="规格成本单位" disabled={disabled} value={cost.template} style={{ minWidth: 160 }} options={templates.map(value => ({ value, label: units[value] }))} onChange={value => changeUnit("cost", value, cost.currency)} />
                <Select aria-label="规格成本币种" disabled={disabled} value={cost.currency} options={[{ value: "CNY", label: "人民币 CNY" }, { value: "USD", label: "美元 USD" }]} onChange={value => changeUnit("cost", cost.template, value)} /></>}
        </Space>
        <Table rowKey="index" size="small" pagination={false} scroll={{ x: 920 }} dataSource={rules.sale.bands.map((band, index) => ({ ...band, index }))} columns={[
            { title: "规格", width: 60, render: (_, row) => row.index + 1 },
            ...fields.map(key => ({ title: label(key), width: 130, render: (_: unknown, row: { index: number; parameters: Record<string, string> }) => {
                const options = native ? native[key as keyof GeminiImageSpecification].map(value => ({ value, label: value })) : capability === "video" ? videoOptions[key] : undefined;
                const value = row.parameters[key];
                return options ? <Select className="w-full" allowClear disabled={disabled} virtual={!native} aria-label={`规格${row.index + 1}${label(key)}`} value={value} placeholder={capability === "video" && key === "aspectRatio" ? "首帧须留空" : "明确选择"}
                    options={value && !options.some(option => option.value === value) ? [...options, { value, label: `原值 ${value}（未支持）`, disabled: true }] : options}
                    onChange={next => editBand(row.index, key, next ?? "")} />
                    : <Input disabled={disabled} aria-label={`规格${row.index + 1}${labels[key]}`} inputMode={key === "durationSeconds" ? "decimal" : "text"} placeholder={capability === "video" && key === "durationSeconds" ? "显式整数 1–15" : key === "size" ? "例如 2K" : "不限"} value={value ?? ""} onChange={event => editBand(row.index, key, event.target.value)} />;
            } })),
            ...(["cost", "sale"] as const).flatMap(side => {
                const rule = paired[side]; return rule ? PRICE_TEMPLATES[rule.template].meters.map(meter => ({ title: `${side === "cost" ? "成本" : "售价"}（${rule.currency === "credit" ? "积分" : rule.currency}/${PRICE_METERS[meter].unit}）`, width: 150,
                    render: (_: unknown, row: { index: number }) => <Input aria-label={`规格${row.index + 1}${side === "cost" ? "成本" : "售价"}`} disabled={disabled} inputMode="decimal" placeholder={side === "cost" ? "未知" : "必填"} value={rule.bands[row.index].rates[meter] ?? ""} onChange={event => editRate(side, row.index, meter, event.target.value)} /> })) : [];
            }),
            { title: "单张 / 单段售价试算", width: 170, render: (_, row) => { const sample = specificationSample(rules.sale, row.index); return sample?.status === "calculated" && sample.total !== null ? `${sample.total} 积分` : <Typography.Text type="secondary">补齐规格和价格后计算</Typography.Text>; } },
            { title: "操作", width: 70, render: (_, row) => <Button type="text" danger disabled={disabled || rules.sale.bands.length === 1} onClick={() => changeRows(rule => ({ ...rule, bands: rule.bands.filter((_, i) => i !== row.index) }))}>移除</Button> },
        ]} />
        <Space wrap><Button disabled={disabled} onClick={() => changeRows(rule => ({ ...rule, bands: [...rule.bands, { parameters: {}, rates: Object.fromEntries(PRICE_TEMPLATES[rule.template].meters.map(meter => [meter, rule.currency === "credit" ? "" : null])) }] }))}>添加规格</Button>
            <Typography.Text type="secondary">每行条件同时匹配；不同规格不能重叠。成本留空代表未知，明确免费才填 0。试算不提交生成或扣费。</Typography.Text></Space>
        <Modal getContainer={false} open={replacement !== null} title="更换计量单位或币种？" okText="更换并重新填写金额" cancelText="保留现有输入" onCancel={() => setReplacement(null)} onOk={() => {
            if (replacement && !disabled && paired[replacement.side]) onChange({ ...paired, [replacement.side]: replaceSpecificationUnit(paired[replacement.side]!, replacement.template, replacement.currency) });
            setReplacement(null);
        }}><Typography.Paragraph>保留规格组合，清空本侧金额并重新填写；另一侧金额不变，不自动换算或更改已发布价格。</Typography.Paragraph></Modal>
    </Space>;
}
