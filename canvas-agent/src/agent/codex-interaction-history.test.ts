import assert from "node:assert/strict";
import test from "node:test";

import { threadMessages } from "./codex-history.js";

const threadId = "synthetic-history-thread", turnId = "synthetic-history-turn";
const cases = [
    { tool: "canvas_create_proposal", kind: "proposal", idField: "proposalId", input: { proposalId: "proposal-history", summary: "保留原稿后新增一份", estimatedCost: 2, actions: ["新增文字", "生成图片"] } },
    { tool: "canvas_ask_user", kind: "question", idField: "questionId", input: { questionId: "question-history", question: "需要哪种风格？", placeholder: "说明风格" } },
    { tool: "canvas_request_generation_confirm", kind: "generation_confirm", idField: "confirmId", input: { confirmId: "confirm-history", description: "生成两张图片", estimatedCost: 0 } },
] as const;
type Example = typeof cases[number];

test("exact business MCP tools restore typed history identity and input from JSON content", () => {
    for (const example of cases) {
        const item = toolItem(example);
        item.arguments = JSON.stringify(example.input);
        const [message] = history(item);
        assert.ok(message?.interaction);
        assert.equal(message.role, "tool");
        assert.equal(message.server, "infinite-canvas");
        assert.equal(message.tool, example.tool);
        assert.equal(message.interaction.id, exampleId(example));
        assert.equal(message.interaction.kind, example.kind);
        assert.equal(message.interaction.threadId, threadId);
        assert.equal(message.interaction.sourceTurnId, turnId);
        assert.equal(message.interaction.status, "pending");
        assert.deepEqual(message.arguments, example.input);
        assert.deepEqual(message.interaction.input, example.input);
        assert.equal((message.result as { ok: boolean }).ok, true);
        assert.equal(message.id, `${threadId}:${turnId}:${item.id}`);
    }
});

