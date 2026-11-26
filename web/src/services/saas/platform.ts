import { useAccountStore } from "@/stores/use-account-store";
import { OPENAI_IMAGE_PROTOCOL, parseTextPriceDerivationMetadata, type TextPriceDerivationMetadata } from "../../../../packages/shared/src/model-price-publications";
import type { AdminGenerationTaskDetail } from "../../../../packages/shared/src/admin-generation";
import { parseTextUsageEvidence, type TextUsageEvidence } from "../../../../packages/shared/src/text-usage";
import { evaluateTextUsageDraft, type TextUsageDraftReview } from "../../../../packages/shared/src/text-usage-review";
import { parseTaskPriceSnapshot } from "../../../../packages/shared/src/task-price-snapshot";
import { normalizeCreditAmount, addCreditAmounts, subtractCreditAmounts } from "../../../../packages/shared/src/credit-amounts";
import { parseModelPriceBinding, parseModelPriceDraftWrite, parseModelPriceRules, sameModelPriceBinding, PRICE_TEMPLATES,
    type AdminModelPriceDraft, type AdminModelPriceDraftCatalog, type ModelPriceBinding, type ModelPriceDraftWrite, type ModelPriceRules, type PriceDraftModel } from "../../../../packages/shared/src/model-pricing-drafts";
import { publishedDraftPrice, parseModelPricePublishWrite, parseImageSpecParameters, selectImageSpecPrice, parsePublishedVideoSpecPrice, samePublishedVideoSpecPrice, type AdminModelPricePublication, type ModelPricePublicationPreview, type ModelPricePublishWrite, type PricePublicationUnavailableReason, type PublishedScalarPrice, type PublishedTextRates, type PublishedImageSpecPrice, type PublishedVideoSpecPrice } from "../../../../packages/shared/src/model-price-publications";
import { estimateGeminiImagePrice, selectGeminiImageBand, type PublishedGeminiImagePrice } from "../../../../packages/shared/src/gemini-image-price-trial";
import { GEMINI_IMAGE_PROTOCOL, GEMINI_IMAGE_USAGE, parseGeminiImageSpecification, type GeminiImageSpecification } from "../../../../packages/shared/src/generation-gemini-image";

export type { AdminGenerationTaskDetail } from "../../../../packages/shared/src/admin-generation";
export type { TextUsageEvidence } from "../../../../packages/shared/src/text-usage";
export type { TextUsageDraftReview } from "../../../../packages/shared/src/text-usage-review";
export type { TaskPriceSnapshot } from "../../../../packages/shared/src/task-price-snapshot";
export { normalizeCreditAmount } from "../../../../packages/shared/src/credit-amounts";
export { normalizePriceAmount, parseModelPriceRules, sameModelPriceBinding, evaluatePriceRule, describePriceDraftSupport, PRICE_TEMPLATES, PRICE_METERS, PRICE_PARAMETERS } from "../../../../packages/shared/src/model-pricing-drafts";
export type { AdminModelPriceDraft, AdminModelPriceDraftCatalog, ModelPriceBinding, ModelPriceDraftWrite, ModelPriceRules, ModelPriceRule, PriceBand, PriceDraftModel, PriceMeter, PriceTemplate, PriceCurrency, PricingCapability, PriceSampleResult } from "../../../../packages/shared/src/model-pricing-drafts";
export { executableImageDraftCredits, publishedDraftPrice } from "../../../../packages/shared/src/model-price-publications";
export type { AdminModelPricePublication, ModelPricePublicationPreview, ModelPricePublishWrite, PricePublicationUnavailableReason, PublishedPrice, PublishedTextRates, PublishedImageSpecPrice, PublishedVideoSpecPrice } from "../../../../packages/shared/src/model-price-publications";

export type PlatformModel = {
    id: string;
    displayName: string;
    capability: "text" | "image" | "video" | "audio";
};

type ScalarBillingUnit = PublishedScalarPrice["billingUnit"];
export type PlatformPriceAmount = PublishedScalarPrice | PublishedTextRates | PublishedImageSpecPrice | PublishedGeminiImagePrice | PublishedVideoSpecPrice;
export type PlatformPricing = {
    modelId: string;
    displayName: string;
    capability: PlatformModel["capability"];
    version: number;
    priceNote?: string;
    textPriceDerivation?: TextPriceDerivationMetadata;
    effectiveFrom: string;
    effectiveTo: string | null;
} & PlatformPriceAmount;

export type PlatformWallet = {
    unit: "credit";
    availableUnits: string;
    reservedUnits: string;
    totalUnits: string;
    version: number;
    createdAt: string;
    updatedAt: string;
};

export type AdminModel = PlatformModel & {
    groupId: string | null;
    revision: number;
    providerId: string;
    providerDisplayName: string;
    adapter: "openai-compatible" | "sub2api";
    endpoint: string;
    providerModel: string;
    providerEnabled: boolean;
    enabled: boolean;
    secretRefConfigured: boolean;
    createdAt: string;
    updatedAt: string;
};

export type AdminProvider = {
    id: string;
    revision: number;
    displayName: string;
    adapter: "openai-compatible" | "sub2api";
    endpoint: string;
    enabled: boolean;
    credentialConfigured: boolean;
    createdAt: string;
    updatedAt: string;
};

export type AdminProviderTestResult = {
    providerId: string;
    models: string[];
    bindings: {
        id: string;
        displayName: string;
        providerModel: string;
        enabled: boolean;
        found: boolean;
    }[];
};

export type ProviderWrite = Pick<AdminProvider, "displayName" | "adapter" | "endpoint" | "enabled" | "revision"> & { apiKey?: string; discoveryReceiptId?: string };
export type AdminProviderDiscovery = AdminProviderTestResult & { receiptId: string; revision: number; added: string[]; missing: string[]; unchanged: number };
export type AdminProviderModel = {
    providerId: string; providerName: string; providerEnabled: boolean; providerModel: string;
    available: boolean; firstSeenAt: string; lastSeenAt: string; boundModelId: string | null;
};
export type ModelWrite = { providerId: string; providerModel: string; displayName: string; capability: PlatformModel["capability"]; enabled: boolean; groupId: string | null; revision: number };
export type CatalogDeletionReceipt = { id: string; revision: number; modelIds: string[] };

export function catalogDeletionReceipt(value: unknown, id: string, revision: number): CatalogDeletionReceipt {
    if (!record(value) || !record(value.deleted)) throw new PlatformServiceError("删除回执不完整，请重新读取配置核对，勿重复提交。");
    const result = value.deleted;
    if (result.id !== id || result.revision !== revision + 1 || !Array.isArray(result.modelIds)
        || !result.modelIds.every(item => typeof item === "string" && !!item.trim()) || new Set(result.modelIds).size !== result.modelIds.length) {
        throw new PlatformServiceError("删除回执不一致，请重新读取配置核对，勿重复提交。");
    }
    return { id, revision: revision + 1, modelIds: result.modelIds };
}

export type AdminUser = {
    id: string;
    name: string;
    email: string;
    role: "user" | "admin";
    disabled: boolean;
    emailVerified: boolean;
    wallet: { unit: "credit"; availableUnits: string; reservedUnits: string; totalUnits: string };
    createdAt: string;
};

