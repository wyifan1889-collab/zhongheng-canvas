import { z } from "zod";
import { readVideoRuntimePolicy, type VideoRuntimePolicy } from "./generation-video-config";

const queueUrl = z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
}, "必须是独立画布 PostgreSQL 连接");

const enabled = z.enum(["true", "false"]);
const batchSize = z.coerce.number().int().min(1).max(100).refine(Number.isSafeInteger);

/** Compare explicit PostgreSQL targets; query options must not override their identity. */
export function canonicalPostgresTarget(value: string, label: string): string {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${label}必须是 PostgreSQL 连接`); }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(`${label}必须是 PostgreSQL 连接`);
    if (["host", "port", "database", "dbname"].some((key) => url.searchParams.has(key))) {
        throw new Error(`${label}不能通过查询参数覆盖数据库目标`);
    }
    if (!url.hostname || url.pathname.length <= 1) throw new Error(`${label}必须显式指定主机和数据库`);
    let host: string, database: string;
    try {
        host = decodeURIComponent(url.hostname);
        // node-postgres decodes the database pathname and preserves its trailing slash.
        database = decodeURI(url.pathname.slice(1));
    } catch { throw new Error(`${label}的数据库目标编码无效`); }
    return `postgresql://${host.startsWith("/") ? host : host.toLowerCase()}:${url.port || "5432"}/${database}`;
}

export type ProductionGenerationTarget = {
    target?: "staging" | "production";
    expectedOrigin?: string;
    /** Credential-free target, pinned from the separately reviewed API configuration. */
    expectedDatabaseTarget?: string;
    authorizeProductionReadOnly?: boolean;
    authorizeProductionSchemaInstall?: boolean;
};

/** Explicit operational acknowledgement; this does not grant database or server privileges. */
export function assertProductionGenerationTarget(
    env: Record<string, string | undefined>, options: ProductionGenerationTarget, apply = false,
): void {
    if (options.target !== "production") throw new Error("必须明确选择 production target");
    if (apply ? (!options.authorizeProductionSchemaInstall || options.authorizeProductionReadOnly)
        : (!options.authorizeProductionReadOnly || options.authorizeProductionSchemaInstall)) {
        throw new Error("production check 与 schema install 必须使用各自独立的授权参数");
    }
    if (env.GENERATION_WORKER_ENVIRONMENT !== "production") throw new Error("production target 需要 production worker 环境");
    const validOrigin = (value: string | undefined) => {
        try {
            const url = new URL(value ?? "");
            return url.origin === "https://agent.zh-api.com" && !url.username && !url.password &&
                url.pathname === "/" && !url.search && !url.hash;
        } catch { return false; }
    };
    if (!validOrigin(options.expectedOrigin) || !validOrigin(env.SAAS_ORIGIN)) throw new Error("production 来源与明确预期来源不符");
    let expected: URL;
    try { expected = new URL(options.expectedDatabaseTarget ?? ""); }
    catch { throw new Error("production 需要明确预期数据库目标"); }
    if (expected.username || expected.password || expected.search || expected.hash) throw new Error("预期数据库目标不能含凭据、查询或片段");
    const target = canonicalPostgresTarget(expected.href, "预期数据库");
    if (target !== canonicalPostgresTarget(env.SAAS_DATABASE_URL ?? "", "SAAS_DATABASE_URL") ||
        target !== canonicalPostgresTarget(env.GENERATION_WORKER_QUEUE_URL ?? "", "GENERATION_WORKER_QUEUE_URL")) {
        throw new Error("production 应用及队列必须与预期目标使用同一数据库");
    }
}

export type GenerationWorkerConfig = {
    /** This type is only returned after an explicit opt-in and complete config. */
    enabled: true;
    queueConnectionString: string;
    maxBatchSize: number;
    environment: "staging" | "production";
    /** Parsed policy is configuration only; it grants no probe execution capability. */
    videoPolicy?: VideoRuntimePolicy;
    videoEnabled?: boolean;
};

/**
 * Read the independent generation worker contract without starting anything.
 *
 * The worker is deliberately absent by default. Setting the enable flag to
 * `true` requires an explicit queue database URL, environment label and safe
 * batch limit; this function never opens a database or creates a worker.
 */
export function readGenerationWorkerConfig(env: Record<string, string | undefined>): GenerationWorkerConfig | null {
    const flag = env.GENERATION_WORKER_ENABLED;
    if (flag === undefined || flag === "false") return null;
    if (flag !== "true") throw new Error("GENERATION_WORKER_ENABLED 只能是 true 或 false");

    const parsed = z.object({
        GENERATION_WORKER_ENABLED: enabled,
        GENERATION_WORKER_QUEUE_URL: queueUrl,
        GENERATION_WORKER_ENVIRONMENT: z.enum(["staging", "production"]),
        GENERATION_WORKER_MAX_BATCH_SIZE: batchSize.default(20),
    }).safeParse(env);
    if (!parsed.success) {
        throw new Error(`generation worker 配置无效：${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join("、")}`);
    }
    const videoPolicy = readVideoRuntimePolicy(env);
    return {
        enabled: true,
        queueConnectionString: parsed.data.GENERATION_WORKER_QUEUE_URL,
        maxBatchSize: parsed.data.GENERATION_WORKER_MAX_BATCH_SIZE,
        environment: parsed.data.GENERATION_WORKER_ENVIRONMENT,
        ...(videoPolicy ? { videoPolicy, videoEnabled: env.GENERATION_WORKER_VIDEO_ENABLED === "true" } : {}),
    };
}
