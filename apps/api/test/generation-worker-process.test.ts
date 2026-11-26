import { expect, test } from "bun:test";
import { createMemoryObjectStorage } from "@infinite-canvas/storage";
import { createGenerationTextDelivery } from "../src/generation-delivery";
import { readGenerationWorkerProcessConfig, startGenerationWorkerProcess } from "../src/generation-worker-process";

const disabled = { GENERATION_WORKER_ENABLED: "false" };
const enabled = {
    GENERATION_WORKER_ENABLED: "true",
    GENERATION_WORKER_QUEUE_URL: "postgresql://db.example.test/canvas",
    GENERATION_WORKER_ENVIRONMENT: "staging",
    SAAS_DATABASE_URL: "postgresql://db.example.test/canvas",
    SAAS_AUTH_SECRET: "12345678901234567890123456789012",
};
const readyPool = { query: async () => ({ rows: ["column.text_quote_snapshot", "constraint.generation_task_text_quote",
    "trigger.generation_task_price_publication_insert", "trigger.generation_task_price_source_immutable",
    "trigger.model_price_publication_source", "constraint.model_pricing_billing_unit", "constraint.model_pricing_credits_positive",
    "function.image_spec_task_credits", "database.writable"].map((relation) => ({ relation })) }) };

test("worker process config is inert when the explicit opt-in is absent", () => {
    expect(readGenerationWorkerProcessConfig(disabled)).toBeNull();
    expect(() => readGenerationWorkerProcessConfig({ ...enabled, SAAS_AUTH_SECRET: "short" })).toThrow("SAAS_AUTH_SECRET");
});

test("text delivery only marks a normalized text result visible", async () => {
    const deliver = createGenerationTextDelivery();
    expect(await deliver({ task: {} as any, result: { status: "succeeded", resultSnapshot: { kind: "text", text: "hello" } } as any })).toEqual({ status: "visible" });
    expect(await deliver({ task: {} as any, result: { status: "succeeded", resultSnapshot: { kind: "image", text: "hello" } } as any })).toEqual({ status: "failed", errorCode: "delivery_text_result_invalid" });
});

test("disabled worker process does not construct database or runtime", async () => {
    let databases = 0;
    let runtimes = 0;
    expect(await startGenerationWorkerProcess({
        env: disabled,
        databaseFactory: (() => { databases += 1; throw new Error("database must not open"); }) as any,
        runtimeFactory: (() => { runtimes += 1; throw new Error("runtime must not construct"); }) as any,
    })).toBeNull();
    expect(databases).toBe(0);
    expect(runtimes).toBe(0);
});

test("enabled worker process fails before runtime when database credentials are missing", async () => {
    await expect(startGenerationWorkerProcess({ env: { ...enabled, SAAS_DATABASE_URL: undefined } })).rejects.toThrow("SAAS_DATABASE_URL");
});

test("worker rejects a different queue database before opening any connection", async () => {
    let opened = false;
    await expect(startGenerationWorkerProcess({
        env: { ...enabled, GENERATION_WORKER_QUEUE_URL: "postgres://db.example.test/other" },
        databaseFactory: (() => { opened = true; throw new Error("must not open database"); }) as any,
    })).rejects.toThrow("同一数据库");
    expect(opened).toBe(false);
    expect(readGenerationWorkerProcessConfig({ ...enabled, GENERATION_WORKER_QUEUE_URL: "postgres://worker:synthetic@DB.EXAMPLE.TEST:5432/canvas" })!.worker.enabled).toBe(true);
});

test("worker startup failure stops its queue before closing the application database", async () => {
    const events: string[] = [];
    await expect(startGenerationWorkerProcess({
        env: enabled,
        databaseFactory: (() => ({ db: {}, pool: readyPool, close: async () => { events.push("database.close"); } })) as any,
        providerFactory: () => async () => ({ status: "failed", errorCode: "synthetic" }),
        settlementFactory: () => async () => "released",
        runtimeFactory: () => ({
            async start() { events.push("queue.start"); throw new Error("synthetic startup failure"); },
            async stop() { events.push("queue.stop"); }, isStarted: () => false,
        }),
    })).rejects.toThrow("synthetic startup failure");
    expect(events).toEqual(["queue.start", "queue.stop", "database.close"]);
});

test("enabled worker process starts only through the injected runtime", async () => {
    let starts = 0;
    let closes = 0;
    const handle = await startGenerationWorkerProcess({
        env: enabled,
        databaseFactory: (() => ({ db: {} as any, pool: readyPool, close: async () => { closes += 1; } })) as any,
        providerFactory: (input) => {
            expect(input.imageMaxBytes).toBeUndefined();
            return async () => ({ status: "failed" as const, errorCode: "test" });
        },
        storageFactory: () => { throw new Error("text worker must not construct image storage"); },
        settlementFactory: (() => (async () => "released" as const)) as any,
        runtimeFactory: ((options) => {
            expect(options.expectedEnvironment).toBe("staging");
            expect(options.dependencies.deliver).toBeFunction();
            expect(options.dependencies.settleBilling).toBeFunction();
            return { async start() { starts += 1; }, async stop() {}, isStarted: () => starts > 0 };
        }) as any,
    });
    expect(starts).toBe(1);
    await handle!.stop();
    expect(closes).toBe(1);
});

