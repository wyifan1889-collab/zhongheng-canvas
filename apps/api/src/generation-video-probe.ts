import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import type { VideoRuntimePolicy } from "./generation-video-config";

export type VideoToolchainIdentity = { ffprobeSha256: string; ffmpegSha256: string; version: string; license: string; sourceUrl: string };
export type VideoProbeSnapshot = { source: "ffmpeg_full_decode"; toolVersion: string; ffprobeSha256: string; ffmpegSha256: string;
    contentSha256: string; format: "mp4"; width: number; height: number; durationSeconds: number; frames: number };
export type VideoProbeResult = { status: "verified"; probe: VideoProbeSnapshot }
    | { status: "unknown"; reason: "video_probe_unavailable" | "video_probe_invalid" | "video_probe_resource_limit" };
export type VideoProcessLimits = { timeoutMs: number; stdoutMaxBytes: number; stderrMaxBytes: number; memoryMaxBytes: number; cpuTimeMs: number;
    resourceLimiterPath?: string; resourceLimiterSha256?: string };
export type VideoProcessResult = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; reason: "exited" | "timeout" | "output_limit" | "resource_unavailable" };
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const remaining = (deadline: number) => Math.max(0, Math.floor(deadline - performance.now()));
async function withinDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    const milliseconds = remaining(deadline);
    if (!milliseconds) throw new Error("video_probe_deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("video_probe_deadline")), milliseconds); })]);
    } finally { if (timer) clearTimeout(timer); }
}
async function cleanupDirectory(directory: string | undefined, deadline: number) {
    if (!directory) return;
    // Once the operation budget is exhausted, cleanup continues privately but cannot
    // keep a stage claim alive. Every process already has kill-on-close protection.
    const cleanup = rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (remaining(deadline)) await withinDeadline(() => cleanup, deadline).catch(() => undefined);
}
async function createProbeDirectory(prefix: string, deadline: number) {
    return withinDeadline(async () => {
        const directory = await mkdtemp(prefix);
        if (!remaining(deadline)) { void rm(directory, { recursive: true, force: true }).catch(() => undefined); throw new Error("video_probe_deadline"); }
        return directory;
    }, deadline);
}

export function readVideoToolchainIdentity(env: Record<string, string | undefined>): VideoToolchainIdentity | null {
    if (env.GENERATION_VIDEO_TOOLCHAIN_IDENTITY === undefined) return null;
    try {
        const value = JSON.parse(env.GENERATION_VIDEO_TOOLCHAIN_IDENTITY);
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "ffmpegSha256,ffprobeSha256,license,sourceUrl,version" ||
            typeof value.ffprobeSha256 !== "string" || typeof value.ffmpegSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(value.ffprobeSha256) || !/^[a-f0-9]{64}$/.test(value.ffmpegSha256) ||
            [value.version, value.license, value.sourceUrl].some(item => typeof item !== "string" || !item || /[\u0000-\u0020\u007f]/.test(item))) return null;
        const source = new URL(value.sourceUrl);
        return source.protocol === "https:" && !source.username && !source.password && !source.search && !source.hash ? value : null;
    } catch { return null; }
}

async function verifyTools(policy: VideoRuntimePolicy, identity: VideoToolchainIdentity, directory: string, deadline: number) {
    if (!["win32", "linux"].includes(process.platform) || !identity || !readVideoToolchainIdentity({ GENERATION_VIDEO_TOOLCHAIN_IDENTITY: JSON.stringify(identity) })) return false;
    for (const path of [policy.ffprobePath, policy.ffmpegPath, policy.probeTempRoot]) if (!isAbsolute(path) || await withinDeadline(() => realpath(path), deadline) !== path) return false;
    if (digest(await withinDeadline(() => readFile(policy.ffprobePath, { signal: AbortSignal.timeout(remaining(deadline)) }), deadline)) !== identity.ffprobeSha256 ||
        digest(await withinDeadline(() => readFile(policy.ffmpegPath, { signal: AbortSignal.timeout(remaining(deadline)) }), deadline)) !== identity.ffmpegSha256) return false;
    const limits = { stdoutMaxBytes: policy.probeStdoutMaxBytes, stderrMaxBytes: policy.probeStderrMaxBytes,
        memoryMaxBytes: policy.probeMemoryMaxBytes, cpuTimeMs: policy.probeCpuLimit,
        resourceLimiterPath: policy.resourceLimiterPath, resourceLimiterSha256: policy.resourceLimiterSha256 };
    if (process.platform === "linux") {
        if (!linuxVideoResourceArguments(limits)) return false;
        // The same pinned prlimit executes a second copy of itself. With no PID
        // and no command, that copy reports its own inherited kernel limits.
        const observed = await runBoundedVideoProcess(policy.resourceLimiterPath!, ["--as", "--cpu", "--output=RESOURCE,SOFT,HARD", "--raw", "--noheadings"], directory,
            { ...limits, timeoutMs: remaining(deadline) });
        if (observed.reason !== "exited" || observed.exitCode !== 0 || observed.stderr.byteLength) return false;
        const rows = new TextDecoder().decode(observed.stdout).trim().split(/\r?\n/).map(row => row.trim().split(/\s+/));
        const expected = new Map([["AS", String(limits.memoryMaxBytes)], ["CPU", String(limits.cpuTimeMs / 1000)]]);
        if (rows.length !== 2 || rows.some(row => row.length !== 3 || expected.get(row[0]) !== row[1] || row[1] !== row[2]) || new Set(rows.map(row => row[0])).size !== 2) return false;
    }
    for (const tool of [policy.ffprobePath, policy.ffmpegPath]) {
        const version = await runBoundedVideoProcess(tool, ["-version"], directory, { ...limits, timeoutMs: remaining(deadline) });
        if (version.reason !== "exited" || version.exitCode !== 0 || new TextDecoder().decode(version.stdout).split(/\s+/)[2] !== identity.version) return false;
    }
    return true;
}

