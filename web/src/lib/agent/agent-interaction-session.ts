import type { AgentChatItem } from "@/stores/use-agent-store";
import {
    agentInteractionKey, agentInteractionScope, createAgentInteractionAutoConfirmController,
    mergeAgentInteractionViews, parseAgentInteraction, sameAgentInteractionScope,
    type AgentInteraction, type AgentInteractionDecision, type AgentInteractionScope, type AgentInteractionView,
} from "./agent-interactions";

export type AgentInteractionClientContext = {
    scope: AgentInteractionScope; endpoint: string; token: string; accountKey: string;
};

function sameContext(a: AgentInteractionClientContext, b: AgentInteractionClientContext | null) {
    return Boolean(b && a.endpoint === b.endpoint && a.token === b.token && a.accountKey === b.accountKey
        && sameAgentInteractionScope(a.scope, b.scope));
}

export function interactionView(value: unknown): AgentInteractionView | null {
    const raw = value && typeof value === "object" ? value as Record<string, unknown> : null;
    const record = parseAgentInteraction(raw?.record ?? value);
    // A tool result or disk history can identify a card, but never grant authority.
    return record ? { record, authoritative: false } : null;
}

export function interactionMessage(record: AgentInteraction, itemId = `interaction:${record.streamId}:${record.kind}:${record.id}`): AgentChatItem {
    const text = record.kind === "proposal" ? record.input.summary : record.kind === "question" ? record.input.question : record.input.description;
    return { id: `${record.threadId}:${record.sourceTurnId}:${itemId}`, itemId, threadId: record.threadId,
        turnId: record.sourceTurnId, role: "tool", text, interaction: { record, authoritative: false } };
}

/** Overlay process-authoritative records after every history/materialization merge. */
export function projectAgentInteractionMessages(messages: AgentChatItem[], views: readonly AgentInteractionView[], scope: AgentInteractionScope | null) {
    const visible = views.filter((view) => scope && sameAgentInteractionScope(agentInteractionScope(view.record), scope));
    const records = new Map(visible.map((view) => [agentInteractionKey(view.record), view]));
    const placed = new Set<string>();
    const result: AgentChatItem[] = [];
    for (const message of messages) {
        const historical = interactionView(message.interaction);
        if (!historical) { result.push(message); continue; }
        const record = historical.record;
        // Foreign ownership must never become an actionable card in this browser.
        if (!scope || record.ownerContext !== scope.ownerContext || record.sourceClientId !== scope.clientId
            || record.threadId !== scope.threadId || record.projectId !== scope.projectId) {
            continue;
        }
        const key = agentInteractionKey(record);
        if (placed.has(key)) continue;
        placed.add(key);
        const view = records.get(key) ?? historical;
        result.push({ ...message, interaction: view });
    }
    visible.forEach((view) => {
        if (!placed.has(agentInteractionKey(view.record))) {
            const next = { ...interactionMessage(view.record), interaction: view };
            const index = result.findIndex((item) => item.id === next.id);
            if (index < 0) result.push(next);
            else result[index] = next;
        }
    });
    return result;
}

type SessionOptions = {
    current: () => AgentInteractionClientContext | null;
    publish: (views: readonly AgentInteractionView[]) => void;
    list: (context: AgentInteractionClientContext) => Promise<unknown>;
    decide: (context: AgentInteractionClientContext, record: AgentInteraction, decision: AgentInteractionDecision) => Promise<unknown>;
};

