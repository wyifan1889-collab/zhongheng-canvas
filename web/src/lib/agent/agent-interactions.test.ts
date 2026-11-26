import { expect, test } from "bun:test";
import {
    agentInteractionKey, agentInteractionScope, createAgentInteractionAutoConfirmController, mergeAgentInteractionViews,
    parseAgentInteraction, parseAgentInteractionEvent, parseAgentInteractionToolCompletion, parseAgentProposalEvent, parseAgentQuestionEvent, sameAgentInteractionScope,
    type AgentInteraction, type AgentInteractionScope, type AgentInteractionView,
} from "./agent-interactions";

const proposal = (): Extract<AgentInteraction, { kind: "proposal" }> => ({
    id: "proposal-1", kind: "proposal", input: { proposalId: "proposal-1", summary: "Create a scene", estimatedCost: 0, actions: ["Place the scene"] },
    streamId: "stream-1", threadId: "thread-1", conversationId: "conversation-1", sourceTurnId: "turn-1", sourceClientId: "client-1",
    ownerContext: "account-1", projectId: "project-1", revision: 0, status: "pending",
});
const question = (): Extract<AgentInteraction, { kind: "question" }> => ({ ...proposal(), id: "question-1", kind: "question", input: { questionId: "question-1", question: "Which scene?", placeholder: "A forest" }, decision: undefined });
const generation = (id = "confirm-1"): Extract<AgentInteraction, { kind: "generation_confirm" }> => ({ ...proposal(), id, kind: "generation_confirm", input: { confirmId: id, description: "Generate the scene", estimatedCost: 3.5 }, decision: undefined });
const envelope = (interaction: AgentInteraction = proposal()) => ({ interaction, seq: 1, threadId: interaction.threadId, turnId: interaction.sourceTurnId, sourceClientId: interaction.sourceClientId });
const questionEnvelope = (interaction = question()) => ({ ...envelope(interaction), ownerContext: interaction.ownerContext,
    questionId: interaction.id, text: interaction.input.question, answer: interaction.decision?.answer });
const proposalEnvelope = (interaction = proposal()) => ({ ...envelope(interaction), ownerContext: interaction.ownerContext,
    proposalId: interaction.id, summary: interaction.input.summary, estimatedCost: interaction.input.estimatedCost, approved: interaction.decision?.approved });
const toolCompletion = (interaction: AgentInteraction = proposal(), textResult = true) => {
    const tool = interaction.kind === "proposal" ? "canvas_create_proposal" : interaction.kind === "question" ? "canvas_ask_user" : "canvas_request_generation_confirm";
    const idField = interaction.kind === "proposal" ? "proposalId" : interaction.kind === "question" ? "questionId" : "confirmId";
    const body = { ok: true, [idField]: interaction.id, message: "Request created", interaction };
    return { ...envelope(interaction), type: "item.completed", item: { id: "tool-item-1", type: "mcp_tool_call", server: "infinite-canvas", tool,
        status: "completed", arguments: interaction.input, result: textResult ? { content: [{ type: "text", text: JSON.stringify(body) }] } : body } };
};
const view = (record: AgentInteraction = proposal(), authoritative = true): AgentInteractionView => ({ record, authoritative });

test("three DTO variants preserve original scope and allow finite zero estimates and local mode", () => {
    for (const record of [proposal(), question(), generation()]) expect(parseAgentInteraction(record)).toEqual(record);
    const local = { ...proposal(), projectId: null, ownerContext: "local" };
    expect(parseAgentInteraction(local)).toEqual(local);
    const input = { proposalId: "proposal-1", summary: "No estimate", actions: [] };
    expect(parseAgentInteraction({ ...proposal(), input })?.input).toEqual(input);
});

