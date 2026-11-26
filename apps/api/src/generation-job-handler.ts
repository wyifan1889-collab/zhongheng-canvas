import type { Database } from "@infinite-canvas/database";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import type { GenerationWorkerDependencies, GenerationWorkerResult } from "./generation-worker";
import { GenerationWorkerError, processGenerationJob } from "./generation-worker";
import { isGenerationJobPayload } from "@infinite-canvas/jobs";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";

/**
 * Minimal shape exposed by pg-boss to a batch handler. Keeping this local avoids
 * passing queue implementation types into the generation state machine.
 */
export type GenerationQueueJob = { data: unknown };

export type GenerationJobHandlerDependencies = GenerationWorkerDependencies;

/**
 * Build a queue callback without opening a queue or starting a worker. The
 * caller owns createGenerationWorker/start/stop and must inject every
 * provider, delivery and billing dependency explicitly.
 */
export function createGenerationJobHandler(
    database: Database,
    dependencies: GenerationJobHandlerDependencies,
    maxBatchSize = 20,
): (jobs: ReadonlyArray<GenerationQueueJob>) => Promise<GenerationWorkerResult[]> {
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 100) {
        throw new Error("生成 worker 批量大小无效");
    }
    return async (jobs) => {
        if (jobs.length < 1 || jobs.length > maxBatchSize) throw new Error("生成 worker 批量大小超出限制");
        const results: GenerationWorkerResult[] = [];
        for (const job of jobs) {
            if (!job || typeof job !== "object" || !("data" in job)) {
                throw new GenerationWorkerError("invalid_job", "生成队列消息格式无效");
            }
            // Keep the queue envelope opaque; processGenerationJob performs the
            // authoritative version/identity validation before any Provider call.
            if (isGenerationJobPayload(job.data)) {
                const task = await createGenerationTaskRepository(database).get(job.data.ownerId, job.data.taskId);
                if (task?.videoQuoteSnapshot != null) {
                    if (!dependencies.processVideo) throw new GenerationWorkerError("invalid_state", "当前worker未开放视频阶段执行");
                    const result = await dependencies.processVideo(job.data);
                    if (result) results.push(result);
                    continue;
                }
            }
            results.push(await processGenerationJob(database, job.data as GenerationJobPayload, dependencies));
        }
        return results;
    };
}