/** One panel owns this memory. All decisions use the same guarded HTTP path. */
export function createAgentInteractionSession(options: SessionOptions) {
    let views: AgentInteractionView[] = [];
    let generation = 0;
    const auto = createAgentInteractionAutoConfirmController();
    const attempted = new Set<string>();
    const publish = () => options.publish(views);
    const currentRecord = (record: AgentInteraction) => views.find((view) => agentInteractionKey(view.record) === agentInteractionKey(record));
    const owns = (record: AgentInteraction, context: AgentInteractionClientContext | null) => Boolean(context
        && sameAgentInteractionScope(agentInteractionScope(record), context.scope));
    const upsert = (record: AgentInteraction) => {
        if (!owns(record, options.current())) return;
        views = mergeAgentInteractionViews(views, [{ record, authoritative: true }]);
        publish();
    };
    const snapshot = (input: unknown, readRevisions?: ReadonlyMap<string, number>) => {
        const context = options.current();
        const raw = input && typeof input === "object" ? input as Record<string, unknown> : null;
        if (!context || raw?.ok !== true || !Array.isArray(raw.interactions)) throw new Error("Invalid interaction snapshot");
        const records = raw.interactions.map(parseAgentInteraction);
        if (records.some((record) => !record)) throw new Error("Invalid interaction record");
        const incoming = records.filter((record): record is AgentInteraction => Boolean(record && owns(record, context)));
        auto.completeSnapshot(incoming);
        // A complete snapshot revokes any record absent from this Agent process.
        const available = new Set(incoming.map(agentInteractionKey));
        views = views.map((view) => {
            const key = agentInteractionKey(view.record), readRevision = readRevisions?.get(key);
            // A GET cannot revoke an item created or updated after that read began.
            const covered = !readRevisions || readRevision !== undefined && view.record.revision <= readRevision;
            return available.has(key) || !covered ? view : { ...view, authoritative: false };
        });
        views = mergeAgentInteractionViews(views, incoming.map((record) => ({ record, authoritative: true })));
        publish();
    };
    const reconcile = async () => {
        const context = options.current();
        if (!context) return;
        const revision = generation;
        const readRevisions = new Map(views.map((view) => [agentInteractionKey(view.record), view.record.revision]));
        const response = await options.list(context);
        if (revision !== generation || !sameContext(context, options.current())) return;
        snapshot(response, readRevisions);
    };
    const submit = async (record: AgentInteraction, decision: AgentInteractionDecision) => {
        const context = options.current(), view = currentRecord(record), key = agentInteractionKey(record);
        if (!context || !owns(record, context) || !view?.authoritative || view.record.revision !== record.revision
            || view.record.status !== "pending" || view.record.decision || view.submission || attempted.has(key)) return;
        attempted.add(key);
        const revision = generation;
        views = views.map((item) => agentInteractionKey(item.record) === key ? { ...item, submission: "submitting", error: undefined,
            ...(record.kind === "question" && "answer" in decision ? { answerDraft: decision.answer } : {}),
            ...(record.kind === "proposal" && "approved" in decision && !decision.approved ? { proposalReasonDraft: decision.reason ?? "" } : {}) } : item);
        publish();
        try {
            const response = await options.decide(context, record, decision);
            if (revision !== generation || !sameContext(context, options.current())) return;
            const raw = response && typeof response === "object" ? response as Record<string, unknown> : null;
            const accepted = parseAgentInteraction(raw?.interaction);
            if (raw?.ok !== true || !accepted || agentInteractionKey(accepted) !== key
                || !owns(accepted, context) || accepted.revision < record.revision || accepted.status === "pending"
                || record.kind === "question" && (accepted.kind !== "question" || !accepted.decision || !("answer" in decision)
                    || accepted.decision.answer !== decision.answer || accepted.sourceTurnId !== record.sourceTurnId)
                || record.kind === "proposal" && (accepted.kind !== "proposal" || !accepted.decision || !("approved" in decision)
                    || accepted.decision.approved !== decision.approved || accepted.decision.reason !== decision.reason || accepted.sourceTurnId !== record.sourceTurnId)) {
                throw new Error("Invalid interaction decision receipt");
            }
            upsert(accepted);
        } catch (error) {
            if (revision !== generation || !sameContext(context, options.current())) return;
            const detail = error instanceof Error ? error.message : String(error);
            views = views.map((item) => agentInteractionKey(item.record) === key && item.record.status === "pending"
                ? { ...item, submission: "unknown", error: detail } : item);
            publish();
            // Unknown writes are reconciled by GET only. Never dispatch the decision again.
            try { await reconcile(); } catch { /* Keep the unknown receipt visible for manual read-only reconciliation. */ }
        }
    };
    return {
        views: () => views,
        begin(scope: AgentInteractionScope, interactions: unknown) {
            generation++;
            views = views.map((view) => ({ ...view, authoritative: false }));
            auto.beginInitialization(scope);
            snapshot({ ok: true, interactions });
        },
        invalidate() { generation++; views = views.map((view) => ({ ...view, authoritative: false,
            submission: view.submission === "submitting" ? "unknown" : view.submission })); publish(); },
        completeReplay: (lastSeq: number) => auto.completeReplay(lastSeq),
        snapshot,
        upsert,
        created(event: { interaction: AgentInteraction; seq: number; replayed?: boolean }, enabled: boolean) {
            const context = options.current();
            if (!context || !owns(event.interaction, context)) return;
            const shouldConfirm = auto.takeCreated(event, context.scope, enabled);
            upsert(event.interaction);
            if (shouldConfirm) void submit(event.interaction, { confirmed: true, decisionSource: "auto" });
        },
        submit,
        reconcile,
    };
}
