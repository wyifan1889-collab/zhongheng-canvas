import { compareCreditAmounts, normalizeCreditAmount } from "./credit-amounts";

export type PaymentType = "alipay" | "wxpay";
export type PaymentOfferView = { id: string; label: string; amountMinor: string; creditUnits: string; paymentType: PaymentType };
export type AdminPaymentOffer = { id: string; offerId: string; revision: number; label: string; amountMinor: string; creditUnits: string; policyReference: string | null };
export type AdminPaymentMerchant = { id: string; merchantId: string; paymentType: PaymentType; channelId: string | null; productName: string; credentialConfigured: boolean };
export type PaymentConfigurationView = { runtimeEnabled: boolean; revision: number; newOrdersEnabled: boolean; merchant: AdminPaymentMerchant | null; offers: AdminPaymentOffer[] };
export type PaymentMerchantWrite = { expectedRevision: number; merchantId: string; merchantKey: string; paymentType: PaymentType; channelId?: string; productName: string };
export type PaymentOffersWrite = { expectedRevision: number; items: Array<Omit<AdminPaymentOffer, "policyReference"> & { policyReference?: string }>; newOrdersEnabled: boolean };
export type PaymentOrderView = {
    id: string; currency: "CNY"; amountMinor: string; creditUnits: string; paymentType: PaymentType;
    createState: "pending" | "attempting" | "accepted" | "rejected" | "unknown";
    paymentState: "unknown" | "unpaid" | "paid"; creditState: "pending" | "credited";
    refundState: "none" | "pending_review" | "refunded"; paymentLinks: Record<string, string> | null;
    creditedAt: string | null; createdAt: string; updatedAt: string; lastReason: string | null;
};
export type AdminPaymentOrderView = PaymentOrderView & { ownerId: string; merchantVersionId: string; merchantOrderId: string;
    providerTradeNo: string | null; providerOrderId: string | null; creditedLedgerId: string | null };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (row: Record<string, unknown>, keys: readonly string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const type = (value: unknown): value is PaymentType => value === "alipay" || value === "wxpay";
const revision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
const minor = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const credits = (value: unknown): value is string => typeof value === "string" && normalizeCreditAmount(value) === value && compareCreditAmounts(value, "0") > 0;
const date = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try { return new Date(value).toISOString() === value; } catch { return false; }
};

export function paymentMinorToCny(value: string): string {
    if (!minor(value)) throw new RangeError("现金分无效");
    const cash = BigInt(value);
    return `${cash / BigInt(100)}.${(cash % BigInt(100)).toString().padStart(2, "0")}`;
}
export function paymentCnyToMinor(value: unknown): string | null {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)([.][0-9]{1,2})?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    const cash = BigInt(whole!) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
    return cash > BigInt(0) ? cash.toString() : null;
}

export function parseAdminPaymentMerchant(value: unknown): AdminPaymentMerchant | null {
    if (!record(value) || !exact(value, ["id", "merchantId", "paymentType", "channelId", "productName", "credentialConfigured"]) ||
        !uuid(value.id) || !text(value.merchantId) || !/^[A-Za-z0-9_-]+$/.test(value.merchantId) || !type(value.paymentType) ||
        !(value.channelId === null || text(value.channelId)) || !text(value.productName) || typeof value.credentialConfigured !== "boolean") return null;
    return value as AdminPaymentMerchant;
}
export function parsePaymentConfiguration(value: unknown): PaymentConfigurationView | null {
    if (!record(value) || !exact(value, ["runtimeEnabled", "revision", "newOrdersEnabled", "merchant", "offers"]) ||
        typeof value.runtimeEnabled !== "boolean" || !revision(value.revision) || typeof value.newOrdersEnabled !== "boolean" || !Array.isArray(value.offers)) return null;
    const merchant = value.merchant;
    if (merchant !== null && !parseAdminPaymentMerchant(merchant)) return null;
    for (const offer of value.offers) {
        if (!record(offer) || !exact(offer, ["id", "offerId", "revision", "label", "amountMinor", "creditUnits", "policyReference"]) ||
            !uuid(offer.id) || !uuid(offer.offerId) || !revision(offer.revision) || offer.revision === 0 || !text(offer.label) ||
            !minor(offer.amountMinor) || !credits(offer.creditUnits) || !(offer.policyReference === null || text(offer.policyReference))) return null;
    }
    if (new Set(value.offers.map(offer => offer.id)).size !== value.offers.length ||
        value.newOrdersEnabled && (!merchant || !value.offers.length || value.offers.some(offer => !offer.policyReference))) return null;
    return value as PaymentConfigurationView;
}

const orderKeys = ["id", "currency", "amountMinor", "creditUnits", "paymentType", "createState", "paymentState", "creditState", "refundState",
    "paymentLinks", "creditedAt", "createdAt", "updatedAt", "lastReason"] as const;
export function parsePaymentOrder(value: unknown): PaymentOrderView | null {
    if (!record(value) || !exact(value, orderKeys) || !uuid(value.id) || value.currency !== "CNY" || !minor(value.amountMinor) || !credits(value.creditUnits) ||
        !type(value.paymentType) || typeof value.createState !== "string" || !["pending", "attempting", "accepted", "rejected", "unknown"].includes(value.createState) ||
        typeof value.paymentState !== "string" || !["unknown", "unpaid", "paid"].includes(value.paymentState) ||
        typeof value.creditState !== "string" || !["pending", "credited"].includes(value.creditState) ||
        typeof value.refundState !== "string" || !["none", "pending_review", "refunded"].includes(value.refundState) || !date(value.createdAt) || !date(value.updatedAt) ||
        !(value.creditedAt === null || date(value.creditedAt)) || !(value.lastReason === null || text(value.lastReason))) return null;
    if (value.paymentLinks !== null) {
        if (!record(value.paymentLinks)) return null;
        for (const [key, link] of Object.entries(value.paymentLinks)) {
            if (!["payurl", "payurl2", "qrcode", "img"].includes(key) || typeof link !== "string") return null;
            try { const parsed = new URL(link); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null; }
            catch { return null; }
        }
    }
    if (value.creditState === "credited" && (value.paymentState !== "paid" || !date(value.creditedAt)) || value.creditState === "pending" && value.creditedAt !== null) return null;
    return value as PaymentOrderView;
}

export function parseAdminPaymentOrder(value: unknown): AdminPaymentOrderView | null {
    const extra = ["ownerId", "merchantVersionId", "merchantOrderId", "providerTradeNo", "providerOrderId", "creditedLedgerId"];
    if (!record(value) || !exact(value, [...orderKeys, ...extra]) || !text(value.ownerId) || !uuid(value.merchantVersionId) || !text(value.merchantOrderId) ||
        !(value.providerTradeNo === null || text(value.providerTradeNo)) || !(value.providerOrderId === null || text(value.providerOrderId)) ||
        !(value.creditedLedgerId === null || uuid(value.creditedLedgerId))) return null;
    const core = Object.fromEntries(orderKeys.map(key => [key, value[key]]));
    return parsePaymentOrder(core) && (value.creditState !== "credited" || value.creditedLedgerId !== null) ? value as AdminPaymentOrderView : null;
}
