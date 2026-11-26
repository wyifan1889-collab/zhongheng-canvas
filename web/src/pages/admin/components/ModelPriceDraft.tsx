import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Col, Collapse, Input, Modal, Row, Select, Space, Table, Tag, Typography } from "antd";
import { ArrowLeft } from "lucide-react";
import { useAccountStore } from "@/stores/use-account-store";
import OfficialPriceMappingCard from "./OfficialPriceMappingCard";
import SpecificationPriceEditor from "./SpecificationPriceEditor";
import GeminiImagePriceTrial from "./GeminiImagePriceTrial";
import { geminiImageBindingOptions } from "../../../../../packages/shared/src/generation-gemini-image";
import { geminiImageDraftSpecs } from "../../../../../packages/shared/src/gemini-image-price-trial";
import { geminiImagePriceDraftMatchesBinding, type ModelPriceBinding } from "../../../../../packages/shared/src/model-pricing-drafts";
import VideoPricePublication, { VideoPricePolicyEditor } from "./VideoPricePublication";
import type { PublishedVideoSpecPrice } from "../../../../../packages/shared/src/model-price-publications";
import { newTextPriceEligibility, composeTextContextTierNote, textContextTierNote } from "../../../../../packages/shared/src/model-price-publications";
import MultiplierPricePreview, { PriceDerivationSummary } from "./MultiplierPricePreview";
import { pairSpecificationCosts } from "./specification-pricing";
import { manualPriceSample } from "./model-price-sample";
import { ImageSpecPriceLines } from "@/components/account/image-spec-price-lines";
import { createAdminModelPriceDraftClient, createAdminModelPricePublicationClient, publishedDraftPrice, getAdminGenerationScope, parseModelPriceRules, sameModelPriceBinding,
    describePriceDraftSupport, PRICE_METERS, PRICE_PARAMETERS, PRICE_TEMPLATES, PlatformServiceError,
    type AdminGenerationScope, type AdminModelPriceDraft, type AdminModelPriceDraftCatalog, type ModelPriceRule, type ModelPriceRules,
    type PriceCurrency, type PriceMeter, type PriceSampleResult, type PriceTemplate, type PricingCapability,
    type ModelPricePublicationPreview, type AdminModelPricePublication, type PricePublicationUnavailableReason, type PlatformPriceAmount } from "@/services/saas/platform";

type Client = ReturnType<typeof createAdminModelPriceDraftClient>;
type Selection = { capability: PricingCapability; id?: string };
type PublicationDialog = { id: number; saved: AdminModelPriceDraft; preview: ModelPricePublicationPreview | null; result: AdminModelPricePublication | null; publicNote: string; busy: "read" | "publish" | null; error: string };
export function publicationPriceNote(saved: AdminModelPriceDraft, adminNote: string): string | null {
    return saved.rules.derivation?.schemaVersion === 2 ? composeTextContextTierNote(saved.rules, saved.binding, adminNote) : adminNote;
}
const publicationUnavailable: Record<PricePublicationUnavailableReason, string> = { draft_missing: "尚无已保存草稿，请先保存。", model_binding_changed: "渠道绑定已变化，请关闭并重新读取草稿核对。", model_not_publishable: "模型或渠道尚不满足发布条件，请核对启用状态和配置。", unsupported_price_rule: "当前可发布语音合成单一无条件的按次正整数积分价、单图按次正整数价（无附加条件或完整明确的尺寸/质量组合），或文本全部输入/输出双项、非缓存输入/缓存读取/输出三项正数价。文本须单一无条件价格档；视频须显式 Grok JSON 协议、完整模式/分辨率/时长/声音/适用比例及按交付条数的正整数积分价，按秒继续保留为草稿。" };
const billingUnitLabels = { request: "次", input_token: "输入 Token", output_token: "输出 Token", second: "秒", megapixel: "百万像素" };
const capabilities: Record<PricingCapability, string> = { text: "文本", image: "图片", video: "视频", audio: "语音合成" };
const parameterLabels: Record<string, string> = { size: "图片尺寸", quality: "质量", mode: "模式", resolution: "分辨率", durationSeconds: "规格时长（秒）", generateAudio: "生成声音（true / false）", aspectRatio: "文生比例", imageSize: "分辨率档位" };
const currencyLabel = (currency: PriceCurrency) => ({ CNY: "元（CNY）", USD: "美元（USD）", credit: "积分" })[currency];
const templateFor = (capability: PricingCapability): PriceTemplate => capability === "text" ? "text_tokens" : capability === "image" ? "image_request" : capability === "audio" ? "audio_request" : "video_second";
function blankRule(template: PriceTemplate, currency: PriceCurrency): ModelPriceRule {
    return { template, currency, bands: [{ parameters: {}, rates: Object.fromEntries(PRICE_TEMPLATES[template].meters.map((meter) => [meter, currency === "credit" ? "" : null])) }] };
}
const blankRules = (capability: PricingCapability, binding?: ModelPriceBinding): ModelPriceRules => ({ schemaVersion: 1, cost: null,
    sale: blankRule(binding && geminiImageBindingOptions(binding) ? "image_count" : templateFor(capability), "credit") });
const failureMessage = (error: unknown) => error instanceof PlatformServiceError ? error.message : "模型价目操作未完成，请手动重新读取核对。";

export function PublicationPrice({ price }: { price: PlatformPriceAmount | PublishedVideoSpecPrice }) {
    if (price.billingUnit === "video_specs") return <VideoPricePublication price={price} />;
    if (price.billingUnit === "image_specs") return <div className="space-y-1"><ImageSpecPriceLines price={price} />
        <Typography.Text type="secondary">本页仅核对图片规格价目；实际可用模型与规格以原画布平台目录和本次报价为准。</Typography.Text></div>;
    return price.billingUnit === "text_tokens" ? <div className="space-y-1 tabular-nums">
        <div>{price.cachedInputCreditsPerMillion === undefined ? "输入" : "非缓存输入"}：{price.inputCreditsPerMillion} 积分 / 百万 Token</div>
        {price.cachedInputCreditsPerMillion !== undefined && <div>缓存读取：{price.cachedInputCreditsPerMillion} 积分 / 百万 Token</div>}<div>输出：{price.outputCreditsPerMillion} 积分 / 百万 Token</div>
        <Typography.Text type="secondary">发布价目后仍须满足站点开放及渠道可用条件；发布本身不会预留或扣除积分。</Typography.Text>
    </div> : <Typography.Text>{price.creditsPerUnit} 积分 / {billingUnitLabels[price.billingUnit]}</Typography.Text>;
}

