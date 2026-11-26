import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Col, Form, Input, Modal, Row, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { Trash2 } from "lucide-react";
import { useAccountStore } from "@/stores/use-account-store";
import { inferProviderModel } from "@/services/saas/model-classification";
import { createAdminProviderCatalogClient, fetchAdminProviders, getAdminGenerationScope, PlatformServiceError,
    type AdminModel, type AdminProvider, type AdminProviderDiscovery, type AdminProviderModel, type CatalogDeletionReceipt, type ProviderWrite } from "@/services/saas/platform";

type ProviderForm = Omit<ProviderWrite, "revision" | "discoveryReceiptId"> & { id: string };
type Client = ReturnType<typeof createAdminProviderCatalogClient>;
const labels = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const errorText = (error: unknown) => error instanceof PlatformServiceError ? error.message : "操作未完成，请稍后重新读取核对。";
const newValues: ProviderForm = { id: "", displayName: "", adapter: "openai-compatible", endpoint: "", apiKey: "", enabled: false };

export default function ProviderModelLibrary({ providers, models, rows, beginLibraryRead, onProvidersChange, onDeleted, onSynchronized, onSelectModel }: {
    providers: AdminProvider[]; models: AdminModel[]; rows: AdminProviderModel[]; beginLibraryRead: () => (rows: AdminProviderModel[]) => void;
    onProvidersChange: (rows: AdminProvider[]) => void; onSelectModel: (row: AdminProviderModel) => void;
    onDeleted: (receipt: CatalogDeletionReceipt) => void;
    onSynchronized: (receipt: CatalogDeletionReceipt) => void;
}) {
    const { modal } = App.useApp();
    const scopeKey = useAccountStore((state) => { const scope = state.getDraftScope(); return state.user?.role === "admin" && scope ? `${scope.accountId}:${scope.epoch}` : ""; });
    const [form] = Form.useForm<ProviderForm>();
    const [editor, setEditor] = useState<{ provider: AdminProvider | null } | null>(null);
    const [discovery, setDiscovery] = useState<AdminProviderDiscovery | null>(null);
    const [busy, setBusy] = useState<"read" | "save" | "delete" | "disable" | null>(null), [editorError, setEditorError] = useState("");
    const [deleting, setDeleting] = useState<AdminProvider | null>(null), [deleteError, setDeleteError] = useState("");
    const [deleteBlocked, setDeleteBlocked] = useState(false), deletingRef = useRef(false);
    const [notice, setNotice] = useState("");
    const [libraryBusy, setLibraryBusy] = useState(false), [libraryError, setLibraryError] = useState("");
    const [search, setSearch] = useState(""), [channel, setChannel] = useState<string>(), [kind, setKind] = useState<string>();
    const client = useRef<Client | null>(null), library = useRef<Client | null>(null), dirty = useRef(false), sequence = useRef(0), librarySequence = useRef(0);
    const current = (owner: Client | null) => owner !== null && owner === client.current && owner.isCurrent();

    useLayoutEffect(() => {
        const scope = getAdminGenerationScope();
        sequence.current++; librarySequence.current++; dirty.current = false;
        setEditor(null); setDiscovery(null); setBusy(null); setEditorError(""); setNotice(""); beginLibraryRead()([]); setLibraryError(""); setSearch(""); setChannel(undefined); setKind(undefined); form.resetFields();
        setDeleting(null); setDeleteError(""); setDeleteBlocked(false); deletingRef.current = false;
        if (!scope) return;
        const owner = createAdminProviderCatalogClient({ scope, getScope: getAdminGenerationScope });
        const reader = createAdminProviderCatalogClient({ scope, getScope: getAdminGenerationScope });
        client.current = owner; library.current = reader;
        return () => { sequence.current++; librarySequence.current++; owner.close(); reader.close(); client.current = null; library.current = null; };
    }, [scopeKey, form, beginLibraryRead]);

    async function loadLibrary(refreshProviders = false) {
        const owner = library.current, request = ++librarySequence.current;
        if (!owner?.isCurrent()) return;
        const publishRows = beginLibraryRead();
        const live = () => library.current === owner && owner.isCurrent() && request === librarySequence.current;
        setLibraryBusy(true); setLibraryError("");
        try {
            const [nextRows, nextProviders] = await Promise.all([owner.load(), refreshProviders ? fetchAdminProviders() : Promise.resolve(null)]);
            if (!live()) return;
            if (nextRows) publishRows(nextRows);
            if (nextProviders) { onProvidersChange(nextProviders); setDeleteBlocked(false); setDeleteError(""); setDeleting(null); }
        } catch (failure) { if (live()) setLibraryError(errorText(failure)); }
        finally { if (live()) setLibraryBusy(false); }
    }
    useEffect(() => { void loadLibrary(); }, [scopeKey, providers]);

    function invalidate() {
        sequence.current++; client.current?.cancel(); dirty.current = true; setDiscovery(null); setBusy(null); setEditorError("");
    }
    function close() {
        sequence.current++; client.current?.cancel(); dirty.current = false; form.resetFields(); setEditor(null); setDiscovery(null); setBusy(null); setEditorError("");
    }
    function requestClose() {
        if (busy === "save") return;
        if (!dirty.current) { close(); return; }
        const owner = client.current, request = sequence.current;
        modal.confirm({ title: "关闭未保存的渠道配置？", content: "关闭会清除本次输入和测试结果，已保存渠道不变。", okText: "关闭", cancelText: "继续编辑",
            onOk: () => { if (current(owner) && sequence.current === request) close(); } });
    }
    function open(provider: AdminProvider | null, update = false) {
        const owner = client.current;
        if (!current(owner) || deletingRef.current) return;
        const apply = () => {
            if (!current(owner)) return;
            sequence.current++; owner!.cancel(); dirty.current = false; setDiscovery(null); setEditorError(""); setBusy(null); setNotice("");
            setEditor({ provider }); form.resetFields();
            const next = provider ? { id: provider.id, displayName: provider.displayName, adapter: provider.adapter, endpoint: provider.endpoint, enabled: provider.enabled, apiKey: "" } : { ...newValues };
            form.setFieldsValue(next);
            if (update && provider) void discover(next, provider.revision);
        };
        if (dirty.current) modal.confirm({ title: "替换尚未保存的渠道配置？", content: "继续会替换本次输入和测试结果。", okText: "替换", cancelText: "保留输入", onOk: apply });
        else apply();
    }
    const input = (fields: ProviderForm, revision: number): ProviderWrite => ({ revision, displayName: fields.displayName.trim(), adapter: fields.adapter,
        endpoint: fields.endpoint.trim(), enabled: fields.enabled, ...(fields.apiKey?.trim() ? { apiKey: fields.apiKey.trim() } : {}) });

    async function discover(fields: ProviderForm, revision = editor?.provider?.revision ?? 0) {
        const owner = client.current, request = ++sequence.current;
        if (!current(owner)) return;
        setBusy("read"); setEditorError(""); setDiscovery(null);
        try {
            const result = await owner!.discover(fields.id.trim(), input(fields, revision));
            if (current(owner) && request === sequence.current && result) { setDiscovery(result); dirty.current = true; }
        } catch (failure) { if (current(owner) && request === sequence.current) setEditorError(errorText(failure)); }
        finally { if (current(owner) && request === sequence.current) setBusy(null); }
    }
    async function save() {
        const owner = client.current, request = sequence.current;
        if (!current(owner) || busy) return;
        let fields: ProviderForm;
        try { fields = await form.validateFields(); } catch { return; }
        if (!current(owner) || request !== sequence.current || !discovery) return;
        const body = input(fields, editor?.provider?.revision ?? 0);
        body.discoveryReceiptId = discovery.receiptId;
        setBusy("save"); setEditorError("");
        try {
            const saved = await owner!.save(fields.id.trim(), body);
            if (!current(owner) || request !== sequence.current || !saved) return;
            onProvidersChange([...providers.filter((row) => row.id !== saved.id), saved]);
            onSynchronized({ id: saved.id, revision: saved.revision, modelIds: saved.removedModelIds });
            close(); setNotice(`渠道「${saved.displayName}」与模型库已同步，移除 ${saved.removedModelIds.length} 个节点模型；历史任务与价格已保留。`);
        } catch (failure) {
            if (current(owner) && request === sequence.current) { setDiscovery(null); setEditorError(errorText(failure)); }
        } finally { if (current(owner) && request === sequence.current) setBusy(null); }
    }

    async function removeProvider() {
        const owner = client.current, target = deleting;
        if (!current(owner) || !target || deletingRef.current || busy || deleteBlocked) return;
        deletingRef.current = true; setBusy("delete"); setDeleteError("");
        try {
            const result = await owner!.remove(target.id, target.revision);
            if (!current(owner) || !result) return;
            onDeleted(result); setDeleting(null); if (channel === target.id) setChannel(undefined);
            setNotice(`渠道「${target.displayName}」及其模型已删除，历史任务、账单和价格记录已保留。`);
        } catch (failure) { if (current(owner)) { setDeleteError(errorText(failure)); setDeleteBlocked(true); } }
        finally { if (current(owner)) { deletingRef.current = false; setBusy(null); } }
    }

    function requestDisable(provider: AdminProvider) {
        const owner = client.current;
        if (!current(owner) || busy) return;
        modal.confirm({ title: `停用渠道「${provider.displayName}」？`, content: "停止接收新任务，保留现有任务、模型目录和价格。", okText: "停用渠道", cancelText: "取消",
            onOk: async () => {
                if (!current(owner)) return;
                setBusy("disable"); setLibraryError("");
                try {
                    const saved = await owner!.save(provider.id, { displayName: provider.displayName, endpoint: provider.endpoint, adapter: provider.adapter, enabled: false, revision: provider.revision });
                    if (!current(owner) || !saved) return;
                    onProvidersChange([...providers.filter(row => row.id !== saved.id), saved]);
                    onSynchronized({ id: saved.id, revision: saved.revision, modelIds: saved.removedModelIds });
                    setNotice(`渠道「${saved.displayName}」已停用，目录和历史记录保持。`);
                } catch (failure) { if (current(owner)) setLibraryError(errorText(failure)); }
                finally { if (current(owner)) setBusy(null); }
            } });
    }

    const bindings = new Map(models.map(model => [JSON.stringify([model.providerId, model.providerModel]), model.id]));
    const filtered = rows.map(row => ({ ...row, boundModelId: bindings.get(JSON.stringify([row.providerId, row.providerModel])) ?? null })).filter((row) => {
        const suggestion = inferProviderModel(row.providerModel);
        return (!channel || row.providerId === channel) && (!kind || (suggestion.capability ?? "unknown") === kind)
            && `${row.providerModel} ${row.providerName} ${row.providerId} ${suggestion.brand ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
    });
    return <>
        <Card title={<span className="block whitespace-normal">渠道管理</span>} extra={<Button type="primary" disabled={busy !== null} onClick={() => open(null)}>添加渠道</Button>}>
            <Typography.Paragraph type="secondary">渠道保存时同步最新模型库。先读取并核对变化，确认后移除上游已缺失的型号；有未结束任务时会拦住更新。</Typography.Paragraph>
            {notice && <Alert className="mb-3" type="success" showIcon title={notice} closable onClose={() => setNotice("")} />}
            {deleteError && !deleting && <Alert className="mb-3" type="error" showIcon title={deleteError} action={<Button loading={libraryBusy} onClick={() => void loadLibrary(true)}>刷新渠道和模型库</Button>} />}
            <Table rowKey="id" size="small" dataSource={providers} pagination={false} scroll={{ x: 780 }} locale={{ emptyText: "还没有渠道，点击“添加渠道”开始接入" }} columns={[
                { title: "渠道", render: (_, row) => <><div>{row.displayName}</div><Typography.Text type="secondary">{row.id}</Typography.Text></> },
                { title: "协议 / 地址", render: (_, row) => <><div>{row.adapter === "sub2api" ? "Sub2API" : "OpenAI 兼容"}</div><Typography.Text type="secondary">{row.endpoint}</Typography.Text></> },
                { title: "状态", render: (_, row) => <Space wrap><Tag color={row.enabled ? "green" : undefined}>{row.enabled ? "启用" : "停用"}</Tag>{!row.credentialConfigured && <Tag color="orange">未配置密钥</Tag>}</Space> },
                { title: "操作", render: (_, row) => <Space wrap><Button size="small" disabled={busy !== null} onClick={() => open(row)}>编辑</Button><Button size="small" disabled={busy !== null} onClick={() => open(row, true)}>更新模型库</Button>{row.enabled && <Button size="small" disabled={busy !== null} onClick={() => requestDisable(row)}>停用</Button>}<Button size="small" danger type="text" icon={<Trash2 size={14} />} disabled={busy !== null || deleteBlocked} onClick={() => { setDeleteError(""); setDeleting(row); }}>删除</Button></Space> },
            ]} />
        </Card>
        <Card className="mt-4" title={<span className="block whitespace-normal">渠道模型库</span>} extra={<Button disabled={busy !== null} loading={libraryBusy} onClick={() => void loadLibrary(true)}>刷新已保存目录</Button>}>
            <Typography.Paragraph type="secondary">汇总所有渠道已确认保存的型号；同名模型按来源渠道分别保留。厂商和类型是名称识别建议，配置节点时可修正。读取目录不代表已验证生成能力。</Typography.Paragraph>
            {libraryError && <Alert className="mb-3" type="error" showIcon title={libraryError} />}
            <Space wrap className="mb-3">
                <Input aria-label="搜索模型库" allowClear placeholder="搜索型号、渠道或厂商" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 250 }} />
                <Select aria-label="筛选来源渠道" allowClear placeholder="全部渠道" value={channel} onChange={setChannel} style={{ width: 180 }} options={providers.map((row) => ({ value: row.id, label: row.displayName }))} />
                <Select aria-label="筛选建议类型" allowClear placeholder="全部类型" value={kind} onChange={setKind} style={{ width: 160 }} options={[...Object.entries(labels).map(([value, label]) => ({ value, label: `${label}（建议）` })), { value: "unknown", label: "未识别" }]} />
                <Typography.Text type="secondary">{filtered.length} / {rows.length} 条</Typography.Text>
            </Space>
            <Table rowKey={(row) => JSON.stringify([row.providerId, row.providerModel])} size="small" loading={libraryBusy} dataSource={filtered} pagination={{ pageSize: 10, showSizeChanger: true }} scroll={{ x: 800 }}
                locale={{ emptyText: rows.length ? "没有匹配的型号" : "暂无已保存目录。已有渠道请点“更新模型库”，测试成功后确认保存。" }} columns={[
                    { title: "上游型号", dataIndex: "providerModel", render: (value: string) => <Typography.Text className="break-all">{value}</Typography.Text> },
                    { title: "来源渠道", render: (_, row) => <><div>{row.providerName}</div>{!row.providerEnabled && <Tag>渠道停用</Tag>}</> },
                    { title: "厂商 / 类型建议", render: (_, row) => { const result = inferProviderModel(row.providerModel); return <><div>{result.brand ?? "未识别厂商"}</div><Typography.Text type="secondary">{result.capability ? `${labels[result.capability]}（建议）` : "未识别类型"}</Typography.Text></>; } },
                    { title: "目录状态", render: (_, row) => <div><Tag color={row.available ? "green" : "orange"}>{row.available ? "最近返回有该型号" : "最近返回未含该型号"}</Tag><Typography.Text type="secondary" className="block text-xs">上次返回记录：{new Date(row.lastSeenAt).toLocaleString()}</Typography.Text></div> },
                    { title: "节点配置", render: (_, row) => row.boundModelId ? <Tag color="blue">已配置</Tag> : "未配置" },
                    { title: "操作", render: (_, row) => <Button size="small" onClick={() => onSelectModel(row)}>{row.boundModelId ? "查看节点配置" : "配置到节点"}</Button> },
                ]} />
        </Card>
        <Modal getContainer={false} title={editor?.provider ? `编辑渠道 · ${editor.provider.displayName}` : "添加渠道"} open={editor !== null} width={820} style={{ top: 24 }} forceRender onCancel={requestClose} closable={busy !== "save"} maskClosable={false}
            styles={{ body: { maxHeight: "calc(100dvh - 220px)", overflowY: "auto", overflowX: "hidden" } }}
            footer={<><Button disabled={busy === "save"} onClick={requestClose}>关闭</Button>{discovery && <Button type="primary" loading={busy === "save"} onClick={() => void save()}>确认保存并同步</Button>}</>}>
            <Form form={form} name="admin-provider" layout="vertical" initialValues={newValues} disabled={busy === "save"} onValuesChange={invalidate} onFinish={(fields) => void discover(fields)}>
                <Row gutter={16}>
                    <Col xs={24} md={8}><Form.Item label="渠道 ID" name="id" extra="英文或数字开头，2–64 位，可含 . _ -" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, transform: (value) => value?.trim(), message: "请使用 2–64 位英文、数字或 . _ -" }]}><Input disabled={Boolean(editor?.provider) || busy === "save"} placeholder="例如 my-channel" /></Form.Item></Col>
                    <Col xs={24} md={8}><Form.Item label="显示名称" name="displayName" rules={[{ required: true, whitespace: true, max: 120 }]}><Input placeholder="例如 图片渠道 A" /></Form.Item></Col>
                    <Col xs={24} md={8}><Form.Item label="接口协议" name="adapter" rules={[{ required: true }]}><Select options={[{ value: "openai-compatible", label: "OpenAI 兼容" }, { value: "sub2api", label: "Sub2API" }]} /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item label="Endpoint（HTTPS）" name="endpoint" rules={[{ required: true, whitespace: true }, { type: "url", message: "请填写完整 HTTPS 地址" }]}><Input placeholder="https://api.example.com/v1" /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item label={editor?.provider ? "API Key（留空保留原密钥）" : "API Key"} name="apiKey" rules={editor?.provider ? [] : [{ required: true, whitespace: true, message: "新渠道需要 API Key" }]}><Input.Password autoComplete="new-password" placeholder="密钥仅提交给平台服务端" /></Form.Item></Col>
                    <Col xs={24}><Form.Item label="启用渠道" name="enabled" valuePropName="checked"><Switch /></Form.Item></Col>
                </Row>
                <Space wrap><Button type="primary" htmlType="submit" loading={busy === "read"}>测试并读取模型</Button>
                </Space>
            </Form>
            {busy === "read" && <Alert className="mt-3" type="info" showIcon title="正在测试并读取模型目录…" description="读取结果会显示在这里，确认保存前不会修改已保存渠道和模型库。" />}
            {editorError && <Alert className="mt-3" type="error" showIcon title="渠道操作未完成" description={editorError} />}
            {discovery && <div className="mt-4 space-y-3">
                <Alert type="success" showIcon title={`读取成功 · 返回 ${discovery.models.length} 个型号，尚未保存`} description={`新增 ${discovery.added.length} 个 · 本次仍有 ${discovery.unchanged} 个 · 本次未返回 ${discovery.missing.length} 个。此处只验证目录接口，未执行生成。`} />
                {(discovery.missing.length > 0 || discovery.bindings.some(item => !item.found)) && <Alert type="warning" showIcon title="确认后将移除缺失型号" description={<><div className="break-all">{[...new Set([...discovery.missing, ...discovery.bindings.filter(item => !item.found).map(item => item.providerModel)])].join("、")}</div><div>受影响节点：{discovery.bindings.filter(item => !item.found).map(item => item.displayName).join("、") || "无"}。对应草稿来源会一并移除；历史任务和价格保留。有未结束或待核对任务时，本次更新不会保存。</div></>} />}
                <Table rowKey="id" size="small" pagination={{ pageSize: 6 }} dataSource={discovery.models.map((id) => ({ id }))} columns={[
                    { title: "本次返回型号", dataIndex: "id" }, { title: "变化", render: (_, row) => discovery.added.includes(row.id) ? <Tag color="green">新增</Tag> : "已有" },
                    { title: "节点配置", render: (_, row) => discovery.bindings.some((binding) => binding.providerModel === row.id) ? "已配置" : "未配置" },
                ]} />
            </div>}
        </Modal>
        <Modal getContainer={false} open={deleting !== null} title={`删除渠道「${deleting?.displayName ?? ""}」？`} okText="删除渠道及模型" cancelText="取消" okButtonProps={{ danger: true, disabled: deleteBlocked }} confirmLoading={busy === "delete"} cancelButtonProps={{ disabled: busy === "delete" }} closable={busy !== "delete"} maskClosable={false} onCancel={() => { if (!deletingRef.current) setDeleting(null); }} onOk={() => void removeProvider()}>
            <Typography.Paragraph>该渠道的模型库和全部节点模型会一并移除，不能再用于新的生成。历史任务、账单和价格记录保留。删除后不能恢复原配置。</Typography.Paragraph>
            <Typography.Paragraph>有未结束或待核对的任务时，暂不允许删除。</Typography.Paragraph>
            {deleting && <Typography.Paragraph>当前已配置 {models.filter(row => row.providerId === deleting.id).length} 个节点模型。</Typography.Paragraph>}
            {deleting && <ul className="mb-4 max-h-40 list-disc overflow-auto pl-5">{models.filter(row => row.providerId === deleting.id).map(row => <li key={row.id} className="break-all">{row.displayName} · {row.id}</li>)}</ul>}
            {deleteError && <Alert type="error" showIcon title={deleteError} action={<Button loading={libraryBusy} onClick={() => void loadLibrary(true)}>刷新渠道和模型库</Button>} />}
        </Modal>
    </>;
}
