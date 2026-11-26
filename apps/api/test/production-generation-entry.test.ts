import { expect, test } from "bun:test";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertProductionGenerationTarget, readGenerationWorkerConfig } from "../src/generation-worker-config";
import { readVideoRuntimePolicy } from "../src/generation-video-config";
import { startGenerationWorkerProcess } from "../src/generation-worker-process";
import { expectedGenerationSchemaVersion, inspectGenerationSchemaVersion, parseGenerationSchemaArguments,
    productionGenerationFixtureSchema, readGenerationWorkerSchemaConfig, runGenerationWorkerSchemaOperation } from "../src/generation-worker-schema";
import { requiredAccountRelations } from "../src/readiness";
import { evaluateProductionGenerationMetadata, parseProductionPreflightArguments, readProductionGenerationConfiguration,
    runProductionGenerationPreflight, type ProductionGenerationMetadata } from "../../../scripts/saas/production-generation-preflight";

const target = { target: "production" as const, authorizeProductionReadOnly: true,
    expectedOrigin: "https://agent.zh-api.com", expectedDatabaseTarget: "postgresql://db.example.test:5432/canvas" };
const env = {
    GENERATION_WORKER_ENABLED: "true", GENERATION_WORKER_ENVIRONMENT: "production",
    GENERATION_WORKER_QUEUE_URL: "postgresql://worker:synthetic@db.example.test/canvas",
    SAAS_DATABASE_URL: "postgresql://api:synthetic@db.example.test:5432/canvas",
    SAAS_ORIGIN: "https://agent.zh-api.com", SAAS_ACCOUNTS_ENABLED: "true", SAAS_TRUSTED_PROXY: "true",
    SAAS_MEDIA_ENABLED: "true", SAAS_AUTH_SECRET: "synthetic-test-secret-is-at-least-32-characters",
    SMTP_HOST: "smtp.example.test", SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "synthetic", SMTP_PASSWORD: "synthetic",
    SMTP_FROM: "test@example.test", SMTP_CONNECTION_TIMEOUT_MS: "10000", SMTP_SOCKET_TIMEOUT_MS: "30000",
    CAPTCHA_TIMEOUT_MS: "10000", TURNSTILE_SECRET_KEY: "synthetic", TURNSTILE_SITE_KEY: "synthetic",
    STORAGE_PROVIDER: "aliyun-oss", ALIYUN_OSS_REGION: "synthetic", ALIYUN_OSS_BUCKET: "synthetic",
    ALIYUN_OSS_ACCESS_KEY_ID: "synthetic", ALIYUN_OSS_ACCESS_KEY_SECRET: "synthetic",
    PRODUCTION_GENERATION_IMAGE: "sha256:" + "a".repeat(64),
};
const args = ["--target", "production", "--authorize-production-read-only", "--expected-origin", target.expectedOrigin,
    "--expected-database-target", target.expectedDatabaseTarget];
const queue = { name: "generation", policy: "standard", retryLimit: 0, retryDelay: 0, retryBackoff: false,
    retryDelayMax: null, expireInSeconds: 900, retentionSeconds: 1209600, deleteAfterSeconds: 604800, heartbeatSeconds: null };
const ready: ProductionGenerationMetadata = { schemaState: "ready", installedSchemaVersion: expectedGenerationSchemaVersion(),
    queue: { name: "generation", policy: "standard", retryLimit: 0 },
    applicationRelations: [...requiredAccountRelations(true), "generation_task", "model_price_publication", "model_price_draft"] };

