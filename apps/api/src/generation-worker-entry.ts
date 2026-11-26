import type { Database } from "@infinite-canvas/database";
import type { GenerationWorkerDependencies } from "./generation-worker";
import { readGenerationWorkerConfig } from "./generation-worker-config";
import {
    createGenerationWorkerRuntimeFromConfig,
    type GenerationWorkerFactory,
    type GenerationWorkerLifecycle,
} from "./generation-worker-runtime";

export type GenerationWorkerEntryOptions = {
    env: Record<string, string | undefined>;
    /** The process deployment's expected environment, if it is fixed. */
    expectedEnvironment?: "staging" | "production";
    database: Database;
    dependencies: GenerationWorkerDependencies;
    onError: (error: Error) => void;
    workerFactory?: GenerationWorkerFactory;
};

/**
 * Build the independent generation-worker process boundary.
 *
 * A disabled or absent opt-in returns null and does not construct a queue.
 * An enabled config must match the deployment's explicitly supplied
 * environment label. Construction still does not start the worker; the
 * process owner must call `start()` after migrations and readiness checks.
 */
export function createConfiguredGenerationWorkerRuntime(
    options: GenerationWorkerEntryOptions,
): GenerationWorkerLifecycle | null {
    const config = readGenerationWorkerConfig(options.env);
    if (!config) return null;
    if (options.expectedEnvironment && config.environment !== options.expectedEnvironment) {
        throw new Error(`generation worker 环境不匹配：需要 ${options.expectedEnvironment}`);
    }
    return createGenerationWorkerRuntimeFromConfig({
        database: options.database,
        dependencies: options.dependencies,
        onError: options.onError,
        workerFactory: options.workerFactory,
        config,
    });
}
