import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Descriptions, Input, Space, Spin, Table, Tag, Typography } from "antd";
import { useAccountStore } from "@/stores/use-account-store";
import TextUsageReview from "./TextUsageReview";
import AcceptedTaskPrice from "./AcceptedTaskPrice";
import {
    createAdminGenerationTaskReader, getAdminGenerationScope,
    type AdminGenerationReviewState, type AdminGenerationScope, type AdminGenerationTaskDetail,
} from "@/services/saas/platform";

const executionLabels = { pending: "等待处理", queued: "已排队", running: "生成中", succeeded: "生成成功", failed: "生成失败", unknown: "结果未知", cancelled: "已取消", timeout: "等待超时" };
const deliveryLabels = { pending: "待交付", saved: "已保存", visible: "已可查看", failed: "交付失败", unknown: "交付未知" };
const billingLabels = { unbilled: "未计费", reserved: "积分已冻结", captured: "已结算", released: "积分已退回", pending_review: "结算待核对" };
const reservationLabels = { pending: "冻结中", captured: "已扣除", released: "已释放", expired: "已过期" };
const ledgerLabels = { grant: "发放", recharge: "充值", adjustment: "人工调整", reserve: "冻结", capture: "结算", release: "释放", refund: "退款", consume: "扣除" };
const unitLabels = { request: "请求", input_token: "输入Token", output_token: "输出Token", second: "秒", megapixel: "百万像素", image: "张" };
const time = (value: string | null) => value === null ? "未记录" : new Date(value).toLocaleString();
const amount = (value: string | number | null) => value === null ? "未记录" : `${value} 积分`;
const delta = (value: string) => value === "0" || value.startsWith("-") ? value : `+${value}`;
const reason = (value: string | null | undefined) => value === "unrecognized_reason" ? "原因未识别（原始内容未展示）" : value ?? "未记录";

export default function GenerationTaskReview() {
    const account = useAccountStore(), scope = account.getDraftScope();
    const adminScope: AdminGenerationScope | null = account.user?.role === "admin" && scope ? { ...scope, role: "admin" } : null;
    return <ReviewPanel key={adminScope ? `${adminScope.accountId}:${adminScope.epoch}:admin` : "unavailable"} scope={adminScope} />;
}

function ReviewPanel({ scope }: { scope: AdminGenerationScope | null }) {
    const [input, setInput] = useState("");
    const [state, setState] = useState<AdminGenerationReviewState>({ status: "idle" });
    const reader = useRef<ReturnType<typeof createAdminGenerationTaskReader> | null>(null);
    useLayoutEffect(() => {
        if (!scope) return;
        const instance = createAdminGenerationTaskReader({ scope, getScope: getAdminGenerationScope, onState: setState });
        reader.current = instance;
        return () => { instance.close(); reader.current = null; };
    }, [scope?.accountId, scope?.epoch]);

    const detail = state.status === "ready" ? state.detail : null;
    return <Card title="生成任务核对" extra={<Tag>只读</Tag>}>
        <Typography.Paragraph type="secondary">输入用户提供的完整任务编号，手动读取该任务的执行、交付与积分记录。此处不会重新生成、退款或调整余额。</Typography.Paragraph>
        {!scope ? <Alert type="warning" showIcon title="管理员会话尚未确认，请重新登录后查询。" /> : <>
            <Space.Compact className="mb-4 w-full">
                <Input aria-label="生成任务编号" placeholder="完整任务编号（UUID）" value={input}
                    onChange={(event) => { reader.current?.clear(); setInput(event.target.value); }}
                    onPressEnter={() => { void reader.current?.query(input); }} />
                <Button type="primary" loading={state.status === "loading"} disabled={!input.trim()} onClick={() => { void reader.current?.query(input); }}>查询任务</Button>
            </Space.Compact>
            {state.status === "loading" ? <div role="status"><Spin size="small" /> 正在读取任务 {state.taskId}…</div> : null}
            {state.status === "error" ? <Alert type="error" showIcon title="任务查询未完成" description={state.message} /> : null}
            {detail ? <TaskDetail key={detail.task.id} detail={detail} scope={scope} /> : null}
        </>}
    </Card>;
}

