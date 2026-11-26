import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "@infinite-canvas/database";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { mediaObject, user } from "@infinite-canvas/database/schema";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { createAndEnqueueGenerationTask } from "../src/generation-dispatch";
import { createGenerationMediaDelivery } from "../src/generation-delivery";
import { createTestDatabase, postgresTestUrl } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
    database = await createTestDatabase();
    await seedGenerationPricing(database.db, [{ modelId: "quota-recovery-image", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 1 }]);
});
afterAll(async () => { await database?.close(); });

async function scenario() {
    const ownerId = crypto.randomUUID();
    await database.db.insert(user).values({ id: ownerId, name: "Synthetic quota recovery", email: `${ownerId}@example.test` });
    const dispatched = await createAndEnqueueGenerationTask(database.db, { async send() { return crypto.randomUUID(); } }, {
        ownerId, modelId: "quota-recovery-image", inputSnapshot: {}, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() });
    const result = await createGenerationResultRepository(database.db).create({ ownerId, taskId: dispatched.task.id, status: "succeeded", resultSnapshot: {} });
    const storage = createMemoryObjectStorage();
    return { ownerId, task: dispatched.task, result: result.result, storage, media: createMediaRepository(database.db),
        dependencies: { database: database.db as Database, storage, quotaBytes: 3, maxBytes: { image: 20, video: 20, audio: 20 },
            async resolveAsset() { return { kind: "image" as const, contentType: "image/png", body: new Uint8Array([1, 2, 3]) }; } } };
}

// Lose the response after the real transaction commits. The root INSERT path
// reproduces the same failure for the previous nontransactional implementation.
function loseCommitResponse(db: Database): Database {
    let lost = false;
    return new Proxy(db, { get(target, property) {
        if (property === "transaction") return async (callback: Parameters<Database["transaction"]>[0]) => {
            const result = await target.transaction(callback);
            if (!lost) { lost = true; throw new Error("Synthetic committed response lost"); }
            return result;
        };
        if (property === "insert") return (table: unknown) => {
            const query = target.insert(table as typeof mediaObject);
            if (table !== mediaObject) return query;
            return new Proxy(query, { get(insert, key) {
                if (key !== "values") return Reflect.get(insert, key);
                return (...args: unknown[]) => {
                    const values = Reflect.apply(insert.values, insert, args);
                    return new Proxy(values, { get(builder, name) {
                        if (name === "returning") return async (...fields: unknown[]) => {
                            const result = await Reflect.apply(builder.returning, builder, fields);
                            if (!lost) { lost = true; throw new Error("Synthetic committed response lost"); }
                            return result;
                        };
                        const member = Reflect.get(builder, name);
                        return typeof member === "function" ? member.bind(builder) : member;
                    } });
                };
            } });
        };
        const member = Reflect.get(target, property);
        return typeof member === "function" ? member.bind(target) : member;
    } });
}

test("committed media response loss preserves the single quota charge and replay", async () => {
    const f = await scenario();
    const deliver = createGenerationMediaDelivery({ ...f.dependencies, database: loseCommitResponse(database.db as Database) });
    expect(await deliver(f)).toMatchObject({ status: "visible", media: { mediaId: f.task.id, sizeBytes: 3 } });
    expect(await f.media.getQuota(f.ownerId, 3)).toMatchObject({ usedBytes: 3, availableBytes: 0 });
    expect(await deliver(f)).toMatchObject({ status: "visible", media: { mediaId: f.task.id } });
    expect(await f.media.getQuota(f.ownerId, 3)).toMatchObject({ usedBytes: 3, availableBytes: 0 });
    expect(await f.media.list(f.ownerId)).toHaveLength(1);
});

