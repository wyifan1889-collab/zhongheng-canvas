import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { executableAudioDraftCredits, executableImageDraftCredits, imageSpecParametersFromTask, publishedDraftPrice, publishedTextDraftRates, parseTextQuoteSnapshot, resolveImageSpecDraftSelection, resolveVideoSpecDraftSelection, sameModelPriceBinding, type AdminModelPriceDraft, type AdminModelPricePublication,
    OPENAI_IMAGE_PROTOCOL, imageGenerationSpec, imageModelMaxCount, type ImageSpecification, type ModelPriceBinding, type ModelPricePublicationPreview, type ModelPricePublishWrite, type PricePublicationUnavailableReason } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { parseVideoParameters, parseVideoQuoteSnapshot, sameVideoParameters, type VideoParameters } from "../../shared/src/generation-video";
import { modelPriceDraftView } from "./model-price-drafts";
import { parseModelPriceRules } from "../../shared/src/model-pricing-drafts";
import { contextTierRates } from "../../shared/src/model-price-derivation";
import { validTextContextTierNote } from "../../shared/src/model-price-publications";
import type { TextSettlementPolicy } from "../../shared/src/text-billing";
import { auditEvent, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential } from "./schema";

import { GEMINI_IMAGE_PROTOCOL, parseGeminiImageIntent, type GeminiImageIntent } from "../../shared/src/generation-gemini-image";
import { publishedGeminiImagePrice, selectGeminiImageBand } from "../../shared/src/gemini-image-price-trial";

type CurrentBinding = Omit<ModelPriceBinding, "capability"> & { capability: "text" | "image" | "video" | "audio" };
type PublicationRow = typeof modelPricePublication.$inferSelect;
type PriceRow = typeof modelPricing.$inferSelect;

function view(publication: PublicationRow, price: PriceRow, draft: AdminModelPriceDraft): AdminModelPricePublication {
    const published = publishedDraftPrice(draft.binding, draft.rules);
    if (!published || price.billingUnit !== published.billingUnit || price.creditsPerUnit !== published.creditsPerUnit) throw new Error("Invalid published model price");
    return {
        id: publication.id, modelId: draft.modelId, draftId: draft.id, draftVersion: draft.version,
        priceVersion: price.version, ...published,
        publicPriceNote: publication.publicPriceNote, rules: draft.rules, binding: draft.binding,
        bindingMatchesCurrent: draft.bindingMatchesCurrent, createdAt: publication.createdAt.toISOString(),
    };
}

function unavailable(draft: AdminModelPriceDraft | null, enabled: boolean, allowGeminiImage: boolean): PricePublicationUnavailableReason | null {
    if (!draft) return "draft_missing";
    if (!draft.bindingMatchesCurrent) return "model_binding_changed";
    const price = publishedDraftPrice(draft.binding, draft.rules);
    if (!price || (!allowGeminiImage && price.billingUnit === "image_specs" && price.protocol === GEMINI_IMAGE_PROTOCOL)) return "unsupported_price_rule";
    return enabled ? null : "model_not_publishable";
}

