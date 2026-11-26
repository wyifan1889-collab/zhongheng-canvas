export type AgentInteractionScope = {
    streamId: string;
    threadId: string;
    conversationId: string;
    clientId: string;
    ownerContext: string;
    projectId: string | null;
};
export type AgentInteractionDecision =
    | { approved: boolean; reason?: string; decisionSource?: "manual" | "auto" }
    | { answer: string }
    | { confirmed: boolean; decisionSource?: "manual" | "auto" };
type InteractionBase = Omit<AgentInteractionScope, "clientId"> & {
    id: string;
    sourceTurnId: string;
    sourceClientId: string;
    revision: number;
    status: "pending" | "queued" | "continuing" | "completed" | "expired" | "continuation_failed";
    continuationTurnId?: string;
    error?: string;
};
export type AgentInteraction = InteractionBase & (
    | { kind: "proposal"; input: { proposalId: string; summary: string; estimatedCost?: number; actions: string[] }; decision?: Extract<AgentInteractionDecision, { approved: boolean }> }
    | { kind: "question"; input: { questionId: string; question: string; placeholder?: string }; decision?: Extract<AgentInteractionDecision, { answer: string }> }
    | { kind: "generation_confirm"; input: { confirmId: string; description: string; estimatedCost: number }; decision?: Extract<AgentInteractionDecision, { confirmed: boolean }> }
);
export type AgentInteractionView = { record: AgentInteraction; authoritative: boolean; submission?: "submitting" | "unknown"; error?: string; answerDraft?: string; proposalReasonDraft?: string };
export type AgentInteractionEvent = { interaction: AgentInteraction; seq: number; replayed: boolean };

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const cost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const statuses = new Set(["pending", "queued", "continuing", "completed", "expired", "continuation_failed"]);
const toolKinds = {
    canvas_create_proposal: "proposal",
    canvas_ask_user: "question",
    canvas_request_generation_confirm: "generation_confirm",
} as const;

function parseInput(kind: AgentInteraction["kind"], value: unknown): AgentInteraction["input"] | null {
    const input = object(value);
    if (!input) return null;
    if (kind === "proposal") {
        if (!nonempty(input.proposalId) || !nonempty(input.summary) || !Array.isArray(input.actions) || !input.actions.every(nonempty)
            || input.estimatedCost !== undefined && !cost(input.estimatedCost)) return null;
        return { proposalId: input.proposalId, summary: input.summary, ...(input.estimatedCost === undefined ? {} : { estimatedCost: input.estimatedCost as number }), actions: [...input.actions] as string[] };
    }
    if (kind === "question") {
        if (!nonempty(input.questionId) || !nonempty(input.question) || !optionalString(input.placeholder)) return null;
        return { questionId: input.questionId, question: input.question, ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder as string }) };
    }
    if (!nonempty(input.confirmId) || !nonempty(input.description) || !cost(input.estimatedCost)) return null;
    return { confirmId: input.confirmId, description: input.description, estimatedCost: input.estimatedCost };
}

function parseDecision(kind: AgentInteraction["kind"], value: unknown): AgentInteractionDecision | null {
    const decision = object(value);
    if (!decision) return null;
    if (decision.decisionSource !== undefined && decision.decisionSource !== "manual" && decision.decisionSource !== "auto") return null;
    const source = decision.decisionSource === undefined ? {} : { decisionSource: decision.decisionSource as "manual" | "auto" };
    if (kind === "proposal") {
        if (typeof decision.approved !== "boolean" || !optionalString(decision.reason) || "answer" in decision || "confirmed" in decision) return null;
        return { approved: decision.approved, ...(decision.reason === undefined ? {} : { reason: decision.reason as string }), ...source };
    }
    if (kind === "question") {
        if (!nonempty(decision.answer) || "approved" in decision || "confirmed" in decision) return null;
        return { answer: decision.answer };
    }
    if (typeof decision.confirmed !== "boolean" || "approved" in decision || "answer" in decision) return null;
    return { confirmed: decision.confirmed, ...source };
}

