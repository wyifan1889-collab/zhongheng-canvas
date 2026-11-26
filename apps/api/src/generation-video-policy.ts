import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@infinite-canvas/database";
import { modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential } from "@infinite-canvas/database/schema";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { listPublicModels } from "@infinite-canvas/database/models";
import { computeObjectEtag, objectKey, type ObjectStorage } from "@infinite-canvas/storage";
import { publishedVideoSpecDraftPrice, resolveVideoSpecDraftSelection } from "../../../packages/shared/src/model-price-publications";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type PublicVideoQuote, type VideoBinding, type VideoGenerationModel, type VideoQuoteSnapshot } from "../../../packages/shared/src/generation-video";
import { GenerationContractError, type GenerationIntent } from "./generation-contract";
import type { VideoRuntimePolicy } from "./generation-video-config";
import { parseGenerationVideoRequest } from "./generation-video-request";

export type VideoReferenceResources = {
    storage: ObjectStorage;
    /** Must fully decode the image under the configured resource boundary, never inspect a URL. */
    verifyReference: (body: Uint8Array, contentType: string, policy: VideoRuntimePolicy) => Promise<{ width: number; height: number } | null>;
};
export type VideoGenerationQuote = PublicVideoQuote & { binding: VideoBinding; videoQuoteSnapshot: VideoQuoteSnapshot };

