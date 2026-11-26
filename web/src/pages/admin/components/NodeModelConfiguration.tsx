import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Col, Form, Input, Modal, Row, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { createNodeModelConfigurationClient, type NodeModelGroup, type NodeModelGroups } from "@/services/saas/node-model-configuration";
import { inferProviderModel } from "@/services/saas/model-classification";
import { geminiImageBindingOptions } from "../../../../../packages/shared/src/generation-gemini-image";
import { getAdminGenerationScope, PlatformServiceError, type AdminModel, type AdminProvider, type AdminProviderModel, type CatalogDeletionReceipt, type ModelWrite, type PricingCapability } from "@/services/saas/platform";

export type PriceSelectionRequest = { modelId: string; capability: PricingCapability; requestId: number };
export type DiscoveredSelectionRequest = { row: AdminProviderModel; requestId: number };
type Client = ReturnType<typeof createNodeModelConfigurationClient>;
type ModelForm = Omit<ModelWrite, "revision"> & { id: string };
const labels = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const errorText = (failure: unknown) => failure instanceof PlatformServiceError ? failure.message : "操作未完成，请重新读取配置核对。";
export const pricingConfigurationRoute = (capability: AdminModel["capability"]) => capability === "image" || capability === "video" ? "mapping" : "price-draft";

