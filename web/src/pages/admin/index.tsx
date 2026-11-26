import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Col, Form, Input, Menu, Row, Segmented, Select, Spin, Steps, Table, Tag, Typography } from "antd";
import { CreditCard, History, Images, ListChecks, Network, ShieldCheck, Users } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { useAccountStore } from "@/stores/use-account-store";
import GenerationTaskReview from "./components/GenerationTaskReview";
import ModelPriceDraft from "./components/ModelPriceDraft";
import ProviderModelLibrary from "./components/ProviderModelLibrary";
import NodeModelConfiguration, { type DiscoveredSelectionRequest, type PriceSelectionRequest } from "./components/NodeModelConfiguration";
import ModelMappingPreview, { type MappingSourceFocus } from "./components/ModelMappingPreview";
import { ImageSpecPriceLines } from "@/components/account/image-spec-price-lines";
import { VideoSpecPriceLines } from "@/components/account/video-spec-price-lines";
import InspirationAdmin from "./inspiration";
import ContentSafetyAdmin from "./content-safety";
import PaymentPlatformConfiguration from "./payments/PaymentPlatformConfiguration";
import {
    adjustAdminUserBalance, fetchAdminModels, fetchAdminPricing, fetchAdminProviders, fetchAdminUsers, fetchPlatformPricing, PlatformServiceError, getAdminGenerationScope,
    normalizeCreditAmount,
    type AdminBalanceAdjustment, type AdminModel, type AdminPricing, type AdminProvider, type AdminProviderModel, type AdminUser, type CatalogDeletionReceipt,
} from "@/services/saas/platform";

type BalanceForm = AdminBalanceAdjustment & { userId: string };
type PublicPricingStatus = "loading" | "ready" | "unknown";
const sections = [
    { key: "models", label: "模型与渠道", icon: <Network size={16} /> },
    { key: "prices", label: "价格历史", icon: <History size={16} /> },
    { key: "users", label: "用户与积分", icon: <Users size={16} /> },
    { key: "tasks", label: "生成任务", icon: <ListChecks size={16} /> },
    { key: "inspiration", label: "灵感管理", icon: <Images size={16} /> },
    { key: "safety", label: "安全与投诉", icon: <ShieldCheck size={16} /> },
    { key: "payments", label: "支付设置", icon: <CreditCard size={16} /> },
];

function isPriceActive(item: AdminPricing, now = Date.now()): boolean {
    return item.enabled && Date.parse(item.effectiveFrom) <= now
        && (item.effectiveTo === null || Date.parse(item.effectiveTo) > now);
}

