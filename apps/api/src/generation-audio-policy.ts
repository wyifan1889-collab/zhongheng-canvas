import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@infinite-canvas/database";
import { modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential } from "@infinite-canvas/database/schema";
import { publishedPriceMatchesCurrentBinding } from "@infinite-canvas/database/model-price-publications";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { listPublicModels } from "@infinite-canvas/database/models";
import { audioSpeechCapabilities, parseGenerationAudioRequest } from "./generation-audio-request";
import { GenerationContractError, type GenerationIntent } from "./generation-contract";
import type { GenerationQuote } from "./generation-dispatch";

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value);
}

export function audioQuoteFingerprint(ownerId: string, intent: GenerationIntent, price: GenerationQuote): string {
    return createHash("sha256").update(canonical({ domain: "audio-quote-v1", ownerId, modelId: intent.modelId,
        input: intent.inputSnapshot, parameters: intent.parameterSnapshot, projectId: intent.projectId ?? null,
        spaceId: intent.spaceId ?? null, nodeId: intent.nodeId ?? null, pricePublicationId: price.pricePublicationId,
        priceVersion: price.priceVersion, creditsPerUnit: price.creditsPerUnit, quotedUnits: price.quotedUnits, billingUnit: "request" })).digest("hex");
}

export function assertGenerationAudioIntent(intent: GenerationIntent, providerModel?: string) {
    const result = parseGenerationAudioRequest(intent.inputSnapshot, intent.parameterSnapshot, providerModel);
    if ("errorCode" in result) throw new GenerationContractError("unsupported_generation", result.errorCode === "audio_instructions_unsupported"
        ? "该模型不支持风格和语言指令，请清空这两项" : result.errorCode === "audio_voice_unsupported" ? "该模型不支持所选音色"
            : "当前仅支持文字转语音，请检查文本、音色、格式及风格参数");
}

function audioPricingQuery(db: Database, modelId?: string) {
    const now = new Date();
    return db.select({ id: modelCatalog.publicId, displayName: modelCatalog.displayName, providerModel: modelCatalog.providerModel,
        priceVersion: modelPricing.version, billingUnit: modelPricing.billingUnit, creditsPerUnit: modelPricing.creditsPerUnit,
        priceNote: modelPricePublication.publicPriceNote, publicationId: modelPricePublication.id,
    }).from(modelCatalog).innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
        .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .innerJoin(modelPricing, eq(modelPricing.modelId, modelCatalog.id))
        .innerJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(and(eq(modelCatalog.enabled, true), eq(modelCatalog.capability, "audio"), eq(modelProvider.enabled, true),
            eq(modelProvider.adapter, "openai-compatible"), eq(modelPricing.enabled, true), lte(modelPricing.effectiveFrom, now),
            or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, now)), publishedPriceMatchesCurrentBinding(),
            modelId === undefined ? undefined : eq(modelCatalog.publicId, modelId)))
        .orderBy(asc(modelCatalog.publicId), desc(modelPricing.version));
}

function validPrice(row: { billingUnit: string; creditsPerUnit: number | null; providerModel: string }) {
    return row.billingUnit === "request" && Number.isSafeInteger(row.creditsPerUnit) && Number(row.creditsPerUnit) > 0 && audioSpeechCapabilities(row.providerModel);
}

export async function listExecutableAudioModels(db: Database) {
    const seen = new Set<string>();
    const groups = new Map((await listPublicModels(db)).map(model => [model.id, model.group]));
    return (await audioPricingQuery(db)).flatMap(row => {
        if (seen.has(row.id)) return [];
        seen.add(row.id);
        const audio = validPrice(row);
        return audio ? [{ id: row.id, displayName: row.displayName, capability: "audio" as const, group: groups.get(row.id) ?? null, audio,
            audioPricing: { priceVersion: row.priceVersion, billingUnit: "request" as const, creditsPerUnit: row.creditsPerUnit!,
                ...(row.priceNote === null ? {} : { priceNote: row.priceNote }) } }] : [];
    });
}

export async function resolveExecutableAudioQuote(db: Database, intent: GenerationIntent, ownerId: string, lock = false): Promise<GenerationQuote> {
    assertGenerationAudioIntent(intent);
    const query = audioPricingQuery(db, intent.modelId).limit(1);
    const [price] = await (lock ? query.for("share", { of: [alias(modelCatalog, "model_catalog"), alias(modelProvider, "model_provider"),
        alias(modelProviderCredential, "model_provider_credential"), alias(modelPricing, "model_pricing")] }) : query);
    if (!price || !validPrice(price)) throw new GenerationContractError("unsupported_generation", "该模型暂不支持平台语音生成或尚未发布按次价格");
    assertGenerationAudioIntent(intent, price.providerModel);
    const quote: GenerationQuote = { modelId: price.id, priceVersion: price.priceVersion, billingUnit: "request",
        creditsPerUnit: price.creditsPerUnit!, quotedUnits: price.creditsPerUnit!, pricePublicationId: price.publicationId,
        ...(price.priceNote === null ? {} : { priceNote: price.priceNote }) };
    quote.quoteFingerprint = audioQuoteFingerprint(ownerId, intent, quote);
    return quote;
}

export async function getAudioTaskSnapshot(db: Database, task: Pick<GenerationTaskView,
    "modelId" | "priceVersion" | "pricePublicationId" | "billingUnitSnapshot" | "creditsPerUnitSnapshot" | "quotedUnits" | "inputSnapshot" | "parameterSnapshot">) {
    const [source] = await db.select({ capability: modelCatalog.capability, draftCapability: modelPriceDraft.capabilitySnapshot,
        publicationId: modelPricePublication.id, billingUnit: modelPricing.billingUnit, creditsPerUnit: modelPricing.creditsPerUnit,
    }).from(modelCatalog).leftJoin(modelPricing, and(eq(modelPricing.modelId, modelCatalog.id), eq(modelPricing.version, task.priceVersion ?? -1)))
        .leftJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .leftJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .where(eq(modelCatalog.publicId, task.modelId)).limit(1);
    if (source?.draftCapability !== "audio" && source?.capability !== "audio") return null;
    if (source.draftCapability !== "audio" || !source.publicationId || source.publicationId !== task.pricePublicationId || source.billingUnit !== "request" ||
        task.billingUnitSnapshot !== "request" || task.creditsPerUnitSnapshot !== source.creditsPerUnit || task.quotedUnits !== source.creditsPerUnit ||
        "errorCode" in parseGenerationAudioRequest(task.inputSnapshot, task.parameterSnapshot)) return { status: "invalid" as const };
    return { status: "recorded" as const, input: { text: task.inputSnapshot.text as string }, parameters: { ...task.parameterSnapshot } };
}

export function publicAudioQuote(quote: GenerationQuote) {
    return { modelId: quote.modelId, priceVersion: quote.priceVersion, billingUnit: "request" as const,
        creditsPerUnit: quote.creditsPerUnit, quotedUnits: quote.quotedUnits, quoteFingerprint: quote.quoteFingerprint!,
        ...(quote.priceNote === undefined ? {} : { priceNote: quote.priceNote }) };
}
