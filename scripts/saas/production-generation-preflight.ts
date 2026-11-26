import { readFile } from "node:fs/promises";
import { createDatabase } from "../../packages/database/src/client";
import { isGenerationQueueReady } from "../../packages/jobs/src";
import { readAccountConfig } from "../../apps/api/src/config";
import { readGenerationApiConfig } from "../../apps/api/src/generation-api-runtime";
import { assertProductionGenerationTarget, type ProductionGenerationTarget } from "../../apps/api/src/generation-worker-config";
import { readGenerationWorkerProcessConfig } from "../../apps/api/src/generation-worker-process";
import { inspectVideoToolchainReadOnly, readVideoToolchainIdentity, linuxVideoResourceArguments } from "../../apps/api/src/generation-video-probe";
import { requiredAccountRelations } from "../../apps/api/src/readiness";
import { expectedGenerationSchemaVersion, inspectGenerationWorkerSchema, inspectGenerationSchemaVersion,
    inspectGenerationQueue, parseGenerationSchemaArguments, productionGenerationMetadataSchema as metadataSchema,
    productionGenerationFixtureSchema, productionVideoResourceInspectionSchema,
    type GenerationWorkerSchemaClient, type ProductionGenerationMetadata } from "../../apps/api/src/generation-worker-schema";
export type { ProductionGenerationMetadata };

/** Parse only: no database, storage, SMTP, supplier, queue or worker is started. */
export function readProductionGenerationConfiguration(env: Record<string, string | undefined>, target: ProductionGenerationTarget) {
    assertProductionGenerationTarget(env, target);
    if (!/^sha256:[a-f0-9]{64}$/.test(env.PRODUCTION_GENERATION_IMAGE ?? "")) throw new Error("production 需要固定的实际镜像 ID");
    for (const name of ["SAAS_AUTH_SECRET", "ALIYUN_OSS_ACCESS_KEY_ID", "ALIYUN_OSS_ACCESS_KEY_SECRET", "TURNSTILE_SECRET_KEY", "SMTP_PASSWORD"]) {
        if (env[name]?.startsWith("REPLACE_")) throw new Error("production 安全配置不能使用模板占位符");
    }
    const account = readAccountConfig(env);
    if (!account || account.SAAS_TRUSTED_PROXY !== "true") throw new Error("production 需要账户及可信 HTTPS 反代配置");
    if (!account.cloudMedia || account.storage?.provider !== "aliyun-oss") throw new Error("production 需要私有 OSS 及云媒体配置");
    const worker = readGenerationWorkerProcessConfig(env);
    if (!worker) throw new Error("worker 配置门禁需要明确启用 worker");
    const api = readGenerationApiConfig(env, account);
    if (api?.imageEnabled && !worker.imageEnabled) throw new Error("API 图片准入需要兼容图片 worker");
    if (api?.audioEnabled && !worker.audioEnabled) throw new Error("API 音频准入需要兼容音频 worker");
    return { account, worker, api };
}

/** Fixed SELECTs only. The caller owns a READ ONLY transaction; never instantiate pg-boss. */
export async function inspectProductionGenerationMetadata(client: GenerationWorkerSchemaClient): Promise<ProductionGenerationMetadata> {
    const schemaState = await inspectGenerationWorkerSchema(client);
    const installedSchemaVersion = schemaState === "ready" ? (await inspectGenerationSchemaVersion(client)).installed : null;
    const queue = schemaState === "ready" ? await inspectGenerationQueue(client) : null;
    const { rows } = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'canvas_saas' AND table_type = 'BASE TABLE'");
    return metadataSchema.parse({ schemaState, installedSchemaVersion,
        queue: queue?.settings ? { name: "generation", policy: queue.settings.policy, retryLimit: queue.settings.retryLimit } : null,
        applicationRelations: rows.map((row) => row.table_name),
    });
}

export function evaluateProductionGenerationMetadata(metadata: ProductionGenerationMetadata, cloudMedia: boolean) {
    const data = metadataSchema.parse(metadata);
    const required = [...requiredAccountRelations(cloudMedia), "generation_task", "model_price_publication", "model_price_draft"];
    const checks = {
        schema: data.schemaState === "ready",
        version: data.installedSchemaVersion === expectedGenerationSchemaVersion(),
        queue: isGenerationQueueReady(data.queue),
        applicationRelations: required.every((name) => data.applicationRelations.includes(name)),
    };
    return { status: Object.values(checks).every(Boolean) ? "checks-passed" : "blocked", checks };
}

const externalChecks = ["actual-api-and-all-consumer-configurations", "all-consumers-compatible-and-old-consumers-exited",
    "full-application-schema-and-runtime-readiness", "published-model-price-and-approved-operating-policy",
    "inflight-unknown-and-reserved-funds", "private-storage-delivery-and-recovery", "independent-review-and-release-authorization"];

type VideoInspection = Awaited<ReturnType<typeof inspectVideoToolchainReadOnly>>;