export default function AdminPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const section = sections.find(item => item.key === searchParams.get("section"))?.key ?? "models";
    const selectSection = (key: string) => { if (sections.some(item => item.key === key)) setSearchParams(current => { const next = new URLSearchParams(current); next.set("section", key); return next; }); };
    const user = useAccountStore((state) => state.user);
    const scopeKey = useAccountStore((state) => { const scope = state.getDraftScope(); return state.user?.role === "admin" && scope ? `${scope.accountId}:${scope.epoch}` : ""; });
    const [models, setModels] = useState<AdminModel[]>([]);
    const [providers, setProviders] = useState<AdminProvider[]>([]);
    const [providerModels, setProviderModels] = useState<AdminProviderModel[]>([]);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [pricing, setPricing] = useState<AdminPricing[]>([]);
    const [publishedModelIds, setPublishedModelIds] = useState<string[]>([]);
    const [publicPricingStatus, setPublicPricingStatus] = useState<PublicPricingStatus>("loading");
    const [activeStep, setActiveStep] = useState(1);
    const [modelView, setModelView] = useState("nodes");
    const [directoryChange, setDirectoryChange] = useState(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<PlatformServiceError | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [discoveredSelection, setDiscoveredSelection] = useState<DiscoveredSelectionRequest | null>(null);
    const [priceSelection, setPriceSelection] = useState<PriceSelectionRequest | null>(null);
    const [mappingSourceFocus, setMappingSourceFocus] = useState<(MappingSourceFocus & { scopeKey: string }) | null>(null);
    const removed = useRef({ models: new Set<string>(), providers: new Set<string>() });
    const [removedModelIds, setRemovedModelIds] = useState<string[]>([]);
    const selectionSequence = useRef(0);
    const [balanceForm] = Form.useForm<BalanceForm>();
    const balanceAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
    const reloadRequest = useRef(0);
    const publicPricingRequest = useRef(0);
    const libraryReadVersion = useRef(0);
    const beginLibraryRead = useCallback(() => {
        const version = ++libraryReadVersion.current;
        return (rows: AdminProviderModel[]) => {
            if (version === libraryReadVersion.current) setProviderModels(rows.filter(row => !removed.current.providers.has(row.providerId))
                .map(row => row.boundModelId && removed.current.models.has(row.boundModelId) ? { ...row, boundModelId: null } : row));
        };
    }, []);

    async function refreshPublishedModels() {
        const scope = getAdminGenerationScope(), request = ++publicPricingRequest.current;
        setPublishedModelIds([]); setPublicPricingStatus("loading");
        if (!scope) return;
        try {
            const rows = await fetchPlatformPricing({ accountId: scope.accountId, signal: new AbortController().signal });
            const next = getAdminGenerationScope();
            if (request === publicPricingRequest.current && next?.accountId === scope.accountId && next.epoch === scope.epoch) {
                setPublishedModelIds(rows.map(row => row.modelId).filter(id => !removed.current.models.has(id))); setPublicPricingStatus("ready");
            }
        } catch { if (request === publicPricingRequest.current) setPublicPricingStatus("unknown"); }
    }

    async function reload() {
        const scope = getAdminGenerationScope(), request = ++reloadRequest.current;
        if (!scope) return;
        const pricingRequest = ++publicPricingRequest.current; setPublishedModelIds([]); setPublicPricingStatus("loading");
        const [nextModels, nextUsers, nextPricing, nextProviders] = await Promise.all([fetchAdminModels(), fetchAdminUsers(), fetchAdminPricing(), fetchAdminProviders()]);
        const next = getAdminGenerationScope();
        if (!next || next.accountId !== scope.accountId || next.epoch !== scope.epoch || request !== reloadRequest.current) return;
        setModels(nextModels.filter(row => !removed.current.models.has(row.id) && !removed.current.providers.has(row.providerId)));
        setUsers(nextUsers); setPricing(nextPricing);
        setProviders(nextProviders.filter(row => !removed.current.providers.has(row.id)));
        try {
            const publicPricing = await fetchPlatformPricing({ accountId: scope.accountId, signal: new AbortController().signal });
            const live = getAdminGenerationScope();
            if (pricingRequest === publicPricingRequest.current && live?.accountId === scope.accountId && live.epoch === scope.epoch) {
                setPublishedModelIds(publicPricing.map(row => row.modelId).filter(id => !removed.current.models.has(id))); setPublicPricingStatus("ready");
            }
        } catch { if (pricingRequest === publicPricingRequest.current) setPublicPricingStatus("unknown"); }
    }

    useEffect(() => {
        libraryReadVersion.current++;
        removed.current = { models: new Set(), providers: new Set() }; setRemovedModelIds([]);
        setModels([]); setProviders([]); setProviderModels([]); setUsers([]); setPricing([]); setPublishedModelIds([]); setPublicPricingStatus("loading"); setNotice(null); setError(null); setSaving(false);
        balanceForm.resetFields(); balanceAttempt.current = null; setDiscoveredSelection(null); setPriceSelection(null); setMappingSourceFocus(null);
        if (!scopeKey) { setLoading(false); return; }
        setLoading(true);
        let active = true;
        void reload().then(() => { if (active) { setError(null); setNotice(null); } })
            .catch((failure) => { if (active) setError(failure instanceof PlatformServiceError ? failure : new PlatformServiceError()); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; reloadRequest.current++; publicPricingRequest.current++; };
    }, [scopeKey]);

    function acceptDeletion(receipt: CatalogDeletionReceipt, provider = false) {
        setDirectoryChange(value => value + 1);
        reloadRequest.current++; publicPricingRequest.current++; libraryReadVersion.current++;
        for (const id of receipt.modelIds) removed.current.models.add(id);
        if (provider) removed.current.providers.add(receipt.id);
        setRemovedModelIds([...removed.current.models]);
        setModels(current => current.filter(row => !removed.current.models.has(row.id) && !removed.current.providers.has(row.providerId)));
        setProviders(current => current.filter(row => !removed.current.providers.has(row.id)));
        setProviderModels(current => current.filter(row => !removed.current.providers.has(row.providerId))
            .map(row => row.boundModelId && removed.current.models.has(row.boundModelId) ? { ...row, boundModelId: null } : row));
        setPublishedModelIds(current => current.filter(id => !removed.current.models.has(id)));
        setPricing(current => current.map(row => removed.current.models.has(row.modelId) || removed.current.providers.has(row.providerId) ? { ...row, deleted: true } : row));
        setDiscoveredSelection(null); setPriceSelection(null);
        const scope = getAdminGenerationScope();
        void reload().catch(() => {
            const current = getAdminGenerationScope();
            if (scope && current?.accountId === scope.accountId && current.epoch === scope.epoch) setNotice("配置更新已确认，后续列表读取失败。请刷新后台核对，勿重复提交。");
        });
    }

    async function adjustBalance(values: BalanceForm) {
        const scope = getAdminGenerationScope();
        if (!scope || saving) return;
        const live = () => { const next = getAdminGenerationScope(); return next?.accountId === scope.accountId && next.epoch === scope.epoch; };
        setSaving(true); setNotice(null);
        try {
            const amount = normalizeCreditAmount(values.amount);
            if (typeof values.amount !== "string" || amount === null || amount === "0") throw new PlatformServiceError("请输入非零十进制积分");
            const input = { amount, reason: values.reason };
            const fingerprint = JSON.stringify({ userId: values.userId, ...input });
            const attempt = balanceAttempt.current?.fingerprint === fingerprint ? balanceAttempt.current : { fingerprint, key: crypto.randomUUID() };
            balanceAttempt.current = attempt;
            await adjustAdminUserBalance(values.userId, input, attempt.key);
            if (!live()) return;
            balanceAttempt.current = null;
            balanceForm.resetFields(["amount", "reason"]);
            try {
                await reload();
                if (live()) setNotice(`余额调整 ${amount} 积分已写入不可变流水。`);
            } catch {
                if (live()) setNotice(`余额调整 ${amount} 积分已写入，但用户列表刷新失败。请重新读取后台，不要重复调整。`);
            }
        } catch (failure) { if (live()) setNotice(failure instanceof PlatformServiceError ? "余额调整失败，请检查用户、金额或当前余额。" : "余额调整失败，请稍后重试。"); }
        finally { if (live()) setSaving(false); }
    }

    if (user?.role !== "admin") return <main className="h-full overflow-auto bg-background p-6"><Alert type="warning" showIcon title="需要管理员权限" description="当前账户可以使用画布，但不能打开管理后台。" /></main>;

    return <main className="h-full overflow-auto bg-background p-4 sm:p-6">
        <div className="mx-auto max-w-[1440px]">
            <header className="mb-6">
                <div className="mb-1 flex flex-wrap items-center gap-2"><Typography.Title level={3} className="!mb-0">平台后台</Typography.Title><Tag color="gold">超级管理员</Tag></div>
            </header>
            <div className="grid items-start gap-5 lg:grid-cols-[168px_minmax(0,1fr)] lg:gap-7">
                <nav aria-label="后台分区" className="min-w-0 lg:sticky lg:top-0">
                    <div className="hidden lg:block"><Menu mode="inline" selectedKeys={[section]} items={sections} onClick={({ key }) => selectSection(key)} style={{ background: "transparent", borderInlineEnd: 0 }} /></div>
                    <Select aria-label="后台分区" className="w-full lg:!hidden" value={section} options={sections.map(({ key, label }) => ({ value: key, label }))} onChange={selectSection} />
                </nav>
                <div className="min-w-0 space-y-4">
            {/* Keep panels mounted so navigation retains drafts and pending write receipts. */}
            <section aria-label="灵感管理" hidden={section !== "inspiration"}><InspirationAdmin key={scopeKey} /></section>
            <section aria-label="安全与投诉" hidden={section !== "safety"}><ContentSafetyAdmin /></section>
            <section aria-label="支付设置" hidden={section !== "payments"}><PaymentPlatformConfiguration /></section>
            <div hidden={!["models", "prices", "users", "tasks"].includes(section)}>
            {loading ? <div className="flex items-center justify-center py-10"><Spin /><span className="ml-3">正在读取后台数据…</span></div>
                : error ? <Alert type="error" showIcon title={error.status === 401 ? "管理员会话已失效" : error.status === 403 ? "当前账户没有后台权限" : "后台服务暂时不可用"} description={error.message} action={<Button size="small" href="/account">重新登录</Button>} /> : null}
            </div>
            {notice && <Alert type="info" showIcon title={notice} closable onClose={() => setNotice(null)} />}
            {!loading && !error && <>
            <section aria-label="生成任务" hidden={section !== "tasks"}><GenerationTaskReview /></section>
            <section aria-label="模型与渠道" hidden={section !== "models"} className="min-w-0 space-y-5">
            <div className="border-b border-border pb-5">
                <div className="hidden sm:block"><Steps size="small" current={activeStep - 1} responsive items={[{ title: "接入渠道" }, { title: "模型与价格" }]} onChange={step => setActiveStep(step + 1)} /></div>
                <Select aria-label="模型配置步骤" className="w-full sm:!hidden" value={activeStep} options={[{ value: 1, label: "1 · 接入渠道" }, { value: 2, label: "2 · 模型与价格" }]} onChange={setActiveStep} />
            </div>
            <section id="admin-model-step-1" className={activeStep === 1 ? "" : "hidden"}><ProviderModelLibrary providers={providers} models={models} rows={providerModels} beginLibraryRead={beginLibraryRead} onProvidersChange={rows => { setProviders(rows.filter(row => !removed.current.providers.has(row.id))); void reload().catch(() => undefined); }} onDeleted={receipt => acceptDeletion(receipt, true)} onSynchronized={receipt => acceptDeletion(receipt)} onSelectModel={row => { setActiveStep(2); setModelView("nodes"); setDiscoveredSelection({ row, requestId: ++selectionSequence.current }); }} /></section>
            <section id="admin-model-step-2" className={activeStep === 2 ? "space-y-4" : "hidden"}>
                <div hidden={modelView === "price"}><Segmented aria-label="模型配置视图" value={modelView} onChange={setModelView} options={[{ value: "nodes", label: "渠道节点" }, { value: "mapping", label: "统一模型与价格" }]} /></div>
                <div hidden={modelView !== "nodes"}><NodeModelConfiguration key={scopeKey} models={models} providers={providers} library={providerModels} beginLibraryRead={beginLibraryRead} publishedModelIds={publishedModelIds} publicPricingStatus={publicPricingStatus}
                    removedModelIds={removedModelIds} selectionRequest={discoveredSelection} onDeleted={receipt => acceptDeletion(receipt)} onModelsChange={rows => { reloadRequest.current++; setModels(rows.filter(row => !removed.current.models.has(row.id) && !removed.current.providers.has(row.providerId))); void refreshPublishedModels(); }} onConfigurePrice={request => { setModelView("price"); setPriceSelection(request); }} onOpenMapping={model => {
                        if (model.capability !== "image" && model.capability !== "video") return;
                        setPriceSelection(null); setModelView("mapping"); setMappingSourceFocus({ providerId: model.providerId, providerModel: model.providerModel, capability: model.capability, requestId: ++selectionSequence.current, scopeKey });
                    }} /></div>
                <div hidden={modelView !== "mapping"}><ModelMappingPreview key={scopeKey} directoryChange={directoryChange} sourceFocus={mappingSourceFocus?.scopeKey === scopeKey ? mappingSourceFocus : null} onPublished={() => {
                    setPriceSelection(null); setDiscoveredSelection(null);
                    const scope = getAdminGenerationScope();
                    void reload().catch(() => { const current = getAdminGenerationScope();
                        if (scope && current?.accountId === scope.accountId && current.epoch === scope.epoch) setNotice("生效已确认，列表尚未刷新，请手动刷新核对。");
                    });
                }} /></div>
                <div hidden={modelView !== "price"}><ModelPriceDraft removedModelIds={removedModelIds} selectionRequest={priceSelection} publishedModelIds={publishedModelIds} publicPricingStatus={publicPricingStatus} onBack={() => setModelView("nodes")} onPublished={() => { void reload().catch(() => undefined); }} /></div>
            </section>
            </section>
            <section aria-label="价格历史" hidden={section !== "prices"} className="min-w-0">
            <Card title="模型价格历史（只读）" extra={<Tag color={pricing.length ? "green" : "default"}>{pricing.length} 个版本</Tag>}>
                <Typography.Paragraph type="secondary" className="!mb-3">保留历史价格记录，包括已删除的模型与渠道。修改价格请进入“模型与渠道 → 模型与价格”，选择模型后保存草稿并确认生效。</Typography.Paragraph>
                <Table className="mt-4" scroll={{ x: 760 }} rowKey="id" size="small" pagination={false} dataSource={pricing} columns={[
                    { title: "模型", dataIndex: "displayName" }, { title: "版本", dataIndex: "version" },
                    { title: "用户售价", render: (_: unknown, row: AdminPricing) => row.billingUnit === "video_specs" ? <VideoSpecPriceLines price={row} /> : row.billingUnit === "image_specs" ? <ImageSpecPriceLines price={row} /> : row.billingUnit === "text_tokens" ? <div className="tabular-nums"><div>{row.cachedInputCreditsPerMillion === undefined ? "输入" : "非缓存输入"} {row.inputCreditsPerMillion} 积分 / 百万 Token</div>{row.cachedInputCreditsPerMillion !== undefined && <div>缓存读取 {row.cachedInputCreditsPerMillion} 积分 / 百万 Token</div>}<div>输出 {row.outputCreditsPerMillion} 积分 / 百万 Token</div></div> : `${row.creditsPerUnit} 积分 / ${{ request: "次", input_token: "输入 Token", output_token: "输出 Token", second: "秒", megapixel: "百万像素" }[row.billingUnit]}` },
                    { title: "公开说明", render: (_: unknown, row: AdminPricing) => <span className="whitespace-pre-wrap break-words">{row.priceNote || "未填写"}</span> },
                    { title: "状态", render: (_: unknown, row: AdminPricing) => {
                        const model = models.find((item) => item.id === row.modelId);
                        if (row.deleted) return <Tag>已删除 · 历史记录</Tag>;
                        if (!row.enabled) return <Tag>关闭/历史</Tag>;
                        if (!row.modelEnabled) return <Tag>模型停用</Tag>;
                        if (!row.providerEnabled) return <Tag>渠道停用</Tag>;
                        if (!model?.secretRefConfigured) return <Tag color="orange">缺少 API Key</Tag>;
                        if (!isPriceActive(row)) return <Tag color="orange">未生效</Tag>;
                        if (publicPricingStatus !== "ready") return <Tag color="orange">公开目录未知</Tag>;
                        if (!publishedModelIds.includes(row.modelId)) return <Tag color="orange">未在公开目录</Tag>;
                        return <Tag color="green">启用</Tag>;
                    } },
                ]} />
            </Card>
            </section>
            <section aria-label="用户与积分" hidden={section !== "users"} className="min-w-0">
                <Card title={`用户与积分（${users.length}）`}><Table scroll={{ x: 640 }} rowKey="id" size="small" pagination={false} dataSource={users} columns={[
                    { title: "邮箱", dataIndex: "email" }, { title: "角色", dataIndex: "role", render: (value: AdminUser["role"]) => <Tag color={value === "admin" ? "gold" : undefined}>{value === "admin" ? "超级管理员" : "普通用户"}</Tag> },
                    { title: "可用积分", render: (_: unknown, row: AdminUser) => <span className="break-all tabular-nums">{row.wallet.availableUnits}</span> },
                    { title: "冻结积分", render: (_: unknown, row: AdminUser) => <span className="break-all tabular-nums">{row.wallet.reservedUnits}</span> },
                    { title: "状态", render: (_: unknown, row: AdminUser) => row.disabled ? <Tag color="red">停用</Tag> : <Tag color="green">正常</Tag> },
                ]} /><Form className="mt-6 border-t border-border pt-5" form={balanceForm} layout="vertical" onFinish={(values) => void adjustBalance(values)} disabled={saving}>
                    <Typography.Title level={5}>调整积分</Typography.Title>
                    <Row gutter={12}>
                        <Col xs={24} md={10}><Form.Item label="调整用户" name="userId" rules={[{ required: true, message: "请选择用户" }]}><Select options={users.map((row) => ({ value: row.id, label: `${row.name} · ${row.email}` }))} placeholder="选择账户" /></Form.Item></Col>
                        <Col xs={24} md={6}><Form.Item label="调整积分" name="amount" extra="可输入精确小数；正数增加，负数扣减，不自动舍入。" rules={[{ required: true, validator: (_, value) => typeof value === "string" && normalizeCreditAmount(value) !== null && normalizeCreditAmount(value) !== "0" ? Promise.resolve() : Promise.reject(new Error("请输入非零十进制积分，不使用指数格式")) }]}><Input className="w-full" placeholder="例如 0.000004 或 -0.000004" /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item label="原因" name="reason" rules={[{ required: true, min: 1, max: 500, message: "请填写原因" }]}><Input placeholder="例如：内测补偿" /></Form.Item></Col>
                    </Row>
                    <Button htmlType="submit" loading={saving}>写入余额流水</Button>
                </Form></Card>
            </section>
            </>}
                </div>
            </div>
        </div>
    </main>;
}
