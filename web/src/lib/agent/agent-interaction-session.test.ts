import { expect, test } from "bun:test";
import type { AgentChatItem } from "@/stores/use-agent-store";
import {
    createAgentInteractionSession, interactionMessage, interactionView, projectAgentInteractionMessages,
    type AgentInteractionClientContext,
} from "./agent-interaction-session";
import { agentInteractionScope, parseAgentInteractionEvent, parseAgentProposalEvent, parseAgentQuestionEvent,
    type AgentInteraction, type AgentInteractionDecision, type AgentInteractionView } from "./agent-interactions";

const proposal = (): Extract<AgentInteraction, { kind: "proposal" }> => ({
    id: "proposal-1", kind: "proposal", input: { proposalId: "proposal-1", summary: "Plan", actions: ["Place the scene"] },
    streamId: "stream-1", threadId: "thread-1", conversationId: "conversation-1", sourceTurnId: "source-turn-1", sourceClientId: "client-1",
    ownerContext: "account-1", projectId: "project-1", revision: 0, status: "pending",
});
const question = (): Extract<AgentInteraction, { kind: "question" }> => ({ ...proposal(), id: "question-1", kind: "question", input: { questionId: "question-1", question: "Which scene?" }, decision: undefined });
const generation = (id = "confirm-1"): AgentInteraction => ({ ...proposal(), id, kind: "generation_confirm", input: { confirmId: id, description: "Generate", estimatedCost: 4 }, decision: undefined });
const context = (): AgentInteractionClientContext => ({ scope: agentInteractionScope(proposal()), endpoint: "http://synthetic-agent", token: "synthetic-token", accountKey: "account-1:epoch-1" });
const queued = (record: AgentInteraction = proposal(), decision: AgentInteractionDecision = { approved: true }): AgentInteraction => ({ ...record, revision: record.revision + 1, status: "queued", decision } as AgentInteraction);
const receipt = (interaction: AgentInteraction) => ({ ok: true, interaction });
const questionEnvelope = (interaction = question(), seq = 1) => ({ interaction, seq, threadId: interaction.threadId,
    turnId: interaction.sourceTurnId, sourceClientId: interaction.sourceClientId, ownerContext: interaction.ownerContext,
    questionId: interaction.id, text: interaction.input.question, answer: interaction.decision?.answer });
const proposalEnvelope = (interaction = proposal(), seq = 1) => ({ interaction, seq, threadId: interaction.threadId,
    turnId: interaction.sourceTurnId, sourceClientId: interaction.sourceClientId, ownerContext: interaction.ownerContext,
    proposalId: interaction.id, summary: interaction.input.summary, estimatedCost: interaction.input.estimatedCost, approved: interaction.decision?.approved });
function deferred<T = unknown>() {
    let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
}

function setup(options: { decide?: (record: AgentInteraction, decision: AgentInteractionDecision) => Promise<unknown>; list?: () => Promise<unknown> } = {}) {
    let current: AgentInteractionClientContext | null = context();
    const decisions: Array<{ context: AgentInteractionClientContext; record: AgentInteraction; decision: AgentInteractionDecision }> = [];
    const lists: AgentInteractionClientContext[] = [], publications: Array<readonly AgentInteractionView[]> = [];
    const session = createAgentInteractionSession({
        current: () => current,
        publish: (views) => publications.push(views),
        list: async (ctx) => { lists.push(ctx); return options.list ? options.list() : { ok: true, interactions: [proposal()] }; },
        decide: async (ctx, record, decision) => { decisions.push({ context: ctx, record, decision }); return options.decide ? options.decide(record, decision) : receipt(queued(record, decision)); },
    });
    return { session, decisions, lists, publications, current: () => current!, setCurrent: (next: AgentInteractionClientContext | null) => { current = next; } };
}