/** One read-only snapshot supplies the saved draft and both legacy/new price CAS baselines. */
export async function getModelPricePublicationPreview(db: Database, modelId: string, allowGeminiImage = false): Promise<ModelPricePublicationPreview | null> {
    return db.transaction(async (tx) => {
        const [current] = await tx.select({
            model: modelCatalog, provider: modelProvider, credentialId: modelProviderCredential.providerId,
        }).from(modelCatalog).innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .leftJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
            .where(and(eq(modelCatalog.publicId, modelId), isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt))).limit(1);
        if (!current) return null;
        const binding: CurrentBinding = { providerId: current.provider.id, providerModel: current.model.providerModel,
            adapter: current.provider.adapter, endpoint: current.provider.endpoint, capability: current.model.capability };
        const [saved] = await tx.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, current.model.id))
            .orderBy(desc(modelPriceDraft.version)).limit(1);
        const [price] = await tx.select().from(modelPricing).where(eq(modelPricing.modelId, current.model.id))
            .orderBy(desc(modelPricing.version)).limit(1);
        const draft = saved ? modelPriceDraftView(saved, modelId, binding) : null;
        const [published] = saved ? await tx.select({ publication: modelPricePublication, price: modelPricing })
            .from(modelPricePublication).innerJoin(modelPricing, eq(modelPricing.id, modelPricePublication.pricingId))
            .where(eq(modelPricePublication.draftId, saved.id)).limit(1) : [];
        let currentPrice: ModelPricePublicationPreview["currentPrice"] = null;
        if (price?.billingUnit === "text_tokens" || price?.billingUnit === "image_specs" || price?.billingUnit === "video_specs") {
            const [source] = await tx.select({ publication: modelPricePublication, draft: modelPriceDraft })
                .from(modelPricePublication).innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
                .where(eq(modelPricePublication.pricingId, price.id)).limit(1);
            if (!source) throw new Error("Published structured price source is missing");
            const fixed = view(source.publication, price, modelPriceDraftView(source.draft, modelId, binding));
            if (fixed.billingUnit === "text_tokens") {
                currentPrice = { version: price.version, enabled: price.enabled, billingUnit: fixed.billingUnit, creditsPerUnit: null,
                    inputCreditsPerMillion: fixed.inputCreditsPerMillion, outputCreditsPerMillion: fixed.outputCreditsPerMillion,
                    ...(fixed.cachedInputCreditsPerMillion === undefined ? {} : { cachedInputCreditsPerMillion: fixed.cachedInputCreditsPerMillion }) };
            } else if (fixed.billingUnit === "image_specs") {
                currentPrice = { version: price.version, enabled: price.enabled, billingUnit: fixed.billingUnit, creditsPerUnit: null,
                    ...(fixed.protocol === OPENAI_IMAGE_PROTOCOL ? { protocol: fixed.protocol, imageSpecs: fixed.imageSpecs } :
                        { protocol: fixed.protocol, imageSpecs: fixed.imageSpecs, usagePolicy: fixed.usagePolicy }) };
            } else if (fixed.billingUnit === "video_specs") {
                currentPrice = { version: price.version, enabled: price.enabled, billingUnit: fixed.billingUnit, creditsPerUnit: null,
                    protocol: fixed.protocol, usagePolicy: fixed.usagePolicy, videoSpecs: fixed.videoSpecs };
            } else throw new Error("Invalid published structured price");
        } else if (price) {
            if (price.creditsPerUnit === null) throw new Error("Invalid scalar model price");
            currentPrice = { version: price.version, billingUnit: price.billingUnit, creditsPerUnit: price.creditsPerUnit, enabled: price.enabled };
        }
        return {
            modelId, draft, latestPriceVersion: price?.version ?? 0,
            currentPrice,
            publication: published && draft ? view(published.publication, published.price, draft) : null,
            unavailableReason: unavailable(draft, current.model.enabled && current.provider.enabled && !!current.credentialId, allowGeminiImage),
        };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

type PublishResult = { status: "published"; publication: AdminModelPricePublication } |
    { status: "model_not_found" | "price_draft_conflict" | "price_publication_conflict" | "model_binding_changed" | "model_not_publishable" | "unsupported_price_rule" };

