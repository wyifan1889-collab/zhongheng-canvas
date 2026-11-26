import { z } from "zod/v4";
import { compareCreditAmounts, normalizeCreditAmount } from "../../../../packages/shared/src/credit-amounts";
import { parseAdminPaymentMerchant, parsePaymentConfiguration, type AdminPaymentMerchant, type PaymentConfigurationView, type PaymentMerchantWrite, type PaymentOffersWrite } from "../../../../packages/shared/src/payment-platform";

export type PaymentPlatformScope = { accountId: string; epoch: number; role: "user" | "admin" };
export class PaymentPlatformError extends Error {
    constructor(readonly code: string, message: string, readonly status = 0,
        readonly outcome: "not-sent" | "rejected" | "unknown" = "unknown") { super(message); }
}
const revision = z.number().int().min(0).max(2_147_483_647);
const text = z.string().trim().min(1);
const uuid = z.uuid().transform(value => value.toLowerCase());
const merchantSchema = z.strictObject({ expectedRevision: revision, merchantId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    merchantKey: z.string().min(1), paymentType: z.enum(["alipay", "wxpay"]),
    channelId: text.refine(value => !value.includes("&")).optional(), productName: text.refine(value => !value.includes("&")) });
const offersSchema = z.strictObject({ expectedRevision: revision, newOrdersEnabled: z.boolean(), items: z.array(z.strictObject({
    id: uuid, offerId: uuid, revision: revision.refine(value => value > 0), label: text,
    amountMinor: z.string().regex(/^[1-9][0-9]*$/),
    creditUnits: z.string().refine(value => normalizeCreditAmount(value) === value && compareCreditAmounts(value, "0") > 0),
    policyReference: text.optional(),
})) }).refine(value => new Set(value.items.map(item => item.id)).size === value.items.length &&
    new Set(value.items.map(item => item.offerId)).size === value.items.length &&
    (!value.newOrdersEnabled || value.items.length > 0 && value.items.every(item => item.policyReference)));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new PaymentPlatformError("invalid_input", "请核对填写内容、金额和保存意图编号，原输入已保留。", 0, "not-sent");
const unknown = (writing: boolean, status = 0) => new PaymentPlatformError(writing ? "outcome_unknown" : "read_failed", writing
    ? "保存结果尚未确认，请保留原输入并读取当前配置核对，不要重复保存。" : "读取未完成，原输入和已确认的保存结果已保留。", status);
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input); if (!result.success) throw invalid(); return result.data;
}
function configuration(value: unknown): PaymentConfigurationView | null {
    if (!record(value) || Object.keys(value).some(key => key !== "config" && key !== "requestId") ||
        value.requestId !== undefined && (typeof value.requestId !== "string" || !value.requestId)) return null;
    const config = parsePaymentConfiguration(value.config);
    return config && new Set(config.offers.map(item => item.id.toLowerCase())).size === config.offers.length &&
        new Set(config.offers.map(item => item.offerId.toLowerCase())).size === config.offers.length ? config : null;
}
type MerchantIntent = Omit<PaymentMerchantWrite, "merchantKey">;
function merchantReceipt(value: unknown, id: string, expected?: MerchantIntent): AdminPaymentMerchant | null {
    if (!record(value) || Object.keys(value).some(key => key !== "receipt" && key !== "requestId") ||
        value.requestId !== undefined && (typeof value.requestId !== "string" || !value.requestId)) return null;
    const receipt = parseAdminPaymentMerchant(value.receipt);
    return receipt && receipt.id.toLowerCase() === id && receipt.credentialConfigured && (!expected || receipt.merchantId === expected.merchantId &&
        receipt.paymentType === expected.paymentType && receipt.channelId === (expected.channelId ?? null) && receipt.productName === expected.productName) ? receipt : null;
}
function merchantWriteResult(value: unknown, id: string, expected: MerchantIntent): PaymentConfigurationView | null {
    if (!record(value) || Object.keys(value).some(key => !["config", "receipt", "requestId"].includes(key))) return null;
    return merchantReceipt({ receipt: value.receipt, requestId: value.requestId }, id, expected)
        ? configuration({ config: value.config, requestId: value.requestId }) : null;
}
function sameOffers(config: PaymentConfigurationView, input: PaymentOffersWrite): boolean {
    const byId = new Map(input.items.map(item => [item.id, item]));
    return config.revision > input.expectedRevision && config.newOrdersEnabled === input.newOrdersEnabled && config.offers.length === input.items.length &&
        config.offers.every(item => {
            const expected = byId.get(item.id.toLowerCase());
            return !!expected && item.offerId.toLowerCase() === expected.offerId && item.revision === expected.revision &&
                item.label === expected.label && item.amountMinor === expected.amountMinor && item.creditUnits === expected.creditUnits &&
                item.policyReference === (expected.policyReference ?? null);
        });
}

