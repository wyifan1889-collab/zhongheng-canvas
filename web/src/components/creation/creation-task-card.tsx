import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/creation/ui";
import { formatDuration } from "@/lib/image-utils";
import type { CreationTaskProjection } from "@/services/saas/creation-task-projection";

const executionLabels: Record<CreationTaskProjection["executionStatus"], string> = {
    pending: "已提交，等待处理",
    queued: "排队中",
    running: "生成中",
    succeeded: "生成完成",
    failed: "生成失败",
    unknown: "结果待核对",
    cancelled: "已取消",
    timeout: "结果待核对",
};
const billingLabels: Record<CreationTaskProjection["billingStatus"], string> = {
    unbilled: "未计费",
    reserved: "积分已冻结",
    captured: "积分已结算",
    released: "冻结积分已退回",
    pending_review: "费用待核对",
};

export function CreationTaskCard({ task, busy = false, onRefresh, onOpenHistory }: { task: CreationTaskProjection; busy?: boolean; onRefresh?: () => void; onOpenHistory?: () => void }) {
    const [now, setNow] = useState(() => Date.now());
    const active = task.executionStatus === "pending" || task.executionStatus === "queued" || task.executionStatus === "running";
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active, task.submittedAt]);
    const elapsed = formatDuration(Math.max(0, (active ? now : task.updatedAt) - task.submittedAt));
    const status = executionLabels[task.executionStatus];
    return (
        <article aria-label="创作任务状态" className="rounded-xl border border-border/70 bg-card/80 p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                        {active ? <LoaderCircle aria-hidden className="size-4 animate-spin text-primary" /> : null}
                        <span>{status}</span>
                        {active ? <span className="text-muted-foreground">已用 {elapsed}</span> : null}
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                        任务 {task.taskId} · 模型 {task.modelId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        报价 {task.quotedUnits} 积分 · {billingLabels[task.billingStatus]}
                    </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    {onRefresh ? (
                        <Button size="small" variant="outlined" loading={busy} disabled={busy} icon={<RefreshCw className="size-3.5" />} onClick={onRefresh}>
                            查询原任务
                        </Button>
                    ) : null}
                    {onOpenHistory ? (
                        <Button size="small" variant="text" disabled={busy} onClick={onOpenHistory}>
                            查看历史
                        </Button>
                    ) : null}
                </div>
            </div>
            {task.executionStatus === "unknown" || task.executionStatus === "timeout" || task.billingStatus === "pending_review" ? <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">结果或费用待核对，只读取原任务，不会重复生成。</p> : null}
            {task.executionStatus === "failed" && task.billingStatus === "released" ? <p className="mt-3 text-xs text-muted-foreground">本次生成失败，冻结积分已按任务结果退回。</p> : null}
        </article>
    );
}
