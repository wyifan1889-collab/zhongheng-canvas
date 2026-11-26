import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Empty, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { inferProviderModel } from "@/services/saas/model-classification";
import { ModelBrandIcon } from "@/components/model-brand-icon";
import { useModelMappingDraft } from "../use-model-mapping-draft";
import MappingPublicationDialog from "./MappingPublicationDialog";
import MappingExecutionFields, { executionInput, executionFromInput, type ExecutionInput } from "./MappingExecutionFields";
import { addMapping, mappingSourceKey, mappingCombinationKey, mappingBindingKey, mappingParameterLabel, previewMappingRoute, removeMappingSource, removeMappingBindings, replaceMappingBinding, suggestModelMapping, validMappingPrice, validMappingSpecification,
    type MappingBinding, type MappingCapability, type MappingModel, type MappingSource } from "../model-mapping-plan";

type Editor = { source: MappingSource; target: string; id: string; name: string; capability: MappingCapability; specification: string; confirmed: boolean; previous?: MappingBinding; execution: ExecutionInput };
type SpecificationEditor = { ids: string[]; capability: MappingCapability; options: string[]; selected: string[]; value: string; error: string };
export type MappingSourceFocus = Pick<MappingSource, "providerId" | "providerModel"> & { capability: MappingCapability; requestId: number };
const labels = { image: "图片", video: "视频" };
const routeLabels = { missing: "型号已缺失", unavailable: "渠道已停用", choose_channel: "待选择渠道" };

