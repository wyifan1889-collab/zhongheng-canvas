import { expect, test } from "bun:test";
import { canonicalPostgresTarget, readGenerationWorkerConfig } from "../src/generation-worker-config";

test("canonical generation target cannot hide query overrides or implicit database names", () => {
    for (const parameter of ["host=other.example.test", "port=5433", "database=other", "dbname=other"]) {
        expect(() => canonicalPostgresTarget(`postgres://db.example.test/canvas?${parameter}`, "queue")).toThrow("查询参数覆盖数据库目标");
    }
    expect(() => canonicalPostgresTarget("postgres://alice@db.example.test", "queue")).toThrow("显式指定主机和数据库");
    expect(() => canonicalPostgresTarget("postgres:///canvas", "queue")).toThrow("显式指定主机和数据库");
    const target = canonicalPostgresTarget("postgres://worker:synthetic@DB.EXAMPLE.TEST:5432/canvas?sslmode=require", "queue");
    expect(target).toBe(canonicalPostgresTarget("postgresql://db.example.test/canvas", "app"));
    expect(canonicalPostgresTarget("postgres://db.example.test/canvas/", "queue")).not.toBe(target);
    expect(canonicalPostgresTarget("postgres://db.example.test/can%76as", "queue")).toBe(target);
});

test("generation worker config is disabled without an explicit opt-in", () => {
    expect(readGenerationWorkerConfig({})).toBeNull();
    expect(readGenerationWorkerConfig({ GENERATION_WORKER_ENABLED: "false", GENERATION_WORKER_QUEUE_URL: "not-a-url" })).toBeNull();
    expect(() => readGenerationWorkerConfig({ GENERATION_WORKER_ENABLED: "yes" })).toThrow("GENERATION_WORKER_ENABLED");
});

test("enabled worker config requires an explicit environment and PostgreSQL queue", () => {
    expect(() => readGenerationWorkerConfig({ GENERATION_WORKER_ENABLED: "true" }))
        .toThrow("GENERATION_WORKER_QUEUE_URL、GENERATION_WORKER_ENVIRONMENT");
    expect(() => readGenerationWorkerConfig({
        GENERATION_WORKER_ENABLED: "true",
        GENERATION_WORKER_QUEUE_URL: "https://queue.example.test",
        GENERATION_WORKER_ENVIRONMENT: "staging",
    })).toThrow("GENERATION_WORKER_QUEUE_URL");
    expect(() => readGenerationWorkerConfig({
        GENERATION_WORKER_ENABLED: "true",
        GENERATION_WORKER_QUEUE_URL: "postgres://queue.example.test/canvas_jobs",
        GENERATION_WORKER_ENVIRONMENT: "staging",
        GENERATION_WORKER_MAX_BATCH_SIZE: "101",
    })).toThrow("GENERATION_WORKER_MAX_BATCH_SIZE");
});

test("complete worker config is normalized without opening the queue", () => {
    const result = readGenerationWorkerConfig({
        GENERATION_WORKER_ENABLED: "true",
        GENERATION_WORKER_QUEUE_URL: "postgresql://queue.example.test/canvas_jobs",
        GENERATION_WORKER_ENVIRONMENT: "staging",
        GENERATION_WORKER_MAX_BATCH_SIZE: "12",
    });
    expect(result).toEqual({
        enabled: true,
        queueConnectionString: "postgresql://queue.example.test/canvas_jobs",
        maxBatchSize: 12,
        environment: "staging",
    });
});
