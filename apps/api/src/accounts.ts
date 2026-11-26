import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { createAuth, getPrincipal, type AuthOptions } from "@infinite-canvas/auth";
import type { Database } from "@infinite-canvas/database";
import { createDraftRepository } from "@infinite-canvas/database/drafts";
import { createCanvasSharingRepository } from "@infinite-canvas/database/canvas-sharing";
import { createMediaRepository, type MediaKind, type MediaRecord } from "@infinite-canvas/database/media";
import { listAdminModels, listAdminProviders, listPublicModels } from "@infinite-canvas/database/models";
import { listNodeModelGroups, saveNodeModelGroups, saveNodeModel, NodeModelConfigurationError } from "@infinite-canvas/database/node-model-groups";
import { readModelMappingDraft, saveModelMappingDraft, ModelMappingDraftError } from "@infinite-canvas/database/model-mapping-drafts";
import { parseMappingDraftWrite } from "@infinite-canvas/shared";
import { previewMappingPublication, publishMappingConfiguration, readPublishedMappingCatalog, MappingPublicationError } from "@infinite-canvas/database/model-mapping-publications";
import { executableMappingCatalog } from "./model-mapping-catalog";
import { parseMappingPublicationWrite } from "@infinite-canvas/shared";
import { CatalogDeletionError, deleteCatalogModel, deleteCatalogProvider } from "@infinite-canvas/database/catalog-deletion";
import { loadProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { prepareProviderDiscovery, recordProviderDiscovery, saveDiscoveredProvider, listDiscoveredProviderModels, ProviderDiscoveryError } from "@infinite-canvas/database/provider-discovery";
import { listAdminModelPricing, listPublicModelPricing } from "@infinite-canvas/database/pricing";
import { createModelPriceDraft, listModelPriceDrafts } from "@infinite-canvas/database/model-price-drafts";
import { getModelPricePublicationPreview, publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { listAdminOfficialPriceCatalog, listPublicOfficialPriceReferences, saveOfficialPriceMapping } from "@infinite-canvas/database/official-price-references";
import { parseModelPriceDraftWrite, parseModelPricePublishWrite, parseOfficialPriceMappingWrite, parseNodeModelGroupsWrite, normalizeCreditAmount, addCreditAmounts, compareCreditAmounts } from "@infinite-canvas/shared";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { auditEvent, modelCatalog, modelPricePublication, modelPricing, modelProvider, user as userTable, wallet as walletTable, walletLedger } from "@infinite-canvas/database/schema";
import { assertSafetyActor, type SafetyActor, type SafetyTx } from "../../../packages/database/src/account-moderation";
import { computeObjectEtag, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import type { RateStore, RateRule } from "@infinite-canvas/database/rate-limit";
import { accountPolicy, type AccountPolicy } from "./policy";
import { HttpError, json, readBytes, readJson } from "./http";
import { InspirationConflict, parseInspirationWrite, type InspirationStore } from "./inspiration-store";
import { createProviderGateway, isBlockedProviderHostname, type ProviderResolver } from "./provider-gateway";
import { GenerationContractError, parseGenerationIdempotencyKey, parseGenerationIntent, parseGenerationSubmission } from "./generation-contract";
import { GenerationQueryError, getGenerationTaskForOwner, getGenerationTaskByKeyForOwner, getGenerationTasksForOwner } from "./generation-query";
import { getGenerationHistoryForOwner, renameGenerationHistoryForOwner } from "./generation-history";
import { getAdminGenerationTaskDetail } from "./admin-generation-query";
import { quoteReserveAndEnqueueConfirmedImageTask, type GenerationQueueSender } from "./generation-dispatch";
import { listExecutableImageModels, resolveExecutableImageQuote } from "./generation-image-policy";
import { publicImageQuote } from "./generation-image-quote";
import { estimateGeminiImagePrice, type GeminiImagePriceTrialInput } from "../../../packages/shared/src/gemini-image-price-trial";
import { GEMINI_IMAGE_PROTOCOL, parseGeminiImageSpecification } from "../../../packages/shared/src/generation-gemini-image";
import { listExecutableTextModels, parseTextGenerationIntent, resolveExecutableTextQuote } from "./generation-text-policy";
import { quoteReserveAndEnqueueConfirmedTextTask } from "./generation-text-dispatch";
import { listExecutableAudioModels, resolveExecutableAudioQuote, publicAudioQuote } from "./generation-audio-policy";
import { quoteReserveAndEnqueueConfirmedAudioTask } from "./generation-audio-dispatch";
import { listExecutableVideoModels, resolveExecutableVideoQuote, publicVideoQuote } from "./generation-video-policy";
import { quoteReserveAndEnqueueConfirmedVideoTask } from "./generation-video-dispatch";
import { inspectGenerationVideoReference } from "./generation-video-probe";
import type { VideoRuntimePolicy } from "./generation-video-config";
import type { GenerationSubmissionSafety } from "./generation-admission";
import { handleContentSafetySettings } from "./content-safety-settings-handler";
import { GenerationTaskError } from "@infinite-canvas/database/generation-tasks";
import { WalletOperationError } from "@infinite-canvas/database/wallet";
import { handleAccountModeration } from "./account-moderation-handler";
import { handleAbuseReport } from "./abuse-report-handler";
import { rethrowModerationError, type SafetyRouteContext } from "./account-moderation-contract";
import { readContentSafetyConfig, type ContentSafetyConfig } from "./content-safety-config";
import { createPaymentPlatform } from "./payment-platform";
import type { PaymentRuntimeConfig } from "./payment-config";

type Options = {
    database: Database;
    origin: string;
    /** Optional server-owned bootstrap identity. Never read from request input. */
    adminEmail?: string;
    auth: Omit<AuthOptions, "database" | "baseURL">;
    rates: RateStore;
    policy?: AccountPolicy;
    contentSafety?: ContentSafetyConfig;
    payments?: PaymentRuntimeConfig;
    /** Deterministic transport injection; production uses the bounded payment client. */
    paymentFetcher?: typeof fetch;
    inspiration?: InspirationStore;
    media?: {
        storage: ObjectStorage;
        quotaBytes: number;
        maxBytes: Record<MediaKind, number>;
    };
    /** Public cloud-draft gate. Production must pass the validated runtime flag. */
    cloudCanvas?: boolean;
    // Required gate; production supplies the checked Turnstile-backed auth integration.
    verifyHuman: (request: Request) => Promise<boolean>;
    /** Optional resolver injection for deterministic provider connection tests. */
    providerResolver?: ProviderResolver;
    /** Explicitly injected generation seam; absent means all generation routes stay closed. */
    generation?: {
        enabled: boolean;
        imageEnabled?: boolean;
        /** Only isolated acceptance fixtures enable this; production release needs separate verification. */
        geminiImageEnabled?: boolean;
        textEnabled?: boolean;
        audioEnabled?: boolean;
        videoEnabled?: boolean;
        videoPolicy?: VideoRuntimePolicy;
        queue: GenerationQueueSender;
    };
    onFault: (event: {
        requestId: string; component: "accounts";
        code: "mail_unavailable" | "auth_unavailable" | "service_unavailable" | "content_safety_record_unavailable";
    }) => void;
};

// Better Auth treats email identifiers case-insensitively for normal sign-up,
// but older imports may have left the stored value with uppercase characters.
// Resolve the canonical stored value before handing the request to the auth
// library so those accounts can still log in, verify, reset, or resend mail.
const emailAuthPaths = new Set([
    "/sign-up/email",
    "/sign-in/email",
    "/send-verification-email",
    "/request-password-reset",
    "/email-otp/send-verification-otp",
    "/email-otp/verify-email",
]);

const positive = z.number().int().positive().refine(Number.isSafeInteger);
const rateRule = z.strictObject({ points: positive, duration: positive });
const policySchema = z.strictObject({
    login: rateRule, signup: rateRule, mail: rateRule, verificationLink: rateRule, resetMail: rateRule, otpVerify: rateRule, resetSubmit: rateRule,
    read: rateRule, save: rateRule,
    documentBytes: positive, pageSize: positive, titleLength: positive,
});
const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });
const mediaResolveSchema = z.strictObject({ ids: z.array(z.uuid().transform((value) => value.toLowerCase())).min(1).max(100) });
const shareLinkSchema = z.strictObject({ role: z.enum(["viewer", "editor"]), reset: z.boolean().optional() });
const memberWriteSchema = z.strictObject({ userId: z.string().min(1), role: z.enum(["viewer", "editor"]) });
const objectDocument = z.record(z.string(), z.json());
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;
const remoteUrlPattern = /^https?:\/\//i;
const cloudMediaIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const compactId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/);
const endpoint = z.string().trim().url().refine((value) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && !isBlockedProviderHostname(parsed.hostname);
    } catch { return false; }
}, { message: "provider endpoint must be an https URL without credentials, query or fragment" });
const providerWriteSchema = z.strictObject({
    displayName: z.string().trim().min(1).max(120),
    adapter: z.enum(["openai-compatible", "sub2api"]),
    endpoint,
    enabled: z.boolean(),
    // Empty/omitted values preserve an existing credential; creating a provider requires one.
    apiKey: z.string().max(4096).optional(),
    revision: z.number().int().min(0).max(2_147_483_646),
    discoveryReceiptId: z.uuid().optional(),
});
const providerDiscoverSchema = providerWriteSchema.omit({ discoveryReceiptId: true });
const modelWriteSchema = z.strictObject({
    providerId: compactId,
    providerModel: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(120),
    capability: z.enum(["text", "image", "video", "audio"]),
    enabled: z.boolean(),
    groupId: z.uuid().transform(value => value.toLowerCase()).nullable(),
    revision: z.number().int().min(0).max(2_147_483_646),
});
const modelPricingWriteSchema = z.strictObject({
    modelId: compactId,
    billingUnit: z.enum(["request", "input_token", "output_token", "second", "megapixel"]),
    creditsPerUnit: positive,
    effectiveFrom: z.iso.datetime().transform((value) => new Date(value)).optional(),
    enabled: z.boolean().default(true),
});
const balanceAdjustmentSchema = z.strictObject({
    amount: z.string().transform((value, context) => {
        const amount = normalizeCreditAmount(value);
        if (amount === null || amount === "0") {
            context.addIssue({ code: "custom", message: "请输入非零十进制积分金额" });
            return z.NEVER;
        }
        return amount;
    }),
    reason: z.string().trim().min(1).max(500),
});

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mediaKind(contentType: string): MediaKind | null {
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
    if (contentType.startsWith("audio/")) return "audio";
    return null;
}

function mediaView(media: { id: string; kind: MediaKind; contentType: string; sizeBytes: number; createdAt: string }, canvasId?: string) {
    return { id: media.id, kind: media.kind, contentType: media.contentType, sizeBytes: media.sizeBytes, createdAt: media.createdAt, url: `/api/v1/media/${media.id}${canvasId ? `?canvasId=${canvasId}` : ""}` };
}

/**
 * Server-side second gate for the JSON-only draft boundary. The browser performs the
 * same preflight, but the API must remain safe if a caller bypasses that UI.
 * Text prompt URLs remain ordinary text; only known media/task shapes are refused.
 */
