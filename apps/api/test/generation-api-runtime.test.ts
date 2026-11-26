import { expect, test } from "bun:test";
import { readGenerationApiConfig, startGenerationApiRuntime } from "../src/generation-api-runtime";

const account = {
    SAAS_DATABASE_URL: "postgresql://app:synthetic@db.example.test/canvas",
    cloudMedia: true,
    storage: { provider: "server-disk" as const, rootDirectory: "synthetic-generation-storage", quotaBytes: 2048, maxBytes: { image: 1024, audio: 1024, video: 1024 } },
};
const enabled = {
    SAAS_GENERATION_IMAGE_ENABLED: "true",
    GENERATION_WORKER_QUEUE_URL: "postgres://producer:synthetic@DB.EXAMPLE.TEST:5432/canvas",
};

function fixture() {
    const events: string[] = [];
    const state = { installed: true, registered: true, failStart: false, failRead: false, policy: "standard", retryLimit: 0 };
    const queue = {
        async start() { events.push("start"); if (state.failStart) throw new Error("synthetic start failure"); },
        async stop() { events.push("stop"); },
        async isInstalled() { events.push("installed"); if (state.failRead) throw new Error("synthetic read failure"); return state.installed; },
        async getQueue(name: string) { events.push(`get:${name}`); return state.registered ? { name, policy: state.policy, retryLimit: state.retryLimit } : null; },
        async send() { events.push("send"); return "synthetic-job"; },
        // Any accidental runtime installation or consumption fails this fixture.
        async createQueue() { throw new Error("API must not create queues"); },
        async work() { throw new Error("API must not start workers"); },
    };
    return { events, state, queue };
}

test("generation API stays inert without an explicit opt-in", async () => {
    expect(readGenerationApiConfig({}, null)).toBeNull();
    expect(readGenerationApiConfig({ ...enabled, SAAS_GENERATION_IMAGE_ENABLED: "false", GENERATION_WORKER_QUEUE_URL: "invalid" }, null)).toBeNull();
    expect(await startGenerationApiRuntime(null, { queueFactory() { throw new Error("disabled API must not open queue"); } })).toBeNull();
    expect(() => readGenerationApiConfig({ ...enabled, SAAS_GENERATION_IMAGE_ENABLED: "yes" }, account)).toThrow("SAAS_GENERATION_IMAGE_ENABLED");
});

test("generation API requires accounts, media and the same transactional database before construction", () => {
    for (const configuration of [null, { ...account, cloudMedia: false }, { ...account, storage: null }]) {
        expect(() => readGenerationApiConfig(enabled, configuration)).toThrow("账户、云媒体和私有存储");
    }
    expect(() => readGenerationApiConfig({ ...enabled, GENERATION_WORKER_QUEUE_URL: undefined }, account)).toThrow("GENERATION_WORKER_QUEUE_URL");
    for (const target of ["postgres://db.example.test/other", "postgres://other.example.test/canvas", "postgres://db.example.test:5433/canvas"]) {
        expect(() => readGenerationApiConfig({ ...enabled, GENERATION_WORKER_QUEUE_URL: target }, account)).toThrow("同一数据库");
    }
    expect(() => readGenerationApiConfig({ ...enabled, GENERATION_WORKER_QUEUE_URL: "postgres://db.example.test/canvas?host=other.example.test" }, account)).toThrow("查询参数覆盖数据库目标");
    expect(readGenerationApiConfig(enabled, account)).toEqual({ queueConnectionString: enabled.GENERATION_WORKER_QUEUE_URL, imageEnabled: true, textEnabled: false, audioEnabled: false });
});

