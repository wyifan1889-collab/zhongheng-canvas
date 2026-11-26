import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "@infinite-canvas/database";
import { createGenerationTaskRepository, type CreateGenerationTaskInput } from "@infinite-canvas/database/generation-tasks";
import { createRateStore, type RateBatchEntry, type RateClient, type RateStore, type RateTransactionRunner } from "@infinite-canvas/database/rate-limit";
import { generationTask, user } from "@infinite-canvas/database/schema";
import { fromDrizzle } from "@infinite-canvas/jobs";
import { enforceGenerationAdmission, type GenerationAdmissionInput } from "../src/content-safety-admission";
import { readContentSafetyConfig, type GenerationRateConfig } from "../src/content-safety-config";
import { createTestDatabase, postgresTestUrl } from "./database";

const enabled = process.env.Q1_D04_POSTGRES === "1", pgTest = enabled ? test : test.skip;
const connectionString = enabled ? postgresTestUrl() : null;
if (enabled && (!connectionString || process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL)) {
    throw new Error("Q1 D04仅接受runner新建的隔离回环PostgreSQL目标");
}
type TestConnection = { db: Database; pool: RateClient; close(): Promise<void> };
type Counter = { key: string; points: number; expire: string };
let first: TestConnection | undefined, second: TestConnection | undefined;
let stores: [RateStore, RateStore];
const secret = `synthetic-d04-${crypto.randomUUID()}`;
let ipSequence = 0;
const nextIp = () => { const value = ipSequence++; return `198.18.${Math.floor(value / 250)}.${value % 250 + 1}`; };
const identity = (): GenerationAdmissionInput => ({ actorId: crypto.randomUUID(), requestId: crypto.randomUUID(), peerIp: nextIp(),
    modelId: `synthetic-model-${crypto.randomUUID()}`, capability: "image" });

/** The same adapter works for a native root transaction and a nested savepoint. */
function runner(database: Database): RateTransactionRunner {
    return work => database.transaction(async tx => {
        const adapter = fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql);
        return work({ query: query => adapter.executeSql(query.text, query.values ?? []) });
    });
}
function entries(config: GenerationRateConfig, input: GenerationAdmissionInput): RateBatchEntry[] {
    const result: RateBatchEntry[] = [];
    if (config.ip) result.push({ bucket: "generation-ip", identity: input.peerIp!, rule: config.ip });
    if (config.user) result.push({ bucket: "generation-user", identity: input.actorId, rule: config.user });
    const model = config.models.find(value => value.modelId === input.modelId);
    if (model) result.push({ bucket: "generation-model", identity: input.modelId, rule: { points: model.points, duration: model.duration } });
    return result;
}
const storedKey = (entry: RateBatchEntry) => `${entry.bucket}:${entry.rule.duration}:${createHmac("sha256", secret).update(`canvas-rate\0${entry.identity}`).digest("hex")}`;
async function counters(values: readonly RateBatchEntry[]): Promise<Counter[]> {
    const keys = [...new Set(values.map(storedKey))];
    if (!keys.length) return [];
    const result = await first!.pool.query({
        text: `SELECT key, points, expire::text AS expire FROM canvas_saas.rate_limit WHERE key IN (${keys.map((_, index) => `$${index + 1}`).join(",")}) ORDER BY key`,
        values: keys,
    }) as { rows: Counter[] };
    return result.rows;
}
function composite(input: GenerationAdmissionInput, points = 5): GenerationRateConfig {
    return { ip: { points, duration: 3600 }, user: { points, duration: 86400 }, models: [{ modelId: input.modelId, points, duration: 3600 }] };
}
const connection = (index: number) => index % 2 ? second! : first!;
const admit = (index: number, config: GenerationRateConfig, input: GenerationAdmissionInput) =>
    enforceGenerationAdmission(stores[index % 2]!, config, input, runner(connection(index).db));

