import { z } from "zod/v4";
import { normalizeCreditAmount } from "../../../../packages/shared/src/credit-amounts";
import { parseGenerationImageSpecSnapshot } from "./generation";
import { parseVideoParameters } from "../../../../packages/shared/src/generation-video";
import { GEMINI_IMAGE_PROTOCOL, GEMINI_IMAGE_USAGE, parseGeminiImageIntent } from "../../../../packages/shared/src/generation-gemini-image";
import { validImageGenerationCount } from "../../../../packages/shared/src/generation-image-protocol";
import type { GenerationHistoryQuery } from "./generation-history";

const amount = z.string().refine(value => !value.startsWith("-") && normalizeCreditAmount(value) === value);
const name = z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const historyTitleSchema = z.string().trim().min(1).refine(value => [...value].length <= 100 && !/[\u0000-\u001f\u007f]/.test(value));
const media = z.object({ mediaId: z.uuid(), kind: z.enum(["image", "video", "audio"]), contentType: name,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), etag: name });
type HistoryMedia = z.infer<typeof media>;
const schema = z.object({
    task: z.object({
        id: z.uuid(), projectId: name.nullable(), nodeId: name.nullable().optional(), modelId: name,
        priceVersion: z.number().int().positive().nullable(), quotedUnits: z.number().int().nonnegative().nullable(),
        executionStatus: z.enum(["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"]),
        deliveryStatus: z.enum(["pending", "saved", "visible", "failed", "unknown"]),
        billingStatus: z.enum(["unbilled", "reserved", "captured", "released", "pending_review"]),
        imageSpecSnapshot: z.unknown().transform((value, context) => {
            const parsed = parseGenerationImageSpecSnapshot(value);
            if (!parsed) { context.addIssue({ code: "custom", message: "Invalid image snapshot" }); return z.NEVER; }
            return parsed;
        }).optional(),
        audioSnapshot: z.discriminatedUnion("status", [z.strictObject({ status: z.literal("invalid") }),
            z.strictObject({ status: z.literal("recorded"), input: z.strictObject({ text: z.string().max(200_000) }),
                parameters: z.strictObject({ voice: name, format: z.enum(["mp3", "wav"]), style: z.string().optional(), language: z.string().optional() }) })]).optional(),
        textQuoteSnapshot: z.object({ budgetCredits: amount }).nullable().optional(),
        geminiImage: z.strictObject({ protocol: z.literal(GEMINI_IMAGE_PROTOCOL), usagePolicy: z.literal(GEMINI_IMAGE_USAGE),
            parameters: z.unknown().transform((value, context) => {
                const parsed = parseGeminiImageIntent(value);
                if (!parsed) { context.addIssue({ code: "custom", message: "Invalid native image snapshot" }); return z.NEVER; }
                return parsed;
            }), creditsPerImage: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
        video: z.strictObject({ parameters: z.unknown().transform((value, context) => {
            const parsed = parseVideoParameters(value);
            if (!parsed) { context.addIssue({ code: "custom", message: "Invalid video parameters" }); return z.NEVER; }
            return parsed;
        }), usagePolicy: z.literal("delivered_video"), quotedVideoUnits: z.literal(1), reservedCredits: z.number().int().positive(),
            phase: z.enum(["ready", "rejected", "create_started", "accepted", "polling", "completed", "failed", "unknown"]) }).optional(),
        billing: z.object({ reservedCredits: amount, capturedCredits: amount, releasedCredits: amount }).nullable().optional(),
    }),
    result: z.object({ taskId: z.uuid(), status: z.enum(["succeeded", "failed", "unknown"]), consumedUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        resultSnapshot: z.object({ kind: z.enum(["text", "image", "video", "audio"]).optional(), text: z.string().max(200_000).optional(),
            media: media.optional(), imageMedia: z.array(media).optional() }) }).nullable(),
});
export type HistoryDetail = z.infer<typeof schema>;

/** Project only the existing owner GET's public fields; never expose arbitrary snapshots. */
export function parseHistoryDetail(value: unknown, taskId: string): HistoryDetail | null {
    const parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data.task.id !== taskId || parsed.data.result && parsed.data.result.taskId !== taskId) return null;
    const { task, result } = parsed.data, native = task.geminiImage;
    const raw = (value as { task: Record<string, unknown> }).task;
    if (!native) return raw.billingUnitSnapshot === "image" ? null : parsed.data;
    const billing = task.billing, budget = BigInt(native.parameters.budgetCredits);
    if (task.imageSpecSnapshot || !task.priceVersion || task.quotedUnits !== native.parameters.budgetCredits || raw.billingUnitSnapshot !== "image" ||
        raw.creditsPerUnitSnapshot !== native.creditsPerImage || native.creditsPerImage > native.parameters.budgetCredits || !billing ||
        !Object.values(billing).every(value => /^(0|[1-9]\d*)$/.test(value)) || BigInt(billing.reservedCredits) !== budget ||
        BigInt(billing.capturedCredits) + BigInt(billing.releasedCredits) > budget ||
        task.billingStatus === "released" && (billing.capturedCredits !== "0" || billing.releasedCredits !== billing.reservedCredits)) return null;
    if (result?.resultSnapshot.media) {
        const snapshot = result.resultSnapshot, images = snapshot.imageMedia ?? [snapshot.media!], count = images.length;
        const cost = BigInt(count) * BigInt(native.creditsPerImage);
        if (!validImageGenerationCount(count) || result.consumedUnits !== count || result.status !== "succeeded" || task.executionStatus !== "succeeded" ||
            snapshot.kind !== "image" || cost > budget || new Set(images.map(item => item.mediaId)).size !== count ||
            images.some(item => item.kind !== "image" || item.contentType !== "image/png") ||
            Object.keys(snapshot.media!).some(key => snapshot.media![key as keyof HistoryMedia] !== images[0]![key as keyof HistoryMedia]) ||
            task.billingStatus === "captured" && (BigInt(billing.capturedCredits) !== cost || BigInt(billing.releasedCredits) + cost !== budget)) return null;
    } else if (task.billingStatus === "captured" || result?.resultSnapshot.imageMedia) return null;
    return parsed.data;
}

const returnQuery = z.strictObject({ pageNumber: z.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 50)).optional(),
    pageSize: z.literal(50).optional(), type: z.enum(["text", "image", "audio", "video"]).optional(),
    status: z.enum(["succeeded", "failed", "running", "queued", "pending"]).optional(), search: historyTitleSchema.optional() });
export function parseHistoryReturnQuery(value: unknown): GenerationHistoryQuery | undefined {
    const parsed = returnQuery.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** Only an existing local canvas is a trustworthy canvas destination. */
export function historyOriginTarget(detail: HistoryDetail, localIds: string[]) {
    if (detail.task.video && detail.task.projectId === null && detail.task.nodeId == null) return "/video";
    const id = detail.task.projectId;
    return id && localIds.includes(id) ? `/canvas/${encodeURIComponent(id)}` : null;
}
