import { expect, test } from "bun:test";
import { createConfiguredGenerationWorkerRuntime } from "../src/generation-worker-entry";

const database = {} as any;
const dependencies = { async provider() { return { status: "failed" as const, errorCode: "test" }; } };

test("disabled worker entry does not construct a queue", () => {
    let constructed = false;
    const result = createConfiguredGenerationWorkerRuntime({
        env: { GENERATION_WORKER_ENABLED: "false" },
        database,
        dependencies,
        onError() {},
        workerFactory() {
            constructed = true;
            throw new Error("queue must not be constructed");
        },
    });
    expect(result).toBeNull();
    expect(constructed).toBe(false);
});

test("configured worker entry validates the deployment environment before construction", () => {
    expect(() => createConfiguredGenerationWorkerRuntime({
        env: {
            GENERATION_WORKER_ENABLED: "true",
            GENERATION_WORKER_QUEUE_URL: "postgresql://queue.example.test/jobs",
            GENERATION_WORKER_ENVIRONMENT: "production",
        },
        expectedEnvironment: "staging",
        database,
        dependencies,
        onError() {},
        workerFactory() { throw new Error("queue must not be constructed"); },
    })).toThrow("环境不匹配");
});

test("configured worker entry constructs but does not start the worker", () => {
    let starts = 0;
    const result = createConfiguredGenerationWorkerRuntime({
        env: {
            GENERATION_WORKER_ENABLED: "true",
            GENERATION_WORKER_QUEUE_URL: "postgresql://queue.example.test/jobs",
            GENERATION_WORKER_ENVIRONMENT: "staging",
            GENERATION_WORKER_MAX_BATCH_SIZE: "7",
        },
        expectedEnvironment: "staging",
        database,
        dependencies,
        onError() {},
        workerFactory(connectionString, handler) {
            expect(connectionString).toBe("postgresql://queue.example.test/jobs");
            expect(handler).toBeFunction();
            return {
                async start() { starts += 1; },
                async stop() {},
                isStarted: () => starts > 0,
            };
        },
    });
    expect(result).not.toBeNull();
    expect(result!.isStarted()).toBe(false);
    expect(starts).toBe(0);
});
