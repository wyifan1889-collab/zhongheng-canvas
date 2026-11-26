import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

import type { AgentAttachment } from "../agent/types.js";
import type { CodexRunOutcome } from "../agent/codex-protocol.js";
import { logger } from "../utils/logger.js";
import { cloneInteraction, continuationIsReadOnly, InteractionError, interactionContinuationMessageText, interactionContinuationPrompt, interactionDecision, interactionKey, interactionReadTools, interactionScope, interactionToolKinds, sameInteractionScope, type ClaimedInteraction, type Interaction, type InteractionKind, type InteractionScope, type ManagedRun, type ManagedRunSettings, type StoredInteraction } from "./interactions.js";
import { buildCanvasToolRequest, fitAttachmentNodeSize } from "./operations.js";
import type { ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, nextCanvasX, parseToolInput } from "./tools.js";
import type { CanvasSnapshot } from "./types.js";

type PendingRequest = { clientId: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
type TurnAttachment = { clientId: string; id: string; name: string; type: string; size: number; width: number; height: number; dataUrl: string };
type ReplayEvent = { type: string; payload: Record<string, unknown> };
export type CodexState = { busy: boolean; threadId: string; turnId: string };
export type McpStartupState = "starting" | "ready" | "failed" | "cancelled";
export type ConversationState = {
    revision: number;
    conversationId: string;
    threadId: string;
    status: "idle" | "preparing" | "ready" | "warning" | "running" | "failed";
    mcpStatuses: Record<string, { status: McpStartupState; error?: string | null; failureReason?: string | null }>;
    sourceClientId?: string;
    error?: string;
};
type McpInventoryItem = { name: string; authStatus?: string };
export const AGENT_PROTOCOL_VERSION = 7;

const SITE_TOOLS = new Set<ToolName>([
    "site_navigate",
    "canvas_list_projects",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
    "generation_get_status",
]);

/** 管理网页画布连接、状态、附件和工具请求。 */
export class CanvasSession {
    private clients = new Map<string, ServerResponse>();
    private clientFocusOrder = new Map<string, number>();
    private pending = new Map<string, PendingRequest>();
    private pendingApprovals = new Map<string, Record<string, unknown>>();
    /** Derived from interactions; decisions still use the scoped interaction state. */
    private pendingQuestions = new Map<string, { questionId: string; text: string }>();
    private pendingProposals = new Map<string, { proposalId: string; summary: string; estimatedCost?: number }>();
    private canvasStates = new Map<string, CanvasSnapshot>();
    private turnAttachments = new Map<string, TurnAttachment>();
    private codexReplayEvents = new Map<string, ReplayEvent>();
    private codexReplayActiveItems = new Set<string>();
    private readonly streamId = crypto.randomUUID();
    private eventSeq = 0;
    private codexMutationBusy = false;
    private activeClientId = "";
    private boundClientId = "";
    private focusSequence = 0;
    private codexState: CodexState = { busy: false, threadId: "", turnId: "" };
    private conversationState: ConversationState;
    private conversationInventoryComplete = false;
    private preparedConversationThreadId = "";
    private clientOwners = new Map<string, string>();
    private clientProjects = new Map<string, string | null>();
    private clientStateReady = new Set<string>();
    private clientConnectionRevisions = new Map<string, number>();
    private interactions = new Map<string, StoredInteraction>();
    private managedRuns = new Map<string, ManagedRun>();
    private managedRunToken = "";

    constructor(activeThreadId = "") {
        this.conversationState = {
            revision: 1,
            conversationId: activeThreadId || crypto.randomUUID(),
            threadId: activeThreadId,
            status: activeThreadId ? "ready" : "idle",
            mcpStatuses: {},
        };
    }

    /** 获取当前目标网页的画布状态。 */
    private get canvasState() {
        return this.clients.has(this.targetClientId) ? this.canvasStates.get(this.targetClientId) || null : null;
    }

    /** 获取当前 turn 绑定或最近激活的网页客户端。 */
    private get targetClientId() {
        return this.boundClientId || this.activeClientId;
    }

    /** 返回 Canvas Agent 当前连接状态。 */
    health() {
        return { ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, hasCanvas: Boolean(this.canvasState), clients: this.clients.size, codexBusy: this.codexState.busy, conversation: this.conversationStateSnapshot };
    }

    /** 返回 Codex 是否正在执行任务。 */
    get codexBusy() {
        return this.codexState.busy;
    }

    get codexThreadId() {
        return this.codexState.threadId;
    }

    /** Return a copy that callers can restore after a temporary Codex operation. */
    get codexStateSnapshot(): CodexState {
        return { ...this.codexState };
    }

    /** 返回站点级对话的权威快照。 */
    get conversationStateSnapshot(): ConversationState {
        return { ...this.conversationState, mcpStatuses: { ...this.conversationState.mcpStatuses } };
    }

    /** 冻结本轮来源和设置；能力令牌仅由受跟踪的运行入口传递。 */
    startManagedRun(scope: InteractionScope, settings: ManagedRunSettings, options: { interaction?: Interaction } = {}) {
        this.assertInteractionScope(scope);
        if (this.managedRunToken) throw new InteractionError(409, "CONVERSATION_BUSY", "当前运行尚未结束");
        let continuationKey: string | undefined;
        let continuation: StoredInteraction | undefined;
        if (options.interaction) {
            continuationKey = interactionKey(scope.threadId, options.interaction.kind, options.interaction.id);
            continuation = this.interactions.get(continuationKey);
            if (!continuation || continuation.interaction.streamId !== this.streamId || continuation.interaction.status !== "continuing" || continuation.continuationRunToken || !sameInteractionScope(scope, interactionScope(continuation.interaction))) throw new InteractionError(409, "INTERACTION_NOT_CLAIMED", "业务续接未取得唯一执行权");
        } else {
            this.assertNoPendingInteraction(scope);
        }
        const token = crypto.randomUUID();
        const run: ManagedRun = { token, scope: cloneInteraction(scope), settings: cloneInteraction(continuation?.settings || settings), connectionRevision: this.clientConnectionRevisions.get(scope.clientId) || 0, turnId: "", fenced: false, readOnly: Boolean(continuation && continuationIsReadOnly(continuation.interaction)), ...(continuationKey ? { continuationKey } : {}) };
        this.managedRuns.set(token, run);
        this.managedRunToken = token;
        if (continuationKey) this.interactions.get(continuationKey)!.continuationRunToken = token;
        return token;
    }

    /** 官方MCP元数据提供来源thread/turn；不从模型工具参数猜测当前run。 */
    managedToolToken(source: unknown): string | undefined {
        if (source === undefined || source === null) {
            return undefined;
        }
        const value = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
        if (typeof value.threadId !== "string" || !value.threadId.trim() || typeof value.turnId !== "string" || !value.turnId.trim()) throw new InteractionError(409, "INTERACTION_RUN_STALE", "工具来源轮次无效");
        const run = [...this.managedRuns.values()].find((entry) => entry.scope.threadId === value.threadId && entry.turnId === value.turnId);
        if (!run) {
            if (!this.managedRunToken && ![...this.interactions.values()].some(({ interaction }) => ["pending", "queued", "continuing"].includes(interaction.status))) return undefined;
            throw new InteractionError(409, "INTERACTION_RUN_STALE", "外部工具来源不能越过当前托管业务流程");
        }
        if (!this.codexState.busy || this.codexState.threadId !== value.threadId || this.codexState.turnId !== value.turnId) throw new InteractionError(409, "INTERACTION_RUN_STALE", "工具来源不是当前托管轮次");
        this.currentManagedRun(run.token);
        return run.token;
    }

    bindManagedTurn(turnId: string, token: string) {
        const run = this.currentManagedRun(token);
        if (!turnId || (run.turnId && run.turnId !== turnId)) throw new InteractionError(409, "INTERACTION_RUN_STALE", "运行轮次已失效");
        run.turnId = turnId;
        if (run.continuationKey) {
            const stored = this.interactions.get(run.continuationKey)!;
            this.updateInteraction(stored, { continuationTurnId: turnId });
        }
    }

    validateManagedRun(token: string) {
        this.currentManagedRun(token);
    }

    /** finally不是成功凭证；只有明确completed才允许原请求进入续接。 */
    finishManagedRun(outcome: CodexRunOutcome, token: string) {
        const run = this.managedRuns.get(token);
        if (!run || run.outcome) return;
        const matching = outcome.threadId === run.scope.threadId && Boolean(run.turnId) && outcome.turnId === run.turnId;
        run.outcome = cloneInteraction(matching ? outcome : { ...outcome, status: "unknown" });
        if (this.managedRunToken === token) this.managedRunToken = "";
        if (run.continuationKey) {
            const stored = this.interactions.get(run.continuationKey)!;
            if (stored.interaction.status === "continuing") this.updateInteraction(stored, { status: this.interactionScopeIsCurrent(run.scope, false) ? run.outcome.status === "completed" ? "completed" : "continuation_failed" : "expired", ...(run.outcome.status === "completed" ? {} : { error: run.outcome.error || `续接轮次${run.outcome.status}` }) });
        }
        if (run.createdInteractionKey && run.outcome.status !== "completed") {
            const stored = this.interactions.get(run.createdInteractionKey)!;
            if (["pending", "queued"].includes(stored.interaction.status)) this.updateInteraction(stored, { status: "expired", error: run.outcome.error || `原轮次${run.outcome.status}，不会自动续接` });
        }
    }

    /** 原子claim，调用方随后必须使用原设置和严格原线程派发。 */
    claimQueuedInteraction(): ClaimedInteraction | null {
        if (this.managedRunToken || this.codexState.busy || this.codexMutationBusy) return null;
        for (const stored of this.interactions.values()) {
            if (stored.interaction.status !== "queued") continue;
            const sourceRun = this.managedRuns.get(stored.sourceRunToken);
            if (!sourceRun?.outcome) continue;
            if (!this.interactionScopeIsCurrent(sourceRun.scope, false) || sourceRun.outcome.status !== "completed") {
                this.updateInteraction(stored, { status: "expired", error: "原请求来源或轮次已失效，不会自动续接" });
                continue;
            }
            if (!this.clients.has(sourceRun.scope.clientId) || !this.clientStateReady.has(sourceRun.scope.clientId)) continue;
            this.updateInteraction(stored, { status: "continuing" });
            return { interaction: cloneInteraction(stored.interaction), settings: cloneInteraction(stored.settings), scope: cloneInteraction(sourceRun.scope), prompt: interactionContinuationPrompt(stored.interaction), messageText: interactionContinuationMessageText(stored.interaction) };
        }
        return null;
    }

    failClaimedInteraction(interaction: Interaction, error: string) {
        const stored = this.interactions.get(interactionKey(interaction.threadId, interaction.kind, interaction.id));
        if (stored?.interaction.streamId === this.streamId && stored.interaction.status === "continuing" && !stored.continuationRunToken) this.updateInteraction(stored, { status: this.interactionScopeIsCurrent(interactionScope(stored.interaction), false) ? "continuation_failed" : "expired", error });
    }

    assertNoPendingInteraction(scope: InteractionScope) {
        this.assertInteractionScope(scope);
        const pending = [...this.interactions.values()].some(({ interaction }) => interaction.threadId === scope.threadId && interaction.conversationId === scope.conversationId && ["pending", "queued", "continuing"].includes(interaction.status));
        if (pending) throw new InteractionError(409, "INTERACTION_PENDING", "当前会话有待处理业务请求，请先决定或回答");
    }

    interactionsForScope(scope: InteractionScope) {
        this.assertInteractionScope(scope);
        return this.visibleInteractions(scope);
    }

    decideInteraction(kind: InteractionKind, id: string, body: Record<string, unknown>) {
        const scope = this.parseInteractionScope(body);
        this.assertInteractionScope(scope);
        const stored = this.interactions.get(interactionKey(scope.threadId, kind, id));
        if (!stored || body.streamId !== this.streamId || !sameInteractionScope(scope, interactionScope(stored.interaction))) throw new InteractionError(409, "INTERACTION_STALE", "业务请求已失效或不属于当前来源");
        const decision = interactionDecision(kind, body);
        if (stored.interaction.decision) {
            if (JSON.stringify(stored.interaction.decision) !== JSON.stringify(decision)) throw new InteractionError(409, "INTERACTION_DECISION_CONFLICT", "该业务请求已有不同决定");
            return { interaction: cloneInteraction(stored.interaction), duplicate: true };
        }
        if (stored.interaction.status === "expired") throw new InteractionError(409, "INTERACTION_EXPIRED", "业务请求已失效");
        if (stored.interaction.status !== "pending" || !Number.isInteger(body.expectedInteractionRevision) || body.expectedInteractionRevision !== stored.interaction.revision) throw new InteractionError(409, "INTERACTION_REVISION_STALE", "业务请求状态已变化，请重新读取");
        this.updateInteraction(stored, { decision, status: "queued" });
        const interaction = stored.interaction;
        const event = kind === "proposal" ? { proposalId: id, approved: (decision as { approved: boolean }).approved, summary: (interaction.input as { summary: string }).summary } : kind === "question" ? { questionId: id, answer: (decision as { answer: string }).answer } : { confirmId: id, confirmed: (decision as { confirmed: boolean }).confirmed };
        this.emitInteraction(kind === "proposal" ? "agent_proposal_decided" : kind === "question" ? "agent_question_answered" : "agent_generation_confirmed", interaction, event);
        return { interaction: cloneInteraction(interaction), duplicate: false };
    }

    private parseInteractionScope(body: Record<string, unknown>): InteractionScope {
        if (![body.clientId, body.ownerContext, body.threadId, body.conversationId].every((value) => typeof value === "string" && value.trim()) || (body.projectId !== null && typeof body.projectId !== "string")) throw new InteractionError(400, "INVALID_INTERACTION_SCOPE", "业务请求来源无效");
        return { clientId: body.clientId as string, ownerContext: body.ownerContext as string, threadId: body.threadId as string, conversationId: body.conversationId as string, projectId: body.projectId === "" ? null : body.projectId as string | null };
    }

    private interactionScopeIsCurrent(scope: InteractionScope, requireConnected = true) {
        return (!requireConnected || this.clients.has(scope.clientId)) && this.clientOwners.get(scope.clientId) === scope.ownerContext && this.conversationState.threadId === scope.threadId && this.conversationState.conversationId === scope.conversationId && (this.clientProjects.get(scope.clientId) ?? null) === scope.projectId;
    }

    private assertInteractionScope(scope: InteractionScope) {
        this.parseInteractionScope(scope as unknown as Record<string, unknown>);
        if (!this.interactionScopeIsCurrent(scope)) throw new InteractionError(409, "INTERACTION_SCOPE_STALE", "业务请求的网页、账号、项目或会话已变化");
    }

    private visibleInteractions(scope: InteractionScope) {
        return [...this.interactions.values()].flatMap(({ interaction }) => sameInteractionScope(scope, interactionScope(interaction)) ? [cloneInteraction(interaction)] : []);
    }

    private currentManagedRun(token: string) {
        const run = this.managedRuns.get(token);
        if (!token || !run || token !== this.managedRunToken || run.outcome) throw new InteractionError(409, "INTERACTION_RUN_STALE", "工具调用的运行能力已失效");
        this.assertInteractionScope(run.scope);
        if (run.turnId && (this.boundClientId !== run.scope.clientId || !this.codexState.busy || this.codexState.threadId !== run.scope.threadId || this.codexState.turnId !== run.turnId)) throw new InteractionError(409, "INTERACTION_RUN_STALE", "工具调用已脱离原绑定轮次");
        return run;
    }

    private expireChangedInteractions() {
        this.interactions.forEach((stored) => {
            if (["pending", "queued", "continuing"].includes(stored.interaction.status) && !this.interactionScopeIsCurrent(interactionScope(stored.interaction), false)) this.updateInteraction(stored, { status: "expired", error: "原网页账号、项目或会话已变化" });
        });
    }

    private updateInteraction(stored: StoredInteraction, patch: Partial<Interaction>) {
        stored.interaction = { ...stored.interaction, ...patch, revision: stored.interaction.revision + 1 } as Interaction;
        this.indexPendingQuestion(stored.interaction);
        this.indexPendingProposal(stored.interaction);
        this.emitInteraction("agent_interaction_updated", stored.interaction);
    }

    private indexPendingQuestion(interaction: Interaction) {
        if (interaction.kind !== "question") return;
        const key = interactionKey(interaction.threadId, "question", interaction.id);
        if (interaction.status === "pending" && !interaction.decision) this.pendingQuestions.set(key, { questionId: interaction.id, text: interaction.input.question });
        else this.pendingQuestions.delete(key);
    }

    private indexPendingProposal(interaction: Interaction) {
        if (interaction.kind !== "proposal") return;
        const key = interactionKey(interaction.threadId, "proposal", interaction.id);
        if (interaction.status === "pending" && !interaction.decision) this.pendingProposals.set(key, { proposalId: interaction.id, summary: interaction.input.summary,
            ...(interaction.input.estimatedCost === undefined ? {} : { estimatedCost: interaction.input.estimatedCost }) });
        else this.pendingProposals.delete(key);
    }

    private emitInteraction(type: string, interaction: Interaction, extra: Record<string, unknown> = {}) {
        const client = this.clients.get(interaction.sourceClientId);
        if (!client || this.clientOwners.get(interaction.sourceClientId) !== interaction.ownerContext) return;
        const data = this.sequenceEvent({ ...extra, interaction: cloneInteraction(interaction), threadId: interaction.threadId, turnId: interaction.sourceTurnId, sourceClientId: interaction.sourceClientId, ownerContext: interaction.ownerContext });
        sendEvent(client, type, data, this.eventId(data.seq, interaction.sourceClientId, interaction.threadId));
    }

    /** 原子开始一次新建或恢复对话流程。 */
    beginConversation(options: { threadId?: string; conversationId?: string; sourceClientId?: string } = {}) {
        this.conversationInventoryComplete = false;
        this.preparedConversationThreadId = "";
        return this.updateConversation({
            conversationId: options.conversationId || options.threadId || crypto.randomUUID(),
            threadId: options.threadId || "",
            status: "preparing",
            mcpStatuses: {},
            sourceClientId: options.sourceClientId,
            error: undefined,
        });
    }

    /** 记录预热阶段单个 MCP 服务的启动状态。 */
    updateConversationMcp(name: string, status: McpStartupState, error?: string | null, failureReason?: string | null) {
        if (!name || this.conversationState.status !== "preparing") return this.conversationStateSnapshot;
        const snapshot = this.updateConversation({
            mcpStatuses: { ...this.conversationState.mcpStatuses, [name]: { status, error, failureReason } },
        });
        return this.conversationInventoryComplete && this.preparedConversationThreadId
            ? this.completeConversationPreparation(this.preparedConversationThreadId)
            : snapshot;
    }

    /** 用 app-server 的完整 MCP 清单补齐未发送逐项通知的服务。 */
    completeConversationMcpInventory(services: McpInventoryItem[]) {
        if (this.conversationState.status !== "preparing") return this.conversationStateSnapshot;
        const mcpStatuses = { ...this.conversationState.mcpStatuses };
        services.filter((item) => item.name).forEach((item) => {
            const current = mcpStatuses[item.name];
            if (current?.status === "failed" || current?.status === "cancelled") return;
            mcpStatuses[item.name] = item.authStatus === "notLoggedIn"
                ? { status: "failed", error: "MCP 服务未登录", failureReason: "reauthenticationRequired" }
                : { status: "ready" };
        });
        this.conversationInventoryComplete = true;
        return this.updateConversation({ mcpStatuses });
    }

    /** MCP 清单读取结束后提交线程和最终可发送状态。 */
    completeConversationPreparation(threadId: string) {
        this.preparedConversationThreadId = threadId;
        const statuses = this.conversationState.mcpStatuses;
        const hasPending = !this.conversationInventoryComplete || Object.values(statuses).some((item) => item.status === "starting");
        const requiredFailure = statuses["infinite-canvas"]?.status !== "ready";
        const hasFailure = Object.values(statuses).some((item) => item.status === "failed" || item.status === "cancelled");
        const requiredFailureDetail = statuses["infinite-canvas"]?.error;
        return this.updateConversation({
            threadId,
            status: hasPending ? "preparing" : requiredFailure ? "failed" : hasFailure ? "warning" : "ready",
            error: requiredFailure ? `Infinite Canvas MCP 初始化失败${requiredFailureDetail ? `：${requiredFailureDetail}` : ""}` : undefined,
        });
    }

    /** 将创建线程或读取 MCP 清单的失败保存为不可发送状态。 */
    failConversationPreparation(error: string) {
        this.conversationInventoryComplete = false;
        this.preparedConversationThreadId = "";
        return this.updateConversation({ status: "failed", error });
    }

    /** 切换到无需重新预热的既有状态，例如删除当前对话后的空状态。 */
    activateConversation(threadId: string, sourceClientId?: string) {
        this.conversationInventoryComplete = false;
        this.preparedConversationThreadId = "";
        return this.updateConversation({
            conversationId: threadId || crypto.randomUUID(),
            threadId,
            status: threadId ? "ready" : "idle",
            mcpStatuses: {},
            sourceClientId,
            error: undefined,
        });
    }

    markConversationRunning(threadId: string) {
        if (!threadId || threadId !== this.conversationState.threadId || !["ready", "warning"].includes(this.conversationState.status)) return this.conversationStateSnapshot;
        return this.updateConversation({ status: "running" });
    }

    finishConversationRun(threadId: string) {
        if (!threadId || threadId !== this.conversationState.threadId) return this.conversationStateSnapshot;
        const hasFailure = Object.values(this.conversationState.mcpStatuses).some((item) => item.status === "failed" || item.status === "cancelled");
        return this.updateConversation({ status: hasFailure ? "warning" : "ready" });
    }

    /** 判断网页客户端是否仍连接到当前 Agent。 */
    hasClient(clientId: string) {
        return this.clients.has(clientId);
    }

    /** 读取指定网页上报的画布，避免提炼时受最近焦点或其他标签页影响。 */
    canvasStateForClient(clientId: string) {
        return this.clients.has(clientId) ? this.canvasStates.get(clientId) || null : null;
    }

    /** 原子取得 Codex 写操作权限，避免多个网页并发切换或修改会话。 */
    beginCodexMutation() {
        if (this.codexState.busy || this.codexMutationBusy) return false;
        this.codexMutationBusy = true;
        return true;
    }

    /** 释放 Codex 写操作权限。 */
    endCodexMutation() {
        this.codexMutationBusy = false;
    }

    /** 返回当前 Codex turn 的线程、turn 和发起网页。 */
    get codexEventScope() {
        return {
            threadId: this.codexState.threadId,
            turnId: this.codexState.busy ? this.codexState.turnId : "",
            sourceClientId: this.codexState.busy ? this.boundClientId : "",
        };
    }

    /** 返回刷新后仍需展示的 Codex 权限请求。 */
    get codexPendingApprovals() {
        return [...this.pendingApprovals.values()];
    }

    /** 跟踪权限请求，并按当前托管来源规范化业务提问与提案。 */
    trackCodexEvent(type: string, payload: Record<string, unknown>) {
        if (type === "agent_question" || type === "agent_proposal") {
            // Direct events must identify a current managed run, not borrow its
            // identity from a business ID. Its frozen scope remains authoritative.
            try {
                if (![payload.threadId, payload.turnId, payload.sourceClientId, payload.ownerContext].every(value => typeof value === "string" && value.trim())) return false;
                const token = this.managedToolToken({ threadId: payload.threadId, turnId: payload.turnId });
                if (!token) return false;
                const run = this.currentManagedRun(token);
                if (payload.sourceClientId !== run.scope.clientId || payload.ownerContext !== run.scope.ownerContext ||
                    (payload.streamId !== undefined && payload.streamId !== this.streamId) ||
                    (payload.conversationId !== undefined && payload.conversationId !== run.scope.conversationId) ||
                    (payload.projectId !== undefined && payload.projectId !== run.scope.projectId) ||
                    (run.connectionRevision !== this.clientConnectionRevisions.get(run.scope.clientId) && !this.clientStateReady.has(run.scope.clientId))) return false;
                const snapshot = payload.interaction;
                const kind = type === "agent_question" ? "question" : "proposal";
                const id = kind === "question" ? payload.questionId : payload.proposalId;
                let placeholder = payload.placeholder;
                let estimatedCost = payload.estimatedCost;
                let actions: unknown = payload.actions === undefined ? [] : payload.actions;
                if (snapshot !== undefined) {
                    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
                    const interaction = snapshot as Record<string, unknown>;
                    const input = recordValue(interaction.input);
                    if (interaction.kind !== kind || interaction.id !== id || interaction.streamId !== this.streamId ||
                        interaction.sourceTurnId !== run.turnId || !sameInteractionScope(run.scope, {
                            clientId: interaction.sourceClientId as string, ownerContext: interaction.ownerContext as string,
                            threadId: interaction.threadId as string, conversationId: interaction.conversationId as string, projectId: interaction.projectId as string | null,
                        })) return false;
                    if (kind === "question") {
                        if (input.questionId !== id || input.question !== payload.text ||
                            (placeholder !== undefined && input.placeholder !== undefined && placeholder !== input.placeholder)) return false;
                        if (placeholder === undefined) placeholder = input.placeholder;
                    } else {
                        if (input.proposalId !== id || input.summary !== payload.summary ||
                            (estimatedCost !== undefined && estimatedCost !== input.estimatedCost) ||
                            (payload.actions !== undefined && JSON.stringify(payload.actions) !== JSON.stringify(input.actions))) return false;
                        estimatedCost = input.estimatedCost;
                        actions = input.actions;
                    }
                }
                const input = kind === "question"
                    ? parseToolInput("canvas_ask_user", { questionId: id, question: payload.text, ...(placeholder === undefined ? {} : { placeholder }) })
                    : parseToolInput("canvas_create_proposal", { proposalId: id, summary: payload.summary, actions, ...(estimatedCost === undefined ? {} : { estimatedCost }) });
                this.createInteraction(kind, input as Record<string, unknown>, run);
            } catch { /* Invalid/stale direct events never create actionable cards. */ }
            // The session sends the canonical scoped event; never broadcast the
            // original payload a second time (including rejected direct events).
            return false;
        }
        const requestId = String(payload.requestId || "");
        if (type === "codex_approval" && requestId) this.pendingApprovals.set(requestId, payload);
        if (type === "codex_approval_resolved" && requestId) this.pendingApprovals.delete(requestId);
        if (type === "agent_error") this.pendingApprovals.clear();
        return true;
    }

    /** 更新并广播 Codex 运行状态；静默后台活动可保留上一 turn 的断线重放。 */
    setCodexState(patch: Partial<CodexState>, options: { preserveReplay?: boolean } = {}) {
        const next = { ...this.codexState, ...patch };
        const threadChanged = next.threadId !== this.codexState.threadId;
        const turnChanged = Boolean(this.codexState.turnId && next.turnId && next.turnId !== this.codexState.turnId);
        const nextTurnStarted = !this.codexState.busy && next.busy;
        if (!options.preserveReplay && (threadChanged || turnChanged || nextTurnStarted)) {
            this.codexReplayEvents.clear();
            this.codexReplayActiveItems.clear();
        }
        if (!next.busy) {
            if (this.boundClientId && !this.clients.has(this.boundClientId)) this.boundClientId = "";
        }
        if (next.busy === this.codexState.busy && next.threadId === this.codexState.threadId && next.turnId === this.codexState.turnId) return;
        this.codexState = next;
        logger.debug("Codex state changed", this.codexState);
        this.emitAll("codex_state", this.codexState);
    }

    /** 权威历史已覆盖指定 turn 后，清理其断线重放事件。 */
    acknowledgeCodexHistory(threadId: string, turnIds: string[]) {
        const acknowledged = new Set(turnIds.filter(Boolean));
        if (!threadId || !acknowledged.size) return;
        this.codexReplayEvents.forEach((event, key) => {
            const eventThreadId = String(event.payload.threadId || event.payload.thread_id || "");
            const eventTurnId = String(event.payload.turnId || event.payload.turn_id || "");
            if (eventThreadId === threadId && acknowledged.has(eventTurnId)) {
                this.codexReplayEvents.delete(key);
                this.codexReplayActiveItems.delete(key);
            }
        });
    }

    /** 建立网页与 Canvas Agent 之间的 SSE 连接。 */
    openEvents(url: URL, res: ServerResponse, activeThreadId = "", lastEventId?: string) {
        const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
        const statusOnly = url.searchParams.get("role") === "status";
        const ownerContext = url.searchParams.get("ownerContext") || "";
        // Explicit query reconnects must agree with a cursor bound to this
        // stream/client/thread. Partial or invalid query intent never falls
        // through to a header that could silently skip the requested replay.
        const queryResume = url.searchParams.has("after") || url.searchParams.has("resumeId");
        const resumeAfter = statusOnly ? -1 : queryResume
            ? this.queryResumeAfter(url, clientId, activeThreadId)
            : this.resumeAfter(lastEventId, clientId, activeThreadId);
        const replayHead = this.eventSeq;
        const replayEvents = [...this.codexReplayEvents.values()];
        logger.info("SSE client connected", { clientId, statusOnly });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (!statusOnly) {
            this.clients.set(clientId, res);
            this.clientStateReady.delete(clientId);
            this.clientConnectionRevisions.set(clientId, (this.clientConnectionRevisions.get(clientId) || 0) + 1);
            this.clientOwners.set(clientId, ownerContext);
            this.expireChangedInteractions();
            if (!this.clientFocusOrder.has(clientId)) this.clientFocusOrder.set(clientId, 0);
            if (!this.activeClientId) {
                this.activeClientId = clientId;
                this.clientFocusOrder.set(clientId, ++this.focusSequence);
            }
        }
        const scope = { clientId, ownerContext, threadId: activeThreadId, conversationId: this.conversationState.conversationId, projectId: this.clientProjects.get(clientId) ?? null };
        sendEvent(res, "hello", { ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, clientId, ownerContext, streamId: this.streamId, resumeThreadId: activeThreadId, resumeAfter, workspace: { activeThreadId }, conversation: this.conversationStateSnapshot, codex: this.codexState, pendingApprovals: this.codexPendingApprovals, interactions: !statusOnly && ownerContext && this.interactionScopeIsCurrent(scope) ? this.visibleInteractions(scope) : [] });
        if (!statusOnly) {
            if (activeThreadId && this.codexState.threadId === activeThreadId) replayEvents.forEach((event) => {
                if (Number(event.payload.seq) > resumeAfter) sendEvent(res, event.type, event.payload);
            });
            // Snapshots keep item-start order, not sequence order. Commit the transport
            // cursor only after the whole batch so a partial reconnect cannot skip items.
            sendEvent(res, "replay_complete", { lastSeq: replayHead }, this.eventId(replayHead, clientId, activeThreadId));
        }
        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
        res.on("close", () => {
            clearInterval(timer);
            logger.info("SSE client disconnected", { clientId, statusOnly });
            if (statusOnly || this.clients.get(clientId) !== res) return;
            this.clients.delete(clientId);
            this.clientStateReady.delete(clientId);
            this.clientFocusOrder.delete(clientId);
            this.canvasStates.delete(clientId);
            this.pending.forEach((item, requestId) => {
                if (item.clientId !== clientId) return;
                this.pending.delete(requestId);
                item.reject(new Error("请求页面已断开"));
            });
            if (this.activeClientId === clientId) this.activeClientId = [...this.clients.keys()].sort((a, b) => (this.clientFocusOrder.get(b) || 0) - (this.clientFocusOrder.get(a) || 0))[0] || "";
        });
    }

    private updateConversation(patch: Partial<Omit<ConversationState, "revision">>) {
        this.conversationState = { ...this.conversationState, ...patch, revision: this.conversationState.revision + 1 };
        this.expireChangedInteractions();
        const snapshot = this.conversationStateSnapshot;
        this.emitAll("conversation_changed", snapshot);
        return snapshot;
    }

    /** 保存指定网页上报的最新画布快照。 */
    updateState(body: unknown, clientId?: string) {
        const targetClientId = clientId || this.activeClientId;
        if (!targetClientId || !this.clients.has(targetClientId)) return;
        const state = { ...((body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>), clientId: targetClientId } as CanvasSnapshot;
        this.canvasStates.set(targetClientId, state);
        this.clientProjects.set(targetClientId, typeof state.projectId === "string" && state.projectId ? state.projectId : null);
        if (body && typeof body === "object" && !Array.isArray(body) && (state.projectId == null || typeof state.projectId === "string")) this.clientStateReady.add(targetClientId);
        this.expireChangedInteractions();
        logger.debug("Canvas state updated", { clientId: targetClientId, nodes: state.nodes?.length || 0, connections: state.connections?.length || 0 });
    }

    /** 将指定网页设为最近激活的工具目标。 */
    activateClient(clientId: string) {
        if (!this.clients.has(clientId)) throw new Error("当前网页未连接");
        this.activeClientId = clientId;
        this.clientFocusOrder.set(clientId, ++this.focusSequence);
        logger.debug("Canvas client activated", { clientId });
    }

    /** 将当前 Agent turn 固定绑定到指定网页。 */
    bindClient(clientId: string) {
        if (!this.clients.has(clientId)) throw new Error("当前网页未连接");
        this.boundClientId = clientId;
        logger.debug("Canvas client bound to turn", { clientId });
    }

    /** 解除当前 Agent turn 的网页绑定。 */
    releaseClient(clientId: string) {
        if (this.boundClientId === clientId) this.boundClientId = "";
        logger.debug("Canvas client released from turn", { clientId });
    }

    /** 保存当前 turn 可用的图片附件并返回安全引用。 */
    setTurnAttachments(clientId: string, attachments: AgentAttachment[]) {
        this.turnAttachments.clear();
        return attachments.flatMap((item, index) => {
            if (!item.dataUrl?.startsWith("data:image/")) return [];
            const id = item.id?.trim() || `attachment-${crypto.randomUUID()}`;
            const attachment: TurnAttachment = {
                clientId,
                id,
                name: item.name?.trim() || `图片 ${index + 1}`,
                type: item.type?.startsWith("image/") ? item.type : item.dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png",
                size: positiveNumber(item.size, 0),
                width: positiveNumber(item.width, 1024),
                height: positiveNumber(item.height, 1024),
                dataUrl: item.dataUrl,
            };
            this.turnAttachments.set(id, attachment);
            return [{ id, name: attachment.name, type: attachment.type, size: attachment.size, width: attachment.width, height: attachment.height }];
        });
    }

    /** 清理指定网页或全部 turn 附件。 */
    clearTurnAttachments(clientId?: string) {
        this.turnAttachments.forEach((item, id) => {
            if (!clientId || item.clientId === clientId) this.turnAttachments.delete(id);
        });
    }

    /** 获取属于指定网页 turn 的图片附件。 */
    getTurnAttachment(clientId: string, attachmentId: string) {
        const attachment = this.turnAttachments.get(attachmentId);
        if (!attachment) throw new Error(`找不到本轮图片附件：${attachmentId}`);
        if (attachment.clientId !== clientId) throw new Error("图片附件不属于当前 turn 的发起标签页");
        return attachment;
    }

    /** 接收网页返回的工具调用结果。 */
    resolveResult(clientId: string, body: { requestId?: string; error?: string; result?: unknown }) {
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!item || !body.requestId || item.clientId !== clientId) return false;
        this.pending.delete(body.requestId);
        logger.debug("Canvas tool result received", { clientId, requestId: body.requestId, error: body.error, result: body.result });
        body.error ? item.reject(new Error(body.error)) : item.resolve(body.result);
        return true;
    }

    /** 向全部已连接网页广播事件。 */
    emitAll(type: string, payload: unknown) {
        this.broadcastEvent(type, this.sequenceEvent(payload));
    }

    private sequenceEvent(payload: unknown): Record<string, unknown> & { seq: number } {
        return { ...recordValue(payload), seq: ++this.eventSeq };
    }

    private broadcastEvent(type: string, payload: Record<string, unknown> & { seq: number }) {
        this.clients.forEach((client, clientId) => sendEvent(client, type, payload, this.eventId(payload.seq, clientId, this.conversationState.threadId)));
    }

    private eventId(seq: number, clientId: string, threadId: string) {
        return `v1:${this.streamId}:${encodeURIComponent(clientId)}:${encodeURIComponent(threadId)}:${seq}`;
    }

    private resumeAfter(id: string | undefined, clientId: string, threadId: string) {
        if (!id) return -1;
        const value = id.slice(id.lastIndexOf(":") + 1);
        if (!/^(0|[1-9]\d*)$/.test(value)) return -1;
        const seq = Number(value);
        return Number.isSafeInteger(seq) && seq <= this.eventSeq && id === this.eventId(seq, clientId, threadId) ? seq : -1;
    }

    private queryResumeAfter(url: URL, clientId: string, threadId: string) {
        const after = url.searchParams.getAll("after"), ids = url.searchParams.getAll("resumeId");
        if (after.length !== 1 || ids.length !== 1 || !/^(0|[1-9]\d*)$/.test(after[0]!)) return -1;
        const seq = Number(after[0]);
        return Number.isSafeInteger(seq) && seq === this.resumeAfter(ids[0], clientId, threadId) ? seq : -1;
    }

    /** 向全部网页广播带线程归属的事件。 */
    emitThread(type: string, threadId: string, payload: Record<string, unknown> = {}) {
        const data = this.sequenceEvent({ ...payload, threadId });
        const replayKey = codexReplayKey(type, data);
        const eventTurnId = String(data.turnId || data.turn_id || "");
        const currentScope = threadId === this.codexState.threadId && (!this.codexState.turnId || !eventTurnId || eventTurnId === this.codexState.turnId);
        if (this.codexState.busy && currentScope && replayKey) {
            const item = recordValue(data.item);
            const eventType = String(data.type || "");
            if (type === "agent_event" && item.id && (eventType === "item.started" || eventType === "item.updated")) this.codexReplayActiveItems.add(replayKey);
            if (type === "agent_event" && item.id && eventType === "item.completed") this.codexReplayActiveItems.delete(replayKey);
            if (type === "agent_event" && (eventType === "turn.completed" || eventType === "error")) this.clearReplayActiveTurn(threadId, eventTurnId);
            const replayData = this.replaySnapshot(replayKey, data);
            this.codexReplayEvents.set(replayKey, { type, payload: { ...replayData, replayed: true } });
            while (this.codexReplayEvents.size > 240) {
                const evictable = [...this.codexReplayEvents.keys()].find((key) => !this.codexReplayActiveItems.has(key));
                if (!evictable) break;
                this.codexReplayEvents.delete(evictable);
            }
        }
        this.broadcastEvent(type, data);
    }

    /** 为断线重连保存完整的最新文本快照，实时连接仍只接收增量。 */
    private replaySnapshot(replayKey: string, data: Record<string, unknown>) {
        if (data.type !== "item.updated" && data.type !== "item.completed") return data;
        const item = recordValue(data.item);
        if (!item.id) return data;
        const previous = recordValue(recordValue(this.codexReplayEvents.get(replayKey)?.payload).item);
        const delta = String(item.delta || "");
        if (!delta) return data;
        const previousText = String(previous.text || "");
        const { delta: _delta, ...snapshotItem } = item;
        return { ...data, item: { ...previous, ...snapshotItem, text: `${previousText}${delta}` } };
    }

    private clearReplayActiveTurn(threadId: string, turnId: string) {
        const prefix = `item:${turnId}:`;
        this.codexReplayActiveItems.forEach((key) => {
            if (key.startsWith(prefix)) this.codexReplayActiveItems.delete(key);
        });
        if (!turnId) return;
        this.codexReplayActiveItems.forEach((key) => {
            const event = this.codexReplayEvents.get(key);
            const eventThreadId = String(event?.payload.threadId || event?.payload.thread_id || "");
            const eventTurnId = String(event?.payload.turnId || event?.payload.turn_id || "");
            if (eventThreadId === threadId && eventTurnId === turnId) this.codexReplayActiveItems.delete(key);
        });
    }

    /** 校验工具参数并将调用分派到当前目标网页。 */
    async callTool(name: unknown, rawInput: unknown, runToken?: string) {
        if (!isToolName(name)) throw new Error(`未知工具：${String(name)}`);
        logger.info("MCP tool called", { name, input: rawInput, targetClientId: this.targetClientId });
        const input = parseToolInput(name, rawInput) as Record<string, unknown>;
        const interactionKind = interactionToolKinds[name as keyof typeof interactionToolKinds];
        const run = runToken ? this.currentManagedRun(runToken) : undefined;
        if (run && !interactionReadTools.has(name) && run.connectionRevision !== this.clientConnectionRevisions.get(run.scope.clientId) && !this.clientStateReady.has(run.scope.clientId)) throw new InteractionError(409, "INTERACTION_SCOPE_UNCONFIRMED", "发起网页重连后尚未确认当前项目，请等待状态同步");
        if (interactionKind) {
            if (!run) throw new InteractionError(409, "INTERACTION_UNMANAGED_RUN", "业务请求仅允许当前受跟踪的Codex运行创建");
            return this.createInteraction(interactionKind, input, run);
        }
        if (!interactionReadTools.has(name)) {
            if (!run && (this.managedRunToken || [...this.interactions.values()].some(({ interaction }) => ["pending", "queued", "continuing"].includes(interaction.status)))) throw new InteractionError(409, "INTERACTION_RUN_REQUIRED", "写工具调用缺少当前运行能力");
            if (run && (run.fenced || run.readOnly)) throw new InteractionError(409, run.readOnly ? "INTERACTION_READ_ONLY" : "INTERACTION_PENDING", run.readOnly ? "本轮决定已拒绝或取消，仅可读取或提出新的业务请求" : "本轮已创建业务等待请求，请结束当前轮次等待新消息续接");
        }
        if (SITE_TOOLS.has(name)) {
            if (!this.clients.size) throw new Error("当前没有已连接网页");
            return await this.requestCanvasTool(name, input);
        }
        const readTool = ["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"].includes(name);
        if (readTool && (!this.clients.size || !this.canvasState)) throw new Error("当前没有已连接画布");
        if (name === "canvas_get_state" || name === "canvas_export_snapshot") return compactCanvasState(this.canvasState);
        if (name === "canvas_get_selection") {
            const ids = new Set(this.canvasState?.selectedNodeIds || []);
            return { nodes: (this.canvasState?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }
        if (name === "canvas_create_attachment_nodes") return await this.createAttachmentNodes(input as { attachmentIds: string[]; x?: number; y?: number; gap?: number; direction?: "row" | "column" });
        if (!this.clients.size) throw new Error("当前没有已连接画布");
        const request = buildCanvasToolRequest(name, input, this.canvasState);
        return await this.requestCanvasTool(request.name, request.input);
    }

    private createInteraction(kind: InteractionKind, input: Record<string, unknown>, run: ManagedRun) {
        if (!run.turnId || !this.codexState.busy || this.codexState.threadId !== run.scope.threadId || this.codexState.turnId !== run.turnId || this.boundClientId !== run.scope.clientId) throw new InteractionError(409, "INTERACTION_RUN_STALE", "业务请求没有当前绑定的Codex轮次");
        const id = String(input[kind === "proposal" ? "proposalId" : kind === "question" ? "questionId" : "confirmId"]);
        const key = interactionKey(run.scope.threadId, kind, id);
        if (run.createdInteractionKey && run.createdInteractionKey !== key) throw new InteractionError(409, "INTERACTION_TURN_CONFLICT", "同一轮次最多创建一个业务等待请求");
        const existing = this.interactions.get(key);
        if (existing) {
            if (!sameInteractionScope(run.scope, interactionScope(existing.interaction)) || JSON.stringify(existing.interaction.input) !== JSON.stringify(input)) throw new InteractionError(409, "INTERACTION_ID_CONFLICT", "该业务标识已用于不同内容或来源");
            run.createdInteractionKey = key;
            run.fenced = true;
            this.indexPendingQuestion(existing.interaction);
            this.indexPendingProposal(existing.interaction);
            return this.interactionToolResult(existing.interaction);
        }
        if ([...this.interactions.values()].some(({ interaction }) => interaction.threadId === run.scope.threadId && interaction.conversationId === run.scope.conversationId && ["pending", "queued"].includes(interaction.status))) throw new InteractionError(409, "INTERACTION_PENDING", "当前会话仍有待处理业务请求");
        const interaction = { id, kind, input: cloneInteraction(input), streamId: this.streamId, threadId: run.scope.threadId, conversationId: run.scope.conversationId, sourceTurnId: run.turnId, sourceClientId: run.scope.clientId, projectId: run.scope.projectId, ownerContext: run.scope.ownerContext, revision: 1, status: "pending" } as Interaction;
        const stored: StoredInteraction = { interaction, settings: cloneInteraction(run.settings), sourceRunToken: run.token };
        this.interactions.set(key, stored);
        this.indexPendingQuestion(interaction);
        this.indexPendingProposal(interaction);
        run.createdInteractionKey = key;
        run.fenced = true;
        this.emitInteraction("agent_interaction_created", interaction);
        if (interaction.kind === "question") this.emitInteraction("agent_question", interaction, { questionId: interaction.id, text: interaction.input.question });
        if (interaction.kind === "proposal") this.emitInteraction("agent_proposal", interaction, { proposalId: interaction.id, summary: interaction.input.summary,
            ...(interaction.input.estimatedCost === undefined ? {} : { estimatedCost: interaction.input.estimatedCost }) });
        return this.interactionToolResult(interaction);
    }

    private interactionToolResult(interaction: Interaction) {
        const idField = interaction.kind === "proposal" ? "proposalId" : interaction.kind === "question" ? "questionId" : "confirmId";
        return { ok: true, [idField]: interaction.id, message: "业务请求已记录。结束当前轮次；用户决定或回答后将以新消息续接原线程。预估不构成正式报价或钱包授权。", interaction: cloneInteraction(interaction) };
    }

    /** 将当前 turn 的附件转换为画布图片节点。 */
    private async createAttachmentNodes(input: { attachmentIds: string[]; x?: number; y?: number; gap?: number; direction?: "row" | "column" }) {
        const clientId = this.targetClientId;
        if (!this.clients.has(clientId)) throw new Error("当前没有已连接画布");
        const attachments = input.attachmentIds.map((id) => this.getTurnAttachment(clientId, id));
        const x = Number(input.x ?? nextCanvasX(this.canvasState));
        const y = Number(input.y ?? 0);
        const gap = Number(input.gap ?? 40);
        const direction = input.direction || "row";
        let offset = 0;
        const nodes = attachments.map((attachment) => {
            const size = fitAttachmentNodeSize(attachment.width, attachment.height);
            const node = {
                id: `image-${crypto.randomUUID()}`,
                attachmentId: attachment.id,
                title: attachment.name,
                position: { x: direction === "row" ? x + offset : x, y: direction === "column" ? y + offset : y },
                width: size.width,
                height: size.height,
            };
            offset += (direction === "row" ? size.width : size.height) + gap;
            return node;
        });
        await this.requestCanvasTool("canvas_create_attachment_nodes", { nodes });
        return { nodes: nodes.map(({ id, attachmentId, title }) => ({ id, attachmentId, title })) };
    }

    /** 向目标网页发送工具请求并等待调用结果。 */
    private async requestCanvasTool(name: ToolName, input: Record<string, unknown>) {
        const requestId = crypto.randomUUID();
        const clientId = this.targetClientId;
        const client = this.clients.get(clientId);
        if (!client) throw new Error("当前没有已连接画布");
        const data = this.sequenceEvent({ requestId, name, input });
        sendEvent(client, "tool_call", data, this.eventId(data.seq, clientId, this.conversationState.threadId));
        logger.debug("Canvas tool request sent", { requestId, name, input, clientId });
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                logger.warn("Canvas tool request timed out", { requestId, name, clientId });
                reject(new Error("画布操作超时"));
            }, 30000);
            this.pending.set(requestId, { clientId, resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (error) => (clearTimeout(timer), reject(error)) });
        });
    }
}

