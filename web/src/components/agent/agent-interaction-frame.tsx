import type { ReactNode } from "react";
import { theme as antdTheme } from "antd";
import { Button } from "@/components/creation/ui";
import { useTranslation } from "react-i18next";
import type { AgentInteractionCardProps } from "./agent-interaction-card";

export function InteractionFrame({ view, theme, onReconcile, submitting, title, icon, children }: AgentInteractionCardProps & { submitting: boolean; title: string; icon: ReactNode; children: ReactNode }) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const record = view.record;
    const status = !view.authoritative ? "expired" : view.submission || (submitting ? "submitting" : record.status);
    const failed = status === "continuation_failed";
    const decision = record.decision;
    let decisionText = "";
    if (decision && "answer" in decision) decisionText = t("agent.interactions.answered", { answer: decision.answer });
    if (decision && "approved" in decision) decisionText = t(`agent.interactions.${decision.approved ? "approved" : "rejected"}`);
    if (decision && "confirmed" in decision) decisionText = t(`agent.interactions.${decision.confirmed ? decision.decisionSource === "auto" ? "autoConfirmed" : "confirmed" : "canceled"}`);
    return (
        <div className="min-w-0 rounded-xl border px-3 py-3" data-agent-interaction={record.kind} style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <div className="flex items-center gap-2 text-sm font-medium">
                <span className="shrink-0" style={{ color: theme.node.muted }}>{icon}</span>
                <span className="min-w-0 flex-1">{title}</span>
            </div>
            <div className="mt-2">{children}</div>
            {decisionText ? <div className="mt-3 whitespace-pre-wrap break-words text-xs leading-5" style={{ color: theme.node.muted }}>{decisionText}{decision && "reason" in decision && decision.reason ? <div>{t("agent.interactions.reason", { reason: decision.reason })}</div> : null}</div> : null}
            <div role="status" className="mt-2 text-xs leading-5" style={{ color: failed ? token.colorError : theme.node.muted }}>{t(`agent.interactions.status.${status}`)}</div>
            {view.error || record.error ? <div role="alert" className="mt-1 whitespace-pre-wrap break-words text-xs leading-5" style={{ color: token.colorError }}>{view.error || record.error}</div> : null}
            {status === "unknown" && onReconcile ? <Button type="text" size="small" className="mt-1" onClick={() => onReconcile(record)}>{t("agent.interactions.reconcile")}</Button> : null}
        </div>
    );
}
