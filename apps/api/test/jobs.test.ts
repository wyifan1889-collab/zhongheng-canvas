import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDraftRepository } from "@infinite-canvas/database/drafts";
import { canvasDraft, user } from "@infinite-canvas/database/schema";
import { createGenerationJobPayload, createGenerationWorker, createJobQueue, createJobWorker, fromDrizzle, getJobSchemaSql, isGenerationJobPayload, isGenerationQueueReady } from "@infinite-canvas/jobs";
import { createTestDatabase, postgresTestUrl } from "./database";

const url = postgresTestUrl();
const realTest = url ? describe : describe.skip;

describe("job worker boundary", () => {
    test("requires a safe explicit queue name before opening a connection", () => {
        expect(() => createJobWorker("http://not-postgres", "generation", async () => {}, () => {})).toThrow("任务队列必须使用独立画布 PostgreSQL 数据库");
        expect(() => createJobWorker("postgres://localhost/canvas", "", async () => {}, () => {})).toThrow("任务队列名称无效");
        expect(() => createJobWorker("postgres://localhost/canvas", "generation\u0000queue", async () => {}, () => {})).toThrow("任务队列名称无效");
    });

    test("generation queue payload is versioned and contains only task identity", () => {
        const payload = createGenerationJobPayload({ taskId: "task-1", ownerId: "owner-1", requestId: "request-1" });
        expect(payload).toEqual({ schemaVersion: 1, taskId: "task-1", ownerId: "owner-1", requestId: "request-1" });
        expect(isGenerationJobPayload(payload)).toBe(true);
        expect(isGenerationJobPayload({ ...payload, providerKey: "must-not-be-here" })).toBe(false);
        expect(isGenerationJobPayload({ schemaVersion: 2, taskId: "task-1", ownerId: "owner-1", requestId: "request-1" })).toBe(false);
        expect(() => createGenerationJobPayload({ taskId: "", ownerId: "owner-1", requestId: "request-1" })).toThrow("任务 ID无效");
        expect(() => createGenerationWorker("http://not-postgres", async () => {}, () => {})).toThrow("任务队列必须使用独立画布 PostgreSQL 数据库");
    });

    test("only a standard generation queue with zero retries is compatible", () => {
        expect(isGenerationQueueReady({ name: "generation", policy: "standard", retryLimit: 0, expireInSeconds: 900 })).toBe(true);
        for (const queue of [null, {}, { name: "other", policy: "standard", retryLimit: 0 }, { name: "generation", policy: "singleton", retryLimit: 0 }, { name: "generation", policy: "standard", retryLimit: 2 }, { name: "generation", policy: "standard", retryLimit: "0" }]) {
            expect(isGenerationQueueReady(queue)).toBe(false);
        }
    });

    test("generation worker checks installed policy before work and releases an incompatible client without opening a connection", async () => {
        for (const scenario of [{ installed: false, policy: "standard", retryLimit: 0 }, { installed: true, policy: "standard", retryLimit: 2 }, { installed: true, policy: "singleton", retryLimit: 0 }, { installed: true, policy: "standard", retryLimit: 0 }]) {
            const events: string[] = [], worker = createGenerationWorker("postgres://localhost/canvas", async () => {}, () => {});
            const queue = worker.queue;
            const mocks = [
                spyOn(queue, "start").mockImplementation(async () => { events.push("start"); return queue; }),
                spyOn(queue, "isInstalled").mockImplementation(async () => { events.push("installed"); return scenario.installed; }),
                spyOn(queue, "getQueue").mockImplementation(async (name) => {
                    events.push(`get:${name}`);
                    return { name, policy: scenario.policy, retryLimit: scenario.retryLimit } as Awaited<ReturnType<typeof queue.getQueue>>;
                }),
                spyOn(queue, "work").mockImplementation(async () => { events.push("work"); return "synthetic-worker"; }),
                spyOn(queue, "stop").mockImplementation(async () => { events.push("stop"); }),
                spyOn(queue, "createQueue").mockImplementation(async () => { throw new Error("runtime must not create queue"); }),
            ];
            try {
                if (scenario.installed && scenario.policy === "standard" && scenario.retryLimit === 0) {
                    await worker.start();
                    expect(events).toEqual(["start", "installed", "get:generation", "work"]);
                    expect(worker.isStarted()).toBe(true);
                    await worker.stop();
                } else {
                    await expect(worker.start()).rejects.toThrow("生成队列未就绪");
                    expect(events).not.toContain("work");
                    expect(events.at(-1)).toBe("stop");
                    expect(worker.isStarted()).toBe(false);
                    expect(events.filter((event) => event === "stop")).toHaveLength(1);
                    if (!scenario.installed) expect(events).not.toContain("get:generation");
                }
            } finally { for (const mock of mocks) mock.mockRestore(); }
        }
    });
});

