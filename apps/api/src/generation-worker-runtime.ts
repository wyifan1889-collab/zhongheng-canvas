import type { Database } from "@infinite-canvas/database";
import {
    createGenerationWorker,
    type GenerationJobPayload,
    type JobBatchHandler,
} from "@infinite-canvas/jobs";
import type { GenerationWorkerDependencies } from "./generation-worker";
import { createGenerationJobHandler, type GenerationQueueJob } from "./generation-job-handler";
import type { GenerationWorkerConfig } from "./generation-worker-config";

export type GenerationWorkerLifecycle = {
    start(): Promise<void>;
    stop(): Promise<void>;
    isStarted(): boolean;
};

export type GenerationWorkerFactory = (
    connectionString: string,
    handler: JobBatchHandler<GenerationJobPayload>,
    onError: (error: Error) => void,
) => GenerationWorkerLifecycle;

export type GenerationWorkerRuntimeOptions = {
    database: Database;
    queueConnectionString: string;
    dependencies: GenerationWorkerDependencies;
    onError: (error: Error) => void;
    maxBatchSize?: number;
    workerFactory?: GenerationWorkerFactory;
};

/**
 * Compose the generation queue callback and lifecycle without starting it.
 * Production/staging bootstrap must separately install the queue schema, audit
 * its pg-boss policy, and call start explicitly; API startup never does so.
 */
export function createGenerationWorkerRuntime(options: GenerationWorkerRuntimeOptions): GenerationWorkerLifecycle {
    const handler = createGenerationJobHandler(options.database, options.dependencies, options.maxBatchSize);
    const workerFactory = options.workerFactory ?? createGenerationWorker;
    const worker = workerFactory(options.queueConnectionString, (async (jobs) => {
        await handler(jobs as ReadonlyArray<GenerationQueueJob>);
    }) satisfies JobBatchHandler<GenerationJobPayload>, options.onError);
    return {
        start: () => worker.start(),
        stop: () => worker.stop(),
        isStarted: () => worker.isStarted(),
    };
}

/**
 * Bind an explicitly validated worker config to the existing lifecycle seam.
 * This is still construction only: callers must invoke `start()` themselves.
 */
export function createGenerationWorkerRuntimeFromConfig(
    options: Omit<GenerationWorkerRuntimeOptions, "queueConnectionString" | "maxBatchSize"> & {
        config: GenerationWorkerConfig;
    },
): GenerationWorkerLifecycle {
    return createGenerationWorkerRuntime({
        ...options,
        queueConnectionString: options.config.queueConnectionString,
        maxBatchSize: options.config.maxBatchSize,
    });
}