/** No price supplied by the caller is accepted; the latest immutable draft is the source. */
export async function publishModelPriceDraft(db: Database, input: ModelPricePublishWrite, audit: { actorId: string; requestId: string }, allowGeminiImage = false): Promise<PublishResult> {
    return db.transaction<PublishResult>(async (tx) => {
        const [model] = await tx.select().from(modelCatalog).where(eq(modelCatalog.publicId, input.modelId)).for("update");
        if (!model || model.deletedAt) return { status: "model_not_found" };
        const [provider] = await tx.select().from(modelProvider).where(eq(modelProvider.id, model.providerId)).for("share");
        if (!provider || provider.deletedAt) return { status: "model_binding_changed" };
        const binding: CurrentBinding = { providerId: provider.id, providerModel: model.providerModel,
            adapter: provider.adapter, endpoint: provider.endpoint, capability: model.capability };
        if (!sameModelPriceBinding(input.binding, binding)) return { status: "model_binding_changed" };
        const [saved] = await tx.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, model.id)).orderBy(desc(modelPriceDraft.version)).limit(1);
        if (!saved || saved.id !== input.draftId || saved.version !== input.expectedDraftVersion) return { status: "price_draft_conflict" };
        const draft = modelPriceDraftView(saved, model.publicId, binding);
        if (draft.rules.derivation?.schemaVersion === 2 && !validTextContextTierNote(draft.rules, draft.binding, input.publicPriceNote)) return { status: "unsupported_price_rule" };
        const [credential] = await tx.select({ providerId: modelProviderCredential.providerId }).from(modelProviderCredential)
            .where(eq(modelProviderCredential.providerId, provider.id)).for("share");
        const reason = unavailable(draft, model.enabled && provider.enabled && !!credential, allowGeminiImage);
        if (reason) return { status: reason === "draft_missing" ? "price_draft_conflict" : reason };
        const [latest] = await tx.select().from(modelPricing).where(eq(modelPricing.modelId, model.id)).orderBy(desc(modelPricing.version)).limit(1);
        const [existing] = await tx.select({ publication: modelPricePublication, price: modelPricing }).from(modelPricePublication)
            .innerJoin(modelPricing, eq(modelPricing.id, modelPricePublication.pricingId)).where(eq(modelPricePublication.draftId, saved.id)).limit(1);
        if (existing) {
            // Recover a lost response without a second price or audit. Never reactivate a superseded price.
            if (existing.publication.publicPriceNote !== input.publicPriceNote || existing.price.id !== latest?.id) return { status: "price_publication_conflict" };
            return { status: "published", publication: view(existing.publication, existing.price, draft) };
        }
        const version = latest?.version ?? 0;
        if (input.expectedPriceVersion !== version || version >= 2_147_483_647) return { status: "price_publication_conflict" };
        const publishedPrice = publishedDraftPrice(draft.binding, draft.rules)!;
        await tx.update(modelPricing).set({ enabled: false, updatedAt: new Date() }).where(and(eq(modelPricing.modelId, model.id), eq(modelPricing.enabled, true)));
        const [price] = await tx.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: model.id, version: version + 1,
            billingUnit: publishedPrice.billingUnit, creditsPerUnit: publishedPrice.creditsPerUnit, effectiveFrom: new Date(), effectiveTo: null, enabled: true }).returning();
        const [publication] = await tx.insert(modelPricePublication).values({ id: crypto.randomUUID(), pricingId: price.id, draftId: saved.id, publicPriceNote: input.publicPriceNote }).returning();
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: audit.actorId, action: "model.price.published",
            resourceId: publication.id, revision: price.version, requestId: audit.requestId });
        return { status: "published", publication: view(publication, price, draft) };
    });
}

/** Used only by queries that left-join publication and its immutable source draft. Legacy rows keep their existing policy. */
export function publishedPriceMatchesCurrentBinding() {
    return or(and(isNull(modelPricePublication.id), ne(modelCatalog.capability, "audio"), ne(modelCatalog.capability, "video"), ne(modelPricing.billingUnit, "text_tokens"), ne(modelPricing.billingUnit, "image_specs"), ne(modelPricing.billingUnit, "video_specs")), and(
        eq(modelPriceDraft.modelId, modelPricing.modelId),
        or(and(or(eq(modelPricing.billingUnit, "request"), eq(modelPricing.billingUnit, "image_specs")), eq(modelPriceDraft.capabilitySnapshot, "image")),
            and(eq(modelPricing.billingUnit, "request"), eq(modelPriceDraft.capabilitySnapshot, "audio")),
            and(eq(modelPricing.billingUnit, "video_specs"), eq(modelPriceDraft.capabilitySnapshot, "video")),
            and(eq(modelPricing.billingUnit, "text_tokens"), eq(modelPriceDraft.capabilitySnapshot, "text"))),
        eq(modelPriceDraft.providerIdSnapshot, modelProvider.id), eq(modelPriceDraft.providerModelSnapshot, modelCatalog.providerModel),
        eq(modelPriceDraft.adapterSnapshot, modelProvider.adapter), eq(modelPriceDraft.endpointSnapshot, modelProvider.endpoint),
        eq(modelPriceDraft.capabilitySnapshot, modelCatalog.capability),
    ));
}

export type ImageSpecTaskInput = {
    modelId: string; priceVersion: number | null; pricePublicationId?: string | null;
    billingUnitSnapshot: string | null; creditsPerUnitSnapshot: number | null; quotedUnits?: number | null;
    inputSnapshot?: unknown; parameterSnapshot?: unknown; textQuoteSnapshot?: unknown; videoQuoteSnapshot?: unknown;
};