test("a competing committed delivery at the exact quota limit keeps its object and one charge", async () => {
    const f = await scenario();
    const put = f.storage.put;
    f.storage.put = async input => {
        const stored = await put(input);
        await database.db.transaction(async tx => {
            const media = createMediaRepository(tx);
            await media.add(f.ownerId, { id: f.task.id, objectKey: stored.key, kind: "image", contentType: stored.contentType, sizeBytes: stored.sizeBytes, etag: stored.etag });
            expect(await media.reserve(f.ownerId, stored.sizeBytes, 3)).toBe(true);
        });
        return stored;
    };
    const deliver = createGenerationMediaDelivery(f.dependencies);
    expect(await deliver(f)).toMatchObject({ status: "visible", media: { mediaId: f.task.id } });
    expect(await f.media.getQuota(f.ownerId, 3)).toMatchObject({ usedBytes: 3 });
    expect(await f.storage.get(objectKey((await f.media.get(f.ownerId, f.task.id))!.objectKey))).not.toBeNull();
});

test("quota refusal rolls back the media row and removes the uncommitted object", async () => {
    const f = await scenario();
    const deliver = createGenerationMediaDelivery({ ...f.dependencies, quotaBytes: 2 });
    expect(await deliver(f)).toEqual({ status: "failed", errorCode: "delivery_quota_exceeded" });
    expect(await f.media.list(f.ownerId)).toEqual([]);
    expect(await f.media.getQuota(f.ownerId, 2)).toMatchObject({ usedBytes: 0 });
    expect(await f.storage.get(objectKey(`accounts/${Buffer.from(f.ownerId).toString("base64url")}/media/${f.task.id}`))).toBeNull();
});

const postgresUrl = postgresTestUrl();
if (postgresUrl) test("actual concurrent deliveries wait on one media row and charge the exact quota once", async () => {
    const f = await scenario(), target = new URL(postgresUrl);
    const application = `media-duplicate-${crypto.randomUUID()}`;
    target.searchParams.set("application_name", application);
    const second = createDatabase(target.toString());
    const bothRead = Promise.withResolvers<void>(), committedRow = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let reads = 0;
    const get = f.storage.get;
    f.storage.get = async key => {
        const object = await get(key);
        if (++reads <= 2) { if (reads === 2) bothRead.resolve(); await bothRead.promise; }
        return object;
    };
    const held = new Proxy(database.db as Database, { get(db, key) {
        if (key === "transaction") return (callback: Parameters<Database["transaction"]>[0]) => db.transaction(async tx => {
            const result = await callback(tx); committedRow.resolve(); await release.promise; return result;
        });
        const member = Reflect.get(db, key);
        return typeof member === "function" ? member.bind(db) : member;
    } });
    const firstDelivery = createGenerationMediaDelivery({ ...f.dependencies, database: held });
    const secondDelivery = createGenerationMediaDelivery({ ...f.dependencies, database: second.db });
    let pending: Promise<unknown[]> | undefined;
    try {
        pending = Promise.all([firstDelivery(f), secondDelivery(f)]);
        await Promise.race([committedRow.promise, pending.then(() => { throw new Error("Expected a held transaction"); })]);
        let blocked: { blockers: number[] } | undefined;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const result = await second.pool.query({ text: "SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", values: [application] });
            if (result.rows.length) { blocked = result.rows[0]; break; }
            await Bun.sleep(10);
        }
        expect(blocked?.blockers.length).toBeGreaterThan(0);
        release.resolve();
        expect(await pending).toMatchObject([{ status: "visible", media: { mediaId: f.task.id } }, { status: "visible", media: { mediaId: f.task.id } }]);
        expect(await f.media.list(f.ownerId)).toHaveLength(1);
        expect(await f.media.getQuota(f.ownerId, 3)).toMatchObject({ usedBytes: 3, availableBytes: 0 });
        expect(await get(objectKey((await f.media.get(f.ownerId, f.task.id))!.objectKey))).not.toBeNull();
        console.log(JSON.stringify({ scenario: "concurrent-delivery-exact-quota", blocked, outcome: "one-media-one-quota-object-preserved" }));
    } finally { release.resolve(); bothRead.resolve(); await pending; await second.close(); }
}, 30_000);