export default function NodeModelConfiguration({ models, providers, library, beginLibraryRead, publishedModelIds, publicPricingStatus = "ready", removedModelIds, selectionRequest, onModelsChange, onDeleted, onConfigurePrice, onOpenMapping }: {
    models: AdminModel[]; providers: AdminProvider[]; library: AdminProviderModel[]; publishedModelIds: string[]; publicPricingStatus?: "loading" | "ready" | "unknown"; selectionRequest: DiscoveredSelectionRequest | null;
    beginLibraryRead: () => (rows: AdminProviderModel[]) => void;
    onModelsChange: (rows: AdminModel[]) => void; onConfigurePrice: (request: PriceSelectionRequest) => void;
    removedModelIds: string[]; onDeleted: (receipt: CatalogDeletionReceipt) => void; onOpenMapping: (model: AdminModel) => void;
}) {
    const { modal } = App.useApp();
    const [kind, setKind] = useState<AdminModel["capability"]>("text"), [filter, setFilter] = useState("all");
    const [query, setQuery] = useState(""), [directoryStatus, setDirectoryStatus] = useState("all");
    const [documents, setDocuments] = useState<NodeModelGroups[]>([]);
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
    const [error, setError] = useState(""), [notice, setNotice] = useState("");
    const [editor, setEditor] = useState<{ original: AdminModel | null } | null>(null), [groupEditor, setGroupEditor] = useState<{ capability: PricingCapability; id?: string; name: string } | null>(null);
    const [deleting, setDeleting] = useState<AdminModel | null>(null);
    const [deletingGroup, setDeletingGroup] = useState<{ capability: PricingCapability; group: NodeModelGroup } | null>(null);
    const [form] = Form.useForm<ModelForm>();
    const selectedKind = Form.useWatch("capability", form) as AdminModel["capability"] | undefined;
    const selectedProvider = Form.useWatch("providerId", form) as string | undefined;
    const selectedModel = Form.useWatch("providerModel", form) as string | undefined;
    const removedRef = useRef(removedModelIds); removedRef.current = removedModelIds;
    const client = useRef<Client | null>(null), busyRef = useRef(false), dirty = useRef(false), selectionSeen = useRef<number | undefined>(undefined), priceSequence = useRef(0);
    const groups = documents.find(doc => doc.capability === kind)?.groups ?? [];
    const editorGroups = documents.find(doc => doc.capability === selectedKind)?.groups ?? [];
    const live = (owner: Client | null) => owner !== null && client.current === owner && owner.isCurrent();

    async function read() {
        const owner = client.current; if (!owner || !live(owner) || busyRef.current) return;
        const publishRows = beginLibraryRead();
        busyRef.current = true; setLoading(true); setError("");
        try {
            const data = await owner.load(); if (!data || !live(owner)) return;
            setDocuments(data.groups); publishRows(data.library); onModelsChange(data.models); setBlocked(false);
        } catch (failure) { if (live(owner)) { setError(errorText(failure)); setBlocked(true); } }
        finally { if (live(owner)) { busyRef.current = false; setLoading(false); } }
    }
    useLayoutEffect(() => {
        const scope = getAdminGenerationScope(); if (!scope) { setLoading(false); return; }
        const owner = createNodeModelConfigurationClient({ scope, getScope: getAdminGenerationScope }); client.current = owner; void read();
        return () => { owner.close(); if (client.current === owner) client.current = null; busyRef.current = false; };
    }, []);
    function replaceEditor(action: () => void) {
        const owner = client.current; if (!owner || !live(owner) || busyRef.current) return;
        const apply = () => { if (live(owner) && !busyRef.current) action(); };
        if (!dirty.current) return apply();
        modal.confirm({ title: "替换尚未保存的模型配置？", content: "当前输入会被替换，已保存模型和价格保持不变。", okText: "替换输入", cancelText: "继续编辑", onOk: apply });
    }
    useEffect(() => {
        if (editor && (editor.original && removedModelIds.includes(editor.original.id) || selectedProvider && !providers.some(row => row.id === selectedProvider))) {
            dirty.current = false; setEditor(null); setNotice("所编辑的模型已随渠道删除，请重新选择。");
        }
        if (deleting && removedModelIds.includes(deleting.id)) setDeleting(null);
    }, [removedModelIds, providers, selectedProvider, editor?.original?.id, deleting?.id]);
    function openModel(row?: AdminModel, source?: AdminProviderModel) {
        replaceEditor(() => {
            const type = row?.capability ?? (source ? inferProviderModel(source.providerModel).capability ?? undefined : kind);
            form.resetFields();
            form.setFieldsValue(row ? { id: row.id, providerId: row.providerId, providerModel: row.providerModel, displayName: row.displayName, capability: row.capability, enabled: row.enabled, groupId: row.groupId }
                : { id: "", providerId: source?.providerId, providerModel: source?.providerModel, displayName: source?.providerModel ?? "", capability: type, enabled: false, groupId: filter !== "all" && filter !== "ungrouped" && type === kind ? filter : null });
            if (type) { setKind(type); setFilter("all"); }
            dirty.current = false; setEditor({ original: row ?? null }); setError(""); setNotice("");
        });
    }
    useEffect(() => {
        if (!selectionRequest || selectionSeen.current === selectionRequest.requestId || loading || busy) return;
        selectionSeen.current = selectionRequest.requestId;
        const source = selectionRequest.row;
        openModel(models.find(row => row.providerId === source.providerId && row.providerModel === source.providerModel), source);
    }, [selectionRequest, loading, busy, models]);
    const closeEditor = () => replaceEditor(() => { dirty.current = false; setEditor(null); });
    const reload = () => replaceEditor(() => { dirty.current = false; setEditor(null); setGroupEditor(null); setDeleting(null); setDeletingGroup(null); void read(); });
    function configurePrice(row: AdminModel, geminiTrial = false) {
        if (!geminiTrial && pricingConfigurationRoute(row.capability) === "mapping") onOpenMapping(row);
        else onConfigurePrice({ modelId: row.id, capability: row.capability, requestId: ++priceSequence.current });
    }
    async function saveModel(values: ModelForm) {
        const owner = client.current, original = editor?.original;
        if (!owner || !editor || !live(owner) || busyRef.current || blocked) return;
        busyRef.current = true; setBusy(true); setError("");
        const id = values.id.trim(), input: ModelWrite = { providerId: values.providerId, providerModel: values.providerModel, displayName: values.displayName.trim(), capability: values.capability, enabled: values.enabled, groupId: values.groupId ?? null, revision: original?.revision ?? 0 };
        try {
            const saved = await owner.saveModel(id, input); if (!saved || !live(owner)) return;
            if (removedRef.current.includes(saved.id)) return;
            onModelsChange([...models.filter(row => row.id !== saved.id), saved]); dirty.current = false; setEditor(null);
            setNotice(`模型「${saved.displayName}」已保存。图片和视频请在统一模型目录整理规格与价格；文本和音频仍按节点模型设置价格。`);
            configurePrice(saved);
        } catch (failure) { if (live(owner)) { setError(errorText(failure)); setBlocked(true); } }
        finally { if (live(owner)) { busyRef.current = false; setBusy(false); } }
    }
    async function saveGroups(capability: PricingCapability, nextGroups: NodeModelGroup[], selectNewId?: string) {
        const owner = client.current, existing = documents.find(doc => doc.capability === capability);
        if (!owner || !live(owner) || !existing || busyRef.current || blocked) return;
        busyRef.current = true; setBusy(true); setError("");
        try {
            const result = await owner.saveGroups({ capability, expectedVersion: existing.version, groups: nextGroups });
            if (!result || !live(owner)) return;
            setDocuments(previous => previous.map(doc => doc.capability === capability ? result : doc)); setGroupEditor(null);
            setDeletingGroup(null);
            if (kind === capability && filter !== "all" && filter !== "ungrouped" && !nextGroups.some(group => group.id === filter)) setFilter("all");
            if (selectedKind === capability && form.getFieldValue("groupId") && !nextGroups.some(group => group.id === form.getFieldValue("groupId"))) {
                form.setFieldValue("groupId", null); dirty.current = true;
            }
            if (selectNewId && editor && selectedKind === capability) { form.setFieldValue("groupId", selectNewId); dirty.current = true; }
            setNotice("分组配置已保存，模型价格保持不变。");
        } catch (failure) { if (live(owner)) { setError(errorText(failure)); setBlocked(true); } }
        finally { if (live(owner)) { busyRef.current = false; setBusy(false); } }
    }
    function submitGroup() {
        if (!groupEditor) return;
        const name = groupEditor.name.trim(), existing = documents.find(doc => doc.capability === groupEditor.capability);
        if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) return setError("请填写有效分组名称。");
        if (!existing || existing.groups.some(group => group.id !== groupEditor.id && group.name.toLowerCase() === name.toLowerCase())) return setError("这个节点类型下已有同名分组，请换一个名称。");
        const id = groupEditor.id ?? crypto.randomUUID();
        const nextGroups = groupEditor.id ? existing.groups.map(group => group.id === id ? { id, name } : group) : [...existing.groups, { id, name }];
        void saveGroups(groupEditor.capability, nextGroups, groupEditor.id ? undefined : id);
    }
    function moveGroup(index: number, direction: -1 | 1) {
        const next = [...groups]; [next[index], next[index + direction]] = [next[index + direction], next[index]];
        void saveGroups(kind, next);
    }
    async function removeModel() {
        const owner = client.current, target = deleting;
        if (!owner || !target || !live(owner) || busyRef.current || blocked) return;
        busyRef.current = true; setBusy(true); setError("");
        try {
            const result = await owner.removeModel(target.id, target.revision); if (!result || !live(owner)) return;
            setDeleting(null); onDeleted(result);
            setNotice(`模型「${target.displayName}」已删除，历史任务、账单和价格记录已保留。`);
        } catch (failure) { if (live(owner)) { setError(errorText(failure)); setBlocked(true); } }
        finally { if (live(owner)) { busyRef.current = false; setBusy(false); } }
    }
    const groupInUse = deletingGroup && models.some(row => row.capability === deletingGroup.capability && row.groupId === deletingGroup.group.id);
    const visibleModels = models.filter(row => row.capability === kind && (filter === "all" || (filter === "ungrouped" ? row.groupId === null : row.groupId === filter))
        && (directoryStatus === "all" || publicPricingStatus !== "ready" || (directoryStatus === "published" ? publishedModelIds.includes(row.id) : !publishedModelIds.includes(row.id)))
        && `${row.displayName} ${row.id} ${row.providerDisplayName} ${row.providerModel}`.toLowerCase().includes(query.trim().toLowerCase()));
    const disabled = loading || busy || blocked;
    const candidates = library.filter(row => row.providerId === selectedProvider && row.available);
    if (selectedProvider && selectedModel && !candidates.some(row => row.providerModel === selectedModel)) {
        const current = library.find(row => row.providerId === selectedProvider && row.providerModel === selectedModel);
        if (current) candidates.push(current);
    }
    return <Card title="渠道节点" extra={<Button disabled={busy || loading} loading={loading} onClick={reload}>重新读取配置</Button>}>
        <Typography.Paragraph type="secondary">在这里管理渠道型号与节点分组。图片和视频的展示规格、调用来源及积分统一在模型目录维护；文本和音频价格仍在节点配置中编辑。</Typography.Paragraph>
        {error && !editor && !groupEditor && !deleting && !deletingGroup && <Alert className="!mb-4" type="error" showIcon title={error} />}
        {notice && <Alert className="!mb-4" type="success" showIcon title={notice} closable onClose={() => setNotice("")} />}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Segmented aria-label="节点配置类型" value={kind} options={Object.entries(labels).map(([value, label]) => ({ value, label: <span>{label}<span className="max-sm:sr-only">节点</span></span> }))} onChange={value => { setKind(value as AdminModel["capability"]); setFilter("all"); }} />
            <Button type="primary" icon={<Plus size={15} />} disabled={disabled} onClick={() => openModel()}>从模型库添加</Button>
        </div>
        <div className="mb-4 flex flex-wrap gap-2"><Input.Search aria-label="搜索已接入模型" className="w-full sm:!w-72" placeholder="搜索名称、型号或渠道" value={query} onChange={event => setQuery(event.target.value)} allowClear />
            <Select aria-label="模型目录状态" value={directoryStatus} className="w-full sm:!w-40" options={[{ value: "all", label: "全部已配置" }, { value: "published", label: "已在公开目录" }, { value: "pending", label: "未在公开目录" }]} onChange={setDirectoryStatus} /></div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[210px_minmax(0,1fr)]">
            <Card size="small" title="展示分组" extra={<Button size="small" type="text" aria-label="新建节点分组" disabled={disabled} icon={<Plus size={15} />} onClick={() => { setError(""); setGroupEditor({ capability: kind, name: "" }); }} />}>
                <div className="flex flex-col gap-1">
                    <Button type={filter === "all" ? "primary" : "text"} onClick={() => setFilter("all")}>全部分组</Button>
                    <Button type={filter === "ungrouped" ? "primary" : "text"} onClick={() => setFilter("ungrouped")}>未分组</Button>
                    {groups.map((group, index) => <div key={group.id} className="flex flex-col gap-1 rounded-lg border border-transparent p-1">
                        <Button block type={filter === group.id ? "primary" : "text"} onClick={() => setFilter(group.id)}>{group.name} · {models.filter(row => row.capability === kind && row.groupId === group.id).length}</Button>
                        <div className="flex justify-end"><Tooltip title="重命名"><Button type="text" size="small" aria-label={`重命名分组 ${group.name}`} disabled={disabled} icon={<Pencil size={12} />} onClick={() => { setError(""); setGroupEditor({ capability: kind as PricingCapability, id: group.id, name: group.name }); }} /></Tooltip><Tooltip title="上移"><Button type="text" size="small" aria-label={`上移分组 ${group.name}`} disabled={disabled || index === 0} icon={<ArrowUp size={12} />} onClick={() => moveGroup(index, -1)} /></Tooltip><Tooltip title="下移"><Button type="text" size="small" aria-label={`下移分组 ${group.name}`} disabled={disabled || index === groups.length - 1} icon={<ArrowDown size={12} />} onClick={() => moveGroup(index, 1)} /></Tooltip><Tooltip title="删除分组"><Button type="text" danger size="small" aria-label={`删除分组 ${group.name}`} disabled={disabled} icon={<Trash2 size={12} />} onClick={() => { setError(""); setDeletingGroup({ capability: kind as PricingCapability, group }); }} /></Tooltip></div>
                    </div>)}
                </div>
                {kind === "audio" && <Typography.Text type="secondary">音乐生成尚未接入。</Typography.Text>}
            </Card>
            <Table<AdminModel> rowKey="id" size="small" loading={loading} dataSource={visibleModels} scroll={{ x: 650 }} locale={{ emptyText: "这个节点类型或分组还没有模型，可从模型库添加。" }} columns={[
                { title: "模型 / 来源", render: (_, row) => <div><Typography.Text strong>{row.displayName}</Typography.Text><div className="text-xs text-muted-foreground">{row.id}</div><div className="text-xs text-muted-foreground">{row.providerDisplayName} · {row.providerModel}</div></div> },
                { title: "分组", render: (_, row) => groups.find(group => group.id === row.groupId)?.name ?? "未分组" },
                { title: "目录状态", render: (_, row) => !row.enabled ? <Tag>未启用</Tag> : !row.providerEnabled ? <Tag>渠道停用</Tag> : !row.secretRefConfigured ? <Tag color="orange">缺少密钥</Tag> : publicPricingStatus !== "ready" ? <Tag color="orange">公开目录未知</Tag> : publishedModelIds.includes(row.id) ? <Tag color="green">已读取公开目录</Tag> : <Tag color="orange">待定价 / 生效</Tag> },
                { title: "操作", render: (_, row) => <Space wrap><Button size="small" disabled={disabled} onClick={() => openModel(row)}>编辑配置</Button><Button size="small" disabled={disabled} onClick={() => configurePrice(row)}>{pricingConfigurationRoute(row.capability) === "mapping" ? "统一模型与价格" : "规格与价格"}</Button>
                    {geminiImageBindingOptions(row) && <Button size="small" disabled={disabled} onClick={() => configurePrice(row, true)}>规格与试算</Button>}
                    <Button size="small" type="text" danger icon={<Trash2 size={14} />} disabled={disabled} onClick={() => { setError(""); setDeleting(row); }}>删除</Button></Space> },
            ]} />
        </div>
        <Modal getContainer={false} title={editor?.original ? "编辑节点模型" : "从模型库添加节点模型"} open={editor !== null} onCancel={closeEditor} width={720} footer={[
            <Button key="cancel" disabled={busy} onClick={closeEditor}>关闭</Button>,
            <Button key="save" type="primary" disabled={disabled} loading={busy} onClick={() => form.submit()}>保存并继续设置</Button>,
        ]} styles={{ body: { maxHeight: "calc(100dvh - 220px)", overflowY: "auto", overflowX: "hidden" } }}>
            {error && <Alert className="!mb-4" type="error" showIcon title={error} action={blocked ? <Button onClick={reload} disabled={busy}>重新读取配置</Button> : undefined} />}
            <Form form={form} layout="vertical" name="node-model-config" disabled={disabled} onValuesChange={values => { dirty.current = true; if (Object.hasOwn(values, "capability")) form.setFieldValue("groupId", null); }} onFinish={values => void saveModel(values)}>
                <Row gutter={16}>
                    <Col xs={24} md={12}><Form.Item name="providerId" label="来源渠道" rules={[{ required: true, message: "请选择渠道" }]}><Select aria-label="节点模型来源渠道" disabled={disabled || !!editor?.original} options={providers.map(row => ({ value: row.id, label: `${row.displayName}${row.enabled ? "" : "（停用）"}` }))} onChange={() => form.setFieldsValue({ providerModel: undefined, displayName: "" })} /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item name="providerModel" label="模型库型号" rules={[{ required: true, message: "请选择已读取的型号" }]}><Select aria-label="节点模型库型号" showSearch optionFilterProp="label" disabled={disabled || !!editor?.original} options={candidates.map(row => ({ value: row.providerModel, label: `${row.providerModel}${row.available ? "" : "（最近未返回）"}${models.some(model => model.providerId === row.providerId && model.providerModel === row.providerModel) ? "（已配置）" : ""}`, disabled: models.some(model => model.providerId === row.providerId && model.providerModel === row.providerModel) }))} onChange={value => { const suggestion = inferProviderModel(value); form.setFieldsValue({ displayName: value, ...(suggestion.capability ? { capability: suggestion.capability, groupId: null } : {}) }); }} /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item name="capability" label="节点类型" rules={[{ required: true, message: "请确认该模型的节点类型" }]}><Select aria-label="模型节点类型" disabled={disabled} options={Object.entries(labels).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item name="groupId" label="用户可见分组" getValueProps={value => ({ value: value ?? "" })} normalize={value => value || null}><Select aria-label="模型展示分组" disabled={disabled || !selectedKind} options={[{ value: "", label: "未分组" }, ...editorGroups.map(group => ({ value: group.id, label: group.name }))]} /></Form.Item>{selectedKind && <Button className="!-mt-3 !mb-4" type="link" disabled={disabled} onClick={() => setGroupEditor({ capability: selectedKind, name: "" })}>新建这个类型的分组</Button>}</Col>
                    <Col xs={24} md={12}><Form.Item name="id" label="公开模型 ID" rules={[{ required: true, message: "请输入公开模型 ID" }, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, transform: value => value?.trim(), message: "使用 2–64 位英文、数字或 . _ -" }]}><Input disabled={disabled || !!editor?.original} placeholder="例如 image-default" /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item name="displayName" label="用户看到的名称" rules={[{ required: true, whitespace: true, message: "请输入显示名称" }, { max: 120, message: "最多 120 字符" }]}><Input placeholder="例如 GPT 图片" /></Form.Item></Col>
                    <Col xs={24}><Form.Item name="enabled" label="启用模型目录" valuePropName="checked"><Switch /></Form.Item></Col>
                </Row>
                <Typography.Paragraph type="secondary">厂商和类型识别仅作建议，请核对模型实际用途。启用且具备生效价格后才进入用户目录；保存名称和分组会立即更新展示，价格须保存草稿并确认生效。</Typography.Paragraph>
            </Form>
        </Modal>
        <Modal getContainer={false} open={deleting !== null} title={`删除模型「${deleting?.displayName ?? ""}」？`} okText="删除模型" cancelText="取消" confirmLoading={busy} okButtonProps={{ danger: true, disabled: blocked }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={false} onCancel={() => { if (!busyRef.current) setDeleting(null); }} onOk={() => void removeModel()}>
            <Typography.Paragraph>模型会从当前配置和用户可选目录中移除。历史任务、账单和价格记录保留，原模型 ID 不能再次使用。</Typography.Paragraph>
            <Typography.Paragraph>有未结束或待核对的任务时，暂不允许删除。</Typography.Paragraph>
            {error && <Alert type="error" showIcon title={error} action={blocked ? <Button onClick={reload} disabled={busy}>重新读取配置</Button> : undefined} />}
        </Modal>
        <Modal getContainer={false} open={deletingGroup !== null} title={`删除分组「${deletingGroup?.group.name ?? ""}」？`} okText="删除分组" cancelText="取消" confirmLoading={busy} okButtonProps={{ danger: true, disabled: blocked || !!groupInUse }} cancelButtonProps={{ disabled: busy }} closable={!busy} onCancel={() => { if (!busyRef.current) setDeletingGroup(null); }} onOk={() => {
            if (!deletingGroup || groupInUse || busyRef.current || blocked) return;
            const document = documents.find(row => row.capability === deletingGroup.capability);
            if (document) void saveGroups(document.capability, document.groups.filter(group => group.id !== deletingGroup.group.id));
        }}>
            {groupInUse ? <Alert type="warning" showIcon title="请先移出组内模型" description="编辑模型配置，将组内模型移至其他分组或“未分组”后，再删除此分组。" /> : <Typography.Paragraph>仅删除这个空分组，其他模型、分组和价格保持不变。</Typography.Paragraph>}
            {error && <Alert className="!mt-3" type="error" showIcon title={error} action={blocked ? <Button onClick={reload} disabled={busy}>重新读取配置</Button> : undefined} />}
        </Modal>
        <Modal getContainer={false} title={groupEditor?.id ? "重命名节点分组" : `新建${groupEditor ? labels[groupEditor.capability] : ""}分组`} open={!!groupEditor} okText="保存分组" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled }} cancelButtonProps={{ disabled: busy }} onCancel={() => { if (!busy) setGroupEditor(null); }} onOk={submitGroup}>
            {error && <Alert className="!mb-4" type="error" showIcon title={error} action={blocked ? <Button onClick={reload} disabled={busy}>重新读取配置</Button> : undefined} />}
            <Input aria-label="节点分组名称" value={groupEditor?.name ?? ""} disabled={disabled} onChange={event => setGroupEditor(previous => previous && ({ ...previous, name: event.target.value }))} placeholder="例如 GPT、DeepSeek、精选视频" onPressEnter={submitGroup} />
            <Typography.Paragraph className="!mb-0 !mt-3" type="secondary">分组只属于当前节点类型。保存名称与排序后，已有模型展示随之更新，计费价格保持不变。</Typography.Paragraph>
        </Modal>
    </Card>;
}
