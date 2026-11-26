/** Pure configuration only. Construction grants neither network access nor tool readiness. */
export type VideoRuntimePolicy = {
    createTimeoutMs: number; inspectTimeoutMs: number; downloadTimeoutMs: number; jsonMaxBytes: number;
    pollIntervalMs: number; claimLeaseMs: number; recoveryScanIntervalMs: number; recoveryScanBatchSize: number;
    observationWindowMs: number; maxInspectAttempts: number; maxDownloadAttempts: number;
    maxVideoBytes: number; maxPixels: number; maxMediaDurationMs: number;
    referenceMaxBytes: number; referenceMaxPixels: number; referenceContentTypes: string[];
    ffprobePath: string; ffmpegPath: string; probeTimeoutMs: number; probeStdoutMaxBytes: number; probeStderrMaxBytes: number;
    probeMemoryMaxBytes: number;
    /** Hard process CPU time in milliseconds, not a percentage or thread count. */
    probeCpuLimit: number; probeTempRoot: string;
    /** Linux requires an explicitly pinned util-linux prlimit resource launcher. */
    resourceLimiterPath?: string; resourceLimiterSha256?: string;
};
const numbers = {
    createTimeoutMs: "GENERATION_VIDEO_CREATE_TIMEOUT_MS", inspectTimeoutMs: "GENERATION_VIDEO_INSPECT_TIMEOUT_MS",
    downloadTimeoutMs: "GENERATION_VIDEO_DOWNLOAD_TIMEOUT_MS", jsonMaxBytes: "GENERATION_VIDEO_JSON_MAX_BYTES",
    pollIntervalMs: "GENERATION_VIDEO_POLL_INTERVAL_MS", claimLeaseMs: "GENERATION_VIDEO_CLAIM_LEASE_MS",
    recoveryScanIntervalMs: "GENERATION_VIDEO_RECOVERY_SCAN_INTERVAL_MS", recoveryScanBatchSize: "GENERATION_VIDEO_RECOVERY_SCAN_BATCH_SIZE",
    observationWindowMs: "GENERATION_VIDEO_OBSERVATION_WINDOW_MS", maxInspectAttempts: "GENERATION_VIDEO_MAX_INSPECT_ATTEMPTS",
    maxDownloadAttempts: "GENERATION_VIDEO_MAX_DOWNLOAD_ATTEMPTS", maxVideoBytes: "STORAGE_VIDEO_MAX_BYTES",
    maxPixels: "GENERATION_VIDEO_MAX_PIXELS", maxMediaDurationMs: "GENERATION_VIDEO_MAX_MEDIA_DURATION_MS",
    referenceMaxBytes: "GENERATION_VIDEO_REFERENCE_MAX_BYTES", referenceMaxPixels: "GENERATION_VIDEO_REFERENCE_MAX_PIXELS",
    probeTimeoutMs: "GENERATION_VIDEO_PROBE_TIMEOUT_MS", probeStdoutMaxBytes: "GENERATION_VIDEO_PROBE_STDOUT_MAX_BYTES",
    probeStderrMaxBytes: "GENERATION_VIDEO_PROBE_STDERR_MAX_BYTES", probeMemoryMaxBytes: "GENERATION_VIDEO_PROBE_MEMORY_MAX_BYTES",
    probeCpuLimit: "GENERATION_VIDEO_PROBE_CPU_LIMIT",
} as const;
const paths = { ffprobePath: "GENERATION_VIDEO_FFPROBE_PATH", ffmpegPath: "GENERATION_VIDEO_FFMPEG_PATH", probeTempRoot: "GENERATION_VIDEO_PROBE_TEMP_ROOT" } as const;

export function readVideoRuntimePolicy(env: Record<string, string | undefined>): VideoRuntimePolicy | null {
    const flag = (name: string) => {
        if (env[name] === undefined || env[name] === "false") return false;
        if (env[name] !== "true") throw new Error(`${name}只能是true或false`);
        return true;
    };
    const api = flag("SAAS_GENERATION_VIDEO_ENABLED"), worker = flag("GENERATION_WORKER_VIDEO_ENABLED");
    if (!api && !worker) return null;
    const result: Record<string, unknown> = {};
    for (const [key, name] of Object.entries(numbers)) {
        const raw = env[name];
        if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`视频配置缺少有效正整数：${name}`);
        result[key] = Number(raw);
    }
    for (const [key, name] of Object.entries(paths)) {
        const path = env[name];
        if (!path || path.trim() !== path || /[\u0000-\u001f\u007f]/.test(path) || !(/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/"))) {
            throw new Error(`视频配置需要明确绝对路径：${name}`);
        }
        result[key] = path;
    }
    let types: unknown;
    try { types = JSON.parse(env.GENERATION_VIDEO_REFERENCE_CONTENT_TYPES ?? ""); } catch { throw new Error("视频配置需要明确参考图片MIME数组"); }
    if (!Array.isArray(types) || types.length === 0 || types.some(value => typeof value !== "string" || !/^image\/[a-z0-9.+-]+$/.test(value)) ||
        new Set(types).size !== types.length) throw new Error("视频配置参考图片MIME数组无效");
    result.referenceContentTypes = [...types];
    const limiterPath = env.GENERATION_VIDEO_RESOURCE_LIMITER_PATH, limiterSha = env.GENERATION_VIDEO_RESOURCE_LIMITER_SHA256;
    if (limiterPath !== undefined || limiterSha !== undefined) {
        if (!limiterPath || !limiterPath.startsWith("/") || limiterPath.trim() !== limiterPath || /[\u0000-\u001f\u007f]/.test(limiterPath) ||
            !limiterSha || !/^[0-9a-f]{64}$/.test(limiterSha)) throw new Error("Linux视频资源启动器必须有明确绝对路径和SHA-256");
        result.resourceLimiterPath = limiterPath; result.resourceLimiterSha256 = limiterSha;
    }
    const policy = result as VideoRuntimePolicy;
    for (const key of ["createTimeoutMs", "inspectTimeoutMs", "downloadTimeoutMs", "probeTimeoutMs", "recoveryScanIntervalMs", "claimLeaseMs"] as const) {
        if (policy[key] > 0x7fffffff) throw new Error(`视频定时器超出运行时可表示范围：${numbers[key]}`);
    }
    // A lease cannot authorize overlapping external work. These are relational checks, not invented defaults.
    // Delivery verifies the downloaded media and settlement independently rechecks
    // the saved object; both complete probes consume this same claim's budget.
    const longestOperation = Math.max(policy.createTimeoutMs, policy.inspectTimeoutMs, policy.downloadTimeoutMs + 2 * policy.probeTimeoutMs);
    if (!Number.isSafeInteger(longestOperation) || policy.claimLeaseMs <= longestOperation) throw new Error("视频claim租约必须覆盖单次网络/探测截止并留有提交窗口");
    if (policy.observationWindowMs < policy.pollIntervalMs) throw new Error("视频观察窗口不能短于查询间隔");
    return policy;
}
