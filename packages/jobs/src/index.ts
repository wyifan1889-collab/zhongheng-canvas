import { PgBoss, getConstructionPlans } from "pg-boss";
import type { Job } from "pg-boss";

export { fromDrizzle } from "pg-boss";
export const JOB_SCHEMA = "canvas_jobs";
export const GENERATION_QUEUE_NAME = "generation";

/** Inspect only the effective queue policy; installation and changes remain explicit operations. */
export function isGenerationQueueReady(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const queue = value as Record<string, unknown>;
    return queue.name === GENERATION_QUEUE_NAME && queue.policy === "standard" && queue.retryLimit === 0;
}

export type GenerationJobPayload = {
    schemaVersion: 1;
    taskId: string;
    ownerId: string;
    requestId: string;
};

function assertJobIdentifier(value: string, label: string) {
    if (!value.trim() || value.length > 200) throw new Error(`${label}无效`);
}

function isJobIdentifier(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim()) && value.length <= 200;
}

/** Build the only payload a generation worker may receive from the API. */
export function createGenerationJobPayload(input: Omit<GenerationJobPayload, "schemaVersion">): GenerationJobPayload {
    assertJobIdentifier(input.taskId, "任务 ID");
    assertJobIdentifier(input.ownerId, "账号 ID");
    assertJobIdentifier(input.requestId, "请求 ID");
    return { schemaVersion: 1, taskId: input.taskId, ownerId: input.ownerId, requestId: input.requestId };
}

export function isGenerationJobPayload(value: unknown): value is GenerationJobPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<GenerationJobPayload>;
    if (Object.keys(candidate).some((key) => !["schemaVersion", "taskId", "ownerId", "requestId"].includes(key))) return false;
    return candidate.schemaVersion === 1 && isJobIdentifier(candidate.taskId) &&
        isJobIdentifier(candidate.ownerId) && isJobIdentifier(candidate.requestId);
}

/** Initial installation SQL only; run separately under a migration role, never on API startup. */
export const getJobSchemaSql = () => getConstructionPlans(JOB_SCHEMA);

/** Foundation client, not a generation worker. Lifecycle and error handling belong to the caller. */
export function createJobQueue(connectionString: string, onError: (error: Error) => void) {
    if (!["postgres:", "postgresql:"].includes(new URL(connectionString).protocol)) {
        throw new Error("任务队列必须使用独立画布 PostgreSQL 数据库");
    }
    const queue = new PgBoss({
        connectionString,
        schema: JOB_SCHEMA,
        migrate: false,
        createSchema: false,
        // No automatic expiry/recovery sweeps or scheduling until business policy is approved.
        supervise: false,
        schedule: false,
    });
    queue.on("error", onError);
    return queue;
}

export type JobBatchHandler<Payload> = (jobs: ReadonlyArray<Job<Payload>>) => Promise<void>;

/**
 * Explicit worker lifecycle for a named queue. This is only a runtime seam:
 * migrations, queue policy, provider calls and billing state transitions stay
 * with the caller and are never inferred here.
 */
export function createJobWorker<Payload>(
    connectionString: string,
    queueName: string,
    handler: JobBatchHandler<Payload>,
    onError: (error: Error) => void,
) {
    if (!queueName || queueName.length > 200 || /[\u0000-\u001f\u007f]/.test(queueName)) {
        throw new Error("任务队列名称无效");
    }
    const queue = createJobQueue(connectionString, onError);
    let started = false;
    return {
        queue,
        async start() {
            if (started) return;
            try {
                await queue.start();
                if (queueName === GENERATION_QUEUE_NAME && (!await queue.isInstalled() || !isGenerationQueueReady(await queue.getQueue(queueName)))) {
                    throw new Error("生成队列未就绪：须已安装，且为 standard 策略、retryLimit=0；运行时不会创建或改写队列");
                }
                await queue.work<Payload>(queueName, async (jobs) => {
                    await handler(jobs);
                });
                started = true;
            } catch (error) {
                try { await queue.stop(); } catch { /* Preserve startup failure after releasing queue resources. */ }
                throw error;
            }
        },
        async stop() {
            if (!started) {
                await queue.stop();
                return;
            }
            await queue.stop();
            started = false;
        },
        isStarted: () => started,
    };
}

/**
 * Named worker seam for the first generation vertical slice. It does not
 * contact a provider or choose retry/billing policy; the caller owns those
 * decisions inside the handler.
 */
export function createGenerationWorker(
    connectionString: string,
    handler: JobBatchHandler<GenerationJobPayload>,
    onError: (error: Error) => void,
) {
    return createJobWorker(connectionString, GENERATION_QUEUE_NAME, handler, onError);
}
