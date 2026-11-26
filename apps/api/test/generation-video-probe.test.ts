import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeGenerationVideo, runBoundedVideoProcess, inspectGenerationVideoReference, readVideoToolchainIdentity, checkVideoToolchainReadiness, inspectVideoToolchainReadOnly, linuxVideoResourceArguments, type VideoToolchainIdentity } from "../src/generation-video-probe";
import type { VideoRuntimePolicy } from "../src/generation-video-config";

const root = process.env.VIDEO_TEST_TOOL_ROOT;
const real = root && process.platform === "win32" ? test : test.skip;
const cleanup: string[] = [];
afterAll(async () => { for (const path of cleanup) await rm(path, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const limits = { timeoutMs: 30000, stdoutMaxBytes: 65536, stderrMaxBytes: 65536, memoryMaxBytes: 268435456, cpuTimeMs: 5000 };
test("pinned tool identity never coerces JSON arrays into hash strings", () => {
    const identity = { ffprobeSha256: "a".repeat(64), ffmpegSha256: "b".repeat(64), version: "fixed-version", license: "GPL-3.0", sourceUrl: "https://tools.example.test/fixed.zip" };
    expect(readVideoToolchainIdentity({ GENERATION_VIDEO_TOOLCHAIN_IDENTITY: JSON.stringify(identity) })).toEqual(identity);
    for (const field of ["ffprobeSha256", "ffmpegSha256"] as const) {
        expect(readVideoToolchainIdentity({ GENERATION_VIDEO_TOOLCHAIN_IDENTITY: JSON.stringify({ ...identity, [field]: [identity[field]] }) })).toBeNull();
    }
});
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "video-probe-test-")); cleanup.push(directory);
    const ffmpegPath = join(root!, "ffmpeg.exe"), ffprobePath = join(root!, "ffprobe.exe");
    const identity: VideoToolchainIdentity = { ffprobeSha256: sha(await readFile(ffprobePath)), ffmpegSha256: sha(await readFile(ffmpegPath)),
        version: "9.0.2-essentials_build-www.gyan.dev", license: "GPL-3.0", sourceUrl: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip" };
    // Synthetic test resource values only; these never become production defaults.
    const policy = { maxVideoBytes: 2097152, maxPixels: 4096, maxMediaDurationMs: 1000, ffmpegPath, ffprobePath, probeTempRoot: directory,
        probeTimeoutMs: limits.timeoutMs, probeStdoutMaxBytes: limits.stdoutMaxBytes, probeStderrMaxBytes: limits.stderrMaxBytes,
        probeMemoryMaxBytes: limits.memoryMaxBytes, probeCpuLimit: limits.cpuTimeMs } as VideoRuntimePolicy;
    const path = join(directory, "synthetic.mp4");
    const result = await runBoundedVideoProcess(ffmpegPath, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10", "-t", "0.4", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], directory, limits);
    expect(result.reason).toBe("exited"); expect(result.exitCode).toBe(0);
    return { directory, identity, policy, body: new Uint8Array(await readFile(path)) };
}
real("pinned real FFmpeg under Job Object fully decodes a synthetic MP4 and rejects truncation, hashes and resource excess", async () => {
    const { directory, policy, identity, body } = await fixture();
    const before = await readdir(directory);
    expect(await inspectVideoToolchainReadOnly(policy, identity)).toEqual({ ready: true, platform: "win32", reasons: [] });
    expect(await readdir(directory)).toEqual(before);
    expect(await checkVideoToolchainReadiness(policy, identity)).toBe(true);
    const verified = await probeGenerationVideo(body, policy, identity);
    expect(verified.status).toBe("verified");
    if (verified.status === "verified") {
        expect(verified.probe).toMatchObject({ source: "ffmpeg_full_decode", width: 64, height: 64, frames: 4, contentSha256: sha(body) });
        expect(verified.probe.durationSeconds).toBe(0.4);
    }
    expect((await probeGenerationVideo(body.subarray(0, body.byteLength - 200), policy, identity)).status).toBe("unknown");
    expect((await probeGenerationVideo(body, { ...policy, maxPixels: 1 }, identity)).status).toBe("unknown");
    expect((await probeGenerationVideo(body, policy, { ...identity, ffprobeSha256: "0".repeat(64) })).status).toBe("unknown");
}, 180000);
real("actual process is killed on CPU user-time, memory, wall clock and stdout bounds", async () => {
    const { directory, policy } = await fixture();
    const version = await runBoundedVideoProcess(policy.ffprobePath, ["-version"], directory, { ...limits, stdoutMaxBytes: 8 });
    expect(version.reason).toBe("output_limit");
    const memory = await runBoundedVideoProcess(policy.ffprobePath, ["-version"], directory, { ...limits, memoryMaxBytes: 1048576 });
    expect(memory.reason).toBe("exited"); expect(memory.exitCode).not.toBe(0);
    const cpu = await runBoundedVideoProcess(policy.ffmpegPath, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x64:r=30", "-f", "null", "-"], directory, { ...limits, cpuTimeMs: 1 });
    expect(cpu.reason).toBe("exited"); expect(cpu.exitCode).not.toBe(0);
    const wall = await runBoundedVideoProcess(policy.ffmpegPath, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=s=64x64:r=30", "-f", "null", "-"], directory, { ...limits, timeoutMs: 5000, cpuTimeMs: 30000 });
    expect(wall.reason).toBe("timeout");
}, 120000);
real("the complete real probe shares one deadline across version checks, metadata and full decode", async () => {
    const { directory, policy, identity, body } = await fixture();
    const started = performance.now();
    expect((await runBoundedVideoProcess(policy.ffprobePath, ["-version"], directory, limits)).exitCode).toBe(0);
    const oneVersionMs = Math.ceil(performance.now() - started);
    // Each real process is faster than this allowance. The old per-process reset
    // could therefore execute all four and report success beyond the total budget.
    const budget = oneVersionMs * 2;
    const probeStarted = performance.now();
    const checked = await probeGenerationVideo(body, { ...policy, probeTimeoutMs: budget }, identity);
    const elapsed = performance.now() - probeStarted;
    expect(checked.status).toBe("unknown");
    expect(elapsed).toBeLessThan(budget + oneVersionMs);
}, 120000);
test("missing tools or policy never return a successful probe", async () => {
    expect((await probeGenerationVideo(new Uint8Array([1]), {} as VideoRuntimePolicy, {} as VideoToolchainIdentity)).status).toBe("unknown");
});
test("toolchain identity requires an exact, explicit, nonsecret pinned record", () => {
    const identity = { ffprobeSha256: "a".repeat(64), ffmpegSha256: "b".repeat(64), version: "fixed-version", license: "GPL-3.0", sourceUrl: "https://example.test/fixed.zip" };
    expect(readVideoToolchainIdentity({})).toBeNull();
    expect(readVideoToolchainIdentity({ GENERATION_VIDEO_TOOLCHAIN_IDENTITY: JSON.stringify(identity) })).toEqual(identity);
    for (const value of [{ ...identity, extra: true }, { ...identity, ffmpegSha256: "not-pinned" }, { ...identity, sourceUrl: "https://key:secret@example.test/file" }]) {
        expect(readVideoToolchainIdentity({ GENERATION_VIDEO_TOOLCHAIN_IDENTITY: JSON.stringify(value) })).toBeNull();
    }
});
test("Linux resource admission requires a pinned limiter and exact whole CPU seconds", () => {
    const configured = { memoryMaxBytes: 268435456, cpuTimeMs: 5000, resourceLimiterPath: "/usr/bin/prlimit", resourceLimiterSha256: "a".repeat(64) };
    expect(linuxVideoResourceArguments(configured)).toEqual(["--as=268435456:268435456", "--cpu=5:5", "--"]);
    for (const patch of [{ cpuTimeMs: 1 }, { cpuTimeMs: 1500 }, { resourceLimiterPath: undefined }, { resourceLimiterPath: "prlimit" },
        { resourceLimiterSha256: undefined }, { resourceLimiterSha256: "not-pinned" }, { memoryMaxBytes: 0 }]) expect(linuxVideoResourceArguments({ ...configured, ...patch })).toBeNull();
});
test("first-frame mature decoder checks MIME, actual pixels, full bytes and animation", async () => {
    const sharp = (await import("sharp")).default;
    const body = await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } }).png().toBuffer();
    const policy = { referenceMaxBytes: body.byteLength, referenceMaxPixels: 4, referenceContentTypes: ["image/png"] } as VideoRuntimePolicy;
    expect(await inspectGenerationVideoReference(body, "image/png", policy)).toEqual({ width: 2, height: 2, contentSha256: sha(body) });
    expect(await inspectGenerationVideoReference(body, "image/jpeg", policy)).toBeNull();
    expect(await inspectGenerationVideoReference(body, "image/png", { ...policy, referenceMaxPixels: 1 })).toBeNull();
    expect(await inspectGenerationVideoReference(body.subarray(0, 30), "image/png", policy)).toBeNull();
});
