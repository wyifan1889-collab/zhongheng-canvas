import { expect, test } from "bun:test";

import type { AgentInteraction, AgentInteractionDecision, AgentInteractionScope } from "@/lib/agent/agent-interactions";
import { AgentApiError, fetchAgentInteractions, postAgentInteractionDecision } from "./canvas-agent";

const endpoint = "http://synthetic-agent.invalid:17371";
const token = "synthetic token/?&=+#中文";
const scope: AgentInteractionScope = { streamId: "process-stream", threadId: "original/thread", conversationId: "conversation 1", clientId: "web-client", ownerContext: "owner/中文", projectId: "project 1" };
const base = { id: "业务 /?#&", streamId: scope.streamId, threadId: scope.threadId, conversationId: scope.conversationId, sourceTurnId: "original-turn", sourceClientId: scope.clientId, ownerContext: scope.ownerContext, projectId: scope.projectId, revision: 7, status: "pending" as const };
const proposal: AgentInteraction = { ...base, kind: "proposal", input: { proposalId: base.id, summary: "合成方案", actions: ["展示动作"] } };
const question: AgentInteraction = { ...base, kind: "question", input: { questionId: base.id, question: "合成问题" } };
const generation: AgentInteraction = { ...base, kind: "generation_confirm", input: { confirmId: base.id, description: "合成生成确认", estimatedCost: 17 } };
type Call = { url: URL; init?: RequestInit };

async function withFetch(run: (calls: Call[]) => Promise<void>, response: (call: Call) => Promise<Response> = async () => Response.json({ ok: true })) {
    const originalFetch = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = { url: new URL(String(input)), init };
        calls.push(call);
        return response(call);
    }, { preconnect: originalFetch.preconnect });
    try { await run(calls); } finally { globalThis.fetch = originalFetch; }
}

const cases: Array<{ name: string; record: AgentInteraction; decision: AgentInteractionDecision; path: string }> = [
    { name: "proposal", record: proposal, decision: { approved: false, reason: "请修改方案" }, path: `/agent/proposal/${encodeURIComponent(base.id)}/decision` },
    { name: "proposal approval", record: proposal, decision: { approved: true }, path: `/agent/proposal/${encodeURIComponent(base.id)}/decision` },
    { name: "question", record: question, decision: { answer: "完整回答\n第二行" }, path: `/agent/question/${encodeURIComponent(base.id)}/answer` },
    { name: "generation-confirm", record: generation, decision: { confirmed: true, decisionSource: "auto" }, path: `/agent/generation-confirm/${encodeURIComponent(base.id)}` },
];

for (const scenario of cases) {
    test(`${scenario.name} uses its exact encoded POST route, token, complete scope and business revision`, async () => {
        await withFetch(async (calls) => {
            await postAgentInteractionDecision(endpoint, token, scope, scenario.record, scenario.decision);
            expect(calls).toHaveLength(1);
            const { url, init } = calls[0];
            expect(url.origin).toBe(endpoint);
            expect(url.pathname).toBe(scenario.path);
            expect(url.searchParams.get("token")).toBe(token);
            expect([...url.searchParams.keys()]).toEqual(["token"]);
            expect(init?.method).toBe("POST");
            expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
            expect(JSON.parse(String(init?.body))).toEqual({ ...scenario.decision, ...scope, expectedInteractionRevision: 7 });
            expect(String(init?.body)).not.toContain("estimatedCost");
            expect(String(init?.body)).not.toContain("permissionMode");
        });
    });
}

test("generation cancellation uses the original T5 route with no /confirm suffix and preserves manual source", async () => {
    await withFetch(async (calls) => {
        await postAgentInteractionDecision(endpoint, token, scope, generation, { confirmed: false, decisionSource: "manual" });
        expect(calls[0].url.pathname).toBe(`/agent/generation-confirm/${encodeURIComponent(base.id)}`);
        expect(calls[0].url.pathname.endsWith("/confirm")).toBe(false);
        expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ confirmed: false, decisionSource: "manual", expectedInteractionRevision: 7 });
    });
});

