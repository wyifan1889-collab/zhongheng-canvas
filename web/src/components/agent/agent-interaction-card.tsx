import { useRef, useState } from "react";
import { theme as antdTheme } from "antd";
import { Button } from "@/components/creation/ui";
import { CheckCircle2, CircleHelp, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AgentInteraction, AgentInteractionDecision, AgentInteractionView } from "@/lib/agent/agent-interactions";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { InteractionFrame } from "./agent-interaction-frame";
import { AgentQuestionCard } from "./agent-question-card";
import { AgentProposalCard } from "./agent-proposal-card";

export type AgentInteractionCardProps = {
    view: AgentInteractionView;
    theme: CanvasTheme;
    onDecision?: (record: AgentInteraction, decision: AgentInteractionDecision) => void;
    onReconcile?: (record: AgentInteraction) => void;
};

export function AgentInteractionCard(props: AgentInteractionCardProps) {
    const record = props.view.record;
    const [answeredKey, setAnsweredKey] = useState<string | null>(null);
    const [decidedKey, setDecidedKey] = useState<string | null>(null);
    const { t } = useTranslation();
    const key = JSON.stringify([record.streamId, record.threadId, record.conversationId, record.sourceTurnId, record.sourceClientId, record.ownerContext, record.projectId, record.kind, record.id]);
    if (record.kind === "proposal") return <AgentProposalCard key={key} {...props} proposalId={record.id} summary={record.input.summary} estimatedCost={record.input.estimatedCost} onDecision={decidedKey === key ? undefined : props.onDecision} onDecided={() => setDecidedKey(key)} />;
    if (record.kind === "question") return answeredKey === key
        ? <InteractionFrame {...props} submitting={false} title={t("agent.interactions.questionTitle")} icon={<CircleHelp className="size-4" />}><div className="whitespace-pre-wrap break-words text-sm leading-6">{record.input.question}</div></InteractionFrame>
        : <AgentQuestionCard key={key} {...props} questionId={record.id} text={record.input.question} onAnswered={() => setAnsweredKey(key)} />;
    return <AgentGenerationConfirmCard key={key} {...props} />;
}

export function AgentGenerationConfirmCard(props: AgentInteractionCardProps) {
    if (props.view.record.kind !== "generation_confirm") return null;
    return <AgentDecisionCard {...props} />;
}

function useDecision({ view, onDecision }: AgentInteractionCardProps) {
    const [attempted, setAttempted] = useState(false);
    const submitted = useRef(false);
    const editable = view.authoritative && view.record.status === "pending" && !view.record.decision && !view.submission && !attempted && Boolean(onDecision);
    return {
        editable,
        submit: (decision: AgentInteractionDecision) => {
            if (!editable || submitted.current) return;
            submitted.current = true;
            setAttempted(true);
            onDecision?.(view.record, decision);
        },
        submitting: attempted && !view.submission && !view.record.decision && view.record.status === "pending" && !view.error,
    };
}

function AgentDecisionCard(props: AgentInteractionCardProps) {
    const { view, theme } = props;
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const { editable, submit, submitting } = useDecision(props);
    const record = view.record;
    if (record.kind !== "generation_confirm") return null;
    const cost = record.input.estimatedCost;
    const decide = (confirmed: boolean) => submit({ confirmed, decisionSource: "manual" });
    return (
        <InteractionFrame {...props} submitting={submitting} title={t("agent.interactions.generationTitle")} icon={<Sparkles className="size-4" />}>
            <div className="whitespace-pre-wrap break-words text-sm leading-6">{record.input.description}</div>
            {typeof cost === "number" ? (
                <div className="mt-2 text-xs leading-5" style={{ color: theme.node.muted }}>
                    <div>{t("agent.interactions.estimatedCost", { cost })}</div>
                    <div>{t("agent.interactions.estimateOnly")}</div>
                </div>
            ) : null}
            {editable ? (
                <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button type="text" icon={<X className="size-3.5" />} style={{ color: theme.node.muted }} onClick={() => decide(false)}>{t("agent.interactions.cancelGeneration")}</Button>
                        <Button type="text" icon={<CheckCircle2 className="size-3.5" />} style={{ color: token.colorSuccess }} onClick={() => decide(true)}>{t("agent.interactions.confirmGeneration")}</Button>
                    </div>
                </div>
            ) : null}
        </InteractionFrame>
    );
}