test("supplemental completed MCP events also restore typed cards without creating authority", () => {
    const example = cases[1], item = toolItem(example);
    const input = structuredClone(item);
    const messages = threadMessages({ id: threadId, turns: [{ id: turnId, status: "completed", items: [] }] }, [], {
        turns: [], items: [{ threadId, turnId, itemId: String(item.id), item: { ...item, type: "mcp_tool_call" } }],
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.interaction?.kind, "question");
    assert.equal(messages[0]!.interaction?.status, "pending");
    assert.deepEqual(item, input);
    assert.deepEqual(history(item), history(item));
});

test("wrong server, nonexact tool, incomplete or failed calls remain ordinary history", () => {
    const example = cases[0];
    for (const patch of [
        { server: "other-server" }, { server: "infinite-canvas-suffix" },
        { tool: "prefix_canvas_create_proposal" }, { tool: "canvas_create_proposal_suffix" },
        { status: "inProgress" }, { status: undefined }, { status: "failed" },
        { error: { message: "synthetic error" } }, { success: false },
        { result: { isError: true, content: [{ type: "text", text: JSON.stringify(result(example)) }] } },
    ]) assertOrdinary({ ...toolItem(example), ...patch });
});

test("result and history identities, kinds and original inputs must all agree", () => {
    const example = cases[0], original = result(example);
    for (const patch of [
        { ok: false }, { proposalId: undefined }, { proposalId: "different-result-id" },
        { interaction: { ...original.interaction, id: "different-record-id" } },
        { interaction: { ...original.interaction, kind: "question" } },
        { interaction: { ...original.interaction, threadId: "other-history-thread" } },
        { interaction: { ...original.interaction, sourceTurnId: "other-history-turn" } },
        { interaction: { ...original.interaction, input: { ...example.input, summary: "changed summary" } } },
        { interaction: { ...original.interaction, input: { ...example.input, actions: ["different action"] } } },
    ]) assertOrdinary({ ...toolItem(example), result: { ...original, ...patch } });
    assertOrdinary({ ...toolItem(example), arguments: { ...example.input, proposalId: "different-argument-id" } });
    assertOrdinary({ ...toolItem(example), arguments: "{invalid json" });
});

test("typed history validates the full record and finite estimates rather than trusting an ok marker", () => {
    const example = cases[2], original = result(example);
    const invalid = [
        { streamId: "" }, { sourceClientId: "" }, { ownerContext: " " }, { conversationId: "" }, { projectId: 17 },
        { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { status: "fabricated" },
        { status: "queued" }, { status: "completed" }, { continuationTurnId: "" },
        { input: { ...example.input, estimatedCost: -1 } }, { input: { ...example.input, estimatedCost: Number.POSITIVE_INFINITY } },
        { input: { ...example.input, estimatedCost: "1" } }, { input: { ...example.input, description: "" } },
        { decision: { confirmed: true, decisionSource: "auto" } },
    ];
    for (const patch of invalid) assertOrdinary({ ...toolItem(example), arguments: "input" in patch ? patch.input : example.input, result: { ...original, interaction: { ...original.interaction, ...patch } } });
    const proposal = cases[0], proposalResult = result(proposal);
    for (const actions of ["text", [1], [""]]) {
        assertOrdinary({ ...toolItem(proposal), arguments: { ...proposal.input, actions }, result: { ...proposalResult, interaction: { ...proposalResult.interaction, input: { ...proposal.input, actions } } } });
    }
});

test("valid processed records retain their state and decision and need a current snapshot for actions", () => {
    const decisions = [
        { approved: false, reason: "保留原稿", decisionSource: "manual" },
        { answer: "柔和风格", decisionSource: "manual" },
        { confirmed: true, decisionSource: "auto" },
    ];
    for (const [index, example] of cases.entries()) {
        const original = result(example);
        for (const status of ["queued", "continuing", "completed", "expired", "continuation_failed"]) {
            const record = { ...original.interaction, revision: 3, status, decision: decisions[index], continuationTurnId: "synthetic-continuation-turn" };
            const [message] = history({ ...toolItem(example), result: { ...original, interaction: record } });
            assert.equal(message?.interaction?.status, status);
            assert.equal(message?.interaction?.revision, 3);
            assert.deepEqual(message?.interaction?.decision, decisions[index]);
        }
    }
});

test("malformed, ambiguous and missing MCP JSON results do not become typed cards", () => {
    const example = cases[1];
    for (const value of [
        undefined, null, "unstructured result", { content: [] }, { content: [{ type: "text", text: "invalid json" }] },
        { content: [{ type: "image", text: JSON.stringify(result(example)) }] },
        { content: [{ type: "text", text: JSON.stringify(result(example)) }, { type: "text", text: JSON.stringify(result(example)) }] },
        { ok: true }, { ok: true, questionId: "question-history", interaction: [] },
    ]) assertOrdinary({ ...toolItem(example), result: value });
});

test("ordinary tools keep their existing history shape", () => {
    const item = { id: "ordinary-tool", type: "mcpToolCall", server: "infinite-canvas", tool: "canvas_get_state", status: "completed", arguments: {}, result: { nodes: [], connections: [] } };
    assert.deepEqual(history(item), [{
        id: `${threadId}:${turnId}:ordinary-tool`, itemId: "ordinary-tool", threadId, turnId,
        role: "tool", title: "读取画布", text: "当前画布为空", detail: { kind: "tool", status: "completed", rows: [] },
    }]);
});

function interaction(example: Example) {
    return {
        id: exampleId(example), kind: example.kind, input: example.input,
        streamId: "synthetic-history-stream", threadId, conversationId: "synthetic-history-conversation", sourceTurnId: turnId,
        sourceClientId: "synthetic-history-client", projectId: "synthetic-history-project", ownerContext: "synthetic-history-owner",
        revision: 1, status: "pending",
    };
}
function result(example: Example) {
    return { ok: true, [example.idField]: exampleId(example), message: "recorded for display", interaction: interaction(example) };
}
function exampleId(example: Example) { return String((example.input as Record<string, unknown>)[example.idField]); }
function toolItem(example: Example): Record<string, unknown> {
    return { id: `tool-${example.kind}`, type: "mcpToolCall", server: "infinite-canvas", tool: example.tool, status: "completed", arguments: example.input, result: { content: [{ type: "text", text: JSON.stringify(result(example)) }] } };
}
function history(item: Record<string, unknown>) {
    return threadMessages({ id: threadId, turns: [{ id: turnId, status: "completed", items: [item] }] });
}
function assertOrdinary(item: Record<string, unknown>) {
    const [message] = history(item);
    assert.ok(message);
    assert.equal(message.interaction, undefined);
    assert.equal(message.server, undefined);
    assert.equal(message.tool, undefined);
    assert.equal(message.arguments, undefined);
    assert.equal(message.result, undefined);
    assert.equal((message.detail as { kind: string }).kind, "tool");
}
