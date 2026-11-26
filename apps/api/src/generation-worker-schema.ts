import { createDatabase } from "@infinite-canvas/database";
import { z } from "zod";
import { createJobQueue, GENERATION_QUEUE_NAME, getJobSchemaSql, isGenerationQueueReady, JOB_SCHEMA } from "@infinite-canvas/jobs";
import { assertProductionGenerationTarget, canonicalPostgresTarget, readGenerationWorkerConfig, type ProductionGenerationTarget } from "./generation-worker-config";

type QueryResult<Row> = { rows: readonly Row[] };
export type GenerationWorkerSchemaClient = {
    query(text: string, values?: readonly unknown[]): Promise<QueryResult<Record<string, unknown>>>;
};

type SchemaCheckRow = { exists?: boolean };

export const productionGenerationMetadataSchema = z.object({
    schemaState: z.enum(["missing", "partial", "ready"]),
    installedSchemaVersion: z.number().int().nonnegative().nullable(),
    queue: z.object({ name: z.string(), policy: z.string(), retryLimit: z.number().int().nonnegative() }).strict().nullable(),
    applicationRelations: z.array(z.string()),
}).strict();
export type ProductionGenerationMetadata = z.infer<typeof productionGenerationMetadataSchema>;
export const productionVideoResourceInspectionSchema = z.object({
    ready: z.boolean(), platform: z.string().regex(/^[a-z0-9_]+$/),
    reasons: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
}).strict().refine((value) => value.ready
    ? ["linux", "win32"].includes(value.platform) && value.reasons.length === 0 : value.reasons.length > 0,
"资源检查状态与原因不一致");
export const productionGenerationFixtureSchema = z.object({
    env: z.record(z.string(), z.string()), metadata: productionGenerationMetadataSchema,
    videoResources: productionVideoResourceInspectionSchema.optional(),
}).strict();

export type GenerationWorkerSchemaConfig = {
    queueConnectionString: string;
    applicationConnectionString: string;
    environment: "staging" | "production";
};

export type GenerationWorkerSchemaState = "missing" | "ready" | "partial";

// These are the fixed tables created by the pg-boss 12.35.0 construction
// plan. Queue-specific partitions are created later by pg-boss itself.
const CORE_TABLES = [
    "version",
    "queue",
    "schedule",
    "subscription",
    "bam",
    "job",
    "job_common",
    "warning",
    "queue_stats",
    "job_dependency",
] as const;

/**
 * Staging remains the default. Production needs a separate target and acknowledgement.
 * The queue must share the explicit staging application database so enqueue
 * can participate in the task/wallet transaction. Installation stays manual.
 */
export function readGenerationWorkerSchemaConfig(
    env: Record<string, string | undefined>,
    options: ProductionGenerationTarget & { apply?: boolean } = {},
): GenerationWorkerSchemaConfig {
    const worker = readGenerationWorkerConfig(env);
    if (!worker) throw new Error("启用 schema 操作前必须设置 GENERATION_WORKER_ENABLED=true");
    if (options.target === "production") assertProductionGenerationTarget(env, options, options.apply === true);
    else if (worker.environment !== "staging") {
        throw new Error("canvas_jobs schema 操作只允许 staging 环境");
    }
    const originValue = env.SAAS_ORIGIN;
    if (!originValue) throw new Error("schema 操作需要 SAAS_ORIGIN");
    let origin: URL;
    try { origin = new URL(originValue); } catch { throw new Error("SAAS_ORIGIN 必须是绝对 HTTPS 来源"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
        throw new Error("SAAS_ORIGIN 必须是没有凭据、路径、查询或片段的绝对 HTTPS 来源");
    }
    if (options.target !== "production" && origin.hostname.toLowerCase() === "agent.zh-api.com") {
        throw new Error("canvas_jobs schema 操作拒绝 production 来源");
    }
    const application = env.SAAS_DATABASE_URL;
    if (!application) throw new Error("schema 操作需要 SAAS_DATABASE_URL 作为应用数据库边界");
    const queue = canonicalPostgresTarget(worker.queueConnectionString, "GENERATION_WORKER_QUEUE_URL");
    const app = canonicalPostgresTarget(application, "SAAS_DATABASE_URL");
    if (queue !== app) throw new Error("GENERATION_WORKER_QUEUE_URL 必须与 SAAS_DATABASE_URL 使用同一数据库");
    if (options.target !== "production" && (options.authorizeProductionReadOnly || options.authorizeProductionSchemaInstall || options.expectedOrigin || options.expectedDatabaseTarget)) {
        throw new Error("production 参数需要明确 production target");
    }
    return { queueConnectionString: worker.queueConnectionString, applicationConnectionString: application, environment: worker.environment };
}

/** Derive the exact version from the pinned library's own construction plan, never run it. */
export function expectedGenerationSchemaVersion(): number {
    const versions = [...getJobSchemaSql().matchAll(/INSERT INTO canvas_jobs\.version\(version\) VALUES \('(\d+)'\)/g)];
    if (versions.length !== 1 || !Number.isSafeInteger(Number(versions[0]![1]))) throw new Error("无法核实冻结 pg-boss schema 版本");
    return Number(versions[0]![1]);
}

export async function inspectGenerationSchemaVersion(client: GenerationWorkerSchemaClient) {
    const expected = expectedGenerationSchemaVersion();
    const { rows } = await client.query("SELECT version FROM canvas_jobs.version");
    const installed = rows.length === 1 && Number.isSafeInteger(rows[0]?.version) ? rows[0]!.version as number : null;
    return { expected, installed, compatible: installed === expected };
}

async function hasTable(client: GenerationWorkerSchemaClient, table: string) {
    const result = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS exists",
        [JOB_SCHEMA, table],
    );
    return Boolean((result.rows[0] as SchemaCheckRow | undefined)?.exists);
}