/** Resolve only the task's immutable publication, never the enabled/current catalogue or source. */
export async function getTextTaskSettlementPolicy(db: Database, task: ImageSpecTaskInput): Promise<TextSettlementPolicy> {
    try {
        const quote = parseTextQuoteSnapshot(task.textQuoteSnapshot);
        if (!quote || task.priceVersion === null || !task.pricePublicationId || task.videoQuoteSnapshot != null ||
            task.billingUnitSnapshot !== null || task.creditsPerUnitSnapshot !== null || (task.quotedUnits != null)) return { status: "invalid" };
        const [row] = await db.select({ price: modelPricing, publication: modelPricePublication, draft: modelPriceDraft })
            .from(modelPricePublication).innerJoin(modelPricing, eq(modelPricing.id, modelPricePublication.pricingId))
            .innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
            .innerJoin(modelCatalog, eq(modelCatalog.id, modelPricing.modelId))
            .where(and(eq(modelPricePublication.id, task.pricePublicationId), eq(modelCatalog.publicId, task.modelId), eq(modelPricing.version, task.priceVersion))).limit(1);
        if (!row || row.draft.modelId !== row.price.modelId || row.price.billingUnit !== "text_tokens" || row.price.creditsPerUnit !== null ||
            row.draft.capabilitySnapshot !== "text") return { status: "invalid" };
        const binding: ModelPriceBinding = { providerId: row.draft.providerIdSnapshot, providerModel: row.draft.providerModelSnapshot,
            adapter: row.draft.adapterSnapshot, endpoint: row.draft.endpointSnapshot, capability: "text" };
        const rules = parseModelPriceRules(row.draft.rules, "text"), rates = rules && publishedTextDraftRates(binding, rules);
        if (!rules || !rates || quote.inputCreditsPerMillion !== rates.inputCreditsPerMillion || quote.outputCreditsPerMillion !== rates.outputCreditsPerMillion ||
            quote.cachedInputCreditsPerMillion !== rates.cachedInputCreditsPerMillion ||
            quote.usageSource !== (binding.adapter === "sub2api" ? "responses" : "chat_completions") ||
            rules.derivation && !sameModelPriceBinding(rules.derivation.binding, binding)) return { status: "invalid" };
        const derivation = rules.derivation;
        if (!derivation || derivation.schemaVersion === 1) return { status: "legacy_fixed" };
        return derivation.schemaVersion === 2 && contextTierRates(derivation) && validTextContextTierNote(rules, binding, row.publication.publicPriceNote)
            ? { status: "context_tiers", derivation } : { status: "invalid" };
    } catch { return { status: "invalid" }; }
}
export type GeminiTaskSource = { status: "gemini"; parameters: GeminiImageIntent; creditsPerImage: number; publicationId: string; binding: ModelPriceBinding };
export type ImageSpecTaskSnapshot = GeminiTaskSource | { status: "legacy" } | { status: "invalid" } |
    (ImageSpecification & { status: "recorded"; creditsPerRequest: number; publicationId: string; maxImagesPerRequest?: number });