export function PricePublicationComparison({ preview }: { preview: ModelPricePublicationPreview }) {
    const next = preview.draft && publishedDraftPrice(preview.draft.binding, preview.draft.rules);
    return <div className="grid min-w-0 gap-3 sm:grid-cols-2" aria-label="价格生效前后对照">
        <Card size="small" title="当前价格" className="min-w-0">
            {preview.currentPrice ? <Space orientation="vertical" className="w-full"><Tag>{`版本 ${preview.currentPrice.version} · ${preview.currentPrice.enabled ? "已启用" : "未启用"}`}</Tag><PublicationPrice price={preview.currentPrice} /></Space> : <Typography.Text type="secondary">尚无价格记录</Typography.Text>}
        </Card>
        <Card size="small" title="本次保存的价格" className="min-w-0">
            {next ? <Space orientation="vertical" className="w-full"><Tag>草稿 v{preview.draft!.version}</Tag><PublicationPrice price={next} /></Space> : <Typography.Text type="secondary">当前规则不能生效，请返回修改草稿</Typography.Text>}
        </Card>
    </div>;
}

export function SavedPriceDraft({ saved, published, publicPricingStatus = "ready" }: { saved?: AdminModelPriceDraft; published: boolean; publicPricingStatus?: "loading" | "ready" | "unknown" }) {
    if (!saved) return <Tag color={publicPricingStatus !== "ready" ? "orange" : published ? undefined : "orange"}>{publicPricingStatus !== "ready" ? "公开目录未知；暂无草稿" : published ? "尚无价目草稿" : "待定价"}</Tag>;
    return <div>草稿 v{saved.version} · {PRICE_TEMPLATES[saved.rules.sale.template].label}<br />
        <Typography.Text type="secondary">{saved.rules.sale.bands.length} 档规格 · {saved.rules.cost ? `成本 ${currencyLabel(saved.rules.cost.currency)}` : "成本未录入"}</Typography.Text>
        {saved.rules.derivation?.source.kind === "official" && saved.rules.sale.template === "text_cached_tokens" && <div>渠道模型倍率 {saved.rules.derivation.saleMultiplier} · 基准版本 {saved.rules.derivation.source.version}</div>}
        {!saved.bindingMatchesCurrent && <Tag color="orange">绑定需核对</Tag>}
    </div>;
}

function RuleEditor({ side, capability, rule, disabled, onChange }: {
    side: "cost" | "sale"; capability: PricingCapability; rule: ModelPriceRule; disabled: boolean; onChange: (rule: ModelPriceRule) => void;
}) {
    const [replacement, setReplacement] = useState<{ template: PriceTemplate; currency: PriceCurrency } | null>(null);
    const spec = PRICE_TEMPLATES[rule.template], keys = PRICE_PARAMETERS[capability];
    const changeBand = (index: number, patch: Partial<ModelPriceRule["bands"][number]>) => onChange({ ...rule, bands: rule.bands.map((band, i) => i === index ? { ...band, ...patch } : band) });
    const label = side === "cost" ? "成本" : "售价";
    return <Space orientation="vertical" className="w-full" size="middle">
        <Space wrap>
            <Select aria-label={`${label}计量模板`} disabled={disabled} value={rule.template} style={{ minWidth: 230 }}
                options={Object.entries(PRICE_TEMPLATES).filter(([, value]) => value.capability === capability).map(([value, item]) => ({ value, label: item.label }))}
                onChange={(template: PriceTemplate) => { if (template !== rule.template) setReplacement({ template, currency: rule.currency }); }} />
            {side === "cost" ? <Select<"CNY" | "USD"> aria-label="成本币种" disabled={disabled} value={rule.currency === "CNY" || rule.currency === "USD" ? rule.currency : undefined} style={{ minWidth: 140 }} options={[{ value: "CNY", label: "人民币 CNY" }, { value: "USD", label: "美元 USD" }]}
                onChange={(currency: "CNY" | "USD") => { if (currency !== rule.currency) setReplacement({ template: rule.template, currency }); }} /> : <Tag>用户售价 · 积分</Tag>}
        </Space>
        <Typography.Text type="secondary">{side === "cost" ? "配置成本是估算；每项留空表示未知，明确免费才填 0。" : capability === "audio" ? "语音合成售价须为每次成功交付收取的正整数积分。" : "每项售价均需明确填写，0 表示明确免费。"} 单价按下表单位填写，不自动换算币种。{rule.template === "text_cached_tokens" ? "非缓存输入与缓存读取互斥计量；须明确返回读取和写入计数，且写入为 0。明细缺失或存在缓存写入时，结算待核对；缓存写入分档尚未支持。" : rule.template === "text_tokens" ? "此模板对全部输入统一计价，缓存读取已含输入，不另计优惠；输出包含推理。" : ""}</Typography.Text>
        <Table rowKey="index" size="small" pagination={false} scroll={{ x: Math.max(620, 180 * (keys.length + spec.meters.length)) }}
            dataSource={rule.bands.map((band, index) => ({ ...band, index }))} columns={[
                { title: "价格档", width: 80, render: (_, row) => row.index + 1 },
                ...keys.map((key) => ({ title: parameterLabels[key], render: (_: unknown, row: ModelPriceRule["bands"][number] & { index: number }) => <Input disabled={disabled} aria-label={`${label}档${row.index + 1}${parameterLabels[key]}`} placeholder="不限此参数" value={row.parameters[key] ?? ""} onChange={(event) => {
                    const parameters = { ...row.parameters }; if (event.target.value === "") delete parameters[key]; else parameters[key] = event.target.value;
                    changeBand(row.index, { parameters });
                }} /> })),
                ...spec.meters.map((meter) => ({ title: `${rule.template === "text_cached_tokens" && meter === "input_token" ? "非缓存输入" : PRICE_METERS[meter].label}（${currencyLabel(rule.currency)} / ${PRICE_METERS[meter].unit}）`, render: (_: unknown, row: ModelPriceRule["bands"][number] & { index: number }) => <Input disabled={disabled} aria-label={`${label}档${row.index + 1}${rule.template === "text_cached_tokens" && meter === "input_token" ? "非缓存输入" : PRICE_METERS[meter].label}单价`} inputMode="decimal" placeholder={side === "cost" ? "未知" : "填写单价"} value={row.rates[meter] ?? ""}
                    onChange={(event) => changeBand(row.index, { rates: { ...row.rates, [meter]: event.target.value === "" && side === "cost" ? null : event.target.value } })} /> })),
                { title: "操作", width: 80, render: (_, row) => <Button type="text" danger disabled={disabled || rule.bands.length === 1} onClick={() => onChange({ ...rule, bands: rule.bands.filter((_, index) => index !== row.index) })}>移除此档</Button> },
            ]} />
        {keys.length ? <Space wrap><Button disabled={disabled} onClick={() => onChange({ ...rule, bands: [...rule.bands, blankRule(rule.template, rule.currency).bands[0]] })}>添加参数价格档</Button><Typography.Text type="secondary">一行内条件同时成立；不同档必须互斥。空条件匹配全部，因此不能与其他档重叠。</Typography.Text></Space> : null}
        <Modal getContainer={false} open={replacement !== null} title={`更换${label}模板或币种并清空本侧价格档？`} okText="更换并重新填写" cancelText="保留现有输入" onCancel={() => setReplacement(null)}
            onOk={() => { const next = replacement; setReplacement(null); if (next && !disabled) onChange(blankRule(next.template, next.currency)); }}>
            <Typography.Paragraph>当前未保存的{label}单价与参数档将清空，另一侧规则不变。不会换算金额或修改已保存草稿。</Typography.Paragraph>
        </Modal>
    </Space>;
}

