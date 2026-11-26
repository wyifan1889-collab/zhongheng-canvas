import { z } from "zod";
import { isAbsolute } from "node:path";
import { JOB_SCHEMA, GENERATION_QUEUE_NAME } from "@infinite-canvas/jobs";
import { INITIAL_STORAGE_QUOTA_BYTES } from "@infinite-canvas/database/media";
import { readContentSafetyConfig } from "./content-safety-config";
import { readPaymentConfig } from "./payment-config";
import { canonicalPostgresTarget } from "./generation-worker-config";
import type { ApprovedConsumerCheckOptions } from "./generation-approved-consumers";

const port = z.coerce.number().int().min(1).max(65535);
const wait = z.coerce.number().int().positive().refine(Number.isSafeInteger);
const required = z.string().min(1);
const bytes = z.coerce.number().int().positive().refine(Number.isSafeInteger);
const settings = z.object({
    SAAS_DATABASE_URL: z.url().refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
    SAAS_TRUSTED_PROXY: z.enum(["true", "false"]).default("false"),
    SAAS_ORIGIN: z.url().refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
            (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
    }),
    SAAS_AUTH_SECRET: z.string().min(32),
    SMTP_HOST: required, SMTP_PORT: port, SMTP_SECURE: z.enum(["true", "false"]),
    SMTP_USER: required, SMTP_PASSWORD: required, SMTP_FROM: z.email(),
    // Optional server-owned bootstrap identity. It only promotes this verified
    // email to the admin role; it never accepts a role from the browser.
    SAAS_ADMIN_EMAIL: z.email().optional(),
    TURNSTILE_SECRET_KEY: required, TURNSTILE_SITE_KEY: required,
    // Deliberately explicit: approved example values do not implicitly configure a runtime.
    CAPTCHA_TIMEOUT_MS: wait, SMTP_CONNECTION_TIMEOUT_MS: wait, SMTP_SOCKET_TIMEOUT_MS: wait,
});
const smtpSettings = settings.pick({
    SAAS_ORIGIN: true,
    SMTP_HOST: true, SMTP_PORT: true, SMTP_SECURE: true, SMTP_USER: true, SMTP_PASSWORD: true, SMTP_FROM: true,
    SMTP_CONNECTION_TIMEOUT_MS: true, SMTP_SOCKET_TIMEOUT_MS: true,
});

const storageProvider = z.enum(["aliyun-oss", "server-disk"]);

export type MediaRuntimeConfig = {
    provider: "aliyun-oss" | "server-disk";
    quotaBytes: number;
    maxBytes: { image: number; video: number; audio: number };
    rootDirectory?: string;
    region?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
    bucket?: string;
    endpoint?: string;
};