/** Read-only preflight. This never creates a directory/media/helper or changes ACLs.
 * Windows reports installed mechanism metadata; actual Job Object enforcement
 * must still pass checkVideoToolchainReadiness at worker startup. Linux also
 * executes the pinned limiter's self-limit report and bounded tool -version. */
export async function inspectVideoToolchainReadOnly(policy: VideoRuntimePolicy, identity: VideoToolchainIdentity): Promise<{ ready: boolean; platform: string; reasons: string[] }> {
    const result = (reason?: string) => ({ ready: reason === undefined, platform: process.platform, reasons: reason ? [reason] : [] });
    const deadline = performance.now() + (policy?.probeTimeoutMs ?? 0);
    try {
        if (!policy || ![policy.probeTimeoutMs, policy.probeStdoutMaxBytes, policy.probeStderrMaxBytes, policy.probeMemoryMaxBytes, policy.probeCpuLimit].every(positive) ||
            policy.probeTimeoutMs > 0x7fffffff) return result("tool_resource_policy_invalid");
        if (!identity || !readVideoToolchainIdentity({ GENERATION_VIDEO_TOOLCHAIN_IDENTITY: JSON.stringify(identity) })) return result("tool_identity_missing_or_invalid");
        for (const path of [policy.ffprobePath, policy.ffmpegPath]) {
            if (!isAbsolute(path) || await withinDeadline(() => realpath(path), deadline) !== path || !(await withinDeadline(() => stat(path), deadline)).isFile()) return result("tool_path_invalid");
            await withinDeadline(() => access(path, constants.R_OK | constants.X_OK), deadline);
        }
        if (!isAbsolute(policy.probeTempRoot) || await withinDeadline(() => realpath(policy.probeTempRoot), deadline) !== policy.probeTempRoot ||
            !(await withinDeadline(() => stat(policy.probeTempRoot), deadline)).isDirectory()) return result("tool_temp_root_invalid");
        await withinDeadline(() => access(policy.probeTempRoot, constants.R_OK | constants.W_OK | constants.X_OK), deadline);
        if (digest(await withinDeadline(() => readFile(policy.ffprobePath, { signal: AbortSignal.timeout(remaining(deadline)) }), deadline)) !== identity.ffprobeSha256 ||
            digest(await withinDeadline(() => readFile(policy.ffmpegPath, { signal: AbortSignal.timeout(remaining(deadline)) }), deadline)) !== identity.ffmpegSha256) return result("tool_hash_mismatch");
        if (process.platform === "linux") return await verifyTools(policy, identity, policy.probeTempRoot, deadline) && remaining(deadline) > 0 ? result() : result("linux_limits_or_version_unverified");
        if (process.platform === "win32") {
            const systemRoot = process.env.SystemRoot;
            if (!systemRoot || !isAbsolute(systemRoot)) return result("windows_job_mechanism_missing");
            await withinDeadline(() => access(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), constants.R_OK | constants.X_OK), deadline);
            await withinDeadline(() => access(new URL("./generation-video-process.cs", import.meta.url), constants.R_OK), deadline);
            return result();
        }
        return result("resource_platform_unsupported");
    } catch { return result("tool_resource_check_unavailable"); }
}