/** Validate the complete authority DTO; text and model arguments never supply its scope. */
export function parseAgentInteraction(value: unknown): AgentInteraction | null {
    const record = object(value);
    if (!record || !nonempty(record.id) || !nonempty(record.streamId) || !nonempty(record.threadId) || !nonempty(record.conversationId)
        || !nonempty(record.sourceTurnId) || !nonempty(record.sourceClientId) || !nonempty(record.ownerContext)
        || record.projectId !== null && !nonempty(record.projectId) || !revision(record.revision)
        || typeof record.status !== "string" || !statuses.has(record.status)
        || record.continuationTurnId !== undefined && !nonempty(record.continuationTurnId) || !optionalString(record.error)
        || record.kind !== "proposal" && record.kind !== "question" && record.kind !== "generation_confirm") return null;
    const input = parseInput(record.kind, record.input);
    const idField = record.kind === "proposal" ? "proposalId" : record.kind === "question" ? "questionId" : "confirmId";
    if (!input || object(input)?.[idField] !== record.id) return null;
    const decision = record.decision === undefined ? undefined : parseDecision(record.kind, record.decision);
    if (decision === null) return null;
    return {
        id: record.id, kind: record.kind, input, streamId: record.streamId, threadId: record.threadId, conversationId: record.conversationId,
        sourceTurnId: record.sourceTurnId, sourceClientId: record.sourceClientId, projectId: record.projectId, ownerContext: record.ownerContext,
        revision: record.revision, status: record.status,
        ...(decision === undefined ? {} : { decision }),
        ...(record.continuationTurnId === undefined ? {} : { continuationTurnId: record.continuationTurnId }),
        ...(record.error === undefined ? {} : { error: record.error }),
    } as AgentInteraction;
}

function eventScopeMatches(event: Record<string, unknown>, record: AgentInteraction) {
    const threadId = event.threadId ?? event.thread_id, turnId = event.turnId ?? event.turn_id;
    return threadId === record.threadId && turnId === record.sourceTurnId && event.sourceClientId === record.sourceClientId
        && (event.threadId === undefined || event.threadId === record.threadId) && (event.thread_id === undefined || event.thread_id === record.threadId)
        && (event.turnId === undefined || event.turnId === record.sourceTurnId) && (event.turn_id === undefined || event.turn_id === record.sourceTurnId);
}

export function parseAgentInteractionEvent(value: unknown): AgentInteractionEvent | null {
    const event = object(value), record = parseAgentInteraction(event?.interaction);
    if (!event || !record || !revision(event.seq) || event.seq === 0 || event.replayed !== undefined && typeof event.replayed !== "boolean" || !eventScopeMatches(event, record)) return null;
    return { interaction: record, seq: event.seq, replayed: event.replayed === true };
}

/** Question aliases must describe the same scoped authority record as their envelope. */
export function parseAgentQuestionEvent(name: "agent_question" | "agent_question_answered", value: unknown): AgentInteractionEvent | null {
    const event = object(value), parsed = parseAgentInteractionEvent(value), record = parsed?.interaction;
    if (!event || !parsed || record?.kind !== "question" || event.ownerContext !== record.ownerContext || event.questionId !== record.id) return null;
    if (name === "agent_question" ? event.text !== record.input.question
        : record.status === "pending" || !record.decision || event.answer !== record.decision.answer) return null;
    return parsed;
}

export function parseAgentProposalEvent(name: "agent_proposal" | "agent_proposal_decided", value: unknown): AgentInteractionEvent | null {
    const event = object(value), parsed = parseAgentInteractionEvent(value), record = parsed?.interaction;
    if (!event || !parsed || record?.kind !== "proposal" || event.ownerContext !== record.ownerContext
        || event.proposalId !== record.id || event.summary !== record.input.summary) return null;
    if (name === "agent_proposal" ? event.estimatedCost !== record.input.estimatedCost
        : record.status === "pending" || !record.decision || event.approved !== record.decision.approved) return null;
    return parsed;
}

function parseJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
}