export async function runProductionGenerationPreflight(options: ProductionGenerationTarget & {
    env: Record<string, string | undefined>;
    mode: "configuration-only" | "runtime-read-only" | "fixture" | "database-read-only";
    metadata?: ProductionGenerationMetadata;
    /** Explicit synthetic input, used only in fixture mode; never taken from env. */
    fixtureVideoResources?: VideoInspection;
    /** Test seam for the exact V1 resource inspector, not a media/probe success override. */
    inspectVideoTools?: typeof inspectVideoToolchainReadOnly;
    databaseFactory?: typeof createDatabase;
}) {
    const config = readProductionGenerationConfiguration(options.env, options);
    const videoPolicy = config.worker.worker.videoPolicy;
    const configured = { api: { image: config.api?.imageEnabled ?? false, text: config.api?.textEnabled ?? false,
        audio: config.api?.audioEnabled ?? false, video: options.env.SAAS_GENERATION_VIDEO_ENABLED === "true" },
        worker: { image: config.worker.imageEnabled, audio: config.worker.audioEnabled, video: config.worker.worker.videoEnabled ?? false } };
    const base = { component: "production-generation-preflight", target: "production", mode: options.mode,
        launchReady: false, requiredExternalChecks: videoPolicy ? [...externalChecks, "video-startup-resource-and-private-temp-check"] : externalChecks, configured };
    let videoResources: (VideoInspection & { evidenceSource: string; status: string }) | undefined;
    if (videoPolicy) {
        const identity = readVideoToolchainIdentity(options.env);
        const unavailable = (reason: string): VideoInspection => ({ ready: false, platform: process.platform, reasons: [reason] });
        let inspected: VideoInspection;
        if (!configured.worker.video) inspected = unavailable("local_video_worker_not_configured");
        else if (!identity) inspected = unavailable("tool_identity_missing_or_invalid");
        else if (options.mode === "configuration-only") inspected = unavailable("resource_check_not_requested");
        else if (options.mode === "fixture") inspected = options.fixtureVideoResources ?? unavailable("fixture_resource_evidence_missing");
        else {
            try { inspected = await (options.inspectVideoTools ?? inspectVideoToolchainReadOnly)(videoPolicy, identity); }
            catch { inspected = unavailable("tool_resource_check_unavailable"); }
        }
        inspected = productionVideoResourceInspectionSchema.parse(inspected);
        // Reuse V1's exact whole-second conversion guard even for synthetic Linux input.
        if (inspected.platform === "linux" && !linuxVideoResourceArguments({ cpuTimeMs: videoPolicy.probeCpuLimit,
            memoryMaxBytes: videoPolicy.probeMemoryMaxBytes, resourceLimiterPath: videoPolicy.resourceLimiterPath,
            resourceLimiterSha256: videoPolicy.resourceLimiterSha256 })) inspected = {
                ready: false, platform: inspected.platform, reasons: ["linux_resource_policy_not_representable"] };
        const evidenceSource = options.mode === "fixture" ? "fixture" : options.mode === "configuration-only" ? "not-run"
            : options.inspectVideoTools ? "injected-fixture" : "local-read-only";
        videoResources = { ...inspected, status: inspected.ready ? "checks-passed" : "unverified", evidenceSource };
        if (!inspected.ready) return { ...base, status: "blocked", videoResources,
            checks: { configuration: true, localVideoWorkerConfigured: configured.worker.video,
                videoReadOnlyResourcesPassed: false, startupVideoProbeVerified: false } };
    }
    let metadata = options.metadata;
    if (options.mode === "database-read-only") {
        const database = (options.databaseFactory ?? createDatabase)(config.worker.databaseUrl);
        let client: (GenerationWorkerSchemaClient & { release(): void }) | undefined;
        try {
            const connection = await database.pool.connect();
            client = { query: (sql, values) => connection.query(sql, values ? [...values] : undefined), release: () => connection.release() };
            await client.query("BEGIN TRANSACTION READ ONLY");
            metadata = await inspectProductionGenerationMetadata(client);
        } finally {
            try { if (client) await client.query("ROLLBACK"); }
            finally { client?.release(); await database.close(); }
        }
    }
    if (options.mode === "fixture" && !metadata) throw new Error("fixture 需要明确合成元数据");
    const result = options.mode === "configuration-only" || options.mode === "runtime-read-only"
        ? { status: options.mode === "runtime-read-only" ? "runtime-checks-passed" : "configuration-passed", checks: { configuration: true } }
        : evaluateProductionGenerationMetadata(metadata!, config.account.cloudMedia);
    return { ...base, ...result,
        checks: { ...result.checks, ...(videoResources ? { localVideoWorkerConfigured: configured.worker.video,
            videoReadOnlyResourcesPassed: videoResources.ready, startupVideoProbeVerified: false } : {}) },
        ...(videoResources ? { videoResources } : {}),
    };
}

export function parseProductionPreflightArguments(args: string[]) {
    let mode: "configuration-only" | "runtime-read-only" | "fixture" | "database-read-only" | undefined;
    let fixturePath: string | undefined;
    const rest: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const name = args[index]!;
        if (["--configuration-only", "--runtime-read-only", "--fixture", "--database-read-only"].includes(name)) {
            if (mode) throw new Error("必须选择唯一输入模式");
            mode = name.slice(2) as typeof mode;
            if (name === "--fixture") {
                fixturePath = args[++index];
                if (!fixturePath || fixturePath.startsWith("--")) throw new Error("fixture 缺少文件路径");
            }
        } else rest.push(name);
    }
    if (!mode) throw new Error("必须明确选择配置、运行资源只读、fixture 或数据库只读模式");
    const target = parseGenerationSchemaArguments(rest);
    if (target.apply || target.authorizeProductionSchemaInstall || target.target !== "production") throw new Error("生产预检只接受明确 production 只读目标");
    return { ...target, mode, fixturePath };
}

if (import.meta.main) {
    try {
        const options = parseProductionPreflightArguments(process.argv.slice(2));
        const fixture = options.mode === "fixture" ? productionGenerationFixtureSchema
            .parse(JSON.parse(await readFile(options.fixturePath!, "utf8"))) : undefined;
        const result = await runProductionGenerationPreflight({ ...options, env: fixture?.env ?? process.env,
            metadata: fixture?.metadata, fixtureVideoResources: fixture?.videoResources });
        console.log(JSON.stringify(result));
        if (result.status === "blocked") process.exitCode = 1;
    } catch {
        console.error("production generation preflight refused or failed; no install, migration or generation was requested");
        process.exitCode = 1;
    }
}