/** Independent current release metadata; none of the expected bindings comes from the approval file. */
export function readVideoConsumerApprovalOptions(env: Record<string, string | undefined>, generation: {
    queueConnectionString: string; imageEnabled: boolean; textEnabled: boolean; audioEnabled: boolean; videoEnabled?: boolean;
} | null, storage: MediaRuntimeConfig | null): ApprovedConsumerCheckOptions | null {
    if (!generation?.videoEnabled || !storage) return null;
    const hash = z.string().regex(/^[a-f0-9]{64}$/);
    const parsed = z.object({
        GENERATION_VIDEO_CONSUMER_APPROVAL_PATH: z.string().refine(isAbsolute), GENERATION_VIDEO_CONSUMER_APPROVAL_SHA256: hash,
        GENERATION_VIDEO_CANDIDATE_REVISION: z.string().regex(/^[a-f0-9]{40}$/), GENERATION_VIDEO_IMAGE_ID: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        GENERATION_VIDEO_CONFIG_PLAN_SHA256: hash, GENERATION_VIDEO_CONFIG_READY_SHA256: hash,
    }).safeParse(env);
    if (!parsed.success) return null;
    const value = parsed.data;
    const storageBinding = storage.provider === "aliyun-oss" && storage.region && storage.bucket
        ? { provider: "aliyun-oss" as const, region: storage.region, bucket: storage.bucket, endpoint: storage.endpoint ?? null }
        : storage.provider === "server-disk" && storage.rootDirectory && isAbsolute(storage.rootDirectory)
            ? { provider: "server-disk" as const, rootDirectory: storage.rootDirectory } : null;
    if (!storageBinding) return null;
    try {
        return { path: value.GENERATION_VIDEO_CONSUMER_APPROVAL_PATH, sha256: value.GENERATION_VIDEO_CONSUMER_APPROVAL_SHA256, expected: {
            candidate: value.GENERATION_VIDEO_CANDIDATE_REVISION, image: value.GENERATION_VIDEO_IMAGE_ID,
            databaseTarget: canonicalPostgresTarget(generation.queueConnectionString, "GENERATION_WORKER_QUEUE_URL"),
            queueSchema: JOB_SCHEMA, queueName: GENERATION_QUEUE_NAME, payloadVersion: 1, videoProtocol: "yunfei-grok-video-v1",
            capabilities: [...(generation.textEnabled ? ["text" as const] : []), ...(generation.imageEnabled ? ["image" as const] : []),
                ...(generation.audioEnabled ? ["audio" as const] : []), "video"], storage: storageBinding,
            configPlanSha256: value.GENERATION_VIDEO_CONFIG_PLAN_SHA256, readyReceiptSha256: value.GENERATION_VIDEO_CONFIG_READY_SHA256,
        } };
    } catch { return null; }
}

export function readMediaConfig(env: Record<string, string | undefined>): MediaRuntimeConfig | null {
    const provider = env.STORAGE_PROVIDER;
    if (provider === undefined || provider === "") return null;
    const parsed = z.object({
        STORAGE_PROVIDER: storageProvider,
        STORAGE_QUOTA_BYTES: bytes.default(INITIAL_STORAGE_QUOTA_BYTES),
        STORAGE_IMAGE_MAX_BYTES: bytes.default(10 * 1024 * 1024),
        STORAGE_VIDEO_MAX_BYTES: bytes.default(100 * 1024 * 1024),
        STORAGE_AUDIO_MAX_BYTES: bytes.default(100 * 1024 * 1024),
        SAAS_STORAGE_ROOT: z.string().min(1).optional(),
        ALIYUN_OSS_REGION: z.string().min(1).optional(),
        ALIYUN_OSS_ACCESS_KEY_ID: z.string().min(1).optional(),
        ALIYUN_OSS_ACCESS_KEY_SECRET: z.string().min(1).optional(),
        ALIYUN_OSS_BUCKET: z.string().min(1).optional(),
        ALIYUN_OSS_ENDPOINT: z.string().url().optional(),
    }).safeParse(env);
    if (!parsed.success) throw new Error(`对象存储配置无效：${[...new Set(parsed.error.issues.map((issue) => issue.path[0]))].join("、")}`);
    const value = parsed.data;
    if (value.STORAGE_PROVIDER === "aliyun-oss" && (!value.ALIYUN_OSS_REGION || !value.ALIYUN_OSS_ACCESS_KEY_ID || !value.ALIYUN_OSS_ACCESS_KEY_SECRET || !value.ALIYUN_OSS_BUCKET)) {
        throw new Error("对象存储配置无效：阿里云 OSS 配置不完整");
    }
    if (value.STORAGE_PROVIDER === "server-disk" && !value.SAAS_STORAGE_ROOT) {
        throw new Error("对象存储配置无效：缺少 SAAS_STORAGE_ROOT");
    }
    return {
        provider: value.STORAGE_PROVIDER,
        quotaBytes: value.STORAGE_QUOTA_BYTES,
        maxBytes: { image: value.STORAGE_IMAGE_MAX_BYTES, video: value.STORAGE_VIDEO_MAX_BYTES, audio: value.STORAGE_AUDIO_MAX_BYTES },
        ...(value.SAAS_STORAGE_ROOT ? { rootDirectory: value.SAAS_STORAGE_ROOT } : {}),
        ...(value.ALIYUN_OSS_REGION ? { region: value.ALIYUN_OSS_REGION } : {}),
        ...(value.ALIYUN_OSS_ACCESS_KEY_ID ? { accessKeyId: value.ALIYUN_OSS_ACCESS_KEY_ID } : {}),
        ...(value.ALIYUN_OSS_ACCESS_KEY_SECRET ? { accessKeySecret: value.ALIYUN_OSS_ACCESS_KEY_SECRET } : {}),
        ...(value.ALIYUN_OSS_BUCKET ? { bucket: value.ALIYUN_OSS_BUCKET } : {}),
        ...(value.ALIYUN_OSS_ENDPOINT ? { endpoint: value.ALIYUN_OSS_ENDPOINT } : {}),
    };
}

