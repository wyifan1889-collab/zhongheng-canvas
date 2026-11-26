import { useState } from "react";
import { Alert, Button, Tag, Typography, theme } from "antd";
import { Boxes, Cable, Clapperboard, LayoutGrid, ListTree, Tags } from "lucide-react";

import { ChannelPanel, CatalogPanel } from "./ChannelCatalogPanels";
import { AssignmentPanel, PricingPanel } from "./AssignmentPanels";
import { NodeExperience } from "./NodeExperience";
import { useModelManagementPreview } from "./state";
import { useThemeStore } from "@/stores/use-theme-store";

type Section = "channels" | "catalog" | "nodes" | "pricing" | "experience";
const navigation = [
    { id: "channels", label: "渠道管理", note: "连接与读取", icon: Cable },
    { id: "catalog", label: "模型库", note: "所有渠道的模型", icon: Boxes },
    { id: "nodes", label: "节点模型", note: "分组、规格与上线", icon: ListTree },
    { id: "pricing", label: "价格管理", note: "集中维护同一份价格", icon: Tags },
    { id: "experience", label: "用户端预览", note: "选择模型与规格", icon: Clapperboard },
] as const;

/** Imported only by the isolated development harness; no production route or API adapter. */
export default function ManagementPreview() {
    const [section, setSection] = useState<Section>("nodes");
    const [assignCatalogId, setAssignCatalogId] = useState<string>();
    const store = useModelManagementPreview();
    const appearance = useThemeStore();
    const { token } = theme.useToken();
    const current = navigation.find(item => item.id === section)!;
    const publishedCount = store.assignments.filter(item => item.published).length;
    const counts = [store.channels.length, store.catalog.length, store.assignments.length, publishedCount];
    return <div style={{ background: token.colorBgLayout, color: token.colorText, minHeight: "100vh" }}>
        <div className="mx-auto max-w-[1440px] px-4 py-6 md:px-8">
            <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className="rounded-xl border p-3" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}><LayoutGrid size={22} /></div>
                    <div><Typography.Title level={3} className="!mb-1">模型管理工作台</Typography.Title><Typography.Text type="secondary">把渠道资源整理成用户能找到、看得懂价格的模型。</Typography.Text></div>
                </div>
                <div className="flex items-center gap-3"><Button onClick={() => appearance.setTheme(appearance.theme === "dark" ? "light" : "dark")}>切换明暗主题</Button><Tag color="gold" className="!m-0">交互预览 · 全部为模拟数据</Tag></div>
            </header>
            <Alert type="warning" showIcon className="!mb-6" title="这里可以完整试操作，刷新后恢复示例。不会连接供应商、收费或修改线上配置，请勿填写真实密钥。" />
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {["已接入渠道", "模型库条目", "已分配模型", "预览中已上线"].map((label, index) => <div key={label} className="rounded-xl border px-5 py-4" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}>
                    <div className="mb-1 text-xs" style={{ color: token.colorTextSecondary }}>{label}</div><div className="text-2xl font-semibold tabular-nums">{counts[index]}</div>
                </div>)}
            </div>
            <div className="grid items-start gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
                <nav aria-label="模型管理导航" className="flex gap-2 overflow-x-auto lg:sticky lg:top-4 lg:flex-col">
                    {navigation.map(item => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}
                        className="flex min-w-[155px] items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors"
                        style={{ borderColor: section === item.id ? token.colorBorder : "transparent", background: section === item.id ? token.colorBgContainer : "transparent", color: section === item.id ? token.colorText : token.colorTextSecondary }}>
                        <item.icon size={18} /><span><span className="block text-sm font-medium">{item.label}</span><span className="mt-1 block text-xs" style={{ color: token.colorTextTertiary }}>{item.note}</span></span>
                    </button>)}
                    <div className="hidden border-t px-4 pt-5 text-xs leading-6 lg:block" style={{ borderColor: token.colorBorderSecondary, color: token.colorTextTertiary }}>渠道 → 模型库 → 节点配置<br />定好价格，再确认上线。</div>
                </nav>
                <main className="min-w-0">
                    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                        <div><Typography.Title level={4} className="!mb-1">{current.label}</Typography.Title><Typography.Text type="secondary">{current.note}</Typography.Text></div>
                        {section !== "experience" && <Button onClick={() => setSection("experience")}>查看用户选模效果</Button>}
                    </div>
                    {section === "channels" && <ChannelPanel />}
                    {section === "catalog" && <CatalogPanel onAssign={(catalogId: string) => { setAssignCatalogId(catalogId); setSection("nodes"); }} />}
                    {section === "nodes" && <AssignmentPanel initialCatalogId={assignCatalogId} onCatalogConsumed={() => setAssignCatalogId(undefined)} onShowExperience={() => setSection("experience")} />}
                    {section === "pricing" && <PricingPanel />}
                    {section === "experience" && <NodeExperience />}
                </main>
            </div>
        </div>
    </div>;
}
