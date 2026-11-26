import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Checkbox, Drawer, Empty, Input, Modal, Segmented, Select, Space, Table, Tag, Typography, theme } from "antd";
import { ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react";
import { PRICE_METERS, PRICE_PARAMETERS, PRICE_TEMPLATES, type ModelPriceRule, type ModelPriceRules, type PriceMeter, type PriceTemplate } from "../../../../../packages/shared/src/model-pricing-drafts";
import { useModelManagementPreview, type Assignment, type Kind } from "./state";

const kinds = [{ label: "文本节点", value: "text" }, { label: "图片节点", value: "image" }, { label: "视频节点", value: "video" }];
const kindNames = { text: "文本", image: "图片", video: "视频" };
const parameterNames: Record<string, string> = { size: "分辨率", quality: "质量", mode: "模式", resolution: "分辨率", durationSeconds: "时长（秒）" };
const unitNames: Record<string, string> = { text_tokens: "输入 / 输出 Token", image_tokens: "文本与图片 Token", image_count: "按张", image_request: "按次", video_second: "按秒", video_count: "按整段" };
const changed = (item: Assignment) => !!item.published && JSON.stringify([item.name, item.groupId, item.rules, item.note]) !== JSON.stringify([item.published.name, item.published.groupId, item.published.rules, item.published.note]);
const status = (item: Assignment) => !item.published ? "待上线" : changed(item) ? "已上线 · 有草稿" : "已上线";
const priceSummary = (item: Assignment) => item.rules.sale.bands.map(band => `${Object.entries(band.parameters).map(([key, value]) => `${parameterNames[key]} ${value}${key === "durationSeconds" ? " 秒" : ""}`).join(" / ") || "默认"}：${PRICE_TEMPLATES[item.rules.sale.template].meters.map(meter => `${PRICE_METERS[meter].label} ${band.rates[meter] === "" || band.rates[meter] == null ? "待填写" : band.rates[meter]} 积分/${PRICE_METERS[meter].unit}`).join(" · ")}`).join("；");

export function AssignmentPanel({ initialCatalogId, onCatalogConsumed, onShowExperience }: { initialCatalogId?: string; onCatalogConsumed: () => void; onShowExperience: () => void }) {
    const store = useModelManagementPreview();
    const { token } = theme.useToken(), { message } = App.useApp();
    const [kind, setKind] = useState<Kind>("video"), [groupId, setGroupId] = useState("all");
    const [editor, setEditor] = useState<string>(), [adding, setAdding] = useState(false);
    const [channelId, setChannelId] = useState<string>(), [catalogId, setCatalogId] = useState<string>(), [targetGroup, setTargetGroup] = useState<string>();
    const [groupEditor, setGroupEditor] = useState<{ id?: string; name: string }>();
    const groups = store.groups.filter(group => group.kind === kind);
    const items = store.assignments.filter(item => item.kind === kind && (groupId === "all" || item.groupId === groupId));
    useEffect(() => {
        if (!initialCatalogId) return;
        const model = store.catalog.find(item => item.id === initialCatalogId);
        if (model && model.kind !== "unknown") {
            setKind(model.kind); setGroupId("all"); setChannelId(model.channelId); setCatalogId(model.id);
            const existing = store.assignments.find(item => item.catalogId === model.id && item.kind === model.kind);
            if (existing) setEditor(existing.id);
            else { setTargetGroup(store.groups.find(group => group.kind === model.kind && group.name === model.brand)?.id); setAdding(true); }
        }
        onCatalogConsumed();
    }, [initialCatalogId, onCatalogConsumed, store.catalog, store.groups, store.assignments]);
    const openAdd = () => { setChannelId(undefined); setCatalogId(undefined); setTargetGroup(groupId !== "all" ? groupId : undefined); setAdding(true); };
    const eligible = store.catalog.filter(model => model.kind === kind && model.available && store.channels.some(channel => channel.id === model.channelId && channel.enabled) && (!channelId || model.channelId === channelId));
    const finishAdd = () => {
        if (!catalogId || !targetGroup) return;
        const result = store.addAssignment(catalogId, kind, targetGroup);
        if (!result.ok) return void message.error(result.error);
        setAdding(false); setEditor(result.id); void message.success("已加入节点配置，继续设置规格和价格。");
    };
    return <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><Segmented aria-label="配置节点类型" options={kinds} value={kind} onChange={value => { setKind(value as Kind); setGroupId("all"); }} /><Button type="primary" icon={<Plus size={16} />} onClick={openAdd}>添加模型到节点</Button></div>
        <div className="grid gap-4 xl:grid-cols-[200px_minmax(0,1fr)]">
            <Card size="small" title="用户可见的分组" extra={<Button type="text" size="small" aria-label="新建节点分组" icon={<Plus size={15} />} onClick={() => setGroupEditor({ name: "" })} />}>
                <div className="flex flex-col gap-1">
                    <Button type={groupId === "all" ? "primary" : "text"} block onClick={() => setGroupId("all")}>全部分组</Button>
                    {groups.map((group, index) => <div key={group.id} className="rounded-lg border p-2" style={{ borderColor: groupId === group.id ? token.colorBorder : "transparent", background: groupId === group.id ? token.controlItemBgActive : "transparent" }}>
                        <button type="button" className="flex w-full items-center justify-between text-left text-sm" onClick={() => setGroupId(group.id)}><span>{group.name}</span><span style={{ color: token.colorTextTertiary }}>{store.assignments.filter(item => item.groupId === group.id).length}</span></button>
                        <div className="mt-1 flex justify-end"><Button size="small" type="text" aria-label={`重命名分组 ${group.name}`} icon={<Pencil size={12} />} onClick={() => setGroupEditor({ id: group.id, name: group.name })} /><Button size="small" type="text" disabled={index === 0} aria-label={`上移分组 ${group.name}`} icon={<ArrowUp size={12} />} onClick={() => store.moveGroup(group.id, -1)} /><Button size="small" type="text" disabled={index === groups.length - 1} aria-label={`下移分组 ${group.name}`} icon={<ArrowDown size={12} />} onClick={() => store.moveGroup(group.id, 1)} /></div>
                    </div>)}
                </div>
                <Typography.Paragraph type="secondary" className="!mb-0 !mt-4 text-xs">用户先展开分组，再选择型号。分组名称与顺序由你决定。</Typography.Paragraph>
            </Card>
            <Card title={`${kindNames[kind]}节点模型`} extra={<Tag>{items.length} 个模型</Tag>}>
                <Typography.Paragraph type="secondary">从模型库挑选，设置展示名称、规格和价格。确认上线后才会出现在用户端预览中。</Typography.Paragraph>
                <Table<Assignment> rowKey="id" size="middle" pagination={false} scroll={{ x: 600 }} dataSource={items} locale={{ emptyText: <Empty description="这个分组还没有模型"><Button onClick={openAdd}>从模型库添加</Button></Empty> }} columns={[
                    { title: "模型 / 来源", render: (_, item) => { const model = store.catalog.find(entry => entry.id === item.catalogId); return <div><div className="font-medium">{item.name}</div><div className="mt-1 text-xs" style={{ color: token.colorTextTertiary }}>{store.channels.find(channel => channel.id === model?.channelId)?.name} · {model?.upstreamId}</div></div>; } },
                    { title: "展示分组", render: (_, item) => store.groups.find(group => group.id === item.groupId)?.name },
                    { title: "计价与规格", render: (_, item) => <div><div>{unitNames[item.rules.sale.template]}</div><Typography.Text type="secondary" className="text-xs">{item.rules.sale.bands.length} 档规格</Typography.Text></div> },
                    { title: "状态", render: (_, item) => <Tag color={item.published ? "green" : "orange"}>{status(item)}</Tag> },
                    { title: "操作", render: (_, item) => <Button onClick={() => setEditor(item.id)}>配置模型</Button> },
                ]} />
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><Typography.Text type="secondary" className="text-xs">成本用于内部核算，用户只看到售价与公开说明。</Typography.Text><Button type="link" onClick={onShowExperience}>查看节点选择效果 →</Button></div>
            </Card>
        </div>
        <Modal title={`添加${kindNames[kind]}模型`} open={adding} okText="添加并配置价格" cancelText="取消" onCancel={() => setAdding(false)} onOk={finishAdd} okButtonProps={{ disabled: !catalogId || !targetGroup }}>
            <div className="space-y-4 py-3">
                <Field label="来源渠道"><Select aria-label="分配来源渠道" className="w-full" allowClear placeholder="所有渠道" value={channelId} options={store.channels.map(channel => ({ value: channel.id, label: channel.name, disabled: !channel.enabled }))} onChange={value => { setChannelId(value); setCatalogId(undefined); }} /></Field>
                <Field label="模型库中的型号"><Select aria-label="分配渠道模型" className="w-full" showSearch optionFilterProp="label" value={catalogId} placeholder="选择已确认类型的模型" options={eligible.map(model => ({ value: model.id, label: `${model.name} · ${store.channels.find(channel => channel.id === model.channelId)?.name}`, disabled: store.assignments.some(item => item.catalogId === model.id && item.kind === kind) }))} onChange={setCatalogId} /></Field>
                <Field label="用户可见分组"><Select aria-label="分配目标分组" className="w-full" value={targetGroup} placeholder="先创建一个分组" options={groups.map(group => ({ value: group.id, label: group.name }))} onChange={setTargetGroup} /></Field>
                <Typography.Text type="secondary">未识别类型的模型，请先在模型库确认。添加不会自动上线。</Typography.Text>
            </div>
        </Modal>
        <Modal title={groupEditor?.id ? "重命名分组" : `新建${kindNames[kind]}分组`} open={!!groupEditor} okText="保存分组" cancelText="取消" onCancel={() => setGroupEditor(undefined)} onOk={() => {
            if (!groupEditor) return;
            const result = groupEditor.id ? store.renameGroup(groupEditor.id, groupEditor.name) : store.createGroup(kind, groupEditor.name);
            if (!result.ok) return void message.error(result.error);
            setGroupEditor(undefined);
        }}><Input aria-label="节点分组名称" placeholder="例如 GPT、DeepSeek、精选视频" value={groupEditor?.name} onChange={event => setGroupEditor(previous => previous && ({ ...previous, name: event.target.value }))} /></Modal>
        {editor && <AssignmentEditor key={editor} id={editor} onClose={() => setEditor(undefined)} />}
    </>;
}

export function PricingPanel() {
    const store = useModelManagementPreview(), { token } = theme.useToken();
    const [filter, setFilter] = useState("published"), [kind, setKind] = useState("all"), [query, setQuery] = useState(""), [editor, setEditor] = useState<string>();
    const items = store.assignments.filter(item => (filter === "all" || (filter === "published" ? !!item.published : !item.published || changed(item))) && (kind === "all" || item.kind === kind) && item.name.toLowerCase().includes(query.trim().toLowerCase()));
    return <>
        <Alert className="!mb-4" type="info" showIcon title="这里只管理已加入节点的模型，与「节点模型」编辑同一份价格。草稿修改需再次确认上线，才会更新用户预览。" />
        <Card><div className="mb-5 flex flex-wrap gap-3"><Segmented aria-label="价格状态筛选" value={filter} options={[{ value: "published", label: "已上线" }, { value: "draft", label: "待上线 / 有草稿" }, { value: "all", label: "全部已分配" }]} onChange={setFilter} /><Select aria-label="价格类型筛选" value={kind} style={{ width: 130 }} options={[{ value: "all", label: "全部类型" }, ...kinds]} onChange={setKind} /><Input.Search aria-label="搜索模型价格" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} style={{ width: 210 }} allowClear /></div>
            <Table<Assignment> rowKey="id" pagination={false} dataSource={items} scroll={{ x: 680 }} columns={[
                { title: "模型", render: (_, item) => <div><div className="font-medium">{item.name}</div><Typography.Text type="secondary" className="text-xs">{kindNames[item.kind]} · {store.groups.find(group => group.id === item.groupId)?.name}</Typography.Text></div> },
                { title: "渠道成本", render: (_, item) => item.rules.cost ? <div>{item.rules.cost.currency} / {unitNames[item.rules.cost.template]}<div className="text-xs" style={{ color: token.colorTextTertiary }}>按规格配置 · 内部可见</div></div> : <Typography.Text type="secondary">未录入</Typography.Text> },
                { title: "积分售价草稿", width: 310, render: (_, item) => <div className="text-xs leading-6">{priceSummary(item)}</div> },
                { title: "状态", render: (_, item) => <Tag color={item.published ? "green" : "orange"}>{status(item)}</Tag> },
                { title: "操作", render: (_, item) => <Button onClick={() => setEditor(item.id)}>编辑价格</Button> },
            ]} />
        </Card>
        {editor && <AssignmentEditor key={editor} id={editor} onClose={() => setEditor(undefined)} />}
    </>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><div className="mb-2 text-sm font-medium">{label}</div>{children}</div>; }

