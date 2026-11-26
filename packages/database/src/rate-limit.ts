import { createHmac } from "node:crypto";
import { RateLimiterPostgres, RateLimiterRes } from "rate-limiter-flexible";

export type RateRule = { points: number; duration: number };
export type RateDecision = { allowed: true } | { allowed: false; retryAfter: number };
export type RateBatchEntry = { bucket: string; identity: string; rule: RateRule };
export type RateTransactionRunner = <T>(work: (client: RateClient) => Promise<T>) => Promise<T>;
export type RateStore = {
    consume(bucket: string, identity: string, rule: RateRule): Promise<RateDecision>;
    /** Requires a caller-owned transaction/savepoint; never falls back to single consumes. */
    consumeMany?: (entries: readonly RateBatchEntry[], transaction: RateTransactionRunner) => Promise<RateDecision>;
    /** Optional so isolated callers can use a minimal fake store; production exposes it. */
    cleanupExpired?: (before?: number) => Promise<number>;
};
export type RateClient = { query(query: { text: string; values?: unknown[]; name?: string }): Promise<unknown> };

/** Bounds used by new generation policies; legacy single-bucket validation is unchanged. */
export function isValidRateRule(rule: RateRule): boolean {
    const milliseconds = rule.duration * 1000;
    return Number.isSafeInteger(rule.points) && rule.points >= 1 && rule.points <= 2147483647 &&
        Number.isSafeInteger(rule.duration) && rule.duration >= 1 &&
        Number.isSafeInteger(milliseconds) && Number.isSafeInteger(Date.now() + milliseconds);
}

function rowCount(result: unknown): number {
    if (!result || typeof result !== "object") return 0;
    const value = (result as { rowCount?: unknown; affectedRows?: unknown }).rowCount ?? (result as { affectedRows?: unknown }).affectedRows;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Shared PostgreSQL counters, not per-process memory. Store failures must fail closed at the API. */
export function createRateStore(pool: RateClient, secret: string): RateStore {
    if (!secret) throw new Error("限流身份摘要密钥未配置");
    const limiters = new Map<string, RateLimiterPostgres>();
    return {
        async consume(bucket, identity, rule) {
            if (!Number.isSafeInteger(rule.points) || rule.points < 1 || !Number.isSafeInteger(rule.duration) || rule.duration < 1) {
                throw new Error("无效的限流策略");
            }
            const prefix = `${bucket}:${rule.points}:${rule.duration}`;
            let limiter = limiters.get(prefix);
            if (!limiter) {
                limiter = new RateLimiterPostgres({
                    storeClient: pool, storeType: "pool", schemaName: "canvas_saas", tableName: "rate_limit",
                    // The dependency runs an unref'd cleanup every five minutes and
                    // removes rows at least one hour expired. `cleanupExpired` below
                    // remains available for an explicit deployment scheduler.
                    tableCreated: true, clearExpiredByTimeout: true, keyPrefix: prefix, ...rule,
                });
                limiters.set(prefix, limiter);
            }
            const key = createHmac("sha256", secret).update(`canvas-rate\0${identity}`).digest("hex");
            try {
                await limiter.consume(key);
                return { allowed: true };
            } catch (error) {
                if (error instanceof RateLimiterRes) {
                    return { allowed: false, retryAfter: Math.max(1, Math.ceil(error.msBeforeNext / 1000)) };
                }
                throw error;
            }
        },
        async consumeMany(entries, transaction) {
            const planned = new Map<string, { prefix: string; identity: string; rule: RateRule }>();
            for (const entry of entries) {
                if (!isValidRateRule(entry.rule) || typeof entry.bucket !== "string" || !entry.bucket || entry.bucket.includes("\0") ||
                    typeof entry.identity !== "string" || !entry.identity) throw new Error("无效的限流策略");
                const prefix = `${entry.bucket}:${entry.rule.duration}`;
                const identity = createHmac("sha256", secret).update(`canvas-rate\0${entry.identity}`).digest("hex");
                const key = `${prefix}:${identity}`;
                if ([...key].length > 255) throw new Error("无效的限流策略");
                const previous = planned.get(key);
                if (previous && previous.rule.points !== entry.rule.points) throw new Error("重复限流键的策略不一致");
                planned.set(key, { prefix, identity, rule: { points: entry.rule.points, duration: entry.rule.duration } });
            }
            if (!planned.size) return { allowed: true };
            // Compare the complete stored keys without locale-dependent collation.
            const ordered = [...planned].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
            try {
                await transaction(async client => {
                    for (const [key, entry] of ordered) {
                        const result = await client.query({
                            text: 'SELECT points, expire FROM "canvas_saas"."rate_limit" WHERE key = $1 FOR UPDATE', values: [key],
                        });
                        const rows = (result as { rows?: Array<{ points: number; expire: number | string }> } | null)?.rows;
                        if (!Array.isArray(rows) || rows.length > 1) throw new Error("无效的限流存储结果");
                        if (rows.length) {
                            const { points, expire: storedExpire } = rows[0]!;
                            const expire = typeof storedExpire === "string" ? Number(storedExpire) : storedExpire;
                            if (!Number.isSafeInteger(points) || points < 0 || points > 2147483647 ||
                                !Number.isSafeInteger(expire) || expire < 0) throw new Error("无效的限流存储结果");
                            // Avoid the library's increment-before-rejection overflowing
                            // PostgreSQL integer at a full maximum-sized bucket.
                            const now = Date.now();
                            if (expire > now && points >= entry.rule.points) {
                                throw new RateLimiterRes(0, expire - now, points, false);
                            }
                        }
                        const limiter = new RateLimiterPostgres({
                            storeClient: client, storeType: "client", schemaName: "canvas_saas", tableName: "rate_limit",
                            tableCreated: true, clearExpiredByTimeout: false, keyPrefix: entry.prefix, ...entry.rule,
                        });
                        // A concurrent insert can make the library reject after
                        // incrementing; let that rejection escape the savepoint too.
                        await limiter.consume(entry.identity);
                    }
                });
                return { allowed: true };
            } catch (error) {
                if (error instanceof RateLimiterRes) {
                    if (!Number.isSafeInteger(error.msBeforeNext) || error.msBeforeNext < 0) throw new Error("无效的限流存储周期");
                    return { allowed: false, retryAfter: Math.max(1, Math.ceil(error.msBeforeNext / 1000)) };
                }
                throw error;
            }
        },
        async cleanupExpired(before = Date.now() - 60 * 60 * 1000) {
            if (!Number.isSafeInteger(before) || before < 0) throw new Error("无效的限流清理边界");
            // Keep this explicit and bounded by the indexed expire column. The
            // one-hour grace matches rate-limiter-flexible's own cleanup policy;
            // callers decide when to schedule it instead of hiding a worker here.
            const result = await pool.query({
                name: "canvas-rate-cleanup-expired",
                text: 'DELETE FROM "canvas_saas"."rate_limit" WHERE expire IS NOT NULL AND expire < $1',
                values: [before],
            });
            return rowCount(result);
        },
    };
}