/** 为运行中 turn 的可重放事件生成稳定键。 */
function codexReplayKey(type: string, payload: Record<string, unknown>) {
    const turnId = String(payload.turnId || payload.turn_id || "");
    if (type === "chat_message") {
        const message = recordValue(payload.message);
        const clientMessageId = String(message.clientMessageId || "");
        if (clientMessageId) return `chat:${clientMessageId}`;
        const messageId = String(message.itemId || message.id || "");
        return messageId ? `chat:${turnId}:${messageId}` : "";
    }
    if (type === "agent_error") return `error:${turnId}`;
    if (type !== "agent_event") return "";
    const item = recordValue(payload.item);
    if (item.id) return `item:${turnId}:${String(item.id)}`;
    const eventType = String(payload.type || "");
    if (eventType === "plan.updated") return `plan:${turnId}`;
    if (eventType === "usage.updated") return `usage:${turnId}`;
    if (eventType === "turn.completed" || eventType === "error") return `${eventType}:${turnId}`;
    return "";
}

function recordValue(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 向 SSE 连接写入一个事件。 */
function sendEvent(res: ServerResponse, type: string, payload: unknown, id?: string) {
    res.write(`event: ${type}\n${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}
/** 将未知数值转换为正数，否则使用默认值。 */
function positiveNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}
