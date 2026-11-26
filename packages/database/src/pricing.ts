import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { publishedGeminiImagePrice, type PublishedGeminiImagePrice, publishedImageSpecDraftPrice, publishedVideoSpecDraftPrice, publishedTextDraftRates, newTextPriceEligibility, type TextPriceDerivationMetadata, type PublishedImageSpecPrice, type PublishedVideoSpecPrice, type PublishedScalarPrice, type PublishedTextRates } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential, type BillingUnit, type ScalarBillingUnit } from "./schema";
import { publishedPriceMatchesCurrentBinding } from "./model-price-publications";

export type { BillingUnit, ScalarBillingUnit } from "./schema";

export type PublicModelPricing = {
    modelId: string;
    displayName: string;
    capability: "text" | "image" | "video" | "audio";
    version: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    priceNote?: string;
    textPriceDerivation?: TextPriceDerivationMetadata;
} & (PublishedScalarPrice | PublishedTextRates | PublishedImageSpecPrice | PublishedGeminiImagePrice | PublishedVideoSpecPrice);

export type AdminModelPricing = PublicModelPricing & {
    id: string;
    modelCatalogId: string;
    providerId: string;
    providerDisplayName: string;
    providerEnabled: boolean;
    modelEnabled: boolean;
    deleted: boolean;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type GenerationPricingSnapshot = {
    modelId: string;
    priceVersion: number;
    billingUnit: ScalarBillingUnit;
    creditsPerUnit: number;
};

function publicView(row: {
    modelId: string;
    displayName: string;
    capability: "text" | "image" | "video" | "audio";
    version: number;
    billingUnit: BillingUnit;
    creditsPerUnit: number | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    priceNote?: string | null;
    sourceDraft: typeof modelPriceDraft.$inferSelect | null;
}): PublicModelPricing {
    let price: PublishedScalarPrice | PublishedTextRates | PublishedImageSpecPrice | PublishedGeminiImagePrice | PublishedVideoSpecPrice;
    if (row.billingUnit === "text_tokens" || row.billingUnit === "image_specs" || row.billingUnit === "video_specs") {
        const draft = row.sourceDraft;
        const binding = draft && { providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot,
            adapter: draft.adapterSnapshot, endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot };
        const rates = draft && binding && (row.billingUnit === "text_tokens" ? publishedTextDraftRates(binding, draft.rules)
            : row.billingUnit === "video_specs" ? publishedVideoSpecDraftPrice(binding, draft.rules) : publishedImageSpecDraftPrice(binding, draft.rules) ?? publishedGeminiImagePrice(binding, draft.rules));
        if (!rates || row.creditsPerUnit !== null) throw new Error("Invalid published structured price source");
        price = rates;
    } else {
        if (row.creditsPerUnit === null) throw new Error("Invalid scalar model price");
        price = { billingUnit: row.billingUnit, creditsPerUnit: row.creditsPerUnit };
    }
    const draft = row.sourceDraft;
    const explanation = row.billingUnit === "text_tokens" && draft ? newTextPriceEligibility({
        providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot,
        endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot,
    }, draft.rules, row.version) : null;
    return {
        modelId: row.modelId,
        displayName: row.displayName,
        capability: row.sourceDraft?.capabilitySnapshot ?? row.capability,
        version: row.version,
        ...price,
        ...(explanation?.status === "available" ? { textPriceDerivation: explanation.metadata } : {}),
        effectiveFrom: row.effectiveFrom.toISOString(),
        effectiveTo: row.effectiveTo?.toISOString() ?? null,
        ...(row.priceNote === null || row.priceNote === undefined ? {} : { priceNote: row.priceNote }),
    };
}

/** Return only currently effective prices for enabled provider/model entries. */
export async function listPublicModelPricing(db: Database, now = new Date()): Promise<PublicModelPricing[]> {
    const rows = await db.select({
        modelId: modelCatalog.publicId,
        displayName: modelCatalog.displayName,
        capability: modelCatalog.capability,
        version: modelPricing.version,
        billingUnit: modelPricing.billingUnit,
        creditsPerUnit: modelPricing.creditsPerUnit,
        effectiveFrom: modelPricing.effectiveFrom,
        effectiveTo: modelPricing.effectiveTo,
        priceNote: modelPricePublication.publicPriceNote,
        sourceDraft: modelPriceDraft,
    }).from(modelPricing)
        .innerJoin(modelCatalog, eq(modelPricing.modelId, modelCatalog.id))
        .innerJoin(modelProvider, eq(modelCatalog.providerId, modelProvider.id))
        .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .leftJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(and(
            eq(modelPricing.enabled, true),
            eq(modelCatalog.enabled, true),
            eq(modelProvider.enabled, true),
            lte(modelPricing.effectiveFrom, now),
            or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, now)),
            publishedPriceMatchesCurrentBinding(),
        ))
        .orderBy(asc(modelCatalog.capability), asc(modelCatalog.displayName), asc(modelPricing.version));
    return rows.map(publicView);
}