function parseSettings<T extends z.ZodTypeAny>(schema: T, env: Record<string, string | undefined>, label: string): z.infer<T> {
    const result = schema.safeParse(env);
    if (!result.success) {
        // Error messages identify missing/invalid field names only, never environment values.
        throw new Error(`${label}配置无效：${[...new Set(result.error.issues.map((issue) => issue.path[0]))].join("、")}`);
    }
    return result.data;
}

export function readAccountConfig(env: Record<string, string | undefined>) {
    if (env.SAAS_ACCOUNTS_ENABLED === undefined || env.SAAS_ACCOUNTS_ENABLED === "false") return null;
    if (env.SAAS_ACCOUNTS_ENABLED !== "true") throw new Error("SAAS_ACCOUNTS_ENABLED 只能是 true 或 false");
    const account = parseSettings(settings, env, "账户服务");
    const contentSafety = readContentSafetyConfig(env);
    const payments = readPaymentConfig(env);
    const originUrl = new URL(account.SAAS_ORIGIN);
    if (payments.enabled && (originUrl.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(originUrl.hostname))) {
        throw new Error("开启支付前必须使用真实 HTTPS 域名");
    }
    if (account.SAAS_TRUSTED_PROXY === "true" &&
        (originUrl.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(originUrl.hostname))) {
        throw new Error("启用可信反代前必须使用真实 HTTPS 域名");
    }
    const cloudCanvas = env.SAAS_CLOUD_CANVAS_ENABLED === "true";
    if (env.SAAS_CLOUD_CANVAS_ENABLED !== undefined && env.SAAS_CLOUD_CANVAS_ENABLED !== "true" && env.SAAS_CLOUD_CANVAS_ENABLED !== "false") {
        throw new Error("SAAS_CLOUD_CANVAS_ENABLED 只能是 true 或 false");
    }
    const cloudMedia = env.SAAS_MEDIA_ENABLED === "true";
    if (env.SAAS_MEDIA_ENABLED !== undefined && env.SAAS_MEDIA_ENABLED !== "true" && env.SAAS_MEDIA_ENABLED !== "false") {
        throw new Error("SAAS_MEDIA_ENABLED 只能是 true 或 false");
    }
    const storage = readMediaConfig(env);
    if (cloudCanvas && !storage) throw new Error("开启云画布前必须配置对象存储");
    if (cloudCanvas && storage?.provider !== "aliyun-oss") {
        throw new Error("开启云画布前必须使用阿里云 OSS 对象存储");
    }
    if (cloudCanvas) {
        if (originUrl.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(originUrl.hostname)) {
            throw new Error("开启云画布前必须使用真实 HTTPS 域名");
        }
    }
    if (cloudMedia && !storage) throw new Error("开启云媒体前必须配置对象存储");
    return { ...account, cloudCanvas, cloudMedia, storage, contentSafety, payments, adminEmail: account.SAAS_ADMIN_EMAIL?.toLowerCase() };
}

/** SMTP-only preflight input; it does not enable or connect the account service. */
export function readSmtpConfig(env: Record<string, string | undefined>) {
    return parseSettings(smtpSettings, env, "SMTP");
}
