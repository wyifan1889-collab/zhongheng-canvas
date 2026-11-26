import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createRateStore, isValidRateRule, type RateBatchEntry, type RateClient, type RateTransactionRunner } from "@infinite-canvas/database/rate-limit";

const secret = "synthetic-rate-batch-test-secret";
const initialTime = 1800000000000;
let now = initialTime;
afterEach(() => { now = initialTime; });

type Row = { points: number; expire: number };
type Query = Parameters<RateClient["query"]>[0];
const entry = (bucket: string, points = 5, identity = "synthetic-identity", duration = 60): RateBatchEntry => ({ bucket, identity, rule: { points, duration } });
const storedKey = (value: RateBatchEntry) => `${value.bucket}:${value.rule.duration}:${createHmac("sha256", secret).update(`canvas-rate\0${value.identity}`).digest("hex")}`;

/** A savepoint/SQL protocol fake; the actual installed limiter still builds and executes its SQL. */
function fixture() {
    const state = {
        rows: new Map<string, Row>(), queries: [] as Query[], rollbacks: [] as unknown[], commits: 0, begins: 0, poolCalls: 0,
        failKey: "", failure: new Error("synthetic SQL failure"),
        pool: { async query() { state.poolCalls++; throw new Error("batch escaped its transaction client"); } },
        async transaction<T>(work: (client: RateClient) => Promise<T>): Promise<T> {
            state.begins++;
            const staged = new Map([...state.rows].map(([key, row]) => [key, { ...row }]));
            let closed = false;
            const client: RateClient = { async query(query) {
                if (closed) throw new Error("a previous transaction client was retained");
                state.queries.push(query);
                const key = query.values?.[0] as string;
                if (key === state.failKey) throw state.failure;
                if (query.text.startsWith("SELECT")) {
                    expect(query.text).toContain("FOR UPDATE");
                    const row = staged.get(key);
                    // pg returns bigint expire as a string by default.
                    return { rows: row ? [{ points: row.points, expire: String(row.expire) }] : [] };
                }
                if (!query.text.includes('INSERT INTO "canvas_saas"."rate_limit"')) throw new Error("unexpected limiter SQL");
                const [, increment, newExpire, currentTime] = query.values as [string, number, number, number];
                const previous = staged.get(key);
                const row = previous && previous.expire > currentTime ? { ...previous, points: previous.points + increment } : { points: increment, expire: newExpire };
                if (row.points > 2147483647) throw new Error("simulated PostgreSQL integer overflow");
                staged.set(key, row);
                return { rows: [{ ...row }] };
            } };
            try {
                const result = await work(client);
                state.rows = staged;
                state.commits++;
                return result;
            } catch (error) {
                state.rollbacks.push(error);
                throw error;
            } finally { closed = true; }
        },
    };
    return state;
}

async function atFixedTime(work: () => Promise<void>) {
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try { await work(); } finally { clock.mockRestore(); }
}

test("batch locks complete HMAC keys in stable order, using only fresh savepoint clients without cleanup", async () => atFixedTime(async () => {
    const db = fixture();
    const rates = createRateStore(db.pool, secret);
    const extraFields = { ...entry("z-bucket"), rule: { points: 5, duration: 60, keyPrefix: "unsafe", storeClient: db.pool, clearExpiredByTimeout: true } };
    const entries = [extraFields, entry("a-bucket", 5, "private-user@example.test"), entry("a-bucket", 5, "198.51.100.42")];
    const timer = spyOn(globalThis, "setTimeout");
    try {
        expect(await rates.consumeMany!(entries, db.transaction)).toEqual({ allowed: true });
        expect(await rates.consumeMany!([...entries].reverse(), db.transaction)).toEqual({ allowed: true });
        expect(timer).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); }
    const expected = entries.map(storedKey).sort();
    const selects = db.queries.filter(query => query.text.startsWith("SELECT")).map(query => query.values![0]);
    expect(selects).toEqual([...expected, ...expected]);
    expect([...db.rows.values()].map(row => row.points)).toEqual([2, 2, 2]);
    expect(db.poolCalls).toBe(0);
    expect(db.commits).toBe(2);
    expect(JSON.stringify(db.queries)).not.toContain("private-user@example.test");
    expect(JSON.stringify(db.queries)).not.toContain("198.51.100.42");
}));