export function TaskDetail({ detail, scope }: { detail: AdminGenerationTaskDetail; scope: AdminGenerationScope }) {
    const { task, result, reservation, ledger } = detail, held = reservation.details;
    const uncertain = ["unknown", "timeout"].includes(task.executionStatus) || task.deliveryStatus === "unknown" || task.billingStatus === "pending_review" || result?.status === "unknown";
    const missing = { none: "该任务未关联冻结记录", missing: "该任务关联的冻结记录缺失", mismatch: "该任务的冻结记录关联不一致" };
    return <Space orientation="vertical" className="w-full" size="middle">
        <Space wrap>
            <Tag>执行：{executionLabels[task.executionStatus]}</Tag>
            <Tag>交付：{deliveryLabels[task.deliveryStatus]}</Tag>
            <Tag>积分：{billingLabels[task.billingStatus]}</Tag>
        </Space>
        {uncertain ? <Alert type="warning" showIcon title="结果或结算仍待核对"
            description="请保留任务号核对原任务及账本；不能仅凭此状态再次扣费、退款或重新生成。" /> : null}
        <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: "id", label: "任务编号", children: <Typography.Text copyable>{task.id}</Typography.Text> },
            { key: "owner", label: "所属账号ID", children: task.ownerId },
            { key: "project", label: "画布ID", children: task.projectId ?? "未记录" },
            { key: "node", label: "节点ID", children: task.nodeId ?? "未记录" },
            { key: "model", label: "模型ID", children: task.modelId },
            { key: "quote", label: task.billingUnitSnapshot === "image" ? "确认预算" : "任务报价", children: amount(task.quotedUnits) },
            { key: "price", label: "价格版本", children: task.priceVersion ?? "未记录" },
            { key: "unit", label: "单价快照", children: task.creditsPerUnitSnapshot === null || task.billingUnitSnapshot === null ? "未记录" : `${task.creditsPerUnitSnapshot} 积分 / ${unitLabels[task.billingUnitSnapshot]}` },
            { key: "created", label: "创建时间", children: time(task.createdAt) },
            { key: "updated", label: "更新时间", children: time(task.updatedAt) },
            { key: "finished", label: "完成时间", children: time(task.finishedAt) },
            { key: "observed", label: "本次读取时间", children: time(detail.observedAt) },
        ]} />
        <Typography.Text>结果计量：{result?.consumedUnits === null || result?.consumedUnits === undefined ? "未记录" : `${result.consumedUnits} ${task.billingUnitSnapshot ? unitLabels[task.billingUnitSnapshot] : "（计量单位未记录）"}`}；实际扣除以冻结记录和账本为准。</Typography.Text>
        <Typography.Text type="secondary">任务原因：{reason(task.unknownReason)}；结果记录：{result ? executionLabels[result.status] : "未记录"}；错误码：{reason(result?.errorCode)}；结果原因：{reason(result?.unknownReason)}</Typography.Text>
        <AcceptedTaskPrice snapshot={detail.priceSnapshot} />
        {result?.textUsage != null ? <TextUsageReview scope={scope} modelId={task.modelId} usage={result.textUsage} /> : null}
        {held ? <Descriptions title="该任务的冻结记录" size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: "id", label: "记录编号", children: held.id }, { key: "status", label: "状态", children: reservationLabels[held.status] },
            { key: "requested", label: "请求冻结", children: amount(held.requestedUnits) }, { key: "remaining", label: "剩余冻结", children: amount(held.remainingUnits) },
            { key: "captured", label: "已扣除", children: amount(held.capturedUnits) }, { key: "released", label: "已释放", children: amount(held.releasedUnits) },
        ]} /> : <Alert type="warning" showIcon title={reservation.linkStatus === "linked" ? "冻结记录未完整返回" : missing[reservation.linkStatus]}
            description="缺失或不一致不等于冻结、扣除和释放均为0；请继续核对原始关联，不能据此调整积分。" />}
        <Typography.Text strong>该任务关联账本</Typography.Text>
        <Table size="small" rowKey="id" pagination={false} scroll={{ x: true }} dataSource={ledger}
            locale={{ emptyText: "未查到该任务的关联账本，不能据此推定扣费或冻结为0" }} columns={[
                { title: "流水编号", dataIndex: "id" },
                { title: "类型", dataIndex: "kind", render: (value: AdminGenerationTaskDetail["ledger"][number]["kind"]) => ledgerLabels[value] },
                { title: "可用积分实际增减", dataIndex: "deltaAvailableUnits", render: delta },
                { title: "冻结积分实际增减", dataIndex: "deltaReservedUnits", render: delta },
                { title: "时间", dataIndex: "createdAt", render: time },
            ]} />
        <Typography.Text type="secondary">这里展示该任务的记录快照，不代表账号当前总余额；记录状态与账本仍需一起核对。</Typography.Text>
    </Space>;
}