/** One administrator account lifetime; every write intent is sent at most once. */
export function createPaymentPlatformClient(options: { scope: PaymentPlatformScope; getScope: () => PaymentPlatformScope | null;
    fetcher?: typeof fetch; onAccountInvalidated?: () => void }) {
    const scope = Object.freeze({ ...options.scope }), controllers = new Set<AbortController>(), used = new Set<string>();
    let active = true, busy = false, requiresRead = true;
    let pending: { id: string; kind: "merchant" | "offers"; offers?: PaymentOffersWrite; merchant?: MerchantIntent } | null = null;
    function check(outcome: "not-sent" | "unknown" = "not-sent") {
        const current = options.getScope();
        if (!active || !current || current.accountId !== scope.accountId || current.epoch !== scope.epoch || current.role !== scope.role) {
            active = false; for (const controller of controllers) controller.abort();
            throw new PaymentPlatformError("context_changed", "账户状态已变化；已发送的保存请使用原账户核对。", 0, outcome);
        }
        if (scope.role !== "admin") throw new PaymentPlatformError("forbidden", "需要管理员权限。", 403, "not-sent");
    }
    async function request<T>(path: string, method: "GET" | "PUT", parser: (value: unknown) => T | null,
        body?: PaymentMerchantWrite | PaymentOffersWrite, intentId?: string): Promise<T> {
        check(); const controller = new AbortController(), writing = method === "PUT"; controllers.add(controller);
        try {
            const response = await (options.fetcher ?? fetch)(path, {
                method, credentials: "include", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}),
                    ...(intentId ? { "Idempotency-Key": intentId } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            check(writing ? "unknown" : "not-sent");
            if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw unknown(writing, response.status);
            const data: unknown = await response.json(); check(writing ? "unknown" : "not-sent");
            if (!response.ok) {
                const code = record(data) && record(data.error) && typeof data.error.code === "string" ? data.error.code : "";
                if (response.status === 401 || response.status === 400 && code === "account_context_required" || response.status === 409 && code === "account_changed") {
                    active = false; for (const other of controllers) other.abort(); options.onAccountInvalidated?.();
                    throw new PaymentPlatformError("context_changed", "登录或账户状态已变化，请重新确认原账户后核对。", response.status, "rejected");
                }
                const known: Record<number, string[]> = { 400: ["payment_invalid", "invalid_input"], 403: ["forbidden", "invalid_origin"],
                    404: ["payment_not_found"], 409: ["payment_config_conflict", "payment_idempotency_conflict"],
                    413: ["payload_too_large"], 415: ["unsupported_media_type"], 429: ["rate_limited"] };
                if (known[response.status]?.includes(code)) {
                    if (response.status === 409) requiresRead = true;
                    throw new PaymentPlatformError(code, response.status === 409 ? "配置版本已变化，请先读取当前配置核对，原输入已保留。"
                        : response.status === 404 ? "尚未读取到原保存回执，不代表未保存；请保留原输入继续核对。"
                        : response.status === 403 ? "当前账户无权操作，请核对权限。"
                        : response.status === 429 ? "操作过于频繁，请稍后手动读取核对。" : "请求已被拒绝，请核对填写内容。", response.status, "rejected");
                }
                throw unknown(writing, response.status);
            }
            const result = parser(data);
            if (!result) throw unknown(writing, response.status);
            return result;
        } catch (error) {
            if (error instanceof PaymentPlatformError && error.code === "context_changed") throw error;
            check(writing ? "unknown" : "not-sent");
            throw error instanceof PaymentPlatformError ? error : unknown(writing);
        } finally { controllers.delete(controller); }
    }
    function start() {
        check();
        if (busy) throw new PaymentPlatformError("operation_pending", "上一项读取或保存尚未完成，请等待结果。", 0, "not-sent");
        busy = true;
    }
    async function write(id: string, kind: "merchant" | "offers", body: PaymentMerchantWrite | PaymentOffersWrite) {
        check(); id = parse(uuid, id);
        if (pending) throw unknown(true);
        if (requiresRead) throw new PaymentPlatformError("configuration_read_required", "请先读取当前配置核对版本。", 0, "not-sent");
        if (used.has(id)) throw new PaymentPlatformError("intent_already_sent", "此保存意图已发送，请读取当前配置核对。", 0, "not-sent");
        const merchant = kind === "merchant" ? { expectedRevision: body.expectedRevision, merchantId: (body as PaymentMerchantWrite).merchantId,
            paymentType: (body as PaymentMerchantWrite).paymentType, channelId: (body as PaymentMerchantWrite).channelId, productName: (body as PaymentMerchantWrite).productName } : undefined;
        start(); used.add(id); pending = { id, kind, ...(kind === "offers" ? { offers: body as PaymentOffersWrite } : { merchant }) };
        try {
            const config = await request(`/api/v1/admin/payments/${kind}`, "PUT", kind === "merchant"
                ? value => merchantWriteResult(value, id, merchant!) : configuration, body, kind === "merchant" ? id : undefined);
            check("unknown");
            if (config.revision <= body.expectedRevision) throw unknown(true, 200);
            pending = null; requiresRead = false; return config;
        } catch (error) {
            if (error instanceof PaymentPlatformError && error.outcome !== "unknown") pending = null;
            else requiresRead = true;
            throw error;
        } finally { busy = false; }
    }
    return {
        syncScope() { check(); return true; },
        close() { active = false; for (const controller of controllers) controller.abort(); controllers.clear(); },
        getPendingIntent: () => pending ? { id: pending.id, kind: pending.kind } : null,
        requiresConfigurationRead: () => requiresRead,
        async readConfiguration(): Promise<PaymentConfigurationView> {
            start();
            try {
                const config = await request("/api/v1/admin/payments/config", "GET", configuration);
                check();
                requiresRead = false;
                if (pending?.offers && sameOffers(config, pending.offers)) pending = null;
                return config;
            } finally { busy = false; }
        },
        async readMerchantOperation(id: string): Promise<AdminPaymentMerchant> {
            id = parse(uuid, id); check();
            if (requiresRead) throw new PaymentPlatformError("configuration_read_required", "请先读取当前配置，再核对原商户保存回执。", 0, "not-sent");
            start();
            try {
                const expected = pending?.kind === "merchant" && pending.id === id ? pending.merchant : undefined;
                const receipt = await request(`/api/v1/admin/payments/merchant-operations/${id}`, "GET", value => merchantReceipt(value, id, expected));
                check();
                if (pending?.kind === "merchant" && pending.id === id) pending = null;
                return receipt;
            } finally { busy = false; }
        },
        saveMerchant: async (id: string, input: PaymentMerchantWrite) => write(id, "merchant", parse(merchantSchema, input)),
        saveOffers: async (id: string, input: PaymentOffersWrite) => write(id, "offers", parse(offersSchema, input)),
    };
}
export type PaymentPlatformClient = ReturnType<typeof createPaymentPlatformClient>;