function SampleResult({ label, value }: { label: string; value: PriceSampleResult | null }) {
    if (value === null) return <Typography.Paragraph>{label}：尚未录入成本，不能按零估算。</Typography.Paragraph>;
    if (value.status !== "calculated") {
        const reasons = { missing_parameters: "缺少参数", no_matching_band: "没有匹配价格档", ambiguous: "匹配多个价格档", missing_usage: "缺少用量", invalid_sample: "样例参数或用量无效" };
        return <Typography.Paragraph role="status">{label}：暂不能计算，{reasons[value.status]}{value.fields.length ? `（${value.fields.map((field) => PRICE_METERS[field as PriceMeter]?.label ?? parameterLabels[field] ?? field).join("、")}）` : ""}。</Typography.Paragraph>;
    }
    return <div><Typography.Text strong>{label}：{value.total === null ? "存在未知单价，合计未知" : `${value.total} ${currencyLabel(value.currency)}`}（价格档 {value.bandIndex + 1}）</Typography.Text>
        {value.lines.map((line) => <Typography.Paragraph key={line.meter} className="!mb-1" type="secondary">{line.meter === "input_token" && value.lines.some(item => item.meter === "cached_input_token") ? "非缓存输入" : PRICE_METERS[line.meter].label}：{line.quantity} × {line.rate ?? "未知"} / {line.base} = {line.total ?? "未知"} {currencyLabel(value.currency)}</Typography.Paragraph>)}
    </div>;
}

export type PriceSelectionRequest = { modelId: string; capability: PricingCapability; requestId: number };
type DraftProps = { selectionRequest?: PriceSelectionRequest | null; publishedModelIds?: string[]; publicPricingStatus?: "loading" | "ready" | "unknown"; removedModelIds?: string[]; onBack: () => void; onPublished?: () => void };
export default function ModelPriceDraft(props: DraftProps) {
    const account = useAccountStore(), draftScope = account.getDraftScope();
    const scope: AdminGenerationScope | null = account.user?.role === "admin" && draftScope ? { ...draftScope, role: "admin" } : null;
    return <DraftPanel key={scope ? `${scope.accountId}:${scope.epoch}:admin` : "unavailable"} scope={scope} {...props} />;
}

