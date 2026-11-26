import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { user } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";
import { createAndEnqueueGenerationTask } from "../src/generation-dispatch";
import { createGenerationJobHandler } from "../src/generation-job-handler";
import { createGenerationWorkerRuntime, createGenerationWorkerRuntimeFromConfig } from "../src/generation-worker-runtime";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: ownerId, name: "Job handler owner", email: `${ownerId}@example.test` });
});

afterAll(async () => { await database?.close(); });

async function queuedTask(key: string) {
    return (await createAndEnqueueGenerationTask(database.db, { async send() { return `job-${key}`; } }, {
        ownerId, inputSnapshot: { prompt: key }, modelId: "text-test", parameterSnapshot: {}, idempotencyKey: key, requestId: `request-${key}`,
    })).task;
}

describe("generation queue handler boundary", () => {
    test("processes an injected batch sequentially and leaves replay behavior to the worker state machine", async () => {
        const first = await queuedTask("handler-first");
        const second = await queuedTask("handler-second");
        let calls = 0;
        const handler = createGenerationJobHandler(database.db, {
            async provider(task) {
                calls += 1;
                return { status: "failed" as const, errorCode: `provider_rejected_${task.inputSnapshot.prompt}` };
            },
        });
        const jobs = [
            { data: { schemaVersion: 1 as const, taskId: first.id, ownerId, requestId: first.requestId } },
            { data: { schemaVersion: 1 as const, taskId: second.id, ownerId, requestId: second.requestId } },
        ];
        const results = await handler(jobs);
        const replay = await handler([jobs[0]!]);
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ replay: false, task: { executionStatus: "failed" } });
        expect(results[1]).toMatchObject({ replay: false, task: { executionStatus: "failed" } });
        expect(replay[0]).toMatchObject({ replay: true, result: { status: "failed" } });
        expect(calls).toBe(2);
    });

    test("rejects oversized batches before touching the database or Provider", async () => {
        let calls = 0;
        const handler = createGenerationJobHandler(database.db, {
            async provider() { calls += 1; return { status: "failed" as const, errorCode: "should_not_run" }; },
        }, 1);
        await expect(handler([{ data: {} }, { data: {} }])).rejects.toThrow("生成 worker 批量大小超出限制");
        expect(calls).toBe(0);
    });

    test("rejects malformed queue data through the worker validation boundary", async () => {
        let calls = 0;
        const handler = createGenerationJobHandler(database.db, {
            async provider() { calls += 1; return { status: "failed" as const, errorCode: "should_not_run" }; },
        });
        await expect(handler([{ data: { schemaVersion: 2, taskId: "task", ownerId, requestId: "request" } }])).rejects.toMatchObject({ code: "invalid_job" });
        expect(calls).toBe(0);
    });

    test("composes a worker lifecycle without starting or connecting it", async () => {
        let started = false;
        let startedOnce = false;
        let stopped = false;
        let factoryCalls = 0;
        const runtime = createGenerationWorkerRuntime({
            database: database.db,
            queueConnectionString: "postgres://127.0.0.1/canvas_jobs",
            dependencies: { async provider() { return { status: "failed" as const, errorCode: "unused" }; } },
            onError: () => {},
            workerFactory: (_connectionString, _handler, _onError) => {
                factoryCalls += 1;
                return {
                    async start() { started = true; startedOnce = true; },
                    async stop() { stopped = true; started = false; },
                    isStarted: () => started,
                };
            },
        });
        expect(factoryCalls).toBe(1);
        expect(runtime.isStarted()).toBe(false);
        await runtime.start();
        await runtime.stop();
        expect({ startedOnce, started, stopped, running: runtime.isStarted() }).toEqual({ startedOnce: true, started: false, stopped: true, running: false });
    });

    test("binds a validated worker config without auto-starting it", () => {
        let factoryCalls = 0;
        const runtime = createGenerationWorkerRuntimeFromConfig({
            database: database.db,
            config: {
                enabled: true,
                queueConnectionString: "postgres://127.0.0.1/canvas_jobs",
                maxBatchSize: 7,
                environment: "staging",
            },
            dependencies: { async provider() { return { status: "failed" as const, errorCode: "unused" }; } },
            onError: () => {},
            workerFactory: (connectionString, _handler, _onError) => {
                factoryCalls += 1;
                expect(connectionString).toBe("postgres://127.0.0.1/canvas_jobs");
                return { async start() {}, async stop() {}, isStarted: () => false };
            },
        });
        expect(factoryCalls).toBe(1);
        expect(runtime.isStarted()).toBe(false);
    });
});