test("image worker requires explicit opt-in and valid private storage before opening the database", async () => {
    expect(readGenerationWorkerProcessConfig({ ...enabled, STORAGE_PROVIDER: "invalid" })!.media).toBeNull();
    expect(() => readGenerationWorkerProcessConfig({ ...enabled, GENERATION_WORKER_IMAGE_ENABLED: "yes" })).toThrow("GENERATION_WORKER_IMAGE_ENABLED");
    for (const storage of [{}, { STORAGE_PROVIDER: "server-disk" }]) {
        let opened = false;
        await expect(startGenerationWorkerProcess({
            env: { ...enabled, GENERATION_WORKER_IMAGE_ENABLED: "true", ...storage },
            databaseFactory: (() => { opened = true; throw new Error("must not open database"); }) as any,
        })).rejects.toThrow();
        expect(opened).toBe(false);
    }
});

const imageEnabled = {
    ...enabled, GENERATION_WORKER_IMAGE_ENABLED: "true", STORAGE_PROVIDER: "server-disk",
    SAAS_STORAGE_ROOT: "synthetic-image-worker-storage",
    STORAGE_QUOTA_BYTES: "2048", STORAGE_IMAGE_MAX_BYTES: "1024",
    STORAGE_VIDEO_MAX_BYTES: "4096", STORAGE_AUDIO_MAX_BYTES: "3072",
};

test("image opt-in reuses configured storage limits and keeps text delivery available", async () => {
    let storageCalls = 0;
    let closes = 0;
    let starts = 0;
    const handle = await startGenerationWorkerProcess({
        env: imageEnabled,
        databaseFactory: (() => ({ db: {} as any, pool: readyPool, close: async () => { closes += 1; } })) as any,
        storageFactory: (configuration) => {
            expect(configuration).toEqual({ provider: "server-disk", rootDirectory: imageEnabled.SAAS_STORAGE_ROOT });
            storageCalls += 1;
            return createMemoryObjectStorage();
        },
        providerFactory: (input) => {
            expect(input.imageMaxBytes).toBe(1024);
            expect(input.authSecret).toBe(enabled.SAAS_AUTH_SECRET);
            return async () => ({ status: "failed" as const, errorCode: "synthetic" });
        },
        settlementFactory: () => async () => "released",
        runtimeFactory: (options) => ({
            async start() {
                starts += 1;
                expect(await options.dependencies.deliver!({
                    task: { priceVersion: null, pricePublicationId: null } as any,
                    result: { status: "succeeded", resultSnapshot: { kind: "text", text: "still supported" } } as any,
                })).toEqual({ status: "visible" });
            },
            async stop() {}, isStarted: () => starts > 0,
        }),
    });
    expect(handle!.config.media).toMatchObject({ quotaBytes: 2048, maxBytes: { image: 1024, video: 4096, audio: 3072 } });
    expect(storageCalls).toBe(1);
    expect(starts).toBe(1);
    await handle!.stop();
    expect(closes).toBe(1);
});

test("image storage startup failure closes the database before constructing provider or runtime", async () => {
    let closes = 0;
    let providers = 0;
    let runtimes = 0;
    await expect(startGenerationWorkerProcess({
        env: imageEnabled,
        databaseFactory: (() => ({ db: {} as any, pool: readyPool, close: async () => { closes += 1; } })) as any,
        storageFactory: () => { throw new Error("synthetic storage failure"); },
        providerFactory: () => { providers += 1; throw new Error("must not construct provider"); },
        runtimeFactory: () => { runtimes += 1; throw new Error("must not construct runtime"); },
    })).rejects.toThrow("synthetic storage failure");
    expect(closes).toBe(1);
    expect(providers).toBe(0);
    expect(runtimes).toBe(0);
});

test("worker refuses an old task schema before constructing provider or starting a queue", async () => {
    const events: string[] = [];
    await expect(startGenerationWorkerProcess({ env: enabled,
        databaseFactory: (() => ({ db: {}, pool: { query: async () => ({ rows: [] }) }, close: async () => { events.push("closed"); } })) as any,
        providerFactory: () => { events.push("provider"); throw new Error("must not construct"); },
        runtimeFactory: () => { events.push("runtime"); throw new Error("must not construct"); },
    })).rejects.toThrow("0026");
    expect(events).toEqual(["closed"]);
});
