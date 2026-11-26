import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Form, Input, Select, Space, Spin, Switch, Tag, Typography } from "antd";
import { useAccountStore } from "@/stores/use-account-store";
import { createPaymentPlatformClient, PaymentPlatformError, type PaymentPlatformClient, type PaymentPlatformScope } from "@/services/saas/payment-platform";
import { compareCreditAmounts, normalizeCreditAmount } from "../../../../../packages/shared/src/credit-amounts";
import { paymentCnyToMinor, paymentMinorToCny, type AdminPaymentOffer, type PaymentConfigurationView, type PaymentMerchantWrite,
    type PaymentOffersWrite, type PaymentType } from "../../../../../packages/shared/src/payment-platform";

export type PaymentOfferDraft = { offerId: string; label: string; amountCny: string; creditUnits: string; policyReference: string; original?: AdminPaymentOffer };
export function paymentOfferDrafts(config: PaymentConfigurationView): PaymentOfferDraft[] {
    return config.offers.map(original => ({ offerId: original.offerId, label: original.label, amountCny: paymentMinorToCny(original.amountMinor),
        creditUnits: original.creditUnits, policyReference: original.policyReference ?? "", original }));
}
/** Allocate a new version only for a changed offer, once per explicit save intent. */
export function buildPaymentOffersWrite(config: PaymentConfigurationView, rows: PaymentOfferDraft[], enabled: boolean,
    newId: () => string = () => crypto.randomUUID()): PaymentOffersWrite {
    if (new Set(rows.map(row => row.offerId.toLowerCase())).size !== rows.length) throw new Error("档位编号重复，请重新读取核对。");
    const values = rows.map(row => {
        const amountMinor = paymentCnyToMinor(row.amountCny), creditUnits = normalizeCreditAmount(row.creditUnits.trim());
        const label = row.label.trim(), policyReference = row.policyReference.trim();
        if (!amountMinor || !creditUnits || compareCreditAmounts(creditUnits, "0") <= 0 || !label) throw new Error("请填写档位名称、正数现金金额（最多两位小数）和正数积分。");
        if (enabled && !policyReference) throw new Error("允许新订单前，每个档位都必须填写经营规则依据。");
        const original = row.original;
        const unchanged = original && original.offerId === row.offerId && original.label === label && original.amountMinor === amountMinor &&
            original.creditUnits === creditUnits && original.policyReference === (policyReference || null);
        if (!unchanged && original && original.revision >= 2_147_483_647) throw new Error("档位版本已达上限，请保留配置并联系管理员核对。");
        return { row, label, amountMinor, creditUnits, policyReference, unchanged };
    });
    if (enabled && (!config.merchant?.credentialConfigured || !values.length)) throw new Error("允许新订单前，请先保存商户凭据并填写档位及经营规则依据。");
    return { expectedRevision: config.revision, newOrdersEnabled: enabled, items: values.map(value => ({
        id: value.unchanged ? value.row.original!.id : newId(), offerId: value.row.offerId,
        revision: value.unchanged ? value.row.original!.revision : (value.row.original?.revision ?? 0) + 1,
        label: value.label, amountMinor: value.amountMinor, creditUnits: value.creditUnits,
        ...(value.policyReference ? { policyReference: value.policyReference } : {}),
    })) };
}
function currentScope(): PaymentPlatformScope | null {
    const account = useAccountStore.getState(), scope = account.getDraftScope();
    return scope && account.user ? { ...scope, role: account.user.role } : null;
}
const live = (client: PaymentPlatformClient) => { try { return client.syncScope(); } catch { return false; } };
const failureMessage = (error: unknown) => error instanceof PaymentPlatformError ? error.message : "请核对填写内容；尚未确认的保存请先读取当前配置核对。";

