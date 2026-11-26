import { useMemo, useState } from "react";
import { Alert, Button, Card, Col, Empty, Form, Input, Modal, Row, Select, Space, Steps, Table, Tag, Typography, theme } from "antd";
import { CheckCircleOutlined, CloudServerOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useModelManagementPreview, type CatalogModel, type Channel, type DiscoveredModel } from "./state";

const kindLabels = { text: "文本", image: "图片", video: "视频", unknown: "待确认" };
const kindColors = { text: "blue", image: "purple", video: "cyan", unknown: "orange" };
const adapterLabels = { "openai-compatible": "OpenAI 兼容", sub2api: "Sub2API" };
const kindOptions = Object.entries(kindLabels).map(([value, label]) => ({ value, label }));
type ChannelForm = Omit<Channel, "id"> & { id?: string };
type ReadScenario = "success" | "changed" | "failure";
type ReadResult = { fingerprint: string; models: DiscoveredModel[] };
type Notice = { type: "success" | "info" | "error"; text: string };

const sampleCatalog: DiscoveredModel[] = [
    { upstreamId: "gpt-demo-text", name: "GPT 文本示例", brand: "OpenAI", kind: "text" },
    { upstreamId: "deepseek-demo-text", name: "DeepSeek 文本示例", brand: "DeepSeek", kind: "text" },
    { upstreamId: "gemini-demo-text", name: "Gemini 文本示例", brand: "Google", kind: "text" },
    { upstreamId: "gpt-demo-image", name: "GPT 图片示例", brand: "OpenAI", kind: "image" },
    { upstreamId: "demo-video", name: "视频模型示例", brand: "示例厂商", kind: "video" },
    { upstreamId: "custom-model", name: "自定义型号", brand: "待确认", kind: "unknown" },
];
function formError(form: ChannelForm): string | null {
    if (!form.name.trim()) return "先填写渠道名称。";
    try {
        const url = new URL(form.endpoint);
        if (url.protocol !== "https:" || !url.hostname.endsWith(".invalid") || url.username || url.password || url.search || url.hash) return "预览只接受 https://渠道名.invalid 形式的演示地址，不要填写真实地址或凭据。";
    } catch { return "请填写 HTTPS 演示地址，例如 https://example.invalid。"; }
    return null;
}
function fingerprint(form: ChannelForm) { return JSON.stringify(form); }
function difference(current: CatalogModel[], incoming: DiscoveredModel[]) {
    const oldIds = new Set(current.map((model) => model.upstreamId));
    const incomingIds = new Set(incoming.map((model) => model.upstreamId));
    return { added: incoming.filter((model) => !oldIds.has(model.upstreamId)), missing: current.filter((model) => !incomingIds.has(model.upstreamId)), retained: incoming.filter((model) => oldIds.has(model.upstreamId)) };
}
function discoveryRows(models: DiscoveredModel[]) {
    return <Table<DiscoveredModel> size="small" rowKey="upstreamId" pagination={false} scroll={{ x: 460 }} dataSource={models} columns={[
        { title: "渠道返回型号", dataIndex: "upstreamId", render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
        { title: "厂商建议", dataIndex: "brand" },
        { title: "类型建议", dataIndex: "kind", render: (kind: CatalogModel["kind"]) => <Tag color={kindColors[kind]}>{kindLabels[kind]}</Tag> },
    ]} />;
}

export function ChannelPanel() {
    const { token } = theme.useToken();
    const store = useModelManagementPreview();
    const [form, setForm] = useState<ChannelForm | null>(null);
    const [scenario, setScenario] = useState<ReadScenario>("success");
    const [read, setRead] = useState<ReadResult | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState<Notice | null>(null);
    const [updating, setUpdating] = useState<Channel | null>(null);
    const [updateModels, setUpdateModels] = useState<DiscoveredModel[] | null>(null);
    const [updateScenario, setUpdateScenario] = useState<ReadScenario>("changed");
    const [updateError, setUpdateError] = useState("");
    const [toggle, setToggle] = useState<Channel | null>(null);
    const channelModels = (id: string) => store.catalog.filter((model) => model.channelId === id);
    const assignedCount = (id: string) => {
        const modelIds = new Set(channelModels(id).map((model) => model.id));
        return store.assignments.filter((assignment) => modelIds.has(assignment.catalogId)).length;
    };
    function openEditor(channel?: Channel) {
        setForm(channel ? { ...channel } : { name: "", endpoint: "https://example.invalid", adapter: "openai-compatible", enabled: true });
        setScenario("success"); setRead(null); setError("");
    }
    function changeForm(patch: Partial<ChannelForm>) {
        if (!form) return;
        setForm({ ...form, ...patch }); setRead(null); setError("");
    }
    function simulateRead() {
        if (!form) return;
        const invalid = formError(form);
        setRead(null);
        if (invalid) { setError(invalid); return; }
        if (scenario === "failure") { setError("模拟读取失败：渠道未返回模型目录。请检查配置后重新读取；本次不能保存渠道。"); return; }
        const existing = form.id ? channelModels(form.id).filter(model => model.available) : [];
        setRead({ fingerprint: fingerprint(form), models: form.id ? existing.map(({ upstreamId, name, brand, kind }) => ({ upstreamId, name, brand, kind })) : sampleCatalog });
        setError("");
    }
    function saveChannel() {
        if (!form || !read || read.fingerprint !== fingerprint(form)) return;
        const result = store.saveChannel({ ...form, name: form.name.trim(), endpoint: form.endpoint.trim() }, read.models);
        if (!result.ok) { setError(result.error); return; }
        setNotice({ type: "success", text: `${form.name.trim()}已在预览中保存，${read.models.length} 个型号进入模型库。下一步按节点分组配置。` });
        setForm(null);
    }
    function simulateUpdate() {
        if (!updating) return;
        setUpdateModels(null);
        if (updateScenario === "failure") { setUpdateError("模拟读取失败，已保存的模型库和节点配置保持不变。可以切换成功场景再读取。"); return; }
        const current = channelModels(updating.id).filter((model) => model.available).map(({ upstreamId, name, brand, kind }) => ({ upstreamId, name, brand, kind }));
        const addition: DiscoveredModel = { upstreamId: "demo-new-model", name: "新型号示例", brand: "待确认", kind: "unknown" };
        setUpdateModels(updateScenario === "changed" ? [...current.slice(0, Math.max(0, current.length - 1)).filter((model) => model.upstreamId !== addition.upstreamId), addition] : current.length ? current : sampleCatalog);
        setUpdateError("");
    }
    const updateDiff = updating && updateModels ? difference(channelModels(updating.id), updateModels) : null;
    return <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
            <div><Typography.Title level={4} style={{ margin: 0 }}>接入渠道，建立你的模型库</Typography.Title><Typography.Text type="secondary">一个渠道一套地址与凭据。读取成功、确认目录后保存，再配置用户能使用的模型。</Typography.Text></div>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>添加渠道</Button>
        </div>
        <Steps size="small" current={0} items={[{ title: "填写渠道" }, { title: "测试并读取" }, { title: "确认保存" }, { title: "分配到节点" }]} />
        {notice && <Alert showIcon type={notice.type} title={notice.text} closable onClose={() => setNotice(null)} />}
        <Row gutter={[16, 16]}>{store.channels.map((channel) => {
            const models = channelModels(channel.id), count = assignedCount(channel.id);
            return <Col xs={24} xl={12} key={channel.id}><Card style={{ height: "100%" }}>
                <Space style={{ width: "100%", justifyContent: "space-between", alignItems: "start" }}>
                    <Space align="start"><div style={{ background: token.colorFillSecondary, borderRadius: token.borderRadiusLG, padding: 12 }}><CloudServerOutlined style={{ fontSize: 22 }} /></div><div><Typography.Title level={5} style={{ margin: "0 0 4px" }}>{channel.name}</Typography.Title><Typography.Text type="secondary">{adapterLabels[channel.adapter]}</Typography.Text></div></Space>
                    <Tag color={channel.enabled ? "success" : "default"}>{channel.enabled ? "已启用（预览）" : "已停用（预览）"}</Tag>
                </Space>
                <Typography.Paragraph type="secondary" style={{ margin: "18px 0", overflowWrap: "anywhere" }}>{channel.endpoint}</Typography.Paragraph>
                <div style={{ display: "flex", gap: 32, padding: "16px 0", borderTop: `1px solid ${token.colorBorderSecondary}`, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
                    <div><Typography.Text strong style={{ fontSize: 24 }}>{models.length}</Typography.Text><Typography.Text type="secondary"> 个目录型号</Typography.Text></div>
                    <div><Typography.Text strong style={{ fontSize: 24 }}>{count}</Typography.Text><Typography.Text type="secondary"> 个节点配置</Typography.Text></div>
                </div>
                <Space wrap style={{ marginTop: 16 }}>
                    <Button icon={<ReloadOutlined />} onClick={() => { setUpdating(channel); setUpdateModels(null); setUpdateError(""); setUpdateScenario("changed"); }}>读取更新</Button>
                    <Button icon={<EditOutlined />} onClick={() => openEditor(channel)}>编辑</Button>
                    <Button type="text" onClick={() => setToggle(channel)}>{channel.enabled ? "停用渠道" : "启用渠道"}</Button>
                </Space>
            </Card></Col>;
        })}</Row>
        {!store.channels.length && <Empty description="还没有渠道，先添加一个演示渠道并读取目录。" />}
        <Alert showIcon type="info" title="目录返回了型号，不代表已验证实际生成" description="厂商和类型是可修正的分类建议；图片规格、视频时长与分辨率等能力，需要在节点配置时核对。本预览不连接供应商。" />

        <Modal title={form?.id ? "编辑渠道 · 演示" : "添加渠道 · 演示"} open={!!form} width={760} onCancel={() => setForm(null)} footer={<Space><Button onClick={() => setForm(null)}>取消</Button><Button icon={<ReloadOutlined />} onClick={simulateRead}>模拟测试并读取</Button><Button type="primary" disabled={!form || !read || read.fingerprint !== fingerprint(form)} onClick={saveChannel}>确认保存渠道</Button></Space>}>
            {form && <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
                <Alert showIcon type="info" title="这是操作预览，不接收真实 API Key" description="所有修改只保留在本页内存。示例地址使用 .invalid 域名，测试按钮返回固定演示目录。" />
                <Form layout="vertical">
                    <Row gutter={16}><Col xs={24} sm={12}><Form.Item label="渠道名称" required><Input aria-label="演示渠道名称" placeholder="例如：文本主渠道" value={form.name} onChange={(event) => changeForm({ name: event.target.value })} /></Form.Item></Col><Col xs={24} sm={12}><Form.Item label="接口协议" required><Select aria-label="演示渠道协议" value={form.adapter} options={Object.entries(adapterLabels).map(([value, label]) => ({ value, label }))} onChange={(adapter: Channel["adapter"]) => changeForm({ adapter })} /></Form.Item></Col></Row>
                    <Form.Item label="演示 Endpoint" required extra="仅用于展示配置流程，不会发出请求。"><Input aria-label="演示渠道地址" value={form.endpoint} onChange={(event) => changeForm({ endpoint: event.target.value })} /></Form.Item>
                    <Form.Item label="API Key"><Input aria-label="固定演示凭据" value="演示凭据已就绪（不可编辑）" readOnly disabled /></Form.Item>
                    <Form.Item label="演示读取场景"><Select aria-label="渠道读取演示场景" value={scenario} options={[{ value: "success", label: "成功：返回模型目录" }, { value: "failure", label: "失败：无法读取目录" }]} onChange={(value: ReadScenario) => { setScenario(value); setRead(null); setError(""); }} /></Form.Item>
                </Form>
                {error && <Alert showIcon type="error" title={error} />}
                {read ? <><Alert type="success" showIcon icon={<CheckCircleOutlined />} title={`演示读取成功：${read.models.length} 个型号，确认后保存`} description="修改任何渠道字段后，都需要重新测试读取。" />{discoveryRows(read.models)}</> : <Typography.Text type="secondary">读取成功后，这里展示本次模型目录，再由你确认保存。</Typography.Text>}
            </Space>}
        </Modal>

        <Modal title={`读取渠道更新 · ${updating?.name ?? ""}`} open={!!updating} width={760} onCancel={() => setUpdating(null)} footer={<Space><Button onClick={() => setUpdating(null)}>关闭</Button><Button icon={<ReloadOutlined />} onClick={simulateUpdate}>模拟读取更新</Button><Button type="primary" disabled={!updating || !updateModels} onClick={() => {
            if (!updating || !updateModels) return;
            const result = store.updateCatalog(updating.id, updateModels);
            if (!result.ok) { setUpdateError(result.error); return; }
            setNotice({ type: "success", text: `${updating.name}的目录更新已确认。新增型号仍需分类与分配，已有分组、价格和发布配置未被修改。` }); setUpdating(null);
        }}>确认更新模型库</Button></Space>}>
            <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
                <Alert showIcon type="info" title="先核对差异，再更新模型库" description="新型号需要你确认后导入；本次未返回的型号保留记录和已有节点配置，不自动删除。" />
                <Select aria-label="目录更新演示场景" style={{ width: "100%" }} value={updateScenario} options={[{ value: "changed", label: "目录变化：新增一个型号，少返回一个型号" }, { value: "success", label: "正常读取：保持当前目录" }, { value: "failure", label: "读取失败：保留已有目录" }]} onChange={(value: ReadScenario) => { setUpdateScenario(value); setUpdateModels(null); setUpdateError(""); }} />
                {updateError && <Alert type="error" showIcon title={updateError} />}
                {updateDiff && <><Space wrap><Tag color="success">新增 {updateDiff.added.length}</Tag><Tag>已在库中 {updateDiff.retained.length}</Tag><Tag color={updateDiff.missing.length ? "warning" : "default"}>本次未返回 {updateDiff.missing.length}</Tag></Space>
                    {updateDiff.added.length > 0 && <><Typography.Text strong>待确认导入</Typography.Text>{discoveryRows(updateDiff.added)}</>}
                    {updateDiff.missing.length > 0 && <Alert showIcon type="warning" title="以下型号仅标记为本次目录未返回" description={`${updateDiff.missing.map((model) => model.upstreamId).join("、")}。现有记录、分组和价格保留；是否停用请另行核对。`} />}
                    {updateDiff.retained.length > 0 && <Typography.Paragraph type="secondary">已在库中：{updateDiff.retained.map((model) => model.upstreamId).join("、")}。不会覆盖你的类型与厂商修正。</Typography.Paragraph>}
                </>}
            </Space>
        </Modal>

        <Modal title={`${toggle?.enabled ? "停用" : "启用"}渠道 · 仅本页演示`} open={!!toggle} okText={toggle?.enabled ? "确认停用（预览）" : "确认启用（预览）"} onCancel={() => setToggle(null)} onOk={() => {
            if (!toggle) return;
            const result = store.toggleChannel(toggle.id, !toggle.enabled);
            if (!result.ok) setNotice({ type: "error", text: result.error });
            else setNotice({ type: "success", text: `${toggle.name}已在预览中${toggle.enabled ? "停用" : "启用"}，目录和价格配置均保留。` });
            setToggle(null);
        }}><Typography.Paragraph>{toggle?.enabled ? `这个渠道关联 ${toggle ? assignedCount(toggle.id) : 0} 个节点配置。停用后，这些模型会从用户选模预览中隐藏，原配置和价格仍保留。` : "启用后，满足已上线条件的模型会重新出现在用户选模预览中。"}</Typography.Paragraph><Typography.Text type="secondary">不会修改真实渠道，也不执行删除。</Typography.Text></Modal>
    </Space>;
}

export function CatalogPanel({ onAssign }: { onAssign?: (catalogId: string) => void }) {
    const store = useModelManagementPreview();
    const [search, setSearch] = useState("");
    const [channelId, setChannelId] = useState<string>();
    const [kind, setKind] = useState<CatalogModel["kind"]>();
    const [editing, setEditing] = useState<{ id: string; kind: CatalogModel["kind"]; brand: string } | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const filtered = useMemo(() => store.catalog.filter((model) => {
        const channel = store.channels.find((item) => item.id === model.channelId);
        const matches = [model.name, model.upstreamId, model.brand, channel?.name ?? ""].join(" ").toLowerCase().includes(search.trim().toLowerCase());
        return matches && (!channelId || model.channelId === channelId) && (!kind || model.kind === kind);
    }), [store.catalog, store.channels, search, channelId, kind]);
    return <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        <div><Typography.Title level={4} style={{ margin: "0 0 4px" }}>所有渠道的模型，放在一个地方管理</Typography.Title><Typography.Text type="secondary">共 {store.catalog.length} 个来源型号。同名型号保留各自渠道，分类后再分配给文本、图片或视频节点。</Typography.Text></div>
        {notice && <Alert showIcon type="success" title={notice} closable onClose={() => setNotice("")} />}
        <Space wrap style={{ width: "100%" }}>
            <Input aria-label="搜索模型库" allowClear prefix={<SearchOutlined />} placeholder="搜索型号、名称、厂商或渠道" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 300, maxWidth: "100%" }} />
            <Select aria-label="按渠道筛选模型库" allowClear placeholder="全部渠道" value={channelId} onChange={setChannelId} style={{ width: 190 }} options={store.channels.map((item) => ({ value: item.id, label: item.name }))} />
            <Select aria-label="按类型筛选模型库" allowClear placeholder="全部类型" value={kind} onChange={setKind} style={{ width: 140 }} options={kindOptions} />
            <Tag>{filtered.length} 个结果</Tag>
        </Space>
        <Table<CatalogModel> rowKey="id" size="middle" dataSource={filtered} pagination={false} scroll={{ x: 1000 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的模型；可调整筛选或先到渠道管理读取目录。" /> }} columns={[
            { title: "模型名称 / 上游型号", width: 240, render: (_, model) => <Space orientation="vertical" size={2}><Typography.Text strong>{model.name}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{model.upstreamId}</Typography.Text>{!model.available && <Tag color="warning">本次目录未返回</Tag>}</Space> },
            { title: "来源渠道", width: 170, render: (_, model) => { const channel = store.channels.find((item) => item.id === model.channelId); return <Space orientation="vertical" size={2}><Typography.Text>{channel?.name ?? "渠道不存在"}</Typography.Text>{!channel?.enabled && <Typography.Text type="secondary">渠道已停用</Typography.Text>}</Space>; } },
            { title: "厂商", dataIndex: "brand", width: 140 },
            { title: "节点类型", dataIndex: "kind", width: 110, render: (value: CatalogModel["kind"]) => <Tag color={kindColors[value]}>{kindLabels[value]}</Tag> },
            { title: "分配情况", width: 120, render: (_, model) => { const count = store.assignments.filter((item) => item.catalogId === model.id).length; return count ? <Tag color="success">已分配 {count} 处</Tag> : <Typography.Text type="secondary">尚未分配</Typography.Text>; } },
            { title: "操作", width: 240, render: (_, model) => {
                const assigned = store.assignments.some((item) => item.catalogId === model.id);
                const canAdd = model.kind !== "unknown" && model.available && store.channels.some((item) => item.id === model.channelId && item.enabled);
                return <Space wrap><Button disabled={!onAssign || (!assigned && !canAdd)} onClick={() => onAssign?.(model.id)}>{assigned ? "查看配置" : "分配到节点"}</Button><Button type="text" onClick={() => { setEditing({ id: model.id, kind: model.kind, brand: model.brand }); setError(""); }}>修正分类</Button></Space>;
            } },
        ]} />
        <Alert showIcon type="info" title="自动建议可以修正，未确认类型不进入节点选模" description="厂商是模型来源属性，GPT、DeepSeek 等用户分组由你另行创建。价格与规格在分配模型时配置；读取目录本身不会把任何型号上线。" />
        <Modal title="修正模型分类 · 演示" open={!!editing} onCancel={() => setEditing(null)} okText="保存分类" onOk={() => {
            if (!editing) return;
            if (!editing.brand.trim()) { setError("请填写厂商，暂不确定可以填“待确认”。"); return; }
            if (editing.kind === "unknown") { setError("请选择文本、图片或视频，确认用途后再保存分类。"); return; }
            const result = store.classifyModel(editing.id, editing.kind, editing.brand.trim());
            if (!result.ok) { setError(result.error); return; }
            setNotice("分类已在预览中保存，可按对应节点类型继续分配。"); setEditing(null);
        }}>
            {editing && <Form layout="vertical"><Typography.Paragraph type="secondary">分类是你的管理配置，不代表接口已经验证。已分配型号的类型变更需先核对节点配置。</Typography.Paragraph><Form.Item label="模型厂商" required><Input aria-label="修正模型厂商" value={editing.brand} onChange={(event) => setEditing({ ...editing, brand: event.target.value })} /></Form.Item><Form.Item label="节点类型" required><Select aria-label="修正模型类型" value={editing.kind} options={kindOptions} onChange={(value: CatalogModel["kind"]) => setEditing({ ...editing, kind: value })} /></Form.Item>{error && <Alert showIcon type="error" title={error} />}</Form>}
        </Modal>
    </Space>;
}