/** Read-only inspection of the fixed pg-boss installation contract. */
export async function inspectGenerationWorkerSchema(client: GenerationWorkerSchemaClient): Promise<GenerationWorkerSchemaState> {
    const result = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists",
        [JOB_SCHEMA],
    );
    if (!Boolean((result.rows[0] as SchemaCheckRow | undefined)?.exists)) return "missing";
    // Inspection holds one read-only connection; node-postgres requires serial queries on it.
    for (const table of CORE_TABLES) {
        if (!await hasTable(client, table)) return "partial";
    }
    return "ready";
}

export type GenerationWorkerSchemaOperation = {
    state: GenerationWorkerSchemaState;
    applied: boolean;
};

export type GenerationQueueSettings = {
    policy: string;
    retryLimit: number;
    retryDelay: number;
    retryBackoff: boolean;
    retryDelayMax: number | null;
    expireInSeconds: number;
    retentionSeconds: number;
    deleteAfterSeconds: number;
    heartbeatSeconds: number | null;
};
export type GenerationQueueInspection = {
    state: "missing" | "ready" | "policy_mismatch" | "unavailable";
    settings: GenerationQueueSettings | null;
};
export type GenerationInstallationOperation = {
    schema: GenerationWorkerSchemaOperation;
    queue: GenerationQueueInspection & { applied: boolean };
    version?: Awaited<ReturnType<typeof inspectGenerationSchemaVersion>>;
};

/** Fixed metadata only: never start pg-boss (or its maintenance timers) during inspection. */
export async function inspectGenerationQueue(client: GenerationWorkerSchemaClient): Promise<GenerationQueueInspection> {
    const { rows } = await client.query(`SELECT name, policy, retry_limit AS "retryLimit", retry_delay AS "retryDelay",
        retry_backoff AS "retryBackoff", retry_delay_max AS "retryDelayMax", expire_seconds AS "expireInSeconds",
        retention_seconds AS "retentionSeconds", deletion_seconds AS "deleteAfterSeconds", heartbeat_seconds AS "heartbeatSeconds"
        FROM canvas_jobs.queue WHERE name = $1`, [GENERATION_QUEUE_NAME]);
    if (!rows.length) return { state: "missing", settings: null };
    const row = rows[0];
    const integers = ["retryLimit", "retryDelay", "expireInSeconds", "retentionSeconds", "deleteAfterSeconds"] as const;
    if (typeof row.policy !== "string" || typeof row.retryBackoff !== "boolean" ||
        integers.some((field) => !Number.isSafeInteger(row[field]) || Number(row[field]) < 0) ||
        [row.retryDelayMax, row.heartbeatSeconds].some((value) => value !== null && (!Number.isSafeInteger(value) || Number(value) < 0))) {
        throw new Error("generation 队列元数据格式无效");
    }
    const settings: GenerationQueueSettings = {
        policy: row.policy, retryLimit: row.retryLimit as number, retryDelay: row.retryDelay as number,
        retryBackoff: row.retryBackoff, retryDelayMax: row.retryDelayMax as number | null,
        expireInSeconds: row.expireInSeconds as number, retentionSeconds: row.retentionSeconds as number,
        deleteAfterSeconds: row.deleteAfterSeconds as number, heartbeatSeconds: row.heartbeatSeconds as number | null,
    };
    return { state: isGenerationQueueReady(row) ? "ready" : "policy_mismatch", settings };
}

/**
 * Install only a missing schema. Existing or partial schemas are never
 * rewritten by this helper; partial installations require manual review.
 */
export async function ensureGenerationWorkerSchema(
    client: GenerationWorkerSchemaClient,
    apply: boolean,
): Promise<GenerationWorkerSchemaOperation> {
    const state = await inspectGenerationWorkerSchema(client);
    if (state === "ready") return { state, applied: false };
    if (!apply) return { state, applied: false };
    if (state === "partial") throw new Error("canvas_jobs schema 不完整，拒绝自动改写；请先人工核对");
    await client.query(getJobSchemaSql());
    return { state: await inspectGenerationWorkerSchema(client), applied: true };
}