/** Real startup check, separate from parsing env. Never contacts a provider or reads media. */
export async function checkVideoToolchainReadiness(policy: VideoRuntimePolicy, identity: VideoToolchainIdentity): Promise<boolean> {
    const deadline = performance.now() + (policy?.probeTimeoutMs ?? 0);
    let directory: string | undefined;
    try {
        if (!policy || !isAbsolute(policy.probeTempRoot) || await withinDeadline(() => realpath(policy.probeTempRoot), deadline) !== policy.probeTempRoot) return false;
        directory = await createProbeDirectory(join(policy.probeTempRoot, "video-readiness-"), deadline);
        return await verifyTools(policy, identity, directory, deadline) && remaining(deadline) > 0;
    } catch { return false; }
    finally { await cleanupDirectory(directory, deadline); }
}

/** No unit conversion or rounding can silently expand the configured CPU budget. */
export function linuxVideoResourceArguments(limits: Pick<VideoProcessLimits, "cpuTimeMs" | "memoryMaxBytes" | "resourceLimiterPath" | "resourceLimiterSha256">): string[] | null {
    if (!positive(limits.cpuTimeMs) || limits.cpuTimeMs % 1000 !== 0 || !positive(limits.memoryMaxBytes) ||
        typeof limits.resourceLimiterPath !== "string" || !limits.resourceLimiterPath.startsWith("/") ||
        !/^[a-f0-9]{64}$/.test(limits.resourceLimiterSha256 ?? "")) return null;
    return [`--as=${limits.memoryMaxBytes}:${limits.memoryMaxBytes}`, `--cpu=${limits.cpuTimeMs / 1000}:${limits.cpuTimeMs / 1000}`, "--"];
}

async function runLinuxVideoProcess(executable: string, args: string[], directory: string, limits: VideoProcessLimits, deadline: number): Promise<VideoProcessResult> {
    const unavailable = (): VideoProcessResult => ({ exitCode: -1, stdout: new Uint8Array(), stderr: new Uint8Array(), reason: "resource_unavailable" });
    const limitArguments = linuxVideoResourceArguments(limits);
    if (!limitArguments || !limits.resourceLimiterPath) return unavailable();
    try {
        if (await withinDeadline(() => realpath(limits.resourceLimiterPath!), deadline) !== limits.resourceLimiterPath ||
            digest(await withinDeadline(() => readFile(limits.resourceLimiterPath!, { signal: AbortSignal.timeout(remaining(deadline)) }), deadline)) !== limits.resourceLimiterSha256) return unavailable();
        const child = spawn(limits.resourceLimiterPath, [...limitArguments, executable, ...args], { cwd: directory, detached: true,
            env: { PATH: "", LANG: "C", LC_ALL: "C", TMPDIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
        return await new Promise<VideoProcessResult>(resolve => {
            let done = false, reason: VideoProcessResult["reason"] = "exited", stdoutBytes = 0, stderrBytes = 0;
            const stdout: Buffer[] = [], stderr: Buffer[] = [];
            const kill = (next: VideoProcessResult["reason"]) => { reason = next; if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
            const timer = setTimeout(() => kill("timeout"), remaining(deadline));
            const finish = (exitCode: number) => { if (!done) { done = true; clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), reason }); } };
            child.on("error", () => { reason = "resource_unavailable"; finish(-1); });
            child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; if (stdoutBytes > limits.stdoutMaxBytes) kill("output_limit"); else stdout.push(chunk); });
            child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > limits.stderrMaxBytes) kill("output_limit"); else stderr.push(chunk); });
            child.on("close", code => finish(code ?? -1));
        });
    } catch { return unavailable(); }
}

