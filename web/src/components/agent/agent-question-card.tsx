import { useEffect, useRef, useState } from "react";
import { theme as antdTheme } from "antd";
import { Button, Input } from "@/components/creation/ui";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AgentInteractionCardProps } from "./agent-interaction-card";
import { InteractionFrame } from "./agent-interaction-frame";

export type AgentQuestionCardProps = AgentInteractionCardProps & {
    questionId: string;
    text: string;
    onAnswered: () => void;
};

export function AgentQuestionCard({ questionId, text, onAnswered, ...props }: AgentQuestionCardProps) {
    const { view, theme, onDecision } = props;
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const [answer, setAnswer] = useState(view.answerDraft ?? "");
    const [attempted, setAttempted] = useState(false);
    const submitted = useRef(false), notified = useRef(false);
    const record = view.record;
    const matches = record.kind === "question" && questionId === record.id && text === record.input.question;
    const answered = matches && view.authoritative && record.status !== "pending" && Boolean(record.decision?.answer.trim());
    const editable = matches && view.authoritative && record.status === "pending" && !record.decision && !view.submission && !attempted && Boolean(onDecision);
    useEffect(() => {
        // Dispatch is void; only a scoped authority receipt can acknowledge the answer.
        if (!answered || notified.current) return;
        notified.current = true;
        onAnswered();
    }, [answered, onAnswered]);
    if (!matches) return null;
    const submitting = attempted && !view.submission && !record.decision && record.status === "pending" && !view.error;
    const showDraft = !record.decision && (editable || attempted || view.submission || view.answerDraft !== undefined);
    const submit = () => {
        if (!editable || submitted.current || !answer.trim()) return;
        submitted.current = true;
        setAttempted(true);
        onDecision?.(record, { answer: answer.trim() });
    };
    return (
        <InteractionFrame {...props} submitting={submitting} title={t("agent.interactions.questionTitle")} icon={<CircleHelp className="size-4" />}>
            <div className="whitespace-pre-wrap break-words text-sm leading-6">{text}</div>
            {showDraft ? (
                <div className="mt-3 flex items-center gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                    <Input aria-label={t("agent.interactions.answerLabel")} placeholder={t("agent.interactions.answerPlaceholder")} value={answer} readOnly={!editable} onChange={(event) => setAnswer(event.target.value)} style={{ color: theme.node.text, background: "transparent" }} />
                    {editable ? <Button type="text" disabled={!answer.trim()} style={{ color: answer.trim() ? token.colorSuccess : undefined }} onClick={submit}>{t("agent.interactions.submitAnswer")}</Button> : null}
                </div>
            ) : null}
        </InteractionFrame>
    );
}
