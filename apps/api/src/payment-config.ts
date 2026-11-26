import { validatePaymentJson } from "./payment-provider-json";

export type PaymentRuntimeConfig = { enabled: false } | {
    enabled: true;
    timeoutMs: number;
    maxResponseBytes: number;
    paymentLinkOrigins: readonly string[];
};

/** Explicit technical safety settings only; there are no default offers, rates or request ceilings. */
export function readPaymentConfig(env: Record<string, string | undefined>): PaymentRuntimeConfig {
    if (env.SAAS_PAYMENTS_ENABLED === undefined || env.SAAS_PAYMENTS_ENABLED === "false") return { enabled: false };
    if (env.SAAS_PAYMENTS_ENABLED !== "true") throw new Error("SAAS_PAYMENTS_ENABLED 只能是 true 或 false");
    const integer = (name: string) => {
        const raw = env[name];
        if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} 必须明确配置为正安全整数`);
        return Number(raw);
    };
    const timeoutMs = integer("SAAS_PAYMENTS_TIMEOUT_MS");
    if (timeoutMs > 2_147_483_647) throw new Error("SAAS_PAYMENTS_TIMEOUT_MS 超出计时器可表示范围");
    const maxResponseBytes = integer("SAAS_PAYMENTS_JSON_MAX_BYTES");
    const raw = env.SAAS_PAYMENTS_LINK_ORIGINS;
    let origins: unknown;
    try {
        if (typeof raw !== "string" || !validatePaymentJson(raw).ok) throw new Error();
        origins = JSON.parse(raw);
        if (!Array.isArray(origins) || origins.some(origin => {
            if (typeof origin !== "string") return true;
            const url = new URL(origin);
            return url.protocol !== "https:" || url.origin !== origin || url.username || url.password ||
                url.pathname !== "/" || url.search || url.hash;
        }) || new Set(origins).size !== origins.length) throw new Error();
    } catch { throw new Error("SAAS_PAYMENTS_LINK_ORIGINS 必须明确配置为无重复的严格 HTTPS origin JSON 数组"); }
    return Object.freeze({ enabled: true, timeoutMs, maxResponseBytes, paymentLinkOrigins: Object.freeze([...(origins as string[])]) });
}