test("text opt-in does not expose image generation or require media storage", async () => {
    const env = { GENERATION_WORKER_QUEUE_URL: enabled.GENERATION_WORKER_QUEUE_URL, SAAS_GENERATION_TEXT_ENABLED: "true" };
    expect(() => readGenerationApiConfig(env, null)).toThrow("账户数据库");
    expect(() => readGenerationApiConfig({ ...env, SAAS_GENERATION_TEXT_ENABLED: "yes" }, account)).toThrow("SAAS_GENERATION_TEXT_ENABLED");
    const config = readGenerationApiConfig(env, { ...account, cloudMedia: false, storage: null });
    expect(config).toMatchObject({ imageEnabled: false, textEnabled: true });
    const { queue } = fixture();
    const runtime = await startGenerationApiRuntime(config, { queueFactory: () => queue });
    expect(runtime).toMatchObject({ imageEnabled: false, textEnabled: true });
    await runtime!.stop();
});

test("generation producer rejects a missing task-price migration and detects later schema failures", async () => {
    const first = fixture();
    await expect(startGenerationApiRuntime(readGenerationApiConfig(enabled, account), {
        queueFactory: () => first.queue, checkDatabaseReady: async () => false,
    })).rejects.toThrow("0025");
    expect(first.events).toEqual(["stop"]);
    let ready = true;
    const second = fixture();
    const runtime = await startGenerationApiRuntime(readGenerationApiConfig(enabled, account), {
        queueFactory: () => second.queue, checkDatabaseReady: async () => ready,
    });
    expect(await runtime!.checkReady()).toBe(true);
    ready = false;
    expect(await runtime!.checkReady()).toBe(false);
    await runtime!.stop();
});

test("generation API starts only a producer against an existing queue and readiness fails closed", async () => {
    const { events, state, queue } = fixture();
    const runtime = await startGenerationApiRuntime(readGenerationApiConfig(enabled, account), {
        queueFactory(connectionString) { expect(connectionString).toBe(enabled.GENERATION_WORKER_QUEUE_URL); return queue; },
    });
    expect(runtime!.enabled).toBe(true);
    expect(runtime!.queue).toBe(queue);
    expect(events).toEqual(["start", "installed", "get:generation"]);
    expect(await runtime!.checkReady()).toBe(true);
    state.retryLimit = 2;
    expect(await runtime!.checkReady()).toBe(false);
    state.retryLimit = 0;
    state.policy = "singleton";
    expect(await runtime!.checkReady()).toBe(false);
    state.policy = "standard";
    state.registered = false;
    expect(await runtime!.checkReady()).toBe(false);
    state.failRead = true;
    expect(await runtime!.checkReady()).toBe(false);
    await runtime!.stop();
    await runtime!.stop();
    expect(events.filter((event) => event === "stop")).toHaveLength(1);
    const before = events.length;
    expect(await runtime!.checkReady()).toBe(false);
    expect(events).toHaveLength(before);
    expect(events).not.toContain("send");
});

test("generation producer rejects incompatible existing policies without changing or recreating the queue", async () => {
    for (const policy of [{ policy: "standard", retryLimit: 2 }, { policy: "singleton", retryLimit: 0 }]) {
        const { state, events, queue } = fixture();
        Object.assign(state, policy);
        await expect(startGenerationApiRuntime(readGenerationApiConfig(enabled, account), { queueFactory: () => queue })).rejects.toThrow("standard 策略、retryLimit=0");
        expect(events).toEqual(["start", "installed", "get:generation", "stop"]);
        expect(state).toMatchObject(policy);
    }
});

test("generation API closes the producer after failed start, absent schema or missing queue", async () => {
    for (const failure of ["failStart", "installed", "registered"] as const) {
        const { state, events, queue } = fixture();
        state[failure] = failure === "failStart";
        await expect(startGenerationApiRuntime(readGenerationApiConfig(enabled, account), { queueFactory: () => queue })).rejects.toThrow();
        expect(events[0]).toBe("start");
        expect(events.at(-1)).toBe("stop");
        expect(events.filter((event) => event === "stop")).toHaveLength(1);
        expect(events).not.toContain("send");
    }
});