test("a 202 queued receipt is accepted intact without a second write or read", async () => {
    const receipt = { ok: true, interaction: { ...generation, status: "queued", revision: 8, decision: { confirmed: true, decisionSource: "manual" } } };
    await withFetch(async (calls) => {
        expect<unknown>(await postAgentInteractionDecision(endpoint, token, scope, generation, { confirmed: true, decisionSource: "manual" })).toEqual(receipt);
        expect(calls).toHaveLength(1);
    }, async () => Response.json(receipt, { status: 202 }));
});

test("a 200 idempotent receipt is returned intact without dispatching another request", async () => {
    const receipt = { ok: true, interaction: { ...question, status: "continuing", revision: 8, decision: { answer: "已回答" }, continuationTurnId: "new-turn" } };
    await withFetch(async (calls) => {
        expect<unknown>(await postAgentInteractionDecision(endpoint, token, scope, question, { answer: "已回答" })).toEqual(receipt);
        expect(calls).toHaveLength(1);
    }, async () => Response.json(receipt));
});

test("GET snapshot encodes client/owner/thread/conversation/project and token without a write body", async () => {
    const receipt = { ok: true, interactions: [proposal] };
    await withFetch(async (calls) => {
        expect<unknown>(await fetchAgentInteractions(endpoint, token, scope)).toEqual(receipt);
        expect(calls).toHaveLength(1);
        const { url, init } = calls[0];
        expect(url.pathname).toBe("/agent/interactions");
        expect(Object.fromEntries(url.searchParams)).toEqual({ clientId: scope.clientId, ownerContext: scope.ownerContext, threadId: scope.threadId, conversationId: scope.conversationId, projectId: scope.projectId!, token });
        expect(init?.method || "GET").toBe("GET");
        expect(init?.body).toBeUndefined();
    }, async () => Response.json(receipt));
});

test("GET snapshot encodes a null project as the required empty query value", async () => {
    await withFetch(async (calls) => {
        await fetchAgentInteractions(endpoint, token, { ...scope, projectId: null });
        expect(calls[0].url.searchParams.has("projectId")).toBe(true);
        expect(calls[0].url.searchParams.get("projectId")).toBe("");
    });
});

test("network failure rejects once and never automatically resubmits or starts reconciliation", async () => {
    const failure = new TypeError("synthetic network result unknown");
    await withFetch(async (calls) => {
        await expect(postAgentInteractionDecision(endpoint, token, scope, generation, { confirmed: true })).rejects.toBe(failure);
        expect(calls).toHaveLength(1);
    }, async () => { throw failure; });
});

test("HTTP conflict and unavailable failures preserve AgentApiError and never retry despite retry-after", async () => {
    for (const status of [409, 503]) {
        await withFetch(async (calls) => {
            let caught: unknown;
            try { await postAgentInteractionDecision(endpoint, token, scope, proposal, { approved: true }); } catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(AgentApiError);
            expect((caught as AgentApiError).status).toBe(status);
            expect((caught as AgentApiError).response).toEqual({ code: "synthetic-refusal", error: "合成拒绝" });
            expect(calls).toHaveLength(1);
        }, async () => Response.json({ code: "synthetic-refusal", error: "合成拒绝" }, { status, headers: { "retry-after": "1" } }));
    }
});

test("snapshot failure remains a single read and cannot turn into a decision POST", async () => {
    await withFetch(async (calls) => {
        await expect(fetchAgentInteractions(endpoint, token, scope)).rejects.toBeInstanceOf(AgentApiError);
        expect(calls).toHaveLength(1);
        expect(calls[0].url.pathname).toBe("/agent/interactions");
        expect(calls[0].init?.method || "GET").toBe("GET");
    }, async () => Response.json({ error: "合成读取失败" }, { status: 503 }));
});
