import { useEffect, useRef, useState } from "react";
import { theme as antdTheme } from "antd";
import { Button, Input } from "@/components/creation/ui";
import { CheckCircle2, ListChecks, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AgentInteractionCardProps } from "./agent-interaction-card";
import { InteractionFrame } from "./agent-interaction-frame";

export type AgentProposalCardProps = AgentInteractionCardProps & {
    proposalId: string;
    summary: string;
    estimatedCost?: number;
    onDecided: () => void;
};

export function AgentProposalCard({ proposalId, summary, estimatedCost, onDecided, ...props }: AgentProposalCardProps) {
    const { view, theme, onDecision } = props;
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const [reason, setReason] = useState(view.proposalReasonDraft ?? "");
    const [attempted, setAttempted] = useState(false);
    const submitted = useRef(false), notified = useRef(false);
    const record = view.record;
    const matches = record.kind === "proposal" && proposalId === record.id && summary === record.input.summary && estimatedCost === record.input.estimatedCost;
    const decided = matches && view.authoritative && record.status !== "pending" && typeof record.decision?.approved === "boolean";
    const editable = matches && view.authoritative && record.status === "pending" && !record.decision && !view.submission && !attempted && Boolean(onDecision);
    useEffect(() => {
        // A void dispatch cannot acknowledge a decision; wait for scoped authority.
        if (!decided || notified.current) return;
        notified.current = true;
        onDecided();
    }, [decided, onDecided]);
    if (!matches) return null;
    const submitting = attempted && !view.submission && !record.decision && record.status === "pending" && !view.error;
    const showReason = !record.decision && (editable || attempted || view.proposalReasonDraft !== undefined);
    const decide = (approved: boolean) => {
        if (!editable || submitted.current) return;
        submitted.current = true;
        setAttempted(true);
        onDecision?.(record, { approved, ...(!approved && reason.trim() ? { reason: reason.trim() } : {}) });
    };
    return (
        <InteractionFrame {...props} submitting={submitting} title={t("agent.interactions.proposalTitle")} icon={<ListChecks className="size-4" />}>
            <div className="whitespace-pre-wrap break-words text-sm leading-6">{summary}</div>
            {record.input.actions.length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-5" style={{ color: theme.node.muted }}>{record.input.actions.map((action, index) => <li key={index} className="whitespace-pre-wrap break-words">{action}</li>)}</ul> : null}
            {typeof estimatedCost === "number" ? <div className="mt-2 text-xs leading-5" style={{ color: theme.node.muted }}><div>{t("agent.interactions.estimatedCost", { cost: estimatedCost })}</div><div>{t("agent.interactions.estimateOnly")}</div></div> : null}
            {showReason ? <div className="mt-3 border-t pt-3" style={{ borderColor: theme.node.stroke }}><Input.TextArea aria-label={t("agent.interactions.reasonLabel")} placeholder={t("agent.interactions.reasonPlaceholder")} rows={2} value={reason} readOnly={!editable} onChange={(event) => setReason(event.target.value)} style={{ color: theme.node.text, background: "transparent" }} /></div> : null}
            {editable ? <div className="mt-2 flex flex-wrap justify-end gap-2"><Button type="text" icon={<X className="size-3.5" />} style={{ color: theme.node.muted }} onClick={() => decide(false)}>{t("agent.interactions.reject")}</Button><Button type="text" icon={<CheckCircle2 className="size-3.5" />} style={{ color: token.colorSuccess }} onClick={() => decide(true)}>{t("agent.interactions.approve")}</Button></div> : null}
        </InteractionFrame>
    );
}
