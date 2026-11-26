import { expect, test } from "bun:test";
import {
    ensureGenerationWorkerSchema,
    inspectGenerationQueue,
    inspectGenerationWorkerSchema,
    readGenerationWorkerSchemaConfig,
    runGenerationWorkerSchemaOperation,
} from "../src/generation-worker-schema";

const base = {
    GENERATION_WORKER_ENABLED: "true",
    GENERATION_WORKER_QUEUE_URL: "postgresql://app.example.test/canvas",
    GENERATION_WORKER_ENVIRONMENT: "staging",
    SAAS_DATABASE_URL: "postgresql://app.example.test/canvas",
    SAAS_ORIGIN: "https://staging.example.test",
};

const readyQueue = {
    name: "generation", policy: "standard", retryLimit: 0, retryDelay: 0, retryBackoff: false, retryDelayMax: null,
    expireInSeconds: 900, retentionSeconds: 1209600, deleteAfterSeconds: 604800, heartbeatSeconds: null,
};
const { name: _queueName, ...readySettings } = readyQueue;

function fakeClient(schema: boolean, tables: string[] = [], queue: typeof readyQueue | null = null) {
    const queries: string[] = [];
    const client = {
        queries,
        async query(text: string, values?: readonly unknown[]) {
            queries.push(text);
            if (text.includes("information_schema.schemata")) return { rows: [{ exists: schema }] };
            if (text.includes("information_schema.tables")) return { rows: [{ exists: tables.includes(String(values?.[1])) }] };
            if (text.trimStart().startsWith("SELECT") && text.includes("FROM canvas_jobs.queue")) {
                expect(values).toEqual(["generation"]);
                return { rows: queue ? [{ ...queue }] : [] };
            }
            return { rows: [] };
        },
        setQueue(value: typeof readyQueue | null) { queue = value; },
    };
    return client;
}

test("schema config is staging-only and requires the same explicit application database", () => {
    expect(readGenerationWorkerSchemaConfig(base).environment).toBe("staging");
    expect(() => readGenerationWorkerSchemaConfig({ ...base, GENERATION_WORKER_ENVIRONMENT: "production" })).toThrow("staging");
    expect(() => readGenerationWorkerSchemaConfig({ ...base, SAAS_ORIGIN: "https://agent.zh-api.com" })).toThrow("production");
    expect(() => readGenerationWorkerSchemaConfig({ ...base, SAAS_ORIGIN: "http://staging.example.test" })).toThrow("HTTPS");
    expect(() => readGenerationWorkerSchemaConfig({ ...base, SAAS_ORIGIN: "https://staging.example.test/path" })).toThrow("HTTPS");
    expect(() => readGenerationWorkerSchemaConfig({ ...base, GENERATION_WORKER_QUEUE_URL: "postgres://queue.example.test/jobs" })).toThrow("同一数据库");
    expect(readGenerationWorkerSchemaConfig({ ...base, GENERATION_WORKER_QUEUE_URL: "postgres://other:synthetic@APP.EXAMPLE.TEST:5432/canvas?sslmode=require" }).environment).toBe("staging");
    expect(() => readGenerationWorkerSchemaConfig({ ...base, GENERATION_WORKER_QUEUE_URL: `${base.SAAS_DATABASE_URL}?host=other.example.test` })).toThrow("查询参数覆盖数据库目标");
    expect(() => readGenerationWorkerSchemaConfig({ ...base, GENERATION_WORKER_ENABLED: "false" })).toThrow("true");
});

test("a mismatched schema target is rejected before constructing a database client", async () => {
    let opened = false;
    await expect(runGenerationWorkerSchemaOperation({
        env: { ...base, GENERATION_WORKER_QUEUE_URL: "postgres://app.example.test/other" },
        apply: true,
        databaseFactory: (() => { opened = true; throw new Error("must not open database"); }) as any,
    })).rejects.toThrow("同一数据库");
    expect(opened).toBe(false);
});

const coreTables = ["version", "queue", "schedule", "subscription", "bam", "job", "job_common", "warning", "queue_stats", "job_dependency"];

test("schema inspection is read-only and distinguishes missing, ready and partial", async () => {
    expect(await inspectGenerationWorkerSchema(fakeClient(false))).toBe("missing");
    expect(await inspectGenerationWorkerSchema(fakeClient(true, coreTables))).toBe("ready");
    expect(await inspectGenerationWorkerSchema(fakeClient(true, coreTables.filter((table) => table !== "subscription")))).toBe("partial");
});

test("check mode never applies SQL and apply mode installs only a missing schema", async () => {
    const missing = fakeClient(false);
    expect(await ensureGenerationWorkerSchema(missing, false)).toEqual({ state: "missing", applied: false });
    expect(missing.queries.some((query) => query.includes("BEGIN"))).toBe(false);

    const applied = fakeClient(false);
    let installCalls = 0;
    const installClient = {
        ...applied,
        async query(text: string, values?: readonly unknown[]) {
            if (text.includes("BEGIN")) installCalls += 1;
            return applied.query(text, values);
        },
    };
    await expect(ensureGenerationWorkerSchema(installClient, true)).resolves.toEqual({ state: "missing", applied: true });
    expect(installCalls).toBe(1);

    await expect(ensureGenerationWorkerSchema(fakeClient(true, ["version"]), true)).rejects.toThrow("不完整");
});