export default function PaymentPlatformConfiguration() {
    const account = useAccountStore(), scope = account.getDraftScope();
    return scope && account.user?.role === "admin"
        ? <PaymentConfigurationSession key={`${scope.accountId}:${scope.epoch}`} scope={{ ...scope, role: "admin" }} />
        : <Alert type="warning" showIcon title="需要有效的管理员会话" />;
}
function PaymentConfigurationSession({ scope }: { scope: PaymentPlatformScope }) {
    const [client, setClient] = useState<PaymentPlatformClient | null>(null);
    useEffect(() => {
        const instance = createPaymentPlatformClient({ scope, getScope: currentScope, onAccountInvalidated: () => {
            const next = currentScope();
            if (next?.accountId === scope.accountId && next.epoch === scope.epoch && next.role === scope.role) void useAccountStore.getState().refresh();
        } });
        setClient(instance); return () => instance.close();
    }, [scope.accountId, scope.epoch, scope.role]);
    return client ? <ConfigurationEditor key={`${scope.accountId}:${scope.epoch}`} client={client} /> : <Spin size="small" />;
}
function ConfigurationEditor({ client }: { client: PaymentPlatformClient }) {
    const [config, setConfig] = useState<PaymentConfigurationView | null>(null);
    const [merchantId, setMerchantId] = useState(""), [merchantKey, setMerchantKey] = useState("");
    const [paymentType, setPaymentType] = useState<PaymentType | undefined>(), [channelId, setChannelId] = useState(""), [productName, setProductName] = useState("");
    const [rows, setRows] = useState<PaymentOfferDraft[]>([]), [enabled, setEnabled] = useState(false);
    const [merchantDirty, setMerchantDirty] = useState(false), [offersDirty, setOffersDirty] = useState(false), [review, setReview] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
    const [pending, setPending] = useState<ReturnType<PaymentPlatformClient["getPendingIntent"]>>(null), running = useRef(false);
    function fillMerchant(value: PaymentConfigurationView) {
        setMerchantId(value.merchant?.merchantId ?? ""); setPaymentType(value.merchant?.paymentType);
        setChannelId(value.merchant?.channelId ?? ""); setProductName(value.merchant?.productName ?? ""); setMerchantDirty(false);
    }
    function fillOffers(value: PaymentConfigurationView) { setRows(paymentOfferDrafts(value)); setEnabled(value.newOrdersEnabled); setOffersDirty(false); }
    async function read() {
        if (running.current) return;
        running.current = true; setBusy(true); setError("");
        const before = client.getPendingIntent();
        try {
            const value = await client.readConfiguration(); if (!live(client)) return;
            const remaining = client.getPendingIntent(); setConfig(value); setPending(remaining);
            if (before?.kind === "merchant") {
                setNotice("已读取当前活跃配置；原商户保存仍待原操作回执核对，暂不能再次保存。");
                const receipt = await client.readMerchantOperation(before.id); if (!live(client)) return;
                setPending(client.getPendingIntent()); setMerchantKey(""); fillMerchant(value); setReview(offersDirty);
                setNotice(`原商户保存已确认，回执编号 ${receipt.id}。当前活跃配置另以上方最近一次读取为准，原回执不代表原商户版本仍在使用。`);
                return;
            }
            if (!merchantDirty && !before) fillMerchant(value);
            if (before?.kind === "offers" && !remaining) {
                fillOffers(value); setNotice("当前配置与原保存意图的档位版本及内容一致，已通过读取核对。");
            } else if (!offersDirty && !before) fillOffers(value);
            setReview(!remaining && (merchantDirty || offersDirty && before?.kind !== "offers"));
            if (remaining) setNotice("已读取当前配置，但尚未匹配原档位版本；原保存结果仍待核对，暂不能再次保存。");
        } catch (failure) { if (live(client)) setError(failureMessage(failure)); }
        finally { running.current = false; if (live(client)) setBusy(false); }
    }
    async function save(kind: "merchant" | "offers") {
        if (running.current || !config || pending || review || client.requiresConfigurationRead()) return;
        let body: PaymentMerchantWrite | PaymentOffersWrite;
        try {
            if (kind === "merchant") {
                if (!paymentType || !merchantId.trim() || !merchantKey || !productName.trim()) throw new Error("merchant");
                body = { expectedRevision: config.revision, merchantId: merchantId.trim(), merchantKey, paymentType, productName: productName.trim(),
                    ...(channelId.trim() ? { channelId: channelId.trim() } : {}) };
            } else body = buildPaymentOffersWrite(config, rows, enabled);
        } catch (failure) {
            setError(kind === "offers" && failure instanceof Error ? failure.message : "请明确选择支付方式，并填写商户号、商户 Key 和商品名称。"); return;
        }
        const intentId = crypto.randomUUID();
        running.current = true; setBusy(true); setError("");
        try {
            const value = kind === "merchant" ? await client.saveMerchant(intentId, body as PaymentMerchantWrite) : await client.saveOffers(intentId, body as PaymentOffersWrite);
            if (!live(client)) return;
            setConfig(value); setPending(null);
            setReview(value.revision > body.expectedRevision + 1 && (kind === "merchant" ? offersDirty : merchantDirty));
            if (kind === "merchant") { setMerchantKey(""); fillMerchant(value); } else fillOffers(value);
            setNotice(`${kind === "merchant" ? `原商户保存已确认，回执编号 ${intentId}` : "档位配置保存已收到成功回执"}；返回的当前配置版本 ${value.revision}。配置保存不代表真实支付通道验收通过。`);
        } catch (failure) {
            if (live(client)) { setError(failureMessage(failure)); setPending(client.getPendingIntent()); }
        } finally { running.current = false; if (live(client)) setBusy(false); }
    }
    const locked = busy || !!pending, cannotSave = locked || !config || review || client.requiresConfigurationRead();
    const editMerchant = (action: () => void) => { action(); setMerchantDirty(true); };
    const editRow = (offerId: string, changes: Partial<PaymentOfferDraft>) => {
        setRows(current => current.map(row => row.offerId === offerId ? { ...row, ...changes } : row)); setOffersDirty(true);
    };
    const mayEnable = !!config?.merchant?.credentialConfigured && rows.length > 0 && rows.every(row => !!row.policyReference.trim());
    return <section aria-label="支付平台配置" className="space-y-4">
        <Alert type="info" showIcon title="公开充值仍未开放，真实支付通道尚待验收"
            description="此页保存管理员明确填写的商户与“支付 CNY → 积分”档位；配置保存不等于开通充值、真实付款、到账或退款验收。商户 Key 仅本次写入，不回显、不在浏览器持久化。" />
        <Space wrap><Button loading={busy} onClick={() => void read()}>{pending?.kind === "merchant" ? "读取当前配置和原保存回执" : "读取当前配置核对"}</Button>
            {config && <><Tag>配置版本 {config.revision}</Tag><Tag>服务端运行开关：{config.runtimeEnabled ? "已开" : "关闭"}</Tag>
                <Tag>新订单配置：{config.newOrdersEnabled ? "允许" : "关闭"}</Tag></>}
        </Space>
        {!config && <Alert type="info" showIcon title="先读取当前配置，再核对并保存；空白表单不会自动提交。" />}
        {error && <Alert type="error" showIcon title={error} />}
        {notice && <Alert type={pending ? "warning" : "success"} showIcon title={notice} />}
        {pending && <Alert type="warning" showIcon title="原保存结果待核对"
            description={<div><p className="break-all">{pending.kind === "merchant" ? "原商户操作编号" : "本页保存意图编号"}：{pending.id}</p>
                <p>{pending.kind === "merchant" ? "请读取当前配置并按此原编号查询保存回执；尚未读取到回执不代表未保存。" : "此编号用于保留本次意图；未匹配原档位版本不代表未保存。"}请保留本页输入，不能更换编号直接重发。</p></div>} />}
        {review && <Alert type="warning" showIcon title="已读取当前版本，原编辑内容已保留"
            description={<div className="space-y-2"><p>请核对下方当前配置与表单差异，再决定是否按当前版本保存原编辑内容。</p>
                <Button disabled={locked} onClick={() => {
                    if (config) setRows(current => current.map(row => ({ ...row, original: config.offers.find(offer => offer.offerId === row.offerId) ?? row.original })));
                    setReview(false);
                }}>已核对，按当前版本继续编辑</Button>
                <Button className="ml-2" disabled={locked} onClick={() => { if (config) { fillMerchant(config); fillOffers(config); setMerchantKey(""); setReview(false); } }}>放弃编辑，采用读取配置</Button></div>} />}
        {config && <Card size="small" title="最近一次读取或保存回执中的当前配置">
            <p>商户号：{config.merchant?.merchantId ?? "未配置"}；支付方式：{config.merchant?.paymentType ?? "未配置"}；渠道：{config.merchant?.channelId ?? "未配置"}；商品：{config.merchant?.productName ?? "未配置"}；凭据：{config.merchant?.credentialConfigured ? "已配置（不回显）" : "未配置"}</p>
            {config.offers.length ? config.offers.map(offer => <p key={offer.id} className="break-words">{offer.label}：CNY {paymentMinorToCny(offer.amountMinor)} → {offer.creditUnits} 积分；依据：{offer.policyReference ?? "未填写"}；档位版本 {offer.revision}</p>) : <p>暂无档位。</p>}
        </Card>}
        <Card title="商户配置">
            <Form layout="vertical" autoComplete="off">
                <Form.Item label="商户号" required><Input aria-label="支付商户号" value={merchantId} disabled={locked} onChange={event => editMerchant(() => setMerchantId(event.target.value))} /></Form.Item>
                <Form.Item label="支付方式" required><Select aria-label="支付方式" value={paymentType} allowClear disabled={locked} placeholder="请明确选择支付方式"
                    options={[{ value: "alipay", label: "支付宝" }, { value: "wxpay", label: "微信支付" }]} onChange={value => editMerchant(() => setPaymentType(value))} /></Form.Item>
                <Form.Item label="商户 Key（只写）" required extra="每次保存需明确填写；成功后清空。结果未知时保留输入，仅能先读取核对。">
                    <Input.Password aria-label="支付商户Key" value={merchantKey} disabled={locked} autoComplete="new-password" onChange={event => editMerchant(() => setMerchantKey(event.target.value))} /></Form.Item>
                <Form.Item label="渠道编号（可选）"><Input aria-label="支付渠道编号" value={channelId} disabled={locked} onChange={event => editMerchant(() => setChannelId(event.target.value))} /></Form.Item>
                <Form.Item label="商品名称" required><Input aria-label="支付商品名称" value={productName} disabled={locked} onChange={event => editMerchant(() => setProductName(event.target.value))} /></Form.Item>
                <Button type="primary" disabled={cannotSave || !merchantDirty} onClick={() => void save("merchant")}>保存商户配置</Button>
            </Form>
        </Card>
        <Card title="充值档位与经营规则">
            <Typography.Paragraph type="secondary">现金以 CNY 字符串填写，最多两位小数；积分独立填写，不预设价格或兑换倍率。移除档位只影响本次配置，不处理历史订单或退款。</Typography.Paragraph>
            <div className="space-y-3">{rows.map((row, index) => <Card size="small" key={row.offerId} title={`档位 ${index + 1}`} extra={<Button disabled={locked} onClick={() => { setRows(current => current.filter(value => value.offerId !== row.offerId)); setOffersDirty(true); }}>移除此档</Button>}>
                <Form layout="vertical">
                    <Form.Item label="档位名称" required><Input aria-label={`档位${index + 1}名称`} value={row.label} disabled={locked} onChange={event => editRow(row.offerId, { label: event.target.value })} /></Form.Item>
                    <Form.Item label="现金金额（CNY）" required><Input aria-label={`档位${index + 1}现金CNY`} inputMode="decimal" value={row.amountCny} disabled={locked} onChange={event => editRow(row.offerId, { amountCny: event.target.value })} /></Form.Item>
                    <Form.Item label="积分数量" required><Input aria-label={`档位${index + 1}积分`} inputMode="decimal" value={row.creditUnits} disabled={locked} onChange={event => editRow(row.offerId, { creditUnits: event.target.value })} /></Form.Item>
                    <Form.Item label="经营规则依据" extra="允许新订单前必填；填写已批准规则的文档或审批依据。"><Input aria-label={`档位${index + 1}经营规则依据`} value={row.policyReference} disabled={locked} onChange={event => editRow(row.offerId, { policyReference: event.target.value })} /></Form.Item>
                </Form>
            </Card>)}</div>
            <Space wrap className="mt-4"><Button disabled={locked} onClick={() => { setRows(current => [...current, { offerId: crypto.randomUUID(), label: "", amountCny: "", creditUnits: "", policyReference: "" }]); setOffersDirty(true); }}>增加档位</Button>
                <Switch aria-label="允许后续新订单配置" checked={enabled} disabled={locked || !enabled && !mayEnable} onChange={value => { setEnabled(value); setOffersDirty(true); }} />
                <span>允许后续新订单（仍受服务端运行开关控制）</span>
                <Button type="primary" disabled={cannotSave || !offersDirty} onClick={() => void save("offers")}>保存档位配置</Button>
            </Space>
            {!mayEnable && <Typography.Paragraph className="mt-3" type="secondary">商户凭据、至少一档及每档经营规则依据齐全后，方可选择允许新订单；公开充值入口仍关闭。</Typography.Paragraph>}
        </Card>
    </section>;
}