test("identical complete keys consume once; conflicting duplicate policies fail before any transaction", async () => atFixedTime(async () => {
    const db = fixture();
    const rates = createRateStore(db.pool, secret);
    const value = entry("generation-user");
    expect(await rates.consumeMany!([value, { ...value, rule: { ...value.rule } }], db.transaction)).toEqual({ allowed: true });
    expect(db.rows.get(storedKey(value))?.points).toBe(1);
    expect(db.queries).toHaveLength(2);
    await expect(rates.consumeMany!([value, { ...value, rule: { ...value.rule, points: 9 } }], db.transaction)).rejects.toThrow("策略不一致");
    expect(db.begins).toBe(1);
    expect(db.rows.get(storedKey(value))?.points).toBe(1);
}));

test("either an early or late bucket denial escapes the savepoint and preserves all points and expiries", async () => atFixedTime(async () => {
    for (const fullBucket of ["a-ip", "z-user"]) {
        const db = fixture();
        const rates = createRateStore(db.pool, secret);
        const initial = [entry("z-user"), entry("a-ip")];
        await rates.consumeMany!(initial, db.transaction);
        const before = [...db.rows];
        now += 1001;
        const decision = await rates.consumeMany!(initial.map(value => ({ ...value, rule: { ...value.rule, points: value.bucket === fullBucket ? 1 : 5 } })), db.transaction);
        expect(decision).toEqual({ allowed: false, retryAfter: 59 });
        expect([...db.rows]).toEqual(before);
        expect(db.rollbacks).toHaveLength(1);
        expect(db.rollbacks[0]).toMatchObject({ consumedPoints: 1, remainingPoints: 0 });
        expect(db.commits).toBe(1);
        now = initialTime;
    }
}));

test("an unexpected store failure rolls back preceding buckets and preserves the original error", async () => atFixedTime(async () => {
    const db = fixture();
    const rates = createRateStore(db.pool, secret);
    const entries = [entry("a-ip"), entry("z-user")];
    await rates.consumeMany!(entries, db.transaction);
    const before = [...db.rows];
    db.failKey = storedKey(entries[1]!);
    await expect(rates.consumeMany!(entries, db.transaction)).rejects.toBe(db.failure);
    expect([...db.rows]).toEqual(before);
    expect(db.rollbacks).toEqual([db.failure]);
    expect(db.commits).toBe(1);
}));

test("the limiter rejection after an absent-row read also escapes and rolls back every bucket", async () => atFixedTime(async () => {
    const db = fixture();
    const rates = createRateStore(db.pool, secret);
    const entries = [entry("a-ip"), entry("z-user", 1)];
    await rates.consumeMany!(entries, db.transaction);
    const before = [...db.rows];
    // Simulate another connection inserting the full row after SELECT found none,
    // before this transaction's INSERT ON CONFLICT acquires that row's lock.
    const absentRead: RateTransactionRunner = work => db.transaction(client => work({ async query(query) {
        if (query.text.startsWith("SELECT") && query.values?.[0] === storedKey(entries[1]!)) return { rows: [] };
        return client.query(query);
    } }));
    expect(await rates.consumeMany!(entries, absentRead)).toEqual({ allowed: false, retryAfter: 60 });
    expect([...db.rows]).toEqual(before);
    expect(db.rollbacks[0]).toMatchObject({ consumedPoints: 2, remainingPoints: 0 });
    expect(db.commits).toBe(1);
}));