beforeAll(async () => {
    if (!enabled) return;
    // The explicit URL guard above prevents createTestDatabase's PGlite fallback.
    // Apply only the repository's formal migrations; this test creates no schema/DDL.
    first = await createTestDatabase();
    second = createDatabase(connectionString!);
    const boundary = await first.pool.query({ text: `SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, current_setting('server_version_num')::integer AS version,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged,
        pg_backend_pid() AS pid` }) as { rows: Array<{ name: string; role: string; host: string; version: number; privileged: boolean; pid: number }> };
    expect(boundary.rows[0]).toMatchObject({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", version: 160015, privileged: false });
    const other = await second.pool.query({ text: "SELECT pg_backend_pid() AS pid" }) as { rows: Array<{ pid: number }> };
    expect(other.rows[0]!.pid).not.toBe(boundary.rows[0]!.pid);
    stores = [createRateStore(first.pool, secret), createRateStore(second.pool, secret)];
}, 60_000);

afterAll(async () => {
    const closed = await Promise.allSettled([first?.close(), second?.close()]);
    if (closed.some(value => value.status === "rejected")) throw new Error("Q1 D04隔离数据库连接未完整关闭");
});

pgTest("default IP policy admits ten, rejects eleven, and preserves all counters on rejection", async () => {
    const config = readContentSafetyConfig({}).generationRates, input = identity();
    expect(config).toEqual({ ip: { points: 10, duration: 3600 }, user: { points: 50, duration: 86400 }, models: [] });
    for (let index = 0; index < 10; index++) await admit(index, config, { ...input, requestId: crypto.randomUUID() });
    const expected = entries(config, input), before = await counters(expected);
    expect(before).toHaveLength(2);
    expect(before.map(value => value.points)).toEqual([10, 10]);
    await expect(admit(0, config, { ...input, requestId: crypto.randomUUID() })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(await counters(expected)).toEqual(before);
}, 60_000);

pgTest("default user policy admits fifty across distinct IPs and rejects fifty-one without inserting its IP bucket", async () => {
    const config = readContentSafetyConfig({}).generationRates, input = identity();
    const requests = Array.from({ length: 51 }, () => ({ ...input, peerIp: nextIp(), requestId: crypto.randomUUID() }));
    for (let index = 0; index < 50; index++) await admit(index, config, requests[index]!);
    const expected = requests.flatMap(value => entries(config, value)), before = await counters(expected);
    expect(before).toHaveLength(51);
    expect(before.find(value => value.key === storedKey(entries(config, input).find(value => value.bucket === "generation-user")!))?.points).toBe(50);
    expect(before.filter(value => value.key.startsWith("generation-ip:")).every(value => value.points === 1)).toBe(true);
    await expect(admit(1, config, requests[50]!)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(await counters(expected)).toEqual(before);
}, 60_000);

for (const full of ["ip", "user", "model"] as const) {
    pgTest(`a full ${full} bucket rolls back every compound bucket's points and expire`, async () => {
        const input = identity(), config = composite(input);
        await admit(0, config, input);
        const expected = entries(config, input), before = await counters(expected);
        expect(before).toHaveLength(3);
        const limited: GenerationRateConfig = { ip: { ...config.ip!, points: full === "ip" ? 1 : 5 },
            user: { ...config.user!, points: full === "user" ? 1 : 5 },
            models: config.models.map(value => ({ ...value, points: full === "model" ? 1 : 5 })) };
        await expect(admit(1, limited, { ...input, requestId: crypto.randomUUID() })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
        expect(await counters(expected)).toEqual(before);
    }, 60_000);
}

pgTest("forty concurrent requests through two pools obey the shared ceiling despite reversed compound input order", async () => {
    const input = identity(), config = composite(input);
    config.ip!.points = 13; config.user!.points = 17; config.models[0]!.points = 23;
    const values = entries(config, input);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = Array.from({ length: 40 }, async (_, index) => {
        await gate;
        const ordered = index % 2 ? [...values].reverse() : [values[1]!, values[2]!, values[0]!];
        return stores[index % 2]!.consumeMany!(ordered, runner(connection(index).db));
    });
    release();
    const results = await Promise.all(pending);
    expect(results.filter(value => value.allowed)).toHaveLength(13);
    expect(results.filter(value => !value.allowed)).toHaveLength(27);
    for (const value of results) if (!value.allowed) expect(value.retryAfter).toBeGreaterThan(0);
    const current = await counters(values);
    expect(current).toHaveLength(3);
    expect(current.map(value => value.points)).toEqual([13, 13, 13]);
    expect(current.every(value => Number(value.expire) > Date.now())).toBe(true);
}, 60_000);

pgTest("point edits, off/on and a fresh store preserve the window, while an expired window resets", async () => {
    const input = identity(), config: GenerationRateConfig = { ip: { points: 2, duration: 3600 }, user: { points: 50, duration: 86400 }, models: [] };
    await admit(0, config, input);
    const values = entries(config, input), original = await counters(values);
    const raised: GenerationRateConfig = { ...config, ip: { ...config.ip!, points: 4 } };
    await enforceGenerationAdmission(createRateStore(second!.pool, secret), raised, input, runner(second!.db));
    const afterEdit = await counters(values);
    expect(afterEdit).toEqual(original.map(value => ({ ...value, points: 2 })));
    await admit(0, { ip: null, user: null, models: [] }, { ...input, peerIp: undefined });
    expect(await counters(values)).toEqual(afterEdit);
    await admit(1, raised, input);
    const afterOn = await counters(values);
    expect(afterOn).toEqual(original.map(value => ({ ...value, points: 3 })));
    await expect(admit(0, config, input)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(await counters(values)).toEqual(afterOn);
    const expired = Date.now() - 1;
    for (const value of values) await first!.pool.query({ text: "UPDATE canvas_saas.rate_limit SET expire=$2 WHERE key=$1", values: [storedKey(value), expired] });
    const started = Date.now();
    await admit(1, raised, input);
    const finished = Date.now(), reset = await counters(values);
    expect(reset.map(value => value.points)).toEqual([1, 1]);
    for (const value of values) {
        const expire = Number(reset.find(row => row.key === storedKey(value))!.expire);
        expect(expire).toBeGreaterThanOrEqual(started + value.rule.duration * 1000);
        expect(expire).toBeLessThanOrEqual(finished + value.rule.duration * 1000);
    }
}, 60_000);

pgTest("a full PG integer maximum bucket returns a rate rejection with every counter unchanged", async () => {
    const input = identity(), config = composite(input);
    config.user!.points = 2147483647;
    await admit(0, config, input);
    const values = entries(config, input), target = values.find(value => value.bucket === "generation-user")!;
    await first!.pool.query({ text: "UPDATE canvas_saas.rate_limit SET points=2147483647 WHERE key=$1", values: [storedKey(target)] });
    const before = await counters(values);
    await expect(admit(1, config, input)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(await counters(values)).toEqual(before);
}, 60_000);

pgTest("an outer transaction failure also rolls back successful nested admission counters", async () => {
    const input = identity(), config = composite(input), failure = new Error("synthetic failure after admission");
    await expect(first!.db.transaction(async tx => {
        await enforceGenerationAdmission(stores[0], config, input, runner(tx));
        throw failure;
    })).rejects.toBe(failure);
    expect(await counters(entries(config, input))).toEqual([]);
}, 60_000);

pgTest("the real task unique-created gate counts a concurrent same intent once and conflicting intents add nothing", async () => {
    const input = identity(), config = composite(input, 1), idempotencyKey = crypto.randomUUID();
    await first!.db.insert(user).values({ id: input.actorId, name: "合成D04幂等账号", email: `${crypto.randomUUID()}@example.test`, emailVerified: true });
    const intent: CreateGenerationTaskInput = { ownerId: input.actorId, modelId: input.modelId, idempotencyKey,
        requestId: crypto.randomUUID(), inputSnapshot: { prompt: "synthetic rate gate" }, parameterSnapshot: {} };
    const submit = (index: number, changed = false) => connection(index).db.transaction(async tx => {
        const created = await createGenerationTaskRepository(tx).create({ ...intent, requestId: crypto.randomUUID(),
            ...(changed ? { inputSnapshot: { prompt: "different synthetic intent" } } : {}) });
        if (created.created) await enforceGenerationAdmission(stores[index % 2]!, config, { ...input, requestId: created.task.requestId }, runner(tx));
        return created;
    });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => submit(index)));
    expect(results.filter(value => value.created)).toHaveLength(1);
    expect(new Set(results.map(value => value.task.id)).size).toBe(1);
    const before = await counters(entries(config, input));
    expect(before).toHaveLength(3);
    expect(before.map(value => value.points)).toEqual([1, 1, 1]);
    for (let index = 0; index < 4; index++) await expect(submit(index, true)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await counters(entries(config, input))).toEqual(before);
    const tasks = await first!.db.select().from(generationTask).where(eq(generationTask.ownerId, input.actorId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(results[0]!.task.id);
    // This is a repository/transaction test, not validation of the four media dispatch hooks.
}, 60_000);
