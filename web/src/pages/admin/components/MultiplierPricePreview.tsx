import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Col, Input, Modal, Row, Segmented, Select, Space, Table, Tag, Typography } from "antd";
import { useAccountStore } from "@/stores/use-account-store";
import { getAdminGenerationScope, sameModelPriceBinding, PRICE_METERS, PRICE_TEMPLATES, PRICE_PARAMETERS, publishedDraftPrice, type AdminGenerationScope, type AdminModelPriceDraft, type ModelPriceRules, type ModelPriceRule, type PriceDraftModel, type PriceMeter, type PriceTemplate } from "@/services/saas/platform";
import { parseModelPriceDerivation, deriveModelPriceRules, contextTierRates, type ModelPriceDerivation } from "../../../../../packages/shared/src/model-price-derivation";
import { createAdminOfficialPriceReferenceClient, OFFICIAL_PRICE_SOURCES, type AdminOfficialPriceCatalog } from "@/services/saas/official-price-references";
import { normalizeMultiplierAmount, previewMultiplierPricing, type MultiplierBasis, type MultiplierBasisRow } from "./multiplier-pricing";

type SourceMode = "official" | "saved" | "custom";
const currencyName = { USD: "美元", CNY: "元" };
const typeName = { text: "文本", image: "图片", video: "视频", audio: "语音合成" };
const moneyLabel = (value: string | null | undefined, unit: string) => value == null ? "未知" : `${value} ${unit}`;
const parameterNames: Record<string, string> = { size: "尺寸", quality: "质量", mode: "模式", resolution: "分辨率", durationSeconds: "时长" };
const describeParameters = (parameters: Record<string, string>) => Object.entries(parameters).map(([key, value]) => `${parameterNames[key] ?? key}：${value}${key === "durationSeconds" ? " 秒" : ""}`).join(" · ") || "无规格条件";
const tierLabels: Record<string, { tier: "short" | "long"; meter: PriceMeter }> = Object.assign(Object.create(null), {
    "短上下文输入": { tier: "short", meter: "input_token" }, "短上下文缓存读取": { tier: "short", meter: "cached_input_token" }, "短上下文输出": { tier: "short", meter: "output_token" },
    "长上下文输入": { tier: "long", meter: "input_token" }, "长上下文缓存读取": { tier: "long", meter: "cached_input_token" }, "长上下文输出": { tier: "long", meter: "output_token" },
});

/** Keep explicit choices separate from the full source; never infer a choice from its amount. */
export function selectedOfficialContextRows(rows: MultiplierBasisRow[], mapping: Record<string, PriceMeter | "">) {
    const selected = rows.filter(row => Object.hasOwn(tierLabels, row.label));
    if (rows.length !== 10 || selected.length !== 6 || new Set(rows.map(row => row.label)).size !== 10 ||
        selected.some(row => mapping[row.id] !== tierLabels[row.label].meter) || rows.some(row => !Object.hasOwn(tierLabels, row.label) && mapping[row.id])) return null;
    return { metric: "total_tokens" as const, shortMaxTotalTokens: 272000 as const,
        short: Object.fromEntries(selected.filter(row => tierLabels[row.label].tier === "short").map(row => [row.label, mapping[row.id] as PriceMeter])),
        long: Object.fromEntries(selected.filter(row => tierLabels[row.label].tier === "long").map(row => [row.label, mapping[row.id] as PriceMeter])) };
}

function customRows(template: PriceTemplate | "cache_preview"): MultiplierBasisRow[] {
    return template === "cache_preview" ? ["普通输入（不含另计缓存）", "输出（含推理）", "缓存读取", "缓存写入"].map((label, index): MultiplierBasisRow => ({ id: `custom-${index}`, label, unit: "百万 Token", quantityBase: 1_000_000, quantityKind: "integer", amount: null }))
        : PRICE_TEMPLATES[template].meters.map((meter): MultiplierBasisRow => ({ id: meter, label: template === "text_cached_tokens" && meter === "input_token" ? "非缓存输入" : PRICE_METERS[meter].label, unit: PRICE_METERS[meter].unit, quantityBase: PRICE_METERS[meter].base as 1 | 1_000_000, quantityKind: meter === "second" ? "decimal" : "integer", amount: null }));
}

