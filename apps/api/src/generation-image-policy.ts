import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { OPENAI_IMAGE_PROTOCOL, canonicalImageSpecTaskParameters, publishedImageSpecDraftPrice, resolveImageSpecDraftSelection, parseImageGenerationParameters, imageGenerationSpec, imageModelMaxCount } from "@infinite-canvas/shared";
import type { Database } from "@infinite-canvas/database";
import { modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential } from "@infinite-canvas/database/schema";
import { publishedPriceMatchesCurrentBinding } from "@infinite-canvas/database/model-price-publications";
import { listPublicModels } from "@infinite-canvas/database/models";
import { GenerationContractError, type GenerationIntent } from "./generation-contract";
import { parseGenerationImageRequest } from "./generation-image-request";
import type { GenerationQuote } from "./generation-dispatch";
import { GEMINI_IMAGE_PROTOCOL, geminiImageDimensions, parseGeminiImageIntent } from "../../../packages/shared/src/generation-gemini-image";
import { publishedGeminiImagePrice, selectGeminiImageBand } from "../../../packages/shared/src/gemini-image-price-trial";
import { geminiQuoteFingerprint, imageQuoteFingerprint } from "./generation-image-quote";
import { imageSpecFitsPixelBudget } from "./generation-image-limits";

function executablePricingQuery(db: Database, modelId?: string) {
    const now = new Date();
    return db.select({
        id: modelCatalog.publicId, displayName: modelCatalog.displayName,
        priceVersion: modelPricing.version, billingUnit: modelPricing.billingUnit, creditsPerUnit: modelPricing.creditsPerUnit,
        priceNote: modelPricePublication.publicPriceNote,
        publicationId: modelPricePublication.id, sourceDraft: modelPriceDraft,
    }).from(modelCatalog)
        .innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
        .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .innerJoin(modelPricing, eq(modelPricing.modelId, modelCatalog.id))
        .leftJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(and(
            eq(modelCatalog.enabled, true), eq(modelCatalog.capability, "image"),
            eq(modelProvider.enabled, true), eq(modelProvider.adapter, "openai-compatible"),
            eq(modelPricing.enabled, true), lte(modelPricing.effectiveFrom, now),
            or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, now)),
            modelId === undefined ? undefined : eq(modelCatalog.publicId, modelId),
            publishedPriceMatchesCurrentBinding(),
        )).orderBy(asc(modelCatalog.publicId), desc(modelPricing.version));
}

/** Catalog publication alone does not expose unimplemented or unpriced generation. */
export async function listExecutableImageModels(db: Database, geminiImageEnabled = false) {
    const seen = new Set<string>();
    const executable = (await executablePricingQuery(db)).filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        if (row.billingUnit === "image_specs") {
            const draft = row.sourceDraft;
            const price = draft && row.publicationId && row.creditsPerUnit === null && publishedImageSpecDraftPrice({
                providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot,
                endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot }, draft.rules);
            const gemini = draft && row.publicationId && row.creditsPerUnit === null && publishedGeminiImagePrice({
                providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot,
                endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot }, draft.rules);
            return !!price && price.imageSpecs.some(specification => imageSpecFitsPixelBudget(specification.parameters)) ||
                geminiImageEnabled && !!gemini && gemini.imageSpecs.some(spec => geminiSpecExecutable(spec.parameters));
        }
        return row.billingUnit === "request" && typeof row.creditsPerUnit === "number" && Number.isSafeInteger(row.creditsPerUnit) && row.creditsPerUnit > 0;
    });
    // Group metadata only decorates the executable catalog; it cannot publish a model or change a quote.
    const groups = new Map((await listPublicModels(db)).map(model => [model.id, model.group]));
    return executable.map((row) => {
        const { id, displayName } = row;
        const draft = row.sourceDraft;
        const price = row.billingUnit === "image_specs" && draft && publishedImageSpecDraftPrice({
            providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot,
            endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot }, draft.rules);
        const gemini = row.billingUnit === "image_specs" && draft && publishedGeminiImagePrice({
            providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot,
            endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot }, draft.rules);
        return { id, displayName, capability: "image" as const, group: groups.get(id) ?? null,
            ...(price && draft && imageModelMaxCount(draft.providerModelSnapshot, draft.rules.image) > 1 ? {
                maxImages: imageModelMaxCount(draft.providerModelSnapshot, draft.rules.image),
                ...(draft.rules.image?.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: draft.rules.image.maxImagesPerRequest }) } : {}),
            ...(gemini ? { imagePricing: { priceVersion: row.priceVersion, ...gemini,
                imageSpecs: gemini.imageSpecs.filter(spec => geminiSpecExecutable(spec.parameters)),
                ...(row.priceNote === null ? {} : { priceNote: row.priceNote }) } } : {}),
            ...(price ? { imagePricing: { priceVersion: row.priceVersion, ...price,
                ...(row.priceNote === null ? {} : { priceNote: row.priceNote }) } } : {}) };
    });
}

function geminiSpecExecutable(parameters: Parameters<typeof geminiImageDimensions>[0]) {
    const size = geminiImageDimensions(parameters);
    return !!size && imageSpecFitsPixelBudget({ size: `${size.width}x${size.height}` });
}