/** Only the exact successful Canvas MCP completion can place an interaction card. */
export function parseAgentInteractionToolCompletion(value: unknown): AgentInteraction | null {
    const event = object(value), item = object(event?.item);
    if (event?.type !== "item.completed" || item?.type !== "mcp_tool_call" || item.server !== "infinite-canvas" || !nonempty(item.id)
        || typeof item.tool !== "string" || !Object.prototype.hasOwnProperty.call(toolKinds, item.tool)
        || item.error != null || item.success === false || item.status !== undefined && item.status !== "completed") return null;
    const kind = toolKinds[item.tool as keyof typeof toolKinds], argumentsInput = parseInput(kind, parseJson(item.arguments));
    const result = object(item.result);
    if (!result || result.isError === true) return null;
    let body: Record<string, unknown> | null = result;
    if (result.content !== undefined) {
        if (!Array.isArray(result.content)) return null;
        const text = result.content.map((entry) => object(entry)?.text).filter((entry): entry is string => typeof entry === "string").join("\n");
        body = object(parseJson(text));
    }
    const record = parseAgentInteraction(body?.interaction);
    const idField = kind === "proposal" ? "proposalId" : kind === "question" ? "questionId" : "confirmId";
    if (!body || body.ok !== true || !nonempty(body.message) || !record || record.kind !== kind || body[idField] !== record.id
        || !argumentsInput || JSON.stringify(argumentsInput) !== JSON.stringify(record.input) || !eventScopeMatches(event, record)) return null;
    return record;
}

export function agentInteractionScope(record: AgentInteraction): AgentInteractionScope {
    return { streamId: record.streamId, threadId: record.threadId, conversationId: record.conversationId, clientId: record.sourceClientId, ownerContext: record.ownerContext, projectId: record.projectId };
}

export function sameAgentInteractionScope(a: AgentInteractionScope, b: AgentInteractionScope) {
    return a.streamId === b.streamId && a.threadId === b.threadId && a.conversationId === b.conversationId
        && a.clientId === b.clientId && a.ownerContext === b.ownerContext && a.projectId === b.projectId;
}

export function agentInteractionKey(record: AgentInteraction) {
    const scope = agentInteractionScope(record);
    return JSON.stringify([scope.streamId, scope.ownerContext, scope.clientId, scope.projectId, scope.threadId, scope.conversationId, record.kind, record.id]);
}

/** Authoritative records outrank tool/history hints; revisions cannot roll backwards. */
export function mergeAgentInteractionViews(current: readonly AgentInteractionView[], incoming: readonly AgentInteractionView[]): AgentInteractionView[] {
    const result = new Map(current.map((view) => [agentInteractionKey(view.record), view]));
    for (const next of incoming) {
        const key = agentInteractionKey(next.record), previous = result.get(key);
        if (!previous) { result.set(key, next); continue; }
        if (previous.authoritative && !next.authoritative || previous.authoritative === next.authoritative && next.record.revision < previous.record.revision
            || (previous.record.kind === "question" || previous.record.kind === "proposal") && previous.record.decision && next.record.revision < previous.record.revision) continue;
        const settled = next.authoritative && (next.record.status !== "pending" || next.record.decision !== undefined);
        result.set(key, {
            ...previous, ...next,
            submission: settled ? undefined : "submission" in next ? next.submission : previous.submission,
            error: settled ? next.error : "error" in next ? next.error : previous.error,
        });
    }
    return [...result.values()];
}

/** Only a fresh created event after the replay boundary may claim one automatic POST. */
export function createAgentInteractionAutoConfirmController() {
    let scope: AgentInteractionScope | null = null, initialized = false, watermark = 0;
    const observed = new Set<string>();
    return {
        beginInitialization(next: AgentInteractionScope) {
            scope = { ...next };
            initialized = false;
            watermark = 0;
        },
        completeReplay(lastSeq: number) {
            if (!scope || !revision(lastSeq) || lastSeq < watermark) return false;
            watermark = lastSeq;
            initialized = true;
            return true;
        },
        completeSnapshot(records: readonly AgentInteraction[]) {
            for (const record of records) if (scope && sameAgentInteractionScope(scope, agentInteractionScope(record))) observed.add(agentInteractionKey(record));
        },
        takeCreated(event: { interaction: AgentInteraction; seq: number; replayed?: boolean }, currentScope: AgentInteractionScope, enabled: boolean) {
            const { interaction: record, seq } = event;
            if (!scope || !sameAgentInteractionScope(scope, currentScope) || !sameAgentInteractionScope(scope, agentInteractionScope(record)) || !revision(seq) || seq === 0) return false;
            const key = agentInteractionKey(record), seen = observed.has(key), fresh = seq > watermark;
            observed.add(key);
            watermark = Math.max(watermark, seq);
            return initialized && fresh && !event.replayed && !seen && enabled && record.kind === "generation_confirm" && record.status === "pending" && record.decision === undefined;
        },
    };
}