export function PriceDerivationSummary({ rules }: { rules: ModelPriceRules }) {
    const origin = rules.derivation;
    if (!origin) return null;
    const textThree = origin.basis.template === "text_cached_tokens" && origin.source.kind === "official" && origin.creditsPerCurrency === "100";
    const tiers = origin.schemaVersion === 2 ? contextTierRates(origin) : null;
    const source = origin.source.kind === "official" ? `${OFFICIAL_PRICE_SOURCES[origin.source.sourceId].name} · ${origin.source.entry.modelName} · 参考版本 ${origin.source.version}` : origin.source.kind === "saved_cost" ? `已保存成本草稿 · 版本 ${origin.source.draftVersion}` : "管理员自定义基准";
    return <Alert type="info" showIcon title={`倍率生成来源：${source}`} description={<>
        基准 {origin.basis.currency} · {origin.schemaVersion === 2 ? "短档报价锚点，另冻结长档策略" : `${origin.basis.bands.length} 档`} · 成本倍率 {origin.costMultiplier ?? "未知"} · {textThree ? "渠道模型倍率" : "售价倍率"} {origin.saleMultiplier} · 每 1 {origin.basis.currency} 对应 {origin.creditsPerCurrency} 积分。
        {textThree && <div>{origin.schemaVersion === 2 ? "短档" : ""}官方 USD / 百万 Token：普通输入 {origin.basis.bands[0].rates.input_token} · 缓存读取 {origin.basis.bands[0].rates.cached_input_token} · 输出 {origin.basis.bands[0].rates.output_token}。USD:CNY 数值 1:1；积分 =（普通输入费用 + 缓存读取费用 + 输出费用）× {origin.saleMultiplier} × 100。缓存写入须明确为 0。</div>}
        {origin.source.kind === "official" ? <div>官方来源原文：{origin.source.entry.context}{origin.schemaVersion === 2 ? <div>本平台按实际输入 + 输出总量判档；总量不超过 272000 Token 使用短档，超过272K按长档计价。缓存与推理已含在输入/输出中，不重复相加。完整冻结 {origin.source.entry.rates.length} 行，显式选择 6 行，其余 4 行缓存写入费率未适配。</div> : " 平台价格不自动随上下文或服务档位切换。"}</div> : null}
        {tiers && <div>用户积分单价 / 百万 Token：短档非缓存输入 {tiers.short.inputCreditsPerMillion} · 缓存读取 {tiers.short.cachedInputCreditsPerMillion} · 输出 {tiers.short.outputCreditsPerMillion}；长档非缓存输入 {tiers.long.inputCreditsPerMillion} · 缓存读取 {tiers.long.cachedInputCreditsPerMillion} · 输出 {tiers.long.outputCreditsPerMillion}。</div>}
        <div>保存后固定基准快照；手动修改价格会转为手动价目。</div>
    </>} />;
}

type ApplyRules = (rules: ModelPriceRules) => boolean;
export default function MultiplierPricePreview({ model, saved, disabled = false, onApply }: { model: PriceDraftModel; saved?: AdminModelPriceDraft; disabled?: boolean; onApply?: ApplyRules }) {
    const account = useAccountStore(), accountScope = account.getDraftScope();
    const scope: AdminGenerationScope | null = account.user?.role === "admin" && accountScope ? { ...accountScope, role: "admin" } : null;
    const [open, setOpen] = useState(false);
    if (!scope) return null;
    const identity = `${scope.accountId}:${scope.epoch}:${model.modelId}:${JSON.stringify(model.binding)}:${saved?.version ?? "none"}`;
    return <>
        <Space wrap><Button disabled={disabled} onClick={() => setOpen(true)}>按倍率定价 · 试算预览</Button><Typography.Text type="secondary">选择一份基准价，自动试算成本与积分售价。</Typography.Text></Space>
        <Modal key={identity} getContainer={false} width={1120} style={{ top: 24 }} styles={{ body: { maxHeight: "calc(100vh - 185px)", overflowY: "auto", paddingRight: 8 } }} open={open && !disabled} destroyOnHidden title={`${model.displayName} · 倍率定价预览`} footer={<Button onClick={() => setOpen(false)}>关闭预览</Button>} onCancel={() => setOpen(false)}>
            {open && !disabled ? <MultiplierWorkbench key={identity} model={model} saved={saved} scope={scope} onApply={onApply ? rules => { const accepted = onApply(rules); if (accepted) setOpen(false); return accepted; } : undefined} /> : null}
        </Modal>
    </>;
}

