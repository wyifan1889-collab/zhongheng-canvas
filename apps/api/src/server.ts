import { createApp } from "./app";
import { readAccountConfig, readVideoConsumerApprovalOptions } from "./config";
import { createAccountApi } from "./accounts";
import { createDatabase } from "@infinite-canvas/database";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createSmtpMailer } from "@infinite-canvas/auth/mail";
import { createTurnstileVerifier } from "@infinite-canvas/auth/captcha";
import { createStorageAdapter, objectKey } from "@infinite-canvas/storage";
import { resolveTrustedPeerIp, restoreTrustedHttpsOrigin } from "./trusted-proxy";
import { checkAccountDatabaseReadiness, checkGenerationDatabaseReadiness, checkGenerationRateDatabaseReadiness, checkPaymentDatabaseReadiness } from "./readiness";
import { readGenerationApiConfig, startGenerationApiRuntime, type GenerationApiRuntime } from "./generation-api-runtime";
import { startOfficialPriceRuntime } from "./official-price-runtime";
import { createInspirationStore, readInspirationFile } from "./inspiration-store";
import { createVideoApiReadiness } from "./generation-video-api-readiness";
import { readVideoToolchainIdentity } from "./generation-video-probe";
import { createApprovedConsumerCheck } from "./generation-approved-consumers";