/** Historical read model only. It never consults active/enabled prices or current provider bindings. */
export async function getImageSpecTaskSnapshot(db: Database, task: ImageSpecTaskInput): Promise<ImageSpecTaskSnapshot> {
    const nativeIntent = task.billingUnitSnapshot === "image" || (task.parameterSnapshot as Record<string, unknown> | null)?.protocol === GEMINI_IMAGE_PROTOCOL;
    if (task.priceVersion === null) return task.pricePublicationId || nativeIntent ? { status: "invalid" } : { status: "legacy" };
    const [row] = await db.select({ price: modelPricing, publication: modelPricePublication, draft: modelPriceDraft })
        .from(modelPricing).innerJoin(modelCatalog, eq(modelCatalog.id, modelPricing.modelId))
        .leftJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(and(eq(modelCatalog.publicId, task.modelId), eq(modelPricing.version, task.priceVersion))).limit(1);
    if (!row) return task.pricePublicationId || nativeIntent ? { status: "invalid" } : { status: "legacy" };
    if (row.price.billingUnit !== "image_specs") return nativeIntent || task.pricePublicationId != null && task.pricePublicationId !== row.publication?.id
        ? { status: "invalid" } : { status: "legacy" };
    const { price, publication, draft } = row;
    if (!publication || !draft || task.pricePublicationId !== publication.id || draft.modelId !== price.modelId ||
        price.creditsPerUnit !== null || task.textQuoteSnapshot != null || task.videoQuoteSnapshot != null) return { status: "invalid" };
    const binding = { providerId: draft.providerIdSnapshot, providerModel: draft.providerModelSnapshot,
        adapter: draft.adapterSnapshot, endpoint: draft.endpointSnapshot, capability: draft.capabilitySnapshot };
    if (draft.rules?.sale?.template === "image_count") {
        const price = publishedGeminiImagePrice(binding, draft.rules), parameters = parseGeminiImageIntent(task.parameterSnapshot, binding.providerModel);
        const band = price && parameters && selectGeminiImageBand(price, parameters);
        return band && parameters && task.billingUnitSnapshot === "image" && task.creditsPerUnitSnapshot === band.creditsPerImage &&
            task.quotedUnits === parameters.budgetCredits && parameters.budgetCredits >= band.creditsPerImage
            ? { status: "gemini", publicationId: publication.id, binding, parameters, creditsPerImage: band.creditsPerImage } : { status: "invalid" };
    }
    if (task.billingUnitSnapshot !== "request") return { status: "invalid" };
    const parameters = imageSpecParametersFromTask(task.parameterSnapshot);
    const selected = parameters && resolveImageSpecDraftSelection({ providerId: draft.providerIdSnapshot,
        providerModel: draft.providerModelSnapshot, adapter: draft.adapterSnapshot, endpoint: draft.endpointSnapshot,
        capability: draft.capabilitySnapshot }, draft.rules, imageGenerationSpec(parameters));
    const count = parameters?.n ?? 1;
    if (!selected || task.parameterSnapshot.response_format !== draft.rules.image?.responseFormat ||
        count > imageModelMaxCount(draft.providerModelSnapshot, draft.rules.image) || selected.creditsPerRequest !== task.creditsPerUnitSnapshot ||
        !Number.isSafeInteger(selected.creditsPerRequest * count) || selected.creditsPerRequest * count !== task.quotedUnits) return { status: "invalid" };
    return { status: "recorded", protocol: OPENAI_IMAGE_PROTOCOL, parameters: parameters!, creditsPerRequest: selected.creditsPerRequest, publicationId: publication.id,
        ...(draft.rules.image?.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: draft.rules.image.maxImagesPerRequest }),
        ...(draft.rules.image?.responseFormat === undefined ? {} : { responseFormat: draft.rules.image.responseFormat }) };
}

export type VideoSpecTaskSnapshot = { status: "invalid" } | { status: "recorded"; parameters: VideoParameters; creditsPerVideo: number; publicationId: string };

/** A video task has no legacy scalar fallback: it must retain its exact immutable publication and quote. */
export async function getVideoSpecTaskSnapshot(db: Database, task: ImageSpecTaskInput): Promise<VideoSpecTaskSnapshot> {
    const quote = parseVideoQuoteSnapshot(task.videoQuoteSnapshot), parameters = parseVideoParameters(task.parameterSnapshot);
    if (!quote || !parameters || task.textQuoteSnapshot != null || task.priceVersion !== quote.priceVersion ||
        task.pricePublicationId !== quote.publicationId || task.billingUnitSnapshot !== "request" ||
        task.creditsPerUnitSnapshot !== quote.reservedCredits || task.quotedUnits !== quote.reservedCredits ||
        !sameVideoParameters(parameters, quote.selectedBand.parameters)) return { status: "invalid" };
    const input = task.inputSnapshot !== null && typeof task.inputSnapshot === "object" && !Array.isArray(task.inputSnapshot)
        ? task.inputSnapshot as Record<string, unknown> : null;
    if (!input || typeof input.prompt !== "string" || !input.prompt.trim() ||
        Object.keys(input).some(key => key !== "prompt" && key !== "referenceMediaId") ||
        (parameters.mode === "first_frame" ? input.referenceMediaId !== quote.referenceSnapshot?.mediaId
            : Object.hasOwn(input, "referenceMediaId"))) return { status: "invalid" };
    const [row] = await db.select({ price: modelPricing, publication: modelPricePublication, draft: modelPriceDraft })
        .from(modelPricing).innerJoin(modelCatalog, eq(modelCatalog.id, modelPricing.modelId))
        .innerJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(and(eq(modelCatalog.publicId, task.modelId), eq(modelPricing.version, quote.priceVersion),
            eq(modelPricePublication.id, quote.publicationId))).limit(1);
    if (!row || row.price.billingUnit !== "video_specs" || row.price.creditsPerUnit !== null || row.draft.modelId !== row.price.modelId) return { status: "invalid" };
    const selected = resolveVideoSpecDraftSelection({ providerId: row.draft.providerIdSnapshot, providerModel: row.draft.providerModelSnapshot,
        adapter: row.draft.adapterSnapshot, endpoint: row.draft.endpointSnapshot, capability: row.draft.capabilitySnapshot }, row.draft.rules, parameters);
    return selected?.creditsPerVideo === quote.reservedCredits
        ? { status: "recorded", parameters: selected.parameters, creditsPerVideo: selected.creditsPerVideo, publicationId: row.publication.id }
        : { status: "invalid" };
}

