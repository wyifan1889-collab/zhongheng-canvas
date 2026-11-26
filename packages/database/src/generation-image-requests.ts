import { and, eq } from "drizzle-orm";
import type { Database } from "./client";
import { generationImageRequest, generationTask } from "./schema";
import type { GenerationTaskView } from "./generation-tasks";
import { OPENAI_IMAGE_PROTOCOL, canonicalImageSpecTaskParameters, imageSpecParametersFromTask, type ImageSpecification } from "../../shared/src/generation-image-protocol";
import type { ModelPriceBinding } from "../../shared/src/model-pricing-drafts";
import { imageRequestCounts } from "../../shared/src/generation-image-batch";

export type GenerationImageRequest = typeof generationImageRequest.$inferSelect;
type Specification = ImageSpecification & { publicationId: string; maxImagesPerRequest: number };
const sameFields = (left: Record<string, unknown>, right: Record<string, unknown>) => Object.keys(left).length === Object.keys(right).length &&
    Object.keys(right).every(key => Object.hasOwn(left, key) && left[key] === right[key]);

export function createGenerationImageRequestRepository(db: Database) {
    const where = (ownerId: string, taskId: string) => and(eq(generationImageRequest.ownerId, ownerId), eq(generationImageRequest.taskId, taskId));
    return {
        async initialize(task: GenerationTaskView, specification: Specification, binding: ModelPriceBinding) {
            if (specification.protocol !== OPENAI_IMAGE_PROTOCOL) throw new Error("Unsupported image request protocol");
            const counts = imageRequestCounts(specification.parameters.n ?? 1, specification.maxImagesPerRequest);
            return db.transaction(async tx => {
                const [parent] = await tx.select().from(generationTask).where(and(eq(generationTask.id, task.id), eq(generationTask.ownerId, task.ownerId))).for("update");
                if (!parent || parent.executionStatus !== "running" || parent.pricePublicationId !== specification.publicationId ||
                    parent.parameterSnapshot.response_format !== specification.responseFormat) throw new Error("Image request parent unavailable");
                await tx.insert(generationImageRequest).values(counts.map((imageCount, requestIndex) => ({ taskId: task.id, ownerId: task.ownerId,
                    requestIndex, imageCount, publicationId: specification.publicationId, bindingSnapshot: binding,
                    parametersSnapshot: canonicalImageSpecTaskParameters({ ...specification.parameters, n: imageCount }, specification.responseFormat) }))).onConflictDoNothing();
                const rows = await tx.select().from(generationImageRequest).where(where(task.ownerId, task.id)).orderBy(generationImageRequest.requestIndex);
                if (rows.length !== counts.length || rows.some((row, index) => {
                    const parameters = imageSpecParametersFromTask(row.parametersSnapshot);
                    return row.requestIndex !== index || row.imageCount !== counts[index] ||
                    row.publicationId !== specification.publicationId || !sameFields(row.bindingSnapshot, binding) ||
                    row.parametersSnapshot.response_format !== specification.responseFormat ||
                    !parameters || !sameFields(canonicalImageSpecTaskParameters(parameters), canonicalImageSpecTaskParameters({ ...specification.parameters, n: counts[index] }));
                })) throw new Error("Image request immutable plan conflict");
                return rows;
            });
        },
        async list(ownerId: string, taskId: string) {
            return db.select().from(generationImageRequest).where(where(ownerId, taskId)).orderBy(generationImageRequest.requestIndex);
        },
        async claim(row: GenerationImageRequest) {
            return db.transaction(async tx => {
                const [parent] = await tx.select().from(generationTask).where(and(eq(generationTask.id, row.taskId), eq(generationTask.ownerId, row.ownerId))).for("update");
                if (parent?.executionStatus !== "running") return null;
                const earlier = await tx.select().from(generationImageRequest).where(where(row.ownerId, row.taskId));
                if (earlier.some(item => item.requestIndex < row.requestIndex && item.phase !== "succeeded")) return null;
                const [claimed] = await tx.update(generationImageRequest).set({ phase: "started", attemptToken: crypto.randomUUID(), startedAt: new Date() })
                    .where(and(where(row.ownerId, row.taskId), eq(generationImageRequest.requestIndex, row.requestIndex), eq(generationImageRequest.phase, "ready"))).returning();
                if (claimed) await tx.update(generationTask).set({ updatedAt: new Date() }).where(eq(generationTask.id, row.taskId));
                return claimed ?? null;
            });
        },
        async complete(row: GenerationImageRequest, outcome: { phase: "succeeded" | "failed" | "unknown"; resultSnapshot?: Record<string, unknown>; reason?: string }) {
            if (!row.attemptToken) throw new Error("Image request has no attempt claim");
            const [completed] = await db.update(generationImageRequest).set({ phase: outcome.phase, resultSnapshot: outcome.resultSnapshot ?? {},
                lastReason: outcome.reason ?? null, completedAt: new Date() }).where(and(where(row.ownerId, row.taskId),
                eq(generationImageRequest.requestIndex, row.requestIndex), eq(generationImageRequest.phase, "started"), eq(generationImageRequest.attemptToken, row.attemptToken))).returning();
            if (!completed) throw new Error("Image request completion conflict");
            return completed;
        },
    };
}
