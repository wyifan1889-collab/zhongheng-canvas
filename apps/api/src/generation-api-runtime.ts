import { createJobQueue, GENERATION_QUEUE_NAME, isGenerationQueueReady } from "@infinite-canvas/jobs";
import type { readAccountConfig } from "./config";
import { canonicalPostgresTarget } from "./generation-worker-config";
import { readVideoRuntimePolicy, type VideoRuntimePolicy } from "./generation-video-config";

type AccountConfig = Pick<NonNullable<ReturnType<typeof readAccountConfig>>, "SAAS_DATABASE_URL" | "cloudMedia" | "storage"> | null;
type ProducerQueue = {
    start(): Promise<unknown>;
    stop(): Promise<void>;
    isInstalled(): Promise<boolean>;
    getQueue(name: string): Promise<unknown>;
    send: ReturnType<typeof createJobQueue>["send"];
};
export type GenerationApiConfig = { queueConnectionString: string; imageEnabled: boolean; textEnabled: boolean; audioEnabled: boolean; videoEnabled?: true; videoPolicy?: VideoRuntimePolicy };
export type GenerationApiRuntime = {
    enabled: true;
    imageEnabled: boolean;
    textEnabled: boolean;
    audioEnabled: boolean;
    videoEnabled?: boolean;
    videoPolicy?: VideoRuntimePolicy;
    queue: ProducerQueue;
    checkReady(): Promise<boolean>;
    stop(): Promise<void>;
};

/** An explicit API opt-in never enables or starts the separate worker process. */
export function readGenerationApiConfig(
    env: Record<string, string | undefined>, account: AccountConfig,
): GenerationApiConfig | null {
    const enabled = (name: string) => {
        const flag = env[name];
        if (flag === undefined || flag === "false") return false;
        if (flag !== "true") throw new Error(`${name} 只能是 true 或 false`);
        return true;
    };
    const imageEnabled = enabled("SAAS_GENERATION_IMAGE_ENABLED");
    const textEnabled = enabled("SAAS_GENERATION_TEXT_ENABLED");
    const audioEnabled = enabled("SAAS_GENERATION_AUDIO_ENABLED");
    const videoEnabled = enabled("SAAS_GENERATION_VIDEO_ENABLED");
    const videoPolicy = videoEnabled ? readVideoRuntimePolicy({ ...env, GENERATION_WORKER_VIDEO_ENABLED: "false" }) : null;
    if (!imageEnabled && !textEnabled && !audioEnabled && !videoEnabled) return null;
    if (imageEnabled && (!account?.cloudMedia || !account.storage)) throw new Error("图片生成 API 需要先开启账户、云媒体和私有存储");
    if (audioEnabled && (!account?.cloudMedia || !account.storage)) throw new Error("音频生成 API 需要先开启账户、云媒体和私有存储");
    if (videoEnabled && (!account?.cloudMedia || !account.storage || !videoPolicy)) throw new Error("视频生成API需要完整资源政策和私有存储");
    if (!account) throw new Error("文本生成 API 需要先开启账户数据库");
    const queueConnectionString = env.GENERATION_WORKER_QUEUE_URL;
    if (!queueConnectionString) throw new Error("生成 API 需要 GENERATION_WORKER_QUEUE_URL");
    if (canonicalPostgresTarget(queueConnectionString, "GENERATION_WORKER_QUEUE_URL") !==
        canonicalPostgresTarget(account.SAAS_DATABASE_URL, "SAAS_DATABASE_URL")) {
        throw new Error("生成队列必须与 SAAS_DATABASE_URL 使用同一数据库，以保证任务与冻结积分原子提交");
    }
    return { queueConnectionString, imageEnabled, textEnabled, audioEnabled, ...(videoEnabled && videoPolicy ? { videoEnabled: true as const, videoPolicy } : {}) };
}

/** Producer only: the schema and generation queue must already exist. */
export async function startGenerationApiRuntime(
    config: GenerationApiConfig | null,
    options: {
        queueFactory?: (connectionString: string, onError: (error: Error) => void) => ProducerQueue;
        checkDatabaseReady?: () => Promise<boolean>;
        checkVideoReady?: () => Promise<boolean>;
        onError?: (error: Error) => void;
    } = {},
): Promise<GenerationApiRuntime | null> {
    if (!config) return null;
    const queue = (options.queueFactory ?? createJobQueue)(config.queueConnectionString,
        options.onError ?? (() => console.error(JSON.stringify({ component: "generation-api", code: "queue_error" }))));
    let stopped = false;
    let stopping: Promise<void> | undefined;
    const stop = () => {
        stopped = true;
        return stopping ??= queue.stop();
    };
    const checkReady = async () => {
        if (stopped) return false;
        try { return (!options.checkDatabaseReady || await options.checkDatabaseReady()) &&
            (!config.videoEnabled || !!options.checkVideoReady && await options.checkVideoReady()) &&
            await queue.isInstalled() && isGenerationQueueReady(await queue.getQueue(GENERATION_QUEUE_NAME)); }
        catch { return false; }
    };
    try {
        if (options.checkDatabaseReady && !await options.checkDatabaseReady()) throw new Error("生成任务数据库尚未就绪；请先应用 0025 文本缓存计价迁移");
        await queue.start();
        if (!await checkReady()) throw new Error("生成队列尚未就绪；须先独立安装 canvas_jobs，且 generation 队列为 standard 策略、retryLimit=0");
        return { enabled: true, imageEnabled: config.imageEnabled, textEnabled: config.textEnabled, audioEnabled: config.audioEnabled,
            ...(config.videoEnabled ? { videoEnabled: true, videoPolicy: config.videoPolicy } : {}), queue, checkReady, stop };
    } catch (error) {
        try { await stop(); } catch { /* Preserve the startup failure after attempting cleanup. */ }
        throw error;
    }
}
