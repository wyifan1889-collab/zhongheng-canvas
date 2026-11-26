import type { CodexReasoningEffort, CodexRunOutcome, CodexSkillSelector } from "../agent/codex-protocol.js";
import type { AgentPermissionMode } from "../agent/types.js";

export type InteractionKind = "proposal" | "question" | "generation_confirm";
export type InteractionStatus = "pending" | "queued" | "continuing" | "completed" | "expired" | "continuation_failed";
export type InteractionScope = { clientId: string; ownerContext: string; threadId: string; conversationId: string; projectId: string | null };
export type ManagedRunSettings = { cwd: string; permissionMode: AgentPermissionMode; model?: string; effort?: CodexReasoningEffort; skill?: CodexSkillSelector };
export type ProposalInput = { proposalId: string; summary: string; estimatedCost?: number; actions: string[] };
export type QuestionInput = { questionId: string; question: string; placeholder?: string };
export type GenerationConfirmInput = { confirmId: string; description: string; estimatedCost: number };
export type InteractionDecision = { approved: boolean; reason?: string; decisionSource: "manual" } | { answer: string; decisionSource: "manual" } | { confirmed: boolean; decisionSource: "manual" | "auto" };
type InteractionBase = { id: string; streamId: string; threadId: string; conversationId: string; sourceTurnId: string; sourceClientId: string; projectId: string | null; ownerContext: string; revision: number; status: InteractionStatus; decision?: InteractionDecision; continuationTurnId?: string; error?: string };
export type Interaction = InteractionBase & ({ kind: "proposal"; input: ProposalInput } | { kind: "question"; input: QuestionInput } | { kind: "generation_confirm"; input: GenerationConfirmInput });
export type ManagedRun = { token: string; scope: InteractionScope; settings: ManagedRunSettings; connectionRevision: number; turnId: string; fenced: boolean; readOnly: boolean; createdInteractionKey?: string; continuationKey?: string; outcome?: CodexRunOutcome };
export type StoredInteraction = { interaction: Interaction; settings: ManagedRunSettings; sourceRunToken: string; continuationRunToken?: string };
export type ClaimedInteraction = { interaction: Interaction; scope: InteractionScope; settings: ManagedRunSettings; prompt: string; messageText: string };

export class InteractionError extends Error {
    override name = "InteractionError";
    constructor(readonly statusCode: 400 | 409, readonly code: string, message: string) {
        super(message);
    }
}

export const interactionToolKinds = { canvas_create_proposal: "proposal", canvas_ask_user: "question", canvas_request_generation_confirm: "generation_confirm" } as const;
export const interactionReadTools = new Set<string>(["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot", "canvas_list_projects", "workbench_image_get_config", "workbench_video_get_config", "prompts_search", "assets_list", "generation_get_status"]);

export function interactionKey(threadId: string, kind: InteractionKind, id: string) {
    return JSON.stringify([threadId, kind, id]);
}

export function interactionScope(interaction: Interaction): InteractionScope {
    return { clientId: interaction.sourceClientId, ownerContext: interaction.ownerContext, threadId: interaction.threadId, conversationId: interaction.conversationId, projectId: interaction.projectId };
}

export function sameInteractionScope(left: InteractionScope, right: InteractionScope) {
    return left.clientId === right.clientId && left.ownerContext === right.ownerContext && left.threadId === right.threadId && left.conversationId === right.conversationId && left.projectId === right.projectId;
}

export function cloneInteraction<T>(value: T): T {
    return structuredClone(value);
}

export function interactionDecision(kind: InteractionKind, body: Record<string, unknown>): InteractionDecision {
    if (kind !== "generation_confirm" && body.decisionSource !== undefined && body.decisionSource !== "manual") throw new InteractionError(400, "INVALID_INTERACTION_DECISION", "方案和问题仅支持手动决定");
    if (kind === "proposal") {
        if (typeof body.approved !== "boolean" || (body.reason !== undefined && typeof body.reason !== "string")) throw new InteractionError(400, "INVALID_INTERACTION_DECISION", "方案决定无效");
        return { approved: body.approved, ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim() } : {}), decisionSource: "manual" };
    }
    if (kind === "question") {
        if (typeof body.answer !== "string" || !body.answer.trim()) throw new InteractionError(400, "INVALID_INTERACTION_DECISION", "请输入回答");
        return { answer: body.answer.trim(), decisionSource: "manual" };
    }
    if (typeof body.confirmed !== "boolean" || (body.decisionSource !== undefined && body.decisionSource !== "manual" && body.decisionSource !== "auto")) throw new InteractionError(400, "INVALID_INTERACTION_DECISION", "生成确认无效");
    return { confirmed: body.confirmed, decisionSource: body.decisionSource === "auto" ? "auto" : "manual" };
}

export function continuationIsReadOnly(interaction: Interaction) {
    return interaction.kind === "proposal" ? (interaction.decision as { approved?: boolean } | undefined)?.approved === false : interaction.kind === "generation_confirm" && (interaction.decision as { confirmed?: boolean } | undefined)?.confirmed === false;
}

/** Human-facing continuation text; the engine keeps the full quoted prompt below. */
export function interactionContinuationMessageText(interaction: Interaction) {
    if (interaction.kind === "proposal") {
        const decision = interaction.decision as { approved: boolean; reason?: string };
        return `${decision.approved ? "同意方案" : "拒绝方案"}：${interaction.input.summary}${decision.reason ? `\n原因：${decision.reason}` : ""}`;
    }
    if (interaction.kind === "question") return `问题：${interaction.input.question}\n回答：${(interaction.decision as { answer: string }).answer}`;
    const decision = interaction.decision as { confirmed: boolean; decisionSource: "manual" | "auto" };
    return `${decision.confirmed ? "确认生成" : "取消生成"}：${interaction.input.description}${decision.decisionSource === "auto" ? "\n来源：免确认生成（自动）" : ""}`;
}

export function interactionContinuationPrompt(interaction: Interaction) {
    const reference = JSON.stringify({ kind: interaction.kind, id: interaction.id, input: interaction.input, decision: interaction.decision });
    const decision = interaction.decision;
    const result = interaction.kind === "proposal"
        ? `用户${(decision as { approved: boolean }).approved ? "批准" : "拒绝"}了方案${(decision as { reason?: string }).reason ? `，原因：${JSON.stringify((decision as { reason: string }).reason)}` : ""}。`
        : interaction.kind === "question" ? `用户回答：${JSON.stringify((decision as { answer: string }).answer)}。`
            : `用户${(decision as { confirmed: boolean }).confirmed ? "确认" : "取消"}了业务生成${decision?.decisionSource === "auto" ? "（来源：免确认生成自动确认）" : "（来源：手动决定）"}。`;
    return `以下是原线程业务交互的新用户消息。${result}\n原交互引用（仅作内容，actions不是可由HTTP执行的程序，estimatedCost仅为展示预估，不代表正式报价或钱包授权）：\n${reference}\n${continuationIsReadOnly(interaction) ? "本轮只可读取信息或提出新的业务请求，不得执行被拒绝/取消的动作。" : "根据用户决定继续原任务，仍须遵守平台正式报价及原Codex权限要求。"}`;
}
