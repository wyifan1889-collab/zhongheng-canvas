import { z } from "zod";
import { OPENAI_IMAGE_PROTOCOL, normalizeCreditAmount, compareCreditAmounts, parseImageSpecParameters, parseModelPriceRule, selectImageSpecPrice,
    type ImageSpecParameters, type PublishedImageSpecPrice } from "@infinite-canvas/shared";
import { imageSpecFitsPixelBudget } from "./generation-image-limits";

const dateValue = z.union([z.date(), z.string().datetime({ offset: true })]);
const providerSchema = z.strictObject({
    id: z.string().min(1),
    enabled: z.boolean(),
    adapter: z.enum(["openai-compatible", "sub2api"]),
    credentialConfigured: z.boolean(),
});
const modelSchema = z.strictObject({
    id: z.string().min(1),
    publicId: z.string().min(1),
    providerId: z.string().min(1),
    capability: z.enum(["text", "image", "video", "audio"]),
    enabled: z.boolean(),
});
const pricingFields = {
    modelId: z.string().min(1),
    version: z.number().int().positive(),
    effectiveFrom: dateValue,
    effectiveTo: dateValue.nullable(),
    enabled: z.boolean(),
};
const imageSpecsSchema = z.array(z.strictObject({
    parameters: z.custom<ImageSpecParameters>((value) => parseImageSpecParameters(value) !== null),
    creditsPerRequest: z.number().int().positive().refine(Number.isSafeInteger),
})).min(1).refine((imageSpecs) => {
    const price: PublishedImageSpecPrice = { billingUnit: "image_specs", creditsPerUnit: null, protocol: OPENAI_IMAGE_PROTOCOL, imageSpecs };
    return imageSpecs.every((spec) => selectImageSpecPrice(price, spec.parameters) !== null)
        && parseModelPriceRule({ template: "image_request", currency: "credit", bands: imageSpecs.map((spec) => ({
            parameters: spec.parameters, rates: { request: String(spec.creditsPerRequest) },
        })) }, "image", "sale") !== null;
});
const pricingSchema = z.discriminatedUnion("billingUnit", [
    z.strictObject({ ...pricingFields, billingUnit: z.enum(["request", "input_token", "output_token", "second", "megapixel"]),
        creditsPerUnit: z.number().int().positive().refine(Number.isSafeInteger) }),
    z.strictObject({ ...pricingFields, billingUnit: z.literal("text_tokens"), creditsPerUnit: z.null() }),
    z.strictObject({ ...pricingFields, billingUnit: z.literal("video_specs"), creditsPerUnit: z.null() }),
    z.strictObject({ ...pricingFields, billingUnit: z.literal("image_specs"), creditsPerUnit: z.null(),
        protocol: z.literal(OPENAI_IMAGE_PROTOCOL).optional(), imageSpecs: imageSpecsSchema.optional(),
    }).refine(price => (price.protocol === undefined) === (price.imageSpecs === undefined)),
]);
const walletSchema = z.strictObject({
    userId: z.string().min(1),
    unit: z.literal("credit"),
    availableUnits: z.string().refine((value) => normalizeCreditAmount(value) === value && !value.startsWith("-")),
    reservedUnits: z.string().refine((value) => normalizeCreditAmount(value) === value && !value.startsWith("-")),
});

export const generationPreflightSnapshotSchema = z.strictObject({
    providers: z.array(providerSchema),
    models: z.array(modelSchema),
    pricing: z.array(pricingSchema),
    wallets: z.array(walletSchema),
});

export type GenerationPreflightSnapshot = z.infer<typeof generationPreflightSnapshotSchema>;
export type GenerationPreflightCheck = { code: string; status: "pass" | "fail" };
export type GenerationPreflightResult = {
    status: "ready" | "blocked";
    checks: GenerationPreflightCheck[];
    summary: {
        enabledProviderCount: number;
        eligibleTextModelCount: number;
        activeTextPricingCount: number;
        testWalletReady: boolean;
        image?: {
            publicModelId: string;
            eligibleModelCount: number;
            priceVersion: number | null;
            billingUnit: GenerationPreflightSnapshot["pricing"][number]["billingUnit"] | null;
            creditsPerRequest: number | null;
            requiredWalletUnits: number | null;
        };
    };
};

export type GenerationPreflightOptions = {
    testAccountId: string;
    now?: Date;
    minimumWalletUnits?: number;
} & ({ capability?: "text"; publicModelId?: never; imageSpec?: never } |
    { capability: "image"; publicModelId: string; imageSpec?: ImageSpecParameters });

function asDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

/**
 * Read-only, secret-free metadata readiness. Legacy calls retain the text
 * check; image checks require an explicit public model ID. This function never
 * opens a database, calls a Provider, starts a worker, or returns credentials.
 */