test("policy point changes, skipped consumption and a new store retain the fixed window; expiry resets it", async () => atFixedTime(async () => {
    const db = fixture();
    const value = entry("generation-ip", 3);
    await createRateStore(db.pool, secret).consumeMany!([value], db.transaction);
    const firstExpire = db.rows.get(storedKey(value))!.expire;
    now += 1000; // Disabled periods perform no consumption; a later store uses the same key.
    const rates = createRateStore(db.pool, secret);
    await rates.consumeMany!([{ ...value, rule: { ...value.rule, points: 8 } }], db.transaction);
    expect(db.rows.get(storedKey(value))).toEqual({ points: 2, expire: firstExpire });
    expect(await rates.consumeMany!([{ ...value, rule: { ...value.rule, points: 1 } }], db.transaction)).toMatchObject({ allowed: false });
    expect(db.rows.get(storedKey(value))).toEqual({ points: 2, expire: firstExpire });
    now = firstExpire;
    expect(await rates.consumeMany!([value], db.transaction)).toEqual({ allowed: true });
    expect(db.rows.get(storedKey(value))).toEqual({ points: 1, expire: now + 60000 });
    await rates.consumeMany!([{ ...value, rule: { ...value.rule, duration: 120 } }], db.transaction);
    expect(db.rows.size).toBe(2);
}));

test("a full PG integer maximum bucket denies without overflow, then resets after expiry", async () => atFixedTime(async () => {
    const db = fixture();
    const value = entry("generation-user", 2147483647);
    const rates = createRateStore(db.pool, secret);
    db.rows.set(storedKey(value), { points: 2147483647, expire: now + 1000 });
    expect(await rates.consumeMany!([value], db.transaction)).toEqual({ allowed: false, retryAfter: 1 });
    expect(db.queries).toHaveLength(1);
    expect(db.rows.get(storedKey(value))?.points).toBe(2147483647);
    now += 1000;
    expect(await rates.consumeMany!([value], db.transaction)).toEqual({ allowed: true });
    expect(db.rows.get(storedKey(value))).toEqual({ points: 1, expire: now + 60000 });
}));

test("batch validates PG integer and exact millisecond ranges before opening a transaction", async () => atFixedTime(async () => {
    const db = fixture();
    const rates = createRateStore(db.pool, secret);
    const value = entry("generation-ip");
    const badRules = [
        ...[0, -1, 1.1, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER].map(points => ({ points, duration: 60 })),
        ...[0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER, Math.floor((Number.MAX_SAFE_INTEGER - now) / 1000) + 1].map(duration => ({ points: 1, duration })),
    ];
    for (const rule of badRules) {
        expect(isValidRateRule(rule)).toBe(false);
        await expect(rates.consumeMany!([value, { ...value, rule }], db.transaction)).rejects.toThrow("无效的限流策略");
    }
    expect(isValidRateRule({ points: 2147483647, duration: 60 })).toBe(true);
    await expect(rates.consumeMany!([entry("x".repeat(255))], db.transaction)).rejects.toThrow("无效的限流策略");
    expect(db.begins).toBe(0);
    expect(db.poolCalls).toBe(0);
}));

test("an empty batch needs no transaction, while legacy consume keeps its original key and validation", async () => atFixedTime(async () => {
    const queries: Query[] = [];
    const client: RateClient = { async query(query) { queries.push(query); return { rows: [{ points: 1, expire: now + 60000 }] }; } };
    const rates = createRateStore(client, secret);
    const noTransaction: RateTransactionRunner = async () => { throw new Error("empty batch opened a transaction"); };
    expect(await rates.consumeMany!([], noTransaction)).toEqual({ allowed: true });
    // The legacy single-bucket path intentionally keeps its former safe-integer bound.
    expect(await rates.consume("legacy", "synthetic-identity", { points: 2147483648, duration: 60 })).toEqual({ allowed: true });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.values![0]).toBe(`legacy:2147483648:60:${createHmac("sha256", secret).update("canvas-rate\0synthetic-identity").digest("hex")}`);
}));
