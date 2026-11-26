import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Alert, Button, Collapse, Empty, Input, Segmented, Select, Space, Tag, Typography, theme } from "antd";
import { FileText, Image as ImageIcon, Video } from "lucide-react";

import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import { getPublishedModels, PRICE_METERS, PRICE_TEMPLATES, quotePreviewPrice, useModelManagementPreview, type Kind } from "./state";
import type { PriceMeter } from "../../../../../packages/shared/src/model-pricing-drafts";

const kinds = { text: "文本", image: "图片", video: "视频" };
const parameterNames: Record<string, string> = { size: "图片分辨率", quality: "质量", resolution: "视频分辨率", durationSeconds: "视频时长", mode: "生成方式" };
const noop = () => {};

export function NodeExperience() {
    const state = useModelManagementPreview();
    const { token } = theme.useToken();
    const [kind, setKind] = useState<Kind>("video");
    const [search, setSearch] = useState("");
    const [chosenId, setChosenId] = useState("");
    const [expanded, setExpanded] = useState<string[]>([]);
    const [selection, setSelection] = useState<{ key: string; parameters: Record<string, string> }>({ key: "", parameters: {} });
    const [textUsage, setTextUsage] = useState({ input_token: "1000", output_token: "500" });
    const models = getPublishedModels(state, kind);
    const model = models.find((item) => item.id === chosenId) ?? models[0];
    const key = model ? `${model.id}:${model.version}` : "";
    const parameters = selection.key === key ? selection.parameters : model?.sale.bands[0]?.parameters ?? {};
    const parameterKeys = [...new Set(model?.sale.bands.flatMap((band) => Object.keys(band.parameters)) ?? [])];
    parameterKeys.sort((a, b) => ["size", "quality", "resolution", "durationSeconds", "mode"].indexOf(a) - ["size", "quality", "resolution", "durationSeconds", "mode"].indexOf(b));
    const usage: Partial<Record<PriceMeter, string>> = kind === "text" ? textUsage : kind === "image" ? { request: "1", image: "1" } : { second: parameters.durationSeconds ?? "", video: "1" };
    const quote = model ? quotePreviewPrice(model, parameters, usage) : null;
    const selectedBand = quote?.status === "calculated" ? model?.sale.bands[quote.bandIndex] : null;
    const visibleModels = models.filter((item) => `${item.name} ${item.brand} ${state.groups.find((group) => group.id === item.groupId)?.name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
    const groups = state.groups.filter((group) => group.kind === kind && visibleModels.some((item) => item.groupId === group.id));
    const summary = Object.entries(parameters).map(([name, value]) => `${parameterNames[name] ?? name} ${value}${name === "durationSeconds" ? " 秒" : ""}`).join(" · ");
    const price = quote?.status === "calculated" && quote.total !== null ? `${quote.total} 积分` : "请选择有效规格";

    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 24, y: 70, k: 0.9 });
    const [node, setNode] = useState<CanvasNodeData>({ id: "isolated-model-config", type: CanvasNodeType.Config, title: "模型配置预览", position: { x: 24, y: 28 }, width: 350, height: 285 });
    const [selected, setSelected] = useState(true);
    const drag = useRef<{ x: number; y: number; left: number; top: number; scale: number } | null>(null);
    useEffect(() => {
        const move = (event: globalThis.MouseEvent) => {
            const active = drag.current;
            if (active) setNode((current) => ({ ...current, position: { x: active.left + (event.clientX - active.x) / active.scale, y: active.top + (event.clientY - active.y) / active.scale } }));
        };
        const release = () => { drag.current = null; };
        window.addEventListener("mousemove", move); window.addEventListener("mouseup", release); window.addEventListener("blur", release);
        return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", release); window.removeEventListener("blur", release); };
    }, []);
    const startDrag = (event: MouseEvent) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest("input,textarea,button,select"))) return;
        event.preventDefault(); event.stopPropagation(); setSelected(true);
        drag.current = { x: event.clientX, y: event.clientY, left: node.position.x, top: node.position.y, scale: viewport.k };
    };
    const chooseParameter = (name: string, value: string) => {
        if (!model) return;
        const preceding = parameterKeys.slice(0, parameterKeys.indexOf(name));
        const choices = model.sale.bands.filter((band) => band.parameters[name] === value && preceding.every((field) => band.parameters[field] === parameters[field]));
        const band = choices.find((item) => parameterKeys.every((field) => field === name || item.parameters[field] === parameters[field])) ?? choices[0];
        if (band) setSelection({ key, parameters: { ...band.parameters } });
    };

    return <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Alert type="info" showIcon title="用户选模体验 · 隔离预览" description="使用原版画布和配置节点，演示已配置的分组、规格及费用。所有价格均为示例，未接入线上节点或真实生成；刷新后恢复初始演示数据。" />
        <Segmented aria-label="预览节点类型" value={kind} onChange={(value) => { setKind(value as Kind); setChosenId(""); setSearch(""); setExpanded([]); }} options={[
            { label: "文本节点", value: "text", icon: <FileText size={14} /> }, { label: "图片节点", value: "image", icon: <ImageIcon size={14} /> }, { label: "视频节点", value: "video", icon: <Video size={14} /> },
        ]} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 18, alignItems: "start" }}>
            <section aria-label="原版画布预览" style={{ position: "relative", height: 620, overflow: "hidden", border: `1px solid ${token.colorBorder}`, borderRadius: 14 }}>
                <InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportChange={setViewport} tool="pan" onCanvasDeselect={() => setSelected(false)}>
                    <CanvasNode data={{ ...node, metadata: { generationMode: kind, model: model?.name } }} scale={viewport.k} isSelected={selected} isRelated={false} isFocusRelated={false} isConnectionTarget={false} isConnecting={false}
                        showPanel={false} showImageInfo={false} onMouseDown={startDrag} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResizeStart={noop} onResizeEnd={noop}
                        onResize={(_id, width, height, position) => setNode((current) => ({ ...current, width, height, position: position ?? current.position }))}
                        onContentChange={noop} onTitleChange={(_id, title) => setNode((current) => ({ ...current, title }))} onContextMenu={(event) => event.preventDefault()}
                        renderNodeContent={() => <div style={{ width: "100%", height: "100%", padding: 24, color: token.colorText, display: "flex", flexDirection: "column", gap: 12 }}>
                            <Typography.Text type="secondary">{kinds[kind]}创作 · 示例配置</Typography.Text>
                            <Typography.Title level={4} style={{ margin: 0 }}>{model?.name ?? "暂无可选模型"}</Typography.Title>
                            <Typography.Text type="secondary">{summary || (kind === "text" ? "输入 / 输出分别计价" : "当前模型未配置规格")}</Typography.Text>
                            <div style={{ marginTop: "auto" }}><Typography.Text type="secondary">{kind === "text" ? "模拟用量费用" : "本次示例费用"}</Typography.Text><Typography.Title level={3} style={{ margin: "4px 0" }}>{price}</Typography.Title></div>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>在右侧选择模型和规格；此处不提交生成。</Typography.Text>
                        </div>} />
                </InfiniteCanvas>
                <div style={{ position: "absolute", bottom: 16, left: 18, right: 18, color: token.colorTextSecondary, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>拖动画布或节点 · 滚轮缩放 · 双击标题改名</span>
                    <Button size="small" type="text" onClick={() => { setViewport({ x: 24, y: 70, k: 0.9 }); setNode((current) => ({ ...current, position: { x: 24, y: 28 } })); }}>复位 {Math.round(viewport.k * 100)}%</Button>
                </div>
            </section>
            <section aria-label="用户模型选择" style={{ padding: 20, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 14, background: token.colorBgContainer }}>
                <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
                    <div><Typography.Title level={4} style={{ margin: "0 0 6px" }}>选择{kinds[kind]}模型</Typography.Title><Typography.Text type="secondary">仅展示已在演示配置中上线的{kinds[kind]}模型</Typography.Text></div>
                    <Input.Search aria-label="搜索用户模型" placeholder="搜索模型或分组" value={search} onChange={(event) => setSearch(event.target.value)} allowClear />
                    {groups.length ? <Collapse activeKey={search.trim() ? groups.map((group) => group.id) : expanded} onChange={(keys) => setExpanded(Array.isArray(keys) ? keys : [keys])} items={groups.map((group) => ({
                        key: group.id, label: <Space>{group.name}<Tag>{visibleModels.filter((item) => item.groupId === group.id).length}</Tag></Space>, children: <Space orientation="vertical" size={6} style={{ width: "100%" }}>
                            {visibleModels.filter((item) => item.groupId === group.id).map((item) => <button type="button" key={item.id} aria-pressed={model?.id === item.id} onClick={() => setChosenId(item.id)}
                                style={{ width: "100%", padding: "10px 12px", textAlign: "left", color: token.colorText, background: model?.id === item.id ? token.controlItemBgActive : "transparent", border: `1px solid ${model?.id === item.id ? token.colorPrimaryBorder : token.colorBorderSecondary}`, borderRadius: 8, cursor: "pointer" }}>
                                <div style={{ fontWeight: 600 }}>{item.name}</div><div style={{ marginTop: 4, fontSize: 12, color: token.colorTextSecondary }}>{PRICE_TEMPLATES[item.sale.template].label}</div>
                            </button>)}
                        </Space>,
                    }))} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? "没有匹配的已上线模型" : "该节点还没有已上线模型"} />}
                    {model && <>
                        <div><Typography.Text type="secondary">当前模型</Typography.Text><Typography.Title level={5} style={{ margin: "4px 0" }}>{model.name}</Typography.Title></div>
                        {parameterKeys.map((name, index) => {
                            const matching = model.sale.bands.filter((band) => parameterKeys.slice(0, index).every((field) => band.parameters[field] === parameters[field]));
                            const values = [...new Set(matching.map((band) => band.parameters[name]).filter(Boolean))];
                            return <label key={name} style={{ display: "grid", gap: 6 }}><Typography.Text>{parameterNames[name] ?? name}</Typography.Text><Select aria-label={parameterNames[name] ?? name} value={parameters[name]} onChange={(value) => chooseParameter(name, value)} options={values.map((value) => ({ value, label: name === "durationSeconds" ? `${value} 秒` : value }))} /></label>;
                        })}
                        {kind === "text" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            <label><Typography.Text>模拟输入 Token</Typography.Text><Input aria-label="模拟输入 Token" inputMode="numeric" value={textUsage.input_token} onChange={(event) => setTextUsage({ ...textUsage, input_token: event.target.value })} /></label>
                            <label><Typography.Text>模拟输出 Token</Typography.Text><Input aria-label="模拟输出 Token" inputMode="numeric" value={textUsage.output_token} onChange={(event) => setTextUsage({ ...textUsage, output_token: event.target.value })} /></label>
                        </div>}
                        <div style={{ padding: 16, borderRadius: 10, background: token.colorFillQuaternary }}>
                            <Typography.Text type="secondary">{kind === "text" ? "模拟用量费用" : kind === "image" ? model.sale.template === "image_request" ? "单次费用（示例一次出一张）" : "单张费用" : "本段视频费用"}</Typography.Text>
                            <Typography.Title level={3} style={{ margin: "4px 0 8px" }}>{price}</Typography.Title>
                            {selectedBand && PRICE_TEMPLATES[model.sale.template].meters.map((meter) => <div key={meter} style={{ fontSize: 12, color: token.colorTextSecondary }}>{PRICE_METERS[meter].label}：{selectedBand.rates[meter]} 积分 / {PRICE_METERS[meter].unit}</div>)}
                            {quote?.status === "calculated" && quote.lines.map((line) => <div key={line.meter} style={{ marginTop: 6, fontSize: 12 }}>{line.quantity}{PRICE_METERS[line.meter].base === 1_000_000 ? " Token" : PRICE_METERS[line.meter].unit} × {line.rate}{line.base !== 1 ? ` ÷ ${line.base}` : ""} = {line.total} 积分</div>)}
                            {quote && quote.status !== "calculated" && <Typography.Text type="warning">当前规格或用量不完整，请重新选择；不会用其他档位代替报价。</Typography.Text>}
                            {model.note && <Typography.Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0 }}>{model.note}</Typography.Paragraph>}
                        </div>
                    </>}
                    <Button block disabled>仅演示选模与费用 · 不生成、不扣费</Button>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>画布引擎与配置节点复用原组件；本页仅验证选模交互，连线、任务执行和线上接入另行完成。</Typography.Text>
                </Space>
            </section>
        </div>
    </Space>;
}