function AssignmentEditor({ id, onClose }: { id: string; onClose: () => void }) {
    const store = useModelManagementPreview(), { message, modal } = App.useApp(), { token } = theme.useToken();
    const original = store.assignments.find(item => item.id === id)!;
    const [draft, setDraft] = useState(() => structuredClone(original));
    const [dirty, setDirty] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState("");
    const model = store.catalog.find(item => item.id === original.catalogId);
    const patch = (changes: Partial<Assignment>) => { setDraft(previous => ({ ...previous, ...changes })); setDirty(true); setError(""); };
    const patchRules = (rules: ModelPriceRules) => patch({ rules });
    const unitOptions = Object.entries(PRICE_TEMPLATES).filter(([value, spec]) => spec.capability === original.kind && value !== "image_tokens").map(([value]) => ({ value, label: unitNames[value] }));
    const close = () => dirty ? modal.confirm({ title: "放弃本次未保存的编辑？", content: "已保存草稿与已上线价格都会保留。", okText: "放弃编辑", cancelText: "继续编辑", onOk: onClose }) : onClose();
    const setParameter = (index: number, key: string, value: string) => {
        const update = (rule: ModelPriceRule) => ({ ...rule, bands: rule.bands.map((band, position) => { if (position !== index) return band; const parameters = { ...band.parameters }; if (value) parameters[key] = value; else delete parameters[key]; return { ...band, parameters }; }) });
        patchRules({ ...draft.rules, sale: update(draft.rules.sale), cost: draft.rules.cost ? update(draft.rules.cost) : null });
    };
    const setRate = (side: "cost" | "sale", index: number, meter: PriceMeter, value: string) => {
        const rule = draft.rules[side]; if (!rule) return;
        patchRules({ ...draft.rules, [side]: { ...rule, bands: rule.bands.map((band, position) => position === index ? { ...band, rates: { ...band.rates, [meter]: value === "" && side === "cost" ? null : value } } : band) } });
    };
    const changeUnit = (side: "cost" | "sale", template: PriceTemplate, currency?: "CNY" | "USD") => {
        const rule = draft.rules[side]; if (!rule) return;
        if (rule.template === template && (!currency || rule.currency === currency)) return;
        modal.confirm({ title: `更换${side === "cost" ? "成本" : "售价"}单位后重新填写金额`, content: "规格组合会保留，本侧金额将清空；不会换算或修改已上线价格。", okText: "更换并重新填写", cancelText: "取消", onOk: () => patchRules({ ...draft.rules, [side]: { template, currency: currency ?? rule.currency, bands: rule.bands.map(band => ({ parameters: { ...band.parameters }, rates: Object.fromEntries(PRICE_TEMPLATES[template].meters.map(meter => [meter, side === "cost" ? null : ""])) })) } }) });
    };
    const addVariant = () => {
        const append = (rule: ModelPriceRule) => ({ ...rule, bands: [...rule.bands, { parameters: {}, rates: Object.fromEntries(PRICE_TEMPLATES[rule.template].meters.map(meter => [meter, rule.currency === "credit" ? "" : null])) }] });
        patchRules({ ...draft.rules, sale: append(draft.rules.sale), cost: draft.rules.cost ? append(draft.rules.cost) : null });
    };
    const save = () => {
        const result = store.updateAssignment(id, { name: draft.name, groupId: draft.groupId, rules: draft.rules, note: draft.note });
        if (!result.ok) return setError(result.error);
        setDirty(false); setError(""); void message.success("配置草稿已保存到本次预览。用户端仍使用上次上线版本。");
    };
    const columns = [
        ...PRICE_PARAMETERS[draft.kind].map(key => ({ title: parameterNames[key], width: key === "durationSeconds" ? 100 : 130, render: (_: unknown, row: { index: number; parameters: Record<string, string> }) => <Input aria-label={`规格${row.index + 1}${parameterNames[key]}`} placeholder={key === "mode" || key === "quality" ? "不限" : key === "durationSeconds" ? "例如 5" : draft.kind === "image" ? "例如 2K" : "例如 1080p"} value={row.parameters[key] ?? ""} inputMode={key === "durationSeconds" ? "decimal" : "text"} onChange={event => setParameter(row.index, key, event.target.value)} /> })),
        ...(["cost", "sale"] as const).flatMap(side => { const rule = draft.rules[side]; return rule ? PRICE_TEMPLATES[rule.template].meters.map(meter => ({ title: <span>{side === "cost" ? "成本" : "售价"}{PRICE_TEMPLATES[rule.template].meters.length > 1 ? ` · ${PRICE_METERS[meter].label}` : ""}<small className="block font-normal" style={{ color: token.colorTextTertiary }}>{rule.currency === "credit" ? "积分" : rule.currency} / {PRICE_METERS[meter].unit}</small></span>, width: 150, render: (_: unknown, row: { index: number }) => <Input aria-label={`规格${row.index + 1}${side === "cost" ? "成本" : "售价"}${PRICE_METERS[meter].label}`} inputMode="decimal" placeholder={side === "cost" ? "未知" : "必填，0 为免费"} value={rule.bands[row.index]?.rates[meter] ?? ""} onChange={event => setRate(side, row.index, meter, event.target.value)} /> })) : []; }),
        ...(draft.kind === "text" ? [] : [{ title: "操作", width: 75, render: (_: unknown, row: { index: number }) => <Button size="small" type="text" danger disabled={draft.rules.sale.bands.length === 1} onClick={() => patchRules({ ...draft.rules, sale: { ...draft.rules.sale, bands: draft.rules.sale.bands.filter((_, index) => index !== row.index) }, cost: draft.rules.cost ? { ...draft.rules.cost, bands: draft.rules.cost.bands.filter((_, index) => index !== row.index) } : null })}>移除</Button> }]),
    ];
    return <Drawer open title={<span>{kindNames[draft.kind]}模型配置 <Tag className="!ml-2">模拟草稿</Tag></span>} size={980} onClose={close} styles={{ body: { padding: 24 } }} footer={<div className="flex flex-wrap items-center justify-between gap-3"><Typography.Text type="secondary">{dirty ? "有未保存的修改" : "草稿已保存"} · {original.published ? `用户预览版本 ${original.published.version}` : "用户端尚不可见"}</Typography.Text><Space><Button onClick={save}>保存配置草稿</Button><Button type="primary" disabled={dirty} onClick={() => setConfirm(true)}>预览并确认上线</Button></Space></div>}>
        <Typography.Paragraph type="secondary">{store.channels.find(channel => channel.id === model?.channelId)?.name} → {model?.upstreamId}。以下参数和金额均为演示，不代表供应商真实能力或报价。</Typography.Paragraph>
        <div className="mb-6 grid gap-4 sm:grid-cols-2"><Field label="用户看到的模型名称"><Input aria-label="模型展示名称" value={draft.name} onChange={event => patch({ name: event.target.value })} /></Field><Field label="用户可见分组"><Select aria-label="模型展示分组" className="w-full" value={draft.groupId} options={store.groups.filter(group => group.kind === draft.kind).map(group => ({ label: group.name, value: group.id }))} onChange={value => patch({ groupId: value })} /></Field></div>
        <Card size="small" title="规格与价格" extra={<Tag>{draft.rules.sale.bands.length} 档</Tag>}>
            <div className="mb-5 flex flex-wrap items-end gap-4"><Field label="用户售价计费方式"><Select aria-label="用户售价计费方式" style={{ minWidth: 165 }} value={draft.rules.sale.template} options={unitOptions} onChange={(value: PriceTemplate) => changeUnit("sale", value)} /></Field><div><Checkbox checked={draft.rules.cost !== null} onChange={event => patchRules({ ...draft.rules, cost: event.target.checked ? { ...structuredClone(draft.rules.sale), currency: "CNY", bands: draft.rules.sale.bands.map(band => ({ parameters: { ...band.parameters }, rates: Object.fromEntries(PRICE_TEMPLATES[draft.rules.sale.template].meters.map(meter => [meter, null])) })) } : null })}>录入渠道成本</Checkbox></div>
                {draft.rules.cost && <><Field label="成本计费方式"><Select aria-label="渠道成本计费方式" style={{ minWidth: 165 }} value={draft.rules.cost.template} options={unitOptions} onChange={(value: PriceTemplate) => changeUnit("cost", value)} /></Field><Field label="成本币种"><Select aria-label="渠道成本币种" style={{ width: 115 }} value={draft.rules.cost.currency === "credit" ? undefined : draft.rules.cost.currency} options={[{ value: "CNY", label: "人民币" }, { value: "USD", label: "美元" }]} onChange={(value: "CNY" | "USD") => draft.rules.cost && changeUnit("cost", draft.rules.cost.template, value)} /></Field></>}
            </div>
            {draft.kind === "video" && <Alert className="!mb-4" type="info" showIcon title={draft.rules.sale.template === "video_second" ? "按秒：用户费用 = 此规格每秒售价 × 所选时长。" : "按整段：用户费用 = 此分辨率与时长组合的整段售价，不再乘时长。"} />}
            <Table rowKey="index" pagination={false} size="small" scroll={{ x: draft.kind === "text" ? 680 : 850 }} dataSource={draft.rules.sale.bands.map((band, index) => ({ ...band, index }))} columns={columns} />
            {draft.kind !== "text" && <Button className="!mt-4" icon={<Plus size={15} />} onClick={addVariant}>添加规格组合</Button>}
            <Typography.Paragraph type="secondary" className="!mb-0 !mt-4 text-xs">每行是一个可选规格。售价不能为空，明确免费请填 0；成本留空代表未知。不同币种不直接相减，不自动换算。规格组合不能重复。</Typography.Paragraph>
            {draft.kind === "text" && <Typography.Paragraph type="secondary" className="!mb-0 !mt-2 text-xs">当前预览演示输入、输出双项价格；缓存读写等扩展项与真实文本结算仍待接入。</Typography.Paragraph>}
        </Card>
        <div className="mt-5"><Field label="给用户的价格说明"><Input.TextArea aria-label="公开价格说明" rows={3} value={draft.note} placeholder="说明计费单位与规格适用范围" onChange={event => patch({ note: event.target.value })} /></Field></div>
        <div className="mt-5 rounded-xl border p-4" style={{ borderColor: token.colorBorderSecondary }}><div className="mb-1 font-medium">官方参考价</div><Typography.Text type="secondary">独立维护，用于同口径对照。本预览未连接真实参考价，不自动填入你的成本或售价。</Typography.Text></div>
        {error && <Alert className="!mt-4" showIcon type="error" title={error} />}
        <Modal open={confirm} title="确认上线到用户端预览" okText="确认模拟上线" cancelText="返回检查" onCancel={() => setConfirm(false)} onOk={() => { const result = store.publishAssignment(id); if (!result.ok) { setError(result.error); setConfirm(false); return; } setDraft(structuredClone(useModelManagementPreview.getState().assignments.find(item => item.id === id)!)); setConfirm(false); void message.success("已更新用户端预览。没有修改线上配置或产生费用。"); }}>
            <Typography.Paragraph><strong>{original.name}</strong> · {store.groups.find(group => group.id === original.groupId)?.name}</Typography.Paragraph><Typography.Paragraph>{priceSummary(original)}</Typography.Paragraph><Typography.Paragraph>{original.note || "未填写额外价格说明"}</Typography.Paragraph><Typography.Text type="secondary">用户只会看到此处售价与公开说明，渠道成本不公开。只有已保存且校验通过的配置才能上线。</Typography.Text>
        </Modal>
    </Drawer>;
}