test("DTO rejects missing scope, ambiguous projects, unknown statuses and unsafe revisions", () => {
    for (const field of ["id", "streamId", "threadId", "conversationId", "sourceTurnId", "sourceClientId", "ownerContext"]) {
        for (const invalid of [undefined, null, 1, "", "  "]) expect(parseAgentInteraction({ ...proposal(), [field]: invalid })).toBeNull();
    }
    for (const projectId of [undefined, 1, false, "", " "]) expect(parseAgentInteraction({ ...proposal(), projectId })).toBeNull();
    for (const revision of [undefined, "1", -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(parseAgentInteraction({ ...proposal(), revision })).toBeNull();
    for (const status of [undefined, "approved", "unknown", 1]) expect(parseAgentInteraction({ ...proposal(), status })).toBeNull();
    for (const value of [null, [], "proposal", {}, { ...proposal(), kind: "codex_approval" }]) expect(parseAgentInteraction(value)).toBeNull();
});

test("tool inputs require matching identifiers, nonempty text, actual booleans and numeric costs", () => {
    for (const record of [proposal(), question(), generation()]) expect(parseAgentInteraction({ ...record, id: "other" })).toBeNull();
    for (const estimatedCost of [-1, "3", NaN, Infinity, null]) {
        expect(parseAgentInteraction({ ...generation(), input: { ...generation().input, estimatedCost } })).toBeNull();
        expect(parseAgentInteraction({ ...proposal(), input: { ...proposal().input, estimatedCost } })).toBeNull();
    }
    expect(parseAgentInteraction({ ...generation(), input: { confirmId: "confirm-1", description: "Generate" } })).toBeNull();
    expect(parseAgentInteraction({ ...proposal(), input: { proposalId: "proposal-1", summary: " ", actions: [] } })).toBeNull();
    for (const actions of [undefined, "action", [""], [" "] , [1]]) expect(parseAgentInteraction({ ...proposal(), input: { ...proposal().input, actions } })).toBeNull();
    expect(parseAgentInteraction({ ...question(), input: { ...question().input, placeholder: false } })).toBeNull();
});

test("decisions are kind-specific and do not accept string truthiness or another permission domain", () => {
    expect(parseAgentInteraction({ ...proposal(), decision: { approved: false, reason: "Change the plan" } })?.decision).toEqual({ approved: false, reason: "Change the plan" });
    expect(parseAgentInteraction({ ...question(), decision: { answer: "Forest" } })?.decision).toEqual({ answer: "Forest" });
    expect(parseAgentInteraction({ ...generation(), decision: { confirmed: true, decisionSource: "auto" } })?.decision).toEqual({ confirmed: true, decisionSource: "auto" });
    for (const decision of [null, "accept", { approved: "true" }, { approved: true, reason: 1 }, { confirmed: true }, { approved: true, answer: "x" }]) expect(parseAgentInteraction({ ...proposal(), decision })).toBeNull();
    for (const answer of ["", " ", false]) expect(parseAgentInteraction({ ...question(), decision: { answer } })).toBeNull();
    for (const decision of [{ confirmed: "true" }, { confirmed: true, decisionSource: "full" }, { confirmed: true, approved: true }]) expect(parseAgentInteraction({ ...generation(), decision })).toBeNull();
});

test("exact three successful MCP completions support JSON content and direct result envelopes", () => {
    for (const record of [proposal(), question(), generation()]) {
        expect(parseAgentInteractionToolCompletion(toolCompletion(record))).toEqual(record);
        const event = toolCompletion(record, false);
        event.item.arguments = JSON.stringify(record.input) as unknown as typeof event.item.arguments;
        expect(parseAgentInteractionToolCompletion(event)).toEqual(record);
    }
});

test("MCP matching never accepts names containing the expected tool or another server", () => {
    const valid = toolCompletion();
    for (const tool of ["prefix_canvas_create_proposal", "canvas_create_proposal_suffix", "canvas_create_proposal\n", "constructor", "canvas_ask_user_extra"]) {
        expect(parseAgentInteractionToolCompletion({ ...valid, item: { ...valid.item, tool } })).toBeNull();
    }
    for (const item of [{ ...valid.item, server: "other-infinite-canvas" }, { ...valid.item, type: "dynamic_tool_call" }, { ...valid.item, id: "" }, { ...valid.item, error: { message: "failed" } }, { ...valid.item, status: "failed" }]) expect(parseAgentInteractionToolCompletion({ ...valid, item })).toBeNull();
    expect(parseAgentInteractionToolCompletion({ ...valid, type: "item.started" })).toBeNull();
    expect(parseAgentInteractionToolCompletion({ ...valid, type: "tool_call" })).toBeNull();
});

test("MCP output must be valid JSON with literal ok, matching IDs, input and original event scope", () => {
    const valid = toolCompletion(proposal(), false), body = valid.item.result as Record<string, unknown>;
    for (const result of [{ ...body, ok: "true" }, { ...body, ok: false }, { ...body, proposalId: "different" }, { ...body, message: "" }, { ...body, interaction: generation() }, { content: [{ type: "text", text: "{bad" }] }, { content: "bad" }, { isError: true, content: [] }]) expect(parseAgentInteractionToolCompletion({ ...valid, item: { ...valid.item, result } })).toBeNull();
    expect(parseAgentInteractionToolCompletion({ ...valid, item: { ...valid.item, arguments: { ...proposal().input, summary: "Changed" } } })).toBeNull();
    for (const patch of [{ threadId: "other" }, { turnId: "other" }, { sourceClientId: "other" }, { thread_id: "other" }, { turn_id: "other" }]) expect(parseAgentInteractionToolCompletion({ ...valid, ...patch })).toBeNull();
});

test("business event parsing validates the complete DTO, source scope, seq and replay marker", () => {
    expect(parseAgentInteractionEvent(envelope())).toEqual({ interaction: proposal(), seq: 1, replayed: false });
    expect(parseAgentInteractionEvent({ ...envelope(), replayed: true })?.replayed).toBe(true);
    for (const seq of [undefined, 0, -1, "1", 0.5, Infinity]) expect(parseAgentInteractionEvent({ ...envelope(), seq })).toBeNull();
    for (const patch of [{ threadId: "other" }, { turnId: "other" }, { sourceClientId: "other" }, { replayed: "true" }, { interaction: null }]) expect(parseAgentInteractionEvent({ ...envelope(), ...patch })).toBeNull();
});

test("question aliases preserve their authority record, sequence and replay marker with either scope spelling", () => {
    const answered: ReturnType<typeof question> = { ...question(), revision: 1, status: "queued", decision: { answer: "Forest" } };
    for (const [name, record] of [["agent_question", question()], ["agent_question_answered", answered]] as const) {
        const event = questionEnvelope(record);
        expect(parseAgentQuestionEvent(name, event)).toEqual({ interaction: record, seq: 1, replayed: false });
        const { threadId, turnId, ...aliases } = event;
        expect(parseAgentQuestionEvent(name, { ...aliases, thread_id: threadId, turn_id: turnId, replayed: true }))
            .toEqual({ interaction: record, seq: 1, replayed: true });
    }
});

test("question aliases reject foreign owners, mismatched identifiers and conflicting thread, turn or client scope", () => {
    const answered: ReturnType<typeof question> = { ...question(), revision: 1, status: "queued", decision: { answer: "Forest" } };
    for (const [name, record] of [["agent_question", question()], ["agent_question_answered", answered]] as const) {
        const event = questionEnvelope(record);
        for (const patch of [{ ownerContext: undefined }, { ownerContext: "other" }, { questionId: undefined }, { questionId: "other" },
            { threadId: "other" }, { thread_id: "other" }, { turnId: "other" }, { turn_id: "other" }, { sourceClientId: "other" },
            { seq: 0 }, { replayed: "true" }, { interaction: null }]) {
            expect(parseAgentQuestionEvent(name, { ...event, ...patch })).toBeNull();
        }
        for (const interaction of [proposal(), generation()]) {
            expect(parseAgentQuestionEvent(name, { ...event, ...envelope(interaction), questionId: interaction.id })).toBeNull();
        }
    }
});

test("question aliases require exact question text or the recorded nonpending answer", () => {
    const record = question(), event = questionEnvelope(record);
    for (const text of [undefined, "Other question?", `${record.input.question} `, 1]) {
        expect(parseAgentQuestionEvent("agent_question", { ...event, text })).toBeNull();
    }
    const answered: ReturnType<typeof question> = { ...record, revision: 1, status: "queued", decision: { answer: "Forest" } };
    const answeredEvent = questionEnvelope(answered);
    for (const answer of [undefined, "Desert", "Forest ", false]) {
        expect(parseAgentQuestionEvent("agent_question_answered", { ...answeredEvent, answer })).toBeNull();
    }
    expect(parseAgentQuestionEvent("agent_question_answered", questionEnvelope({ ...answered, status: "pending" }))).toBeNull();
    expect(parseAgentQuestionEvent("agent_question_answered", { ...answeredEvent, interaction: { ...answered, decision: undefined } })).toBeNull();
    for (const status of ["queued", "continuing", "completed", "expired", "continuation_failed"] as const) {
        const settled = { ...answered, status };
        expect(parseAgentQuestionEvent("agent_question_answered", questionEnvelope(settled))?.interaction).toEqual(settled);
    }
});

test("proposal aliases preserve zero or omitted estimates and approved or rejected authority records", () => {
    const noEstimate: ReturnType<typeof proposal> = { ...proposal(), input: { proposalId: "proposal-1", summary: "No estimate", actions: [] } };
    for (const record of [proposal(), noEstimate]) {
        expect(parseAgentProposalEvent("agent_proposal", proposalEnvelope(record)))
            .toEqual({ interaction: record, seq: 1, replayed: false });
    }
    const { estimatedCost, ...withoutEstimate } = proposalEnvelope(noEstimate);
    expect(estimatedCost).toBeUndefined();
    expect(parseAgentProposalEvent("agent_proposal", withoutEstimate)?.interaction).toEqual(noEstimate);
    for (const decision of [{ approved: true }, { approved: false, reason: "Use fewer trees" }]) {
        const record: ReturnType<typeof proposal> = { ...proposal(), revision: 1, status: "queued", decision };
        const { threadId, turnId, ...event } = proposalEnvelope(record);
        expect(parseAgentProposalEvent("agent_proposal_decided", { ...event, thread_id: threadId, turn_id: turnId, replayed: true }))
            .toEqual({ interaction: record, seq: 1, replayed: true });
    }
});

test("proposal aliases reject mismatched summaries, identifiers, owners and original event scope", () => {
    const decided: ReturnType<typeof proposal> = { ...proposal(), revision: 1, status: "queued", decision: { approved: false, reason: "Fewer trees" } };
    for (const [name, record] of [["agent_proposal", proposal()], ["agent_proposal_decided", decided]] as const) {
        const event = proposalEnvelope(record);
        for (const patch of [{ summary: undefined }, { summary: "Another plan" }, { summary: `${record.input.summary} ` },
            { proposalId: undefined }, { proposalId: "other" }, { ownerContext: undefined }, { ownerContext: "other" },
            { threadId: "other" }, { thread_id: "other" }, { turnId: "other" }, { turn_id: "other" }, { sourceClientId: "other" },
            { seq: 0 }, { replayed: "true" }, { interaction: null }]) {
            expect(parseAgentProposalEvent(name, { ...event, ...patch })).toBeNull();
        }
        for (const interaction of [question(), generation()]) {
            expect(parseAgentProposalEvent(name, { ...event, ...envelope(interaction), proposalId: interaction.id })).toBeNull();
        }
    }
});

test("proposal aliases require exact estimates and a matching nonpending boolean decision", () => {
    for (const estimatedCost of [undefined, 1, "0", null]) {
        expect(parseAgentProposalEvent("agent_proposal", { ...proposalEnvelope(), estimatedCost })).toBeNull();
    }
    const noEstimate: ReturnType<typeof proposal> = { ...proposal(), input: { proposalId: "proposal-1", summary: "No estimate", actions: [] } };
    expect(parseAgentProposalEvent("agent_proposal", { ...proposalEnvelope(noEstimate), estimatedCost: 0 })).toBeNull();
    for (const approved of [true, false]) {
        const record: ReturnType<typeof proposal> = { ...proposal(), revision: 1, status: "queued", decision: { approved } };
        const event = proposalEnvelope(record);
        for (const candidate of [undefined, !approved, String(approved), 1]) {
            expect(parseAgentProposalEvent("agent_proposal_decided", { ...event, approved: candidate })).toBeNull();
        }
        expect(parseAgentProposalEvent("agent_proposal_decided", { ...event, interaction: { ...record, status: "pending" } })).toBeNull();
        expect(parseAgentProposalEvent("agent_proposal_decided", { ...event, interaction: { ...record, decision: undefined } })).toBeNull();
    }
});

test("identity includes stream, owner, client, project, thread, conversation and kind without separator collisions", () => {
    const record = proposal(), scope = agentInteractionScope(record);
    expect(scope.clientId).toBe(record.sourceClientId);
    expect(sameAgentInteractionScope(scope, { ...scope })).toBe(true);
    for (const field of ["streamId", "threadId", "conversationId", "clientId", "ownerContext", "projectId"] as const) {
        const changed = { ...scope, [field]: "other" };
        expect(sameAgentInteractionScope(scope, changed)).toBe(false);
        const patch = field === "clientId" ? { sourceClientId: "other" } : { [field]: "other" };
        expect(agentInteractionKey({ ...record, ...patch })).not.toBe(agentInteractionKey(record));
    }
    expect(agentInteractionKey({ ...record, threadId: "a:b", conversationId: "c" })).not.toBe(agentInteractionKey({ ...record, threadId: "a", conversationId: "b:c" }));
});

test("authoritative revision prevents old pending completions or delayed GET from rolling back queued cards", () => {
    const queued = { ...proposal(), revision: 2, status: "queued", decision: { approved: true } } as AgentInteraction;
    const latest = view(queued);
    expect(mergeAgentInteractionViews([latest], [view(proposal(), false)])).toEqual([latest]);
    expect(mergeAgentInteractionViews([latest], [view(proposal())])).toEqual([latest]);
    const historical = view({ ...proposal(), revision: 8 }, false);
    expect(mergeAgentInteractionViews([historical], [view(queued)])[0].record).toEqual(queued);
});

test("same revision snapshots retain unknown or submitting writes while newer settled authority clears them", () => {
    for (const submission of ["submitting", "unknown"] as const) {
        const previous = { ...view(), submission, error: "Uncertain receipt" };
        const same = mergeAgentInteractionViews([previous], [view()])[0];
        expect(same.submission).toBe(submission);
        expect(same.error).toBe("Uncertain receipt");
        const queued = { ...proposal(), status: "queued", revision: 1, decision: { approved: true } } as AgentInteraction;
        const updated = mergeAgentInteractionViews([previous], [view(queued)])[0];
        expect(updated.record.status).toBe("queued");
        expect(updated.submission).toBeUndefined();
        expect(updated.error).toBeUndefined();
    }
});

function initialized() {
    const auto = createAgentInteractionAutoConfirmController(), scope = agentInteractionScope(generation());
    auto.beginInitialization(scope);
    expect(auto.completeReplay(10)).toBe(true);
    return { auto, scope };
}

test("hello and snapshots never open the auto gate; only the complete replay boundary does", () => {
    const auto = createAgentInteractionAutoConfirmController(), scope = agentInteractionScope(generation());
    expect(auto.completeReplay(0)).toBe(false);
    auto.beginInitialization(scope);
    auto.completeSnapshot([generation("snapshot-old")]);
    expect(auto.takeCreated({ interaction: generation("before-init"), seq: 2 }, scope, true)).toBe(false);
    expect(auto.completeReplay(1)).toBe(false);
    expect(auto.completeReplay(10)).toBe(true);
    expect(auto.takeCreated({ interaction: generation("snapshot-old"), seq: 11 }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: generation("before-init"), seq: 12 }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: generation("new"), seq: 13 }, scope, true)).toBe(true);
});

