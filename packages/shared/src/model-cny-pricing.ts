/** Private admin draft contracts. These values do not authorize billing. */
export type CnyModelBinding = {
    providerId: string;
    providerModel: string;
    adapter: "openai-compatible" | "sub2api";
    endpoint: string;
    capability: "image";
};

export type CnyDraftModel = {
    modelId: string;
    displayName: string;
    providerDisplayName: string;
    binding: CnyModelBinding;
};

export type AdminCnyPriceDraft = {
    id: string;
    modelId: string;
    version: number;
    currency: "CNY";
    billingUnit: "request";
    costAmount: string | null;
    saleAmount: string;
    estimatedGrossMargin: string | null;
    priceNote: string;
    binding: CnyModelBinding;
    bindingMatchesCurrent: boolean;
    createdAt: string;
};

export type CnyPriceDraftWrite = {
    modelId: string;
    expectedVersion: number;
    binding: CnyModelBinding;
    costAmount: string | null;
    saleAmount: string;
    priceNote: string;
};

/**
 * Normalize a plain nonnegative decimal without floating point or rounding.
 * Limits are PostgreSQL unconstrained numeric's representable range, not a
 * product price cap or a decision about the future wallet's monetary scale.
 */
export function normalizeCnyAmount(value: unknown): string | null {
    if (typeof value !== "string" || value.trim() !== value || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    const significantFraction = fraction.replace(/0+$/, "");
    if (whole.length > 131072 || significantFraction.length > 16383) return null;
    return significantFraction ? `${whole}.${significantFraction}` : whole;
}