function DraftPanel({ scope, selectionRequest, publishedModelIds = [], publicPricingStatus = "ready", removedModelIds, onBack, onPublished }: { scope: AdminGenerationScope | null } & DraftProps) {
    const client = useRef<Client | null>(null), dirty = useRef(false), busyRef = useRef(false);
    const publisher = useRef<ReturnType<typeof createAdminModelPricePublicationClient> | null>(null), publicationSequence = useRef(0), publicationRef = useRef<PublicationDialog | null>(null);
    const [publication, setPublication] = useState<PublicationDialog | null>(null);
    const [catalog, setCatalog] = useState<AdminModelPriceDraftCatalog | null>(null), catalogRef = useRef<AdminModelPriceDraftCatalog | null>(null);
    const removedRef = useRef(removedModelIds); removedRef.current = removedModelIds;
    const [capability, setCapability] = useState<PricingCapability>("image"), [selected, setSelected] = useState<string>(), selectedRef = useRef<string | undefined>(undefined);
    const [rules, setRules] = useState<ModelPriceRules>(blankRules("image")), [priceNote, setPriceNote] = useState("");
    const [busy, setBusy] = useState<"read" | "save" | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
    const [blocked, setBlocked] = useState(false), [bindingConfirmed, setBindingConfirmed] = useState(false), [switchTo, setSwitchTo] = useState<Selection | null>(null);
    const [parameters, setParameters] = useState<Record<string, string>>({}), [usage, setUsage] = useState<Partial<Record<PriceMeter, string>>>({});
    const [sample, setSample] = useState<{ cost: PriceSampleResult | null; sale: PriceSampleResult } | null>(null);
    const externalRequest = useRef(selectionRequest), consumedRequest = useRef<number | null>(null);
    externalRequest.current = selectionRequest;
    const [advancedRules, setAdvancedRules] = useState(false);
    const model = catalog?.models.find((item) => item.modelId === selected && !removedModelIds?.includes(item.modelId)), draft = catalog?.items.find((item) => item.modelId === selected);
    const gemini = model && geminiImageBindingOptions(model.binding);
    const pairedCost = pairSpecificationCosts(rules);
    const editableGemini = !!gemini && rules.sale.template === "image_count" && pairedCost !== undefined && (!pairedCost || pairedCost.template === "image_count") &&
        rules.sale.bands.every(({ parameters }) => !PRICE_PARAMETERS.image.some(key => Object.hasOwn(parameters, key)));
    const parsedRules = model ? parseModelPriceRules(rules, model.binding.capability) : null;
    const validRules = model && parsedRules && geminiImagePriceDraftMatchesBinding(model.binding, parsedRules) &&
        (!gemini || editableGemini && geminiImageDraftSpecs({ binding: model.binding, rules: parsedRules })) ? parsedRules : null;
    const trialDialog = publication && geminiImageBindingOptions(publication.saved.binding);
    const trialDraft = !!gemini;
    const textEligibility = model?.binding.capability === "text" ? newTextPriceEligibility(model.binding, rules, 1) : null;
    const meters = [...new Set([...(rules.cost ? PRICE_TEMPLATES[rules.cost.template].meters : []), ...PRICE_TEMPLATES[rules.sale.template].meters])];
    const sampleMeterLabel = (meter: PriceMeter) => capability === "text" && meters.includes("cached_input_token") && meter === "input_token" ? "总输入（含缓存读取）" : PRICE_METERS[meter].label;
    const live = (owner: Client) => client.current === owner && owner.isCurrent();
    const updateRules = (next: ModelPriceRules) => {
        dirty.current = true; setRules({ schemaVersion: next.schemaVersion, cost: next.cost, sale: next.sale, ...(next.video ? { video: next.video } : {}) }); setSample(null);
        if (rules.derivation) setNotice("已手动修改价格，当前表单转为手动价目；已保存的倍率来源记录保持原样。");
    };
    function showPublication(value: PublicationDialog | null) { publicationRef.current = value; setPublication(value); }
    function closePublication() { ++publicationSequence.current; publisher.current?.cancel(); showPublication(null); }
    function fillSelection(selection: Selection, data = catalogRef.current) {
        closePublication();
        const { id } = selection; selectedRef.current = id; setSelected(id); setCapability(selection.capability); dirty.current = false; setError(""); setNotice(""); setSample(null); setUsage({}); setParameters({}); setAdvancedRules(false);
        const current = data?.models.find((item) => item.modelId === id), saved = data?.items.find((item) => item.modelId === id);
        const matches = !!current && (!saved || (saved.bindingMatchesCurrent && sameModelPriceBinding(saved.binding, current.binding)));
        setRules(matches && saved ? saved.rules : blankRules(selection.capability, current?.binding)); setPriceNote(matches ? saved?.priceNote ?? "" : ""); setBindingConfirmed(matches);
        if (saved && !matches) setNotice("旧草稿绑定已变化，未沿用旧规则。请重新填写并核对当前渠道后保存。");
    }
    function withoutDeleted(data: AdminModelPriceDraftCatalog): AdminModelPriceDraftCatalog {
        return { models: data.models.filter(item => !removedRef.current?.includes(item.modelId)), items: data.items.filter(item => !removedRef.current?.includes(item.modelId)) };
    }
    useLayoutEffect(() => {
        if (!removedModelIds?.length) return;
        if (catalogRef.current) { const next = withoutDeleted(catalogRef.current); catalogRef.current = next; setCatalog(next); }
        if (selectedRef.current && removedModelIds.includes(selectedRef.current)) {
            selectedRef.current = undefined; setSelected(undefined); setBindingConfirmed(false); setSwitchTo(null); closePublication();
            setNotice("所选模型已删除，未保存的价格输入保留；请选择其他模型后再核对。");
        }
    }, [removedModelIds]);
    function acceptCatalog(raw: AdminModelPriceDraftCatalog) {
        const data = withoutDeleted(raw);
        const id = selectedRef.current, previous = catalogRef.current;
        const beforeModel = previous?.models.find((item) => item.modelId === id), nextModel = data.models.find((item) => item.modelId === id);
        const beforeDraft = previous?.items.find((item) => item.modelId === id), nextDraft = data.items.find((item) => item.modelId === id);
        catalogRef.current = data; setCatalog(data); setSample(null);
        if (!id) return;
        if (!nextModel) { setBindingConfirmed(false); setNotice("所选模型已不在当前目录；输入保留，请返回模型列表核对。"); return; }
        setCapability(nextModel.binding.capability);
        if (beforeModel?.binding.capability !== nextModel.binding.capability) { setParameters({}); setUsage({}); }
        const changed = !beforeModel || !sameModelPriceBinding(beforeModel.binding, nextModel.binding) || beforeDraft?.version !== nextDraft?.version || nextDraft?.bindingMatchesCurrent === false;
        if (dirty.current) {
            if (changed) { setBindingConfirmed(false); setNotice("已读取当前渠道与草稿版本，未覆盖你的输入。请重新核对并确认后保存。"); }
        } else {
            const matches = !nextDraft || (nextDraft.bindingMatchesCurrent && sameModelPriceBinding(nextDraft.binding, nextModel.binding));
            setRules(matches && nextDraft ? nextDraft.rules : blankRules(nextModel.binding.capability, nextModel.binding)); setPriceNote(matches ? nextDraft?.priceNote ?? "" : ""); setBindingConfirmed(matches);
            if (!matches) setNotice("旧草稿绑定已变化，未沿用旧规则；请重新填写并确认当前渠道。");
        }
    }
    async function read(owner = client.current) {
        if (!owner || !live(owner) || busyRef.current || publicationRef.current) return;
        busyRef.current = true; setBusy("read"); setError("");
        try {
            const data = await owner.load(); if (!data || !live(owner)) return;
            acceptCatalog(data);
            if (blocked) { setBindingConfirmed(false); setNotice("已重新读取；请核对渠道、版本及保留的输入，明确确认后再保存。不会自动重提。"); }
            setBlocked(false);
        } catch (failure) { if (live(owner)) { setError(failureMessage(failure)); setBlocked(true); } }
        finally { if (live(owner)) { busyRef.current = false; setBusy(null); } }
    }
    useLayoutEffect(() => {
        if (!scope) return;
        const owner = createAdminModelPriceDraftClient({ scope, getScope: getAdminGenerationScope }); client.current = owner;
        const publications = createAdminModelPricePublicationClient({ scope, getScope: getAdminGenerationScope }); publisher.current = publications; void read(owner);
        return () => { owner.close(); publications.close(); ++publicationSequence.current; publicationRef.current = null; if (publisher.current === publications) publisher.current = null; if (client.current === owner) { client.current = null; busyRef.current = false; } };
    // The keyed panel owns one confirmed administrator epoch, including StrictMode remounts.
    }, [scope?.accountId, scope?.epoch]);
    useEffect(() => {
        const request = selectionRequest, owner = client.current;
        if (!request || request.requestId === consumedRequest.current || !owner || !live(owner) || busyRef.current || publicationRef.current) return;
        consumedRequest.current = request.requestId; busyRef.current = true; setBusy("read"); setError("");
        void owner.load().then(data => {
            if (!data || !live(owner) || externalRequest.current?.requestId !== request.requestId) return;
            acceptCatalog(data); setBlocked(false);
            const target = data.models.find(item => item.modelId === request.modelId && !removedRef.current?.includes(item.modelId));
            if (!target || target.binding.capability !== request.capability) { setError("所选模型已变化或不在当前价目目录，请重新核对节点配置。"); return; }
            const selection = { id: target.modelId, capability: target.binding.capability };
            if (dirty.current && selectedRef.current !== target.modelId) setSwitchTo(selection);
            else if (!dirty.current) fillSelection(selection, data);
        }).catch(failure => { if (live(owner) && externalRequest.current?.requestId === request.requestId) { setError(failureMessage(failure)); setBlocked(true); } })
            .finally(() => { if (live(owner)) { busyRef.current = false; setBusy(null); } });
    }, [selectionRequest?.requestId, busy, publication?.id]);
    async function save() {
        const owner = client.current;
        if (!owner || !live(owner) || busyRef.current || publicationRef.current || blocked || !model || model.modelId !== selectedRef.current || !bindingConfirmed) return;
        if (!validRules) { setError("请补齐售价单价，并核对币种和互不重叠的参数档；成本未知可留空。普通十进制不能包含空格、负数或指数。"); return; }
        busyRef.current = true; setBusy("save"); setError(""); setNotice("");
        try {
            const saved = await owner.save({ modelId: model.modelId, expectedVersion: draft?.version ?? 0, binding: { ...model.binding }, rules: validRules, priceNote });
            if (!saved || !live(owner)) return;
            if (removedRef.current?.includes(saved.modelId)) return;
            dirty.current = false; setRules(saved.rules); setPriceNote(saved.priceNote); setSample(null);
            const next = { models: catalogRef.current?.models ?? [], items: [...(catalogRef.current?.items.filter((item) => item.modelId !== saved.modelId) ?? []), saved] };
            catalogRef.current = next; setCatalog(next); setNotice(`价目草稿版本 ${saved.version} 已保存；没有发布或改变当前收费。`);
            try { const refreshed = await owner.load(); if (refreshed && live(owner)) { acceptCatalog(refreshed); setBlocked(false); } }
            catch { if (live(owner)) { setBlocked(true); setError("草稿已保存，但后续读取失败。请手动重新读取核对，不要重复提交。"); } }
        } catch (failure) { if (live(owner)) { dirty.current = true; setError(failureMessage(failure)); setBlocked(true); setBindingConfirmed(false); } }
        finally { if (live(owner)) { busyRef.current = false; setBusy(null); } }
    }
    async function readPublication(id: number) {
        const owner = publisher.current, dialog = publicationRef.current;
        if (!owner || !owner.isCurrent() || !dialog || dialog.id !== id || dialog.busy) return;
        showPublication({ ...dialog, busy: "read", error: "", preview: null });
        const current = () => publisher.current === owner && owner.isCurrent() && publicationRef.current?.id === id && selectedRef.current === dialog.saved.modelId;
        try {
            const preview = await owner.load(dialog.saved.modelId); if (!preview || !current()) return;
            const sameSaved = preview.draft?.id === dialog.saved.id && preview.draft.version === dialog.saved.version && sameModelPriceBinding(preview.draft.binding, dialog.saved.binding);
            showPublication({ ...publicationRef.current!, busy: null, preview: sameSaved ? preview : null, result: sameSaved ? preview.publication ?? dialog.result : dialog.result,
                error: !sameSaved ? "服务端已保存草稿已变化。请关闭并重新读取；原发布结果若仍未确认，不能据此再次发布。" : owner.hasUnconfirmed(dialog.saved.modelId) ? "原发布结果尚未确认，当前读取未发现对应记录。请保留草稿编号继续只读核对，不要重复发布。" : "" });
        } catch (failure) { if (current()) showPublication({ ...publicationRef.current!, busy: null, error: dialog.result ? "发布已确认，但后续读取失败；请只读核对，不要重复发布。" : failureMessage(failure) }); }
    }
    function openPublication() {
        if (!publisher.current?.isCurrent() || busyRef.current || publicationRef.current || dirty.current || blocked || !bindingConfirmed || !draft || !draft.bindingMatchesCurrent || !model || !sameModelPriceBinding(draft.binding, model.binding)) return;
        const id = ++publicationSequence.current;
        showPublication({ id, saved: structuredClone(draft), preview: null, result: null, publicNote: "", busy: null, error: "" }); void readPublication(id);
    }
    async function publish() {
        const owner = publisher.current, dialog = publicationRef.current;
        if (!owner || !owner.isCurrent() || !dialog?.preview || dialog.busy || dialog.result || dialog.preview.publication || dialog.preview.unavailableReason || dirty.current || blocked || !bindingConfirmed
            || geminiImageBindingOptions(dialog.saved.binding) || selectedRef.current !== dialog.saved.modelId || owner.hasUnconfirmed(dialog.saved.modelId)) return;
        showPublication({ ...dialog, busy: "publish", error: "" });
        const current = () => publisher.current === owner && owner.isCurrent() && publicationRef.current?.id === dialog.id && selectedRef.current === dialog.saved.modelId;
        try {
            const finalNote = publicationPriceNote(dialog.saved, dialog.publicNote);
            if (finalNote === null) { showPublication({ ...publicationRef.current!, busy: null, error: "双档合同无法生成完整公开说明，请关闭并重新读取草稿核对。" }); return; }
            const result = await owner.publish(dialog.preview, finalNote); if (!result || !current()) return;
            showPublication({ ...publicationRef.current!, result, busy: null, preview: null });
            onPublished?.();
            setNotice(`草稿版本 ${result.draftVersion} 已发布为价格版本 ${result.priceVersion}；${result.billingUnit === "image_specs" ? "用户可查看完整图片规格价目；生成须在原画布选择可执行组合并确认本次费用。" : result.billingUnit === "text_tokens" ? "用户可查看文本分项价目；生成仍须满足站点开放及渠道可用条件。" : "后续新报价使用服务端有效价格，已有任务保持原快照。"}`);
            await readPublication(dialog.id);
        } catch (failure) { if (current()) showPublication({ ...publicationRef.current!, busy: null, preview: null, error: failureMessage(failure) }); }
    }
    const editingDisabled = busy !== null || publication !== null || !model;
    return <section id="admin-model-price-draft" aria-label="模型规格与价格编辑" className="space-y-4">
        <Button icon={<ArrowLeft size={14} />} disabled={busy !== null || publication !== null || switchTo !== null} onClick={onBack}>返回模型列表</Button>
        <Card title="规格与价格" extra={dirty.current ? <Tag color="orange">未保存修改</Tag> : <Tag>价格草稿</Tag>}>
        <Typography.Paragraph type="secondary">{trialDraft ? "Gemini 规格价目目前仅供草稿试算。" : "保存草稿后，核对当前价格与新价格并确认生效。新价格用于后续报价，已受理任务保持原价。"}</Typography.Paragraph>
        {!scope ? <Alert type="warning" showIcon title="管理员会话尚未确认，请重新登录后读取。" /> : <Space orientation="vertical" className="w-full" size="middle">
            <Space wrap><Button loading={busy === "read"} disabled={busy !== null || publication !== null} onClick={() => { void read(); }}>重新读取草稿</Button><Typography.Text type="secondary">读取不会静默覆盖未保存输入。</Typography.Text></Space>
            {notice ? <Typography.Paragraph role="status" className="!mb-0">{notice}</Typography.Paragraph> : null}{error ? <Alert type="warning" showIcon title={error} /> : null}
            {model ? <>
                <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><Typography.Title level={5} className="!mb-1 break-words">{model.displayName}</Typography.Title><Typography.Text type="secondary" className="break-all">{capabilities[model.binding.capability]} · {model.providerDisplayName} · {model.binding.providerModel}</Typography.Text></div><SavedPriceDraft saved={draft} published={publishedModelIds.includes(model.modelId)} publicPricingStatus={publicPricingStatus} /></div>
                <Collapse size="small" items={[{ key: "binding", label: "查看渠道绑定", children: <Typography.Paragraph className="break-all !mb-0">平台模型：{model.modelId}<br />渠道：{model.providerDisplayName}（{model.binding.providerId}）<br />接口协议：{model.binding.adapter}<br />上游型号：{model.binding.providerModel}<br />接口地址：{model.binding.endpoint}</Typography.Paragraph> }]} />
                {draft && !draft.bindingMatchesCurrent ? <Alert type="warning" showIcon title="旧草稿绑定已变化，必须重新核对。" description={<span className="break-all">旧渠道：{draft.binding.providerId} · {draft.binding.adapter}<br />旧型号：{draft.binding.providerModel} · {capabilities[draft.binding.capability]}<br />旧接口：{draft.binding.endpoint}</span>} /> : null}
                {!bindingConfirmed ? <Checkbox checked={bindingConfirmed} disabled={editingDisabled || blocked} onChange={(event) => setBindingConfirmed(event.target.checked)}>我已核对当前渠道、最新草稿版本和下方规则，确认按当前绑定保存</Checkbox> : null}
                {model.binding.capability === "text" ? <OfficialPriceMappingCard model={model} disabled={editingDisabled} /> : null}
                {model.binding.capability === "video" ? <VideoPricePolicyEditor value={rules.video} disabled={editingDisabled} onChange={video => {
                    const { video: _previous, ...rest } = rules; updateRules({ ...rest, ...(video ? { video } : {}) });
                }} /> : null}
                {!trialDraft && <MultiplierPricePreview key={selected} model={model} saved={draft} disabled={editingDisabled || blocked} onApply={next => {
                    const owner = client.current;
                    if (!owner || !live(owner) || busyRef.current || publicationRef.current || blocked || selectedRef.current !== model.modelId || !next.derivation || !sameModelPriceBinding(next.derivation.binding, model.binding)) return false;
                    const parsed = parseModelPriceRules(next, model.binding.capability); if (!parsed) return false;
                    dirty.current = true; setRules(parsed); setSample(null); setBindingConfirmed(false);
                    setNotice(`已将倍率生成的 ${parsed.sale.bands.length} 档完整规则填入表单。请核对当前渠道与规则，再保存草稿；有效价格尚未改变。`);
                    return true;
                }} />}
                <PriceDerivationSummary rules={rules} />
                {textEligibility?.status === "unavailable" && <Alert showIcon type="warning" title={textEligibility.reason === "zero_rate_unsupported" ? "当前执行不支持零费率；有据零价可保留为草稿。" : "新文本报价须有完整官方三项基价、渠道模型倍率及固定 100 换算；请使用倍率定价核对。"} description="已受理任务保持原发布版本。保存草稿和发布分别确认，发布价目不等于开放生成。" />}
                {rules.derivation && !trialDraft ? <Button disabled={editingDisabled} onClick={() => updateRules(rules)}>转为手动价目，保留当前单价</Button> : null}
                {!trialDraft && model.binding.capability !== "text" && model.binding.capability !== "audio" && <Space wrap><Button disabled={editingDisabled || advancedRules && pairedCost === undefined} onClick={() => setAdvancedRules(!advancedRules)}>{advancedRules ? "按规格并排编辑" : "分别编辑成本与售价 / Token 计价"}</Button><Typography.Text type="secondary">更换编辑方式不改动价格；不同条件的成本与售价保持独立。</Typography.Text></Space>}
                {trialDraft && !editableGemini ? <Alert type="info" showIcon title="现有草稿不是 Gemini 原生规格价目" action={<Button disabled={editingDisabled || blocked} onClick={() => updateRules(blankRules("image", model.binding))}>填写按张价目</Button>} /> :
                model.binding.capability !== "text" && model.binding.capability !== "audio" && !advancedRules && pairedCost !== undefined ? <Card size="small" title="规格、成本与售价"><SpecificationPriceEditor key={selected} capability={model.binding.capability} gemini={gemini} rules={rules} disabled={editingDisabled} onChange={updateRules} /></Card> : <>
                {model.binding.capability !== "text" && model.binding.capability !== "audio" && pairSpecificationCosts(rules) === undefined && <Alert type="info" showIcon title="当前成本与售价采用独立参数档或 Token 计价，按原规则分别编辑；不会自动合并或丢弃档位。" />}
                {model.binding.capability === "audio" && <Alert type="info" showIcon title="语音合成按每次成功交付收固定积分" description="售价填写一个正整数积分金额；完整音频校验与私有交付成功才收取一次，失败释放冻结，结果不明待核对。渠道成本未知可留空，不从音频时长或缺失用量推算。" />}
                <Card size="small" title="渠道成本（估算）" extra={<Checkbox disabled={editingDisabled} checked={rules.cost !== null} onChange={(event) => updateRules({ ...rules, cost: event.target.checked ? blankRule(templateFor(model.binding.capability), "CNY") : null })}>录入成本规则</Checkbox>}>
                    {rules.cost ? <RuleEditor key={`cost:${selected}`} side="cost" capability={model.binding.capability} rule={rules.cost} disabled={editingDisabled} onChange={(cost) => updateRules({ ...rules, cost })} /> : <Typography.Text type="secondary">尚未录入成本；不会按零计算。</Typography.Text>}
                </Card>
                <Card size="small" title="用户售价（积分）"><RuleEditor key={`sale:${selected}`} side="sale" capability={model.binding.capability} rule={rules.sale} disabled={editingDisabled} onChange={(sale) => updateRules({ ...rules, sale })} /></Card></>}
                {dirty.current && !validRules ? <Typography.Text type="warning">{trialDraft ? "请选择完整且不重复的规格，每张售价填正整数积分。" : "规则尚未完整或参数档重叠；请补齐后保存、计算样例。"}</Typography.Text> : null}
                {!trialDraft && <Typography.Text type="secondary">{publishedDraftPrice(model.binding, rules) !== null ? "保存仅生成草稿；语音按次价、单图价格、文本分项价目或视频完整规格价须另行发布。价目发布不等于开放生成。" : describePriceDraftSupport(model.binding, rules.sale)} {model.binding.capability === "video" ? "视频按秒草稿仍不可发布；请求时长和成片时长不替代供应商用量证据。" : model.binding.capability === "audio" ? "固定积分是平台成功交付的售价政策，不代表供应商按次计费或返回了用量。" : "文本可选择缓存读取独立模板；缓存写入分档尚未接入，不能直接作为普通输入结算。图片 Token 各项按不重叠用量填写，不能把含图片的总输入重复计费。"}</Typography.Text>}
                <div><Typography.Paragraph className="!mb-1">价格说明草稿</Typography.Paragraph><Input.TextArea aria-label="价目价格说明" autoSize disabled={editingDisabled} value={priceNote} placeholder="填写适用范围；备注不会改变结构化计量规则" onChange={(event) => { dirty.current = true; setPriceNote(event.target.value); }} /></div>
                <Space wrap><Button type="primary" loading={busy === "save"} disabled={editingDisabled || blocked || !bindingConfirmed || trialDraft && !validRules} onClick={() => { void save(); }}>保存价格草稿</Button>
                    <Button disabled={editingDisabled || dirty.current || blocked || !bindingConfirmed || !draft?.bindingMatchesCurrent || trialDraft && !validRules} onClick={openPublication}>{trialDraft ? "核对草稿与试算" : "核对并生效"}</Button>
                    {dirty.current ? <Typography.Text type="secondary">有未保存修改，请先保存草稿。</Typography.Text> : <Typography.Text type="secondary">保存草稿不改变当前收费。</Typography.Text>}</Space>
                {!trialDraft && <Collapse key={`sample:${selected}`} items={[{ key: "sample", label: "试算费用（模拟）", forceRender: true, children: <div>
                    <Typography.Paragraph type="secondary">填写同一任务的模拟参数和用量，分别计算成本与积分售价。缺少用量不会补零，两个币种不相减；结果不是实际报价或可扣费承诺。{capability === "text" ? "文本样例按无缓存写入计算；输入填写总量（含缓存读取），各侧按自身模板计算。手填样例不作为真实用量证据或扣费依据。" : ""}{rules.derivation?.schemaVersion === 2 ? "此处只按短档报价锚点试算；真实任务依实际输入 + 输出总量自动选档，长档三价见上方冻结策略。" : ""}</Typography.Paragraph>
                    <Row gutter={[12, 12]}>{PRICE_PARAMETERS[model.binding.capability].map((key) => <Col xs={24} md={8} key={key}><Typography.Paragraph className="!mb-1">{parameterLabels[key]}</Typography.Paragraph><Input aria-label={`样例${parameterLabels[key]}`} disabled={editingDisabled} value={parameters[key] ?? ""} placeholder="按价格档填写" onChange={(event) => { const next = { ...parameters }; if (event.target.value === "") delete next[key]; else next[key] = event.target.value; setParameters(next); setSample(null); }} /></Col>)}
                        {meters.map((meter) => <Col xs={24} md={8} key={meter}><Typography.Paragraph className="!mb-1">{sampleMeterLabel(meter)}用量（{PRICE_METERS[meter].base === 1_000_000 ? "Token 个数" : PRICE_METERS[meter].unit}）</Typography.Paragraph><Input aria-label={`样例${sampleMeterLabel(meter)}用量`} inputMode="decimal" disabled={editingDisabled} value={usage[meter] ?? ""} placeholder={PRICE_METERS[meter].base === 1_000_000 ? "填写 Token 个数，不是百万份数" : meter === "second" ? "填写秒数，可含小数" : `填写${PRICE_METERS[meter].unit}数`} onChange={(event) => { setUsage({ ...usage, [meter]: event.target.value }); setSample(null); }} /></Col>)}</Row>
                    <Button className="mt-4" disabled={editingDisabled || !validRules} onClick={() => { if (validRules) setSample({ cost: validRules.cost ? manualPriceSample(validRules.cost, parameters, usage) : null, sale: manualPriceSample(validRules.sale, parameters, usage) }); }}>计算样例</Button>
                    {sample ? <Space className="mt-4 w-full" orientation="vertical"><SampleResult label="配置成本估算" value={sample.cost} /><SampleResult label="积分售价样例" value={sample.sale} /></Space> : null}
                </div> }]} />}
            </> : null}
            {!model && busy === null ? <Typography.Text type="secondary">请返回模型列表，选择要设置规格与价格的模型。</Typography.Text> : null}
        </Space>}
        <Modal getContainer={false} open={switchTo !== null} title="切换模型并放弃未保存输入？" okText="切换" cancelText="保留当前输入" onCancel={() => setSwitchTo(null)} onOk={() => { const next = switchTo; setSwitchTo(null); if (next && !busyRef.current && client.current?.isCurrent()) fillSelection(next); }}>
            <Typography.Paragraph>只清除当前表单未保存的输入，后台已保存草稿不会改变。</Typography.Paragraph>
        </Modal>
        <Modal getContainer={false} open={publication !== null} title={trialDialog ? "Gemini 图片报价试算" : "确认价格生效"} width={720} style={{ top: 24 }}
            styles={{ body: { maxHeight: "calc(100dvh - 230px)", overflowY: "auto", paddingRight: 8 } }} onCancel={closePublication}
            footer={publication ? <Space wrap><Button loading={publication.busy === "read"} disabled={publication.busy !== null} onClick={() => { void readPublication(publication.id); }}>{trialDialog ? "重读价格版本" : "重新核对生效状态"}</Button>
                {!trialDialog && !publication.result ? <Button type="primary" loading={publication.busy === "publish"} disabled={publication.busy !== null || !publication.preview || !!publication.preview.unavailableReason || !!publication.preview.publication || publisher.current?.hasUnconfirmed(publication.saved.modelId)} onClick={() => { void publish(); }}>确认生效</Button> : null}
                <Button onClick={closePublication}>关闭</Button></Space> : null}>
            {trialDialog && publication ? <Space orientation="vertical" className="w-full" size="middle">
                <Alert type="info" showIcon title="仅试算 · 当前未开放 Gemini 图片生成" />
                {publication.error && <Alert type="warning" showIcon title={publication.error} />}
                {publication.preview && publisher.current && <GeminiImagePriceTrial source={publication.preview} client={publisher.current} />}
            </Space> : publication ? <Space orientation="vertical" className="w-full" size="middle">
                <Typography.Paragraph className="!mb-0 break-all">{model?.displayName ?? publication.saved.modelId} · 草稿 v{publication.saved.version}</Typography.Paragraph>
                {publication.saved.binding.capability === "text" && <PriceDerivationSummary rules={publication.saved.rules} />}
                <Typography.Text type="secondary">仅让本次保存的售价生效，渠道成本和内部备注不公开。已受理任务保持原价；关闭窗口不能撤销已发送的请求。</Typography.Text>
                {publication.error ? <Alert type="warning" showIcon title={publication.error} /> : null}
                {publication.result ? <Alert type="success" showIcon title={`已核对发布记录：价格版本 ${publication.result.priceVersion}`} description={<><PublicationPrice price={publication.result} /><Typography.Paragraph className="whitespace-pre-wrap break-words">公开价格说明：{publication.result.publicPriceNote || "未填写"}</Typography.Paragraph><Typography.Paragraph className="!mb-0">是否仍为当前有效价格，以最新核对和用户报价为准。</Typography.Paragraph></>} /> : null}
                {publication.preview ? <>
                    {!publication.result && !publication.preview.publication && <PricePublicationComparison preview={publication.preview} />}
                    {publication.preview.unavailableReason && <Alert type="warning" showIcon title={publicationUnavailable[publication.preview.unavailableReason]} />}
                </> : null}
                {!publication.result ? <div><Typography.Paragraph className="!mb-1">公开价格说明（会展示给用户，独立于后台备注）</Typography.Paragraph>
                    {textContextTierNote(publication.saved.rules, publication.saved.binding) && <Alert type="info" showIcon title="双档计费说明固定保留，以下附加备注不能替换" description={<Typography.Paragraph className="whitespace-pre-wrap break-words !mb-0">{textContextTierNote(publication.saved.rules, publication.saved.binding)}</Typography.Paragraph>} />}
                    <Input.TextArea aria-label="公开价格说明" value={publication.publicNote} disabled={publication.busy !== null || !publication.preview || !!publication.preview.unavailableReason || publisher.current?.hasUnconfirmed(publication.saved.modelId)} placeholder="可补充公开备注；不要填写渠道成本、地址、密钥或内部备注" onChange={(event) => { const value = publicationRef.current; if (value && !value.busy) showPublication({ ...value, publicNote: event.target.value }); }} />
                    {publication.saved.rules.derivation?.schemaVersion === 2 && <Typography.Paragraph className="whitespace-pre-wrap break-words mt-2" aria-label="最终公开价格说明">最终发布全文：{publicationPriceNote(publication.saved, publication.publicNote) ?? "无法生成，请重新核对双档合同。"}</Typography.Paragraph>}
                </div> : null}
            </Space> : null}
        </Modal>
    </Card></section>;
}