export type AdminPricing = PlatformPricing & {
    id: string;
    modelCatalogId: string;
    providerId: string;
    providerDisplayName: string;
    providerEnabled: boolean;
    modelEnabled: boolean;
    deleted?: boolean;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type AdminPricingWrite = {
    modelId: string;
    billingUnit: ScalarBillingUnit;
    creditsPerUnit: number;
    effectiveFrom?: string;
    enabled: boolean;
};

export type AdminBalanceAdjustment = {
    amount: string;
    reason: string;
};

export type AdminBalanceAdjustmentResult = {
    wallet: PlatformWallet;
    ledger: {
        id: string;
        kind: "adjustment";
        deltaAvailableUnits: string;
        deltaReservedUnits: string;
        availableUnitsAfter: string;
        reservedUnitsAfter: string;
        referenceType: string | null;
        referenceId: string | null;
        createdAt: string;
    };
};

export class PlatformServiceError extends Error {
    readonly status?: number;
    constructor(message = "平台服务暂时不可用", status?: number) {
        super(message);
        this.name = "PlatformServiceError";
        this.status = status;
    }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const creditString = (value: unknown): value is string => typeof value === "string" && normalizeCreditAmount(value) === value;
const nonnegativeCreditString = (value: unknown): value is string => creditString(value) && !value.startsWith("-");

function walletAmounts(value: unknown): AdminUser["wallet"] {
    if (!record(value) || value.unit !== "credit" || !nonnegativeCreditString(value.availableUnits) || !nonnegativeCreditString(value.reservedUnits)
        || !nonnegativeCreditString(value.totalUnits) || addCreditAmounts(value.availableUnits, value.reservedUnits) !== value.totalUnits) throw new PlatformServiceError("钱包金额回执格式不一致，请重新读取。");
    return { unit: "credit", availableUnits: value.availableUnits, reservedUnits: value.reservedUnits, totalUnits: value.totalUnits };
}

function platformWallet(value: unknown): PlatformWallet {
    const amounts = walletAmounts(value);
    if (!record(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 0
        || !taskTime(value.createdAt) || !taskTime(value.updatedAt)) throw new PlatformServiceError();
    return { ...amounts, version: value.version as number, createdAt: value.createdAt as string, updatedAt: value.updatedAt as string };
}

function accountHeaders(): Record<string, string> {
    const accountId = useAccountStore.getState().user?.id;
    return accountId ? { "x-canvas-account-id": accountId } : {};
}

async function getJson(path: string, scoped = false, options?: { accountId: string; signal: AbortSignal; fetcher?: typeof fetch }): Promise<unknown> {
    let response: Response;
    try {
        response = await (options?.fetcher ?? fetch)(path, { credentials: "same-origin", cache: "no-store",
            ...(options ? { method: "GET", signal: options.signal, redirect: "error" as const } : {}),
            headers: { accept: "application/json", ...(options ? { "x-canvas-account-id": options.accountId } : scoped ? accountHeaders() : {}) } });
    } catch {
        throw new PlatformServiceError();
    }
    if (!response.ok) throw new PlatformServiceError(response.status === 401 ? "管理员会话已失效，请重新登录" : response.status === 403 ? "当前账户没有后台权限" : undefined, response.status);
    try { return await response.json(); } catch { throw new PlatformServiceError(); }
}

async function putJson(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(path, { method: "PUT", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...accountHeaders() }, body: JSON.stringify(body) });
    } catch { throw new PlatformServiceError(); }
    if (!response.ok) throw new PlatformServiceError(response.status === 401 ? "管理员会话已失效，请重新登录" : response.status === 403 ? "当前账户没有后台权限" : undefined, response.status);
    try { return await response.json(); } catch { throw new PlatformServiceError(); }
}

async function postJson(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", ...extraHeaders, ...accountHeaders() }, body: JSON.stringify(body) });
    } catch { throw new PlatformServiceError(); }
    if (!response.ok) throw new PlatformServiceError(response.status === 401 ? "管理员会话已失效，请重新登录" : response.status === 403 ? "当前账户没有后台权限" : undefined, response.status);
    try { return await response.json(); } catch { throw new PlatformServiceError(); }
}

export async function fetchPlatformWallet(): Promise<PlatformWallet> {
    const data = await getJson("/api/v1/wallet", true);
    if (!record(data)) throw new PlatformServiceError();
    return platformWallet(data.wallet);
}

export async function fetchPlatformModels(): Promise<PlatformModel[]> {
    const data = await getJson("/api/v1/models");
    if (!record(data) || !Array.isArray(data.items)) throw new PlatformServiceError();
    return data.items.filter((item): item is PlatformModel => record(item) && typeof item.id === "string" && typeof item.displayName === "string" && ["text", "image", "video", "audio"].includes(String(item.capability)))
        .map((item) => ({ id: item.id, displayName: item.displayName, capability: item.capability }));
}

export async function fetchPlatformPricing(options?: { accountId: string; signal: AbortSignal; fetcher?: typeof fetch }): Promise<PlatformPricing[]> {
    const data = await getJson("/api/v1/model-pricing", false, options);
    if (!record(data) || !Array.isArray(data.items)) throw new PlatformServiceError();
    return data.items.map(platformPricing);
}