export type GenerationWorkerSchemaProcessOptions = ProductionGenerationTarget & {
    env?: Record<string, string | undefined>;
    apply?: boolean;
    databaseFactory?: typeof createDatabase;
    queueFactory?: (connectionString: string, onError: (error: Error) => void) => Pick<ReturnType<typeof createJobQueue>, "start" | "stop" | "createQueue">;
};

/** No production connection can be constructed before the explicit target gate passes. */
export async function runGenerationWorkerSchemaOperation(
    options: GenerationWorkerSchemaProcessOptions = {},
): Promise<GenerationInstallationOperation> {
    const config = readGenerationWorkerSchemaConfig(options.env ?? process.env, options);
    if (config.environment === "production") expectedGenerationSchemaVersion();
    const databaseFactory = options.databaseFactory ?? createDatabase;
    const database = databaseFactory(config.queueConnectionString);
    let client: (GenerationWorkerSchemaClient & { release(): void }) | undefined;
    let readOnly = false;
    try {
        const connection = await database.pool.connect();
        client = {
            query: (text, values) => connection.query(text, values ? [...values] : undefined),
            release: () => connection.release(),
        };
        const apply = options.apply === true;
        if (!apply) { await client.query("BEGIN TRANSACTION READ ONLY"); readOnly = true; }
        const schema = await ensureGenerationWorkerSchema(client, apply);
        if (schema.state !== "ready") return { schema, queue: { state: "unavailable", settings: null, applied: false } };
        const version = config.environment === "production" ? await inspectGenerationSchemaVersion(client) : undefined;
        if (version && !version.compatible) throw new Error("pg-boss schema 版本不兼容，拒绝安装或自动升级");
        let queue = await inspectGenerationQueue(client);
        let applied = false;
        if (apply && queue.state === "missing") {
            const installer = (options.queueFactory ?? createJobQueue)(config.queueConnectionString,
                () => console.error("generation queue installation connection error"));
            try {
                await installer.start();
                // Existing no-resend contract only. Other settings inherit pinned pg-boss defaults,
                // are reported below, and must be reviewed before a real installation is approved.
                await installer.createQueue(GENERATION_QUEUE_NAME, { retryLimit: 0 });
                applied = true;
            } finally {
                await installer.stop();
            }
            queue = await inspectGenerationQueue(client);
        }
        // applied reports an installation command, not an affected-row count: pg-boss leaves
        // a concurrently created queue untouched (ON CONFLICT DO NOTHING).
        return { schema, queue: { ...queue, applied }, ...(version ? { version } : {}) };
    } finally {
        try {
            if (readOnly) await client!.query("ROLLBACK");
        } finally {
            client?.release();
            await database.close();
        }
    }
}

/** Shared strict parser; unsupported, repeated and incomplete flags never reach a connection. */
export function parseGenerationSchemaArguments(args: string[]): ProductionGenerationTarget & { apply: boolean } {
    const values = new Map<string, string | true>();
    const pairs = ["--target", "--expected-origin", "--expected-database-target"];
    const flags = ["--apply", "--dry-run", "--authorize-production-read-only", "--authorize-production-schema-install"];
    for (let index = 0; index < args.length; index++) {
        const name = args[index]!;
        if ((!pairs.includes(name) && !flags.includes(name)) || values.has(name)) throw new Error("参数未知或重复");
        if (pairs.includes(name)) {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error("参数缺少值");
            values.set(name, value);
        } else values.set(name, true);
    }
    if (values.has("--apply") && values.has("--dry-run")) throw new Error("apply 与 dry-run 互斥");
    const target = values.get("--target");
    if (target !== undefined && target !== "staging" && target !== "production") throw new Error("target 必须为 staging 或 production");
    return {
        target: target as "staging" | "production" | undefined, apply: values.has("--apply"),
        expectedOrigin: values.get("--expected-origin") as string | undefined,
        expectedDatabaseTarget: values.get("--expected-database-target") as string | undefined,
        authorizeProductionReadOnly: values.has("--authorize-production-read-only"),
        authorizeProductionSchemaInstall: values.has("--authorize-production-schema-install"),
    };
}

if (import.meta.main) {
    let options: ReturnType<typeof parseGenerationSchemaArguments> | undefined;
    try {
        options = parseGenerationSchemaArguments(process.argv.slice(2));
    } catch {
        console.error("invalid generation worker schema arguments");
        process.exitCode = 2;
    }
    if (options) {
        try {
            const operation = await runGenerationWorkerSchemaOperation(options);
            console.log(JSON.stringify({ component: "generation-worker-schema", target: options.target ?? "staging", operation: options.apply ? "apply" : "check", ...operation }));
            if (operation.schema.state !== "ready" || operation.queue.state !== "ready") process.exitCode = 1;
        } catch {
            // Even a failed apply may have committed: inspect the actual state before any retry.
            console.error("generation worker schema operation refused or failed; no automatic retry; inspect actual state before retrying apply");
            process.exitCode = 1;
        }
    }
}