realTest("real PostgreSQL and transactional queue (isolated runner only)", () => {
    let database: Awaited<ReturnType<typeof createTestDatabase>>;
    const queues: ReturnType<typeof createJobQueue>[] = [];
    const errors: Error[] = [];
    const ownerId = "queue-test-owner";
    let queue: ReturnType<typeof createJobQueue>;
    function client() {
        const instance = createJobQueue(url!, (error) => errors.push(error));
        queues.push(instance);
        return instance;
    }
    beforeAll(async () => {
        database = await createTestDatabase();
        await database.db.insert(user).values({ id: ownerId, name: "Queue test", email: "queue@example.test" });
    }, 30_000);
    afterAll(async () => {
        try { await Promise.all(queues.map((instance) => instance.stop())); }
        finally { if (database) await database.close(); }
    });

    test("network connection uses SCRAM, loopback and a non-superuser database owner", async () => {
        const result = await database.db.execute(sql`
            SELECT current_user AS username, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
                current_setting('listen_addresses') AS listen,
                current_setting('password_encryption') AS password_encryption
            FROM pg_roles r WHERE rolname = current_user
        `);
        expect(result.rows[0]).toMatchObject({
            username: "canvas_test_app", rolsuper: false, rolcreatedb: false, rolcreaterole: false,
            listen: "127.0.0.1", password_encryption: "scram-sha-256",
        });
    });

    test("a normal client refuses a missing schema instead of migrating at startup", async () => {
        const uninstalled = client();
        await expect(uninstalled.start()).rejects.toThrow();
        await uninstalled.stop();
        const result = await database.db.execute(sql`SELECT to_regnamespace('canvas_jobs') AS schema`);
        expect(result.rows[0].schema).toBeNull();
    });

    test("explicit test installation permits queue startup", async () => {
        await database.db.execute(sql.raw(getJobSchemaSql()));
        queue = client();
        await queue.start();
        expect(await queue.isInstalled()).toBe(true);
    }, 30_000);

    test("commit makes both draft and job visible, never a job before its draft", async () => {
        const name = "test-atomic-commit";
        // Test fixtures only: do not silently choose a retry policy for paid generation.
        await queue.createQueue(name, { retryLimit: 0 });
        const result = await database.db.transaction(async (tx) => {
            const draft = await createDraftRepository(tx).create(ownerId, { title: "事务提交", document: {} });
            const id = await queue.send(name, { draftId: draft.id }, { db: fromDrizzle(tx, sql) });
            expect(id).toBeString();
            expect(await queue.fetch(name)).toEqual([]);
            expect(await createDraftRepository(database.db).get(ownerId, draft.id)).toBeNull();
            return { draft, id };
        });
        const [job] = await queue.fetch<{ draftId: string }>(name);
        expect(job.id).toBe(result.id!);
        expect(job.data.draftId).toBe(result.draft.id);
        expect(await createDraftRepository(database.db).get(ownerId, result.draft.id)).not.toBeNull();
        await queue.complete(name, job);
    });

    test("rollback removes both draft and job", async () => {
        const name = "test-atomic-rollback";
        await queue.createQueue(name, { retryLimit: 0 });
        let draftId = "";
        await expect(database.db.transaction(async (tx) => {
            const draft = await createDraftRepository(tx).create(ownerId, { title: "事务撤回", document: {} });
            draftId = draft.id;
            expect(await queue.send(name, { draftId }, { db: fromDrizzle(tx, sql) })).toBeString();
            throw new Error("intentional-rollback");
        })).rejects.toThrow("intentional-rollback");
        expect(await queue.findJobs(name)).toEqual([]);
        expect(await createDraftRepository(database.db).get(ownerId, draftId)).toBeNull();
    });

    test("queue insertion failure rolls back the preceding business write", async () => {
        let draftId = "";
        await expect(database.db.transaction(async (tx) => {
            const draft = await createDraftRepository(tx).create(ownerId, { title: "入队失败", document: {} });
            draftId = draft.id;
            await queue.send("test-unregistered-queue", { draftId }, { db: fromDrizzle(tx, sql) });
        })).rejects.toThrow();
        expect(await createDraftRepository(database.db).get(ownerId, draftId)).toBeNull();
    });

    test("separate connections cannot claim the same pending job", async () => {
        const name = "test-competing-consumers";
        await queue.createQueue(name, { retryLimit: 0 });
        const id = await queue.send(name, { synthetic: true });
        const other = client();
        await other.start();
        const claims = (await Promise.all([queue.fetch(name), other.fetch(name)])).flat();
        expect(claims).toHaveLength(1);
        expect(claims[0].id).toBe(id!);
        await queue.complete(name, claims[0]);
        expect(await other.fetch(name)).toEqual([]);
    });

    test("pending jobs survive closing and recreating the queue client", async () => {
        const name = "test-client-restart";
        await queue.createQueue(name, { retryLimit: 0 });
        const id = await queue.send(name, { synthetic: true });
        await queue.stop();
        queue = client();
        await queue.start();
        const [job] = await queue.fetch(name);
        expect(job.id).toBe(id!);
        await queue.complete(name, job);
    });

    test("leave an atomic draft and pending job for the full server restart check", async () => {
        const name = "test-server-restart";
        await queue.createQueue(name, { retryLimit: 0 });
        await database.db.transaction(async (tx) => {
            await tx.insert(canvasDraft).values({
                id: "restart-draft", ownerId, title: "重启持久化检查", document: { synthetic: true },
            });
            expect(await queue.send(name, { draftId: "restart-draft" }, { db: fromDrizzle(tx, sql) })).toBeString();
        });
        expect(await database.db.select().from(canvasDraft).where(eq(canvasDraft.id, "restart-draft"))).toHaveLength(1);
        expect(errors).toEqual([]);
    });
});
