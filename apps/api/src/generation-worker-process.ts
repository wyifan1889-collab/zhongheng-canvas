import { z } from "zod";
import { createDatabase } from "@infinite-canvas/database";
import type { GenerationWorkerDependencies } from "./generation-worker";
import { createGenerationProvider } from "./generation-provider";
import { createGenerationDelivery, createGenerationImageSpecMediaVerifier, createGenerationAudioMediaVerifier, createGeminiImageDeliveryVerifier } from "./generation-delivery";
import { createGenerationWalletSettlement } from "./generation-worker";
import { createStorageAdapter } from "@infinite-canvas/storage";
import { readMediaConfig, type MediaRuntimeConfig } from "./config";
import {
    createConfiguredGenerationWorkerRuntime,
    type GenerationWorkerEntryOptions,
} from "./generation-worker-entry";
import type { GenerationWorkerLifecycle } from "./generation-worker-runtime";
import { canonicalPostgresTarget, readGenerationWorkerConfig, type GenerationWorkerConfig } from "./generation-worker-config";
import { checkGenerationDatabaseReadiness } from "./readiness";
import { readVideoRuntimePolicy, type VideoRuntimePolicy } from "./generation-video-config";
import { readVideoToolchainIdentity, type VideoToolchainIdentity } from "./generation-video-probe";
import { createGenerationVideoExecution } from "./generation-video-runtime";
import { checkGenerationVideoDatabaseReadiness } from "./generation-video-readiness";
import { createJobQueue, GENERATION_QUEUE_NAME, isGenerationQueueReady } from "@infinite-canvas/jobs";

const processConfig = z.object({
    SAAS_DATABASE_URL: z.url().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
    SAAS_AUTH_SECRET: z.string().min(32),
    GENERATION_WORKER_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(30_000),
    GENERATION_WORKER_IMAGE_ENABLED: z.enum(["true", "false"]).default("false"),
    GENERATION_WORKER_AUDIO_ENABLED: z.enum(["true", "false"]).default("false"),
    GENERATION_WORKER_VIDEO_ENABLED: z.enum(["true", "false"]).default("false"),
});

export type GenerationWorkerProcessConfig = {
    worker: GenerationWorkerConfig;
    databaseUrl: string;
    authSecret: string;
    providerTimeoutMs: number;
    imageEnabled: boolean;
    audioEnabled: boolean;
    media: MediaRuntimeConfig | null;
    videoPolicy?: VideoRuntimePolicy;
    videoToolchainIdentity?: VideoToolchainIdentity;
};

/** Parse the worker-only credentials without requiring SMTP, captcha or API settings. */
export function readGenerationWorkerProcessConfig(
    env: Record<string, string | undefined>,
): GenerationWorkerProcessConfig | null {
    const worker = readGenerationWorkerConfig(env);
    if (!worker) return null;
    const parsed = processConfig.safeParse(env);
    if (!parsed.success) {
        throw new Error(`生成 worker 进程配置无效：${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join("、")}`);
    }
    if (canonicalPostgresTarget(worker.queueConnectionString, "GENERATION_WORKER_QUEUE_URL") !==
        canonicalPostgresTarget(parsed.data.SAAS_DATABASE_URL, "SAAS_DATABASE_URL")) {
        throw new Error("生成队列必须与 SAAS_DATABASE_URL 使用同一数据库，以保证任务与冻结积分原子提交");
    }
    const imageEnabled = parsed.data.GENERATION_WORKER_IMAGE_ENABLED === "true";
    const audioEnabled = parsed.data.GENERATION_WORKER_AUDIO_ENABLED === "true";
    const videoEnabled = parsed.data.GENERATION_WORKER_VIDEO_ENABLED === "true";
    const videoPolicy = videoEnabled ? readVideoRuntimePolicy({ ...env, SAAS_GENERATION_VIDEO_ENABLED: "false" }) : null;
    const videoToolchainIdentity = videoEnabled ? readVideoToolchainIdentity(env) : null;
    if (videoEnabled && (!videoPolicy || !videoToolchainIdentity)) throw new Error("视频worker需要完整资源政策和固定工具身份");
    const media = imageEnabled || audioEnabled || videoEnabled ? readMediaConfig(env) : null;
    if (imageEnabled && !media) throw new Error("图片生成 worker 需要先配置 STORAGE_PROVIDER 和私有媒体存储");
    if (audioEnabled && !media) throw new Error("音频生成 worker 需要先配置 STORAGE_PROVIDER 和私有媒体存储");
    if (videoEnabled && !media) throw new Error("视频生成 worker 需要配置私有媒体存储");
    return {
        worker,
        databaseUrl: parsed.data.SAAS_DATABASE_URL,
        authSecret: parsed.data.SAAS_AUTH_SECRET,
        providerTimeoutMs: parsed.data.GENERATION_WORKER_PROVIDER_TIMEOUT_MS,
        imageEnabled, audioEnabled,
        media,
        ...(videoPolicy && videoToolchainIdentity ? { videoPolicy, videoToolchainIdentity } : {}),
    };
}

