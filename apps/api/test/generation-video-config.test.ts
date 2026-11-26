import { expect, test } from "bun:test";
import { readVideoRuntimePolicy } from "../src/generation-video-config";
test("video is inert without explicit opt-in and has no invented resource defaults", () => {
    expect(readVideoRuntimePolicy({})).toBeNull();
    expect(readVideoRuntimePolicy({ SAAS_GENERATION_VIDEO_ENABLED: "false" })).toBeNull();
    expect(() => readVideoRuntimePolicy({ SAAS_GENERATION_VIDEO_ENABLED: "yes" })).toThrow();
    expect(() => readVideoRuntimePolicy({ GENERATION_WORKER_VIDEO_ENABLED: "true" })).toThrow("GENERATION_VIDEO_CREATE_TIMEOUT_MS");
});
test("complete policy is copied and relational bounds are enforced", () => {
    // Synthetic limits only: this fixture authorizes no deployed channel or operational policy.
    const env: Record<string, string> = { SAAS_GENERATION_VIDEO_ENABLED: "true", STORAGE_VIDEO_MAX_BYTES: "1000000",
        GENERATION_VIDEO_REFERENCE_CONTENT_TYPES: '["image/png"]', GENERATION_VIDEO_FFPROBE_PATH: "C:\\fixture\\ffprobe.exe",
        GENERATION_VIDEO_FFMPEG_PATH: "C:\\fixture\\ffmpeg.exe", GENERATION_VIDEO_PROBE_TEMP_ROOT: "C:\\fixture\\temp" };
    for (const suffix of ["CREATE_TIMEOUT_MS", "INSPECT_TIMEOUT_MS", "DOWNLOAD_TIMEOUT_MS", "JSON_MAX_BYTES", "POLL_INTERVAL_MS",
        "RECOVERY_SCAN_INTERVAL_MS", "RECOVERY_SCAN_BATCH_SIZE", "OBSERVATION_WINDOW_MS", "MAX_INSPECT_ATTEMPTS", "MAX_DOWNLOAD_ATTEMPTS",
        "MAX_PIXELS", "MAX_MEDIA_DURATION_MS", "REFERENCE_MAX_BYTES", "REFERENCE_MAX_PIXELS", "PROBE_TIMEOUT_MS", "PROBE_STDOUT_MAX_BYTES",
        "PROBE_STDERR_MAX_BYTES", "PROBE_MEMORY_MAX_BYTES", "PROBE_CPU_LIMIT"]) env[`GENERATION_VIDEO_${suffix}`] = "100";
    env.GENERATION_VIDEO_CLAIM_LEASE_MS = "1000";
    expect(readVideoRuntimePolicy(env)?.claimLeaseMs).toBe(1000);
    expect(() => readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_CLAIM_LEASE_MS: "200" })).toThrow("租约");
    expect(() => readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_CLAIM_LEASE_MS: "250" })).toThrow("租约");
    expect(() => readVideoRuntimePolicy({ ...env, STORAGE_VIDEO_MAX_BYTES: "0" })).toThrow("STORAGE_VIDEO_MAX_BYTES");
    expect(() => readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_REFERENCE_CONTENT_TYPES: '["image/png","image/png"]' })).toThrow("MIME");
    expect(() => readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_FFMPEG_PATH: "ffmpeg" })).toThrow("绝对路径");
    expect(() => readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_CREATE_TIMEOUT_MS: "2147483648" })).toThrow("运行时可表示范围");
    expect(() => readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_CLAIM_LEASE_MS: "2147483648" })).toThrow("运行时可表示范围");
    expect(() => readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_RESOURCE_LIMITER_PATH: "/usr/bin/prlimit" })).toThrow("SHA-256");
    expect(readVideoRuntimePolicy({ ...env, GENERATION_VIDEO_RESOURCE_LIMITER_PATH: "/usr/bin/prlimit", GENERATION_VIDEO_RESOURCE_LIMITER_SHA256: "a".repeat(64) }))
        .toMatchObject({ resourceLimiterPath: "/usr/bin/prlimit", resourceLimiterSha256: "a".repeat(64) });
});