test("a lost POST response causes one read-only GET and never another POST, including after a same-revision snapshot", async () => {
    for (const decision of [{ approved: true }, { approved: false }, { approved: false, reason: "Use fewer trees" }]) {
        const fixture = setup({ decide: async () => { throw new Error("Response lost"); } });
        fixture.session.begin(fixture.current().scope, [proposal()]);
        await fixture.session.submit(proposal(), decision);
        expect(fixture.decisions).toHaveLength(1);
        expect(fixture.decisions[0].decision).toEqual(decision);
        expect(fixture.lists).toHaveLength(1);
        expect(fixture.session.views()[0].submission).toBe("unknown");
        expect(fixture.session.views()[0].error).toBe("Response lost");
        fixture.session.snapshot({ ok: true, interactions: [proposal()] });
        await fixture.session.submit(proposal(), { approved: true });
        await fixture.session.submit(proposal(), { approved: false, reason: "Another click" });
        expect(fixture.decisions).toHaveLength(1);
        expect(fixture.lists).toHaveLength(1);
        expect(fixture.session.views()[0].submission).toBe("unknown");
        expect(fixture.session.views()[0].proposalReasonDraft).toBe(decision.approved ? undefined : decision.reason ?? "");
    }
});

test("GET can resolve an uncertain POST to queued without dispatching its continuation again", async () => {
    const accepted = queued();
    const fixture = setup({ decide: async () => { throw new Error("Response lost"); }, list: async () => ({ ok: true, interactions: [accepted] }) });
    fixture.session.begin(fixture.current().scope, [proposal()]);
    await fixture.session.submit(proposal(), { approved: true });
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.lists).toHaveLength(1);
    expect(fixture.session.views()[0]).toEqual({ record: accepted, authoritative: true, submission: undefined, error: undefined });
    await fixture.session.submit(accepted, { approved: true });
    expect(fixture.decisions).toHaveLength(1);
});

test("a failed reconciliation remains unknown and does not retry either HTTP operation", async () => {
    const fixture = setup({ decide: async () => { throw new Error("POST unknown"); }, list: async () => { throw new Error("GET unavailable"); } });
    fixture.session.begin(fixture.current().scope, [proposal()]);
    await fixture.session.submit(proposal(), { approved: true });
    await fixture.session.submit(proposal(), { approved: true });
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.lists).toHaveLength(1);
    expect(fixture.session.views()[0].submission).toBe("unknown");
});

test("an unknown question answer retains its draft and only performs one POST and one read-only GET", async () => {
    const record = question(), decision = { answer: "A forest with a lake" };
    const fixture = setup({ decide: async () => { throw new Error("Answer response lost"); },
        list: async () => ({ ok: true, interactions: [record] }) });
    fixture.session.begin(fixture.current().scope, [record]);
    await fixture.session.submit(record, decision);
    fixture.session.snapshot({ ok: true, interactions: [record] });
    await fixture.session.submit(record, decision);
    await fixture.session.submit(record, { answer: "A revised answer" });
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.decisions[0].decision).toEqual(decision);
    expect(fixture.lists).toHaveLength(1);
    expect(fixture.session.views()[0].record).toEqual(record);
    expect(fixture.session.views()[0]).toMatchObject({ authoritative: true, submission: "unknown",
        error: "Answer response lost", answerDraft: decision.answer });
});

test("question receipts with another answer, source turn, missing decision or pending status remain unknown", async () => {
    const record = question(), decision = { answer: "Forest" }, accepted = queued(record, decision);
    for (const invalid of [{ ...accepted, decision: { answer: "Desert" } }, { ...accepted, sourceTurnId: "another-source-turn" },
        { ...accepted, decision: undefined }, { ...accepted, status: "pending" }]) {
        const fixture = setup({ decide: async () => receipt(invalid as AgentInteraction),
            list: async () => ({ ok: true, interactions: [record] }) });
        fixture.session.begin(fixture.current().scope, [record]);
        await fixture.session.submit(record, decision);
        await fixture.session.submit(record, decision);
        expect(fixture.decisions).toHaveLength(1);
        expect(fixture.lists).toHaveLength(1);
        expect(fixture.session.views()[0].record).toEqual(record);
        expect(fixture.session.views()[0]).toMatchObject({ authoritative: true, submission: "unknown",
            error: "Invalid interaction decision receipt", answerDraft: decision.answer });
    }
});