/** Native Job Object / pinned prlimit limits apply before media tool code starts. */
export async function runBoundedVideoProcess(executable: string, args: string[], directory: string, limits: VideoProcessLimits): Promise<VideoProcessResult> {
    const deadline = performance.now() + limits.timeoutMs;
    const unavailable = (): VideoProcessResult => ({ exitCode: -1, stdout: new Uint8Array(), stderr: new Uint8Array(), reason: "resource_unavailable" });
    if (!isAbsolute(executable) || !isAbsolute(directory) ||
        ![limits.timeoutMs, limits.stdoutMaxBytes, limits.stderrMaxBytes, limits.memoryMaxBytes, limits.cpuTimeMs].every(positive) || limits.timeoutMs > 0x7fffffff) return unavailable();
    if (process.platform === "linux") return runLinuxVideoProcess(executable, args, directory, limits, deadline);
    if (process.platform !== "win32") return unavailable();
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) return unavailable();
    try {
        const source = await withinDeadline(() => readFile(new URL("./generation-video-process.cs", import.meta.url), { encoding: "utf8", signal: AbortSignal.timeout(remaining(deadline)) }), deadline);
        const script = "$ErrorActionPreference='Stop';[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);try{$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition $p.source;$r=[VideoBoundedProcess]::Run($p.executable,[string[]]$p.arguments,$p.directory,[long]$p.memory,[long]$p.cpu,[int]$p.timeout,[int]$p.stdout,[int]$p.stderr);$r|ConvertTo-Json -Compress}catch{[Console]::Write('{}');exit 1}";
        const child = spawn(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
            { windowsHide: true, cwd: directory, env: { SystemRoot: systemRoot, TEMP: directory, TMP: directory }, stdio: ["pipe", "pipe", "pipe"] });
        return await new Promise<VideoProcessResult>((resolve) => {
            let done = false, outputSize = 0, errorsSize = 0;
            let stopped: VideoProcessResult | undefined;
            const chunks: Buffer[] = [];
            const finish = (result: VideoProcessResult) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
            const stop = (result: VideoProcessResult) => { if (!done && !stopped) { stopped = result; child.kill(); } };
            const timer = setTimeout(() => stop({ ...unavailable(), reason: "timeout" }), remaining(deadline));
            child.on("error", () => finish(unavailable()));
            child.stdin.on("error", () => undefined);
            child.stdout.on("data", (chunk: Buffer) => {
                outputSize += chunk.byteLength;
                // Base64 is helper framing, not an extra unbounded tool budget.
                if (outputSize > 4 * Math.ceil((limits.stdoutMaxBytes + limits.stderrMaxBytes) / 3) + 1024) stop({ ...unavailable(), reason: "output_limit" });
                else chunks.push(chunk);
            });
            child.stderr.on("data", (chunk: Buffer) => { errorsSize += chunk.byteLength; if (errorsSize > limits.stderrMaxBytes) stop({ ...unavailable(), reason: "output_limit" }); });
            child.on("close", () => {
                if (done) return;
                // Wait for process/stdio closure after kill; do not leave a decoder
                // running behind a returned timeout and a potentially new stage claim.
                if (stopped) return finish(stopped);
                try {
                    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (!Number.isInteger(value.ExitCode) || !["exited", "timeout", "output_limit", "resource_unavailable"].includes(value.Reason) ||
                        typeof value.StdoutBase64 !== "string" || typeof value.StderrBase64 !== "string") return finish(unavailable());
                    const stdout = Buffer.from(value.StdoutBase64, "base64"), stderr = Buffer.from(value.StderrBase64, "base64");
                    if (stdout.byteLength > limits.stdoutMaxBytes || stderr.byteLength > limits.stderrMaxBytes) return finish(unavailable());
                    finish({ exitCode: value.ExitCode, stdout, stderr, reason: value.Reason });
                } catch { finish(unavailable()); }
            });
            child.stdin.end(JSON.stringify({ source, executable, arguments: args, directory, memory: limits.memoryMaxBytes,
                cpu: limits.cpuTimeMs, timeout: remaining(deadline), stdout: limits.stdoutMaxBytes, stderr: limits.stderrMaxBytes }));
        });
    } catch { return unavailable(); }
}

/** Whole image decode with explicit policy bounds; no first-frame URL or partial decode fallback. */
export async function inspectGenerationVideoReference(body: Uint8Array, contentType: string, policy: VideoRuntimePolicy) {
    if (!(body instanceof Uint8Array) || !positive(policy.referenceMaxBytes) || !positive(policy.referenceMaxPixels) ||
        !body.byteLength || body.byteLength > policy.referenceMaxBytes || !policy.referenceContentTypes.includes(contentType)) return null;
    try {
        const format = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[contentType];
        if (!format) return null;
        const owned = Buffer.from(body);
        const image = sharp(owned, { limitInputPixels: policy.referenceMaxPixels, failOn: "warning", animated: true });
        const info = await image.metadata();
        if (info.format !== format || !info.width || !info.height || (info.pages ?? 1) !== 1 || info.width * info.height > policy.referenceMaxPixels) return null;
        const decoded = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (decoded.info.width !== info.width || decoded.info.height !== info.height || !decoded.data.byteLength) return null;
        return { width: info.width, height: info.height, contentSha256: digest(owned) };
    } catch { return null; }
}