export default function ModelMappingPreview({ directoryChange, sourceFocus, onPublished }: { directoryChange: number; sourceFocus?: MappingSourceFocus | null; onPublished: () => void }) {
    const persistence = useModelMappingDraft(directoryChange);
    const { draft, setDraft, notice, setNotice } = persistence;
    const directory = persistence.catalog?.sources ?? [];
    const sources = [...new Map([...directory, ...draft.bindings.filter(binding => !directory.some(source => mappingSourceKey(source) === mappingSourceKey(binding)))
        .map(binding => ({ providerId: binding.providerId, providerName: binding.providerId, providerModel: binding.providerModel, available: false, providerEnabled: false }))].map(source => [mappingSourceKey(source), source])).values()];
    const [kind, setKind] = useState<MappingCapability>("image"), [channel, setChannel] = useState<string>(), [search, setSearch] = useState("");
    const [selected, setSelected] = useState<string[]>([]), [selectedModels, setSelectedModels] = useState<string[]>([]), [group, setGroup] = useState("");
    const [tab, setTab] = useState("sources");
    const [focusedSource, setFocusedSource] = useState<MappingSourceFocus | null>(null);
    const [editor, setEditor] = useState<Editor | null>(null), [editorError, setEditorError] = useState("");
    const [deleting, setDeleting] = useState<MappingModel | null>(null);
    const [previewId, setPreviewId] = useState<string>(), [previewSpec, setPreviewSpec] = useState<string>();
    const [previewCombination, setPreviewCombination] = useState<string>();
    const [specificationEditor, setSpecificationEditor] = useState<SpecificationEditor | null>(null);
    const [publicationOpen, setPublicationOpen] = useState(false);
    useEffect(() => { setSelected([]); setSelectedModels([]); setEditor(null); setDeleting(null); setSpecificationEditor(null); setPreviewId(undefined); setPreviewSpec(undefined); setPreviewCombination(undefined); }, [persistence.catalog?.version]);
    useEffect(() => {
        if (!sourceFocus) return;
        setFocusedSource(sourceFocus); setKind(sourceFocus.capability); setChannel(undefined); setSearch(""); setTab("sources");
        setSelected([]); setSelectedModels([]); setPreviewId(undefined); setPreviewSpec(undefined); setPreviewCombination(undefined);
    }, [sourceFocus?.requestId]);
    const sourceMap = new Map(sources.map(source => [mappingSourceKey(source), source]));
    const bindings = new Map(draft.bindings.map(binding => [mappingSourceKey(binding), binding]));
    const channels = [...new Map(sources.map(source => [source.providerId, { value: source.providerId, label: source.providerName }])).values()];
    const visibleSources = sources.filter(source => {
        if (focusedSource) return mappingSourceKey(source) === mappingSourceKey(focusedSource);
        const suggestion = suggestModelMapping(source.providerModel), binding = bindings.get(mappingSourceKey(source));
        const capability = binding ? draft.models.find(model => model.id === binding.modelId)?.capability : suggestion?.capability ?? inferProviderModel(source.providerModel).capability;
        return (!channel || source.providerId === channel) && (!capability || capability === kind) &&
            `${source.providerName} ${source.providerModel}`.toLowerCase().includes(search.toLowerCase());
    });
    const models = draft.models.filter(model => model.capability === kind);
    const activeModel = previewId ? models.find(model => model.id === previewId) : models[0];
    const specifications = (modelId: string) => [...new Set(draft.bindings.filter(binding => binding.modelId === modelId).map(binding => binding.specification))];
    const combinations = (modelId: string) => [...new Map(draft.bindings.filter(binding => binding.modelId === modelId).map(binding => [mappingCombinationKey(binding), binding])).values()];
    const configured = (binding: MappingBinding) => !!binding.execution && validMappingPrice(draft.prices[mappingCombinationKey(binding)] ?? "") && previewMappingRoute(draft, sources, binding.modelId, binding.specification, binding.execution).status === "ready";
    const displaySpecs = activeModel ? draft.specificationOptions[activeModel.capability].filter(spec => draft.modelSpecifications[activeModel.id].includes(spec)) : [];
    const previewRows = activeModel ? combinations(activeModel.id) : [];
    const availableSpecs = displaySpecs.filter(spec => previewRows.some(binding => binding.specification === spec && configured(binding)));
    const activeSpec = previewSpec ? availableSpecs.includes(previewSpec) ? previewSpec : undefined : availableSpecs[0];
    const specUnavailable = !!previewSpec && !activeSpec;
    const availableCombinations = previewRows.filter(binding => binding.specification === activeSpec && configured(binding));
    const activeCombination = previewCombination ? availableCombinations.find(binding => mappingCombinationKey(binding) === previewCombination) : availableCombinations[0];
    const selectedPrice = activeCombination ? draft.prices[mappingCombinationKey(activeCombination)] : undefined;

    function openEditor(source: MappingSource, selectedBinding?: MappingBinding | null) {
        const suggestion = suggestModelMapping(source.providerModel), binding = selectedBinding === null ? undefined : selectedBinding ?? bindings.get(mappingSourceKey(source));
        const existing = binding ?? bindings.get(mappingSourceKey(source));
        setEditorError("");
        setEditor({ source, target: existing?.modelId ?? (suggestion && draft.models.some(model => model.id === suggestion.id) ? suggestion.id : ""),
            id: binding?.modelId ?? suggestion?.id ?? "", name: suggestion?.displayName ?? "", capability: suggestion?.capability ?? kind,
            specification: binding?.specification ?? suggestion?.specification ?? "", confirmed: false, previous: binding, execution: executionInput(binding) });
    }
    function saveEditor() {
        if (!editor?.confirmed) return;
        try {
            const source = sourceMap.get(mappingSourceKey(editor.source));
            if (!source) throw new Error("当前目录已变化，请关闭后重新读取型号");
            const target = editor.target ? draft.models.find(model => model.id === editor.target) : {
                id: editor.id.trim(), displayName: editor.name.trim(), capability: editor.capability, group: "",
            };
            if (!target) throw new Error("目标模型已变化，请重新选择");
            const specification = editor.specification.trim().toUpperCase(), execution = executionFromInput(editor.execution, target.capability, specification, source.providerModel);
            if (execution === null) throw new Error("请填写完整、有效的调用参数；视频分辨率须与展示规格一致，暂未支持的协议请保留待核实。");
            setDraft(replaceMappingBinding(draft, source, target, specification, execution, editor.previous));
            setEditor(null); setNotice("参数组合已加入草稿。变更参数后请核对该组合的渠道与积分，再保存。");
        } catch (error) { setEditorError(error instanceof Error ? error.message : "映射未完成"); }
    }
    function acceptSuggestions() {
        let next = draft, added = 0, pending = 0;
        for (const key of selected) {
            const source = sourceMap.get(key), suggestion = source && suggestModelMapping(source.providerModel);
            if (!source || !suggestion?.specification || suggestion.caution || !source.available) { pending++; continue; }
            try { const result = addMapping(next, source, suggestion, suggestion.specification); if (result !== next) added++; next = result; }
            catch { pending++; }
        }
        setDraft(next); setSelected([]); setNotice(`已加入 ${added} 条映射草稿${pending ? `，另有 ${pending} 条需要逐项核对` : ""}。尚未发布。`);
    }
    function moveModel(id: string, direction: -1 | 1) {
        const index = models.findIndex(model => model.id === id), other = models[index + direction];
        if (!other) return;
        setDraft(current => {
            const rows = [...current.models], a = rows.findIndex(model => model.id === id), b = rows.findIndex(model => model.id === other.id);
            [rows[a], rows[b]] = [rows[b], rows[a]]; return { ...current, models: rows };
        });
    }
    function patchModel(id: string, values: Partial<Pick<MappingModel, "displayName" | "group">>) {
        setDraft(current => ({ ...current, models: current.models.map(model => model.id === id ? { ...model, ...values } : model) }));
    }
    function removeModel(model: MappingModel) {
        setDraft(current => {
            let next = current;
            for (const binding of current.bindings.filter(item => item.modelId === model.id)) next = removeMappingSource(next, binding);
            return { ...next, models: next.models.filter(item => item.id !== model.id), modelSpecifications: Object.fromEntries(Object.entries(next.modelSpecifications).filter(([id]) => id !== model.id)) };
        });
        setSelectedModels(current => current.filter(id => id !== model.id)); setDeleting(null);
    }
    function openSpecificationEditor(ids: string[]) {
        setSpecificationEditor({ ids, capability: kind, options: [...draft.specificationOptions[kind]],
            selected: [...new Set(ids.flatMap(id => draft.modelSpecifications[id]))], value: "", error: "" });
    }
    function addSpecificationOption() {
        if (!specificationEditor) return;
        const value = specificationEditor.value.trim().toUpperCase();
        if (!validMappingSpecification(value, specificationEditor.capability)) {
            setSpecificationEditor({ ...specificationEditor, error: specificationEditor.capability === "image" ? "请输入完整规格，例如 2K、8K" : "请输入完整规格，例如 1080P、4K" }); return;
        }
        setSpecificationEditor({ ...specificationEditor, options: [...new Set([...specificationEditor.options, value])], selected: [...new Set([...specificationEditor.selected, value])], value: "", error: "" });
    }
    function saveSpecificationEditor() {
        if (!specificationEditor) return;
        const { ids, capability, options, selected } = specificationEditor;
        setDraft(current => ({ ...current, specificationOptions: { ...current.specificationOptions, [capability]: [...new Set([...current.specificationOptions[capability], ...options])] },
            modelSpecifications: { ...current.modelSpecifications, ...Object.fromEntries(ids.filter(id => current.models.some(model => model.id === id && model.capability === capability)).map(id => [id, [...selected]])) } }));
        setSpecificationEditor(null); setNotice(`已更新 ${ids.length} 个模型的展示规格草稿。尚未发布。`);
    }
    function priceRows(model: MappingModel) {
        return <Table<MappingBinding> size="small" rowKey={mappingCombinationKey} pagination={false} scroll={{ x: 640 }} dataSource={combinations(model.id)} columns={[
            { title: "规格与参数", width: 220, render: (_, binding) => <div><Typography.Text strong>{binding.specification}</Typography.Text><div><Typography.Text type="secondary">{mappingParameterLabel(binding)}</Typography.Text></div></div> },
            { title: "调用渠道", render: (_, binding) => {
                const { specification, execution } = binding, spec = mappingCombinationKey(binding), routes = draft.bindings.filter(item => mappingCombinationKey(item) === spec);
                const route = previewMappingRoute(draft, sources, model.id, specification, execution);
                return <div className="space-y-1"><Select className="w-full min-w-[180px]" aria-label={`${model.displayName} ${specification} ${mappingParameterLabel(binding)} 调用渠道`} placeholder="选择调用渠道"
                    value={Object.hasOwn(draft.preferred, spec) ? draft.preferred[spec] ?? undefined : routes.length === 1 ? mappingSourceKey(routes[0]) : undefined}
                    options={routes.map(binding => { const source = sourceMap.get(mappingSourceKey(binding)); return { value: mappingSourceKey(binding), label: `${source?.providerName ?? binding.providerId} · ${binding.providerModel}`, disabled: !source?.available || !source.providerEnabled }; })}
                    onChange={value => setDraft(current => ({ ...current, preferred: { ...current.preferred, [spec]: value } }))} />
                    {route.status !== "ready" && <Typography.Text type="warning">{routeLabels[route.status]}</Typography.Text>}</div>;
            } },
            { title: "规格积分", width: 130, render: (_, binding) => {
                const key = mappingCombinationKey(binding), value = draft.prices[key] ?? "", invalid = !!value && !validMappingPrice(value);
                return <div><Input aria-label={`${model.displayName} ${binding.specification} ${mappingParameterLabel(binding)} 售价草稿`} inputMode="numeric" value={value} placeholder="未定价" status={invalid ? "error" : undefined}
                    onChange={event => { const price = event.target.value; setDraft(current => ({ ...current, prices: { ...current.prices, [key]: price } })); }} />
                    <Typography.Text type="secondary">{binding.execution?.protocol === "gemini-generate-content-v1" ? "每交付一张" : model.capability === "image" ? "每张" : "每条"}</Typography.Text>
                    {invalid && <Typography.Text type="danger">当前规格价须为正整数积分</Typography.Text>}</div>;
            } },
            { title: "配置", width: 65, render: (_, binding) => <Button type="text" aria-label={`编辑组合 ${binding.specification} ${mappingParameterLabel(binding)}`} icon={<Pencil size={14} />} disabled={!sourceMap.get(mappingSourceKey(binding))?.available} onClick={() => openEditor(sourceMap.get(mappingSourceKey(binding))!, binding)} /> },
        ]} />;
    }

    const userPreview = <section aria-label="用户选模展示预览" className="min-w-0 border-t border-border pt-5 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
        <div className="mb-5 flex flex-wrap items-center gap-2"><Typography.Title level={5} className="!mb-0">用户选模展示</Typography.Title><Tag>草稿</Tag></div>
        {models.length ? <Form layout="vertical">
            <Form.Item label="模型"><Select aria-label="预览用户模型" className="w-full" value={activeModel?.id} placeholder="请选择模型" onChange={id => { setPreviewId(id); setPreviewSpec(undefined); setPreviewCombination(undefined); }}
                options={[...new Set(models.map(model => model.group.trim() || "未分组"))].map(name => ({ label: name, options: models.filter(model => (model.group.trim() || "未分组") === name).map(model => ({ value: model.id,
                    label: <span className="flex min-w-0 items-center gap-2"><ModelBrandIcon model={model.id} label={model.displayName} brand={model.group} /><span className="min-w-0 truncate">{model.displayName || model.id}</span></span> })) }))} /></Form.Item>
            <Form.Item label="清晰度" validateStatus={specUnavailable ? "warning" : undefined} help={specUnavailable ? "原规格已不可用，请重新选择" : undefined}><Select aria-label="预览用户清晰度" className="w-full" value={activeSpec} placeholder="请选择可用规格" options={displaySpecs.map(spec => ({ value: spec, label: availableSpecs.includes(spec) ? spec : `${spec}（暂不可用）`, disabled: !availableSpecs.includes(spec) }))} onChange={spec => { setPreviewSpec(spec); setPreviewCombination(undefined); }} /></Form.Item>
            <Form.Item label={kind === "image" ? "尺寸与画质" : "视频规格"} help={previewCombination && !activeCombination ? "原组合已不可用，请重新选择" : undefined}><Select aria-label="预览用户参数组合" className="w-full" value={activeCombination && mappingCombinationKey(activeCombination)} placeholder="请选择已配置组合" options={previewRows.filter(binding => binding.specification === activeSpec && binding.execution).map(binding => ({ value: mappingCombinationKey(binding), label: mappingParameterLabel(binding), disabled: !configured(binding) }))} onChange={setPreviewCombination} /></Form.Item>
            <div className="flex items-baseline justify-between border-t border-border pt-4"><Typography.Text type="secondary">费用草稿</Typography.Text><Typography.Text strong>{selectedPrice && validMappingPrice(selectedPrice) ? `${selectedPrice} 积分 / ${kind === "image" ? "张" : "条"}` : "未定价"}</Typography.Text></div>
        </Form> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无模型草稿" />}
    </section>;

    return <div className="space-y-4" aria-label="统一模型配置预览">
        <Alert type="info" showIcon title="统一模型与规格" description="按模型整理规格、调用参数、渠道和积分。先保存，再核对并生效；右侧为草稿展示，实际可用规格以生效配置和本次报价为准。" />
        <Space wrap><Button type="primary" loading={persistence.busy === "save"} disabled={!persistence.catalog || !persistence.dirty || !!persistence.busy || persistence.blocked} onClick={persistence.save}>保存统一配置草稿</Button>
            <Button loading={persistence.busy === "read"} disabled={!!persistence.busy || !!persistence.incoming} onClick={persistence.read}>读取服务器草稿</Button>
            <Button disabled={!persistence.catalog || persistence.dirty || !!persistence.busy || persistence.blocked || !!persistence.incoming} onClick={() => setPublicationOpen(true)}>核对并生效</Button>
            <Tag>{persistence.catalog ? `服务器版本 ${persistence.catalog.version}${persistence.dirty ? " · 未保存修改" : ""}` : "尚未读取"}</Tag></Space>
        {persistence.error && <Alert type="warning" showIcon title={persistence.error} />}
        {notice && <Alert type="info" showIcon title={notice} closable onClose={() => setNotice("")} />}
        <div inert={!!persistence.busy || !persistence.catalog || !!persistence.incoming} aria-busy={!!persistence.busy} className="space-y-4">
        <div className="flex flex-wrap items-center gap-3"><Select aria-label="归并节点类型" value={kind} options={Object.entries(labels).map(([value, label]) => ({ value, label: `${label}节点` }))} onChange={value => { setKind(value); setFocusedSource(null); setSelected([]); setSelectedModels([]); setPreviewId(undefined); setPreviewSpec(undefined); setPreviewCombination(undefined); }} />
            <Typography.Text type="secondary">{models.length} 个展示模型 · {draft.bindings.filter(binding => models.some(model => model.id === binding.modelId)).length} 条型号映射</Typography.Text></div>
        <Tabs activeKey={tab} onChange={setTab} items={[
            { key: "sources", label: "渠道型号", children: <section className="space-y-4">
                {focusedSource && <div className="flex min-w-0 flex-wrap items-center gap-2"><Typography.Text className="min-w-0 break-all">{sourceMap.get(mappingSourceKey(focusedSource))?.providerName ?? focusedSource.providerId} · {focusedSource.providerModel}</Typography.Text><Button size="small" onClick={() => setFocusedSource(null)}>查看全部型号</Button></div>}
                {focusedSource && visibleSources.length === 0 && <Alert type="warning" showIcon title="该渠道型号已不在当前目录，请重新读取核对。" />}
                <div className="flex flex-wrap items-center gap-2"><Input.Search aria-label="搜索归并型号" className="w-full sm:!w-64" placeholder="搜索型号或渠道" value={search} onChange={event => { setFocusedSource(null); setSearch(event.target.value); }} allowClear />
                    <Select aria-label="归并来源渠道" className="w-full sm:!w-52" value={channel} options={channels} placeholder="全部渠道" allowClear onChange={value => { setFocusedSource(null); setChannel(value); }} />
                    <Button icon={<Check size={14} />} disabled={!selected.length} onClick={acceptSuggestions}>确认选中建议{selected.length ? `（${selected.length}）` : ""}</Button></div>
                <Table<MappingSource> size="small" rowKey={mappingSourceKey} scroll={{ x: 760 }} dataSource={visibleSources} rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: selected, onChange: keys => setSelected(keys.map(String)), getCheckboxProps: source => ({ disabled: !source.available || bindings.has(mappingSourceKey(source)) }) }} columns={[
                    { title: "渠道原始型号", width: 280, render: (_, source) => <div><Typography.Text className="break-all">{source.providerModel}</Typography.Text><div><Typography.Text type="secondary">{source.providerName}</Typography.Text></div></div> },
                    { title: "统一模型", render: (_, source) => { const binding = bindings.get(mappingSourceKey(source)), suggestion = suggestModelMapping(source.providerModel); return binding ? draft.models.find(model => model.id === binding.modelId)?.displayName : <Typography.Text type="secondary">{suggestion?.displayName ?? "待指定"}</Typography.Text>; } },
                    { title: "规格组合", width: 130, render: (_, source) => { const rows = draft.bindings.filter(binding => mappingSourceKey(binding) === mappingSourceKey(source)); return rows.length ? `${[...new Set(rows.map(binding => binding.specification))].join(" / ")} · ${rows.length}组` : suggestModelMapping(source.providerModel)?.specification ?? "待核实"; } },
                    { title: "状态", width: 120, render: (_, source) => !source.available ? <Tag color="orange">上游已缺失</Tag> : bindings.has(mappingSourceKey(source)) ? <Tag color="green">已加入草稿</Tag> : <Tag>{suggestModelMapping(source.providerModel)?.caution || !suggestModelMapping(source.providerModel)?.specification ? "需逐项核对" : "待确认建议"}</Tag> },
                    { title: "操作", width: 100, render: (_, source) => <Space size={0}><Tooltip title="设置映射"><Button type="text" aria-label={`设置映射 ${source.providerName} ${source.providerModel}`} icon={<Pencil size={14} />} disabled={!source.available} onClick={() => openEditor(source)} /></Tooltip>
                        {bindings.has(mappingSourceKey(source)) && <Tooltip title="移除草稿映射"><Button type="text" aria-label={`移除映射 ${source.providerName} ${source.providerModel}`} icon={<Trash2 size={14} />} onClick={() => setDraft(current => removeMappingSource(current, source))} /></Tooltip>}</Space> },
                ]} />
            </section> },
            { key: "display", label: "展示与价格", children: <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
                <section className="min-w-0 space-y-4"><div className="flex flex-wrap items-center gap-2"><Input aria-label="批量展示分组" className="w-full sm:!w-48" value={group} onChange={event => setGroup(event.target.value)} placeholder="展示分组" />
                    <Button disabled={!selectedModels.length} onClick={() => { setDraft(current => ({ ...current, models: current.models.map(model => selectedModels.includes(model.id) ? { ...model, group: group.trim() } : model) })); setSelectedModels([]); }}>批量设置分组</Button>
                    <Button icon={<SlidersHorizontal size={14} />} disabled={!selectedModels.length} onClick={() => openSpecificationEditor(selectedModels)}>批量设置规格</Button></div>
                    <Table<MappingModel> size="small" rowKey="id" pagination={false} scroll={{ x: 520 }} dataSource={models} rowSelection={{ selectedRowKeys: selectedModels, onChange: keys => setSelectedModels(keys.map(String)) }} expandable={{ expandedRowRender: priceRows, rowExpandable: model => specifications(model.id).length > 0 }} columns={[
                        { title: "用户看到的名称", render: (_, model) => <div><Input aria-label={`展示名称 ${model.id}`} value={model.displayName} onChange={event => patchModel(model.id, { displayName: event.target.value })} /><Typography.Text type="secondary" className="text-xs">{model.id}</Typography.Text></div> },
                        { title: "分组", width: 130, render: (_, model) => <Input aria-label={`展示分组 ${model.id}`} value={model.group} placeholder="未分组" onChange={event => patchModel(model.id, { group: event.target.value })} /> },
                        { title: "设置与顺序", width: 145, render: (_, model, index) => <Space size={0}><Tooltip title="展示规格"><Button type="text" aria-label={`展示规格 ${model.id}`} icon={<SlidersHorizontal size={14} />} onClick={() => openSpecificationEditor([model.id])} /></Tooltip><Tooltip title="上移"><Button type="text" aria-label={`上移模型 ${model.id}`} disabled={index === 0} icon={<ArrowUp size={14} />} onClick={() => moveModel(model.id, -1)} /></Tooltip><Tooltip title="下移"><Button type="text" aria-label={`下移模型 ${model.id}`} disabled={index === models.length - 1} icon={<ArrowDown size={14} />} onClick={() => moveModel(model.id, 1)} /></Tooltip><Tooltip title="移除模型草稿"><Button type="text" aria-label={`移除模型草稿 ${model.id}`} icon={<Trash2 size={14} />} onClick={() => setDeleting(model)} /></Tooltip></Space> },
                    ]} />
                </section>{userPreview}
            </div> },
        ]} />
        <Modal getContainer={false} title={`${specificationEditor?.ids.length === 1 ? "" : "批量设置"}${specificationEditor ? labels[specificationEditor.capability] : ""}展示规格`} open={specificationEditor !== null} okText="应用到草稿" cancelText="取消" onCancel={() => setSpecificationEditor(null)} onOk={saveSpecificationEditor}>
            {specificationEditor && <Form layout="vertical">
                <Form.Item label="模型"><div className="flex flex-wrap gap-1">{specificationEditor.ids.map(id => <Tag key={id}>{draft.models.find(model => model.id === id)?.displayName ?? id}</Tag>)}</div></Form.Item>
                <Form.Item label="展示规格"><Checkbox.Group aria-label="模型展示规格" value={specificationEditor.selected} options={specificationEditor.options}
                    onChange={selected => setSpecificationEditor(current => current && ({ ...current, selected: selected.map(String) }))} /></Form.Item>
                <Form.Item label="新增规格" validateStatus={specificationEditor.error ? "error" : undefined} help={specificationEditor.error || undefined}><Space.Compact className="w-full"><Input aria-label="新增展示规格" value={specificationEditor.value} placeholder={specificationEditor.capability === "image" ? "例如 8K" : "例如 1080P、4K"}
                    onChange={event => setSpecificationEditor(current => current && ({ ...current, value: event.target.value, error: "" }))} onPressEnter={addSpecificationOption} />
                    <Button icon={<Plus size={14} />} onClick={addSpecificationOption}>添加</Button></Space.Compact></Form.Item>
            </Form>}
        </Modal>
        <Modal getContainer={false} title={`移除「${deleting?.displayName ?? ""}」的预览草稿？`} open={deleting !== null} okText="移除草稿" cancelText="保留" onCancel={() => setDeleting(null)} onOk={() => { if (deleting) removeModel(deleting); }}>
            <Typography.Paragraph>该模型的预览映射和价格输入会一并清除。</Typography.Paragraph>
        </Modal>
        <Modal getContainer={false} title="规格与调用参数" width={640} style={{ top: 24 }} styles={{ body: { maxHeight: "calc(100dvh - 190px)", overflowY: "auto", overflowX: "hidden" } }} open={editor !== null} onCancel={() => setEditor(null)} okText="应用到草稿" cancelText="取消" okButtonProps={{ disabled: !editor?.confirmed }} onOk={saveEditor}>
            {editor && <Form layout="vertical">
                <Typography.Paragraph className="break-all">{editor.source.providerName} · {editor.source.providerModel}</Typography.Paragraph>
                <Form.Item label="编辑组合"><Select aria-label="编辑已有参数组合" value={editor.previous ? mappingBindingKey(editor.previous) : "new"} options={[
                    { value: "new", label: "添加另一个参数组合" }, ...draft.bindings.filter(binding => mappingSourceKey(binding) === mappingSourceKey(editor.source)).map(binding => ({ value: mappingBindingKey(binding), label: `${binding.specification} · ${mappingParameterLabel(binding)}` })),
                ]} onChange={key => openEditor(editor.source, key === "new" ? null : draft.bindings.find(binding => mappingBindingKey(binding) === key))} /></Form.Item>
                {suggestModelMapping(editor.source.providerModel)?.caution && <Alert className="!mb-4" type="warning" showIcon title={suggestModelMapping(editor.source.providerModel)?.caution} />}
                <Form.Item label="统一模型"><Select aria-label="映射目标模型" value={editor.target} options={[{ value: "", label: "新建展示模型" }, ...draft.models.map(model => ({ value: model.id,
                    label: <span className="flex min-w-0 items-center gap-2"><ModelBrandIcon model={model.id} label={model.displayName} brand={model.group} /><span className="min-w-0 truncate">{model.displayName} · {labels[model.capability]}</span></span> }))]} onChange={target => setEditor(current => current && ({ ...current, target, confirmed: false, execution: executionInput() }))} /></Form.Item>
                {!editor.target && <><Form.Item label="模型 ID"><Input aria-label="新建统一模型 ID" value={editor.id} onChange={event => setEditor(current => current && ({ ...current, id: event.target.value, confirmed: false }))} /></Form.Item>
                    <Form.Item label="用户看到的名称"><Input aria-label="新建统一模型名称" value={editor.name} onChange={event => setEditor(current => current && ({ ...current, name: event.target.value, confirmed: false }))} /></Form.Item>
                    <Form.Item label="节点类型"><Select aria-label="映射节点类型" value={editor.capability} options={Object.entries(labels).map(([value, label]) => ({ value, label }))} onChange={capability => setEditor(current => current && ({ ...current, capability, confirmed: false, execution: executionInput() }))} /></Form.Item></>}
                <Form.Item label="清晰度"><Input aria-label="映射清晰度" value={editor.specification} placeholder="例如 4K 或 720P" onChange={event => setEditor(current => current && ({ ...current, specification: event.target.value, confirmed: false }))} /></Form.Item>
                <MappingExecutionFields capability={draft.models.find(model => model.id === editor.target)?.capability ?? editor.capability} specification={editor.specification} providerModel={editor.source.providerModel} value={editor.execution} onChange={execution => setEditor(current => current && ({ ...current, execution, confirmed: false }))} />
                <Checkbox checked={editor.confirmed} onChange={event => setEditor(current => current && ({ ...current, confirmed: event.target.checked }))}>{editor.execution.protocol ? "已核对该型号支持以上协议和参数，加入草稿" : "确认模型与展示标签，实际参数保留待核实"}</Checkbox>
                {editor.previous && <div className="mt-3"><Button type="text" danger onClick={() => { setDraft(current => removeMappingBindings(current, binding => mappingBindingKey(binding) === mappingBindingKey(editor.previous!))); setEditor(null); }}>移除此组合</Button></div>}
                {editorError && <Alert className="!mt-4" type="error" showIcon title={editorError} />}
            </Form>}
        </Modal>
        </div>
        <MappingPublicationDialog open={publicationOpen} draftVersion={persistence.catalog?.version ?? 0} onClose={() => setPublicationOpen(false)} onPublished={receipt => {
            setNotice(`草稿 ${receipt.draftVersion} 已确认生效为版本 ${receipt.version}，后续修改仍需保存并核对。`); onPublished();
        }} />
        <Modal getContainer={false} title="核对服务器草稿" open={!!persistence.incoming} closable={false} keyboard={false} maskClosable={false}
            footer={<Space wrap><Button onClick={() => persistence.acceptIncoming(false)}>采用服务器草稿</Button><Button type="primary" onClick={() => persistence.acceptIncoming(true)}>保留本地输入</Button></Space>}>
            <Typography.Paragraph>已读取服务器版本 {persistence.incoming?.version}，本地仍有未保存输入。采用服务器草稿会替换本地输入；保留本地输入后，请核对变化的渠道与配置，再手动保存。</Typography.Paragraph>
        </Modal>
    </div>;
}
