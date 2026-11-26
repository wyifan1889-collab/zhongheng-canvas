import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography } from "antd";
import { useAccountStore } from "@/stores/use-account-store";
import { ContentSafetyError, createContentSafetyClient, type AbuseReportPage, type AbuseReportView, type ContentSafetyScope, type ModerationReceipt, type ModerationState, type ModerationWrite } from "@/services/saas/content-safety";
import GenerationSafetySettings from "./components/GenerationSafetySettings";

type SafetyClient = ReturnType<typeof createContentSafetyClient>;
function currentScope(): ContentSafetyScope | null {
    const account = useAccountStore.getState(), scope = account.getDraftScope();
    return scope && account.user ? { ...scope, role: account.user.role } : null;
}
const message = (error: unknown) => error instanceof ContentSafetyError ? error.message : "操作结果尚未确认，请保留原编号并核对。";
const live = (client: SafetyClient) => { try { client.syncScope(); return true; } catch { return false; } };

export default function ContentSafetyAdmin() {
    const account = useAccountStore(), scope = account.getDraftScope();
    return scope && account.user?.role === "admin"
        ? <SafetyAdminSession key={`${scope.accountId}:${scope.epoch}`} scope={{ ...scope, role: "admin" }} />
        : <Alert type="warning" showIcon title="需要有效的管理员会话" />;
}

function SafetyAdminSession({ scope }: { scope: ContentSafetyScope }) {
    const [client, setClient] = useState<SafetyClient | null>(null);
    useEffect(() => {
        const instance = createContentSafetyClient({ scope, getScope: currentScope, onAccountInvalidated: () => {
            const next = currentScope(); if (next?.accountId === scope.accountId && next.epoch === scope.epoch && next.role === scope.role) void useAccountStore.getState().refresh();
        } });
        setClient(instance); return () => instance.close();
    }, [scope.accountId, scope.epoch, scope.role]);
    if (!client) return <Spin size="small" />;
    return <section aria-label="内容安全与账户处置" className="space-y-4">
        <Alert type="info" showIcon title="内容审核由供应商处理，平台检查仅用于日志记录"
            description="IP与用户请求限流的实际设置、模型规则及日志模式以下方服务端读取结果为准；本地草稿不会立即生效。投诉和封禁在后台处理，不额外发送通知；受理记录不代表裁定、退款或处理时限承诺。" />
        <GenerationSafetySettings client={client} />
        <ModerationPanel client={client} scope={scope} />
        <ReportPanel client={client} />
    </section>;
}

