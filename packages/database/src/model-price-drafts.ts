import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { parseModelPriceDerivation, parseModelPriceRules, parseOfficialPriceEntries, sameDerivedPriceRules, sameModelPriceBinding, type AdminModelPriceDraft, type ModelPriceBinding, type ModelPriceDraftWrite, type PriceDraftModel } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { auditEvent, modelCatalog, modelPriceDraft, modelProvider, officialPriceSource, officialPriceMapping } from "./schema";

type CurrentBinding = Omit<ModelPriceBinding, "capability"> & { capability: "text" | "image" | "video" | "audio" };
const currentBinding = {
    providerId: modelProvider.id, providerModel: modelCatalog.providerModel,
    adapter: modelProvider.adapter, endpoint: modelProvider.endpoint, capability: modelCatalog.capability,
};

function safeEndpoint(value: string): string {
    try {
        const parsed = new URL(value);
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) return value;
    } catch { /* Do not echo malformed legacy endpoint text that might contain a secret. */ }
    return "[invalid endpoint]";
}

function matches(binding: ModelPriceBinding, current: CurrentBinding): boolean {
    return safeEndpoint(current.endpoint) === current.endpoint &&
        sameModelPriceBinding(binding, { ...current, capability: current.capability });
}

export function modelPriceDraftView(row: typeof modelPriceDraft.$inferSelect, modelId: string, current: CurrentBinding): AdminModelPriceDraft {
    const binding: ModelPriceBinding = {
        providerId: row.providerIdSnapshot, providerModel: row.providerModelSnapshot,
        adapter: row.adapterSnapshot, endpoint: safeEndpoint(row.endpointSnapshot), capability: row.capabilitySnapshot,
    };
    const rules = parseModelPriceRules(row.rules, binding.capability);
    if (!rules || rules.derivation && !sameModelPriceBinding(rules.derivation.binding, binding)) throw new Error("Invalid stored model price draft rules");
    return {
        id: row.id, modelId, version: row.version, rules, priceNote: row.priceNote,
        binding, bindingMatchesCurrent: matches(binding, current), createdAt: row.createdAt.toISOString(),
    };
}

