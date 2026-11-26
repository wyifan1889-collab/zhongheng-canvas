import { useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Space, Switch, Tag, Typography } from "antd";
import { ContentSafetyError, type ContentSafetyClient, type GenerationSafetyPolicy, type GenerationSafetyPolicyWrite, type GenerationSafetyPublication, type GenerationSafetySettings } from "@/services/saas/content-safety";

type Dimension = "ip" | "user";
export type GenerationSafetyDraft = Record<Dimension, { enabled: boolean; points: string }>;
const dimensions = ["ip", "user"] as const;
const labels = { ip: "IP", user: "用户" };
export function generationSafetyDraft(policy: GenerationSafetyPolicy): GenerationSafetyDraft {
    return { ip: { enabled: policy.ip.enabled, points: String(policy.ip.points) }, user: { enabled: policy.user.enabled, points: String(policy.user.points) } };
}
export function generationSafetyPeriod(duration: number): string {
    return duration === 3600 ? "1 小时周期（3600 秒）" : duration === 86400 ? "24 小时周期（86400 秒）" : `${duration} 秒周期（服务端配置）`;
}
export function buildGenerationSafetyWrite(config: GenerationSafetySettings, draft: GenerationSafetyDraft, operationId: string): GenerationSafetyPolicyWrite {
    const rate = (dimension: Dimension) => {
        const { enabled, points } = draft[dimension];
        if (typeof enabled !== "boolean" || !/^[1-9]\d*$/.test(points) || !Number.isSafeInteger(Number(points)) || Number(points) > 2_147_483_647) throw new Error("次数须为不超过 2147483647 的正安全整数；关闭维度请使用开关，不能填写 0。");
        return { enabled, points: Number(points) };
    };
    return { operationId, expectedRevision: config.revision, policy: { ip: rate("ip"), user: rate("user") } };
}
const current = (client: ContentSafetyClient) => { try { client.syncScope(); return true; } catch { return false; } };
const errorMessage = (error: unknown) => error instanceof ContentSafetyError ? error.message : "发布结果尚未确认，请保留原操作编号并核对。";