function ModerationPanel({ client, scope }: { client: SafetyClient; scope: ContentSafetyScope }) {
    const [target, setTarget] = useState(""), [reason, setReason] = useState(""), [state, setState] = useState<ModerationState | null>(null);
    const [receipt, setReceipt] = useState<ModerationReceipt | null>(null), [pending, setPending] = useState<{ target: string; input: ModerationWrite } | null>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(""), [confirm, setConfirm] = useState(false);
    const running = useRef(false);
    async function read() {
        if (running.current || pending || !target.trim()) return;
        running.current = true; setBusy(true); setError(""); setState(null); setReceipt(null);
        try { const next = await client.readModeration(target.trim()); if (live(client)) setState(next); }
        catch (failure) { if (live(client)) setError(message(failure)); }
        finally { running.current = false; if (live(client)) setBusy(false); }
    }
    const accept = (value: ModerationReceipt) => {
        setReceipt(value); setPending(null); setState({ userId: value.targetUserId, disabled: value.disabled, moderationVersion: value.revision });
        setReason("");
        if (value.targetUserId === scope.accountId) void useAccountStore.getState().refresh();
    };
    async function save() {
        if (running.current || !state || pending || !reason.trim()) return;
        const attempt = { target: state.userId, input: { operationId: crypto.randomUUID(), disabled: !state.disabled, expectedVersion: state.moderationVersion, reason } };
        running.current = true; setBusy(true); setError(""); setPending(attempt); setReceipt(null);
        try { const value = await client.setModeration(attempt.target, attempt.input); if (live(client)) accept(value); }
        catch (failure) {
            if (live(client)) {
                setError(message(failure));
                if (failure instanceof ContentSafetyError && failure.outcome !== "unknown") { setPending(null); if (failure.status === 409) setState(null); }
            }
        } finally { running.current = false; if (live(client)) { setBusy(false); setConfirm(false); } }
    }
    async function reconcile() {
        if (running.current || !pending) return;
        running.current = true; setBusy(true); setError("");
        try {
            const value = await client.readModerationOperation(pending.input.operationId);
            if (value.targetUserId !== pending.target || value.disabled !== pending.input.disabled) throw new ContentSafetyError("read_failed", "原操作回执与当前记录不一致，请保留编号继续核对。");
            if (live(client)) accept(value);
        } catch (failure) { if (live(client)) setError(message(failure)); }
        finally { running.current = false; if (live(client)) setBusy(false); }
    }
    return <Card title="账户封禁与解封">
        <Typography.Paragraph type="secondary">输入准确账户 ID，先读取当前状态，再填写原因并确认操作；封禁会撤销该账户会话，解封后需重新登录。</Typography.Paragraph>
        <Space.Compact className="mb-4 w-full">
            <Input aria-label="处置账户ID" value={target} onChange={event => { setTarget(event.target.value); setState(null); setReceipt(null); }} disabled={busy || !!pending} onPressEnter={() => void read()} />
            <Button onClick={() => void read()} loading={busy} disabled={!target.trim() || !!pending}>读取状态</Button>
        </Space.Compact>
        {state && <div className="mb-4 space-y-3">
            <p className="break-all">账户：{state.userId} <Tag>{state.disabled ? "已封禁" : "正常"}</Tag><Tag>版本 {state.moderationVersion}</Tag></p>
            <Input.TextArea aria-label="账户处置原因" rows={3} value={reason} onChange={event => setReason(event.target.value)} disabled={busy || !!pending} placeholder="填写本次封禁或解封的具体原因" />
            <Button danger={!state.disabled} type="primary" disabled={busy || !!pending || !reason.trim()} onClick={() => setConfirm(true)}>{state.disabled ? "解封账户" : "封禁账户"}</Button>
        </div>}
        {error && <Alert className="mb-3" type="error" showIcon title={error} />}
        {pending && <Alert className="mb-3" type="warning" showIcon title="操作结果待核对" description={<div className="space-y-2"><p className="break-all">原操作编号：{pending.input.operationId}</p><p>请按原编号查询；尚未查到不代表未执行，不能直接重复操作。</p><Button disabled={busy} onClick={() => void reconcile()}>查询原操作</Button></div>} />}
        {receipt && <Alert type="success" showIcon title="原操作已确认" description={<span className="break-all">{receipt.disabled ? "封禁" : "解封"}回执：{receipt.operationId}；版本 {receipt.revision}。</span>} />}
        <Modal title={state?.disabled ? "确认解封账户" : "确认封禁账户"} open={confirm} onOk={() => void save()} onCancel={() => { if (!busy) setConfirm(false); }} confirmLoading={busy}
            okText="确认操作" cancelText="取消" closable={!busy} maskClosable={!busy} cancelButtonProps={{ disabled: busy }} okButtonProps={{ disabled: !state || !!pending || !reason.trim(), danger: !state?.disabled }}>
            <p className="break-all">账户：{state?.userId}</p><p>{state?.disabled ? "解封后需重新登录，旧会话不会恢复。" : "封禁后此账户不能继续使用平台，已有会话将失效；不自动撤销在途任务或退款。"}</p><p className="whitespace-pre-wrap break-words">原因：{reason}</p>
        </Modal>
    </Card>;
}