function priceQuery(db: Database, modelId?: string) {
    const now = new Date();
    return db.select({ id: modelCatalog.publicId, modelCatalogId: modelCatalog.id, displayName: modelCatalog.displayName, providerId: modelProvider.id,
        providerModel: modelCatalog.providerModel, endpoint: modelProvider.endpoint, adapter: modelProvider.adapter,
        priceVersion: modelPricing.version, billingUnit: modelPricing.billingUnit, creditsPerUnit: modelPricing.creditsPerUnit,
        publicationId: modelPricePublication.id, priceNote: modelPricePublication.publicPriceNote, draft: modelPriceDraft,
    }).from(modelCatalog).innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
        .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .innerJoin(modelPricing, eq(modelPricing.modelId, modelCatalog.id))
        .leftJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(and(eq(modelCatalog.enabled, true), eq(modelCatalog.capability, "video"), eq(modelProvider.enabled, true),
            eq(modelProvider.adapter, "openai-compatible"), eq(modelPricing.enabled, true), lte(modelPricing.effectiveFrom, now),
            or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, now)), modelId ? eq(modelCatalog.publicId, modelId) : undefined))
        .orderBy(asc(modelCatalog.publicId), desc(modelPricing.version));
}
function draftBinding(row: Awaited<ReturnType<typeof priceQuery>>[number]) {
    return { providerId: row.providerId, providerModel: row.providerModel, endpoint: row.endpoint, adapter: row.adapter, capability: "video" as const };
}
type PriceRow = Awaited<ReturnType<typeof priceQuery>>[number];
function sourceMatches(row: PriceRow): row is PriceRow & { draft: NonNullable<PriceRow["draft"]>; publicationId: string } {
    const draft = row.draft;
    return !!draft && !!row.publicationId && draft.modelId === row.modelCatalogId && draft.capabilitySnapshot === "video" && draft.providerIdSnapshot === row.providerId &&
        draft.providerModelSnapshot === row.providerModel && draft.endpointSnapshot === row.endpoint && draft.adapterSnapshot === row.adapter;
}
function endpointSupported(endpoint: string) {
    try { const url = new URL(endpoint); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && /\/v1\/?$/.test(url.pathname); }
    catch { return false; }
}
export async function listExecutableVideoModels(db: Database, policy: VideoRuntimePolicy): Promise<VideoGenerationModel[]> {
    const seen = new Set<string>(), groups = new Map((await listPublicModels(db)).map(model => [model.id, model.group]));
    return (await priceQuery(db)).flatMap(row => {
        if (seen.has(row.id)) return []; seen.add(row.id);
        if (!sourceMatches(row)) return [];
        const price = publishedVideoSpecDraftPrice(draftBinding(row), row.draft.rules);
        if (!price || String(row.billingUnit) !== "video_specs" || row.creditsPerUnit !== null || !endpointSupported(row.endpoint)) return [];
        const videoSpecs = price.videoSpecs.filter(spec => spec.parameters.durationSeconds * 1000 <= policy.maxMediaDurationMs);
        return videoSpecs.length ? [{ id: row.id, displayName: row.displayName, capability: "video" as const, group: groups.get(row.id) ?? null,
            videoPricing: { ...price, videoSpecs, priceVersion: row.priceVersion, ...(row.priceNote === null ? {} : { priceNote: row.priceNote }) } }] : [];
    });
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
}
export function videoQuoteFingerprint(ownerId: string, intent: GenerationIntent, snapshot: VideoQuoteSnapshot): string {
    return createHash("sha256").update(canonical({ domain: "video-quote-v1", ownerId, modelId: intent.modelId, input: intent.inputSnapshot,
        parameters: intent.parameterSnapshot, projectId: intent.projectId ?? null, spaceId: intent.spaceId ?? null, nodeId: intent.nodeId ?? null, snapshot })).digest("hex");
}
export async function resolveExecutableVideoQuote(db: Database, intent: GenerationIntent, ownerId: string,
    policy: VideoRuntimePolicy, lock = false, resources?: VideoReferenceResources): Promise<VideoGenerationQuote> {
    const request = parseGenerationVideoRequest(intent);
    const query = priceQuery(db, intent.modelId).limit(1);
    const [row] = await (lock ? query.for("share", { of: [alias(modelCatalog, "model_catalog"), alias(modelProvider, "model_provider"),
        alias(modelProviderCredential, "model_provider_credential"), alias(modelPricing, "model_pricing")] }) : query);
    const selected = row && sourceMatches(row) && resolveVideoSpecDraftSelection(draftBinding(row), row.draft.rules, request.parameters);
    if (!row || !sourceMatches(row) || String(row.billingUnit) !== "video_specs" || row.creditsPerUnit !== null || !selected || !endpointSupported(row.endpoint) ||
        request.parameters.durationSeconds * 1000 > policy.maxMediaDurationMs) throw new GenerationContractError("unsupported_generation", "该视频规格没有已发布的可执行价格");
    const snapshot: VideoQuoteSnapshot = { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY,
        publicationId: row.publicationId, priceVersion: row.priceVersion, selectedBand: selected, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: selected.creditsPerVideo };
    if (request.input.referenceMediaId) {
        if (!resources) throw new GenerationContractError("unsupported_generation", "首帧私有媒体校验尚未就绪");
        const media = await createMediaRepository(db).get(ownerId, request.input.referenceMediaId);
        if (!media || media.kind !== "image" || !policy.referenceContentTypes.includes(media.contentType) || media.sizeBytes > policy.referenceMaxBytes) {
            throw new GenerationContractError("invalid_input", "首帧素材不属于当前账号或超出已配置能力");
        }
        const expectedKey = objectKey(`accounts/${Buffer.from(ownerId).toString("base64url")}/media/${media.id}`);
        const stored = await resources.storage.get(expectedKey);
        if (media.objectKey !== expectedKey || !stored || stored.metadata.key !== expectedKey || stored.body.byteLength !== media.sizeBytes ||
            stored.metadata.sizeBytes !== media.sizeBytes || stored.metadata.contentType !== media.contentType || stored.metadata.etag !== media.etag ||
            await computeObjectEtag(stored.body) !== media.etag) throw new GenerationContractError("invalid_input", "首帧私有素材完整性无法确认");
        const checked = await resources.verifyReference(stored.body, media.contentType, policy);
        if (!checked || ![checked.width, checked.height].every(n => Number.isSafeInteger(n) && n > 0) || checked.width * checked.height > policy.referenceMaxPixels) {
            throw new GenerationContractError("invalid_input", "首帧图片探测未通过");
        }
        snapshot.referenceSnapshot = { mediaId: media.id, etag: media.etag, contentType: media.contentType, sizeBytes: media.sizeBytes };
    }
    return { modelId: intent.modelId, priceVersion: row.priceVersion, parameters: request.parameters, quotedVideoUnits: 1, maxVideoUnits: 1,
        reservedCredits: snapshot.reservedCredits, usagePolicy: VIDEO_USAGE_POLICY, quoteFingerprint: videoQuoteFingerprint(ownerId, intent, snapshot),
        binding: { protocol: VIDEO_PROTOCOL, providerId: row.providerId, providerModel: row.providerModel, endpoint: row.endpoint }, videoQuoteSnapshot: snapshot,
        ...(row.priceNote === null ? {} : { priceNote: row.priceNote }) };
}
export function publicVideoQuote(quote: VideoGenerationQuote): PublicVideoQuote {
    return { modelId: quote.modelId, priceVersion: quote.priceVersion, parameters: quote.parameters, quotedVideoUnits: 1, maxVideoUnits: 1,
        reservedCredits: quote.reservedCredits, usagePolicy: VIDEO_USAGE_POLICY, quoteFingerprint: quote.quoteFingerprint,
        ...(quote.priceNote === undefined ? {} : { priceNote: quote.priceNote }) };
}