const config = readAccountConfig(process.env);
const inspirationFile = readInspirationFile(process.env);
const inspiration = inspirationFile ? createInspirationStore(inspirationFile) : undefined;
const generationConfig = readGenerationApiConfig(process.env, config);
const videoConsumerApproval = readVideoConsumerApprovalOptions(process.env, generationConfig, config?.storage ?? null);
const database = config ? createDatabase(config.SAAS_DATABASE_URL) : null;
let generation: GenerationApiRuntime | null = null;
let officialPrices: ReturnType<typeof startOfficialPriceRuntime> | null = null;
database?.pool.on("error", () => console.error(JSON.stringify({ component: "database", code: "connection_failed" })));
try {
    if (database && !await checkGenerationRateDatabaseReadiness(database.pool)) {
        throw new Error("生成准入政策数据库尚未就绪；请先核对正式政策迁移与版本约束");
    }
    if (config?.payments.enabled && (!database || !await checkPaymentDatabaseReadiness(database.pool))) {
        throw new Error("支付数据库尚未就绪；请先核对正式支付迁移与资金约束");
    }
    const storage = config && (config.cloudCanvas || config.cloudMedia) && config.storage ? createStorageAdapter(config.storage.provider === "aliyun-oss" ? {
        provider: "aliyun-oss", region: config.storage.region!, accessKeyId: config.storage.accessKeyId!, accessKeySecret: config.storage.accessKeySecret!, bucket: config.storage.bucket!, endpoint: config.storage.endpoint,
    } : { provider: "server-disk", rootDirectory: config.storage.rootDirectory! }) : null;
    generation = await startGenerationApiRuntime(generationConfig, {
        checkDatabaseReady: async () => !!database && await checkGenerationDatabaseReadiness(database.pool, generationConfig?.audioEnabled === true),
        ...(database && generationConfig?.videoEnabled && generationConfig.videoPolicy ? {
            checkVideoReady: createVideoApiReadiness({ database: database.pool, policy: generationConfig.videoPolicy,
                toolchainIdentity: readVideoToolchainIdentity(process.env),
                compatibleConsumers: videoConsumerApproval ? createApprovedConsumerCheck(videoConsumerApproval) : undefined,
            }),
        } : {}),
    });
    const accounts = config && database ? createAccountApi({
        database: database.db, origin: config.SAAS_ORIGIN,
        inspiration,
        contentSafety: config.contentSafety,
        payments: config.payments,
        cloudCanvas: config.cloudCanvas === true && !!storage,
        adminEmail: config.adminEmail,
        auth: {
            secret: config.SAAS_AUTH_SECRET,
            ...createSmtpMailer({
                host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE === "true",
                user: config.SMTP_USER, password: config.SMTP_PASSWORD, from: config.SMTP_FROM,
                origin: config.SAAS_ORIGIN, connectionTimeoutMs: config.SMTP_CONNECTION_TIMEOUT_MS,
                socketTimeoutMs: config.SMTP_SOCKET_TIMEOUT_MS,
            }),
        },
        rates: createRateStore(database.pool, config.SAAS_AUTH_SECRET),
        verifyHuman: createTurnstileVerifier({
            secret: config.TURNSTILE_SECRET_KEY, hostname: new URL(config.SAAS_ORIGIN).hostname,
            timeoutMs: config.CAPTCHA_TIMEOUT_MS,
        }),
        ...(storage && config.storage && config.cloudMedia ? { media: { storage, quotaBytes: config.storage.quotaBytes, maxBytes: config.storage.maxBytes } } : {}),
        ...(generation ? { generation } : {}),
        onFault: (event) => console.error(JSON.stringify(event)),
    }) : undefined;
    const app = createApp(
        accounts,
        config?.TURNSTILE_SITE_KEY,
        config?.cloudCanvas === true && !!storage,
        config?.cloudMedia === true && !!storage,
        async () => {
            const checks: Record<string, "ok" | "failed" | "disabled"> = { api: "ok", database: database ? "ok" : "disabled", storage: storage ? "ok" : "disabled", generation: generation ? "ok" : "disabled", payments: config?.payments.enabled ? "ok" : "disabled", inspiration: inspiration ? "ok" : "disabled" };
            if (inspiration) {
                try { await inspiration.read(); }
                catch { checks.inspiration = "failed"; }
            }
            if (database) {
                if (!await checkAccountDatabaseReadiness(database.pool, config?.cloudMedia === true, config?.contentSafety)) checks.database = "failed";
                if (!await checkGenerationRateDatabaseReadiness(database.pool)) checks.database = "failed";
                if (config?.payments.enabled && !await checkPaymentDatabaseReadiness(database.pool)) checks.payments = "failed";
            }
            if (storage) {
                try { await storage.get(objectKey("__healthcheck__/storage")); }
                catch { checks.storage = "failed"; }
            }
            const storageRequired = config?.cloudCanvas === true || config?.cloudMedia === true;
            if (generation && !await generation.checkReady()) checks.generation = "failed";
            const ready = checks.database !== "failed" && checks.generation !== "failed" && checks.payments !== "failed" && checks.inspiration !== "failed" && (!storageRequired || checks.storage === "ok");
            return { ready, checks };
        },
        { image: generation?.imageEnabled === true, text: generation?.textEnabled === true, audio: generation?.audioEnabled === true, video: generation?.videoEnabled === true },
        inspiration,
    );

    const server = Bun.serve({
        hostname: process.env.HOST || "127.0.0.1",
        port: Number(process.env.PORT || 4000),
        // Never accept x-forwarded-for / cf-connecting-ip from an arbitrary HTTP caller.
        fetch: (request, server) => app(
            restoreTrustedHttpsOrigin(request, config?.SAAS_TRUSTED_PROXY === "true"),
            resolveTrustedPeerIp(request, server.requestIP(request)?.address, config?.SAAS_TRUSTED_PROXY === "true"),
        ),
    });

    if (database) officialPrices = startOfficialPriceRuntime(database.db, {
        onFault: () => console.error(JSON.stringify({ component: "official_prices", code: "reference_refresh_failed" })),
    });
    let stopping: Promise<void> | undefined;
    function stop() {
        return stopping ??= (async () => {
            try { await server.stop(false); }
            finally {
                try { await officialPrices?.stop(); await generation?.stop(); }
                finally { await database?.close(); }
            }
        })();
    }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    console.log(`Infinite Canvas API listening at http://${server.hostname}:${server.port}`);
} catch (error) {
    try { await officialPrices?.stop(); await generation?.stop(); }
    finally { await database?.close(); }
    throw error;
}