/** Only current generic drafts are listed. Historical CNY drafts are not converted. */
export async function listModelPriceDrafts(db: Database): Promise<{ models: PriceDraftModel[]; items: AdminModelPriceDraft[] }> {
    return db.transaction(async (tx) => {
        const models = await tx.select({
            modelId: modelCatalog.publicId, displayName: modelCatalog.displayName,
            providerDisplayName: modelProvider.displayName, binding: currentBinding,
        }).from(modelCatalog).innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .where(and(inArray(modelCatalog.capability, ["text", "image", "video", "audio"]), isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt)))
            .orderBy(asc(modelCatalog.publicId));
        const rows = await tx.selectDistinctOn([modelPriceDraft.modelId], {
            draft: modelPriceDraft, modelId: modelCatalog.publicId, current: currentBinding,
        }).from(modelPriceDraft)
            .innerJoin(modelCatalog, eq(modelCatalog.id, modelPriceDraft.modelId))
            .innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .where(and(isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt)))
            .orderBy(asc(modelPriceDraft.modelId), desc(modelPriceDraft.version));
        return {
            models: models.map((row): PriceDraftModel => ({
                ...row, binding: { ...row.binding, endpoint: safeEndpoint(row.binding.endpoint), capability: row.binding.capability },
            })),
            items: rows.map((row) => modelPriceDraftView(row.draft, row.modelId, row.current)),
        };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

type SaveResult = { status: "saved"; draft: AdminModelPriceDraft } |
    { status: "not_found" | "price_draft_conflict" | "model_binding_changed" | "invalid_derivation" | "price_derivation_source_changed" };

/** Caller authenticates the administrator and parses the complete strict contract. */
export async function createModelPriceDraft(db: Database, input: ModelPriceDraftWrite, audit: { actorId: string; requestId: string }): Promise<SaveResult> {
    return db.transaction<SaveResult>(async (tx) => {
        const [model] = await tx.select({
            id: modelCatalog.id, publicId: modelCatalog.publicId, providerId: modelCatalog.providerId,
            providerModel: modelCatalog.providerModel, capability: modelCatalog.capability,
        }).from(modelCatalog).where(and(eq(modelCatalog.publicId, input.modelId), isNull(modelCatalog.deletedAt))).for("update");
        if (!model) return { status: "not_found" };
        const [provider] = await tx.select({ adapter: modelProvider.adapter, endpoint: modelProvider.endpoint })
            .from(modelProvider).where(and(eq(modelProvider.id, model.providerId), isNull(modelProvider.deletedAt))).for("share");
        if (!provider) return { status: "model_binding_changed" };
        const current: CurrentBinding = { ...provider, providerId: model.providerId, providerModel: model.providerModel, capability: model.capability };
        if (!matches(input.binding, current)) return { status: "model_binding_changed" };
        const [latest] = await tx.select().from(modelPriceDraft)
            .where(eq(modelPriceDraft.modelId, model.id)).orderBy(desc(modelPriceDraft.version)).limit(1);
        const version = latest?.version ?? 0;
        if (input.expectedVersion !== version || version === 2_147_483_647) return { status: "price_draft_conflict" };
        if (input.rules.derivation !== undefined) {
            const derivation = parseModelPriceDerivation(input.rules.derivation, input.binding.capability);
            if (!derivation || !sameModelPriceBinding(derivation.binding, input.binding) || !sameDerivedPriceRules(input.rules, derivation)) return { status: "invalid_derivation" };
            const source = derivation.source;
            // Even a note-only continuation must prove the model identity. Only the
            // mutable price-source check below may reuse previously frozen evidence.
            if (source.kind === "official" && derivation.basis.template === "text_cached_tokens") {
                const [mapping] = await tx.select().from(officialPriceMapping).where(eq(officialPriceMapping.modelId, model.publicId)).for("share");
                if (!mapping || mapping.referenceId !== source.entry.id || !sameModelPriceBinding(input.binding, {
                    providerId: mapping.providerIdSnapshot, providerModel: mapping.providerModelSnapshot,
                    adapter: mapping.adapterSnapshot, endpoint: mapping.endpointSnapshot, capability: mapping.capabilitySnapshot,
                })) return { status: "price_derivation_source_changed" };
            }
            const prior = latest ? modelPriceDraftView(latest, model.publicId, current) : null;
            // Editing notes may keep the latest draft's already authenticated immutable
            // evidence. New arithmetic or a different source must be authenticated again.
            const continuing = prior?.bindingMatchesCurrent && prior.rules.derivation && isDeepStrictEqual(prior.rules.derivation, derivation);
            if (!continuing && source.kind === "official") {
                // The source lock shares this transaction with the new immutable draft.
                // Reference refreshes cannot replace the checked snapshot between validation and insert.
                const [reference] = await tx.select().from(officialPriceSource).where(eq(officialPriceSource.id, source.sourceId)).for("share");
                const entries = reference && parseOfficialPriceEntries(reference.entries, source.sourceId);
                const entry = entries?.find(item => item.id === source.entry.id);
                if (!reference || reference.version !== source.version || reference.checkedAt?.toISOString() !== source.checkedAt || !entry || !isDeepStrictEqual(entry, source.entry)) return { status: "price_derivation_source_changed" };
            } else if (!continuing && source.kind === "saved_cost") {
                if (!latest || latest.id !== source.draftId || latest.version !== source.draftVersion) return { status: "price_derivation_source_changed" };
                if (!prior?.bindingMatchesCurrent || !prior.rules.cost || !isDeepStrictEqual(prior.rules.cost, derivation.basis)) return { status: "price_derivation_source_changed" };
            }
        }
        const [saved] = await tx.insert(modelPriceDraft).values({
            id: crypto.randomUUID(), modelId: model.id, version: version + 1, rules: input.rules, priceNote: input.priceNote,
            providerIdSnapshot: current.providerId, providerModelSnapshot: current.providerModel,
            adapterSnapshot: current.adapter, endpointSnapshot: current.endpoint, capabilitySnapshot: input.binding.capability,
        }).returning();
        await tx.insert(auditEvent).values({
            id: crypto.randomUUID(), actorId: audit.actorId, action: "model.price-draft.created",
            resourceId: saved.id, revision: saved.version, requestId: audit.requestId,
        });
        return { status: "saved", draft: modelPriceDraftView(saved, model.publicId, current) };
    });
}
