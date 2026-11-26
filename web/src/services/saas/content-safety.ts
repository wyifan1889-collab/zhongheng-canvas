import { z } from "zod/v4";

export type ContentSafetyScope = { accountId: string; epoch: number; role: "user" | "admin" };
const version = z.number().int().nonnegative().refine(Number.isSafeInteger);
const text = z.string().trim().min(1);
const time = z.iso.datetime({ offset: true });
const uuid = z.uuid().transform(value => value.toLowerCase());
const reportSchema = z.strictObject({
    id: uuid, subject: text, details: text, status: z.enum(["submitted", "received"]),
    revision: version.refine(value => value > 0), createdAt: time, receivedAt: time.nullable(),
}).refine(value => (value.status === "received") === (value.receivedAt !== null));
const moderationSchema = z.strictObject({ userId: text, disabled: z.boolean(), moderationVersion: version });
const operationSchema = z.strictObject({ operationId: uuid, targetUserId: text, disabled: z.boolean(), revision: version.refine(value => value > 0), createdAt: time });
const reportInputSchema = z.strictObject({ id: uuid, subject: text, details: text });
const moderationInputSchema = z.strictObject({ operationId: uuid, disabled: z.boolean(), expectedVersion: version, reason: text });
const itemResponse = <T extends z.ZodType>(item: T) => z.strictObject({ item, requestId: text.optional() });
const reportPageSchema = z.strictObject({ items: z.array(reportSchema), nextCursor: text.nullable(), requestId: text.optional() });
const policyVersion = z.number().int().min(0).max(2_147_483_647);
const positive = policyVersion.positive();
const duration = version.refine(value => value > 0 && Number.isSafeInteger(value * 1000) && Number.isSafeInteger(Date.now() + value * 1000));
const writableRateSchema = z.strictObject({ enabled: z.boolean(), points: positive });
const rateSchema = writableRateSchema.extend({ duration });
const policyWriteSchema = z.strictObject({ ip: writableRateSchema, user: writableRateSchema });
const policySchema = z.strictObject({ ip: rateSchema, user: rateSchema });
const settingsSchema = z.strictObject({
    revision: policyVersion, publicationId: uuid.nullable(), source: z.enum(["server-default", "published"]), policy: policySchema,
    modelRates: z.array(z.strictObject({ modelId: text.refine(value => !/\s|[\u0000-\u001f\u007f]/.test(value)), points: positive, duration })),
    checkpointMode: z.enum(["off", "record"]),
}).refine(value => value.source === "server-default" ? value.revision === 0 && value.publicationId === null : value.revision > 0 && value.publicationId !== null)
    .refine(value => new Set(value.modelRates.map(rule => rule.modelId)).size === value.modelRates.length);
const settingsWriteSchema = z.strictObject({ operationId: uuid, expectedRevision: policyVersion, policy: policyWriteSchema });
const publicationSchema = z.strictObject({ operationId: uuid, publishedRevision: positive, policy: policySchema, createdAt: time });
const settingsResponseSchema = z.strictObject({ config: settingsSchema, requestId: text.optional() });
const publicationResponseSchema = z.strictObject({ receipt: publicationSchema, requestId: text.optional() });
export type AbuseReportView = z.infer<typeof reportSchema>;
export type AbuseReportInput = z.infer<typeof reportInputSchema>;
export type ModerationState = z.infer<typeof moderationSchema>;
export type ModerationReceipt = z.infer<typeof operationSchema>;
export type ModerationWrite = z.infer<typeof moderationInputSchema>;
export type AbuseReportPage = { items: AbuseReportView[]; nextCursor: string | null };
export type GenerationSafetyPolicy = z.infer<typeof policySchema>;
export type GenerationSafetySettings = z.infer<typeof settingsSchema>;
export type GenerationSafetyPolicyWrite = z.infer<typeof settingsWriteSchema>;
export type GenerationSafetyPublication = z.infer<typeof publicationSchema>;

