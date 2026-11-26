import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "./client";
import { generationVideoStage } from "./schema";
import type { GenerationTaskView } from "./generation-tasks";
import { VIDEO_PROTOCOL, parseVideoQuoteSnapshot, sameVideoParameters, type VideoBinding } from "../../shared/src/generation-video";

export type GenerationVideoStage = typeof generationVideoStage.$inferSelect;
export type VideoStagePatch = Partial<Pick<GenerationVideoStage, "phase" | "createAttemptToken" | "createStartedAt" | "providerTaskId" |
    "claimToken" | "leaseUntil" | "nextActionAt" | "inspectAttempts" | "downloadAttempts" | "observationDeadlineAt" |
    "wakeRevision" | "wakeJobId" | "wakeDeadlineAt" | "lastReason" | "lastHttpStatus" | "completedAt" | "durationEvidence" | "probeSnapshot">>;

/** This attachment has no independent task, owner, price, or billing lifecycle. */
export function createGenerationVideoStageRepository(db: Database) {
    const where = (ownerId: string, taskId: string) => and(eq(generationVideoStage.ownerId, ownerId), eq(generationVideoStage.taskId, taskId));
    return {
        async initialize(task: GenerationTaskView, binding: VideoBinding, now = new Date()): Promise<GenerationVideoStage> {
            const quote = parseVideoQuoteSnapshot(task.videoQuoteSnapshot);
            if (!quote || binding.protocol !== VIDEO_PROTOCOL || task.pricePublicationId !== quote.publicationId) throw new Error("Video stage requires the original published quote");
            const [inserted] = await db.insert(generationVideoStage).values({ taskId: task.id, ownerId: task.ownerId, protocol: VIDEO_PROTOCOL,
                providerId: binding.providerId, providerModel: binding.providerModel, endpoint: binding.endpoint,
                pricePublicationId: quote.publicationId, parametersSnapshot: quote.selectedBand.parameters, phase: "ready", nextActionAt: now,
            }).onConflictDoNothing({ target: generationVideoStage.taskId }).returning();
            if (inserted) return inserted;
            const [existing] = await db.select().from(generationVideoStage).where(where(task.ownerId, task.id));
            if (!existing || existing.protocol !== binding.protocol || existing.providerId !== binding.providerId || existing.providerModel !== binding.providerModel ||
                existing.endpoint !== binding.endpoint || existing.pricePublicationId !== quote.publicationId || !sameVideoParameters(existing.parametersSnapshot, quote.selectedBand.parameters)) {
                throw new Error("Video stage immutable binding conflict");
            }
            return existing;
        },
        async get(ownerId: string, taskId: string): Promise<GenerationVideoStage | null> {
            const [row] = await db.select().from(generationVideoStage).where(where(ownerId, taskId)); return row ?? null;
        },
        /** Must be invoked inside the caller's task/queue transaction. */
        async lock(ownerId: string, taskId: string): Promise<GenerationVideoStage | null> {
            const [row] = await db.select().from(generationVideoStage).where(where(ownerId, taskId)).for("update"); return row ?? null;
        },
        async update(current: GenerationVideoStage, patch: VideoStagePatch): Promise<GenerationVideoStage> {
            if (current.providerTaskId && patch.providerTaskId !== undefined && current.providerTaskId !== patch.providerTaskId) throw new Error("Video provider identity cannot change");
            if (current.createAttemptToken && patch.createAttemptToken !== undefined && patch.createAttemptToken !== current.createAttemptToken) throw new Error("Video create can be claimed only once");
            const [updated] = await db.update(generationVideoStage).set({ ...patch, revision: current.revision + 1, updatedAt: new Date() })
                .where(and(where(current.ownerId, current.taskId), eq(generationVideoStage.revision, current.revision))).returning();
            if (!updated) throw new Error("Video stage revision conflict"); return updated;
        },
        async due(now: Date, limit: number): Promise<GenerationVideoStage[]> {
            if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Video recovery batch must be configured");
            return db.select().from(generationVideoStage).where(and(lte(generationVideoStage.nextActionAt, now),
                or(isNull(generationVideoStage.wakeDeadlineAt), lte(generationVideoStage.wakeDeadlineAt, now))))
                .orderBy(generationVideoStage.nextActionAt, generationVideoStage.taskId).limit(limit);
        },
    };
}

/** Status only: SQL/driver have the same row lock, so scanners cannot duplicate one revision's wake. */
export function videoStageDue(stage: GenerationVideoStage, now: Date): boolean {
    return stage.nextActionAt !== null && stage.nextActionAt <= now && (stage.leaseUntil === null || stage.leaseUntil <= now);
}
