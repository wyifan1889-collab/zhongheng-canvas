import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { compareCreditAmounts, normalizeCreditAmount, newTextPriceEligibility, sameModelPriceBinding, type TextPriceDerivationMetadata, type TextQuoteSnapshot } from "@infinite-canvas/shared";
import type { Database } from "@infinite-canvas/database";
import { listPublicModels } from "@infinite-canvas/database/models";
import { publishedPriceMatchesCurrentBinding } from "@infinite-canvas/database/model-price-publications";
import { modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential, officialPriceMapping } from "@infinite-canvas/database/schema";
import { GenerationContractError, parseGenerationIntent, type GenerationIntent } from "./generation-contract";
import { parseGenerationTextRequest } from "./generation-text";
import { validTextContextTierNote } from "../../../packages/shared/src/model-price-publications";

export type TextGenerationIntent = GenerationIntent & { budgetCredits: string };
export type TextGenerationQuote = Omit<TextQuoteSnapshot, "schemaVersion"> & {
    modelId: string; priceVersion: number; billingUnit: "text_tokens"; priceNote?: string; textPriceDerivation: TextPriceDerivationMetadata;
};

/** A budget is explicit consent to reserve credits, not a client-supplied price or token count. */
export function parseTextGenerationIntent(value: unknown): TextGenerationIntent {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new GenerationContractError("invalid_input", "请填写文本内容和本次预算");
    const { budgetCredits: rawBudget, ...rest } = value as Record<string, unknown>;
    const budgetCredits = typeof rawBudget === "string" ? normalizeCreditAmount(rawBudget) : null;
    if (!budgetCredits || compareCreditAmounts(budgetCredits, "0") <= 0) throw new GenerationContractError("invalid_input", "本次预算必须是大于零的积分金额");
    const intent = parseGenerationIntent(rest);
    assertTextGenerationIntent(intent);
    return { ...intent, budgetCredits };
}

export function assertTextGenerationIntent(intent: GenerationIntent) {
    if ("errorCode" in parseGenerationTextRequest(intent.inputSnapshot, intent.parameterSnapshot)) {
        throw new GenerationContractError("unsupported_generation", "当前文本生成仅支持纯文本内容，请检查输入和参数");
    }
}

function query(db: Database, modelId?: string) {
    const now = new Date();
    return db.select({ id: modelCatalog.publicId, displayName: modelCatalog.displayName,
        priceVersion: modelPricing.version, creditsPerUnit: modelPricing.creditsPerUnit,
        providerId: modelProvider.id, providerModel: modelCatalog.providerModel,
        adapter: modelProvider.adapter, endpoint: modelProvider.endpoint,
        rules: modelPriceDraft.rules, priceNote: modelPricePublication.publicPriceNote, mapping: officialPriceMapping,
    }).from(modelCatalog)
        .innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
        .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .innerJoin(modelPricing, eq(modelPricing.modelId, modelCatalog.id))
        .innerJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
        .innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
        .leftJoin(officialPriceMapping, eq(officialPriceMapping.modelId, modelCatalog.publicId))
        .where(and(eq(modelCatalog.enabled, true), eq(modelCatalog.capability, "text"), eq(modelProvider.enabled, true),
            or(eq(modelProvider.adapter, "openai-compatible"), eq(modelProvider.adapter, "sub2api")),
            eq(modelPricing.enabled, true), eq(modelPricing.billingUnit, "text_tokens"), lte(modelPricing.effectiveFrom, now),
            or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, now)),
            modelId === undefined ? undefined : eq(modelCatalog.publicId, modelId), publishedPriceMatchesCurrentBinding(),
        )).orderBy(asc(modelCatalog.publicId), desc(modelPricing.version));
}

function rates(row: Awaited<ReturnType<typeof query>>[number]) {
    const binding = { providerId: row.providerId, providerModel: row.providerModel, adapter: row.adapter, endpoint: row.endpoint, capability: "text" as const };
    const eligible = row.creditsPerUnit === null ? newTextPriceEligibility(binding, row.rules, row.priceVersion) : null;
    const derivation = row.rules && typeof row.rules === "object" && !Array.isArray(row.rules) ? (row.rules as { derivation?: { schemaVersion?: unknown } }).derivation : undefined;
    if (derivation?.schemaVersion === 2 && !validTextContextTierNote(row.rules, binding, row.priceNote)) return { status: "unavailable", reason: "official_three_bucket_required" } as const;
    const mapping = row.mapping;
    if (eligible?.status === "available" && (!mapping || mapping.referenceId !== eligible.metadata.entryId || !sameModelPriceBinding(binding, {
        providerId: mapping.providerIdSnapshot, providerModel: mapping.providerModelSnapshot, adapter: mapping.adapterSnapshot,
        endpoint: mapping.endpointSnapshot, capability: mapping.capabilitySnapshot,
    }))) return { status: "unavailable", reason: "official_three_bucket_required" } as const;
    return eligible;
}

export async function listExecutableTextModels(db: Database) {
    const groups = new Map((await listPublicModels(db)).map(model => [model.id, model.group]));
    const seen = new Set<string>();
    return (await query(db)).filter(row => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return rates(row)?.status === "available";
    }).map(({ id, displayName }) => ({ id, displayName, capability: "text" as const, group: groups.get(id) ?? null }));
}

export async function resolveExecutableTextQuote(db: Database, intent: TextGenerationIntent, lock = false): Promise<TextGenerationQuote> {
    assertTextGenerationIntent(intent);
    const budget = normalizeCreditAmount(intent.budgetCredits);
    if (!budget || compareCreditAmounts(budget, "0") <= 0) throw new GenerationContractError("invalid_input", "本次预算无效");
    const selected = query(db, intent.modelId).limit(1);
    const [row] = await (lock ? selected.for("share", { of: [alias(modelCatalog, "model_catalog"), alias(modelProvider, "model_provider"),
        alias(modelProviderCredential, "model_provider_credential"), alias(modelPricing, "model_pricing")] }) : selected);
    const eligible = row && rates(row);
    if (!row || eligible?.status !== "available") throw new GenerationContractError("unsupported_generation",
        eligible?.reason === "zero_rate_unsupported" ? "当前文本执行不支持零费率，该价格仅可保留为草稿" : "该文本模型缺少已发布的官方三项基准价、渠道模型倍率或固定 100 积分换算，请联系管理员核对");
    const price = eligible.rates;
    return { modelId: row.id, priceVersion: row.priceVersion, billingUnit: "text_tokens", budgetCredits: budget,
        inputCreditsPerMillion: price.inputCreditsPerMillion, outputCreditsPerMillion: price.outputCreditsPerMillion,
        ...(price.cachedInputCreditsPerMillion === undefined ? {} : { cachedInputCreditsPerMillion: price.cachedInputCreditsPerMillion }),
        usageSource: row.adapter === "sub2api" ? "responses" : "chat_completions", priceNote: row.priceNote, textPriceDerivation: eligible.metadata };
}