function MultiplierWorkbench({ model, saved, scope, onApply }: { model: PriceDraftModel; saved?: AdminModelPriceDraft; scope: AdminGenerationScope; onApply?: ApplyRules }) {
    const textModel = model.binding.capability === "text";
    const client = useRef<ReturnType<typeof createAdminOfficialPriceReferenceClient> | null>(null);
    const [mode, setMode] = useState<SourceMode>(model.binding.capability === "text" ? "official" : saved?.rules.cost && saved.bindingMatchesCurrent && sameModelPriceBinding(saved.binding, model.binding) ? "saved" : "custom");
    const [catalog, setCatalog] = useState<AdminOfficialPriceCatalog | null>(null), [referenceId, setReferenceId] = useState<string>();
    const [loading, setLoading] = useState(false), [error, setError] = useState("");
    const [confirmed, setConfirmed] = useState(false), [bandIndex, setBandIndex] = useState(0);
    const [customTemplate, setCustomTemplate] = useState<PriceTemplate | "cache_preview">(model.binding.capability === "text" ? "text_tokens" : model.binding.capability === "image" ? "image_count" : model.binding.capability === "audio" ? "audio_request" : "video_second");
    const [currency, setCurrency] = useState<"CNY" | "USD">("CNY"), [rows, setRows] = useState(() => customRows(customTemplate));
    const [customParameters, setCustomParameters] = useState<Record<string, string>>({}), [mapping, setMapping] = useState<Record<string, PriceMeter | "">>({});
    const [fixedOfficial, setFixedOfficial] = useState(false), [review, setReview] = useState<ModelPriceRules | null>(null);
    const [costMultiplier, setCostMultiplier] = useState(textModel ? saved?.rules.derivation?.costMultiplier ?? "" : ""), [saleMultiplier, setSaleMultiplier] = useState(textModel ? saved?.rules.derivation?.saleMultiplier ?? "" : ""), [creditsPerCurrency, setCreditsPerCurrency] = useState(textModel ? "100" : "");
    const [quantities, setQuantities] = useState<Record<string, string>>({});
    const [result, setResult] = useState<ReturnType<typeof previewMultiplierPricing> | null>(null);
    useLayoutEffect(() => {
        const owner = createAdminOfficialPriceReferenceClient({ scope, getScope: getAdminGenerationScope }); client.current = owner;
        return () => { owner.close(); if (client.current === owner) client.current = null; };
    }, [scope.accountId, scope.epoch]);
    const resetResult = () => { setResult(null); setReview(null); setError(""); };
    const resetBasis = () => { resetResult(); setConfirmed(false); setFixedOfficial(false); setMapping({}); setQuantities({}); };
    async function loadReferences() {
        const owner = client.current;
        if (!owner?.isCurrent() || loading) return;
        setLoading(true); resetBasis(); setCatalog(null); setReferenceId(undefined);
        try {
            const data = await owner.load();
            if (!data || client.current !== owner || !owner.isCurrent()) return;
            setCatalog(data);
            const mapping = data.mappings.find(item => item.modelId === model.modelId && item.bindingMatchesCurrent && sameModelPriceBinding(item.binding, model.binding));
            if (mapping?.referenceId) setReferenceId(mapping.referenceId);
        } catch (failure) { if (client.current === owner && owner.isCurrent()) setError(failure instanceof Error ? failure.message : "官方参考目录读取失败。"); }
        finally { if (client.current === owner && owner.isCurrent()) setLoading(false); }
    }
    const source = catalog?.sources.find(item => item.entries.some(entry => entry.id === referenceId));
    const entry = source?.entries.find(item => item.id === referenceId);
    const contextTiers = mode === "official" && entry?.rates.length === 10 && Object.keys(tierLabels).every(label => entry.rates.some(rate => rate.label === label));
    const savedUsable = !!saved?.rules.cost && saved.bindingMatchesCurrent && sameModelPriceBinding(saved.binding, model.binding);
    const savedBand = savedUsable ? saved!.rules.cost!.bands[bandIndex] : undefined;
    const basis: MultiplierBasis | null = mode === "official" ? entry && source?.checkedAt ? {
        model: entry.modelName, currency: "USD", source: `${OFFICIAL_PRICE_SOURCES[source.id].name} 官方参考`, version: String(source.version), context: entry.context,
        rows: entry.rates.map((rate, index): MultiplierBasisRow => ({ id: `official-${index}`, label: rate.label, unit: "百万 Token", quantityBase: 1_000_000, quantityKind: "integer", amount: rate.usdPerMillion })),
    } : null : mode === "saved" ? savedBand ? {
        model: model.binding.providerModel, currency: saved!.rules.cost!.currency as "USD" | "CNY", source: "已保存成本估算", version: String(saved!.version), context: describeParameters(savedBand.parameters),
        rows: PRICE_TEMPLATES[saved!.rules.cost!.template].meters.map((meter: PriceMeter): MultiplierBasisRow => ({ id: meter, label: saved!.rules.cost!.template === "text_cached_tokens" && meter === "input_token" ? "非缓存输入" : PRICE_METERS[meter].label, unit: PRICE_METERS[meter].unit, quantityBase: PRICE_METERS[meter].base as 1 | 1_000_000, quantityKind: meter === "second" ? "decimal" : "integer", amount: savedBand.rates[meter] ?? null })),
    } : null : { model: model.binding.providerModel, currency, source: "自定义基准", version: "未保存", context: describeParameters(customParameters), rows };
    const activeCurrency = basis?.currency ?? (mode === "official" ? "USD" : currency);
    const hasSample = Object.values(quantities).some(value => value !== "");
    const sampleIsComplete = !contextTiers && !!basis && basis.rows.every(row => quantities[row.id] !== undefined && quantities[row.id] !== "");
    const previewIssues = result?.issues.filter(item => hasSample || !item.field.startsWith("quantity:")) ?? [];
    const tableRows = basis?.rows.map(row => ({ ...row, priced: result?.rows.find(item => item.id === row.id) })) ?? [];
    function generateRules() {
        if (!basis || !confirmed || !result || previewIssues.length || !client.current?.isCurrent()) return;
        let baseRule: ModelPriceRule, origin: ModelPriceDerivation["source"];
        if (mode === "saved") {
            if (!savedUsable || !saved?.rules.cost) return;
            baseRule = saved.rules.cost;
            origin = { kind: "saved_cost", draftId: saved.id, draftVersion: saved.version };
        } else if (mode === "official") {
            if (!source?.checkedAt || !entry || !fixedOfficial) { setError("请明确确认将所选官方条目作为平台固定基准。"); return; }
            if (contextTiers) {
                const selection = selectedOfficialContextRows(basis.rows, mapping);
                if (!selection) { setError("请显式选择短档、长档各普通输入/缓存读取/输出三行；四行缓存写入未适配，不参与计费。"); return; }
                baseRule = { template: "text_cached_tokens", currency: "USD", bands: [{ parameters: {}, rates: Object.fromEntries(basis.rows.filter(row => tierLabels[row.label]?.tier === "short").map(row => [mapping[row.id], row.amount])) }] };
                origin = { kind: "official", application: "context_tiers", sourceId: source.id, version: source.version, checkedAt: source.checkedAt, entry, selection };
            } else {
                const selectedMeters = basis.rows.map(row => mapping[row.id]);
                const template = selectedMeters.includes("cached_input_token") ? "text_cached_tokens" : "text_tokens", meters = PRICE_TEMPLATES[template].meters;
                if (textModel && template !== "text_cached_tokens") { setError("新文本报价需要官方普通输入、缓存读取、输出三项完整基准价；双项条目不能替代三项价目。"); return; }
                if (basis.rows.length !== meters.length || selectedMeters.some(meter => !meter || !meters.includes(meter)) || new Set(selectedMeters).size !== meters.length) {
                    setError("请完整映射为全部输入/输出双项，或非缓存输入/缓存读取/输出三项。未适配条目继续保留为预览，不能省略计费项。"); return;
                }
                baseRule = { template, currency: "USD", bands: [{ parameters: {}, rates: Object.fromEntries(basis.rows.map(row => [mapping[row.id], row.amount])) }] };
                origin = { kind: "official", application: "fixed_baseline", sourceId: source.id, version: source.version, checkedAt: source.checkedAt, entry, mapping: Object.fromEntries(basis.rows.map(row => [row.label, mapping[row.id] as PriceMeter])) };
            }
        } else {
            if (customTemplate === "cache_preview") { setError("缓存写入分档仅支持预览，不能省略写入项生成三项草稿。"); return; }
            baseRule = { template: customTemplate, currency, bands: [{ parameters: customParameters, rates: Object.fromEntries(rows.map(row => [row.id, normalizeMultiplierAmount(row.amount)])) }] };
            origin = { kind: "custom" };
        }
        const derivation = parseModelPriceDerivation({ schemaVersion: contextTiers ? 2 : 1, kind: "multiplier", binding: model.binding, basis: baseRule,
            costMultiplier: costMultiplier === "" ? null : normalizeMultiplierAmount(costMultiplier), saleMultiplier: normalizeMultiplierAmount(saleMultiplier), creditsPerCurrency: normalizeMultiplierAmount(creditsPerCurrency), source: origin }, model.binding.capability);
        const derived = derivation && deriveModelPriceRules(derivation);
        if (!derived || !derivation) { setError("基准或倍率无法生成完整规则，请核对价格、整数计量及互不重叠的规格。已有成本中的未知项不能用于派生售价。"); return; }
        setReview({ ...derived, derivation }); setError("");
    }
    return <Space orientation="vertical" className="w-full" size="middle">
        <Alert type="info" showIcon title="倍率配置 · 发布后价格才会生效" description="先计算并生成完整规则，再应用到原价目表单。保存草稿与发布仍需分别确认；本窗口不会扣除积分。官方更新可以重新试算，已保存基准不会随之变化。" />
        <Typography.Text type="secondary">当前模型：{model.displayName} · {typeName[model.binding.capability]} · 渠道 {model.providerDisplayName}<br />上游型号：{model.binding.providerModel}</Typography.Text>
        <Card size="small" title="1 · 选择基准价目">
            <Space orientation="vertical" className="w-full" size="middle">
                <Segmented aria-label="倍率基准来源" value={mode} options={[{ value: "official", label: "官方参考", disabled: model.binding.capability !== "text" }, { value: "saved", label: "已保存成本", disabled: !savedUsable }, { value: "custom", label: "自定义基准" }]} onChange={(value: SourceMode) => { setMode(value); setCreditsPerCurrency(textModel ? "100" : ""); resetBasis(); }} />
                {mode === "official" ? <>
                    <Space wrap><Button loading={loading} onClick={() => void loadReferences()}>读取官方基准目录</Button><Typography.Text type="secondary">使用后台已核对的来源，不根据渠道型号名称猜测价格。</Typography.Text></Space>
                    <Select aria-label="倍率官方基准条目" className="w-full" showSearch optionFilterProp="label" placeholder="请选择准确型号与适用档位" value={referenceId} disabled={!catalog || loading}
                        options={catalog?.sources.flatMap(item => item.entries.map(rate => ({ value: rate.id, label: `${OFFICIAL_PRICE_SOURCES[item.id].name} · ${rate.modelName} · ${rate.context}${item.status !== "ready" ? "（旧参考）" : ""}` })))} onChange={value => { setReferenceId(value); resetBasis(); }} />
                    {source && entry ? <>
                        <Typography.Paragraph className="!mb-0">基准型号：{entry.modelName} · 参考版本 {source.version}<br />适用条件：{entry.context}<br />核对时间：{source.checkedAt ? new Date(source.checkedAt).toLocaleString() : "未知"} · <Typography.Link href={OFFICIAL_PRICE_SOURCES[source.id].url} target="_blank" rel="noreferrer">官方来源</Typography.Link></Typography.Paragraph>
                        {source.status !== "ready" && <Alert type="warning" showIcon title="来源最近核对失败，当前显示历史参考价。请核实后再使用这份基准试算。" />}
                    </> : <Typography.Text type="secondary">选择一份官方基准后显示完整分项。尚未收录的型号可使用自定义基准。</Typography.Text>}
                </> : mode === "saved" ? <>
                    <Typography.Text>成本草稿版本 {saved?.version} · 基准币种 {activeCurrency}</Typography.Text>
                    <Select aria-label="倍率成本基准规格" className="w-full" value={bandIndex} options={saved?.rules.cost?.bands.map((band, index) => ({ value: index, label: `价格档 ${index + 1} · ${describeParameters(band.parameters)}` }))} onChange={value => { setBandIndex(value); resetBasis(); }} />
                    <Typography.Text type="secondary">这里选择一档预览；生成草稿时会对这份成本的全部 {saved?.rules.cost?.bands.length ?? 0} 档应用相同倍率，保留每档规格。1 倍表示保持基准数值。</Typography.Text>
                </> : <>
                    <Row gutter={[12, 12]}><Col xs={24} md={8}><Typography.Paragraph className="!mb-1">基准币种</Typography.Paragraph><Select aria-label="倍率自定义币种" className="w-full" value={currency} options={[{ value: "CNY", label: "人民币 CNY" }, { value: "USD", label: "美元 USD" }]} onChange={value => { setCurrency(value); setRows(customRows(customTemplate)); setCreditsPerCurrency(textModel ? "100" : ""); resetBasis(); }} /></Col>
                        <Col xs={24} md={16}><Typography.Paragraph className="!mb-1">计量模板</Typography.Paragraph><Select aria-label="倍率自定义计量模板" className="w-full" value={customTemplate} options={[...Object.entries(PRICE_TEMPLATES).filter(([, template]) => template.capability === model.binding.capability).map(([value, template]) => ({ value, label: template.label })), ...(model.binding.capability === "text" ? [{ value: "cache_preview", label: "含缓存写入分项（仅预览）" }] : [])]} onChange={(value: PriceTemplate | "cache_preview") => { setCustomTemplate(value); setRows(customRows(value)); resetBasis(); }} /></Col></Row>
                    <Row gutter={[12, 12]}>{PRICE_PARAMETERS[model.binding.capability].map(key => <Col xs={24} md={8} key={key}><Typography.Paragraph className="!mb-1">{parameterNames[key]}</Typography.Paragraph><Input aria-label={`倍率基准${parameterNames[key]}`} value={customParameters[key] ?? ""} placeholder="留空不限制该参数" onChange={event => { const next = { ...customParameters }; if (event.target.value === "") delete next[key]; else next[key] = event.target.value; setCustomParameters(next); resetBasis(); }} /></Col>)}</Row>
                    <Typography.Text type="secondary">在下表填写这一个规格的基础价格。留空的规格参数不限制该参数；这套规则将独立保存。已有基准以后，通常只需调整倍率。</Typography.Text>
                </>}
                <Checkbox checked={confirmed} disabled={!basis || loading} onChange={event => { setConfirmed(event.target.checked); resetResult(); }}>已核对基准型号、币种、适用规格与各项单位</Checkbox>
            </Space>
        </Card>
        <Card size="small" title="2 · 设置倍率与积分报价换算">
            <Row gutter={[16, 12]}>
                <Col xs={24} md={8}><Typography.Paragraph className="!mb-1">渠道成本倍率（可留空）</Typography.Paragraph><Input aria-label="渠道成本倍率" inputMode="decimal" value={costMultiplier} placeholder="留空表示成本未知" onChange={event => { setCostMultiplier(event.target.value); resetResult(); }} /><Typography.Text type="secondary">仅当采购按此基准计价时适用。</Typography.Text></Col>
                <Col xs={24} md={8}><Typography.Paragraph className="!mb-1">{textModel ? "渠道模型倍率（唯一售价倍率）" : "用户售价倍率"}</Typography.Paragraph><Input aria-label="用户售价倍率" inputMode="decimal" value={saleMultiplier} placeholder={textModel ? "如 0.36" : "如 0.6，表示基准价的六折"} onChange={event => { setSaleMultiplier(event.target.value); resetResult(); }} /></Col>
                <Col xs={24} md={8}><Typography.Paragraph className="!mb-1">报价换算：每 1 {currencyName[activeCurrency]}对应积分</Typography.Paragraph><Input aria-label="倍率报价换算系数" inputMode="decimal" value={creditsPerCurrency} readOnly={textModel} placeholder="明确填写，不自动使用汇率" onChange={event => { setCreditsPerCurrency(event.target.value); resetResult(); }} /><Typography.Text type="secondary">{textModel ? "固定 100；USD:CNY 按数值 1:1 的商务口径。" : "用于本次模型报价；充值兑换单独设置。"}</Typography.Text></Col>
            </Row>
        </Card>
        <Card size="small" title="3 · 分项价格与模拟用量" extra={<Tag>尚未保存</Tag>}>
            <Typography.Paragraph type="secondary">积分单价 = 基准单价 × 售价倍率 × 报价换算系数。{model.binding.capability === "text" ? <>{mode === "saved" && saved?.rules.cost?.template === "text_tokens" ? "这份已保存双项基准按全部输入计量，缓存已含在输入内，没有独立优惠；输出已含推理。" : "若缓存另计，普通输入应扣除另计缓存，各项用量互斥；输出已含推理。"} Token 用量填个数。</> : model.binding.capability === "audio" ? "语音合成样例填写平台成功交付次数；成本基准须由管理员自行核实，未知可留空，不能从按次售价推断供应商计量或成本。" : "请填写上方选定规格的成功交付数量或计费秒数；按秒单价乘计费时长得到整段费用。"}</Typography.Paragraph>
            <Table size="small" rowKey="id" pagination={false} scroll={{ x: 850 }} dataSource={tableRows} columns={[
                { title: "计费项", dataIndex: "label", width: 190 },
                { title: `基准单价（${activeCurrency}）`, width: 170, render: (_, row) => mode === "custom" ? <Input aria-label={`倍率基准${row.label}单价`} inputMode="decimal" value={row.amount ?? ""} placeholder="未知" onChange={event => { setRows(rows.map(item => item.id === row.id ? { ...item, amount: event.target.value === "" ? null : event.target.value } : item)); resetBasis(); }} /> : moneyLabel(row.amount, `/ ${row.unit}`) },
                { title: "计价单位", dataIndex: "unit", width: 115 },
                ...(mode === "official" ? [{ title: "草稿计费项映射", width: 170, render: (_: unknown, row: MultiplierBasisRow) => contextTiers && !tierLabels[row.label] ? <Tag>未适配</Tag> : <Select aria-label={`倍率映射${row.label}`} className="w-full" placeholder="明确选择" value={mapping[row.id] || undefined} options={(contextTiers ? [tierLabels[row.label].meter] : PRICE_TEMPLATES.text_cached_tokens.meters).map(meter => ({ value: meter, label: meter === "input_token" ? "非缓存输入" : PRICE_METERS[meter].label }))} onChange={(value: PriceMeter) => { setMapping({ ...mapping, [row.id]: value }); setReview(null); setFixedOfficial(false); }} /> }] : []),
                { title: "估算成本", width: 140, render: (_, row) => contextTiers && !tierLabels[row.label] ? "未适配" : moneyLabel(row.priced?.costRate, `${activeCurrency} / ${row.unit}`) },
                { title: "用户积分单价", width: 150, render: (_, row) => contextTiers && !tierLabels[row.label] ? "未适配" : moneyLabel(row.priced?.saleRate, `积分 / ${row.unit}`) },
                { title: "模拟用量（可选）", width: 150, render: (_, row) => contextTiers ? <Typography.Text type="secondary">{tierLabels[row.label] ? "按实际总量自动选档" : "未适配"}</Typography.Text> : <Input aria-label={`倍率模拟${row.label}用量`} inputMode="decimal" placeholder={row.quantityBase === 1_000_000 ? "Token 个数" : `${row.unit}数`} value={quantities[row.id] ?? ""} onChange={event => { setQuantities({ ...quantities, [row.id]: event.target.value }); resetResult(); }} /> },
            ]} />
            <Typography.Paragraph type="secondary" className="mt-3">{contextTiers ? "双档此处仅分别预览单价，不把两档相加成一次费用；真实任务依实际总量选择一档。四行缓存写入不参与计费。" : "只看单价可以不填模拟用量；计算一次费用时每项都需明确填写，用不到的项目填 0。"}成本和售价币种不同，页面不会直接相减得到利润。</Typography.Paragraph>
            <Button type="primary" disabled={!basis || !confirmed || loading} onClick={() => {
                if (!basis || !confirmed) return;
                const selectedBasis = contextTiers ? { ...basis, rows: basis.rows.filter(row => tierLabels[row.label]) } : basis;
                setError(""); setResult(previewMultiplierPricing({ basis: selectedBasis, costMultiplier, saleMultiplier, creditsPerCurrency, quantities: contextTiers ? {} : quantities }));
            }}>计算倍率预览</Button>
            {previewIssues.length ? <Alert className="mt-3" type="warning" showIcon title="请补齐本次试算" description={[...new Set(previewIssues.map(item => item.message))].join(" ")} /> : null}
            {result && !previewIssues.length ? <Space orientation="vertical" className="mt-3 w-full" aria-live="polite">
                <Alert type="success" showIcon title="倍率试算已完成 · 尚未保存或生效" />
                {sampleIsComplete ? <Typography.Text strong>本次模拟：基准费用 {moneyLabel(result.sample.baseTotal, activeCurrency)} · 成本估算 {moneyLabel(result.sample.costTotal, activeCurrency)} · 用户消耗 {moneyLabel(result.sample.saleTotal, "积分")}</Typography.Text> : <Typography.Text>{contextTiers ? "上表分别显示六项单价；结算按实际输入 + 输出总量选择短档或长档，不合并两档费用。" : "上表已显示倍率后的各项单价，填写完整模拟用量可查看一次使用的合计。"}</Typography.Text>}
            </Space> : null}
        </Card>
        {onApply ? <Card size="small" title="4 · 生成并核对完整价目">
            <Space orientation="vertical" className="w-full" size="middle">
                {mode === "official" ? <>
                    <Typography.Text type="secondary">{contextTiers ? "完整冻结官方 10 行；显式选择短/长档各三行，四行缓存写入标为未适配。官方输入阈值原文保留；本平台单独按实际输入 + 输出总量判档，272000 Token 及以下短档，以上长档。" : "每一项都必须映射且价格完整。缓存读取可独立计价；缓存写入分档或其他未支持项目继续仅用于预览。"}</Typography.Text>
                    <Checkbox checked={fixedOfficial} disabled={!entry} onChange={event => { setFixedOfficial(event.target.checked); setReview(null); }}>{contextTiers ? "确认冻结完整来源及六行选择；超过272K按长档计价，两档始终取本次同一冻结来源" : "采用所选官方档位作为本平台固定基准，不自动随上下文或服务档位切换"}</Checkbox>
                </> : null}
                <Typography.Text type="secondary">将生成完整成本与积分售价，先应用到原价目表单。后续仍需保存草稿，再单独预览发布；未支持的生成类型只能保存草稿。</Typography.Text>
                <Button disabled={!result || !!previewIssues.length || !confirmed || loading || mode === "official" && !fixedOfficial} onClick={generateRules}>生成完整价目并核对</Button>
            </Space>
        </Card> : null}
        {error ? <Alert type="warning" showIcon title={error} /> : null}
        <Typography.Paragraph type="secondary" className="!mb-0">{textModel ? "新文本报价须使用官方三项完整基价、渠道模型倍率及固定 100 换算；手动或双项价目不能用于新报价，旧任务仍按原价。缓存三项结算须明确读取与写入计数，且写入为 0；缺明细或存在写入时待核对。显式零价可留草稿，当前执行不支持零费率。按十进制精确计算，不逐次舍入。" : "发布支持单图按次正整数积分，或文本双项/缓存读取三项正数价；均须单一无条件档。缓存三项结算须明确读取与写入计数，且写入为 0；缺明细或存在写入时待核对。视频、多规格与缓存写入分档执行尚待接入。"}</Typography.Paragraph>
        <Modal getContainer={false} width={1000} open={review !== null} title="核对倍率生成的完整价目" okText="应用到当前价目表单" cancelText="返回修改倍率" onCancel={() => setReview(null)} onOk={() => { if (review && onApply && !onApply(review)) setError("当前模型或会话已变化，请关闭后重新读取。"); }}>
            {review ? <Space orientation="vertical" className="w-full" size="middle">
                <PriceDerivationSummary rules={review} />
                <Typography.Paragraph className="!mb-0">将替换当前表单中尚未保存的整套规则。{review.derivation?.schemaVersion === 2 ? "下表为短档报价锚点；上方同时列出同一冻结策略的长档三价。" : `生成 ${review.sale.bands.length} 档，下表列出全部档位。`}已保存记录和有效价格会在你另行保存、发布后才变化。</Typography.Paragraph>
                <Table rowKey="id" size="small" pagination={false} scroll={{ x: 780, y: 360 }} dataSource={review.sale.bands.flatMap((band, index) => PRICE_TEMPLATES[review.sale.template].meters.map(meter => ({ id: `${index}:${meter}`, parameters: describeParameters(band.parameters), label: review.sale.template === "text_cached_tokens" && meter === "input_token" ? "非缓存输入" : PRICE_METERS[meter].label, unit: PRICE_METERS[meter].unit, cost: review.cost?.bands[index].rates[meter] ?? null, sale: band.rates[meter] })))} columns={[
                    { title: "完整规格", dataIndex: "parameters" }, { title: "计费项", dataIndex: "label" }, { title: "成本估算", render: (_, row) => moneyLabel(row.cost, `${review.cost?.currency ?? ""} / ${row.unit}`) }, { title: "用户售价", render: (_, row) => moneyLabel(row.sale, `积分 / ${row.unit}`) },
                ]} />
                <Alert showIcon type={publishedDraftPrice(model.binding, review) ? "info" : "warning"} title={publishedDraftPrice(model.binding, review) ? "保存后可以继续原发布校验；尚未发布或开放生成。" : "该规格暂不能发布执行，可先保存完整草稿。"} />
            </Space> : null}
        </Modal>
    </Space>;
}