export function containsUnresolvedMedia(value: unknown, ownedCloudMediaIds: ReadonlySet<string> = new Set()): boolean {
    function walk(current: unknown): boolean {
        if (typeof current === "string") {
            return /^((blob|data):|file:[\\/])/i.test(current) || storageKeyPattern.test(current);
        }
        if (Array.isArray(current)) return current.some(walk);
        if (!record(current)) return false;
        return Object.entries(current).some(([key, child]) => {
            if (key === "cloudMediaId" && typeof child === "string" && child.length > 0) return !ownedCloudMediaIds.has(child.toLowerCase());
            if ((key === "storageKey" || key === "videoTaskId") && typeof child === "string" && child.length > 0) return true;
            return walk(child);
        });
    }
    if (walk(value)) return true;
    if (!record(value)) return false;
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    for (const node of nodes) {
        if (!record(node) || !record(node.metadata)) continue;
        const metadata = node.metadata;
        const nodeType = typeof node.type === "string" ? node.type : "";
        if (["image", "video", "audio"].includes(nodeType) && typeof metadata.content === "string" && remoteUrlPattern.test(metadata.content)) return true;
        if (Array.isArray(metadata.images) && metadata.images.some((image) => record(image) && typeof image.content === "string" && remoteUrlPattern.test(image.content))) return true;
        if (Array.isArray(metadata.references) && metadata.references.some((reference) => typeof reference === "string" && remoteUrlPattern.test(reference))) return true;
        // Unknown/plugin nodes may expose a media URL through a conventional field.
        // Built-in text prompts are excluded so ordinary prompt links remain text.
        if (nodeType !== "text" && ["url", "src", "dataUrl"].some((key) => typeof metadata[key] === "string" && remoteUrlPattern.test(metadata[key] as string))) return true;
    }
    const sessions = Array.isArray(value.chatSessions) ? value.chatSessions : [];
    return sessions.some((session) => record(session) && Array.isArray(session.messages) && session.messages.some((message) => record(message) && Array.isArray(message.references) && message.references.some((reference) => record(reference) && typeof reference.dataUrl === "string" && remoteUrlPattern.test(reference.dataUrl))));
}

function collectCloudMediaIds(value: unknown): string[] {
    const ids: string[] = [];
    function walk(current: unknown) {
        if (Array.isArray(current)) { current.forEach(walk); return; }
        if (!record(current)) return;
        for (const [key, child] of Object.entries(current)) {
            if (key === "cloudMediaId" && typeof child === "string" && child.length > 0) ids.push(child.toLowerCase());
            else walk(child);
        }
    }
    walk(value);
    return [...new Set(ids)];
}