test("proposal receipts with another approval, reason, source turn, missing decision or pending status remain unknown", async () => {
    const record = proposal();
    for (const decision of [{ approved: true }, { approved: false, reason: "Use fewer trees" }]) {
        const accepted = queued(record, decision);
        for (const invalid of [{ ...accepted, decision: { ...decision, approved: !decision.approved } },
            { ...accepted, decision: { ...decision, reason: "Another reason" } }, { ...accepted, sourceTurnId: "another-source-turn" },
            ...(decision.reason === undefined ? [] : [{ ...accepted, decision: { approved: decision.approved } }]),
            { ...accepted, decision: undefined }, { ...accepted, status: "pending" }]) {
            const fixture = setup({ decide: async () => receipt(invalid as AgentInteraction) });
            fixture.session.begin(fixture.current().scope, [record]);
            await fixture.session.submit(record, decision);
            await fixture.session.submit(record, decision);
            expect(fixture.decisions).toHaveLength(1);
            expect(fixture.lists).toHaveLength(1);
            expect(fixture.session.views()[0].record).toEqual(record);
            expect(fixture.session.views()[0]).toMatchObject({ authoritative: true, submission: "unknown",
                error: "Invalid interaction decision receipt" });
            expect(fixture.session.views()[0].proposalReasonDraft).toBe(decision.approved ? undefined : decision.reason);
        }
    }
});

test("submitted question and proposal-rejection drafts survive snapshots and projection onto a different outer message ID", async () => {
    for (const [record, decision] of [[question(), { answer: "A forest with a lake" }],
        [proposal(), { approved: false, reason: "Use fewer trees" }]] as const) {
        const pending = deferred(), fixture = setup({ decide: () => pending.promise });
        const draft = "answer" in decision ? { answerDraft: decision.answer } : { proposalReasonDraft: decision.reason };
        fixture.session.begin(fixture.current().scope, [record]);
        const operation = fixture.session.submit(record, decision);
        const original = interactionMessage(record, "mcp-original");
        const initial = projectAgentInteractionMessages([original], fixture.session.views(), fixture.current().scope);
        expect(initial[0].interaction).toMatchObject(draft);
        fixture.session.snapshot({ ok: true, interactions: [record] });
        const restored = interactionMessage(record, "mcp-history-restored");
        const projected = projectAgentInteractionMessages([restored, interactionMessage(record, "mcp-duplicate")], fixture.session.views(), fixture.current().scope);
        expect(projected).toHaveLength(1);
        expect(projected[0].id).toBe(restored.id);
        expect(projected[0].id).not.toBe(initial[0].id);
        expect(projected[0].interaction).toMatchObject({ submission: "submitting", ...draft });
        pending.resolve(receipt(queued(record, decision)));
        await operation;
        const settled = projectAgentInteractionMessages([restored], fixture.session.views(), fixture.current().scope);
        expect(settled[0].interaction).toMatchObject({ record: { status: "queued", decision }, ...draft });
        expect(fixture.decisions).toHaveLength(1);
        expect(fixture.lists).toHaveLength(0);
    }
});

test("double click shares one in-flight submission and a stale pending card cannot replace its queued result", async () => {
    const pending = deferred();
    const fixture = setup({ decide: () => pending.promise });
    fixture.session.begin(fixture.current().scope, [proposal()]);
    const first = fixture.session.submit(proposal(), { approved: true });
    const duplicate = fixture.session.submit(proposal(), { approved: false });
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.session.views()[0].submission).toBe("submitting");
    fixture.session.snapshot({ ok: true, interactions: [proposal()] });
    expect(fixture.session.views()[0].submission).toBe("submitting");
    pending.resolve(receipt(queued()));
    await Promise.all([first, duplicate]);
    fixture.session.upsert(proposal());
    expect(fixture.session.views()[0].record.status).toBe("queued");
    expect(fixture.session.views()[0].record.revision).toBe(1);
    expect(fixture.decisions).toHaveLength(1);
});

test("manual approval, rejection, answer and generation cancel pass original record and exact decision to one HTTP call", async () => {
    const variants: Array<[AgentInteraction, AgentInteractionDecision]> = [
        [proposal(), { approved: true }], [proposal(), { approved: false }], [proposal(), { approved: false, reason: "Change the plan" }],
        [question(), { answer: "Forest" }], [generation(), { confirmed: false, decisionSource: "manual" }],
    ];
    for (const [record, decision] of variants) {
        const fixture = setup();
        fixture.session.begin(fixture.current().scope, [record]);
        await fixture.session.submit(record, decision);
        expect(fixture.decisions).toHaveLength(1);
        expect(fixture.decisions[0]).toEqual({ context: fixture.current(), record, decision });
        expect(fixture.session.views()[0].record.decision).toEqual(decision);
        expect(fixture.session.views()[0].record.sourceTurnId).toBe("source-turn-1");
        expect(fixture.session.views()[0].proposalReasonDraft).toBe(record.kind === "proposal" && "approved" in decision && !decision.approved ? decision.reason ?? "" : undefined);
        expect(fixture.lists).toHaveLength(0);
    }
});