export class ContentSafetyError extends Error {
    constructor(readonly code: string, message: string, readonly status = 0,
        readonly outcome: "not-sent" | "rejected" | "unknown" = "unknown") { super(message); }
}
const invalid = () => new ContentSafetyError("invalid_input", "请核对填写内容和回执编号，原输入已保留。", 0, "not-sent");
const unknown = (writing: boolean, status = 0) => new ContentSafetyError(writing ? "result_unknown" : "read_failed", writing
    ? "提交结果尚未确认，请保留原编号并查询，不要重复提交。" : "读取未完成，请保留输入并手动重试。", status);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Bound to one account lifetime. Unknown writes can only be reconciled by GET. */
export function createContentSafetyClient(options: {
    scope: ContentSafetyScope; getScope: () => ContentSafetyScope | null; fetcher?: typeof fetch; onAccountInvalidated?: () => void;
}) {
    const scope = Object.freeze({ ...options.scope }), unresolved = new Set<string>(), controllers = new Set<AbortController>();
    let active = true;
    let settingsBaseline: GenerationSafetySettings | null = null, settingsBusy = false, settingsMinimumRevision = 0;
    let settingsPending: { input: GenerationSafetyPolicyWrite } | null = null;
    const settingsUsed = new Set<string>();
    function check(outcome: "not-sent" | "unknown" = "not-sent", admin = false) {
        const next = options.getScope();
        if (!active || !next || next.accountId !== scope.accountId || next.epoch !== scope.epoch || next.role !== scope.role) {
            active = false; for (const controller of controllers) controller.abort();
            throw new ContentSafetyError("context_changed", "账户状态已变化，原账户的结果不会显示；已发送的操作请用原账户核对。", 0, outcome);
        }
        if (admin && scope.role !== "admin") throw new ContentSafetyError("forbidden", "需要管理员权限。", 403, "not-sent");
    }
    async function request<T>(path: string, method: "GET" | "POST" | "PUT", schema: z.ZodType<T>, body?: object, admin = false): Promise<T> {
        check("not-sent", admin);
        const controller = new AbortController(), writing = method !== "GET"; controllers.add(controller);
        try {
            const response = await (options.fetcher ?? fetch)(path, {
                method, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            check("unknown", admin);
            if (!response.headers.get("content-type")?.includes("application/json")) throw unknown(writing, response.status);
            const data: unknown = await response.json(); check("unknown", admin);
            if (!response.ok) {
                const code = record(data) && record(data.error) && typeof data.error.code === "string" ? data.error.code : "";
                if (response.status === 401 || response.status === 400 && code === "account_context_required" || response.status === 409 && code === "account_changed") {
                    active = false;
                    options.onAccountInvalidated?.();
                    throw new ContentSafetyError("context_changed", "登录或账户状态已变化，请重新确认原账户后核对。", response.status, "rejected");
                }
                const known: Record<number, string[]> = { 400: ["invalid_input", "invalid_cursor", "moderation_invalid", "report_invalid", "rate_settings_invalid"], 403: ["forbidden", "invalid_origin"],
                    404: ["not_found", "moderation_not_found", "report_not_found", "rate_settings_not_found"], 409: ["moderation_conflict", "operation_conflict", "report_conflict", "revision_conflict", "rate_settings_conflict"],
                    413: ["payload_too_large"], 429: ["rate_limited"], 503: ["content_safety_unavailable", "moderation_unavailable", "abuse_reports_unavailable"] };
                if (known[response.status]?.includes(code)) throw new ContentSafetyError(code, response.status === 503 ? "此功能尚未开放或暂不可用，原输入已保留。"
                    : response.status === 404 ? "原编号不存在或当前账户无权读取，请保留编号继续核对。"
                    : response.status === 409 ? "状态或操作编号已变化，请先读取最新状态，原输入已保留。"
                    : response.status === 403 ? "当前账户无权操作，请核对权限。"
                    : response.status === 429 ? "操作过于频繁，请保留输入，稍后手动重试。" : "请求已被拒绝，请核对填写内容，原输入已保留。", response.status, "rejected");
                throw unknown(writing, response.status);
            }
            const parsed = schema.safeParse(data);
            if (!parsed.success) throw unknown(writing, response.status);
            return parsed.data;
        } catch (error) {
            if (error instanceof ContentSafetyError && error.code === "context_changed") throw error;
            check(writing ? "unknown" : "not-sent", admin);
            throw error instanceof ContentSafetyError ? error : unknown(writing);
        } finally { controllers.delete(controller); }
    }
    function parse<T>(schema: z.ZodType<T>, input: unknown): T {
        const result = schema.safeParse(input); if (!result.success) throw invalid(); return result.data;
    }
    async function write<T>(key: string, action: () => Promise<T>): Promise<T> {
        if (unresolved.has(key)) throw unknown(true);
        unresolved.add(key);
        try { const result = await action(); unresolved.delete(key); return result; }
        catch (error) { if (error instanceof ContentSafetyError && error.outcome !== "unknown") unresolved.delete(key); throw error; }
    }
    function startSettings() {
        check("not-sent", true);
        if (settingsBusy) throw new ContentSafetyError("settings_busy", "设置读取或发布尚未完成，请等待结果。", 0, "not-sent");
        settingsBusy = true;
    }
    function validatePublication(receipt: GenerationSafetyPublication, id: string, pending = settingsPending) {
        if (receipt.operationId !== id || pending && (receipt.publishedRevision !== pending.input.expectedRevision + 1 ||
            (["ip", "user"] as const).some(dimension => receipt.policy[dimension].enabled !== pending.input.policy[dimension].enabled ||
                receipt.policy[dimension].points !== pending.input.policy[dimension].points))) throw unknown(true);
        settingsMinimumRevision = Math.max(settingsMinimumRevision, receipt.publishedRevision);
    }
    return {
        syncScope: () => check(),
        close() { active = false; for (const controller of controllers) controller.abort(); controllers.clear(); },
        getPendingSettingsOperation: () => settingsPending ? { operationId: settingsPending.input.operationId, expectedRevision: settingsPending.input.expectedRevision } : null,
        requiresSettingsRead: () => settingsBaseline === null,
        async readSettings(): Promise<GenerationSafetySettings> {
            if (settingsPending) throw new ContentSafetyError("settings_operation_pending", "原发布结果尚未确认，请先按原操作编号查询回执。", 0, "not-sent");
            startSettings();
            try {
                const { config } = await request("/api/v1/admin/content-safety/settings", "GET", settingsResponseSchema, undefined, true);
                if (config.revision < settingsMinimumRevision) throw unknown(false);
                settingsBaseline = config; return config;
            } finally { settingsBusy = false; }
        },
        async publishSettings(input: GenerationSafetyPolicyWrite): Promise<GenerationSafetyPublication> {
            check("not-sent", true); const body = parse(settingsWriteSchema, input);
            if (settingsPending) throw unknown(true);
            if (!settingsBaseline || body.expectedRevision !== settingsBaseline.revision) throw new ContentSafetyError("settings_read_required", "请先读取并核对当前设置版本。", 0, "not-sent");
            if (settingsUsed.has(body.operationId)) throw new ContentSafetyError("settings_intent_used", "此发布意图已发送，请按原编号核对，不能重复发布。", 0, "not-sent");
            startSettings(); settingsUsed.add(body.operationId); settingsPending = { input: body }; settingsBaseline = null;
            try {
                const { receipt } = await request("/api/v1/admin/content-safety/settings", "PUT", publicationResponseSchema, body, true);
                validatePublication(receipt, body.operationId); settingsPending = null; return receipt;
            } catch (error) {
                if (error instanceof ContentSafetyError && error.outcome !== "unknown") settingsPending = null;
                throw error;
            } finally { settingsBusy = false; }
        },
        async readSettingsOperation(operationId: string): Promise<GenerationSafetyPublication> {
            check("not-sent", true); operationId = parse(uuid, operationId);
            if (settingsPending && settingsPending.input.operationId !== operationId) throw new ContentSafetyError("settings_operation_pending", "请使用原发布操作编号核对，不能替换为其他编号。", 0, "not-sent");
            startSettings();
            try {
                const { receipt } = await request(`/api/v1/admin/content-safety/settings/operations/${operationId}`, "GET", publicationResponseSchema, undefined, true);
                validatePublication(receipt, operationId); settingsPending = null; settingsBaseline = null; return receipt;
            } finally { settingsBusy = false; }
        },
        async submitReport(input: AbuseReportInput): Promise<AbuseReportView> {
            const body = parse(reportInputSchema, input);
            return write(`report:${body.id}`, async () => {
                const { item } = await request("/api/v1/abuse-reports", "POST", itemResponse(reportSchema), body);
                if (item.id !== body.id || item.subject !== body.subject || item.details !== body.details) throw unknown(true);
                return item;
            });
        },
        async readOwnReport(id: string): Promise<AbuseReportView> {
            id = parse(uuid, id);
            const { item } = await request(`/api/v1/abuse-reports/${id}`, "GET", itemResponse(reportSchema));
            if (item.id !== id) throw unknown(false);
            unresolved.delete(`report:${id}`); return item;
        },
        async readModeration(userId: string): Promise<ModerationState> {
            userId = parse(text, userId);
            const { item } = await request(`/api/v1/admin/users/${encodeURIComponent(userId)}/moderation`, "GET", itemResponse(moderationSchema), undefined, true);
            if (item.userId !== userId) throw unknown(false); return item;
        },
        async setModeration(userId: string, input: ModerationWrite): Promise<ModerationReceipt> {
            userId = parse(text, userId); const body = parse(moderationInputSchema, input);
            return write(`moderation:${body.operationId}`, async () => {
                const { item } = await request(`/api/v1/admin/users/${encodeURIComponent(userId)}/moderation`, "PUT", itemResponse(operationSchema), body, true);
                if (item.operationId !== body.operationId || item.targetUserId !== userId || item.disabled !== body.disabled || item.revision !== body.expectedVersion + 1) throw unknown(true);
                return item;
            });
        },
        async readModerationOperation(id: string): Promise<ModerationReceipt> {
            id = parse(uuid, id);
            const { item } = await request(`/api/v1/admin/moderation/operations/${id}`, "GET", itemResponse(operationSchema), undefined, true);
            if (item.operationId !== id) throw unknown(false);
            unresolved.delete(`moderation:${id}`); return item;
        },
        async listReports(input: { cursor?: string; status?: "submitted" | "received" } = {}): Promise<AbuseReportPage> {
            const query = new URLSearchParams();
            if (input.cursor) query.set("cursor", input.cursor); if (input.status) query.set("status", input.status);
            const page = await request(`/api/v1/admin/abuse-reports${query.size ? `?${query}` : ""}`, "GET", reportPageSchema, undefined, true);
            if (new Set(page.items.map(item => item.id)).size !== page.items.length) throw unknown(false);
            return { items: page.items, nextCursor: page.nextCursor };
        },
        async receiveReport(id: string, expectedVersion: number): Promise<AbuseReportView> {
            id = parse(uuid, id); expectedVersion = parse(version, expectedVersion);
            return write(`receive:${id}`, async () => {
                const { item } = await request(`/api/v1/admin/abuse-reports/${id}/receipt`, "PUT", itemResponse(reportSchema), { expectedVersion }, true);
                if (item.id !== id || item.status !== "received" || item.revision !== expectedVersion + 1) throw unknown(true);
                return item;
            });
        },
        async readAdminReport(id: string): Promise<AbuseReportView> {
            id = parse(uuid, id);
            const { item } = await request(`/api/v1/admin/abuse-reports/${id}`, "GET", itemResponse(reportSchema), undefined, true);
            if (item.id !== id) throw unknown(false);
            if (item.status === "received") unresolved.delete(`receive:${id}`); return item;
        },
    };
}
export type ContentSafetyClient = ReturnType<typeof createContentSafetyClient>;