test("process check uses one read-only checkout, reports effective queue settings and never constructs pg-boss", async () => {
    let opened: string | undefined;
    let closed = 0;
    let released = 0;
    const client = fakeClient(true, coreTables, readyQueue);
    const result = await runGenerationWorkerSchemaOperation({
        env: base,
        databaseFactory: ((url: string) => {
            opened = url;
            return { db: {} as any, pool: {
                connect: async () => ({ ...client, release() { released++; } }),
                query() { throw new Error("must use the checked-out connection"); },
            }, close: async () => { closed += 1; } };
        }) as any,
        queueFactory() { throw new Error("read-only check must not construct pg-boss"); },
    });
    expect(result).toEqual({ schema: { state: "ready", applied: false }, queue: { state: "ready", settings: readySettings, applied: false } });
    expect(client.queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(client.queries.at(-1)).toBe("ROLLBACK");
    expect(client.queries.slice(1, -1).every((query) => query.trimStart().startsWith("SELECT"))).toBe(true);
    expect(opened).toBe(base.GENERATION_WORKER_QUEUE_URL);
    expect(closed).toBe(1);
    expect(released).toBe(1);
});

function processFixture(client: ReturnType<typeof fakeClient>) {
    const calls = { released: 0, closed: 0 };
    return {
        calls,
        databaseFactory: (() => ({ db: {}, pool: { connect: async () => ({ ...client, release() { calls.released++; } }) },
            close: async () => { calls.closed++; } })) as any,
    };
}

test("queue inspection distinguishes missing and unsafe existing policies without altering metadata", async () => {
    expect(await inspectGenerationQueue(fakeClient(true, coreTables))).toEqual({ state: "missing", settings: null });
    for (const change of [{ retryLimit: 2 }, { policy: "key_strict_fifo" }]) {
        const existing = { ...readyQueue, ...change, expireInSeconds: 1234, retentionSeconds: 5678 };
        const client = fakeClient(true, coreTables, existing), fixture = processFixture(client);
        const result = await runGenerationWorkerSchemaOperation({ env: base, apply: true, databaseFactory: fixture.databaseFactory,
            queueFactory() { throw new Error("existing queue must never be edited"); } });
        expect(result.queue).toMatchObject({ state: "policy_mismatch", applied: false, settings: { ...change, expireInSeconds: 1234, retentionSeconds: 5678 } });
        expect(client.queries.every((query) => query.trimStart().startsWith("SELECT"))).toBe(true);
        expect(fixture.calls).toEqual({ released: 1, closed: 1 });
    }
});

test("read-only missing schema or missing queue never invokes an installer", async () => {
    for (const schemaReady of [false, true]) {
        const client = fakeClient(schemaReady, schemaReady ? coreTables : []), fixture = processFixture(client);
        const result = await runGenerationWorkerSchemaOperation({ env: base, databaseFactory: fixture.databaseFactory,
            queueFactory() { throw new Error("check must not construct an installer"); } });
        expect(result).toEqual({ schema: { state: schemaReady ? "ready" : "missing", applied: false },
            queue: { state: schemaReady ? "missing" : "unavailable", settings: null, applied: false } });
        expect(client.queries.at(-1)).toBe("ROLLBACK");
        expect(fixture.calls).toEqual({ released: 1, closed: 1 });
    }
});

test("explicit apply creates only the missing named queue with retry disabled and reports inherited settings", async () => {
    const client = fakeClient(true, coreTables), fixture = processFixture(client);
    const events: unknown[] = [];
    const queueFactory = ((url: string) => {
        expect(url).toBe(base.GENERATION_WORKER_QUEUE_URL);
        return {
            async start() { events.push("start"); }, async stop() { events.push("stop"); },
            async createQueue(name: string, options: object) { events.push({ name, options }); client.setQueue(readyQueue); },
            work() { throw new Error("installer must not start a worker"); },
            updateQueue() { throw new Error("installer must not change existing policy"); },
        };
    }) as any;
    const result = await runGenerationWorkerSchemaOperation({ env: base, apply: true, databaseFactory: fixture.databaseFactory, queueFactory });
    expect(events).toEqual(["start", { name: "generation", options: { retryLimit: 0 } }, "stop"]);
    expect(result).toEqual({ schema: { state: "ready", applied: false }, queue: { state: "ready", applied: true, settings: readySettings } });
    expect(fixture.calls).toEqual({ released: 1, closed: 1 });
    const second = await runGenerationWorkerSchemaOperation({ env: base, apply: true, databaseFactory: fixture.databaseFactory,
        queueFactory() { throw new Error("must not recreate an existing queue"); } });
    expect(second.queue.applied).toBe(false);
});

test("partial schema cannot reach queue creation even with apply", async () => {
    const client = fakeClient(true, ["version"]), fixture = processFixture(client);
    await expect(runGenerationWorkerSchemaOperation({ env: base, apply: true, databaseFactory: fixture.databaseFactory,
        queueFactory() { throw new Error("partial schema must stop before installer"); } })).rejects.toThrow("不完整");
    expect(fixture.calls).toEqual({ released: 1, closed: 1 });
    expect(client.queries.every((query) => query.trimStart().startsWith("SELECT"))).toBe(true);
});

test("queue startup and creation failures close both connections without reporting success", async () => {
    for (const failAt of ["start", "create"] as const) {
        const client = fakeClient(true, coreTables), fixture = processFixture(client);
        let stopped = 0;
        await expect(runGenerationWorkerSchemaOperation({ env: base, apply: true, databaseFactory: fixture.databaseFactory,
            queueFactory: (() => ({
                async start() { if (failAt === "start") throw new Error("synthetic installation failure"); },
                async createQueue() { throw new Error("synthetic installation failure"); },
                async stop() { stopped++; },
            })) as any })).rejects.toThrow("synthetic installation failure");
        expect(stopped).toBe(1);
        expect(fixture.calls).toEqual({ released: 1, closed: 1 });
    }
});