test("queued proposal and answered-question continuations retain their original scope and source turn", () => {
    for (const record of [proposal(), question()]) {
        const fixture = setup();
        fixture.session.begin(fixture.current().scope, [record]);
        const accepted = queued(record, record.kind === "question" ? { answer: "Forest" } : { approved: true });
        fixture.session.upsert(accepted);
        const continuing = { ...accepted, revision: 2, status: "continuing", continuationTurnId: "new-turn-2" } as AgentInteraction;
        fixture.session.upsert(continuing);
        fixture.session.upsert(accepted);
        expect(fixture.session.views()[0].record).toEqual(continuing);
        expect(agentInteractionScope(fixture.session.views()[0].record)).toEqual(agentInteractionScope(record));
        const projected = projectAgentInteractionMessages([], fixture.session.views(), fixture.current().scope);
        expect(projected[0].threadId).toBe(record.threadId);
        expect(projected[0].turnId).toBe(record.sourceTurnId);
        expect(projected[0].interaction?.record.continuationTurnId).toBe("new-turn-2");
    }
});

test("generic created and question or proposal aliases project one card without automatic decisions", () => {
    for (const record of [question(), proposal()]) {
        const fixture = setup();
        fixture.session.begin(fixture.current().scope, []);
        fixture.session.completeReplay(0);
        const generic = parseAgentInteractionEvent(record.kind === "question" ? questionEnvelope(record) : proposalEnvelope(record));
        const alias = record.kind === "question" ? parseAgentQuestionEvent("agent_question", questionEnvelope(record, 2))
            : parseAgentProposalEvent("agent_proposal", proposalEnvelope(record, 2));
        expect(generic).not.toBeNull();
        expect(alias).not.toBeNull();
        fixture.session.created(generic!, true);
        fixture.session.created(alias!, true);
        expect(fixture.session.views()).toHaveLength(1);
        const original = interactionMessage(record, "generic-created");
        const projected = projectAgentInteractionMessages([original, interactionMessage(record, "business-alias")], fixture.session.views(), fixture.current().scope);
        expect(projected).toHaveLength(1);
        expect(projected[0].id).toBe(original.id);
        expect(projected[0].interaction?.authoritative).toBe(true);
        expect(fixture.decisions).toHaveLength(0);
        expect(fixture.lists).toHaveLength(0);
    }
});

test("an answered question or decided proposal cannot be revived by older generic or alias pending replay", () => {
    for (const record of [question(), proposal()]) {
        const fixture = setup();
        fixture.session.begin(fixture.current().scope, [record]);
        const accepted = record.kind === "question" ? { ...record, revision: 1, status: "queued" as const, decision: { answer: "Forest" } }
            : { ...record, revision: 1, status: "queued" as const, decision: { approved: false, reason: "Fewer trees" } };
        const settled = accepted.kind === "question" ? parseAgentQuestionEvent("agent_question_answered", questionEnvelope(accepted, 3))
            : parseAgentProposalEvent("agent_proposal_decided", proposalEnvelope(accepted, 3));
        const generic = parseAgentInteractionEvent(record.kind === "question" ? questionEnvelope(record) : proposalEnvelope(record));
        const alias = record.kind === "question" ? parseAgentQuestionEvent("agent_question", questionEnvelope(record, 2))
            : parseAgentProposalEvent("agent_proposal", proposalEnvelope(record, 2));
        expect(settled).not.toBeNull();
        fixture.session.upsert(settled!.interaction);
        fixture.session.created({ ...generic!, replayed: true }, false);
        fixture.session.created({ ...alias!, replayed: true }, false);
        expect(fixture.session.views()).toHaveLength(1);
        expect(fixture.session.views()[0].record).toEqual(accepted);
        expect(fixture.decisions).toHaveLength(0);
    }
});

test("a same-scope begin with an older pending hello preserves answered-question and decided-proposal audit records", async () => {
    for (const [record, decision] of [[question(), { answer: "Forest" }], [proposal(), { approved: false, reason: "Fewer trees" }]] as const) {
        const fixture = setup(), accepted = queued(record, decision);
        fixture.session.begin(fixture.current().scope, [record]);
        fixture.session.upsert(accepted);
        fixture.session.begin(fixture.current().scope, [record]);
        expect(fixture.session.views()).toHaveLength(1);
        expect(fixture.session.views()[0].record).toEqual(accepted);
        await fixture.session.submit(record, decision);
        expect(fixture.decisions).toHaveLength(0);
        expect(fixture.lists).toHaveLength(0);
    }
});

