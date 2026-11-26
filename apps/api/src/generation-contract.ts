import { z } from "zod";

/**
 * The public generation boundary accepts task intent only. Pricing, usage,
 * provider endpoints and credentials are deliberately absent from this
 * contract and must be resolved by the server.
 */
export type GenerationIntent = {
    modelId: string;
    inputSnapshot: Record<string, unknown>;
    parameterSnapshot: Record<string, unknown>;
    spaceId?: string;
    projectId?: string;
    nodeId?: string;
};

export class GenerationContractError extends Error {
    constructor(
        public readonly code: "invalid_input" | "idempotency_required" | "idempotency_invalid" | "price_changed" | "unsupported_generation",
        message: string,
    ) {
        super(message);
        this.name = "GenerationContractError";
    }
}

const identifier = z.string().trim().min(1).max(200);
const modelId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, "模型 ID 无效");
const jsonObject = z.record(z.string(), z.json());
const intentSchema = z.strictObject({
    modelId,
    input: jsonObject,
    parameters: jsonObject,
    spaceId: identifier.optional(),
    projectId: identifier.optional(),
    nodeId: identifier.optional(),
});
const submissionSchema = intentSchema.extend({ confirmedPriceVersion: z.number().int().positive().refine(Number.isSafeInteger),
    confirmedQuoteFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional() });

function invalid(message: string): never {
    throw new GenerationContractError("invalid_input", message);
}

/** Parse and normalize only the user-controlled generation intent. */
export function parseGenerationIntent(value: unknown): GenerationIntent {
    const result = intentSchema.safeParse(value);
    if (!result.success) invalid("生成请求字段或格式不正确");
    return {
        modelId: result.data.modelId,
        inputSnapshot: result.data.input,
        parameterSnapshot: result.data.parameters,
        ...(result.data.spaceId ? { spaceId: result.data.spaceId } : {}),
        ...(result.data.projectId ? { projectId: result.data.projectId } : {}),
        ...(result.data.nodeId ? { nodeId: result.data.nodeId } : {}),
    };
}

/** A version confirms the displayed server price; callers never supply credit totals. */
export function parseGenerationSubmission(value: unknown): GenerationIntent & { confirmedPriceVersion: number; confirmedQuoteFingerprint?: string } {
    const result = submissionSchema.safeParse(value);
    if (!result.success) invalid("生成请求必须包含已确认的有效价格版本");
    const { confirmedPriceVersion, confirmedQuoteFingerprint, ...intent } = result.data;
    return { ...parseGenerationIntent(intent), confirmedPriceVersion,
        ...(confirmedQuoteFingerprint === undefined ? {} : { confirmedQuoteFingerprint }) };
}

/**
 * Idempotency-Key is intentionally a short token, never an arbitrary JSON
 * value. Reusing it for another intent is handled by the task repository.
 */
export function parseGenerationIdempotencyKey(value: string | null): string {
    if (value === null || value.length === 0) {
        throw new GenerationContractError("idempotency_required", "缺少 Idempotency-Key，请为本次生成提供唯一请求标识");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,197}$/.test(value)) {
        throw new GenerationContractError("idempotency_invalid", "Idempotency-Key 格式或长度不正确");
    }
    return value;
}