/**
 * Resolve the currently effective, enabled price that a server-side generation
 * request is allowed to use. The returned fields are copied into the task and
 * must not be replaced by a client-supplied pricing projection.
 */
export async function resolveActiveGenerationPricing(
    db: Database,
    input: { modelId: string; priceVersion?: number; now?: Date },
): Promise<GenerationPricingSnapshot | null> {
    if (!input.modelId.trim() || input.modelId.length > 200) throw new Error("模型 ID 无效");
    if (input.priceVersion !== undefined && (!Number.isSafeInteger(input.priceVersion) || input.priceVersion <= 0)) {
        throw new Error("价格版本无效");
    }
    const now = input.now ?? new Date();
    const conditions = [
        eq(modelCatalog.publicId, input.modelId),
        eq(modelCatalog.enabled, true),
        eq(modelProvider.enabled, true),
        eq(modelPricing.enabled, true),
        lte(modelPricing.effectiveFrom, now),
        or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, now)),
        publishedPriceMatchesCurrentBinding(),
    ];
    if (input.priceVersion !== undefined) conditions.push(eq(modelPricing.version, input.priceVersion));
    const [row] = await db.select({
        modelId: modelCatalog.publicId,
        priceVersion: modelPricing.version,
        billingUnit: modelPricing.billingUnit,
        creditsPerUnit: modelPricing.creditsPerUnit,
    }).from(modelPricing)
        .innerJoin(modelCatalog, eq(modelPricing.modelId, modelCatalog.id))
        .innerJoin(modelProvider, eq(modelCatalog.providerId, modelProvider.id))
        .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .leftJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(and(...conditions))
        .orderBy(desc(modelPricing.version))
        .limit(1);
    if (!row || row.billingUnit === "text_tokens" || row.billingUnit === "image_specs" || row.billingUnit === "video_specs" || row.creditsPerUnit === null || !Number.isSafeInteger(row.creditsPerUnit) || row.creditsPerUnit <= 0) return null;
    return { ...row, billingUnit: row.billingUnit, creditsPerUnit: row.creditsPerUnit };
}

/** Admin projection includes historical/disabled prices but no provider secret. */
export async function listAdminModelPricing(db: Database): Promise<AdminModelPricing[]> {
    const rows = await db.select({
        id: modelPricing.id,
        modelCatalogId: modelCatalog.id,
        modelId: modelCatalog.publicId,
        displayName: modelCatalog.displayName,
        capability: modelCatalog.capability,
        version: modelPricing.version,
        billingUnit: modelPricing.billingUnit,
        creditsPerUnit: modelPricing.creditsPerUnit,
        effectiveFrom: modelPricing.effectiveFrom,
        effectiveTo: modelPricing.effectiveTo,
        providerId: modelProvider.id,
        providerDisplayName: modelProvider.displayName,
        providerEnabled: modelProvider.enabled,
        modelEnabled: modelCatalog.enabled,
        deleted: or(isNotNull(modelCatalog.deletedAt), isNotNull(modelProvider.deletedAt)),
        enabled: modelPricing.enabled,
        createdAt: modelPricing.createdAt,
        updatedAt: modelPricing.updatedAt,
        priceNote: modelPricePublication.publicPriceNote,
        sourceDraft: modelPriceDraft,
    }).from(modelPricing)
        .innerJoin(modelCatalog, eq(modelPricing.modelId, modelCatalog.id))
        .innerJoin(modelProvider, eq(modelCatalog.providerId, modelProvider.id))
        .leftJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .orderBy(asc(modelCatalog.capability), asc(modelCatalog.displayName), asc(modelPricing.version));
    return rows.map((row) => ({
        ...publicView(row),
        id: row.id,
        modelCatalogId: row.modelCatalogId,
        providerId: row.providerId,
        providerDisplayName: row.providerDisplayName,
        providerEnabled: row.providerEnabled,
        modelEnabled: row.modelEnabled,
        deleted: row.deleted === true,
        enabled: row.enabled,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    }));
}