/** Nothing is enabled by importing this module. Peer IP must come from the server socket, never headers. */
export function createAccountApi(options: Options) {
    const origin = new URL(options.origin).origin;
    const policy = policySchema.parse(options.policy ?? accountPolicy);
    const contentSafety = options.contentSafety ?? readContentSafetyConfig({});
    // Better Auth awaits but swallows some mail callback failures. Track only the current request,
    // so a failed delivery never turns into a misleading success or leaks into another request.
    const mailContext = new AsyncLocalStorage<{ failed: boolean }>();
    const trackMail = (send: AuthOptions["sendVerificationEmail"]): typeof send => async (mail) => {
        try { await send(mail); }
        catch {
            const state = mailContext.getStore();
            if (state) state.failed = true;
            throw new Error("mail-service-unavailable");
        }
    };
    const trackVerificationCode = (send: AuthOptions["sendVerificationCode"]): typeof send => send ? async (mail) => {
        try { await send(mail); }
        catch {
            const state = mailContext.getStore();
            if (state) state.failed = true;
            throw new Error("mail-service-unavailable");
        }
    } : undefined;
    const auth = createAuth({
        ...options.auth, database: options.database, baseURL: origin,
        sendVerificationEmail: trackMail(options.auth.sendVerificationEmail),
        sendVerificationCode: trackVerificationCode(options.auth.sendVerificationCode),
        sendResetPassword: trackMail(options.auth.sendResetPassword),
    });
    const drafts = createDraftRepository(options.database);
    const wallet = createWalletRepository(options.database);
    const providerGateway = createProviderGateway(undefined, options.providerResolver);
    const media = options.media ? { ...options.media, repository: createMediaRepository(options.database) } : null;
    let paymentPlatform: ReturnType<typeof createPaymentPlatform> | undefined;
    const payments = () => paymentPlatform ??= createPaymentPlatform({ database: options.database, secret: options.auth.secret,
        origin, config: options.payments ?? { enabled: false }, fetcher: options.paymentFetcher });
    const title = z.string().trim().min(1).refine((value) => [...value].length <= policy.titleLength);
    const historyTitle = title.refine(value => !/[\u0000-\u001f\u007f]/.test(value));
    const draftSchema = z.strictObject({ title, documentVersion: z.literal(1), document: objectDocument });
    const createSchema = draftSchema.extend({ creationId: z.uuid().transform((value) => value.toLowerCase()) });
    const saveSchema = draftSchema.extend({ expectedRevision: positive });
    const signupLocks = new Map<string, Promise<void>>();
    async function withSignupLock<T>(email: string, operation: () => Promise<T>): Promise<T> {
        const previous = signupLocks.get(email) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        signupLocks.set(email, current);
        await previous;
        try { return await operation(); }
        finally {
            release();
            if (signupLocks.get(email) === current) signupLocks.delete(email);
        }
    }
    async function existingSignupError(email: string): Promise<HttpError | null> {
        const [existing] = await options.database.select({ emailVerified: userTable.emailVerified, disabled: userTable.disabled })
            .from(userTable)
            .where(sql`lower(${userTable.email}) = ${email.toLowerCase()}`)
            .limit(1);
        if (!existing) return null;
        if (existing.disabled) return new HttpError(409, "account_unavailable", "该邮箱已注册但当前不可用，请联系管理员。");
        if (existing.emailVerified) return new HttpError(409, "email_already_registered", "该邮箱已经注册，请直接登录；如果忘记密码，请使用“忘记密码”。");
        return new HttpError(409, "email_pending_verification", "该邮箱已提交注册但尚未验证，不能重复注册；请使用“未收到验证邮件”重新发送验证码。");
    }
    const authBodies: Record<string, z.ZodType> = {
        "/sign-up/email": z.strictObject({ name: z.string().trim().min(1), email: z.email(), password: z.string().min(1) }),
        "/sign-in/email": z.strictObject({ email: z.email(), password: z.string().min(1) }),
        "/send-verification-email": z.strictObject({ email: z.email() }),
        "/request-password-reset": z.strictObject({ email: z.email() }),
        "/email-otp/send-verification-otp": z.strictObject({ email: z.email(), type: z.literal("email-verification") }),
        "/email-otp/verify-email": z.strictObject({ email: z.email(), otp: z.string().regex(/^\d{6}$/) }),
        "/reset-password": z.strictObject({ token: z.string().min(1), newPassword: z.string().min(1) }),
        "/sign-out": z.strictObject({}),
        "/revoke-sessions": z.strictObject({}),
    };

    async function consume(bucket: string, identity: string, rule: RateRule) {
        const decision = await options.rates.consume(bucket, identity, rule);
        if (!decision.allowed) throw new HttpError(429, "rate_limited", "操作过于频繁，请稍后再试", decision.retryAfter);
    }
    function parse<T>(schema: z.ZodType<T>, input: unknown): T {
        const result = schema.safeParse(input);
        if (!result.success) throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
        return result.data;
    }
    function mapAuthFailure(authPath: string, code: string | undefined, status: number): HttpError {
        switch (code?.toUpperCase()) {
            case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
                return new HttpError(409, "email_already_registered", "该邮箱已经注册，请直接登录；如果忘记密码，请使用“忘记密码”。");
            case "INVALID_EMAIL_OR_PASSWORD":
            case "USER_EMAIL_NOT_FOUND":
                return new HttpError(401, "invalid_credentials", "邮箱或密码错误；如果刚注册，请先完成邮箱验证码验证。");
            case "EMAIL_NOT_VERIFIED":
                return new HttpError(403, "email_not_verified", "该邮箱尚未验证，请先完成邮箱验证码；没有收到验证码可使用“未收到验证邮件”。");
            case "INVALID_PASSWORD":
                return new HttpError(400, "invalid_password", "密码长度需为 8–128 个字符。");
            case "INVALID_EMAIL":
                return new HttpError(400, "invalid_input", "请输入有效的邮箱地址。");
            case "INVALID_OTP":
                return new HttpError(400, "invalid_verification_code", "验证码错误，请检查邮件中的 6 位验证码。");
            case "OTP_EXPIRED":
                return new HttpError(400, "verification_code_expired", "验证码已过期，请重新发送验证码。");
            case "TOO_MANY_ATTEMPTS":
                return new HttpError(429, "verification_code_locked", "验证码尝试次数过多，请重新发送验证码后再试。");
            case "ACCOUNT_UNAVAILABLE":
                return new HttpError(403, "account_unavailable", "该账号当前不可用，请联系管理员。");
            case "FAILED_TO_CREATE_SESSION":
                return new HttpError(503, "service_unavailable", "登录会话创建失败，请稍后重试。");
            default:
                return new HttpError(status >= 500 ? 503 : status, "auth_rejected", authPath === "/sign-in/email"
                    ? "账户登录未完成，请检查邮箱和密码后重试。"
                    : "账户操作未完成，请检查信息后重试。");
        }
    }

    return async (request: Request, peerIp?: string): Promise<Response> => {
        const requestId = crypto.randomUUID();
        const responseHeaders = new Headers();
        const respond = (data: unknown, status = 200) => {
            const response = json(data, status, responseHeaders);
            if (responseHeaders.get("cache-control") === "private, no-store") response.headers.set("cache-control", "private, no-store");
            response.headers.set("x-request-id", requestId);
            return response;
        };
        try {
            const url = new URL(request.url);
            const path = url.pathname;
            // A gateway callback has no browser Origin, cookie or account context.
            // Only this exact notification route bypasses the browser/session gates.
            if (/^\/api\/v1\/payments\/zpay\/notify\/[^/]+$/.test(path)) {
                if (url.origin !== origin) throw new HttpError(403, "invalid_origin", "请求来源不受信任");
                const response = await payments().handleNotification(request, requestId);
                if (!response) throw new HttpError(404, "not_found", "接口不存在");
                response.headers.set("x-request-id", requestId);
                return response;
            }
            const authPath = path.startsWith("/api/auth/") ? path.slice("/api/auth".length) : null;
            const authGet = authPath === "/verify-email" || (authPath !== null && /^\/reset-password\/[^/]+$/.test(authPath));
            const canvasId = path.startsWith("/api/v1/canvases/") ? path.slice("/api/v1/canvases/".length).toLowerCase() : null;
            const sharingPath = path.startsWith("/api/v1/canvas/");
            const sharingMatch = /^\/api\/v1\/canvas\/([^/]+)\/(share|share-link|members)(?:\/([^/]+))?$/.exec(path);
            const joinMatch = /^\/api\/v1\/canvas\/share\/([^/]+)\/join$/.exec(path);
            const mediaResolvePath = path === "/api/v1/media/resolve";
            const mediaId = path.startsWith("/api/v1/media/") ? path.slice("/api/v1/media/".length).toLowerCase() : null;
            const modelsPath = path === "/api/v1/models";
            const modelPricingPath = path === "/api/v1/model-pricing";
            const officialPriceReferencesPath = path === "/api/v1/official-price-references";
            const adminOfficialPriceReferencesPath = path === "/api/v1/admin/official-price-references";
            const adminOfficialPriceMappingsPath = path === "/api/v1/admin/official-price-reference-mappings";
            const adminModelsPath = path === "/api/v1/admin/models";
            const adminInspirationPath = path === "/api/v1/admin/inspiration/items";
            const adminModelGroupsPath = path === "/api/v1/admin/model-groups";
            const adminModelMappingPath = path === "/api/v1/admin/model-mapping-draft";
            const mappingCatalogPath = path === "/api/v1/model-mapping-catalog";
            const adminMappingPublicationPath = path === "/api/v1/admin/model-mapping-publication";
            const adminGenerationTaskId = path.startsWith("/api/v1/admin/generation/tasks/")
                ? path.slice("/api/v1/admin/generation/tasks/".length) : null;
            const adminModelPublicId = path.startsWith("/api/v1/admin/models/") ? path.slice("/api/v1/admin/models/".length) : null;
            const adminModelPricingPath = path === "/api/v1/admin/model-pricing";
            const adminPriceDraftsPath = path === "/api/v1/admin/model-price-drafts";
            const adminPricePublicationsPath = path === "/api/v1/admin/model-price-publications";
            const adminUsersPath = path === "/api/v1/admin/users";
            const moderationPath = /^\/api\/v1\/admin\/users\/[^/]+\/moderation$/.test(path) ||
                /^\/api\/v1\/admin\/moderation\/operations\/[^/]+$/.test(path);
            const abuseReportsPath = path === "/api/v1/abuse-reports" || /^\/api\/v1\/abuse-reports\/[^/]+$/.test(path) ||
                path === "/api/v1/admin/abuse-reports" || /^\/api\/v1\/admin\/abuse-reports\/[^/]+(?:\/receipt)?$/.test(path);
            const contentSafetySettingsPath = path === "/api/v1/admin/content-safety/settings" || /^\/api\/v1\/admin\/content-safety\/settings\/operations\/[^/]+$/.test(path);
            const contentSafetyPath = moderationPath || abuseReportsPath || contentSafetySettingsPath;
            const adminBalanceUserId = path.startsWith("/api/v1/admin/users/") && path.endsWith("/balance")
                ? path.slice("/api/v1/admin/users/".length, -"/balance".length) : null;
            const adminProvidersPath = path === "/api/v1/admin/providers";
            const adminProviderModelsPath = path === "/api/v1/admin/provider-models";
            const adminProviderId = path.startsWith("/api/v1/admin/providers/") ? path.slice("/api/v1/admin/providers/".length) : null;
            const adminProviderTestId = path.startsWith("/api/v1/admin/providers/") && path.endsWith("/test")
                ? path.slice("/api/v1/admin/providers/".length, -"/test".length) : null;
            const adminProviderDiscoverId = path.startsWith("/api/v1/admin/providers/") && path.endsWith("/discover")
                ? path.slice("/api/v1/admin/providers/".length, -"/discover".length) : null;
            const walletPath = path === "/api/v1/wallet" || path === "/api/v1/wallet/ledger";
            const paymentPath = /^\/api\/v1\/payments\/(?:offers|orders(?:\/by-key\/[^/]+|\/[^/]+(?:\/query)?)?)$/.test(path) ||
                /^\/api\/v1\/admin\/payments\/(?:config|merchant|offers|merchant-operations\/[^/]+|orders\/[^/]+(?:\/reconcile)?)$/.test(path);
            const generationQuotePath = path === "/api/v1/generation/quote";
            const generationModelsPath = path === "/api/v1/generation/models";
            const generationTasksPath = path === "/api/v1/generation/tasks";
            const generationBatchPath = path === "/api/v1/generation/tasks/batch";
            const generationLogsPath = path === "/api/v1/generation/logs";
            const generationLogTitleId = /^\/api\/v1\/generation\/logs\/([^/]+)\/title$/.exec(path)?.[1];
            const textModelsPath = path === "/api/v1/generation/text/models";
            const textQuotePath = path === "/api/v1/generation/text/quote";
            const textTasksPath = path === "/api/v1/generation/text/tasks";
            const textGenerationPath = textModelsPath || textQuotePath || textTasksPath;
            const audioModelsPath = path === "/api/v1/generation/audio/models";
            const audioQuotePath = path === "/api/v1/generation/audio/quote";
            const audioTasksPath = path === "/api/v1/generation/audio/tasks";
            const audioGenerationPath = audioModelsPath || audioQuotePath || audioTasksPath;
            const videoModelsPath = path === "/api/v1/generation/video/models";
            const videoQuotePath = path === "/api/v1/generation/video/quote";
            const videoTasksPath = path === "/api/v1/generation/video/tasks";
            const videoGenerationPath = videoModelsPath || videoQuotePath || videoTasksPath;
            const generationTaskKey = path.startsWith("/api/v1/generation/tasks/by-key/") ? path.slice("/api/v1/generation/tasks/by-key/".length) : null;
            const generationTaskId = !generationBatchPath && path.startsWith("/api/v1/generation/tasks/") ? path.slice("/api/v1/generation/tasks/".length).toLowerCase() : null;
            const generationPath = videoGenerationPath || audioGenerationPath || textGenerationPath || generationQuotePath || generationModelsPath || generationTasksPath || generationBatchPath || generationLogsPath || generationLogTitleId !== undefined || generationTaskId !== null;
            const adminPath = adminMappingPublicationPath || adminInspirationPath || adminGenerationTaskId !== null || adminModelsPath || adminModelGroupsPath || adminModelMappingPath || adminModelPublicId !== null || adminModelPricingPath || adminPriceDraftsPath || adminPricePublicationsPath || adminOfficialPriceReferencesPath || adminOfficialPriceMappingsPath || adminUsersPath || adminBalanceUserId !== null || adminProvidersPath || adminProviderModelsPath || adminProviderId !== null || adminProviderTestId !== null;
            if (!authPath && path !== "/api/v1/session" && !mappingCatalogPath && !modelsPath && !modelPricingPath && !officialPriceReferencesPath && !adminPath && !contentSafetyPath && !paymentPath && !walletPath && !generationPath && path !== "/api/v1/canvases" && canvasId === null && !sharingPath && path !== "/api/v1/media" && !mediaResolvePath && mediaId === null) {
                throw new HttpError(404, "not_found", "接口不存在");
            }
            if (generationPath && options.generation?.enabled !== true) throw new HttpError(503, "generation_unavailable", "平台生成尚未开放");
            if (textGenerationPath && options.generation?.textEnabled !== true) throw new HttpError(503, "generation_unavailable", "平台文本生成尚未开放");
            if (audioGenerationPath && (options.generation?.audioEnabled !== true || !options.media)) throw new HttpError(503, "generation_unavailable", "平台语音生成尚未开放");
            if (videoGenerationPath && (options.generation?.videoEnabled !== true || !options.generation.videoPolicy || !options.media)) throw new HttpError(503, "generation_unavailable", "平台视频生成尚未开放");
            if ((generationQuotePath || generationModelsPath || generationTasksPath) && options.generation?.imageEnabled === false) throw new HttpError(503, "generation_unavailable", "平台图片生成尚未开放");
            if (url.origin !== origin || (request.headers.has("origin") && request.headers.get("origin") !== origin) ||
                (request.method !== "GET" && request.headers.get("origin") !== origin) ||
                (!authGet && request.headers.get("sec-fetch-site") === "cross-site")) {
                throw new HttpError(403, "invalid_origin", "请求来源不受信任");
            }
            if (!peerIp || !isIP(peerIp)) throw new HttpError(503, "service_unavailable", "无法确认请求来源，请稍后再试");

            if (authPath) {
                if (!(request.method === "GET" && authGet) && !(request.method === "POST" && Object.hasOwn(authBodies, authPath))) {
                    throw new HttpError(404, "not_found", "接口不存在");
                }
                let body: Record<string, unknown> | undefined;
                if (request.method === "GET" && authGet) {
                    const isVerificationLink = authPath === "/verify-email";
                    const token = isVerificationLink ? (url.searchParams.get("token") ?? "") : authPath.slice("/reset-password/".length);
                    await consume(isVerificationLink ? "verification-link-ip" : "reset-link-ip", peerIp, policy.verificationLink);
                    await consume(isVerificationLink ? "verification-link-token" : "reset-link-token", token, policy.verificationLink);
                }
                if (request.method === "POST") {
                    const sendsMail = ["/sign-up/email", "/send-verification-email", "/request-password-reset", "/email-otp/send-verification-otp"].includes(authPath);
                    if (authPath === "/sign-up/email") await consume("signup-ip", peerIp, policy.signup);
                    if (authPath === "/sign-in/email") await consume("login-ip", peerIp, policy.login);
                    if (sendsMail) await consume("mail-ip", peerIp, policy.mail);
                    body = parse(authBodies[authPath], await readJson(request, policy.documentBytes)) as Record<string, unknown>;
                    if (typeof body.email === "string") {
                        body.email = body.email.trim().toLowerCase();
                    }
                    if (authPath === "/email-otp/verify-email") {
                        await consume("otp-verify-ip", peerIp, policy.otpVerify);
                        await consume("otp-verify-email", String(body.email), policy.otpVerify);
                    }
                    if (authPath === "/reset-password") {
                        await consume("reset-submit-ip", peerIp, policy.resetSubmit);
                        await consume("reset-submit-token", String(body.token), policy.resetSubmit);
                    }
                    if (authPath !== "/sign-out" && authPath !== "/revoke-sessions" && authPath !== "/reset-password" && authPath !== "/email-otp/verify-email") {
                        if (!await options.verifyHuman(request)) throw new HttpError(403, "captcha_failed", "人机验证未通过，请重新验证");
                    }
                    if (typeof body.email === "string" && emailAuthPaths.has(authPath)) {
                        const normalizedEmail = body.email;
                        const [storedEmail] = await options.database.select({ id: userTable.id, email: userTable.email })
                            .from(userTable)
                            .where(sql`lower(${userTable.email}) = ${normalizedEmail}`)
                            .limit(1);
                        if (storedEmail && storedEmail.email !== normalizedEmail) {
                            // Better Auth canonicalizes identifiers to lowercase
                            // internally. Repair one legacy row before handing
                            // it over, otherwise an imported uppercase email
                            // remains impossible to authenticate.
                            await options.database.update(userTable)
                                .set({ email: normalizedEmail, updatedAt: new Date() })
                                .where(and(eq(userTable.id, storedEmail.id), eq(userTable.email, storedEmail.email)));
                        }
                    }
                    // Invalid captcha attempts must not exhaust another person's mailbox budget.
                    if (sendsMail) await consume("mail-email", String(body.email), policy.mail);
                    if (authPath === "/request-password-reset") {
                        await consume("reset-mail-ip", peerIp, policy.resetMail);
                        await consume("reset-mail-email", String(body.email), policy.resetMail);
                    }
                    // User-supplied redirects are rejected; frontend destinations are platform-owned.
                    if (authPath === "/sign-up/email" || authPath === "/send-verification-email") body.callbackURL = `${origin}/login`;
                    if (authPath === "/request-password-reset") body.redirectTo = `${origin}/reset-password`;
                }
                const headers = new Headers({ "x-canvas-peer-ip": peerIp });
                for (const name of ["cookie", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]) {
                    const value = request.headers.get(name);
                    if (value !== null) headers.set(name, value);
                }
                if (body) headers.set("content-type", "application/json");
                const mailState = { failed: false };
                const runAuth = async () => {
                    // Better Auth intentionally returns a generic 200 response
                    // for duplicate sign-ups when email verification is
                    // required. Serialize same-process tabs so the second
                    // request sees the committed account before calling it.
                    if (authPath === "/sign-up/email") {
                        const duplicate = await existingSignupError(String(body?.email ?? ""));
                        if (duplicate) throw duplicate;
                    }
                    return mailContext.run(mailState, () => auth.handler(new Request(request.url, {
                        method: request.method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
                    })));
                };
                const response = authPath === "/sign-up/email"
                    ? await withSignupLock(String(body?.email ?? ""), runAuth)
                    : await runAuth();
                if (mailState.failed) throw new HttpError(503, "mail_unavailable", "验证邮件发送未确认，请稍后重新申请；账号仍需完成邮箱验证");
                if (response.status >= 400) {
                    // Two tabs can pass the read-only pre-check together. If
                    // Better Auth then loses the unique-email race, convert
                    // its generic failure into the same actionable duplicate
                    // state instead of exposing a transient system error.
                    if (authPath === "/sign-up/email") {
                        const duplicate = await existingSignupError(String(body?.email ?? ""));
                        if (duplicate) throw duplicate;
                    }
                    let authCode: string | undefined;
                    try {
                        const payload = await response.clone().json() as unknown;
                        if (record(payload) && typeof payload.code === "string") authCode = payload.code;
                        else if (record(payload) && record(payload.error) && typeof payload.error.code === "string") authCode = payload.error.code;
                    } catch { /* Keep the fixed generic auth error when the provider response is not JSON. */ }
                    if (authPath === "/reset-password" && authCode === "INVALID_TOKEN") {
                        throw new HttpError(400, "invalid_token", "重置链接无效或已过期，请重新申请密码重置邮件");
                    }
                    throw mapAuthFailure(authPath, authCode, response.status);
                }
                const safeHeaders = new Headers();
                for (const cookie of response.headers.getSetCookie()) safeHeaders.append("set-cookie", cookie);
                if (authPath === "/revoke-sessions") {
                    const cookieName = origin.startsWith("https://") ? "__Secure-better-auth.session_token" : "better-auth.session_token";
                    const secure = origin.startsWith("https://") ? "; Secure" : "";
                    safeHeaders.append("set-cookie", `${cookieName}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure}`);
                }
                safeHeaders.set("x-request-id", requestId);
                const location = response.headers.get("location");
                if (location) {
                    if (new URL(location, origin).origin !== origin) throw new HttpError(403, "invalid_origin", "跳转来源不受信任");
                    safeHeaders.set("location", location);
                    safeHeaders.set("cache-control", "no-store");
                    safeHeaders.set("referrer-policy", "no-referrer");
                    return new Response(null, { status: response.status, headers: safeHeaders });
                }
                // Better Auth may return a session token in JSON; only HttpOnly cookies leave here.
                return json({ ok: true, requestId }, 200, safeHeaders);
            }

            const session = await getPrincipal(auth, new Headers({ cookie: request.headers.get("cookie") ?? "" }));
            let principal = session.principal;
            if (!principal) throw new HttpError(401, "unauthorized", "请先登录并完成邮箱验证");
            // Promote only the configured, already authenticated and verified
            // email. This keeps the first admin bootstrap server-controlled and
            // avoids trusting a client-supplied role or a stale session claim.
            if (options.adminEmail && options.adminEmail === options.adminEmail.toLowerCase()) {
                const [owner] = await options.database.select({ id: userTable.id, email: userTable.email, role: userTable.role })
                    .from(userTable).where(eq(userTable.id, principal.id)).limit(1);
                if (owner?.email.toLowerCase() === options.adminEmail && owner.role !== "admin") {
                    await options.database.update(userTable).set({ role: "admin", updatedAt: new Date() }).where(eq(userTable.id, owner.id));
                    principal = { ...principal, role: "admin" };
                }
            }
            // Authentication precedes the user budget. Retain an already-issued renewal even if
            // the following limiter/business operation fails; it never authorizes a refused write.
            for (const cookie of session.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie);
            if ((path === "/api/v1/canvases" || canvasId !== null || sharingPath) && options.cloudCanvas !== true) {
                throw new HttpError(503, "cloud_unavailable", "云端画布暂未开启，请保留本机作品");
            }
            const writing = (request.method === "POST" || request.method === "PUT" || ((sharingPath || adminProviderId !== null || adminModelPublicId !== null) && request.method === "DELETE")) && !(generationBatchPath && request.method === "POST");
            await consume(writing ? "canvas-save" : "account-read", principal.id, writing ? policy.save : policy.read);
            if (path === "/api/v1/session" && request.method === "GET") return respond({ user: principal });
            const principalId = principal.id;
            function requireAccountContext() {
                const accountId = request.headers.get("x-canvas-account-id");
                if (!accountId) throw new HttpError(400, "account_context_required", "缺少账户上下文，请重新确认登录状态");
                if (accountId !== principalId) throw new HttpError(409, "account_changed", "登录账号已变化，本次操作未执行，请重新确认账号");
            }
            function safetyRequestActor(): SafetyActor {
                const context = session.sessionContext;
                if (!context) throw new HttpError(401, "unauthorized", "请重新登录");
                return { actorId: principalId, sessionId: context.id, sessionExpiresAt: context.expiresAt, requestId };
            }
            async function withActiveWrite<T>(adminOnly: boolean, write: (tx: SafetyTx) => Promise<T>): Promise<T> {
                try {
                    return await options.database.transaction(async tx => {
                        await assertSafetyActor(tx, safetyRequestActor(), adminOnly);
                        return write(tx);
                    });
                } catch (error) { rethrowModerationError(error); }
            }
            if (paymentPath) {
                requireAccountContext();
                responseHeaders.set("cache-control", "private, no-store");
                responseHeaders.set("x-canvas-account-id", principal.id);
                const result = await payments().handleAccountRequest(request, { actor: safetyRequestActor(), role: principal.role,
                    peerIp, documentBytes: policy.documentBytes });
                if (!result) throw new HttpError(404, "not_found", "接口不存在");
                return respond({ ...result.data, requestId }, result.status ?? 200);
            }
            if (contentSafetyPath) {
                requireAccountContext();
                responseHeaders.set("cache-control", "private, no-store");
                responseHeaders.set("x-canvas-account-id", principal.id);
                const context: SafetyRouteContext = { database: options.database, actor: safetyRequestActor(), role: principal.role,
                    config: contentSafety, policy };
                const result = await (contentSafetySettingsPath ? handleContentSafetySettings(request, context)
                    : moderationPath ? handleAccountModeration(request, context) : handleAbuseReport(request, context));
                if (!result) throw new HttpError(404, "not_found", "接口不存在");
                return respond({ ...result.data, requestId }, result.status ?? 200);
            }
            if (generationPath) {
                requireAccountContext();
                responseHeaders.set("cache-control", "private, no-store");
                responseHeaders.set("x-canvas-account-id", principal.id);
                const admission: GenerationSubmissionSafety = {
                    ...safetyRequestActor(), peerIp, rates: options.rates, config: contentSafety,
                    onRecordUnavailable: () => options.onFault({ requestId, component: "accounts", code: "content_safety_record_unavailable" }),
                };
                if (generationLogsPath) {
                    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const query: Record<string, string> = Object.create(null);
                    for (const [key, value] of url.searchParams) {
                        if (Object.hasOwn(query, key)) throw new HttpError(400, "invalid_input", "重复的查询参数");
                        query[key] = value;
                    }
                    const pageInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
                    const input = parse(z.strictObject({
                        pageNumber: pageInteger.optional(),
                        pageSize: pageInteger.pipe(z.number().max(50)).optional(),
                        type: z.enum(["text", "image", "audio", "video"]).optional(),
                        status: z.enum(["succeeded", "failed", "running", "queued", "pending"]).optional(),
                        search: historyTitle.optional(),
                    }), query);
                    const pageNumber = input.pageNumber ?? 1, pageSize = input.pageSize ?? 50;
                    if (!Number.isSafeInteger((pageNumber - 1) * pageSize)) throw new HttpError(400, "invalid_input", "分页偏移无效");
                    const result = await getGenerationHistoryForOwner(options.database, { ...input, ownerId: principal.id, pageNumber, pageSize });
                    const response = respond({ items: result.items, total: result.total, pageNumber: result.pageNumber, pageSize: result.pageSize, requestId });
                    response.headers.set("cache-control", "private, no-store");
                    response.headers.set("x-request-id", requestId);
                    return response;
                }
                if (generationLogTitleId !== undefined) {
                    if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    if (url.search || !z.uuid().safeParse(generationLogTitleId).success) throw new HttpError(404, "not_found", "创作记录不存在");
                    const input = parse(z.strictObject({ title: historyTitle }), await readJson(request, policy.documentBytes));
                    const saved = await withActiveWrite(false, tx => renameGenerationHistoryForOwner(tx, principal.id, generationLogTitleId.toLowerCase(), input.title));
                    if (!saved) throw new HttpError(404, "not_found", "创作记录不存在");
                    return respond({ ...saved, requestId });
                }
                if (generationBatchPath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    if ([...url.searchParams].length) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
                    const input = parse(z.strictObject({ taskIds: z.array(z.unknown()).max(50) }), await readJson(request, policy.documentBytes));
                    const taskIds = parse(z.array(z.uuid()), input.taskIds);
                    const result = await getGenerationTasksForOwner(options.database, { ownerId: principal.id, taskIds });
                    const response = respond({ items: result.items, missingTaskIds: result.missingTaskIds, requestId });
                    // json() sets no-store itself; apply the owner-only read policy last.
                    response.headers.set("cache-control", "private, no-store");
                    response.headers.set("x-request-id", requestId);
                    return response;
                }
                if (videoModelsPath) {
                    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    return respond({ items: await listExecutableVideoModels(options.database, options.generation!.videoPolicy!), requestId });
                }
                if (videoQuotePath || videoTasksPath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const body = await readJson(request, policy.documentBytes);
                    const videoPolicy = options.generation!.videoPolicy!;
                    const resources = { storage: media!.storage, verifyReference: inspectGenerationVideoReference };
                    try {
                        if (videoQuotePath) return respond({ quote: publicVideoQuote(await resolveExecutableVideoQuote(options.database, parseGenerationIntent(body), principal.id, videoPolicy, false, resources)), requestId });
                        const { confirmedPriceVersion, confirmedQuoteFingerprint, ...intent } = parseGenerationSubmission(body);
                        if (!confirmedQuoteFingerprint) throw new GenerationContractError("invalid_input", "请先确认本次视频内容、规格与费用");
                        const dispatched = await quoteReserveAndEnqueueConfirmedVideoTask(options.database, options.generation!.queue,
                            { ...intent, ownerId: principal.id, requestId, idempotencyKey: parseGenerationIdempotencyKey(request.headers.get("idempotency-key")) },
                            confirmedPriceVersion, confirmedQuoteFingerprint, videoPolicy, { admission, resources });
                        return respond({ ...(await getGenerationTaskForOwner(options.database, { ownerId: principal.id, taskId: dispatched.task.id })), created: dispatched.created, requestId }, dispatched.created ? 201 : 200);
                    } catch (error) {
                        if (error instanceof GenerationContractError) throw new HttpError(error.code === "price_changed" ? 409 : 400, error.code, error.message);
                        if (error instanceof WalletOperationError && error.code === "insufficient_balance") throw new HttpError(402, "insufficient_balance", "余额不足，请先充值后再生成");
                        if (error instanceof WalletOperationError && error.code === "idempotency_conflict") throw new HttpError(409, "idempotency_conflict", "该幂等键已用于其他生成请求");
                        throw error;
                    }
                }
                if (audioModelsPath) {
                    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    return respond({ items: await listExecutableAudioModels(options.database), requestId });
                }
                if (audioQuotePath || audioTasksPath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const body = await readJson(request, policy.documentBytes);
                    try {
                        if (audioQuotePath) return respond({ quote: publicAudioQuote(await resolveExecutableAudioQuote(options.database, parseGenerationIntent(body), principal.id)), requestId });
                        const { confirmedPriceVersion, confirmedQuoteFingerprint, ...intent } = parseGenerationSubmission(body);
                        if (!confirmedQuoteFingerprint) throw new GenerationContractError("invalid_input", "请先确认本次语音内容与费用");
                        const dispatched = await quoteReserveAndEnqueueConfirmedAudioTask(options.database, options.generation!.queue,
                            { ...intent, ownerId: principal.id, requestId, idempotencyKey: parseGenerationIdempotencyKey(request.headers.get("idempotency-key")) },
                            confirmedPriceVersion, confirmedQuoteFingerprint, { admission });
                        return respond({ ...(await getGenerationTaskForOwner(options.database, { ownerId: principal.id, taskId: dispatched.task.id })), created: dispatched.created, requestId }, dispatched.created ? 201 : 200);
                    } catch (error) {
                        if (error instanceof GenerationContractError) throw new HttpError(error.code === "price_changed" ? 409 : 400, error.code, error.message);
                        if (error instanceof WalletOperationError && error.code === "insufficient_balance") throw new HttpError(402, "insufficient_balance", "余额不足，请先充值后再生成");
                        if (error instanceof WalletOperationError && error.code === "idempotency_conflict") throw new HttpError(409, "idempotency_conflict", "该幂等键已用于其他生成请求");
                        throw error;
                    }
                }
                if (textModelsPath) {
                    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    return respond({ items: await listExecutableTextModels(options.database), requestId });
                }
                if (textQuotePath || textTasksPath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const body = await readJson(request, policy.documentBytes);
                    try {
                        if (textQuotePath) return respond({ quote: await resolveExecutableTextQuote(options.database, parseTextGenerationIntent(body)), requestId });
                        if (!body || typeof body !== "object" || Array.isArray(body)) throw new GenerationContractError("invalid_input", "请先确认文本预算");
                        const { confirmedPriceVersion, ...rawIntent } = body as Record<string, unknown>;
                        if (!Number.isSafeInteger(confirmedPriceVersion) || (confirmedPriceVersion as number) <= 0) throw new GenerationContractError("invalid_input", "请先确认有效的价格版本");
                        const intent = parseTextGenerationIntent(rawIntent);
                        const idempotencyKey = parseGenerationIdempotencyKey(request.headers.get("idempotency-key"));
                        const dispatched = await quoteReserveAndEnqueueConfirmedTextTask(options.database, options.generation!.queue,
                            { ...intent, ownerId: principal.id, idempotencyKey, requestId }, confirmedPriceVersion as number, { admission });
                        const view = await getGenerationTaskForOwner(options.database, { ownerId: principal.id, taskId: dispatched.task.id });
                        return respond({ ...view, created: dispatched.created, requestId }, dispatched.created ? 201 : 200);
                    } catch (error) {
                        if (error instanceof GenerationContractError) throw new HttpError(error.code === "price_changed" ? 409 : 400, error.code, error.message);
                        if (error instanceof WalletOperationError && error.code === "insufficient_balance") throw new HttpError(402, "insufficient_balance", "可用积分不足以冻结本次预算，请减少预算或补充余额");
                        if (error instanceof WalletOperationError && error.code === "idempotency_conflict") throw new HttpError(409, "idempotency_conflict", "该幂等键已用于其他生成请求");
                        throw error;
                    }
                }
                if (generationModelsPath) {
                    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    return respond({ items: await listExecutableImageModels(options.database, options.generation?.geminiImageEnabled === true), requestId });
                }
                if (generationQuotePath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const intent = parseGenerationIntent(await readJson(request, policy.documentBytes));
                    if (intent.parameterSnapshot.protocol === GEMINI_IMAGE_PROTOCOL && options.generation?.geminiImageEnabled !== true)
                        throw new HttpError(503, "generation_unavailable", "Gemini 图片生成尚未开放");
                    try {
                        const quote = await resolveExecutableImageQuote(options.database, intent, false, principal.id);
                        return respond({ quote: publicImageQuote(quote), requestId });
                    } catch (error) {
                        if (error instanceof GenerationContractError) throw new HttpError(400, error.code, error.message);
                        throw new HttpError(409, "generation_unavailable", "当前模型暂时无法报价，请稍后重试");
                    }
                }
                if (generationTasksPath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const { confirmedPriceVersion, confirmedQuoteFingerprint, ...intent } = parseGenerationSubmission(await readJson(request, policy.documentBytes));
                    if (intent.parameterSnapshot.protocol === GEMINI_IMAGE_PROTOCOL && options.generation?.geminiImageEnabled !== true)
                        throw new HttpError(503, "generation_unavailable", "Gemini 图片生成尚未开放");
                    const idempotencyKey = parseGenerationIdempotencyKey(request.headers.get("idempotency-key"));
                    try {
                        const dispatched = await quoteReserveAndEnqueueConfirmedImageTask(options.database, options.generation!.queue, {
                            ...intent, ownerId: principal.id, idempotencyKey, requestId,
                        }, confirmedPriceVersion, confirmedQuoteFingerprint, { admission });
                        const view = await getGenerationTaskForOwner(options.database, { ownerId: principal.id, taskId: dispatched.task.id });
                        return respond({ task: view.task, result: view.result, created: dispatched.created, requestId }, dispatched.created ? 201 : 200);
                    } catch (error) {
                        if (error instanceof GenerationContractError) throw new HttpError(error.code === "price_changed" ? 409 : 400, error.code, error.message);
                        if (error instanceof WalletOperationError && error.code === "insufficient_balance") throw new HttpError(402, "insufficient_balance", "余额不足，请先充值后再生成");
                        if (error instanceof WalletOperationError && error.code === "idempotency_conflict") throw new HttpError(409, "idempotency_conflict", "该幂等键已用于其他生成请求");
                        throw error;
                    }
                }
                if (generationTaskKey !== null) {
                    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    let decodedKey: string;
                    try { decodedKey = decodeURIComponent(generationTaskKey); }
                    catch { throw new HttpError(400, "idempotency_invalid", "Idempotency-Key 格式或长度不正确"); }
                    const idempotencyKey = parseGenerationIdempotencyKey(decodedKey);
                    return respond({ ...(await getGenerationTaskByKeyForOwner(options.database, { ownerId: principal.id, idempotencyKey })), requestId });
                }
                if (generationTaskId === null || !z.uuid().safeParse(generationTaskId).success || request.method !== "GET") throw new HttpError(404, "not_found", "生成任务不存在");
                try {
                    return respond({ ...(await getGenerationTaskForOwner(options.database, { ownerId: principal.id, taskId: generationTaskId })), requestId });
                } catch (error) {
                    if (error instanceof GenerationQueryError && error.code === "not_found") throw new HttpError(404, "not_found", "生成任务不存在");
                    if (error instanceof GenerationQueryError) throw new HttpError(400, error.code, error.message);
                    throw error;
                }
            }
            if (modelsPath) {
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ items: await listPublicModels(options.database), requestId });
            }
            if (adminInspirationPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if ([...url.searchParams].length) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
                if (request.method !== "GET" && request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                if (!options.inspiration) throw new HttpError(503, "inspiration_unavailable", "管理员灵感存储尚未配置");
                responseHeaders.set("cache-control", "private, no-store");
                if (request.method === "GET") return respond({ ...await options.inspiration.read(), requestId });
                const input = parseInspirationWrite(await readJson(request, policy.documentBytes));
                const result = await options.inspiration.write(input, publish => withActiveWrite(true, async () => { await publish(); }));
                return respond({ ...result, requestId });
            }
            if (mappingCatalogPath) {
                requireAccountContext();
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                if ([...url.searchParams].length) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
                const catalog = executableMappingCatalog(await readPublishedMappingCatalog(options.database), {
                    enabled: options.generation?.enabled === true, imageEnabled: options.generation?.imageEnabled !== false,
                    geminiImageEnabled: options.generation?.geminiImageEnabled === true,
                    videoEnabled: options.generation?.videoEnabled === true && !!options.media && !!options.generation.videoPolicy,
                    maxVideoDurationMs: options.generation?.videoPolicy?.maxMediaDurationMs,
                });
                return respond({ catalog, requestId });
            }
            if (adminMappingPublicationPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if ([...url.searchParams].length) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
                try {
                    if (request.method === "GET") return respond({ preview: await previewMappingPublication(options.database, safetyRequestActor(), options.generation?.geminiImageEnabled === true), requestId });
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const input = parseMappingPublicationWrite(await readJson(request, policy.documentBytes));
                    if (!input) throw new HttpError(400, "invalid_input", "生效方案字段不完整");
                    return respond({ publication: await publishMappingConfiguration(options.database, input, safetyRequestActor(), options.generation?.geminiImageEnabled === true), requestId });
                } catch (error) { rethrowModerationError(error); }
            }
            if (adminModelMappingPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if ([...url.searchParams].length) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
                if (request.method === "GET") return respond({ catalog: await readModelMappingDraft(options.database, safetyRequestActor()), requestId });
                if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                const input = parseMappingDraftWrite(await readJson(request, policy.documentBytes));
                if (!input) throw new HttpError(400, "invalid_input", "模型、规格、来源或价格草稿不完整，请核对后保存");
                return respond({ saved: await saveModelMappingDraft(options.database, input, safetyRequestActor()), requestId });
            }
            if (adminModelGroupsPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                responseHeaders.set("cache-control", "private, no-store");
                if (request.method === "GET") return respond({ items: await listNodeModelGroups(options.database), requestId });
                if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                const input = parseNodeModelGroupsWrite(await readJson(request, policy.documentBytes));
                if (!input) throw new HttpError(400, "invalid_input", "请核对分组名称、节点类型及当前版本");
                if (!session.sessionContext) throw new HttpError(401, "unauthorized", "请重新登录");
                const item = await saveNodeModelGroups(options.database, input, { actorId: principal.id, sessionId: session.sessionContext.id, sessionExpiresAt: session.sessionContext.expiresAt, requestId });
                return respond({ item, requestId });
            }
            if (officialPriceReferencesPath || adminOfficialPriceReferencesPath || adminOfficialPriceMappingsPath) {
                if (!officialPriceReferencesPath && principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                if (!officialPriceReferencesPath) requireAccountContext();
                if ([...url.searchParams].length) throw new HttpError(400, "invalid_input", "此接口不接受查询参数");
                responseHeaders.set("cache-control", "private, no-store");
                if (adminOfficialPriceMappingsPath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const input = parseOfficialPriceMappingWrite(await readJson(request, policy.documentBytes));
                    if (!input || !endpoint.safeParse(input.binding.endpoint).success) throw new HttpError(400, "invalid_input", "官方参考价映射格式不正确");
                    const result = await withActiveWrite(true, tx => saveOfficialPriceMapping(tx, input, { actorId: principal.id, requestId }));
                    if (result.status === "model_not_found") throw new HttpError(404, result.status, "模型不存在");
                    if (result.status !== "saved") throw new HttpError(409, result.status, "参考价、模型绑定或映射版本已变化，请重新读取后确认");
                    return respond({ mapping: result.mapping, requestId });
                }
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                return officialPriceReferencesPath
                    ? respond({ items: await listPublicOfficialPriceReferences(options.database), requestId })
                    : respond({ ...await listAdminOfficialPriceCatalog(options.database), requestId });
            }
            if (modelPricingPath) {
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ items: await listPublicModelPricing(options.database), requestId });
            }
            if (adminGenerationTaskId !== null) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ detail: await getAdminGenerationTaskDetail(options.database, adminGenerationTaskId), requestId });
            }
            if (adminModelsPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ items: await listAdminModels(options.database), requestId });
            }
            if (adminPriceDraftsPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                responseHeaders.set("cache-control", "private, no-store");
                if (request.method === "GET") return respond({ ...await listModelPriceDrafts(options.database), requestId });
                if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                const input = parseModelPriceDraftWrite(await readJson(request, policy.documentBytes));
                if (!input || !endpoint.safeParse(input.binding.endpoint).success) throw new HttpError(400, "invalid_input", "模型价格草稿格式不正确");
                const result = await withActiveWrite(true, tx => createModelPriceDraft(tx, input, { actorId: principal.id, requestId }));
                if (result.status === "not_found") throw new HttpError(404, "model_not_found", "模型不存在");
                if (result.status === "model_binding_changed") throw new HttpError(409, result.status, "模型或渠道绑定已变化，请重新读取后确认");
                if (result.status === "price_draft_conflict") throw new HttpError(409, result.status, "已有更新的模型价格草稿，请重新读取后确认");
                if (result.status === "invalid_derivation") throw new HttpError(400, result.status, "倍率价目与基准或计算结果不一致，请重新生成草稿");
                if (result.status === "price_derivation_source_changed") throw new HttpError(409, result.status, "倍率所用基准已变化或不可用，请重新读取并试算");
                return respond({ draft: result.draft, requestId }, 201);
            }
            if (adminPricePublicationsPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                responseHeaders.set("cache-control", "private, no-store");
                if (request.method === "GET") {
                    const params = url.searchParams, modelId = params.get("modelId"), keys = [...params.keys()];
                    const trialFields = ["modelId", "draftVersion", "priceVersion", "aspectRatio", "imageSize", "budgetCredits"];
                    const trial = keys.length === trialFields.length && trialFields.every(key => params.has(key));
                    if (!modelId || modelId.trim() !== modelId || /[\u0000-\u001f\u007f]/.test(modelId) || keys.length !== 1 && !trial) throw new HttpError(400, "invalid_input", "请指定要核对的模型");
                    const preview = await getModelPricePublicationPreview(options.database, modelId, options.generation?.geminiImageEnabled === true);
                    if (!preview) throw new HttpError(404, "model_not_found", "模型不存在");
                    if (trial) {
                        const integer = (key: string) => /^(0|[1-9]\d*)$/.test(params.get(key) ?? "") ? Number(params.get(key)) : NaN;
                        const draftVersion = integer("draftVersion"), priceVersion = integer("priceVersion"), budgetCredits = integer("budgetCredits");
                        const draft = preview.draft;
                        const parameters = draft && parseGeminiImageSpecification(draft.binding.providerModel,
                            { aspectRatio: params.get("aspectRatio"), imageSize: params.get("imageSize") });
                        if (!draft) throw new HttpError(409, "price_changed", "已保存的价格草稿已变化，请重新读取");
                        if (!parameters || !Number.isSafeInteger(draftVersion) || draftVersion <= 0 || !Number.isSafeInteger(priceVersion) || priceVersion < 0 ||
                            !Number.isSafeInteger(budgetCredits) || budgetCredits <= 0) throw new HttpError(400, "invalid_input", "请核对所选比例、分辨率档位和试算预算");
                        const trialInput: GeminiImagePriceTrialInput = { draftVersion, priceVersion, budgetCredits, parameters };
                        const result = estimateGeminiImagePrice(draft, preview.latestPriceVersion, trialInput);
                        if (result.status === "quoted") return respond({ quote: result.quote, requestId });
                        const message = result.status === "budget_insufficient" ? "试算预算不足以覆盖一张图片"
                            : result.status === "unsupported_price_rule" ? "此规格没有已保存的有效按张售价" : "草稿版本、价格或渠道已变化，请重新核对";
                        throw new HttpError(result.status === "invalid_input" ? 400 : 409, result.status, message);
                    }
                    return respond({ preview, requestId });
                }
                if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                const input = parseModelPricePublishWrite(await readJson(request, policy.documentBytes));
                if (!input || !endpoint.safeParse(input.binding.endpoint).success) throw new HttpError(400, "invalid_input", "发布请求格式不正确");
                const result = await withActiveWrite(true, tx => publishModelPriceDraft(tx, input, { actorId: principal.id, requestId }, options.generation?.geminiImageEnabled === true));
                if (result.status === "model_not_found") throw new HttpError(404, result.status, "模型不存在");
                if (result.status !== "published") throw new HttpError(409, result.status, "已保存草稿、渠道或价格状态不再满足发布条件，请重新读取并核对");
                return respond({ publication: result.publication, requestId });
            }
            if (adminModelPricingPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method === "POST") {
                    const input = parse(modelPricingWriteSchema, await readJson(request, policy.documentBytes));
                    const id = crypto.randomUUID();
                    const effectiveFrom = input.effectiveFrom ?? new Date();
                    await withActiveWrite(true, async (tx) => {
                        // Share the model lock with draft publication: the legacy writer cannot race or bypass it.
                        const [catalog] = await tx.select({ id: modelCatalog.id, providerId: modelCatalog.providerId }).from(modelCatalog)
                            .where(and(eq(modelCatalog.publicId, input.modelId), isNull(modelCatalog.deletedAt))).for("update");
                        if (!catalog) throw new HttpError(404, "model_not_found", "模型不存在");
                        const [provider] = await tx.select({ id: modelProvider.id }).from(modelProvider)
                            .where(and(eq(modelProvider.id, catalog.providerId), isNull(modelProvider.deletedAt))).for("share");
                        if (!provider) throw new HttpError(404, "model_not_found", "模型所属渠道已删除");
                        const [managed] = await tx.select({ id: modelPricePublication.id }).from(modelPricePublication)
                            .innerJoin(modelPricing, eq(modelPricing.id, modelPricePublication.pricingId)).where(eq(modelPricing.modelId, catalog.id)).limit(1);
                        if (managed) throw new HttpError(409, "price_publication_managed", "该模型已使用保存草稿发布，请从价目草稿发布新版本");
                        const [latest] = await tx.select({ version: max(modelPricing.version) }).from(modelPricing).where(eq(modelPricing.modelId, catalog.id));
                        const version = (latest?.version ?? 0) + 1;
                        if (!Number.isSafeInteger(version) || version > 2_147_483_647) throw new HttpError(409, "version_exhausted", "模型价格版本已达到上限");
                        // Only one enabled price can be exposed for a model. Historical rows remain
                        // queryable and immutable in their version/id; a new version supersedes them.
                        if (input.enabled) {
                            await tx.update(modelPricing).set({ enabled: false, updatedAt: new Date() })
                                .where(and(eq(modelPricing.modelId, catalog.id), eq(modelPricing.enabled, true)));
                        }
                        await tx.insert(modelPricing).values({
                            id, modelId: catalog.id, version, billingUnit: input.billingUnit,
                            creditsPerUnit: input.creditsPerUnit, effectiveFrom, effectiveTo: null, enabled: input.enabled,
                        });
                        await tx.insert(auditEvent).values({
                            id: crypto.randomUUID(), actorId: principal.id, action: "model.pricing.created",
                            resourceId: id, revision: version, requestId,
                        });
                    });
                    const pricing = (await listAdminModelPricing(options.database)).find((item) => item.id === id);
                    if (!pricing) throw new HttpError(503, "service_unavailable", "价格保存后读取失败，请稍后重试");
                    return respond({ pricing, requestId }, 201);
                }
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ items: await listAdminModelPricing(options.database), requestId });
            }
            if (adminUsersPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                const rawLimit = url.searchParams.get("limit");
                if (url.searchParams.has("limit") && (!rawLimit || !/^\d+$/.test(rawLimit))) throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                const limit = rawLimit ? Number(rawLimit) : 100;
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                const rows = await options.database.select({
                    id: userTable.id, name: userTable.name, email: userTable.email, role: userTable.role,
                    disabled: userTable.disabled, emailVerified: userTable.emailVerified,
                    availableUnits: walletTable.availableUnits, reservedUnits: walletTable.reservedUnits,
                    createdAt: userTable.createdAt,
                }).from(userTable).leftJoin(walletTable, eq(walletTable.userId, userTable.id)).orderBy(asc(userTable.createdAt), asc(userTable.id)).limit(limit);
                return respond({ items: rows.map((row) => ({
                    id: row.id, name: row.name, email: row.email, role: row.role, disabled: row.disabled,
                    emailVerified: row.emailVerified, wallet: {
                        unit: "credit" as const, availableUnits: normalizeCreditAmount(row.availableUnits ?? "0")!, reservedUnits: normalizeCreditAmount(row.reservedUnits ?? "0")!,
                        totalUnits: addCreditAmounts(row.availableUnits ?? "0", row.reservedUnits ?? "0"),
                    }, createdAt: row.createdAt.toISOString(),
                })), requestId });
            }
            if (adminBalanceUserId !== null) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method !== "POST" || !z.string().trim().min(1).max(128).safeParse(adminBalanceUserId).success) {
                    throw new HttpError(405, "method_not_allowed", "不支持此操作");
                }
                const input = parse(balanceAdjustmentSchema, await readJson(request, policy.documentBytes));
                const idempotencyKey = request.headers.get("idempotency-key")?.trim();
                if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, "idempotency_key_required", "缺少有效的幂等键");
                const result = await withActiveWrite(true, async (tx) => {
                    const [target] = await tx.select({ id: userTable.id }).from(userTable)
                        .where(eq(userTable.id, adminBalanceUserId)).limit(1);
                    if (!target) throw new HttpError(404, "user_not_found", "用户不存在");
                    await tx.insert(walletTable).values({ userId: target.id }).onConflictDoNothing({ target: walletTable.userId });
                    const [current] = await tx.select().from(walletTable).where(eq(walletTable.userId, target.id)).for("update");
                    if (!current) throw new HttpError(503, "service_unavailable", "钱包记录不存在，请稍后重试");
                    const [existing] = await tx.select().from(walletLedger)
                        .where(and(eq(walletLedger.userId, target.id), eq(walletLedger.idempotencyKey, idempotencyKey))).limit(1);
                    if (existing) {
                        const existingReason = record(existing.metadata) && typeof existing.metadata.reason === "string" ? existing.metadata.reason : null;
                        if (compareCreditAmounts(existing.deltaAvailableUnits, input.amount) !== 0 || existingReason !== input.reason) throw new HttpError(409, "idempotency_conflict", "幂等键已用于其他余额调整");
                        return { current, ledger: existing };
                    }
                    const availableUnits = addCreditAmounts(current.availableUnits, input.amount);
                    if (compareCreditAmounts(availableUnits, "0") < 0) throw new HttpError(409, "insufficient_balance", "余额不足，不能扣减到负数");
                    // Verify the total is representable before committing an adjustment.
                    addCreditAmounts(availableUnits, current.reservedUnits);
                    const now = new Date();
                    const nextVersion = current.version + 1;
                    if (!Number.isSafeInteger(nextVersion)) throw new HttpError(409, "version_exhausted", "钱包版本已达到上限");
                    await tx.update(walletTable).set({ availableUnits, version: nextVersion, updatedAt: now })
                        .where(eq(walletTable.userId, target.id));
                    const [ledger] = await tx.insert(walletLedger).values({
                        id: crypto.randomUUID(), userId: target.id, kind: "adjustment",
                        deltaAvailableUnits: input.amount, deltaReservedUnits: "0",
                        availableUnitsAfter: availableUnits, reservedUnitsAfter: current.reservedUnits,
                        idempotencyKey, referenceType: "admin_adjustment", referenceId: requestId,
                        actorId: principal.id, metadata: { reason: input.reason },
                    }).returning();
                    if (!ledger) throw new HttpError(503, "service_unavailable", "余额流水写入失败，请稍后重试");
                    await tx.insert(auditEvent).values({
                        id: crypto.randomUUID(), actorId: principal.id, action: "user.balance.adjusted",
                        resourceId: target.id, revision: nextVersion, requestId,
                    });
                    return { current: { ...current, availableUnits, version: nextVersion, updatedAt: now }, ledger };
                });
                return respond({ wallet: {
                    unit: "credit", availableUnits: normalizeCreditAmount(result.current.availableUnits)!,
                    reservedUnits: normalizeCreditAmount(result.current.reservedUnits)!,
                    totalUnits: addCreditAmounts(result.current.availableUnits, result.current.reservedUnits),
                    version: result.current.version, createdAt: result.current.createdAt.toISOString(), updatedAt: result.current.updatedAt.toISOString(),
                }, ledger: {
                    id: result.ledger.id, kind: result.ledger.kind, deltaAvailableUnits: normalizeCreditAmount(result.ledger.deltaAvailableUnits)!,
                    deltaReservedUnits: normalizeCreditAmount(result.ledger.deltaReservedUnits)!, availableUnitsAfter: normalizeCreditAmount(result.ledger.availableUnitsAfter)!,
                    reservedUnitsAfter: normalizeCreditAmount(result.ledger.reservedUnitsAfter)!, referenceType: result.ledger.referenceType,
                    referenceId: result.ledger.referenceId, createdAt: result.ledger.createdAt.toISOString(),
                }, requestId });
            }
            if (adminProviderModelsPath) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ models: await listDiscoveredProviderModels(options.database), requestId });
            }
            if (adminProviderDiscoverId !== null) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method !== "POST" || !compactId.safeParse(adminProviderDiscoverId).success) throw new HttpError(405, "method_not_allowed", "不支持此操作");
                const input = parse(providerDiscoverSchema, await readJson(request, policy.documentBytes));
                if (!session.sessionContext) throw new HttpError(401, "unauthorized", "请重新登录");
                const actor = { actorId: principal.id, sessionId: session.sessionContext.id, sessionExpiresAt: session.sessionContext.expiresAt };
                const target = await prepareProviderDiscovery(options.database, options.auth.secret, adminProviderDiscoverId, input, actor);
                const result = await providerGateway.listModels(target);
                if (result.status === "unknown") throw new HttpError(502, "provider_unavailable", "渠道连接失败，请检查地址、网络和 Key；原配置未改变");
                if (result.status === "failed") throw new HttpError(502, result.code, result.code === "provider_rejected" ? "渠道未通过连接测试，请检查地址和 Key" : "渠道模型目录格式无法识别或存在未读取分页，未导入部分结果");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ ...await recordProviderDiscovery(options.database, options.auth.secret, target, input.revision, result.models, actor), requestId });
            }
            if (adminProviderTestId !== null) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (request.method !== "POST" || !compactId.safeParse(adminProviderTestId).success) {
                    throw new HttpError(405, "method_not_allowed", "不支持此操作");
                }
                const [provider] = await options.database.select({ id: modelProvider.id, adapter: modelProvider.adapter, endpoint: modelProvider.endpoint })
                    .from(modelProvider).where(and(eq(modelProvider.id, adminProviderTestId), isNull(modelProvider.deletedAt))).limit(1);
                if (!provider) throw new HttpError(404, "provider_not_found", "供应商不存在");
                const credential = await loadProviderCredential(options.database, options.auth.secret, provider.id);
                if (!credential) throw new HttpError(409, "provider_credential_required", "供应商尚未配置 API Key");
                const result = await providerGateway.listModels({
                    providerId: provider.id, adapter: provider.adapter, endpoint: provider.endpoint, credential,
                });
                if (result.status === "unknown") throw new HttpError(502, "provider_unavailable", "供应商连接测试失败，请检查地址、网络和 Key");
                if (result.status === "failed") throw new HttpError(502, result.code, result.code === "provider_rejected" ? "供应商未通过连接测试，请检查地址和 Key" : "供应商返回的数据格式无法识别");
                const configuredModels = await options.database.select({
                    id: modelCatalog.publicId,
                    displayName: modelCatalog.displayName,
                    providerModel: modelCatalog.providerModel,
                    enabled: modelCatalog.enabled,
                }).from(modelCatalog)
                    .where(and(eq(modelCatalog.providerId, provider.id), isNull(modelCatalog.deletedAt)))
                    .orderBy(asc(modelCatalog.displayName), asc(modelCatalog.publicId));
                const upstreamModels = new Set(result.models);
                return respond({
                    providerId: provider.id,
                    models: result.models,
                    bindings: configuredModels.map((model) => ({
                        id: model.id,
                        displayName: model.displayName,
                        providerModel: model.providerModel,
                        enabled: model.enabled,
                        found: upstreamModels.has(model.providerModel),
                    })),
                    requestId,
                });
            }
            if (adminProvidersPath || adminProviderId !== null) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (adminProvidersPath && request.method === "GET") {
                    responseHeaders.set("cache-control", "private, no-store");
                    return respond({ items: await listAdminProviders(options.database), requestId });
                }
                if (adminProviderId !== null && compactId.safeParse(adminProviderId).success && request.method === "DELETE") {
                    const input = parse(z.strictObject({ revision: z.number().int().min(1).max(2_147_483_646) }), await readJson(request, policy.documentBytes));
                    const deleted = await deleteCatalogProvider(options.database, adminProviderId, input.revision, safetyRequestActor());
                    return respond({ deleted, requestId });
                }
                if (adminProviderId === null || !compactId.safeParse(adminProviderId).success || request.method !== "PUT") {
                    throw new HttpError(405, "method_not_allowed", "不支持此操作");
                }
                const providerId = adminProviderId;
                const input = parse(providerWriteSchema, await readJson(request, policy.documentBytes));
                if (!session.sessionContext) throw new HttpError(401, "unauthorized", "请重新登录");
                const provider = await saveDiscoveredProvider(options.database, options.auth.secret, providerId, input,
                    { actorId: principal.id, sessionId: session.sessionContext.id, sessionExpiresAt: session.sessionContext.expiresAt, requestId });
                return respond({ provider, requestId });
            }
            if (adminModelPublicId !== null) {
                if (principal.role !== "admin") throw new HttpError(403, "forbidden", "需要管理员权限");
                requireAccountContext();
                if (compactId.safeParse(adminModelPublicId).success && request.method === "DELETE") {
                    const input = parse(z.strictObject({ revision: z.number().int().min(1).max(2_147_483_646) }), await readJson(request, policy.documentBytes));
                    const deleted = await deleteCatalogModel(options.database, adminModelPublicId, input.revision, safetyRequestActor());
                    return respond({ deleted, requestId });
                }
                if (request.method !== "PUT" || !compactId.safeParse(adminModelPublicId).success) throw new HttpError(405, "method_not_allowed", "不支持此操作");
                const publicId = adminModelPublicId;
                const input = parse(modelWriteSchema, await readJson(request, policy.documentBytes));
                if (!session.sessionContext) throw new HttpError(401, "unauthorized", "请重新登录");
                await saveNodeModel(options.database, publicId, input, { actorId: principal.id, sessionId: session.sessionContext.id, sessionExpiresAt: session.sessionContext.expiresAt, requestId });
                const model = (await listAdminModels(options.database)).find(item => item.id === publicId);
                if (!model) throw new HttpError(503, "service_unavailable", "模型保存后读取失败，请重新读取核对");
                return respond({ model, requestId });
            }
            if (walletPath) {
                requireAccountContext();
                if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                if (path === "/api/v1/wallet") return respond({ wallet: await wallet.get(principal.id), requestId });
                const query = url.searchParams.get("limit");
                if (url.searchParams.has("limit") && (!query || !/^\d+$/.test(query))) {
                    throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                }
                const limit = query ? Number(query) : 50;
                if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                    throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                }
                return respond({ items: await wallet.listLedger(principal.id, limit), requestId });
            }
            if (sharingPath) {
                requireAccountContext();
                responseHeaders.set("cache-control", "private, no-store");
                if (url.search) throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                const notFound = () => new HttpError(404, "not_found", "画布不存在");
                if (joinMatch) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const token = joinMatch[1].toLowerCase();
                    if (!z.uuid().safeParse(token).success) throw notFound();
                    parse(z.strictObject({}), await readJson(request, policy.documentBytes));
                    const result = await withActiveWrite(false, async (tx) => {
                        const joined = await createCanvasSharingRepository(tx).join(principal.id, token);
                        if (joined.status === "joined" && !joined.alreadyJoined) {
                            await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: principal.id,
                                action: "canvas.member.joined", resourceId: joined.canvasId, revision: 1, requestId });
                        }
                        return joined;
                    });
                    if (result.status !== "joined") throw notFound();
                    return respond({ member: result.member, requestId });
                }
                if (!sharingMatch) throw notFound();
                const id = sharingMatch[1].toLowerCase();
                const action = sharingMatch[2];
                const encodedUserId = sharingMatch[3];
                if (!z.uuid().safeParse(id).success || (encodedUserId && action !== "members")) throw notFound();
                if (action === "share" && !encodedUserId && request.method === "GET") {
                    const result = await options.database.transaction((tx) => createCanvasSharingRepository(tx).getShare(principal.id, id));
                    if (result.status !== "found") throw notFound();
                    return respond({ share: result.share, members: result.members, requestId });
                }
                if (action === "share-link" && !encodedUserId && request.method === "POST") {
                    const input = parse(shareLinkSchema, await readJson(request, policy.documentBytes));
                    const result = await withActiveWrite(false, async (tx) => {
                        const shared = await createCanvasSharingRepository(tx).shareLink(principal.id, id, input);
                        if (shared.status === "saved" && (shared.created || input.reset)) {
                            await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: principal.id,
                                action: shared.created ? "canvas.share.created" : "canvas.share.reset",
                                resourceId: shared.share.id, revision: 1, requestId });
                        }
                        return shared;
                    });
                    if (result.status === "not_found") throw notFound();
                    if (result.status === "reset_required") throw new HttpError(409, "share_reset_required", "更换链接权限时请明确重置链接");
                    if (result.status !== "saved") throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                    return respond({ share: result.share, requestId });
                }
                if (action === "members" && !encodedUserId && request.method === "POST") {
                    const input = parse(memberWriteSchema, await readJson(request, policy.documentBytes));
                    const result = await withActiveWrite(false, async (tx) => {
                        const member = await createCanvasSharingRepository(tx).upsertMember(principal.id, id, input);
                        if (member.status === "saved") await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: principal.id,
                            action: "canvas.member.updated", resourceId: id, revision: 1, requestId });
                        return member;
                    });
                    if (result.status === "not_found") throw notFound();
                    if (result.status !== "saved") throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                    return respond({ member: result.member, requestId });
                }
                if (action === "members" && encodedUserId && request.method === "DELETE") {
                    if (request.body) throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                    let userId: string;
                    try { userId = decodeURIComponent(encodedUserId); } catch { throw new HttpError(400, "invalid_input", "请求字段或格式不正确"); }
                    const result = await withActiveWrite(false, async (tx) => {
                        const removed = await createCanvasSharingRepository(tx).removeMember(principal.id, id, userId);
                        if (removed.status === "removed" && removed.removed) await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: principal.id,
                            action: "canvas.member.removed", resourceId: id, revision: 1, requestId });
                        return removed;
                    });
                    if (result.status === "not_found") throw notFound();
                    if (result.status !== "removed") throw new HttpError(400, "invalid_input", "请求字段或格式不正确");
                    return respond({ ok: true, requestId });
                }
                throw new HttpError(405, "method_not_allowed", "不支持此操作");
            }
            if (path === "/api/v1/canvases" || canvasId !== null || path === "/api/v1/media" || mediaResolvePath || mediaId !== null) {
                // Bind the request to the page's account if another tab replaced the session cookie.
                // This condition never grants ownership; repository access still uses principal.id.
                const accountId = request.headers.get("x-canvas-account-id");
                if (!accountId) throw new HttpError(400, "account_context_required", "缺少画布账号上下文，请重新确认登录状态");
                if (accountId !== principal.id) throw new HttpError(409, "account_changed", "登录账号已变化，本次画布操作未执行，请重新确认账号");
            }
            if (path === "/api/v1/media" || mediaResolvePath || mediaId !== null) {
                if (!media) throw new HttpError(503, "cloud_unavailable", "云端素材暂未开启，请保留本机素材");
                const query: Record<string, string> = Object.create(null);
                for (const [key, value] of url.searchParams) {
                    if (Object.hasOwn(query, key)) throw new HttpError(400, "invalid_input", "重复的查询参数");
                    query[key] = value;
                }
                const scope = parse(z.strictObject({ canvasId: z.uuid().transform((value) => value.toLowerCase()).optional() }), query).canvasId;
                if (scope) {
                    responseHeaders.set("cache-control", "private, no-store");
                    if (options.cloudCanvas !== true) throw new HttpError(503, "cloud_unavailable", "云端画布暂未开启，请保留本机作品");
                    if (!(mediaResolvePath && request.method === "POST") && !(mediaId && !mediaResolvePath && request.method === "GET")) {
                        throw new HttpError(400, "invalid_input", "画布范围仅用于素材解析和读取");
                    }
                }
                if (mediaResolvePath) {
                    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "不支持此操作");
                    const input = parse(mediaResolveSchema, await readJson(request, policy.documentBytes));
                    const items = scope ? await options.database.transaction(async (tx) => {
                        const allowed = await createCanvasSharingRepository(tx).lockAccess(principal.id, scope, "read");
                        if (!allowed) throw new HttpError(404, "not_found", "画布不存在");
                        return createMediaRepository(tx).resolveReferenced(input.ids, allowed.draft.document);
                    }) : await media.repository.resolve(principal.id, input.ids);
                    const found = new Set(items.map((item) => item.id));
                    return respond({ items: items.map((item) => mediaView(item, scope)), missing: input.ids.filter((id) => !found.has(id)), requestId });
                }
                if (path === "/api/v1/media" && request.method === "GET") {
                    const [quota, items] = await Promise.all([media.repository.getQuota(principal.id, media.quotaBytes), media.repository.list(principal.id)]);
                    return respond({ quota, items: items.map((item) => mediaView(item)) });
                }
                if (path === "/api/v1/media" && request.method === "POST") {
                    const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
                    const kind = mediaKind(contentType);
                    if (!kind) throw new HttpError(415, "unsupported_media_type", "只支持图片、视频或音频文件");
                    const body = await readBytes(request, media.maxBytes[kind]);
                    const id = crypto.randomUUID();
                    const key = objectKey(`accounts/${Buffer.from(principal.id).toString("base64url")}/media/${id}`);
                    let storageWriteAttempted = false;
                    let saved: MediaRecord;
                    try {
                        saved = await withActiveWrite(false, async tx => {
                            storageWriteAttempted = true;
                            const stored = await media.storage.put({ key, body, contentType });
                            const repository = createMediaRepository(tx);
                            const created = await repository.add(principal.id, { id, objectKey: stored.key, kind, contentType, sizeBytes: stored.sizeBytes, etag: stored.etag });
                            if (!await repository.reserve(principal.id, stored.sizeBytes, media.quotaBytes)) {
                                throw new HttpError(413, "quota_exceeded", "云端容量不足，请购买扩容后再上传");
                            }
                            return created;
                        });
                    } catch (error) {
                        // A lost COMMIT response must not delete a durable object.
                        if (storageWriteAttempted && await media.repository.get(principal.id, id).catch(() => undefined) === null) {
                            await media.storage.delete(key).catch(() => undefined);
                        }
                        throw error;
                    }
                    // The media row has committed; response reads must not undo its object or quota.
                    return respond({ media: mediaView(saved), quota: await media.repository.getQuota(principal.id, media.quotaBytes), requestId }, 201);
                }
                if (mediaId === null || !z.uuid().safeParse(mediaId).success) throw new HttpError(404, "not_found", "素材不存在");
                const download = async (item: MediaRecord) => {
                    const key = objectKey(item.objectKey);
                    const stored = await media.storage.get(key);
                    // A readable object can still be the wrong restore. Check the
                    // actual bytes as well as adapter metadata against the DB record.
                    if (!stored || stored.metadata.key !== key || stored.body.byteLength !== item.sizeBytes ||
                        stored.metadata.sizeBytes !== item.sizeBytes || stored.metadata.contentType !== item.contentType ||
                        stored.metadata.etag !== item.etag || await computeObjectEtag(stored.body) !== item.etag) {
                        throw new HttpError(503, "service_unavailable", "素材暂时不可读取，请稍后重试");
                    }
                    const headers = new Headers(responseHeaders);
                    for (const [name, value] of Object.entries({ "content-type": stored.metadata.contentType, "content-length": String(stored.body.byteLength), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline", "x-request-id": requestId, "referrer-policy": "no-referrer" })) headers.set(name, value);
                    return new Response(stored.body, { status: 200, headers });
                };
                if (request.method === "GET" && scope) {
                    // Hold the canvas and media locks through storage verification.
                    // Revocation/deletion waits until this authorized read is prepared.
                    return await options.database.transaction(async (tx) => {
                        const allowed = await createCanvasSharingRepository(tx).lockAccess(principal.id, scope, "read");
                        if (!allowed) throw new HttpError(404, "not_found", "素材不存在");
                        const [item] = await createMediaRepository(tx).resolveReferenced([mediaId], allowed.draft.document);
                        if (!item) throw new HttpError(404, "not_found", "素材不存在");
                        return download(item);
                    });
                }
                const item = await media.repository.get(principal.id, mediaId);
                if (!item) throw new HttpError(404, "not_found", "素材不存在");
                if (request.method === "GET") return await download(item);
                if (request.method === "DELETE") {
                    type StoredObject = NonNullable<Awaited<ReturnType<ObjectStorage["get"]>>>;
                    let deletedObject: { key: ReturnType<typeof objectKey>; stored: StoredObject } | null = null;
                    // Register recovery before delete: a storage failure can mean
                    // the object was deleted but its acknowledgement was lost.
                    // Keep the copy until the database transaction commits too.
                    const restoreDeletedObject = async () => {
                        const pending = deletedObject;
                        if (!pending) return true;
                        deletedObject = null;
                        try {
                            const restored = await media.storage.put({ key: pending.key, body: pending.stored.body, contentType: pending.stored.metadata.contentType });
                            if (restored.key !== pending.key || restored.etag !== pending.stored.metadata.etag ||
                                restored.sizeBytes !== pending.stored.metadata.sizeBytes || restored.contentType !== pending.stored.metadata.contentType) throw new Error("对象恢复元数据不一致");
                            return true;
                        } catch {
                            return false;
                        }
                    };
                    try {
                        await withActiveWrite(false, async (tx) => {
                            const transactionMedia = createMediaRepository(tx);
                            const locked = await transactionMedia.getForDelete(principal.id, mediaId);
                            if (!locked) throw new HttpError(404, "not_found", "素材不存在");
                            // Keep the media row locked while checking references and
                            // deleting it. Cloud saves hold a key-share lock until
                            // their draft transaction commits, so these operations
                            // cannot race into a dangling cloudMediaId.
                            const references = await createDraftRepository(tx).findMediaReferences(principal.id, mediaId);
                            if (references.length) throw new HttpError(409, "media_referenced", "该素材仍被云端画布引用，请先解除引用后再删除");
                            const key = objectKey(locked.objectKey);
                            // Keep a copy so a database failure can restore the object after
                            // OSS deletion. A missing object is an integrity failure; retain
                            // the DB row so an operator can repair it instead of hiding it.
                            let stored: Awaited<ReturnType<ObjectStorage["get"]>>;
                            try {
                                stored = await media.storage.get(key);
                            } catch {
                                throw new HttpError(503, "service_unavailable", "素材暂时不可读取，请稍后重试");
                            }
                            if (!stored) throw new HttpError(503, "service_unavailable", "素材暂时不可读取，请稍后重试");
                            deletedObject = { key, stored };
                            try {
                                await media.storage.delete(key);
                            } catch {
                                // Restore while the media row is still locked, so
                                // another delete cannot race this compensation.
                                if (!await restoreDeletedObject()) throw new HttpError(503, "service_unavailable", "素材删除状态待恢复，请稍后重试");
                                throw new HttpError(503, "service_unavailable", "素材删除暂时不可用，请稍后重试");
                            }
                            try {
                                const removed = await transactionMedia.removeAndReleaseInTransaction(tx, principal.id, mediaId);
                                if (!removed) throw new Error("素材记录未删除");
                            } catch {
                                if (!await restoreDeletedObject()) throw new HttpError(503, "service_unavailable", "素材删除状态待恢复，请稍后重试");
                                throw new HttpError(503, "service_unavailable", "素材删除暂时不可用，请稍后重试");
                            }
                        });
                    } catch (error) {
                        // This also covers a commit failure that happens after the
                        // callback has deleted the row and object.
                        if (!await restoreDeletedObject()) throw new HttpError(503, "service_unavailable", "素材删除状态待恢复，请稍后重试");
                        throw error;
                    }
                    return respond({ ok: true, quota: await media.repository.getQuota(principal.id, media.quotaBytes), requestId });
                }
                throw new HttpError(405, "method_not_allowed", "不支持此操作");
            }
            if (path === "/api/v1/canvases" && request.method === "GET") {
                const query: Record<string, string> = Object.create(null);
                for (const [key, value] of url.searchParams) {
                    if (Object.hasOwn(query, key)) throw new HttpError(400, "invalid_input", "重复的查询参数");
                    query[key] = value;
                }
                const page = parse(z.strictObject({
                    limit: z.string().regex(/^\d+$/).transform(Number).pipe(positive.max(policy.pageSize)).optional(),
                    cursor: z.string().optional(),
                }), query);
                let before: z.infer<typeof cursorSchema> | undefined;
                if (page.cursor) {
                    try { before = parse(cursorSchema, JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8"))); }
                    catch { throw new HttpError(400, "invalid_cursor", "列表游标无效"); }
                }
                const result = await drafts.listPage(principal.id, { limit: page.limit ?? policy.pageSize, before });
                return respond({ items: result.items, nextCursor: result.next ? Buffer.from(JSON.stringify(result.next)).toString("base64url") : null });
            }
            if (canvasId !== null && !z.uuid().safeParse(canvasId).success) throw new HttpError(404, "not_found", "画布不存在");
            if (canvasId && request.method === "GET") {
                const allowed = await options.database.transaction((tx) => createCanvasSharingRepository(tx).lockAccess(principal.id, canvasId, "read"));
                if (!allowed) throw new HttpError(404, "not_found", "画布不存在");
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ ...allowed, requestId });
            }
            if ((path === "/api/v1/canvases" && request.method === "POST") || (canvasId && request.method === "PUT")) {
                const input = await readJson(request, policy.documentBytes);
                const parsed = canvasId ? parse(saveSchema, input) : parse(createSchema, input);
                const cloudMediaIds = collectCloudMediaIds(parsed.document);
                if (cloudMediaIds.length) {
                    if (!media || cloudMediaIds.some((id) => !cloudMediaIdPattern.test(id))) throw new HttpError(400, "invalid_input", "画布含未归属媒体或未完成任务引用，暂不能进行云端 JSON 保存");
                }
                const result = await withActiveWrite(false, async (tx) => {
                    const repository = createDraftRepository(tx);
                    const allowed = canvasId ? await createCanvasSharingRepository(tx).lockAccess(principal.id, canvasId, "write") : null;
                    if (canvasId && !allowed) return { status: "not_found" as const };
                    const ownedCloudMediaIds = new Set<string>();
                    if (cloudMediaIds.length) {
                        // Hold key-share locks through the draft write. Media DELETE
                        // takes the matching update lock, so whichever operation wins
                        // first cannot leave a dangling cloudMediaId reference.
                        const owned = allowed
                            ? await createMediaRepository(tx).resolveForCanvasSave(principal.id, cloudMediaIds, allowed.draft.document)
                            : await createMediaRepository(tx).resolveForSave(principal.id, cloudMediaIds);
                        for (const item of owned) ownedCloudMediaIds.add(item.id.toLowerCase());
                    }
                    if (containsUnresolvedMedia(parsed.document, ownedCloudMediaIds)) {
                        throw new HttpError(400, "invalid_input", "画布含未归属媒体或未完成任务引用，暂不能进行云端 JSON 保存");
                    }
                    const saved = canvasId
                        // Access was checked for this actor and exact locked canvas.
                        // Its owner is used only for the existing canvas CAS predicate.
                        ? await repository.save(allowed!.access.ownerId, canvasId, parsed as z.infer<typeof saveSchema>)
                        : await repository.createOnce(principal.id, parsed as z.infer<typeof createSchema>);
                    if (saved.status === "saved") {
                        await tx.insert(auditEvent).values({
                            id: crypto.randomUUID(), actorId: principal.id, action: canvasId ? "canvas.saved" : "canvas.created",
                            resourceId: saved.draft.id, revision: saved.draft.revision, requestId,
                        });
                    }
                    return { ...saved, access: allowed?.access ?? { role: "owner" as const, ownerId: principal.id, readOnly: false } };
                });
                if (result.status === "not_found") throw new HttpError(404, "not_found", "画布不存在");
                if (result.status === "exists") throw new HttpError(409, "creation_exists", "这次创建已有记录，请先核对云端草稿，不要重复创建");
                if (result.status === "conflict") return respond({ error: { code: "revision_conflict", message: "画布已有新版本，请保留本地修改后处理冲突" }, currentRevision: result.currentRevision, requestId }, 409);
                responseHeaders.set("cache-control", "private, no-store");
                return respond({ draft: result.draft, access: result.access, requestId }, canvasId ? 200 : 201);
            }
            throw new HttpError(405, "method_not_allowed", "不支持此操作");
        } catch (error) {
            const failure = error instanceof HttpError ? error
                : error instanceof MappingPublicationError ? new HttpError(error.code === "mapping_publication_invalid" ? 400 : 409, error.code, error.message)
                : error instanceof ModelMappingDraftError ? new HttpError(error.code === "mapping_invalid" ? 400 : 409, error.code, error.message)
                : error instanceof CatalogDeletionError ? new HttpError(error.code === "catalog_not_found" ? 404 : 409, error.code, error.message)
                : error instanceof NodeModelConfigurationError ? new HttpError(error.code === "provider_not_found" || error.code === "model_group_invalid" ? 400 : 409, error.code, error.message)
                : error instanceof ProviderDiscoveryError ? new HttpError(error.code === "provider_credential_required" ? 400 : 409, error.code, error.message)
                : error instanceof GenerationContractError ? new HttpError(
                    error.code === "price_changed" ? 409 : 400,
                    error.code,
                    error.message,
                )
                : error instanceof GenerationTaskError ? new HttpError(error.code === "idempotency_conflict" || error.code === "model_unavailable" ? 409 : 400, error.code, error.message)
                : error instanceof GenerationQueryError ? new HttpError(error.code === "not_found" ? 404 : 400, error.code, error.message)
                : new HttpError(503, "service_unavailable", "服务暂时不可用，请稍后再试");
            if (failure.status >= 500) {
                // Explicit categories only: never pass provider errors, URLs, email or stacks to the sink.
                const code = failure.code === "mail_unavailable" ? "mail_unavailable"
                    : failure.code === "auth_rejected" ? "auth_unavailable" : "service_unavailable";
                try { options.onFault({ requestId, component: "accounts", code }); } catch { /* Keep the safe response if logging fails. */ }
            }
            if (failure.retryAfter) responseHeaders.set("retry-after", String(failure.retryAfter));
            return respond({ error: { code: failure.code, message: failure.message }, requestId,
                ...(failure instanceof InspirationConflict ? { currentRevision: failure.currentRevision } : {}) }, failure.status);
        }
    };
}