const pricingFormatError = () => new PlatformServiceError("模型价格回执格式不一致，请重新读取核对。");
function pricingAmount(value: unknown): PlatformPriceAmount {
    if (!record(value)) throw pricingFormatError();
    if (value.billingUnit === "video_specs") {
        const price = parsePublishedVideoSpecPrice(value);
        if (!price || Object.hasOwn(value, "currency")) throw pricingFormatError();
        return price;
    }
    if (Object.hasOwn(value, "videoSpecs")) throw pricingFormatError();
    if (value.billingUnit === "image_specs") {
        if (value.protocol === GEMINI_IMAGE_PROTOCOL) {
            if (value.usagePolicy !== GEMINI_IMAGE_USAGE || value.creditsPerUnit !== null || !Array.isArray(value.imageSpecs) || !value.imageSpecs.length ||
                ["inputCreditsPerMillion", "outputCreditsPerMillion", "cachedInputCreditsPerMillion", "currency"].some(key => Object.hasOwn(value, key))) throw pricingFormatError();
            const imageSpecs = value.imageSpecs.map(item => {
                if (!record(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, "parameters") ||
                    !Object.hasOwn(item, "creditsPerImage") || !Number.isSafeInteger(item.creditsPerImage) || Number(item.creditsPerImage) <= 0) throw pricingFormatError();
                // The public receipt omits the provider binding. Flash's known shape contains Pro's options.
                const parameters = parseGeminiImageSpecification("gemini-3.1-flash-image-preview", item.parameters);
                if (!parameters) throw pricingFormatError();
                return { parameters, creditsPerImage: item.creditsPerImage as number };
            });
            const price: PublishedGeminiImagePrice = { billingUnit: "image_specs", protocol: GEMINI_IMAGE_PROTOCOL, usagePolicy: GEMINI_IMAGE_USAGE,
                creditsPerUnit: null, imageSpecs };
            if (imageSpecs.some(item => !selectGeminiImageBand(price, item.parameters))) throw pricingFormatError();
            return price;
        }
        if (value.protocol !== OPENAI_IMAGE_PROTOCOL || value.creditsPerUnit !== null || !Array.isArray(value.imageSpecs) || !value.imageSpecs.length ||
            ["inputCreditsPerMillion", "outputCreditsPerMillion", "cachedInputCreditsPerMillion", "usagePolicy"].some(key => Object.hasOwn(value, key))) throw pricingFormatError();
        const imageSpecs = value.imageSpecs.map(item => {
            if (!record(item) || Reflect.ownKeys(item).length !== 2 || !["parameters", "creditsPerRequest"].every(key => Object.hasOwn(item, key)) ||
                Reflect.ownKeys(item).some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(item, key)!, "value")) ||
                !record(item.parameters) || Reflect.ownKeys(item.parameters).some(key => typeof key !== "string" || !["size", "quality"].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(item.parameters, key)!, "value")) ||
                !Number.isSafeInteger(item.creditsPerRequest) || (item.creditsPerRequest as number) < 1) throw pricingFormatError();
            const parameters = parseImageSpecParameters(item.parameters);
            if (!parameters) throw pricingFormatError();
            return { parameters, creditsPerRequest: item.creditsPerRequest as number };
        });
        const price: PublishedImageSpecPrice = { billingUnit: "image_specs", creditsPerUnit: null, protocol: OPENAI_IMAGE_PROTOCOL, imageSpecs };
        // Apply the saved rule parser's non-overlap policy as well as exact selection, without inventing combinations.
        const rules = parseModelPriceRules({ schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit",
            bands: imageSpecs.map(item => ({ parameters: item.parameters, rates: { request: String(item.creditsPerRequest) } })) } }, "image");
        if (!rules || imageSpecs.some(item => selectImageSpecPrice(price, item.parameters)?.creditsPerRequest !== item.creditsPerRequest)) throw pricingFormatError();
        return price;
    }
    if (Object.hasOwn(value, "imageSpecs")) throw pricingFormatError();
    if (value.billingUnit === "text_tokens") {
        if (value.creditsPerUnit !== null || !nonnegativeCreditString(value.inputCreditsPerMillion) || value.inputCreditsPerMillion === "0"
            || !nonnegativeCreditString(value.outputCreditsPerMillion) || value.outputCreditsPerMillion === "0"
            || Object.hasOwn(value, "cachedInputCreditsPerMillion") && (!nonnegativeCreditString(value.cachedInputCreditsPerMillion) || value.cachedInputCreditsPerMillion === "0")) throw pricingFormatError();
        return { billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: value.inputCreditsPerMillion, outputCreditsPerMillion: value.outputCreditsPerMillion,
            ...(Object.hasOwn(value, "cachedInputCreditsPerMillion") ? { cachedInputCreditsPerMillion: value.cachedInputCreditsPerMillion as string } : {}) };
    }
    if (!["request", "input_token", "output_token", "second", "megapixel"].includes(value.billingUnit as string)
        || !Number.isSafeInteger(value.creditsPerUnit) || (value.creditsPerUnit as number) < 1
        || value.inputCreditsPerMillion != null || value.outputCreditsPerMillion != null || Object.hasOwn(value, "cachedInputCreditsPerMillion")) throw pricingFormatError();
    return { billingUnit: value.billingUnit as ScalarBillingUnit, creditsPerUnit: value.creditsPerUnit as number };
}

function samePricingAmount(left: PlatformPriceAmount, right: PlatformPriceAmount): boolean {
    if (left.billingUnit !== right.billingUnit) return false;
    if (left.billingUnit === "video_specs" && right.billingUnit === "video_specs") return samePublishedVideoSpecPrice(left, right);
    if (left.billingUnit === "image_specs" && right.billingUnit === "image_specs") {
        if (left.imageSpecs.length !== right.imageSpecs.length) return false;
        if (left.protocol === GEMINI_IMAGE_PROTOCOL) return right.protocol === GEMINI_IMAGE_PROTOCOL &&
            left.imageSpecs.every(item => selectGeminiImageBand(right, item.parameters)?.creditsPerImage === item.creditsPerImage);
        return right.protocol === OPENAI_IMAGE_PROTOCOL && left.imageSpecs.every(item => selectImageSpecPrice(right, item.parameters)?.creditsPerRequest === item.creditsPerRequest);
    }
    return left.billingUnit === "text_tokens" && right.billingUnit === "text_tokens"
        ? left.inputCreditsPerMillion === right.inputCreditsPerMillion && left.outputCreditsPerMillion === right.outputCreditsPerMillion && left.cachedInputCreditsPerMillion === right.cachedInputCreditsPerMillion
        : left.creditsPerUnit === right.creditsPerUnit;
}

/** Public catalog projection: prices and public notes only, never private rule snapshots. */
function platformPricing(value: unknown): PlatformPricing {
    if (!record(value) || !taskText(value.modelId) || typeof value.displayName !== "string" || !taskEnum(["text", "image", "video", "audio"])(value.capability)
        || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !taskTime(value.effectiveFrom) || !taskNullableTime(value.effectiveTo)
        || (value.priceNote !== undefined && typeof value.priceNote !== "string")) throw pricingFormatError();
    const price = pricingAmount(value);
    const explanation = value.textPriceDerivation === undefined ? undefined : parseTextPriceDerivationMetadata(value.textPriceDerivation, value.version as number);
    if (explanation === null || explanation && price.billingUnit !== "text_tokens") throw pricingFormatError();
    if (price.billingUnit === "text_tokens" && value.capability !== "text" || price.billingUnit === "image_specs" && value.capability !== "image" ||
        price.billingUnit === "video_specs" && value.capability !== "video") throw pricingFormatError();
    return { modelId: value.modelId as string, displayName: value.displayName, capability: value.capability as PlatformModel["capability"], version: value.version as number,
        ...price, ...(explanation ? { textPriceDerivation: explanation } : {}), effectiveFrom: value.effectiveFrom as string, effectiveTo: value.effectiveTo as string | null, ...(typeof value.priceNote === "string" ? { priceNote: value.priceNote } : {}) };
}