export function assertGenerationImageIntent(intent: GenerationIntent) {
    if (intent.parameterSnapshot.protocol === GEMINI_IMAGE_PROTOCOL) {
        if ("errorCode" in parseGenerationImageRequest(intent.inputSnapshot, {})) throw new GenerationContractError("invalid_input", "请输入图片提示词");
        return;
    }
    if ("errorCode" in parseGenerationImageRequest(intent.inputSnapshot, intent.parameterSnapshot)) {
        throw new GenerationContractError("unsupported_generation", "图片生成参数无效，请检查张数和规格");
    }
}

/** Lock the selected rows only inside a dispatch transaction, never during a quote read. */
export async function resolveExecutableImageQuote(db: Database, intent: GenerationIntent, lock = false, ownerId?: string): Promise<GenerationQuote> {
    assertGenerationImageIntent(intent);
    const query = executablePricingQuery(db, intent.modelId).limit(1);
    // PostgreSQL requires unqualified relation names in OF. These are the FROM/JOIN tables' existing names,
    // not new joins; nullable publication/source sides must not be row-locked.
    const [price] = await (lock ? query.for("share", { of: [
        alias(modelCatalog, "model_catalog"), alias(modelProvider, "model_provider"),
        alias(modelProviderCredential, "model_provider_credential"), alias(modelPricing, "model_pricing"),
    ] }) : query);
    if (price?.billingUnit === "image_specs") {
        const draft = price.sourceDraft;
        if (draft?.rules?.sale?.template === "image_count") {
            const binding = { providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot,
                endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot };
            const parameters = parseGeminiImageIntent(intent.parameterSnapshot, binding.providerModel);
            const published = publishedGeminiImagePrice(binding, draft.rules), band = published && parameters && selectGeminiImageBand(published, parameters);
            if (!ownerId || !price.publicationId || price.creditsPerUnit !== null || !parameters || !band)
                throw new GenerationContractError("unsupported_generation", "该图片规格没有可用的已发布单价");
            const dimensions = geminiImageDimensions(parameters);
            if (!dimensions || !imageSpecFitsPixelBudget({ size: dimensions.width + "x" + dimensions.height }))
                throw new GenerationContractError("unsupported_generation", "该规格暂时无法验证或超出图片像素预算");
            if (parameters.budgetCredits < band.creditsPerImage) throw new GenerationContractError("invalid_input", "本次预算至少需覆盖一张图片");
            const gemini = { status: "gemini" as const, binding, parameters, creditsPerImage: band.creditsPerImage, publicationId: price.publicationId };
            return { modelId: price.id, priceVersion: price.priceVersion, billingUnit: "image", creditsPerUnit: band.creditsPerImage,
                quotedUnits: parameters.budgetCredits, gemini, quoteFingerprint: geminiQuoteFingerprint(ownerId, intent, price.priceVersion, gemini),
                ...(price.priceNote === null ? {} : { priceNote: price.priceNote }) };
        }
        const parameters = parseImageGenerationParameters(intent.parameterSnapshot);
        const count = parameters?.n ?? 1;
        const selected = draft && resolveImageSpecDraftSelection({ providerId: draft.providerIdSnapshot,
            providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot,
            endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot }, draft.rules, parameters && imageGenerationSpec(parameters));
        if (!parameters || !selected || !price.publicationId || price.creditsPerUnit !== null || count > imageModelMaxCount(draft!.providerModelSnapshot, draft!.rules.image)) {
            throw new GenerationContractError("unsupported_generation", "该图片规格没有唯一可用报价");
        }
        if (!imageSpecFitsPixelBudget(selected.parameters)) throw new GenerationContractError("unsupported_generation", "该图片规格超过已批准的像素预算");
        if (!ownerId) throw new GenerationContractError("invalid_input", "图片规格报价需要账号身份");
        const total = selected.creditsPerRequest * count;
        if (!Number.isSafeInteger(total)) throw new GenerationContractError("invalid_input", "图片总价超出范围");
        const quote: GenerationQuote = { modelId: price.id, priceVersion: price.priceVersion,
            billingUnit: "request", creditsPerUnit: selected.creditsPerRequest, quotedUnits: total,
            imageSpec: { protocol: OPENAI_IMAGE_PROTOCOL, parameters, ...(draft!.rules.image?.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: draft!.rules.image.maxImagesPerRequest }),
                ...(draft!.rules.image?.responseFormat === undefined ? {} : { responseFormat: draft!.rules.image.responseFormat }) }, pricePublicationId: price.publicationId,
            ...(price.priceNote === null ? {} : { priceNote: price.priceNote }) };
        quote.quoteFingerprint = imageQuoteFingerprint(ownerId, { ...intent,
            parameterSnapshot: canonicalImageSpecTaskParameters(parameters, quote.imageSpec!.responseFormat) }, {
            pricePublicationId: price.publicationId, priceVersion: quote.priceVersion,
            creditsPerUnit: quote.creditsPerUnit, quotedUnits: quote.quotedUnits,
        });
        return quote;
    }
    if (intent.parameterSnapshot.protocol === GEMINI_IMAGE_PROTOCOL || (intent.parameterSnapshot.n ?? 1) !== 1 || !price || price.billingUnit !== "request" || typeof price.creditsPerUnit !== "number" || !Number.isSafeInteger(price.creditsPerUnit) || price.creditsPerUnit <= 0) {
        throw new GenerationContractError("unsupported_generation", "该模型暂不支持平台图片生成");
    }
    return { modelId: price.id, priceVersion: price.priceVersion, billingUnit: "request", creditsPerUnit: price.creditsPerUnit, quotedUnits: price.creditsPerUnit,
        ...(price.priceNote === null ? {} : { priceNote: price.priceNote }) };
}