function ReportPanel({ client }: { client: SafetyClient }) {
    const [page, setPage] = useState<AbuseReportPage>({ items: [], nextCursor: null }), [loaded, setLoaded] = useState(false);
    const [filter, setFilter] = useState<"all" | "submitted" | "received">("all"), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const [pending, setPending] = useState<string | null>(null), [confirmed, setConfirmed] = useState<AbuseReportView | null>(null), running = useRef(false);
    async function load(cursor?: string) {
        if (running.current) return;
        running.current = true; setBusy(true); setError("");
        try { const next = await client.listReports({ ...(cursor ? { cursor } : {}), ...(filter === "all" ? {} : { status: filter }) }); if (live(client)) { setPage(next); setLoaded(true); } }
        catch (failure) { if (live(client)) setError(message(failure)); }
        finally { running.current = false; if (live(client)) setBusy(false); }
    }
    async function receive(item: AbuseReportView) {
        if (running.current || pending || item.status !== "submitted") return;
        running.current = true; setBusy(true); setError(""); setPending(item.id); setConfirmed(null);
        try { const next = await client.receiveReport(item.id, item.revision); if (live(client)) { setPending(null); setConfirmed(next); setPage(previous => ({ ...previous, items: previous.items.map(row => row.id === next.id ? next : row) })); } }
        catch (failure) { if (live(client)) { setError(message(failure)); if (failure instanceof ContentSafetyError && failure.outcome !== "unknown") setPending(null); } }
        finally { running.current = false; if (live(client)) setBusy(false); }
    }
    async function reconcile() {
        if (running.current || !pending) return;
        running.current = true; setBusy(true); setError("");
        try {
            const next = await client.readAdminReport(pending);
            if (live(client)) {
                setConfirmed(next); setPage(previous => ({ ...previous, items: previous.items.map(row => row.id === next.id ? next : row) }));
                if (next.status === "received") setPending(null); else setError("当前仍为已提交，原受理操作尚未确认，请保留编号继续查询。");
            }
        } catch (failure) { if (live(client)) setError(message(failure)); }
        finally { running.current = false; if (live(client)) setBusy(false); }
    }
    return <Card title="投诉受理">
        <Typography.Paragraph type="secondary">仅记录已收到投诉，不据此自动封禁、删除作品、退款或作出裁定。</Typography.Paragraph>
        <Space wrap className="mb-4"><Select aria-label="投诉状态" value={filter} disabled={busy} options={[{ value: "all", label: "全部状态" }, { value: "submitted", label: "已提交" }, { value: "received", label: "已受理" }]} onChange={value => { setFilter(value); setPage({ items: [], nextCursor: null }); setLoaded(false); }} />
            <Button loading={busy} onClick={() => void load()}>读取投诉</Button>
            <Button disabled={busy || !page.nextCursor} onClick={() => void load(page.nextCursor ?? undefined)}>下一页</Button></Space>
        {error && <Alert className="mb-3" type="error" showIcon title={error} />}
        {pending && <Alert className="mb-3" type="warning" showIcon title="受理结果待核对" description={<div className="space-y-2"><p className="break-all">原投诉编号：{pending}</p><Button disabled={busy} onClick={() => void reconcile()}>查询原投诉状态</Button></div>} />}
        {confirmed && <Typography.Paragraph role="status" className="break-all">已查询回执：{confirmed.id} · {confirmed.status === "received" ? "已受理" : "已提交"}</Typography.Paragraph>}
        <Table<AbuseReportView> rowKey="id" size="small" pagination={false} loading={busy} scroll={{ x: 850 }} dataSource={page.items}
            locale={{ emptyText: loaded ? "当前条件暂无投诉" : "请主动读取投诉列表" }} columns={[
                { title: "投诉编号", dataIndex: "id", width: 240, render: value => <span className="break-all">{value}</span> },
                { title: "主题", dataIndex: "subject", width: 180, render: value => <span className="break-words">{value}</span> },
                { title: "状态", dataIndex: "status", width: 100, render: value => <Tag>{value === "received" ? "已受理" : "已提交"}</Tag> },
                { title: "提交时间", dataIndex: "createdAt", width: 170, render: value => new Date(value).toLocaleString() },
                { title: "操作", width: 110, render: (_, item) => <Popconfirm title="记录已收到此投诉？" description="仅标记受理，不代表裁定或退款。" onConfirm={() => receive(item)} okText="确认受理" cancelText="取消" disabled={busy || !!pending || item.status !== "submitted"}>
                    <Button size="small" disabled={busy || !!pending || item.status !== "submitted"}>记录受理</Button></Popconfirm> },
            ]} expandable={{ expandedRowRender: item => <div className="space-y-2"><Typography.Paragraph className="whitespace-pre-wrap break-words">{item.details}</Typography.Paragraph>{item.receivedAt && <Typography.Text type="secondary">受理时间：{new Date(item.receivedAt).toLocaleString()}</Typography.Text>}</div> }} />
    </Card>;
}
