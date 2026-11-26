import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { normalizeCnyAmount, type AdminCnyPriceDraft, type CnyDraftModel, type CnyModelBinding, type CnyPriceDraftWrite } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { auditEvent, cnyPriceDraft, modelCatalog, modelProvider } from "./schema";

type CurrentBinding = Omit<CnyModelBinding, "capability"> & { capability: "text" | "image" | "video" | "audio" };
const currentBinding = {
    providerId: modelProvider.id, providerModel: modelCatalog.providerModel,
    adapter: modelProvider.adapter, endpoint: modelProvider.endpoint, capability: modelCatalog.capability,
};
const margin = sql<string | null>`(${cnyPriceDraft.saleAmount} - ${cnyPriceDraft.costAmount})::text`;

function safeEndpoint(value: string): string {
    try {
        const parsed = new URL(value);
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) return value;
    } catch { /* Never echo malformed legacy endpoint text that might contain a secret. */ }
    return "[invalid endpoint]";
}

function matches(binding: CnyModelBinding, current: CurrentBinding): boolean {
    return current.capability === "image" && binding.providerId === current.providerId &&
        binding.providerModel === current.providerModel && binding.adapter === current.adapter &&
        binding.endpoint === current.endpoint && safeEndpoint(current.endpoint) === current.endpoint;
}

function canonicalAmount(value: string, signed = false): string {
    const negative = signed && value.startsWith("-");
    const normalized = normalizeCnyAmount(negative ? value.slice(1) : value);
    if (normalized === null) throw new Error("Invalid stored CNY draft amount");
    return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function view(row: typeof cnyPriceDraft.$inferSelect, modelId: string, current: CurrentBinding, estimatedGrossMargin: string | null): AdminCnyPriceDraft {
    const binding: CnyModelBinding = {
        providerId: row.providerIdSnapshot, providerModel: row.providerModelSnapshot,
        adapter: row.adapterSnapshot, endpoint: safeEndpoint(row.endpointSnapshot), capability: row.capabilitySnapshot,
    };
    return {
        id: row.id, modelId, version: row.version, currency: row.currency, billingUnit: row.billingUnit,
        costAmount: row.costAmount === null ? null : canonicalAmount(row.costAmount), saleAmount: canonicalAmount(row.saleAmount),
        estimatedGrossMargin: estimatedGrossMargin === null ? null : canonicalAmount(estimatedGrossMargin, true), priceNote: row.priceNote,
        binding, bindingMatchesCurrent: matches(binding, current), createdAt: row.createdAt.toISOString(),
    };
}

/** Independent administrator drafts: no credential, credit-price, wallet or generation reads. */
export async function listCnyPriceDrafts(db: Database): Promise<{ models: CnyDraftModel[]; items: AdminCnyPriceDraft[] }> {
    return db.transaction(async (tx) => {
        const models = await tx.select({
            modelId: modelCatalog.publicId, displayName: modelCatalog.displayName,
            providerDisplayName: modelProvider.displayName, binding: currentBinding,
        }).from(modelCatalog).innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .where(and(eq(modelCatalog.capability, "image"), isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt)))
            .orderBy(asc(modelCatalog.publicId));
        const rows = await tx.selectDistinctOn([cnyPriceDraft.modelId], {
            draft: cnyPriceDraft, modelId: modelCatalog.publicId, current: currentBinding, estimatedGrossMargin: margin,
        }).from(cnyPriceDraft)
            .innerJoin(modelCatalog, eq(modelCatalog.id, cnyPriceDraft.modelId))
            .innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .where(and(isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt)))
            .orderBy(asc(cnyPriceDraft.modelId), desc(cnyPriceDraft.version));
        return {
            models: models.map((row) => ({ ...row, binding: { ...row.binding, endpoint: safeEndpoint(row.binding.endpoint), capability: "image" as const } })),
            items: rows.map((row) => view(row.draft, row.modelId, row.current, row.estimatedGrossMargin)),
        };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

type SaveResult = { status: "saved"; draft: AdminCnyPriceDraft } |
    { status: "not_found" } | { status: "price_draft_conflict" } | { status: "model_binding_changed" };

/** The caller has authenticated the administrator and validated the write contract. */
export async function createCnyPriceDraft(db: Database, input: CnyPriceDraftWrite, audit: { actorId: string; requestId: string }): Promise<SaveResult> {
    return db.transaction<SaveResult>(async (tx) => {
        // Serialize versions per model and keep model/channel edits out of this write's binding snapshot.
        const [model] = await tx.select({
            id: modelCatalog.id, publicId: modelCatalog.publicId, providerId: modelCatalog.providerId,
            providerModel: modelCatalog.providerModel, capability: modelCatalog.capability,
        }).from(modelCatalog).where(and(eq(modelCatalog.publicId, input.modelId), isNull(modelCatalog.deletedAt))).for("update");
        if (!model) return { status: "not_found" };
        const [provider] = await tx.select({
            adapter: modelProvider.adapter, endpoint: modelProvider.endpoint,
        }).from(modelProvider).where(and(eq(modelProvider.id, model.providerId), isNull(modelProvider.deletedAt))).for("share");
        if (!provider) return { status: "model_binding_changed" };
        const current: CurrentBinding = { ...provider, providerId: model.providerId, providerModel: model.providerModel, capability: model.capability };
        if (!matches(input.binding, current)) return { status: "model_binding_changed" };
        const [latest] = await tx.select({ version: cnyPriceDraft.version }).from(cnyPriceDraft)
            .where(eq(cnyPriceDraft.modelId, model.id)).orderBy(desc(cnyPriceDraft.version)).limit(1);
        const version = latest?.version ?? 0;
        // PostgreSQL integer is the actual version storage limit; never wrap or silently overwrite.
        if (input.expectedVersion !== version || version === 2_147_483_647) return { status: "price_draft_conflict" };
        const [saved] = await tx.insert(cnyPriceDraft).values({
            id: crypto.randomUUID(), modelId: model.id, version: version + 1,
            costAmount: input.costAmount, saleAmount: input.saleAmount, priceNote: input.priceNote,
            providerIdSnapshot: current.providerId, providerModelSnapshot: current.providerModel,
            adapterSnapshot: current.adapter, endpointSnapshot: current.endpoint,
        }).returning();
        await tx.insert(auditEvent).values({
            id: crypto.randomUUID(), actorId: audit.actorId, action: "model.cny-price-draft.created",
            resourceId: saved.id, revision: saved.version, requestId: audit.requestId,
        });
        const [result] = await tx.select({ estimatedGrossMargin: margin }).from(cnyPriceDraft).where(eq(cnyPriceDraft.id, saved.id));
        return { status: "saved", draft: view(saved, model.publicId, current, result.estimatedGrossMargin) };
    });
}