function databaseFixture(input: { schema?: "missing" | "partial" | "ready"; versions?: unknown[]; queue?: typeof queue | null; fail?: string } = {}) {
    const queries: string[] = [], events: string[] = [];
    let state = input.schema ?? "ready";
    let effectiveQueue = input.queue === undefined ? queue : input.queue;
    const client = {
        async query(sql: string) {
            queries.push(sql);
            if (sql === input.fail) throw new Error("synthetic query failure");
            // Observe the construction string before matching SELECT fragments inside it.
            if (sql.includes("CREATE SCHEMA")) { events.push("observe-install-sql"); state = "ready"; return { rows: [] }; }
            if (sql.includes("information_schema.schemata")) return { rows: [{ exists: state !== "missing" }] };
            if (sql.includes("information_schema.tables") && sql.includes("$1")) return { rows: [{ exists: state === "ready" }] };
            if (sql === "SELECT version FROM canvas_jobs.version") return { rows: (input.versions ?? [expectedGenerationSchemaVersion()]).map((version) => ({ version })) };
            if (sql.includes("FROM canvas_jobs.queue")) return { rows: effectiveQueue ? [effectiveQueue] : [] };
            if (sql.includes("table_schema = 'canvas_saas'")) return { rows: ready.applicationRelations.map((table_name) => ({ table_name })) };
            if (sql === "BEGIN TRANSACTION READ ONLY" || sql === "ROLLBACK") return { rows: [] };
            throw new Error("unexpected fixture query");
        },
        release() { events.push("release"); },
    };
    return { queries, events, client,
        databaseFactory: (() => ({ pool: { connect: async () => client }, close: async () => { events.push("close"); } })) as any,
        queueFactory: (() => ({ start: async () => { events.push("fake-start"); }, stop: async () => { events.push("fake-stop"); },
            createQueue: async () => { events.push("fake-create"); effectiveQueue = queue; } })) as any,
    };
}

test("production cannot inherit staging apply or connect without its own explicit acknowledgement", async () => {
    for (const options of [{}, { apply: true }, { target: "production" as const }, { ...target, authorizeProductionReadOnly: false },
        { ...target, apply: true }, { ...target, apply: true, authorizeProductionSchemaInstall: true },
        { ...target, authorizeProductionSchemaInstall: true }]) {
        let opened = false;
        await expect(runGenerationWorkerSchemaOperation({ ...options, env,
            databaseFactory: (() => { opened = true; throw new Error("must not connect"); }) as any })).rejects.toThrow();
        expect(opened).toBe(false);
    }
    expect(readGenerationWorkerSchemaConfig(env, target).environment).toBe("production");
});

test("target pins origin and same database without accepting credentials or query overrides in the expectation", () => {
    expect(() => assertProductionGenerationTarget(env, target)).not.toThrow();
    for (const expectedDatabaseTarget of ["postgres://db.example.test/other", "postgres://user:password@db.example.test/canvas",
        "postgres://db.example.test/canvas?host=db.example.test", "postgres://db.example.test/canvas#fragment"]) {
        expect(() => assertProductionGenerationTarget(env, { ...target, expectedDatabaseTarget })).toThrow();
    }
    for (const change of [{ SAAS_ORIGIN: "https://staging.example.test" }, { GENERATION_WORKER_ENVIRONMENT: "staging" },
        { SAAS_DATABASE_URL: "postgres://other.example.test/canvas" }, { GENERATION_WORKER_QUEUE_URL: "postgres://db.example.test/canvas?dbname=other" }]) {
        expect(() => assertProductionGenerationTarget({ ...env, ...change }, target)).toThrow();
    }
    expect(() => assertProductionGenerationTarget(env, { ...target, expectedOrigin: "https://agent.zh-api.com/path" })).toThrow();
});

test("schema and preflight argument parsers reject ambiguous writes, missing modes and duplicate or unknown flags", () => {
    expect(parseGenerationSchemaArguments(["--apply"]).apply).toBe(true);
    expect(parseGenerationSchemaArguments([...args, "--dry-run"]).apply).toBe(false);
    for (const invalid of [["--apply", "--apply"], ["--unknown"], ["--target"], ["--target", "prod"], ["--apply", "--dry-run"], [...args, "--expected-origin", target.expectedOrigin]]) {
        expect(() => parseGenerationSchemaArguments(invalid)).toThrow();
    }
    expect(parseProductionPreflightArguments([...args, "--configuration-only"]).mode).toBe("configuration-only");
    expect(parseProductionPreflightArguments([...args, "--runtime-read-only"]).mode).toBe("runtime-read-only");
    expect(parseProductionPreflightArguments([...args, "--fixture", "synthetic.json"]).mode).toBe("fixture");
    for (const invalid of [args, [...args, "--database-read-only", "--configuration-only"], [...args, "--runtime-read-only", "--fixture", "synthetic.json"],
        [...args, "--fixture"], [...args, "--database-read-only", "--apply"], [...args, "--database-read-only", "--authorize-production-schema-install"]]) {
        expect(() => parseProductionPreflightArguments(invalid)).toThrow();
    }
});