/** Every verified result has executed the pinned real tools, including full decode. No injectable success probe. */
export async function probeGenerationVideo(body: Uint8Array, policy: VideoRuntimePolicy, identity: VideoToolchainIdentity): Promise<VideoProbeResult> {
    const deadline = performance.now() + (policy?.probeTimeoutMs ?? 0);
    const unknown = (reason: "video_probe_unavailable" | "video_probe_invalid" | "video_probe_resource_limit"): VideoProbeResult => ({ status: "unknown", reason });
    if (!(body instanceof Uint8Array) || !body.byteLength || !positive(policy.maxVideoBytes) || body.byteLength > policy.maxVideoBytes ||
        ![policy.maxPixels, policy.maxMediaDurationMs, policy.probeTimeoutMs, policy.probeStdoutMaxBytes, policy.probeStderrMaxBytes,
            policy.probeMemoryMaxBytes, policy.probeCpuLimit].every(positive) ||
        !identity || !/^[a-f0-9]{64}$/.test(identity.ffprobeSha256) || !/^[a-f0-9]{64}$/.test(identity.ffmpegSha256) ||
        typeof identity.version !== "string" || !identity.version || /\s/.test(identity.version) || !identity.license || !/^https:\/\//.test(identity.sourceUrl)) return unknown("video_probe_unavailable");
    const bytes = new Uint8Array(body); // Own media before any filesystem/tool await.
    let directory: string | undefined;
    try {
        if (!isAbsolute(policy.probeTempRoot) || await withinDeadline(() => realpath(policy.probeTempRoot), deadline) !== policy.probeTempRoot) return unknown("video_probe_unavailable");
        directory = await createProbeDirectory(join(policy.probeTempRoot, "video-"), deadline);
        const filename = join(directory, "input.mp4");
        // verifyTools also establishes the private directory ACL before the first media write.
        if (!await verifyTools(policy, identity, directory, deadline)) return unknown("video_probe_unavailable");
        await withinDeadline(() => writeFile(filename, bytes, { flag: "wx", mode: 0o600, signal: AbortSignal.timeout(remaining(deadline)) }), deadline);
        const limits = { stdoutMaxBytes: policy.probeStdoutMaxBytes,
            stderrMaxBytes: policy.probeStderrMaxBytes, memoryMaxBytes: policy.probeMemoryMaxBytes, cpuTimeMs: policy.probeCpuLimit,
            resourceLimiterPath: policy.resourceLimiterPath, resourceLimiterSha256: policy.resourceLimiterSha256 };
        const input = ["-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-f", "mov"];
        const metadata = await runBoundedVideoProcess(policy.ffprobePath, ["-v", "error", "-threads", "1", ...input, "-count_frames", "-show_entries",
            "format=format_name,duration:stream=index,codec_type,width,height,duration,nb_frames,nb_read_frames", "-of", "json", filename], directory, { ...limits, timeoutMs: remaining(deadline) });
        if (metadata.reason !== "exited") return unknown("video_probe_resource_limit");
        if (metadata.exitCode !== 0 || metadata.stderr.byteLength) return unknown("video_probe_invalid");
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata.stdout));
        const streams = value.streams;
        const video = Array.isArray(streams) ? streams.filter((stream: Record<string, unknown>) => stream.codec_type === "video") : [];
        if (video.length !== 1 || streams.some((stream: Record<string, unknown>) => stream.codec_type !== "video" && stream.codec_type !== "audio") ||
            typeof value.format?.format_name !== "string" || !value.format.format_name.split(",").includes("mp4")) return unknown("video_probe_invalid");
        const width = video[0].width, height = video[0].height, duration = Number(value.format.duration), frames = Number(video[0].nb_read_frames);
        if (!positive(width) || !positive(height) || width * height > policy.maxPixels || !Number.isFinite(duration) || duration <= 0 || duration * 1000 > policy.maxMediaDurationMs ||
            !positive(frames) || video[0].nb_frames !== undefined && Number(video[0].nb_frames) !== frames) return unknown("video_probe_invalid");
        const decoded = await runBoundedVideoProcess(policy.ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-threads", "1", ...input,
            "-i", filename, "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn", "-threads", "1", "-f", "null", "-"], directory, { ...limits, timeoutMs: remaining(deadline) });
        if (decoded.reason !== "exited") return unknown("video_probe_resource_limit");
        if (decoded.exitCode !== 0 || decoded.stderr.byteLength || !remaining(deadline)) return unknown("video_probe_invalid");
        return { status: "verified", probe: { source: "ffmpeg_full_decode", toolVersion: identity.version, ffprobeSha256: identity.ffprobeSha256,
            ffmpegSha256: identity.ffmpegSha256, contentSha256: digest(bytes), format: "mp4", width, height, durationSeconds: duration, frames } };
    } catch { return unknown("video_probe_unavailable"); }
    finally { await cleanupDirectory(directory, deadline); }
}