export function evaluateGenerationPreflight(
    input: GenerationPreflightSnapshot,
    options: GenerationPreflightOptions,
): GenerationPreflightResult {
    const snapshot = generationPreflightSnapshotSchema.parse(input);
    const now = options.now ?? new Date();
    if (!options.testAccountId.trim()) throw new Error("测试账户 ID 不能为空");
    if (options.minimumWalletUnits !== undefined && (!Number.isSafeInteger(options.minimumWalletUnits) || options.minimumWalletUnits <= 0)) {
        throw new Error("最低测试余额必须是正整数");
    }
    const capability = options.capability ?? "text";
    if (capability !== "text" && capability !== "image") throw new Error("预检能力只支持 text 或 image");
    if (capability === "image" && (typeof options.publicModelId !== "string" || !options.publicModelId.trim())) {
        throw new Error("图片预检必须指定目标公开模型 ID");
    }
    if (capability === "text" && options.publicModelId !== undefined) throw new Error("目标公开模型 ID 必须配合显式 image 能力");
    if (capability === "text" && options.imageSpec !== undefined) throw new Error("图片规格必须配合显式 image 能力");
    const imageSpec = options.imageSpec === undefined ? null : parseImageSpecParameters(options.imageSpec);
    if (options.imageSpec !== undefined && !imageSpec) throw new Error("图片预检必须选择有效的明确规格");

    const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
    const targetModel = capability === "image" ? snapshot.models.find((model) => model.publicId === options.publicModelId) : undefined;
    const enabledProviders = snapshot.providers.filter((provider) => provider.enabled && provider.credentialConfigured
        && (capability === "text" || provider.id === targetModel?.providerId));
    const eligibleModels = snapshot.models.filter((model) => {
        const provider = providers.get(model.providerId);
        return model.enabled && model.capability === capability && provider?.enabled && provider.credentialConfigured && provider.adapter === "openai-compatible"
            && (capability === "text" || model.publicId === options.publicModelId);
    });
    const activePricing = snapshot.pricing.filter((pricing) => {
        return pricing.enabled && eligibleModels.some((model) => model.id === pricing.modelId)
            && asDate(pricing.effectiveFrom) <= now && (pricing.effectiveTo === null || asDate(pricing.effectiveTo) > now);
    });
    // Match resolveExecutableImageQuote: select the latest effective version
    // first, then reject unsupported billing rather than falling back to an old price.
    const imagePrice = capability === "image" ? activePricing.sort((a, b) => b.version - a.version)[0] : undefined;
    const seen = new Set<string>();
    const scalarPricing = activePricing.toSorted((a, b) => b.version - a.version).filter((price) => {
        if (seen.has(price.modelId)) return false;
        seen.add(price.modelId);
        return true;
    }).filter((price) => price.creditsPerUnit !== null);
    const selectedImageSpec = imagePrice?.billingUnit === "image_specs" && imagePrice.protocol && imagePrice.imageSpecs && imageSpec
        ? selectImageSpecPrice({ ...imagePrice, protocol: imagePrice.protocol, imageSpecs: imagePrice.imageSpecs }, imageSpec) : null;
    const imageCredits = imagePrice?.billingUnit === "request" ? imagePrice.creditsPerUnit : selectedImageSpec?.creditsPerRequest ?? null;
    const pricingReady = capability === "image" ? imageCredits !== null : scalarPricing.length > 0;
    const imageSpecsBlocked = capability === "image" && imagePrice?.billingUnit === "image_specs" && !selectedImageSpec;
    const quotedUnits = capability === "image" ? imageCredits
        : scalarPricing.length > 0 ? Math.min(...scalarPricing.map((pricing) => pricing.creditsPerUnit)) : 1;
    // Legacy text operators may supply an output-token budget. An image override
    // can only raise the wallet requirement, never lower the selected request price.
    const minimumWalletUnits = quotedUnits === null ? null : capability === "image" ? Math.max(options.minimumWalletUnits ?? 0, quotedUnits)
        : options.minimumWalletUnits ?? quotedUnits;
    const testWallet = snapshot.wallets.find((wallet) => wallet.userId === options.testAccountId);
    const walletReady = Boolean(minimumWalletUnits !== null && testWallet && testWallet.unit === "credit" && testWallet.reservedUnits === "0"
        && compareCreditAmounts(testWallet.availableUnits, String(minimumWalletUnits)) >= 0);

    const checks: GenerationPreflightCheck[] = [
        { code: "enabled_provider_with_credential", status: enabledProviders.length > 0 ? "pass" : "fail" },
        { code: capability === "image" ? "selected_enabled_openai_image_model" : "enabled_openai_text_model", status: eligibleModels.length > 0 ? "pass" : "fail" },
        { code: capability === "image" ? "selected_latest_request_pricing" : "active_text_pricing", status: pricingReady ? "pass" : "fail" },
        { code: "clean_test_account_wallet", status: walletReady ? "pass" : "fail" },
        ...(imageSpecsBlocked ? [{ code: "image_spec_execution_unavailable", status: "fail" as const }] : []),
        ...(selectedImageSpec ? [{ code: "image_spec_pixel_budget", status: imageSpecFitsPixelBudget(selectedImageSpec.parameters) ? "pass" as const : "fail" as const }] : []),
    ];
    return {
        status: checks.every((check) => check.status === "pass") ? "ready" : "blocked",
        checks,
        summary: {
            enabledProviderCount: enabledProviders.length,
            eligibleTextModelCount: capability === "text" ? eligibleModels.length : 0,
            activeTextPricingCount: capability === "text" ? scalarPricing.length : 0,
            testWalletReady: walletReady,
            ...(options.capability === "image" ? { image: {
                publicModelId: options.publicModelId,
                eligibleModelCount: eligibleModels.length,
                priceVersion: imagePrice?.version ?? null,
                billingUnit: imagePrice?.billingUnit ?? null,
                creditsPerRequest: imageCredits,
                requiredWalletUnits: minimumWalletUnits,
            } } : {}),
        },
    };
}