export default function GenerationSafetySettings({ client }: { client: ContentSafetyClient }) {
    const [config, setConfig] = useState<GenerationSafetySettings | null>(null), [draft, setDraft] = useState<GenerationSafetyDraft | null>(null);
    const [dirty, setDirty] = useState(false), [review, setReview] = useState(false), [busy, setBusy] = useState(false);
    const [error, setError] = useState(""), [notice, setNotice] = useState("");
    const [receipt, setReceipt] = useState<GenerationSafetyPublication | null>(null), [pending, setPending] = useState<ReturnType<ContentSafetyClient["getPendingSettingsOperation"]>>(null);
    const [confirmation, setConfirmation] = useState<GenerationSafetyPolicyWrite | null>(null), running = useRef(false);
    function applyConfiguration(value: GenerationSafetySettings, confirmed = receipt) {
        setConfig(value);
        if (!dirty || confirmed?.operationId === value.publicationId) { setDraft(generationSafetyDraft(value.policy)); setDirty(false); setReview(false); }
        else setReview(true);
    }
    async function read() {
        if (running.current || pending) return;
        running.current = true; setBusy(true); setError("");
        try {
            const value = await client.readSettings(); if (!current(client)) return;
            applyConfiguration(value); setNotice(dirty && receipt?.operationId !== value.publicationId ? "已读取实际设置，未保存的输入已保留；请核对后再决定是否按新版本发布。" : "已读取服务端实际设置；修改本地草稿不会立即生效。");
        } catch (failure) { if (current(client)) setError(errorMessage(failure)); }
        finally { running.current = false; if (current(client)) setBusy(false); }
    }
    async function completePublication(value: GenerationSafetyPublication) {
        if (!current(client)) return;
        setReceipt(value); setPending(null); setConfig(null);
        setNotice(`原发布回执已确认，版本 ${value.publishedRevision}；正在另行读取当前实际设置，旧回执不代表当前仍使用该版本。`);
        const actual = await client.readSettings(); if (!current(client)) return;
        applyConfiguration(actual, value);
        setNotice(actual.publicationId === value.operationId ? `原发布已确认，当前实际设置为版本 ${actual.revision}。` : `原发布版本 ${value.publishedRevision} 已确认；当前实际设置已是版本 ${actual.revision}，原输入已保留，请核对差异。`);
    }
    async function publish() {
        if (running.current || !confirmation || pending) return;
        running.current = true; setBusy(true); setError(""); setNotice("");
        try { await completePublication(await client.publishSettings(confirmation)); }
        catch (failure) {
            if (current(client)) { setError(errorMessage(failure)); setPending(client.getPendingSettingsOperation()); if (failure instanceof ContentSafetyError && failure.status === 409) setReview(true); }
        } finally { running.current = false; if (current(client)) { setBusy(false); setConfirmation(null); } }
    }
    async function reconcile() {
        if (running.current || !pending) return;
        running.current = true; setBusy(true); setError("");
        try { await completePublication(await client.readSettingsOperation(pending.operationId)); }
        catch (failure) { if (current(client)) { setError(errorMessage(failure)); setPending(client.getPendingSettingsOperation()); } }
        finally { running.current = false; if (current(client)) setBusy(false); }
    }
    const locked = busy || !!pending, needsRead = client.requiresSettingsRead();
    const update = (dimension: Dimension, value: Partial<GenerationSafetyDraft[Dimension]>) => { setDraft(previous => previous ? { ...previous, [dimension]: { ...previous[dimension], ...value } } : previous); setDirty(true); };
    return <Card title="生成请求限流设置">
        <Typography.Paragraph type="secondary">周期从首个成功受理的新任务开始计时，不按自然日零点重置；修改次数或关闭后再开启不会清空仍在运行的周期计数。报价、查询及原任务重放不新增次数。</Typography.Paragraph>
        <Space wrap className="mb-4"><Button loading={busy} onClick={() => void (pending ? reconcile() : read())}>{pending ? "查询原发布回执" : "读取实际设置"}</Button>
            {config && <><Tag>{config.source === "server-default" ? "服务端默认" : "已发布"}</Tag><Tag>最近读取版本 {config.revision}</Tag></>}
            {dirty && <Tag color="gold">本地修改未保存</Tag>}</Space>
        {error && <Alert className="mb-3" type="error" showIcon title={error} />}
        {notice && <Alert className="mb-3" type={review || needsRead ? "warning" : "info"} showIcon title={notice} />}
        {pending && <Alert className="mb-3" type="warning" showIcon title="原发布结果待核对" description={<div><p className="break-all">原操作编号：{pending.operationId}</p><p>只能按此编号查询回执；尚未查到不代表未发布，不能更换编号重发。原输入已保留。</p></div>} />}
        {receipt && <Alert className="mb-3" type="info" showIcon title={`原操作已确认发布版本 ${receipt.publishedRevision}`}
            description={<span className="break-all">回执：{receipt.operationId}；该回执是历史发布记录，当前设置另以下方可靠读取为准。</span>} />}
        {!config ? <Alert className="mb-4" type="info" showIcon title="当前实际设置尚未可靠读取；先读取并核对，空白表单不会自动发布。" /> : <div className="mb-4 rounded-lg border border-border p-3">
            <Typography.Title level={5}>最近一次可靠读取的实际设置</Typography.Title>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={dimensions.map(dimension => ({ key: dimension, label: `${labels[dimension]} 请求限流`, children: <span>{config.policy[dimension].enabled ? "开启" : "关闭"} · 每 {generationSafetyPeriod(config.policy[dimension].duration)} {config.policy[dimension].points} 次</span> }))} />
            <Typography.Paragraph className="!mt-3 !mb-1 break-all" type="secondary">正式发布编号：{config.publicationId ?? "尚未发布，使用服务端默认"}</Typography.Paragraph>
            <Typography.Paragraph className="!mb-1" type="secondary">平台日志记录：{config.checkpointMode === "record" ? "已开启（仅元数据，不表示审核通过）" : "未开启"}；内容审核由供应商处理。</Typography.Paragraph>
            <Typography.Paragraph className="!mb-1" type="secondary">模型限流（只读）：{config.modelRates.length ? "沿服务端实际配置，不随本次IP/用户设置变更。" : "当前未配置模型限流。"}</Typography.Paragraph>
            {config.modelRates.map(rule => <p key={rule.modelId} className="mb-1 break-all text-sm">{rule.modelId}：{rule.points} 次 / {rule.duration} 秒</p>)}
        </div>}
        {review && config && !needsRead && <Alert className="mb-4" type="warning" showIcon title="实际版本与本地草稿须重新核对" description={<div className="space-y-2"><p>读取不会覆盖未保存输入。请核对上方实际设置和下方本地草稿，再选择继续方式。</p>
            <Space wrap><Button disabled={locked} onClick={() => setReview(false)}>保留草稿，已核对当前版本</Button><Button disabled={locked} onClick={() => { setDraft(generationSafetyDraft(config.policy)); setDirty(false); setReview(false); }}>放弃草稿，采用实际设置</Button></Space></div>} />}
        {draft && <Form layout="vertical" className="mt-4">
            <Typography.Title level={5}>本地编辑草稿</Typography.Title>
            {dimensions.map(dimension => <div key={dimension} className="mb-4 rounded-lg border border-border p-3">
                <Form.Item label={`${labels[dimension]} 请求限流`} className="!mb-3"><Space wrap><Switch aria-label={`${labels[dimension]}请求限流开启`} checked={draft[dimension].enabled} disabled={locked} onChange={enabled => update(dimension, { enabled })} /><span>{draft[dimension].enabled ? "开启" : "关闭（该维度不限制）"}</span></Space></Form.Item>
                <Form.Item label={`${labels[dimension]}周期内最多请求次数`} required className="!mb-1"><Input aria-label={`${labels[dimension]}请求限流次数`} inputMode="numeric" value={draft[dimension].points} disabled={locked} onChange={event => update(dimension, { points: event.target.value })} /></Form.Item>
                <Typography.Text type="secondary">周期只读：{config ? generationSafetyPeriod(config.policy[dimension].duration) : "待重新读取服务端实际周期"}</Typography.Text>
            </div>)}
            <Button type="primary" disabled={locked || !config || !dirty || review || needsRead} onClick={() => {
                if (!config) return; setError("");
                try { setConfirmation(buildGenerationSafetyWrite(config, draft, crypto.randomUUID())); } catch (failure) { setError(failure instanceof Error ? failure.message : "请核对次数和开启状态。"); }
            }}>确认并发布限流设置</Button>
        </Form>}
        <Modal title="确认发布生成限流设置" open={!!confirmation} onCancel={() => { if (!busy) setConfirmation(null); }} onOk={() => void publish()} confirmLoading={busy}
            okText="确认发布" cancelText="取消" closable={!busy} maskClosable={!busy} cancelButtonProps={{ disabled: busy }} okButtonProps={{ disabled: busy || !!pending }}>
            <p>基于最近读取版本 {confirmation?.expectedRevision} 发布完整IP/用户设置；确认前不会生效。</p>
            {confirmation && config && dimensions.map(dimension => <p key={dimension}>{labels[dimension]}：{config.policy[dimension].enabled ? "开启" : "关闭"} / {config.policy[dimension].points} 次 → {confirmation.policy[dimension].enabled ? "开启" : "关闭"} / {confirmation.policy[dimension].points} 次；最近读取周期为 {generationSafetyPeriod(config.policy[dimension].duration)}。</p>)}
            <p>本页不修改周期，实际周期以服务端为准；关闭或改次数不清空已有周期计数。模型规则与日志模式保持服务端实际配置，本次不发送额外通知。</p>
        </Modal>
    </Card>;
}