test("the same question or proposal ID in another thread has an independent decision and ignores the old receipt", async () => {
    for (const [oldRecord, oldDecision, nextDecision] of [[question(), { answer: "Old forest" }, { answer: "New desert" }],
        [proposal(), { approved: true }, { approved: false, reason: "Use fewer trees" }]] as const) {
        const pending = deferred(), nextRecord = { ...oldRecord, threadId: "thread-2", sourceTurnId: "source-turn-2" };
        const fixture = setup({ decide: (record, decision) => record.threadId === oldRecord.threadId
            ? pending.promise : Promise.resolve(receipt(queued(record, decision))) });
        fixture.session.begin(fixture.current().scope, [oldRecord]);
        const oldOperation = fixture.session.submit(oldRecord, oldDecision);
        fixture.setCurrent({ ...fixture.current(), scope: agentInteractionScope(nextRecord) });
        fixture.session.begin(fixture.current().scope, [nextRecord]);
        fixture.session.upsert(queued(oldRecord, oldDecision));
        await fixture.session.submit(nextRecord, nextDecision);
        const publicationCount = fixture.publications.length;
        pending.resolve(receipt(queued(oldRecord, oldDecision)));
        await oldOperation;
        expect(fixture.publications).toHaveLength(publicationCount);
        expect(fixture.decisions).toHaveLength(2);
        expect(fixture.decisions.map(({ context, record }) => [context.scope.threadId, record.threadId])).toEqual([
            [oldRecord.threadId, oldRecord.threadId], [nextRecord.threadId, nextRecord.threadId],
        ]);
        const projected = projectAgentInteractionMessages([interactionMessage(oldRecord), interactionMessage(nextRecord)], fixture.session.views(), fixture.current().scope);
        const draft = "answer" in nextDecision ? { answerDraft: nextDecision.answer } : { proposalReasonDraft: nextDecision.reason };
        expect(projected).toHaveLength(1);
        expect(projected[0].threadId).toBe(nextRecord.threadId);
        expect(projected[0].turnId).toBe(nextRecord.sourceTurnId);
        expect(projected[0].interaction).toMatchObject({ authoritative: true, ...draft,
            record: { id: oldRecord.id, status: "queued", decision: nextDecision } });
        expect(fixture.lists).toHaveLength(0);
    }
});

test("late decision responses and failures are discarded after each account, scope or connection change", async () => {
    const changes: Array<(ctx: AgentInteractionClientContext) => AgentInteractionClientContext | null> = [
        () => null,
        (ctx) => ({ ...ctx, accountKey: "account-1:epoch-2" }),
        (ctx) => ({ ...ctx, endpoint: "http://other-agent" }),
        (ctx) => ({ ...ctx, token: "other-token" }),
        ...(["ownerContext", "clientId", "projectId", "threadId", "conversationId", "streamId"] as const)
            .map((field) => (ctx: AgentInteractionClientContext) => ({ ...ctx, scope: { ...ctx.scope, [field]: "other" } })),
    ];
    for (const fail of [false, true]) for (const change of changes) {
        const pending = deferred(), fixture = setup({ decide: () => pending.promise });
        fixture.session.begin(fixture.current().scope, [proposal()]);
        const operation = fixture.session.submit(proposal(), { approved: true });
        const publicationCount = fixture.publications.length;
        fixture.setCurrent(change(fixture.current()));
        if (fail) pending.reject(new Error("Late failure")); else pending.resolve(receipt(queued()));
        await operation;
        expect(fixture.publications).toHaveLength(publicationCount);
        expect(fixture.lists).toHaveLength(0);
        expect(fixture.session.views()[0].record.status).toBe("pending");
    }
});

test("session invalidation discards old responses even after returning to an identical context", async () => {
    const pending = deferred(), fixture = setup({ decide: () => pending.promise });
    fixture.session.begin(fixture.current().scope, [proposal()]);
    const operation = fixture.session.submit(proposal(), { approved: true });
    fixture.session.invalidate();
    fixture.session.begin(fixture.current().scope, [proposal()]);
    pending.resolve(receipt(queued()));
    await operation;
    expect(fixture.session.views()[0].record.status).toBe("pending");
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.lists).toHaveLength(0);
});