export async function fetchAdminModels(): Promise<AdminModel[]> {
    const data = await getJson("/api/v1/admin/models", true);
    if (!record(data) || !Array.isArray(data.items)) throw new PlatformServiceError();
    return data.items.filter((item): item is AdminModel => record(item) && typeof item.id === "string" && typeof item.displayName === "string" && ["text", "image", "video", "audio"].includes(String(item.capability)))
        .map((item) => item as unknown as AdminModel);
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
    const data = await getJson("/api/v1/admin/users?limit=100", true);
    if (!record(data) || !Array.isArray(data.items)) throw new PlatformServiceError();
    return data.items.map((item): AdminUser => {
        if (!record(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.email !== "string"
            || (item.role !== "admin" && item.role !== "user") || typeof item.disabled !== "boolean" || typeof item.emailVerified !== "boolean"
            || !taskTime(item.createdAt)) throw new PlatformServiceError("用户余额回执格式不一致，请重新读取。");
        return { id: item.id, name: item.name, email: item.email, role: item.role, disabled: item.disabled, emailVerified: item.emailVerified,
            wallet: walletAmounts(item.wallet), createdAt: item.createdAt as string };
    });
}

export async function fetchAdminPricing(): Promise<AdminPricing[]> {
    const data = await getJson("/api/v1/admin/model-pricing", true);
    if (!record(data) || !Array.isArray(data.items)) throw new PlatformServiceError();
    return data.items.map((item): AdminPricing => {
        const price = platformPricing(item);
        if (!record(item) || !taskText(item.id) || !taskText(item.modelCatalogId) || !taskText(item.providerId) || typeof item.providerDisplayName !== "string"
            || typeof item.providerEnabled !== "boolean" || typeof item.modelEnabled !== "boolean" || typeof item.enabled !== "boolean"
            || (item.deleted !== undefined && typeof item.deleted !== "boolean")
            || !taskTime(item.createdAt) || !taskTime(item.updatedAt)) throw pricingFormatError();
        return { ...price, id: item.id as string, modelCatalogId: item.modelCatalogId as string, providerId: item.providerId as string, providerDisplayName: item.providerDisplayName,
            providerEnabled: item.providerEnabled, modelEnabled: item.modelEnabled, enabled: item.enabled, ...(item.deleted === undefined ? {} : { deleted: item.deleted }), createdAt: item.createdAt as string, updatedAt: item.updatedAt as string };
    });
}

export async function fetchAdminProviders(): Promise<AdminProvider[]> {
    const data = await getJson("/api/v1/admin/providers", true);
    if (!record(data) || !Array.isArray(data.items)) throw new PlatformServiceError();
    return data.items.map(adminProvider);
}

export async function saveAdminProvider(id: string, input: ProviderWrite): Promise<AdminProvider> {
    const data = await putJson(`/api/v1/admin/providers/${encodeURIComponent(id)}`, input);
    if (!record(data) || !record(data.provider) || typeof data.provider.id !== "string") throw new PlatformServiceError();
    return data.provider as AdminProvider;
}

export async function testAdminProvider(id: string): Promise<AdminProviderTestResult> {
    const data = await postJson(`/api/v1/admin/providers/${encodeURIComponent(id)}/test`, {});
    if (!record(data) || data.providerId !== id || !Array.isArray(data.models) || !data.models.every((item) => typeof item === "string") || !Array.isArray(data.bindings)) throw new PlatformServiceError();
    const bindings = data.bindings.filter((item): item is AdminProviderTestResult["bindings"][number] => record(item)
        && typeof item.id === "string" && typeof item.displayName === "string" && typeof item.providerModel === "string"
        && typeof item.enabled === "boolean" && typeof item.found === "boolean");
    if (bindings.length !== data.bindings.length) throw new PlatformServiceError();
    return { providerId: data.providerId, models: data.models, bindings };
}

function adminProvider(value: unknown): AdminProvider {
    if (!record(value) || !taskText(value.id) || !taskText(value.displayName) || !taskText(value.endpoint)
        || !["openai-compatible", "sub2api"].includes(String(value.adapter)) || typeof value.enabled !== "boolean"
        || typeof value.credentialConfigured !== "boolean" || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
        || !taskTime(value.createdAt) || !taskTime(value.updatedAt)) throw new PlatformServiceError("渠道回执不完整，请重新读取核对。");
    return { id: value.id as string, displayName: value.displayName as string, endpoint: value.endpoint as string, adapter: value.adapter as AdminProvider["adapter"],
        revision: value.revision as number, enabled: value.enabled, credentialConfigured: value.credentialConfigured,
        createdAt: value.createdAt as string, updatedAt: value.updatedAt as string };
}

const uniqueModelNames = (value: unknown): value is string[] => Array.isArray(value) && value.every(taskText) && new Set(value).size === value.length;
function providerDiscovery(value: unknown, providerId: string, revision: number): AdminProviderDiscovery {
    if (!record(value) || value.providerId !== providerId || value.revision !== revision || !taskUuid(value.receiptId)
        || !uniqueModelNames(value.models) || !uniqueModelNames(value.added) || !uniqueModelNames(value.missing)
        || !Number.isSafeInteger(value.unchanged) || (value.unchanged as number) < 0 || !Array.isArray(value.bindings)
        || value.added.length + (value.unchanged as number) !== value.models.length) throw new PlatformServiceError("模型读取回执不完整，尚未保存，请重新测试。");
    const names = new Set(value.models);
    if (value.added.some((name) => !names.has(name)) || value.missing.some((name) => names.has(name))) throw new PlatformServiceError("模型变化回执不一致，请重新测试。");
    const bindings = value.bindings.map((item): AdminProviderTestResult["bindings"][number] => {
        if (!record(item) || !taskText(item.id) || !taskText(item.displayName) || !taskText(item.providerModel)
            || typeof item.enabled !== "boolean" || typeof item.found !== "boolean") throw new PlatformServiceError("模型绑定回执不完整，请重新测试。");
        return { id: item.id as string, displayName: item.displayName as string, providerModel: item.providerModel as string, enabled: item.enabled, found: item.found };
    });
    return { providerId, revision, receiptId: value.receiptId, models: [...value.models], added: [...value.added], missing: [...value.missing], unchanged: value.unchanged as number, bindings };
}

function providerModels(value: unknown): AdminProviderModel[] {
    if (!record(value) || !Array.isArray(value.models)) throw new PlatformServiceError("模型库回执不完整，请重新读取。");
    const models = value.models.map((row): AdminProviderModel => {
        if (!record(row) || !taskText(row.providerId) || !taskText(row.providerName) || !taskText(row.providerModel)
            || typeof row.providerEnabled !== "boolean" || typeof row.available !== "boolean" || !taskTime(row.firstSeenAt) || !taskTime(row.lastSeenAt)
            || !(row.boundModelId === null || taskText(row.boundModelId))) throw new PlatformServiceError("模型库回执不完整，请重新读取。");
        return { providerId: row.providerId as string, providerName: row.providerName as string, providerModel: row.providerModel as string,
            providerEnabled: row.providerEnabled, available: row.available, firstSeenAt: row.firstSeenAt as string, lastSeenAt: row.lastSeenAt as string, boundModelId: row.boundModelId as string | null };
    });
    if (new Set(models.map((row) => JSON.stringify([row.providerId, row.providerModel]))).size !== models.length) throw new PlatformServiceError("模型库有重复记录，请重新读取核对。");
    return models;
}

/** Each editor owns its requests and receipts; changing a form or session invalidates late results. */
export function createAdminProviderCatalogClient(options: { scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = { ...options.scope };
    let active = true, sequence = 0, pending: AbortController | null = null;
    const current = () => {
        const next = options.getScope();
        if (!next || next.role !== "admin" || next.accountId !== scope.accountId || next.epoch !== scope.epoch) { active = false; pending?.abort(); }
        return active;
    };
    const cancel = () => { ++sequence; pending?.abort(); pending = null; };
    async function request<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE", parse: (value: unknown) => T, body?: ProviderWrite | { revision: number }): Promise<T | null> {
        if (!current()) return null;
        cancel(); const requestId = sequence, operation = new AbortController(); pending = operation;
        const latest = () => current() && sequence === requestId;
        const failure = method === "DELETE" ? "删除结果尚未确认，请刷新渠道和模型库核对，勿重复提交。" : method === "PUT" ? "保存结果尚未确认，请刷新渠道和模型库核对后再操作。" : "读取失败，已保存渠道和模型库未更改；请检查地址、协议和 Key 后重试。";
        try {
            const response = await (options.fetcher ?? fetch)(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: operation.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (!latest()) return null;
            if (!response.ok) {
                const detail: unknown = await response.json().catch(() => null);
                const inUse = record(detail) && record(detail.error) && detail.error.code === "catalog_in_use";
                throw new PlatformServiceError(response.status === 401 ? "管理员会话已失效，请重新登录。" : response.status === 403 ? "当前账户没有后台权限。"
                : response.status === 409 && inUse ? method === "DELETE" ? "渠道仍有未结束或待核对的生成任务，请先处理任务，完成后再删除。" : "待移除的型号仍有未结束或待核对任务，本次渠道与模型库均未更新；处理任务后重新读取核对。"
                : response.status === 404 && method === "DELETE" ? "渠道已删除，请刷新渠道和模型库核对。"
                : response.status === 409 ? "渠道版本或测试结果已变化。请刷新渠道列表，重新编辑并测试后再确认保存。"
                : response.status === 400 ? "输入不完整或测试结果已失效，请核对字段并重新测试。" : failure, response.status);
            }
            const data: unknown = await response.json();
            return latest() ? parse(data) : null;
        } catch (error) {
            if (!latest()) return null;
            throw error instanceof PlatformServiceError ? error : new PlatformServiceError(failure);
        } finally { if (pending === operation) pending = null; }
    }
    return {
        isCurrent: current, cancel, close() { active = false; cancel(); },
        load: () => request("/api/v1/admin/provider-models", "GET", providerModels),
        discover(id: string, input: ProviderWrite) {
            const { discoveryReceiptId: _receipt, ...body } = input;
            return request(`/api/v1/admin/providers/${encodeURIComponent(id)}/discover`, "POST", (value) => providerDiscovery(value, id, body.revision), body);
        },
        save(id: string, body: ProviderWrite) {
            return request(`/api/v1/admin/providers/${encodeURIComponent(id)}`, "PUT", (value) => {
                if (!record(value)) throw new PlatformServiceError("渠道保存回执不完整，请刷新渠道列表核对。");
                const saved = adminProvider(value.provider);
                if (saved.id !== id || saved.revision !== body.revision + 1 || saved.adapter !== body.adapter || saved.endpoint !== body.endpoint
                    || saved.displayName !== body.displayName || saved.enabled !== body.enabled) throw new PlatformServiceError("渠道保存回执不一致，请刷新渠道列表核对。");
                if (!record(value.provider) || !uniqueModelNames(value.provider.removedModelIds)) throw new PlatformServiceError("渠道同步回执不完整，请刷新渠道和模型库核对。");
                return { ...saved, removedModelIds: [...value.provider.removedModelIds] };
            }, body);
        },
        remove: (id: string, revision: number) => request(`/api/v1/admin/providers/${encodeURIComponent(id)}`, "DELETE", value => catalogDeletionReceipt(value, id, revision), { revision }),
    };
}

export async function saveAdminModel(id: string, input: ModelWrite): Promise<AdminModel> {
    const data = await putJson(`/api/v1/admin/models/${encodeURIComponent(id)}`, input);
    if (!record(data) || !record(data.model) || typeof data.model.id !== "string") throw new PlatformServiceError();
    return data.model as AdminModel;
}

export async function createAdminPricing(input: AdminPricingWrite): Promise<AdminPricing> {
    const data = await postJson("/api/v1/admin/model-pricing", input);
    if (!record(data) || !record(data.pricing) || typeof data.pricing.id !== "string") throw new PlatformServiceError();
    return data.pricing as AdminPricing;
}

export async function adjustAdminUserBalance(userId: string, input: AdminBalanceAdjustment, idempotencyKey: string): Promise<AdminBalanceAdjustmentResult> {
    if (!idempotencyKey.trim()) throw new PlatformServiceError("余额调整需要幂等键");
    const amount = typeof input.amount === "string" ? normalizeCreditAmount(input.amount) : null;
    if (amount === null || amount === "0") throw new PlatformServiceError("请输入非零十进制积分，不使用指数格式。");
    const data = await postJson(`/api/v1/admin/users/${encodeURIComponent(userId)}/balance`, { ...input, amount }, { "idempotency-key": idempotencyKey });
    if (!record(data)) throw new PlatformServiceError();
    const wallet = platformWallet(data.wallet);
    const ledger = taskFields<AdminBalanceAdjustmentResult["ledger"]>(data.ledger, {
        id: taskUuid, kind: (v) => v === "adjustment", deltaAvailableUnits: creditString, deltaReservedUnits: creditString,
        availableUnitsAfter: nonnegativeCreditString, reservedUnitsAfter: nonnegativeCreditString,
        referenceType: taskNullableText, referenceId: taskNullableText, createdAt: taskTime,
    });
    if (ledger.deltaAvailableUnits !== amount || ledger.deltaReservedUnits !== "0") throw new PlatformServiceError("余额调整回执不一致，请核对原请求，勿重复调整。");
    return { wallet, ledger };
}

export type AdminGenerationScope = { accountId: string; epoch: number; role: "admin" };
export type AdminGenerationReviewState =
    | { status: "idle" }
    | { status: "loading"; taskId: string }
    | { status: "ready"; detail: AdminGenerationTaskDetail }
    | { status: "error"; message: string };

export function getAdminGenerationScope(): AdminGenerationScope | null {
    const account = useAccountStore.getState(), scope = account.getDraftScope();
    return account.user?.role === "admin" && scope ? { ...scope, role: "admin" } : null;
}

const taskUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const taskText = (value: unknown) => typeof value === "string" && value.length > 0;
const taskNullableText = (value: unknown) => value === null || typeof value === "string";
const taskInteger = (value: unknown) => Number.isSafeInteger(value);
const taskAmount = (value: unknown) => taskInteger(value) && (value as number) >= 0;
const taskNullableAmount = (value: unknown) => value === null || taskAmount(value);
const taskTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const taskNullableTime = (value: unknown) => value === null || taskTime(value);
const taskEnum = (values: readonly string[]) => (value: unknown) => typeof value === "string" && values.includes(value);
const taskFormatError = () => new PlatformServiceError("任务核对数据不完整，未显示结果。请稍后手动查询。");

/** Validate and copy only the administrative DTO fields; never retain private extra fields. */
function taskFields<T>(value: unknown, checks: { [K in keyof T]: (value: unknown) => boolean }): T {
    if (!record(value)) throw taskFormatError();
    const safe: Record<string, unknown> = {};
    for (const key of Object.keys(checks) as Array<keyof T & string>) {
        if (!checks[key](value[key])) throw taskFormatError();
        safe[key] = value[key];
    }
    return safe as T;
}

function taskTextUsage(value: unknown): TextUsageEvidence | null {
    // Older administrative responses have no evidence field. Missing is not zero usage.
    if (value === undefined || value === null) return null;
    if (!record(value)) throw taskFormatError();
    const safe = parseTextUsageEvidence({ schemaVersion: value.schemaVersion, source: value.source, status: value.status,
        inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens, totalSource: value.totalSource,
        cachedInputTokens: value.cachedInputTokens, reasoningOutputTokens: value.reasoningOutputTokens, reason: value.reason,
        ...(Object.hasOwn(value, "cacheWriteTokens") ? { cacheWriteTokens: value.cacheWriteTokens } : {}) });
    if (!safe) throw taskFormatError();
    return safe;
}

function adminTaskDetail(data: unknown, taskId: string): AdminGenerationTaskDetail {
    if (!record(data) || !record(data.detail)) throw taskFormatError();
    const detail = data.detail;
    if (!taskTime(detail.observedAt)) throw taskFormatError();
    const task = taskFields<AdminGenerationTaskDetail["task"]>(detail.task, {
        id: taskUuid, ownerId: taskText, projectId: taskNullableText, nodeId: taskNullableText, modelId: taskText,
        priceVersion: (v) => v === null || (taskInteger(v) && (v as number) > 0), quotedUnits: taskNullableAmount,
        billingUnitSnapshot: (v) => v === null || taskEnum(["request", "input_token", "output_token", "second", "megapixel", "image"])(v),
        creditsPerUnitSnapshot: taskNullableAmount,
        executionStatus: taskEnum(["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"]),
        deliveryStatus: taskEnum(["pending", "saved", "visible", "failed", "unknown"]),
        billingStatus: taskEnum(["unbilled", "reserved", "captured", "released", "pending_review"]),
        unknownReason: taskNullableText, createdAt: taskTime, updatedAt: taskTime, finishedAt: taskNullableTime,
    });
    if (task.id !== taskId) throw taskFormatError();
    const priceSnapshot = parseTaskPriceSnapshot(detail.priceSnapshot);
    if (!priceSnapshot || (priceSnapshot.status === "recorded" && priceSnapshot.priceVersion !== task.priceVersion)) throw taskFormatError();
    const resultFields = detail.result === null ? null : taskFields<Omit<NonNullable<AdminGenerationTaskDetail["result"]>, "textUsage">>(detail.result, {
        status: taskEnum(["succeeded", "failed", "unknown"]), consumedUnits: taskNullableAmount,
        errorCode: taskNullableText, unknownReason: taskNullableText, createdAt: taskTime, updatedAt: taskTime,
    });
    const result = resultFields === null ? null : { ...resultFields, textUsage: taskTextUsage(record(detail.result) ? detail.result.textUsage : undefined) };
    if (!record(detail.reservation) || !taskEnum(["linked", "none", "missing", "mismatch"])(detail.reservation.linkStatus)) throw taskFormatError();
    const linkStatus = detail.reservation.linkStatus as AdminGenerationTaskDetail["reservation"]["linkStatus"];
    const reservationDetails = detail.reservation.details === null ? null : taskFields<NonNullable<AdminGenerationTaskDetail["reservation"]["details"]>>(detail.reservation.details, {
        id: taskUuid, status: taskEnum(["pending", "captured", "released", "expired"]),
        requestedUnits: nonnegativeCreditString, capturedUnits: nonnegativeCreditString, releasedUnits: nonnegativeCreditString, remainingUnits: nonnegativeCreditString,
        createdAt: taskTime, updatedAt: taskTime,
    });
    if ((linkStatus === "linked") !== (reservationDetails !== null) || !Array.isArray(detail.ledger)) throw taskFormatError();
    if (reservationDetails && subtractCreditAmounts(subtractCreditAmounts(reservationDetails.requestedUnits, reservationDetails.capturedUnits), reservationDetails.releasedUnits) !== reservationDetails.remainingUnits) throw taskFormatError();
    const ledger = detail.ledger.map((row) => taskFields<AdminGenerationTaskDetail["ledger"][number]>(row, {
        id: taskUuid, kind: taskEnum(["grant", "recharge", "adjustment", "reserve", "capture", "release", "refund", "consume"]),
        deltaAvailableUnits: creditString, deltaReservedUnits: creditString, createdAt: taskTime,
    }));
    if (new Set(ledger.map((row) => row.id)).size !== ledger.length) throw taskFormatError();
    return { observedAt: detail.observedAt as string, priceSnapshot, task, result, reservation: { linkStatus, details: reservationDetails }, ledger };
}

/** One admin panel lifetime: explicit GET only, with account/epoch and request-order protection. */
export function createAdminGenerationTaskReader(options: {
    scope: AdminGenerationScope;
    getScope: () => AdminGenerationScope | null;
    onState: (state: AdminGenerationReviewState) => void;
    fetcher?: typeof fetch;
}) {
    const scope = Object.freeze({ ...options.scope });
    let active = true, sequence = 0, pending: AbortController | null = null;
    const current = () => {
        const next = options.getScope();
        if (!next || next.role !== "admin" || next.accountId !== scope.accountId || next.epoch !== scope.epoch) {
            active = false; pending?.abort();
        }
        return active;
    };
    const clear = () => { ++sequence; pending?.abort(); pending = null; if (current()) options.onState({ status: "idle" }); };
    return {
        clear,
        close() { active = false; ++sequence; pending?.abort(); pending = null; },
        async query(value: string) {
            if (!current()) return;
            const request = ++sequence, taskId = value.trim().toLowerCase();
            pending?.abort();
            if (!taskUuid(taskId)) { options.onState({ status: "error", message: "请输入完整任务编号（UUID），不能使用提交前的请求回执键。" }); return; }
            const operation = new AbortController(); pending = operation;
            const latest = () => current() && request === sequence;
            options.onState({ status: "loading", taskId });
            if (!latest()) return;
            try {
                const data = await getJson(`/api/v1/admin/generation/tasks/${taskId}`, true, { accountId: scope.accountId, signal: operation.signal, fetcher: options.fetcher });
                if (!latest()) return;
                const detail = adminTaskDetail(data, taskId);
                if (latest()) options.onState({ status: "ready", detail });
            } catch (failure) {
                if (latest()) options.onState({ status: "error", message: failure instanceof PlatformServiceError
                    ? failure.status === 404 ? "未查到该任务，请核对完整任务编号。未查到不代表可以重新生成或退款。"
                        : failure.status === 401 || failure.status === 403 ? failure.message
                        : failure.status ? "任务查询未完成，请稍后手动查询；不会重新生成或改变积分。" : failure.message
                    : "任务查询未完成，请稍后手动查询。" });
            } finally { if (pending === operation) pending = null; }
        },
    };
}

function priceDraftError() { return new PlatformServiceError("模型价目草稿格式不正确，请重新读取核对。"); }
function priceBinding(value: unknown): ModelPriceBinding {
    if (!record(value)) throw priceDraftError();
    const binding = parseModelPriceBinding(value.capability === "video" ? value
        : { providerId: value.providerId, providerModel: value.providerModel, adapter: value.adapter, endpoint: value.endpoint, capability: value.capability });
    if (!binding) throw priceDraftError();
    return binding;
}
function priceDraft(value: unknown): AdminModelPriceDraft {
    if (!record(value) || !taskUuid(value.id) || !Number.isSafeInteger(value.version) || (value.version as number) < 1
        || typeof value.bindingMatchesCurrent !== "boolean" || !taskTime(value.createdAt)) throw priceDraftError();
    const parsed = parseModelPriceDraftWrite({ modelId: value.modelId, expectedVersion: (value.version as number) - 1,
        binding: priceBinding(value.binding), rules: value.rules, priceNote: value.priceNote });
    if (!parsed) throw priceDraftError();
    return { id: value.id, modelId: parsed.modelId, version: value.version as number, binding: parsed.binding, rules: parsed.rules,
        priceNote: parsed.priceNote, bindingMatchesCurrent: value.bindingMatchesCurrent, createdAt: value.createdAt as string };
}
function priceDraftCatalog(value: unknown): AdminModelPriceDraftCatalog {
    if (!record(value) || !Array.isArray(value.models) || !Array.isArray(value.items)) throw priceDraftError();
    const models = value.models.map((item): PriceDraftModel => {
        if (!record(item) || !["modelId", "displayName", "providerDisplayName"].every((key) => taskText(item[key]))) throw priceDraftError();
        return { modelId: item.modelId as string, displayName: item.displayName as string, providerDisplayName: item.providerDisplayName as string, binding: priceBinding(item.binding) };
    });
    const items = value.items.map(priceDraft);
    if (new Set(models.map((item) => item.modelId)).size !== models.length || new Set(items.map((item) => item.modelId)).size !== items.length) throw priceDraftError();
    for (const item of items) {
        const model = models.find((entry) => entry.modelId === item.modelId);
        if (item.bindingMatchesCurrent && (!model || !sameModelPriceBinding(item.binding, model.binding))) throw priceDraftError();
    }
    return { models, items };
}
function rulesSignature(rules: ModelPriceRules): string {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return JSON.stringify([rules.schemaVersion, canonical(rules.derivation ?? null), ...(rules.video ? [canonical(rules.video)] : []), ...[rules.cost, rules.sale].map((rule) => rule === null ? null : [rule.template, rule.currency,
        rule.bands.map((band) => [Object.entries(band.parameters).sort(([a], [b]) => a.localeCompare(b)), PRICE_TEMPLATES[rule.template].meters.map((meter) => band.rates[meter])])])]);
}

/** Private drafts only: no publish, quote, generation or wallet writes. */
export function createAdminModelPriceDraftClient(options: { scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ ...options.scope });
    let active = true, sequence = 0, pending: AbortController | null = null;
    const current = () => {
        const next = options.getScope();
        if (!next || next.role !== "admin" || next.accountId !== scope.accountId || next.epoch !== scope.epoch) { active = false; pending?.abort(); }
        return active;
    };
    async function request<T>(method: "GET" | "POST", parse: (value: unknown) => T, body?: ModelPriceDraftWrite): Promise<T | null> {
        if (!current()) return null;
        const request = ++sequence, operation = new AbortController(); pending?.abort(); pending = operation;
        const latest = () => current() && request === sequence;
        try {
            const response = await (options.fetcher ?? fetch)("/api/v1/admin/model-price-drafts", { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: operation.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (!latest()) return null;
            if (!response.ok) throw new PlatformServiceError(response.status === 409 ? "草稿版本、渠道绑定或倍率基准来源已变化。输入已保留，请重新读取相应基准并核对后再保存。"
                : response.status === 401 ? "管理员会话已失效，请重新登录。" : response.status === 403 ? "当前账户没有后台权限。"
                    : method === "POST" ? "草稿保存结果未确认，请先重新读取核对；不会自动重试。" : "模型价目草稿读取失败，请稍后手动重读。", response.status);
            const data: unknown = await response.json();
            if (!latest()) return null;
            return parse(data);
        } catch (error) {
            if (!latest()) return null;
            throw error instanceof PlatformServiceError ? error : new PlatformServiceError(method === "POST" ? "草稿保存结果未确认，请先重新读取核对；不会自动重试。" : "模型价目草稿读取失败，请稍后手动重读。");
        } finally { if (pending === operation) pending = null; }
    }
    return {
        isCurrent: current,
        close() { active = false; ++sequence; pending?.abort(); pending = null; },
        load: () => request("GET", priceDraftCatalog),
        save(input: ModelPriceDraftWrite): Promise<AdminModelPriceDraft | null> {
            if (!current()) return Promise.resolve(null);
            const body = parseModelPriceDraftWrite(input);
            if (!body || !Number.isSafeInteger(body.expectedVersion + 1)) return Promise.reject(new PlatformServiceError("草稿规则不完整：请核对计量单价、币种、参数档和版本；售价不可留空，成本未知可留空。"));
            return request("POST", (value) => {
                if (!record(value)) throw priceDraftError();
                const draft = priceDraft(value.draft);
                if (draft.modelId !== body.modelId || draft.version !== body.expectedVersion + 1 || !draft.bindingMatchesCurrent || !sameModelPriceBinding(draft.binding, body.binding)
                    || rulesSignature(draft.rules) !== rulesSignature(body.rules) || draft.priceNote !== body.priceNote) throw new PlatformServiceError("草稿保存回执不一致，请重新读取核对；不会自动重试。");
                return draft;
            }, body);
        },
    };
}

export type AdminTextUsageDraftState =
    | { status: "idle" | "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; draft: AdminModelPriceDraft; calculation: TextUsageDraftReview | null };

/** One displayed task lifetime. Manual draft GET and local what-if only; no write method is exposed. */
export function createAdminTextUsageDraftReview(options: {
    scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null;
    modelId: string; usage: TextUsageEvidence | null;
    onState: (state: AdminTextUsageDraftState) => void; fetcher?: typeof fetch;
}) {
    const client = createAdminModelPriceDraftClient(options), usage = options.usage === null ? null : parseTextUsageEvidence(options.usage);
    const modelId = options.modelId;
    let sequence = 0, state: AdminTextUsageDraftState = { status: "idle" };
    const emit = (next: AdminTextUsageDraftState) => { state = next; options.onState(next); };
    return {
        close() { ++sequence; client.close(); },
        async read() {
            if (!client.isCurrent()) return;
            const request = ++sequence, current = () => request === sequence && client.isCurrent();
            emit({ status: "loading" });
            try {
                if (!current()) return;
                const catalog = await client.load();
                if (!catalog || !current()) return;
                const draft = catalog.items.find((item) => item.modelId === modelId && item.binding.capability === "text");
                emit(draft ? { status: "ready", draft, calculation: null }
                    : { status: "error", message: "未找到该任务同模型的已保存文本价目草稿。请先在模型价目草稿中核对保存，再手动读取。" });
            } catch (failure) {
                if (current()) emit({ status: "error", message: failure instanceof PlatformServiceError ? failure.message : "价目草稿读取失败，请手动重读。" });
            }
        },
        calculate() {
            if (!client.isCurrent() || state.status !== "ready") return;
            emit({ ...state, calculation: evaluateTextUsageDraft(modelId, usage, state.draft) });
        },
    };
}

const publicationReasons: PricePublicationUnavailableReason[] = ["draft_missing", "model_binding_changed", "model_not_publishable", "unsupported_price_rule"];
const publicationFormatError = () => new PlatformServiceError("价格发布回执格式不一致，请只读核对，勿重复发布。");
function modelPricePublication(value: unknown): AdminModelPricePublication {
    if (!record(value) || !taskUuid(value.id) || !taskUuid(value.draftId) || !taskText(value.modelId)
        || ![value.draftVersion, value.priceVersion].every((item) => Number.isSafeInteger(item) && (item as number) > 0)
        || typeof value.publicPriceNote !== "string" || typeof value.bindingMatchesCurrent !== "boolean" || !taskTime(value.createdAt)) throw publicationFormatError();
    const binding = priceBinding(value.binding), rules = parseModelPriceRules(value.rules, binding.capability);
    const price = rules ? publishedDraftPrice(binding, rules) : null;
    if (!rules || !price || !samePricingAmount(price, pricingAmount(value))) throw publicationFormatError();
    return { id: value.id, modelId: value.modelId as string, draftId: value.draftId, draftVersion: value.draftVersion as number, priceVersion: value.priceVersion as number,
        ...price, publicPriceNote: value.publicPriceNote, binding, rules,
        bindingMatchesCurrent: value.bindingMatchesCurrent, createdAt: value.createdAt as string };
}
function modelPricePreview(value: unknown, modelId: string): ModelPricePublicationPreview {
    if (!record(value) || !record(value.preview)) throw publicationFormatError();
    const row = value.preview;
    if (row.modelId !== modelId || !Number.isSafeInteger(row.latestPriceVersion) || (row.latestPriceVersion as number) < 0
        || (row.unavailableReason !== null && !publicationReasons.includes(row.unavailableReason as PricePublicationUnavailableReason))) throw publicationFormatError();
    const draft = row.draft === null ? null : priceDraft(row.draft), publication = row.publication === null ? null : modelPricePublication(row.publication);
    let currentPrice: ModelPricePublicationPreview["currentPrice"] = null;
    if (row.currentPrice !== null) {
        const price = row.currentPrice;
        if (!record(price) || !Number.isSafeInteger(price.version) || (price.version as number) < 1 || price.version !== row.latestPriceVersion
            || typeof price.enabled !== "boolean") throw publicationFormatError();
        currentPrice = { version: price.version as number, ...pricingAmount(price), enabled: price.enabled };
    }
    if ((currentPrice === null) !== (row.latestPriceVersion === 0) || (draft && draft.modelId !== modelId) || (publication && (!draft || publication.modelId !== modelId || publication.draftId !== draft.id || publication.draftVersion !== draft.version
        || publication.priceVersion > (row.latestPriceVersion as number) || !sameModelPriceBinding(publication.binding, draft.binding) || rulesSignature(publication.rules) !== rulesSignature(draft.rules)
        || (publication.priceVersion === currentPrice?.version && !samePricingAmount(publication, currentPrice))))
        || (row.unavailableReason === null && (!draft || !draft.bindingMatchesCurrent || publishedDraftPrice(draft.binding, draft.rules) === null))) throw publicationFormatError();
    return { modelId, draft, publication, currentPrice, latestPriceVersion: row.latestPriceVersion as number, unavailableReason: row.unavailableReason as PricePublicationUnavailableReason | null };
}

/** A publish confirmation consumes one server preview. Unknown writes can only be reconciled by GET. */
export function createAdminModelPricePublicationClient(options: { scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ ...options.scope }), unresolved = new Map<string, string>();
    let active = true, sequence = 0, pending: AbortController | null = null, preview: ModelPricePublicationPreview | null = null;
    const current = () => {
        const next = options.getScope();
        if (!next || next.role !== "admin" || next.accountId !== scope.accountId || next.epoch !== scope.epoch) { active = false; pending?.abort(); preview = null; }
        return active;
    };
    const cancel = () => { ++sequence; pending?.abort(); pending = null; preview = null; };
    async function request<T>(path: string, parse: (value: unknown) => T, body?: ModelPricePublishWrite, readFailure?: string): Promise<T | null> {
        const operation = new AbortController(), request = ++sequence; pending?.abort(); pending = operation;
        const latest = () => current() && request === sequence;
        try {
            const response = await (options.fetcher ?? fetch)(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: operation.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (!latest()) return null;
            const data: unknown = await response.json(); if (!latest()) return null;
            if (!response.ok) {
                const code = record(data) && record(data.error) ? data.error.code : undefined;
                const rejected = typeof code === "string" && ((response.status === 409 && ["price_draft_conflict", "price_publication_conflict", "model_binding_changed", "model_not_publishable", "unsupported_price_rule"].includes(code))
                    || (response.status === 400 && code === "invalid_input") || (response.status === 404 && code === "model_not_found"));
                if (body && rejected) unresolved.delete(body.draftId);
                throw new PlatformServiceError(body && rejected ? "本次发布未受理。请重新读取草稿及发布状态，核对后再确认。" : body ? "发布结果未确认；请只读核对原草稿，不要重复发布。" : readFailure ?? "发布状态读取失败，请稍后手动核对。", response.status);
            }
            return parse(data);
        } catch (failure) {
            if (!latest()) return null;
            throw failure instanceof PlatformServiceError ? failure : new PlatformServiceError(body ? "发布结果未确认；请只读核对原草稿，不要重复发布。" : readFailure ?? "发布状态读取失败，请稍后手动核对。");
        } finally { if (pending === operation) pending = null; }
    }
    return {
        isCurrent: current, cancel,
        close() { active = false; cancel(); },
        hasUnconfirmed(modelId: string) { return [...unresolved.values()].includes(modelId); },
        async load(modelId: string): Promise<ModelPricePublicationPreview | null> {
            if (!current()) return null; preview = null;
            if (!taskText(modelId)) throw new PlatformServiceError("请先选择已保存草稿的模型。");
            const expected = sequence + 1;
            const value = await request(`/api/v1/admin/model-price-publications?modelId=${encodeURIComponent(modelId)}`, (data) => modelPricePreview(data, modelId));
            if (!current() || sequence !== expected) return null;
            if (value) { preview = value; if (value.publication) unresolved.delete(value.publication.draftId); }
            return value;
        },
        async trialGeminiImagePrice(source: ModelPricePublicationPreview, parameters: GeminiImageSpecification, budgetCredits: number) {
            if (!current()) return null;
            if (source !== preview || !source.draft) throw new PlatformServiceError("请重新读取已保存的价格草稿。");
            const input = { draftVersion: source.draft.version, priceVersion: source.latestPriceVersion, parameters, budgetCredits };
            const expected = estimateGeminiImagePrice(source.draft, source.latestPriceVersion, input);
            if (expected.status !== "quoted") throw new PlatformServiceError(expected.status === "budget_insufficient"
                ? "试算预算不足以覆盖一张图片。" : "所选规格没有有效按张售价，请核对草稿。");
            const query = new URLSearchParams({ modelId: source.modelId, draftVersion: String(input.draftVersion), priceVersion: String(input.priceVersion),
                ...parameters, budgetCredits: String(budgetCredits) });
            return request(`/api/v1/admin/model-price-publications?${query}`, data => {
                const invalid = () => new PlatformServiceError("试算回执不一致，请重读价格版本后核对。");
                if (!record(data) || !record(data.quote) || !record(data.quote.parameters)) throw invalid();
                const { parameters: spec, ...rest } = expected.quote;
                const { parameters: observed, ...receipt } = data.quote;
                if (Object.keys(receipt).length !== Object.keys(rest).length || Object.entries(rest).some(([key, value]) => receipt[key] !== value) ||
                    Object.keys(observed).length !== 2 || observed.aspectRatio !== spec.aspectRatio || observed.imageSize !== spec.imageSize) throw invalid();
                return expected.quote;
            }, undefined, "无法核对试算结果，请重读草稿和价格版本。");
        },
        async publish(source: ModelPricePublicationPreview, publicPriceNote: string): Promise<AdminModelPricePublication | null> {
            if (!current()) return null;
            if (source !== preview || !source.draft || source.publication || source.unavailableReason || [...unresolved.values()].includes(source.modelId)) throw new PlatformServiceError("请先重新读取并核对已保存版本；结果未知时只能只读核对。");
            const draft = source.draft, price = publishedDraftPrice(draft.binding, draft.rules);
            const body = parseModelPricePublishWrite({ modelId: source.modelId, draftId: draft.id, expectedDraftVersion: draft.version, expectedPriceVersion: source.latestPriceVersion, binding: draft.binding, publicPriceNote });
            if (!body || price === null || !draft.bindingMatchesCurrent) throw publicationFormatError();
            preview = null; unresolved.set(draft.id, draft.modelId);
            return request("/api/v1/admin/model-price-publications", (value) => {
                if (!record(value)) throw publicationFormatError();
                const result = modelPricePublication(value.publication);
                if (result.modelId !== body.modelId || result.draftId !== body.draftId || result.draftVersion !== body.expectedDraftVersion || result.publicPriceNote !== body.publicPriceNote
                    || !sameModelPriceBinding(result.binding, body.binding) || !samePricingAmount(result, price) || rulesSignature(result.rules) !== rulesSignature(draft.rules)) throw publicationFormatError();
                unresolved.delete(draft.id); return result;
            }, body);
        },
    };
}