export type GenerationWorkerProcessHandle = {
    config: GenerationWorkerProcessConfig;
    runtime: GenerationWorkerLifecycle;
    stop(): Promise<void>;
};

export type GenerationWorkerProcessOptions = {
    env?: Record<string, string | undefined>;
    databaseFactory?: typeof createDatabase;
    runtimeFactory?: (options: GenerationWorkerEntryOptions) => GenerationWorkerLifecycle | null;
    providerFactory?: (input: { database: ReturnType<typeof createDatabase>["db"]; authSecret: string; requestTimeoutMs: number; imageMaxBytes?: number; audioMaxBytes?: number }) => GenerationWorkerDependencies["provider"];
    storageFactory?: typeof createStorageAdapter;
    settlementFactory?: typeof createGenerationWalletSettlement;
    onError?: (error: Error) => void;
};

/**
 * Start the independent worker only after an explicit env opt-in. This does
 * not create an API server, run migrations or infer a queue policy. The
 * default profile is text-only. Images require a separate explicit opt-in
 * and the existing private media configuration. Wallet settlement continues
 * to use the immutable task quote and confirmed delivery.
 */
export async function startGenerationWorkerProcess(
    options: GenerationWorkerProcessOptions = {},
): Promise<GenerationWorkerProcessHandle | null> {
    const env = options.env ?? process.env;
    const config = readGenerationWorkerProcessConfig(env);
    if (!config) return null;
    const databaseFactory = options.databaseFactory ?? createDatabase;
    const database = databaseFactory(config.databaseUrl);
    let runtime: GenerationWorkerLifecycle | null = null;
    let videoQueue: ReturnType<typeof createJobQueue> | undefined;
    let videoTimer: ReturnType<typeof setInterval> | undefined;
    let recovery: Promise<void> | undefined;
    try {
        if (!await checkGenerationDatabaseReadiness(database.pool, config.audioEnabled)) throw new Error(config.audioEnabled
            ? "生成任务数据库尚未就绪；请先应用 0027 音频价目迁移" : "生成任务数据库尚未就绪；请先应用 0026 图片规格任务迁移");
        const mediaConfig = config.media;
        if (config.videoPolicy && !await checkGenerationVideoDatabaseReadiness(database.pool)) throw new Error("视频阶段、价目来源和不可变绑定SQL尚未就绪");
        const storage = mediaConfig ? (options.storageFactory ?? createStorageAdapter)(mediaConfig.provider === "aliyun-oss" ? {
            provider: "aliyun-oss", region: mediaConfig.region!, accessKeyId: mediaConfig.accessKeyId!,
            accessKeySecret: mediaConfig.accessKeySecret!, bucket: mediaConfig.bucket!, endpoint: mediaConfig.endpoint,
        } : { provider: "server-disk", rootDirectory: mediaConfig.rootDirectory! }) : null;
        const provider = (options.providerFactory ?? ((input) => createGenerationProvider(input)))({
            database: database.db,
            authSecret: config.authSecret,
            requestTimeoutMs: config.providerTimeoutMs,
            ...(mediaConfig && config.imageEnabled ? { imageMaxBytes: mediaConfig.maxBytes.image } : {}),
            ...(mediaConfig && config.audioEnabled ? { audioMaxBytes: mediaConfig.maxBytes.audio } : {}),
        });
        if (config.videoPolicy) {
            videoQueue = createJobQueue(config.worker.queueConnectionString, options.onError ?? (() => console.error(JSON.stringify({ component: "generation-video", code: "queue_error" }))));
            await videoQueue.start();
            if (!await videoQueue.isInstalled() || !isGenerationQueueReady(await videoQueue.getQueue(GENERATION_QUEUE_NAME))) throw new Error("视频续调度队列尚未就绪");
        }
        const video = config.videoPolicy && config.videoToolchainIdentity && storage && mediaConfig && videoQueue ? await createGenerationVideoExecution({
            database: database.db, queue: videoQueue, storage, policy: config.videoPolicy, toolchainIdentity: config.videoToolchainIdentity,
            authSecret: config.authSecret, quotaBytes: mediaConfig.quotaBytes, maxBytes: mediaConfig.maxBytes,
        }) : null;
        const settleBilling = (options.settlementFactory ?? createGenerationWalletSettlement)(database.db, storage && mediaConfig ? {
            verifyImageSpecDelivery: createGenerationImageSpecMediaVerifier({ storage, maxBytes: mediaConfig.maxBytes }),
            verifyGeminiImageDelivery: createGeminiImageDeliveryVerifier({ storage, maxBytes: mediaConfig.maxBytes }),
            verifyAudioDelivery: createGenerationAudioMediaVerifier({ database: database.db, storage, maxBytes: mediaConfig.maxBytes }),
            ...(video ? { verifyVideoDelivery: video.verifyVideoDelivery } : {}),
        } : {});
        const runtimeFactory = options.runtimeFactory ?? createConfiguredGenerationWorkerRuntime;
        runtime = runtimeFactory({
            env,
            expectedEnvironment: config.worker.environment,
            database: database.db,
            dependencies: {
                provider,
                ...(video ? { processVideo: video.driver.process } : {}),
                deliver: createGenerationDelivery(storage && mediaConfig ? {
                    database: database.db, storage, quotaBytes: mediaConfig.quotaBytes, maxBytes: mediaConfig.maxBytes,
                } : undefined),
                settleBilling,
            },
            onError: options.onError ?? (() => console.error(JSON.stringify({ component: "generation-worker", code: "queue_error" }))),
        });
        if (!runtime) throw new Error("生成 worker 配置启用后未创建运行时");
        await runtime.start();
        if (video && config.videoPolicy) {
            await video.driver.recover();
            videoTimer = setInterval(() => {
                if (recovery) return;
                recovery = video.driver.recover().catch(() => console.error(JSON.stringify({ component: "generation-video", code: "recovery_unavailable" }))).finally(() => { recovery = undefined; });
            }, config.videoPolicy.recoveryScanIntervalMs);
        }
        const startedRuntime = runtime;
        return {
            config,
            runtime,
            async stop() {
                if (videoTimer) clearInterval(videoTimer);
                try { await recovery; await startedRuntime.stop(); }
                finally { try { await videoQueue?.stop(); } finally { await database.close(); } }
            },
        };
    } catch (error) {
        if (videoTimer) clearInterval(videoTimer);
        try { await runtime?.stop(); } catch { /* Preserve the startup failure after attempting cleanup. */ }
        try { await videoQueue?.stop(); } catch { /* Preserve startup failure. */ }
        await database.close();
        throw error;
    }
}

/** Minimal executable entrypoint. It remains inert unless explicitly enabled. */
if (import.meta.main) {
    try {
        const handle = await startGenerationWorkerProcess();
        if (!handle) {
            console.log("generation worker disabled; no queue was opened");
        } else {
            const shutdown = async () => {
                await handle.stop();
                process.exit(0);
            };
            process.once("SIGINT", shutdown);
            process.once("SIGTERM", shutdown);
            console.log(`Generation worker started (${handle.config.worker.environment})`);
            await new Promise<void>(() => undefined);
        }
    } catch (error) {
        console.error("generation worker failed to start; check configuration, migrations and queue readiness");
        process.exitCode = 1;
    }
}