test("only a new pending generation confirmation is claimed once after the initialization watermark", () => {
    const { auto, scope } = initialized();
    expect(auto.takeCreated({ interaction: generation("old"), seq: 9 }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: generation("replay"), seq: 11, replayed: true }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: proposal(), seq: 12 }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: question(), seq: 13 }, scope, true)).toBe(false);
    const event = { interaction: generation("new"), seq: 14 };
    expect(auto.takeCreated(event, scope, true)).toBe(true);
    expect(auto.takeCreated(event, scope, true)).toBe(false);
    expect(auto.takeCreated({ ...event, seq: 15 }, scope, true)).toBe(false);
});

test("enabling auto does not revisit pending events received while disabled or through GET", () => {
    const { auto, scope } = initialized();
    const event = { interaction: generation("disabled"), seq: 11 };
    expect(auto.takeCreated(event, scope, false)).toBe(false);
    expect(auto.takeCreated({ ...event, seq: 12 }, scope, true)).toBe(false);
    auto.completeSnapshot([generation("read-only-get")]);
    expect(auto.takeCreated({ interaction: generation("read-only-get"), seq: 13 }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: generation("later"), seq: 14 }, scope, true)).toBe(true);
});

test("all scope fields are checked before auto and a reconnected scope requires a fresh replay boundary", () => {
    const { auto, scope } = initialized();
    for (const field of ["streamId", "threadId", "conversationId", "clientId", "ownerContext", "projectId"] as const) {
        const foreign: AgentInteractionScope = { ...scope, [field]: "other" };
        expect(auto.takeCreated({ interaction: generation(), seq: 11 }, foreign, true)).toBe(false);
        const fieldPatch = field === "clientId" ? { sourceClientId: "other" } : { [field]: "other" };
        expect(auto.takeCreated({ interaction: { ...generation(), ...fieldPatch }, seq: 11 }, scope, true)).toBe(false);
    }
    const event = { interaction: generation(), seq: 11 };
    expect(auto.takeCreated(event, scope, true)).toBe(true);
    auto.beginInitialization(scope);
    expect(auto.takeCreated({ interaction: generation("during-reconnect"), seq: 12 }, scope, true)).toBe(false);
    expect(auto.completeReplay(12)).toBe(true);
    expect(auto.takeCreated({ ...event, seq: 13 }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: generation("fresh-after-reconnect"), seq: 14 }, scope, true)).toBe(true);
});

test("resolved and malformed sequence events cannot trigger auto submission", () => {
    const { auto, scope } = initialized();
    for (const status of ["queued", "continuing", "completed", "expired", "continuation_failed"] as const) {
        expect(auto.takeCreated({ interaction: { ...generation(status), status }, seq: 11 }, scope, true)).toBe(false);
    }
    for (const seq of [0, -1, NaN, Infinity, 0.5]) expect(auto.takeCreated({ interaction: generation(), seq }, scope, true)).toBe(false);
    expect(auto.takeCreated({ interaction: { ...generation("decided"), decision: { confirmed: true } }, seq: 12 }, scope, true)).toBe(false);
});