test("production dry-run uses only one read-only connection and never starts an installer", async () => {
    const fixture = databaseFixture();
    const result = await runGenerationWorkerSchemaOperation({ ...target, env, databaseFactory: fixture.databaseFactory,
        queueFactory() { throw new Error("must never construct pg-boss in check"); } });
    expect(result.version).toEqual({ expected: expectedGenerationSchemaVersion(), installed: expectedGenerationSchemaVersion(), compatible: true });
    expect(result.schema.applied).toBe(false);
    expect(result.queue.applied).toBe(false);
    expect(fixture.queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(fixture.queries.at(-1)).toBe("ROLLBACK");
    expect(fixture.queries.slice(1, -1).every((sql) => sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(fixture.events).toEqual(["release", "close"]);
});

test("version comparison rejects unknown, multiple or incompatible version rows without any write", async () => {
    for (const versions of [[], ["43"], [null], [expectedGenerationSchemaVersion() - 1], [expectedGenerationSchemaVersion(), expectedGenerationSchemaVersion()]]) {
        const fixture = databaseFixture({ versions });
        expect((await inspectGenerationSchemaVersion(fixture.client)).compatible).toBe(false);
        await expect(runGenerationWorkerSchemaOperation({ ...target, env, apply: true,
            authorizeProductionReadOnly: false, authorizeProductionSchemaInstall: true,
            databaseFactory: fixture.databaseFactory, queueFactory: fixture.queueFactory })).rejects.toThrow("版本不兼容");
        expect(fixture.queries.every((sql) => sql.startsWith("SELECT"))).toBe(true);
        expect(fixture.events).toEqual(["release", "close"]);
    }
});

test("partial schemas and existing unsafe queue policies cannot reach the production installer", async () => {
    const options = { ...target, env, apply: true, authorizeProductionReadOnly: false, authorizeProductionSchemaInstall: true };
    const partial = databaseFixture({ schema: "partial" });
    await expect(runGenerationWorkerSchemaOperation({ ...options, databaseFactory: partial.databaseFactory, queueFactory: partial.queueFactory })).rejects.toThrow("不完整");
    expect(partial.events).toEqual(["release", "close"]);
    const unsafe = databaseFixture({ queue: { ...queue, retryLimit: 1 } });
    const result = await runGenerationWorkerSchemaOperation({ ...options, databaseFactory: unsafe.databaseFactory, queueFactory: unsafe.queueFactory });
    expect(result.queue.state).toBe("policy_mismatch");
    expect(unsafe.events).toEqual(["release", "close"]);
});

test("explicit production apply can reach only fake initial-install primitives after the independent gate", async () => {
    const fixture = databaseFixture({ schema: "missing", queue: null });
    const result = await runGenerationWorkerSchemaOperation({ ...target, env, apply: true,
        authorizeProductionReadOnly: false, authorizeProductionSchemaInstall: true,
        databaseFactory: fixture.databaseFactory, queueFactory: fixture.queueFactory });
    expect(result.schema.applied).toBe(true);
    expect(result.queue.applied).toBe(true);
    expect(fixture.events).toEqual(["observe-install-sql", "fake-start", "fake-create", "fake-stop", "release", "close"]);
});

test("missing production schema dry-run reports missing and never applies", async () => {
    const fixture = databaseFixture({ schema: "missing" });
    const result = await runGenerationWorkerSchemaOperation({ ...target, env, databaseFactory: fixture.databaseFactory, queueFactory: fixture.queueFactory });
    expect(result.schema).toEqual({ state: "missing", applied: false });
    expect(fixture.events).toEqual(["release", "close"]);
});

test("configuration gate refuses missing security, unpinned images, disabled worker and unsupported API admission", () => {
    expect(() => readProductionGenerationConfiguration(env, target)).not.toThrow();
    for (const change of [{ SAAS_AUTH_SECRET: "" }, { SMTP_PASSWORD: undefined }, { TURNSTILE_SECRET_KEY: "" },
        { ALIYUN_OSS_ACCESS_KEY_SECRET: "" }, { SAAS_TRUSTED_PROXY: "false" }, { GENERATION_WORKER_ENABLED: "false" },
        { PRODUCTION_GENERATION_IMAGE: "latest" }, { SAAS_AUTH_SECRET: "REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS" },
        { SAAS_GENERATION_IMAGE_ENABLED: "true" }, { SAAS_GENERATION_AUDIO_ENABLED: "true" },
        { SAAS_GENERATION_VIDEO_ENABLED: "true" }, { GENERATION_WORKER_VIDEO_ENABLED: "true" }, { GENERATION_WORKER_VIDEO_ENABLED: "yes" }]) {
        expect(() => readProductionGenerationConfiguration({ ...env, ...change }, target)).toThrow();
    }
});

test("metadata inspection and fixture mode report script checks separately from launch readiness", async () => {
    const fixture = databaseFixture();
    const result = await runProductionGenerationPreflight({ ...target, env, mode: "database-read-only", databaseFactory: fixture.databaseFactory });
    expect(result.status).toBe("checks-passed");
    expect(result.launchReady).toBe(false);
    expect(result.requiredExternalChecks).toContain("all-consumers-compatible-and-old-consumers-exited");
    expect(fixture.queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(fixture.queries.at(-1)).toBe("ROLLBACK");
    expect(fixture.queries.slice(1, -1).every((sql) => sql.startsWith("SELECT"))).toBe(true);
    expect(fixture.events).toEqual(["release", "close"]);
    const synthetic = await runProductionGenerationPreflight({ ...target, env, mode: "fixture", metadata: ready,
        databaseFactory: (() => { throw new Error("fixture must never connect"); }) as any });
    expect(synthetic.mode).toBe("fixture");
    expect(synthetic.status).toBe("checks-passed");
    const printed = JSON.stringify(result);
    for (const secret of [env.SAAS_AUTH_SECRET, env.SAAS_DATABASE_URL, env.GENERATION_WORKER_QUEUE_URL]) expect(printed).not.toContain(secret);
});

test("missing tables/version/queue and unsafe policies block metadata results", () => {
    for (const change of [{ schemaState: "partial" as const }, { installedSchemaVersion: null }, { installedSchemaVersion: expectedGenerationSchemaVersion() + 1 },
        { queue: null }, { queue: { name: "generation", policy: "standard", retryLimit: 2 } }, { applicationRelations: [] }]) {
        expect(evaluateProductionGenerationMetadata({ ...ready, ...change }, true).status).toBe("blocked");
    }
});

test("query failure still rolls back and closes; invalid targets never construct a database", async () => {
    const fixture = databaseFixture({ fail: "SELECT version FROM canvas_jobs.version" });
    await expect(runProductionGenerationPreflight({ ...target, env, mode: "database-read-only", databaseFactory: fixture.databaseFactory })).rejects.toThrow("synthetic");
    expect(fixture.queries.at(-1)).toBe("ROLLBACK");
    expect(fixture.events).toEqual(["release", "close"]);
    await expect(runProductionGenerationPreflight({ ...target, expectedOrigin: "https://wrong.example.test", env, mode: "database-read-only",
        databaseFactory: (() => { throw new Error("must not connect"); }) as any })).rejects.toThrow("来源");
});

/** Synthetic numbers and paths only. No file, tool, approved channel or resource executor exists. */
function completeVideoEnv(): Record<string, string> {
    const video: Record<string, string> = { ...env, SAAS_GENERATION_VIDEO_ENABLED: "true", GENERATION_WORKER_VIDEO_ENABLED: "true",
        STORAGE_VIDEO_MAX_BYTES: "1000000", GENERATION_VIDEO_REFERENCE_CONTENT_TYPES: '["image/png"]',
        GENERATION_VIDEO_FFPROBE_PATH: "/synthetic/tools/ffprobe", GENERATION_VIDEO_FFMPEG_PATH: "/synthetic/tools/ffmpeg",
        GENERATION_VIDEO_PROBE_TEMP_ROOT: "/synthetic/temp" };
    for (const suffix of ["CREATE_TIMEOUT_MS", "INSPECT_TIMEOUT_MS", "DOWNLOAD_TIMEOUT_MS", "JSON_MAX_BYTES", "POLL_INTERVAL_MS",
        "RECOVERY_SCAN_INTERVAL_MS", "RECOVERY_SCAN_BATCH_SIZE", "OBSERVATION_WINDOW_MS", "MAX_INSPECT_ATTEMPTS", "MAX_DOWNLOAD_ATTEMPTS",
        "MAX_PIXELS", "MAX_MEDIA_DURATION_MS", "REFERENCE_MAX_BYTES", "REFERENCE_MAX_PIXELS", "PROBE_TIMEOUT_MS", "PROBE_STDOUT_MAX_BYTES",
        "PROBE_STDERR_MAX_BYTES", "PROBE_MEMORY_MAX_BYTES", "PROBE_CPU_LIMIT"]) video[`GENERATION_VIDEO_${suffix}`] = "100";
    video.GENERATION_VIDEO_CLAIM_LEASE_MS = "1000";
    video.GENERATION_VIDEO_PROBE_CPU_LIMIT = "1000";
    video.GENERATION_VIDEO_RESOURCE_LIMITER_PATH = "/synthetic/tools/prlimit";
    video.GENERATION_VIDEO_RESOURCE_LIMITER_SHA256 = "c".repeat(64);
    video.GENERATION_VIDEO_TOOLCHAIN_IDENTITY = JSON.stringify({ ffprobeSha256: "a".repeat(64), ffmpegSha256: "b".repeat(64),
        version: "synthetic-fixed-version", license: "synthetic-license", sourceUrl: "https://example.test/synthetic.zip" });
    return video;
}

test("worker configuration consumes the shared V1 parser without inventing video defaults or execution readiness", () => {
    const video = completeVideoEnv();
    const parsed = readGenerationWorkerConfig(video);
    expect(parsed?.videoPolicy).toEqual(readVideoRuntimePolicy(video)!);
    expect(parsed?.videoPolicy?.probeCpuLimit).toBe(1000);
    expect(parsed?.videoEnabled).toBe(true);
    expect(readGenerationWorkerConfig({ ...video, GENERATION_WORKER_VIDEO_ENABLED: "false" })?.videoEnabled).toBe(false);
    expect(readGenerationWorkerConfig({ ...env, GENERATION_WORKER_VIDEO_ENABLED: "false" })).not.toHaveProperty("videoPolicy");
    for (const change of [{ GENERATION_VIDEO_PROBE_CPU_LIMIT: "" }, { GENERATION_WORKER_VIDEO_ENABLED: "yes" },
        { GENERATION_VIDEO_CLAIM_LEASE_MS: "200" }, { STORAGE_VIDEO_MAX_BYTES: "0" }]) {
        expect(() => readGenerationWorkerConfig({ ...video, ...change })).toThrow();
    }
});

test("schema operations validate the shared video policy before constructing any connection", async () => {
    let opened = false;
    await expect(runGenerationWorkerSchemaOperation({ ...target, env: { ...completeVideoEnv(), GENERATION_VIDEO_PROBE_MEMORY_MAX_BYTES: "" },
        databaseFactory: (() => { opened = true; throw new Error("must not connect"); }) as any })).rejects.toThrow("GENERATION_VIDEO_PROBE_MEMORY_MAX_BYTES");
    expect(opened).toBe(false);
    const fixture = databaseFixture();
    await runGenerationWorkerSchemaOperation({ ...target, env: completeVideoEnv(), databaseFactory: fixture.databaseFactory,
        queueFactory() { throw new Error("schema check must not construct an installer"); } });
    expect(fixture.queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(fixture.queries.at(-1)).toBe("ROLLBACK");
    expect(fixture.queries.slice(1, -1).every((sql) => sql.startsWith("SELECT"))).toBe(true);
});

test("complete video policy or optimistic env/metadata without resource inspection remains blocked before a database", async () => {
    const video: Record<string, string> = { ...completeVideoEnv(), VIDEO_TOOLS_READY: "true" };
    for (const mode of ["configuration-only", "fixture", "database-read-only"] as const) {
        let opened = false;
        const result = await runProductionGenerationPreflight({ ...target, env: video, mode, metadata: ready,
            inspectVideoTools: async () => ({ ready: false, platform: "linux", reasons: ["linux_limits_or_version_unverified"] }),
            databaseFactory: (() => { opened = true; throw new Error("video resources must block before DB"); }) as any });
        expect(opened).toBe(false);
        expect(result).toMatchObject({ status: "blocked", launchReady: false,
            checks: { configuration: true, localVideoWorkerConfigured: true, videoReadOnlyResourcesPassed: false, startupVideoProbeVerified: false },
            videoResources: { status: "unverified", ready: false, reasons: expect.any(Array) } });
        expect(JSON.stringify(result)).not.toContain(video.GENERATION_VIDEO_FFPROBE_PATH!);
    }
});

test("API video configuration does not imply a configured local video consumer or runtime resources", async () => {
    const result = await runProductionGenerationPreflight({ ...target, env: { ...completeVideoEnv(), GENERATION_WORKER_VIDEO_ENABLED: "false" },
        mode: "configuration-only" });
    expect(result).toMatchObject({ status: "blocked", launchReady: false,
        checks: { localVideoWorkerConfigured: false, videoReadOnlyResourcesPassed: false, startupVideoProbeVerified: false },
        configured: { api: { video: true }, worker: { video: false } } });
});

test("both video opt-ins false preserve existing non-video preflight behavior and do not require probe paths or limits", async () => {
    const result = await runProductionGenerationPreflight({ ...target, env: { ...env, SAAS_GENERATION_VIDEO_ENABLED: "false", GENERATION_WORKER_VIDEO_ENABLED: "false" },
        mode: "fixture", metadata: ready, databaseFactory: (() => { throw new Error("fixture must not connect"); }) as any });
    expect(result.status).toBe("checks-passed");
    expect(result).not.toHaveProperty("videoResources");
    expect(result.configured).toMatchObject({ api: { video: false }, worker: { video: false } });
});

test("explicit runtime read-only mode has a configurable positive path through the same V1 inspector", async () => {
    let checks = 0;
    const video = completeVideoEnv();
    const result = await runProductionGenerationPreflight({ ...target, env: video, mode: "runtime-read-only",
        databaseFactory: (() => { throw new Error("runtime resource check must not connect to DB"); }) as any,
        inspectVideoTools: async (policy, identity) => {
            checks++;
            expect(policy).toEqual(readVideoRuntimePolicy(video)!);
            expect(identity).toMatchObject({ ffprobeSha256: "a".repeat(64), ffmpegSha256: "b".repeat(64) });
            return { ready: true, platform: "linux", reasons: [] };
        } });
    expect(checks).toBe(1);
    expect(result).toMatchObject({ status: "runtime-checks-passed", launchReady: false,
        checks: { configuration: true, videoReadOnlyResourcesPassed: true, startupVideoProbeVerified: false, localVideoWorkerConfigured: true },
        videoResources: { status: "checks-passed", platform: "linux", evidenceSource: "injected-fixture" } });
    expect(result.requiredExternalChecks).toContain("all-consumers-compatible-and-old-consumers-exited");
});

test("fixture positive evidence is labelled synthetic and never executes the resource inspector", async () => {
    const result = await runProductionGenerationPreflight({ ...target, env: completeVideoEnv(), mode: "fixture", metadata: ready,
        fixtureVideoResources: { ready: true, platform: "linux", reasons: [] },
        inspectVideoTools: async () => { throw new Error("fixture must not inspect the real filesystem or execute a tool"); },
        databaseFactory: (() => { throw new Error("fixture must not connect"); }) as any });
    expect(result).toMatchObject({ status: "checks-passed", launchReady: false,
        videoResources: { status: "checks-passed", evidenceSource: "fixture", platform: "linux" } });
});

test("database read-only follows successful resource inspection but never becomes launch approval", async () => {
    const fixture = databaseFixture(), events: string[] = [];
    const result = await runProductionGenerationPreflight({ ...target, env: completeVideoEnv(), mode: "database-read-only",
        inspectVideoTools: async () => { events.push("inspect"); return { ready: true, platform: "linux", reasons: [] }; },
        databaseFactory: ((connection: string) => { events.push("open"); return fixture.databaseFactory(connection); }) as any });
    expect(events).toEqual(["inspect", "open"]);
    expect(result.status).toBe("checks-passed");
    expect(result.launchReady).toBe(false);
    expect(fixture.queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(fixture.queries.at(-1)).toBe("ROLLBACK");
    expect(fixture.queries.slice(1, -1).every((sql) => sql.startsWith("SELECT"))).toBe(true);
    expect(fixture.events).toEqual(["release", "close"]);
});

test("Linux fixture success cannot bypass exact CPU representation or missing pinned resource launcher", async () => {
    for (const change of [{ GENERATION_VIDEO_PROBE_CPU_LIMIT: "100" }, { GENERATION_VIDEO_PROBE_CPU_LIMIT: "1500" },
        { GENERATION_VIDEO_RESOURCE_LIMITER_PATH: undefined, GENERATION_VIDEO_RESOURCE_LIMITER_SHA256: undefined }]) {
        const result = await runProductionGenerationPreflight({ ...target, env: { ...completeVideoEnv(), ...change }, mode: "fixture", metadata: ready,
            fixtureVideoResources: { ready: true, platform: "linux", reasons: [] },
            databaseFactory: (() => { throw new Error("invalid CPU/launcher cannot reach DB"); }) as any });
        expect(result).toMatchObject({ status: "blocked", videoResources: { status: "unverified", platform: "linux",
            reasons: ["linux_resource_policy_not_representable"] } });
    }
});

test("missing identity is rejected by worker configuration before tools, database or queue runtime", async () => {
    let inspected = 0;
    let opened = 0;
    let runtimeCreated = 0;
    const video = { ...completeVideoEnv(), GENERATION_VIDEO_TOOLCHAIN_IDENTITY: undefined };
    const databaseFactory = (() => { opened++; throw new Error("must not open without identity"); }) as any;
    const fixedRejection = "视频worker需要完整资源政策和固定工具身份";
    await expect(runProductionGenerationPreflight({ ...target, env: video, mode: "database-read-only",
        inspectVideoTools: async () => { inspected++; throw new Error("must not inspect without identity"); },
        databaseFactory,
    })).rejects.toThrow(fixedRejection);
    await expect(startGenerationWorkerProcess({ env: video, databaseFactory,
        runtimeFactory: () => { runtimeCreated++; throw new Error("must not create queue runtime without identity"); },
    })).rejects.toThrow(fixedRejection);
    expect(inspected).toBe(0);
    expect(opened).toBe(0);
    expect(runtimeCreated).toBe(0);
});

test("missing identity CLI exits one and emits only the safe rejection contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "production-w1-cli-"));
    const fixturePath = join(directory, "missing-identity.json");
    try {
        const video = completeVideoEnv();
        delete video.GENERATION_VIDEO_TOOLCHAIN_IDENTITY;
        await writeFile(fixturePath, JSON.stringify({ env: video, metadata: ready }));
        const cli = fileURLToPath(new URL("../../../scripts/saas/production-generation-preflight.ts", import.meta.url));
        const child = Bun.spawn({ cmd: [process.execPath, "--no-env-file", cli, ...args, "--fixture", fixturePath],
            env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exit).toBe(1);
        expect(stdout).toBe("");
        expect(stderr.trim()).toBe("production generation preflight refused or failed; no install, migration or generation was requested");
        for (const secret of [video.SAAS_AUTH_SECRET!, video.SAAS_DATABASE_URL!, video.GENERATION_VIDEO_FFPROBE_PATH!]) {
            expect(stdout + stderr).not.toContain(secret);
        }
    } finally {
        await unlink(fixturePath).catch(() => undefined);
        await rmdir(directory);
    }
});

test("failed or throwing resource checks stay closed without printing tool errors", async () => {
    const failed = await runProductionGenerationPreflight({ ...target, env: completeVideoEnv(), mode: "runtime-read-only",
        inspectVideoTools: async () => { throw new Error(env.SAAS_AUTH_SECRET); } });
    expect(failed).toMatchObject({ status: "blocked", videoResources: { reasons: ["tool_resource_check_unavailable"] } });
    expect(JSON.stringify(failed)).not.toContain(env.SAAS_AUTH_SECRET);
});

test("synthetic resource records are accepted only in explicit fixture mode and have a strict consistent shape", async () => {
    const positive = { ready: true, platform: "linux", reasons: [] };
    expect(productionGenerationFixtureSchema.parse({ env: completeVideoEnv(), metadata: ready, videoResources: positive }).videoResources).toEqual(positive);
    for (const videoResources of [{ ...positive, ready: false }, { ...positive, reasons: ["tool_hash_mismatch"] },
        { ...positive, platform: "unsupported" }, { ...positive, extra: true }]) {
        expect(() => productionGenerationFixtureSchema.parse({ env: completeVideoEnv(), metadata: ready, videoResources })).toThrow();
    }
    let inspected = 0;
    const actualMode = await runProductionGenerationPreflight({ ...target, env: completeVideoEnv(), mode: "runtime-read-only",
        fixtureVideoResources: positive, inspectVideoTools: async () => {
            inspected++; return { ready: false, platform: "linux", reasons: ["tool_hash_mismatch"] };
        } });
    expect(inspected).toBe(1);
    expect(actualMode).toMatchObject({ status: "blocked", videoResources: { reasons: ["tool_hash_mismatch"] } });
});