test("late reconciliation cannot restore authority after the scope or session epoch changes", async () => {
    for (const invalidate of [false, true]) {
        const pending = deferred(), fixture = setup({ list: () => pending.promise });
        fixture.session.begin(fixture.current().scope, [proposal()]);
        const operation = fixture.session.reconcile();
        if (invalidate) fixture.session.invalidate();
        else fixture.setCurrent({ ...fixture.current(), scope: { ...fixture.current().scope, streamId: "restart" } });
        const publications = fixture.publications.length;
        pending.resolve({ ok: true, interactions: [queued()] });
        await operation;
        expect(fixture.publications).toHaveLength(publications);
        expect(fixture.session.views()[0].record.status).toBe("pending");
        expect(fixture.lists).toHaveLength(1);
    }
});

test("a complete snapshot missing a record revokes authority and neither disk history nor a tool hint grants it", async () => {
    const fixture = setup(), source = interactionMessage(proposal(), "mcp-item-original");
    fixture.session.begin(fixture.current().scope, [proposal()]);
    fixture.session.snapshot({ ok: true, interactions: [] });
    const expired = fixture.session.views()[0];
    expect(expired.authoritative).toBe(false);
    await fixture.session.submit(proposal(), { approved: true });
    expect(fixture.decisions).toHaveLength(0);
    expect(interactionView({ record: proposal(), authoritative: true })?.authoritative).toBe(false);
    const projected = projectAgentInteractionMessages([source], fixture.session.views(), fixture.current().scope);
    expect(projected[0].interaction?.authoritative).toBe(false);
    expect(projected[0].id).toBe(source.id);
});

test("history projection deduplicates exact identity at its original item position and overlays latest authority", () => {
    const source = interactionMessage(proposal(), "mcp-original"), duplicate = interactionMessage(proposal(), "mcp-repeat");
    const before: AgentChatItem = { id: "user", role: "user", text: "Please plan" };
    const after: AgentChatItem = { id: "assistant", role: "assistant", text: "Waiting for your decision" };
    const authoritative = { record: queued(), authoritative: true };
    const projected = projectAgentInteractionMessages([before, source, after, duplicate], [authoritative], context().scope);
    expect(projected.map((item) => item.id)).toEqual([before.id, source.id, after.id]);
    expect(projected[1].itemId).toBe("mcp-original");
    expect(projected[1].turnId).toBe(proposal().sourceTurnId);
    expect(projected[1].interaction).toEqual(authoritative);
    const again = projectAgentInteractionMessages(projected, [authoritative], context().scope);
    expect(again).toEqual(projected);
});

test("foreign scope history never becomes actionable and an old process card remains a read-only hint", () => {
    for (const field of ["ownerContext", "sourceClientId", "projectId", "threadId"] as const) {
        const foreign = { ...proposal(), [field]: "other" };
        const projected = projectAgentInteractionMessages([interactionMessage(foreign)], [{ record: foreign, authoritative: true }], context().scope);
        expect(projected).toHaveLength(0);
    }
    const oldProcess = { ...proposal(), streamId: "old-process" };
    const projected = projectAgentInteractionMessages([interactionMessage(oldProcess)], [], context().scope);
    expect(projected[0].interaction?.authoritative).toBe(false);
    expect(projected[0].interaction?.record.streamId).toBe("old-process");
});

test("current snapshots validate atomically and ignore foreign-scope records", () => {
    const fixture = setup();
    fixture.session.begin(fixture.current().scope, [proposal()]);
    expect(() => fixture.session.snapshot({ ok: true, interactions: [queued(), {}] })).toThrow("Invalid interaction record");
    expect(fixture.session.views()[0].record.status).toBe("pending");
    fixture.session.snapshot({ ok: true, interactions: [{ ...proposal(), ownerContext: "other" }] });
    expect(fixture.session.views()[0].authoritative).toBe(false);
    expect(fixture.session.views()).toHaveLength(1);
});

