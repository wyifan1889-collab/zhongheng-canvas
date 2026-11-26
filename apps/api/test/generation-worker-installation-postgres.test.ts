import { expect, test } from "bun:test";
import { createDatabase } from "@infinite-canvas/database";
import { createGenerationWorker, createJobQueue } from "@infinite-canvas/jobs";
import { startGenerationApiRuntime, type GenerationApiRuntime } from "../src/generation-api-runtime";
import { runGenerationWorkerSchemaOperation } from "../src/generation-worker-schema";
import { postgresTestUrl } from "./database";

// A dedicated fresh cluster from the isolated runner only; no PGlite fallback,
// app migration, account, provider request, generation job, or external storage.
const url = postgresTestUrl();
const isolatedTest = url ? test : test.skip;

isolatedTest("real PostgreSQL installs the named generation queue explicitly and rejects unsafe existing policy", async () => {
    const database = createDatabase(url!);
    const env = {
        GENERATION_WORKER_ENABLED: "true", GENERATION_WORKER_ENVIRONMENT: "staging",
        GENERATION_WORKER_QUEUE_URL: url!, SAAS_DATABASE_URL: url!, SAAS_ORIGIN: "https://isolated-generation.example.test",
    };
    const errors: Error[] = [];
    const control = createJobQueue(url!, (error) => errors.push(error));
    const workers: ReturnType<typeof createGenerationWorker>[] = [];
    const producers: GenerationApiRuntime[] = [];
    let controlStarted = false, alteredPolicy = false, handledJobs = 0;
    const worker = () => {
        const instance = createGenerationWorker(url!, async () => { handledJobs++; }, (error) => errors.push(error));
        workers.push(instance);
        return instance;
    };
    const queueRow = async () => (await database.pool.query(
        "SELECT xmin::text AS revision, to_jsonb(q) AS metadata FROM canvas_jobs.queue q WHERE name = $1", ["generation"],
    )).rows;
    try {
        const identity = await database.pool.query("SELECT current_database() AS name, current_user AS role, host(inet_server_addr()) AS address");
        expect(identity.rows).toEqual([{ name: "canvas_saas_test", role: "canvas_test_app", address: "127.0.0.1" }]);
        // Refuse to erase or reuse another suite's queue schema.
        expect((await database.pool.query("SELECT to_regnamespace('canvas_jobs') AS schema")).rows[0].schema).toBeNull();
        const missing = await runGenerationWorkerSchemaOperation({ env });
        expect(missing).toEqual({ schema: { state: "missing", applied: false }, queue: { state: "unavailable", settings: null, applied: false } });
        expect((await database.pool.query("SELECT to_regnamespace('canvas_jobs') AS schema")).rows[0].schema).toBeNull();

        const installed = await runGenerationWorkerSchemaOperation({ env, apply: true });
        expect(installed.schema).toEqual({ state: "ready", applied: true });
        expect(installed.queue).toMatchObject({ state: "ready", applied: true, settings: { policy: "standard", retryLimit: 0 } });
        await control.start(); controlStarted = true;
        const effective = await control.getQueue("generation");
        expect(effective).not.toBeNull();
        // Compare reported metadata with the library's actual getQueue result,
        // without selecting new timeout or retention policy values in this test.
        for (const [key, value] of Object.entries(installed.queue.settings!)) {
            expect((effective as unknown as Record<string, unknown>)[key]).toEqual(value);
        }
        const original = await queueRow();
        expect(original).toHaveLength(1);
        const checked = await runGenerationWorkerSchemaOperation({ env });
        expect(checked).toEqual({ schema: { state: "ready", applied: false }, queue: { ...installed.queue, applied: false } });
        const repeated = await runGenerationWorkerSchemaOperation({ env, apply: true });
        expect(repeated).toEqual(checked);
        expect(await queueRow()).toEqual(original);

        const producer = await startGenerationApiRuntime({ queueConnectionString: url!, imageEnabled: true, textEnabled: false }, { onError: (error) => errors.push(error) });
        expect(producer).not.toBeNull(); producers.push(producer!);
        expect(await producer!.checkReady()).toBe(true);
        const readyWorker = worker();
        await readyWorker.start();
        expect(readyWorker.isStarted()).toBe(true);
        await readyWorker.stop();
        expect(await queueRow()).toEqual(original);
        expect(handledJobs).toBe(0);

        // Deliberate isolated fixture mutation, never a production default.
        await control.updateQueue("generation", { retryLimit: 1 }); alteredPolicy = true;
        const incompatible = await queueRow();
        const refused = await runGenerationWorkerSchemaOperation({ env, apply: true });
        expect(refused).toMatchObject({ schema: { applied: false }, queue: { state: "policy_mismatch", applied: false, settings: { retryLimit: 1 } } });
        expect(await queueRow()).toEqual(incompatible);
        expect(await producer!.checkReady()).toBe(false);
        await expect(startGenerationApiRuntime({ queueConnectionString: url!, imageEnabled: true, textEnabled: false }, { onError: (error) => errors.push(error) })).rejects.toThrow("生成队列尚未就绪");
        const refusedWorker = worker();
        await expect(refusedWorker.start()).rejects.toThrow("生成队列未就绪");
        expect(refusedWorker.isStarted()).toBe(false);
        expect(handledJobs).toBe(0);
        expect((await database.pool.query("SELECT count(*)::int AS count FROM canvas_jobs.job")).rows[0].count).toBe(0);
        expect(await queueRow()).toEqual(incompatible);
        expect(errors).toHaveLength(0);
    } finally {
        const stopped = await Promise.allSettled([
            ...producers.map((producer) => producer.stop()), ...workers.map((instance) => instance.stop()),
        ]);
        try {
            if (alteredPolicy && controlStarted) await control.updateQueue("generation", { retryLimit: 0 });
        } finally {
            try { await control.stop(); } finally { await database.close(); }
        }
        if (stopped.some((result) => result.status === "rejected")) throw new Error("isolated generation runtime cleanup failed");
    }
}, 30_000);
