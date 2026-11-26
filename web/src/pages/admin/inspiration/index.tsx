import { useLayoutEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Empty, Input, Select, Space, Tag, Typography } from "antd";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";

import { createAdminInspirationClient, type InspirationItem } from "@/services/saas/inspiration";
import { getAdminGenerationScope } from "@/services/saas/platform";
import { useAccountStore } from "@/stores/use-account-store";
import { createInspirationEditor, emptyInspirationEditor } from "./editor";

const types = [{ value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }];
const label = (type: InspirationItem["type"]) => types.find(item => item.value === type)?.label ?? type;

export default function InspirationAdmin() {
    const { modal } = App.useApp();
    const scopeKey = useAccountStore(() => { const scope = getAdminGenerationScope(); return scope ? `${scope.accountId}:${scope.epoch}` : ""; });
    const [state, setState] = useState(emptyInspirationEditor);
    const controller = useRef<ReturnType<typeof createInspirationEditor> | null>(null);
    useLayoutEffect(() => {
        setState(emptyInspirationEditor());
        if (!scopeKey) return;
        const owner = createInspirationEditor({ client: createAdminInspirationClient(getAdminGenerationScope), getScope: getAdminGenerationScope, onState: setState });
        controller.current = owner;
        void owner.read();
        return () => { owner.close(); if (controller.current === owner) controller.current = null; };
    }, [scopeKey]);
    if (!scopeKey) return null;
    const busy = state.phase === "loading" || state.phase === "saving", editable = state.phase === "ready" && Boolean(state.baseline);
    const update = (index: number, patch: Partial<InspirationItem>) => controller.current?.edit(state.items.map((item, i) => i === index ? { ...item, ...patch } : item));
    const move = (index: number, offset: number) => {
        const items = [...state.items], target = index + offset;
        if (target < 0 || target >= items.length) return;
        [items[index], items[target]] = [items[target], items[index]];
        controller.current?.edit(items);
    };
    const save = () => {
        const owner = controller.current;
        if (!owner || !editable || !state.dirty) return;
        if (state.items.length) { void owner.save(); return; }
        const snapshot = owner.getState();
        modal.confirm({ title: "撤下全部公开灵感？", content: "保存空列表后，灵感广场将不再展示预置内容。", okText: "确认撤下全部", cancelText: "保留编辑", onOk: () => {
            if (controller.current === owner && owner.getState() === snapshot) return owner.save();
        } });
    };
    return <Card title="灵感广场预置" extra={<Link to="/inspiration">查看公开广场</Link>}>
        <Space orientation="vertical" size="middle" className="w-full">
            <Typography.Paragraph type="secondary" className="!mb-0">由管理员维护公开灵感，不接收用户投稿。保存后标题、提示词、标签和封面地址会公开展示；封面只填写管理员确认可公开访问的图片 URL，不引用用户素材或私有生成结果。</Typography.Paragraph>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Space wrap><Tag>{state.items.length} 条灵感</Tag>{state.baseline && <Tag>已读取版本 {state.baseline.revision}</Tag>}{state.dirty && <Tag color="gold">编辑未保存</Tag>}</Space>
                <Space wrap>
                    <Button loading={state.phase === "loading"} disabled={busy} onClick={() => void controller.current?.read()}>{state.dirty || state.phase === "check-required" ? "核对服务器列表" : "重新读取"}</Button>
                    <Button disabled={!editable} icon={<Plus className="size-4" />} onClick={() => controller.current?.edit([...state.items, { id: crypto.randomUUID(), type: "image", title: "", prompt: "", imageUrl: "", tags: [] }])}>添加灵感</Button>
                    <Button disabled={!editable || !state.dirty} onClick={() => controller.current?.discardDraft()}>撤销本次编辑</Button>
                    <Button type="primary" loading={state.phase === "saving"} disabled={!editable || !state.dirty} onClick={save}>保存并公开列表</Button>
                </Space>
            </div>
            <Alert showIcon type={state.phase === "check-required" ? "warning" : state.phase === "error" ? "error" : "info"} title={state.notice} />
            {state.verification && <div className="space-y-3 rounded-xl border border-border p-4">
                <Typography.Text strong>服务器版本 {state.verification.revision} · {state.verification.items.length} 条</Typography.Text>
                <div className="max-h-80 space-y-3 overflow-y-auto">
                    {state.verification.items.map(item => <div key={item.id} className="space-y-1 border-b border-border pb-3 last:border-0 last:pb-0">
                        <div className="flex flex-wrap items-center gap-2"><Tag>{label(item.type)}</Tag><strong>{item.title}</strong><Typography.Text type="secondary" className="break-all text-xs">{item.id}</Typography.Text></div>
                        <p className="whitespace-pre-wrap break-words text-sm">{item.prompt}</p>
                        <p className="break-all text-xs text-muted-foreground">封面：{item.imageUrl || "未设置"}</p>
                        <div>{item.tags.map((tag, index) => <Tag key={`${index}:${tag}`}>{tag}</Tag>)}</div>
                    </div>)}
                    {!state.verification.items.length && <Typography.Text type="secondary">服务器列表为空。</Typography.Text>}
                </div>
                <Space wrap><Button onClick={() => controller.current?.adoptVerified()}>采用服务器列表，替换当前编辑</Button><Button type="primary" onClick={() => controller.current?.keepDraft()}>保留本机编辑，使用已核对版本继续</Button></Space>
            </div>}
            <div className="space-y-4">
                {state.items.map((item, index) => <section key={item.id} aria-label={`编辑灵感 ${index + 1}`} className="rounded-xl border border-border p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0"><strong>灵感 {index + 1}</strong><Typography.Text type="secondary" className="ml-3 break-all text-xs">ID：{item.id}</Typography.Text></div>
                        <Space size="small"><Button size="small" aria-label={`上移灵感 ${index + 1}`} disabled={!editable || index === 0} icon={<ArrowUp className="size-3.5" />} onClick={() => move(index, -1)} /><Button size="small" aria-label={`下移灵感 ${index + 1}`} disabled={!editable || index === state.items.length - 1} icon={<ArrowDown className="size-3.5" />} onClick={() => move(index, 1)} /><Button size="small" danger disabled={!editable} icon={<Trash2 className="size-3.5" />} onClick={() => controller.current?.edit(state.items.filter((_, i) => i !== index))}>移除</Button></Space>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                        <label className="space-y-1 text-sm"><span>创作类型</span><Select className="w-full" aria-label={`灵感 ${index + 1} 类型`} value={item.type} disabled={!editable} options={types} onChange={(type: InspirationItem["type"]) => update(index, { type })} /></label>
                        <label className="space-y-1 text-sm"><span>标题（必填）</span><Input aria-label={`灵感 ${index + 1} 标题`} aria-required value={item.title} disabled={!editable} onChange={event => update(index, { title: event.target.value })} /></label>
                    </div>
                    <label className="mt-3 block space-y-1 text-sm"><span>提示词（必填）</span><Input.TextArea aria-label={`灵感 ${index + 1} 提示词`} aria-required value={item.prompt} disabled={!editable} autoSize={{ minRows: 3, maxRows: 10 }} onChange={event => update(index, { prompt: event.target.value })} /></label>
                    <label className="mt-3 block space-y-1 text-sm"><span>管理员确认可公开访问的图片 URL（必填）</span><Input aria-label={`灵感 ${index + 1} 公开封面 URL`} aria-required value={item.imageUrl} disabled={!editable} placeholder="https://… 或 /inspiration-assets/…" onChange={event => update(index, { imageUrl: event.target.value })} /></label>
                    <label className="mt-3 block space-y-1 text-sm"><span>标签</span><Select mode="tags" className="w-full" aria-label={`灵感 ${index + 1} 标签`} value={item.tags} disabled={!editable} placeholder="输入标签后按回车" onChange={tags => update(index, { tags })} /></label>
                </section>)}
                {!state.items.length && state.baseline && !busy && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无预置灵感，可添加后保存公开列表。" />}
            </div>
        </Space>
    </Card>;
}