test("only a new created generation-confirm event after replay can auto-submit through the guarded HTTP path", async () => {
    const fixture = setup();
    fixture.session.begin(fixture.current().scope, [generation("hello-pending")]);
    await fixture.session.created({ interaction: generation("replay-pending"), seq: 1, replayed: true }, true);
    expect(fixture.decisions).toHaveLength(0);
    fixture.session.completeReplay(1);
    await fixture.session.created({ interaction: generation("hello-pending"), seq: 2 }, true);
    await fixture.session.created({ interaction: proposal(), seq: 3 }, true);
    await fixture.session.created({ interaction: question(), seq: 4 }, true);
    await fixture.session.created({ interaction: generation("disabled"), seq: 5 }, false);
    await fixture.session.created({ interaction: generation("disabled"), seq: 6 }, true);
    expect(fixture.decisions).toHaveLength(0);
    const fresh = { interaction: generation("fresh"), seq: 7 };
    await fixture.session.created(fresh, true);
    await fixture.session.created({ ...fresh, seq: 8 }, true);
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.decisions[0].decision).toEqual({ confirmed: true, decisionSource: "auto" });
    expect(fixture.lists).toHaveLength(0);
});

test("a hanging automatic POST does not block created processing or the following authority update", async () => {
    const pending = deferred(), fixture = setup({ decide: () => pending.promise });
    fixture.session.begin(fixture.current().scope, []);
    fixture.session.completeReplay(10);
    const record = generation("automatic-hanging");
    const returned = fixture.session.created({ interaction: record, seq: 11 }, true);
    expect(returned).toBeUndefined();
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.session.views()[0].submission).toBe("submitting");
    const continuing = { ...queued(record, { confirmed: true, decisionSource: "auto" }), revision: 2,
        status: "continuing", continuationTurnId: "continuation-2" } as AgentInteraction;
    // Mirrors the real event queue awaiting created's return before processing updated.
    await Promise.resolve(returned).then(() => fixture.session.upsert(continuing));
    expect(fixture.session.views()[0].record).toEqual(continuing);
    expect(fixture.session.views()[0].submission).toBeUndefined();
    pending.resolve(receipt(queued(record, { confirmed: true, decisionSource: "auto" })));
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.session.views()[0].record).toEqual(continuing);
    expect(fixture.decisions).toHaveLength(1);
    expect(fixture.lists).toHaveLength(0);
});

test("an older GET snapshot cannot revoke authority created or updated after that GET started", async () => {
    const pending = deferred(), fixture = setup({ list: () => pending.promise });
    fixture.session.begin(fixture.current().scope, [proposal(), question()]);
    fixture.session.completeReplay(10);
    const reading = fixture.session.reconcile();
    expect(fixture.lists).toHaveLength(1);
    const created = generation("arrived-during-get"), updated = queued();
    fixture.session.created({ interaction: created, seq: 11 }, false);
    fixture.session.upsert(updated);
    // This read began before either event and does not include those records yet.
    pending.resolve({ ok: true, interactions: [] });
    await reading;
    const views = fixture.session.views();
    expect(views.find((view) => view.record.id === created.id)?.authoritative).toBe(true);
    expect(views.find((view) => view.record.id === updated.id)?.authoritative).toBe(true);
    expect(views.find((view) => view.record.id === updated.id)?.record).toEqual(updated);
    // A record known before the read and untouched during it can still be revoked.
    expect(views.find((view) => view.record.id === question().id)?.authoritative).toBe(false);
    expect(fixture.decisions).toHaveLength(0);
});

test("invalidate through a null scope and restore the same scope without duplicate message IDs", () => {
    const fixture = setup();
    fixture.session.begin(fixture.current().scope, [proposal()]);
    const before: AgentChatItem = { id: "before", role: "user", text: "Plan this" };
    const original = interactionMessage(proposal());
    let projected = projectAgentInteractionMessages([before, original], fixture.session.views(), fixture.current().scope);
    expect(projected.map((item) => item.id)).toEqual([before.id, original.id]);
    fixture.session.invalidate();
    projected = projectAgentInteractionMessages(projected, fixture.session.views(), null);
    expect(projected.map((item) => item.id)).toEqual([before.id]);
    fixture.session.begin(fixture.current().scope, [proposal()]);
    projected = projectAgentInteractionMessages(projected, fixture.session.views(), fixture.current().scope);
    projected = projectAgentInteractionMessages(projected, fixture.session.views(), fixture.current().scope);
    expect(projected.map((item) => item.id)).toEqual([before.id, original.id]);
    expect(new Set(projected.map((item) => item.id)).size).toBe(projected.length);
    expect(projected[1].interaction?.authoritative).toBe(true);
});
