import { readAccountConfig } from "../../apps/api/src/config";
import { readGenerationWorkerProcessConfig } from "../../apps/api/src/generation-worker-process";

const requireCloud = process.argv.includes("--require-cloud");
const requireImage = process.argv.includes("--require-image");
const requireWorker = requireImage || process.argv.includes("--require-worker");

function fail(message: string): never {
    console.error(`FAIL staging config: ${message}`);
    process.exit(1);
}

try {
    if (process.argv.slice(2).some((arg) => !["--require-cloud", "--require-worker", "--require-image"].includes(arg))) fail("unsupported arguments");
    const config = readAccountConfig(process.env);
    if (!config) fail("SAAS_ACCOUNTS_ENABLED must be true");

    const origin = new URL(config.SAAS_ORIGIN);
    if (origin.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(origin.hostname)) {
        fail("SAAS_ORIGIN must be a real HTTPS origin");
    }
    if (process.env.SAAS_TRUSTED_PROXY !== "true") fail("SAAS_TRUSTED_PROXY must be true");
    if (!config.storage || config.storage.provider !== "aliyun-oss") fail("private Aliyun OSS must be configured");
    if (!config.cloudMedia) fail("SAAS_MEDIA_ENABLED must be true");
    if (requireCloud && !config.cloudCanvas) fail("SAAS_CLOUD_CANVAS_ENABLED must be true for this gate");

    const workerFlag = process.env.GENERATION_WORKER_ENABLED;
    if (workerFlag !== undefined && workerFlag !== "true" && workerFlag !== "false") fail("GENERATION_WORKER_ENABLED must be true or false");
    const workerEnabled = workerFlag === "true";
    if (workerEnabled && !requireWorker) fail("GENERATION_WORKER_ENABLED is true; rerun with --require-worker so the worker gate is explicit");
    const worker = requireWorker ? readGenerationWorkerProcessConfig(process.env) : null;
    if (requireWorker && !worker) fail("GENERATION_WORKER_ENABLED must be true for the worker gate");
    if (worker && worker.worker.environment !== "staging") fail("GENERATION_WORKER_ENVIRONMENT must be staging for this preflight");
    if (requireWorker && origin.hostname.toLowerCase() === "agent.zh-api.com") fail("worker preflight refuses the production origin");
    if (requireImage && (!worker?.media || worker.media.provider !== "aliyun-oss")) fail("GENERATION_WORKER_IMAGE_ENABLED=true and private Aliyun OSS are required for the image gate");

    console.log(JSON.stringify({
        status: "ok",
        checks: {
            origin: "https",
            trustedProxy: true,
            database: "configured",
            storage: "aliyun-oss",
            cloudMedia: config.cloudMedia,
            cloudCanvas: config.cloudCanvas,
            worker: worker ? {
                enabled: true,
                environment: worker.worker.environment,
                queueConfigured: true,
                providerTimeoutMs: worker.providerTimeoutMs,
                imageEnabled: Boolean(worker.media),
            } : { enabled: false },
        },
    }));
} catch (error) {
    fail(error instanceof Error ? error.message : "invalid staging config");
}