/** Historical price versions stay valid for accepted tasks; current binding must still be the approved one. */
export async function validatePublishedGenerationTask(db: Database, task: ImageSpecTaskInput, binding: CurrentBinding): Promise<boolean> {
    if (binding.capability === "video") {
        const fixed = await getVideoSpecTaskSnapshot(db, task);
        if (fixed.status !== "recorded") return false;
        const [draft] = await db.select({ source: modelPriceDraft }).from(modelPricePublication)
            .innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
            .where(eq(modelPricePublication.id, fixed.publicationId)).limit(1);
        return !!draft && modelPriceDraftView(draft.source, task.modelId, binding).bindingMatchesCurrent;
    }
    if (task.videoQuoteSnapshot != null) return false;
    if (task.priceVersion === null) return binding.capability !== "audio" && task.textQuoteSnapshot == null && !task.pricePublicationId;
    const [row] = await db.select({ publication: modelPricePublication, price: modelPricing, draft: modelPriceDraft })
        .from(modelPricing).leftJoin(modelPricePublication, eq(modelPricing.id, modelPricePublication.pricingId))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .innerJoin(modelCatalog, eq(modelCatalog.id, modelPricing.modelId))
        .where(and(eq(modelCatalog.publicId, task.modelId), eq(modelPricing.version, task.priceVersion))).limit(1);
    if (!row) return binding.capability !== "audio" && task.textQuoteSnapshot == null && !task.pricePublicationId;
    if (row.price.billingUnit === "image_specs") {
        const snapshot = await getImageSpecTaskSnapshot(db, task);
        return (snapshot.status === "recorded" || snapshot.status === "gemini") && !!row.draft && modelPriceDraftView(row.draft, task.modelId, binding).bindingMatchesCurrent;
    }
    if (!row.publication || !row.draft) return binding.capability !== "audio" && task.textQuoteSnapshot == null && row.price.billingUnit !== "text_tokens" && !task.pricePublicationId;
    if (task.pricePublicationId != null && task.pricePublicationId !== row.publication.id) return false;
    const draft = modelPriceDraftView(row.draft, task.modelId, binding);
    if (task.textQuoteSnapshot != null) {
        const quote = parseTextQuoteSnapshot(task.textQuoteSnapshot), rates = publishedTextDraftRates(draft.binding, draft.rules);
        return !!quote && !!rates && draft.bindingMatchesCurrent && row.price.billingUnit === "text_tokens" && row.price.creditsPerUnit === null &&
            task.billingUnitSnapshot === null && task.creditsPerUnitSnapshot === null &&
            quote.inputCreditsPerMillion === rates.inputCreditsPerMillion && quote.outputCreditsPerMillion === rates.outputCreditsPerMillion &&
            quote.cachedInputCreditsPerMillion === rates.cachedInputCreditsPerMillion &&
            quote.usageSource === (draft.binding.adapter === "sub2api" ? "responses" : "chat_completions");
    }
    return draft.bindingMatchesCurrent && task.billingUnitSnapshot === "request" &&
        row.price.creditsPerUnit === task.creditsPerUnitSnapshot && (binding.capability === "audio"
            ? task.pricePublicationId === row.publication.id && task.quotedUnits === task.creditsPerUnitSnapshot && executableAudioDraftCredits(draft.binding, draft.rules) === task.creditsPerUnitSnapshot
            : executableImageDraftCredits(draft.binding, draft.rules) === task.creditsPerUnitSnapshot);
}
