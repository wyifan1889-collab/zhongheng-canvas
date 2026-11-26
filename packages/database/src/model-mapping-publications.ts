import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { compileMappingPublication, mappingCombinationKey, mappingSourceKey, parseMappingDraft, parseMappingPublicationWrite, parseModelPriceRules, publishedDraftPrice,
    type MappingPublicationChange, type MappingPublicationDocument, type MappingPublicationPreview, type MappingPublicationReceipt, type MappingPublicationWrite, type MappingSource } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { assertSafetyActor, type SafetyActor, type SafetyTx } from "./account-moderation";
import { assertNoUnfinishedTasks } from "./catalog-deletion";
import { lockModelMappingDraft } from "./model-mapping-drafts";
import { modelPriceDraftView } from "./model-price-drafts";
import { auditEvent, modelCatalog, modelMappingDraft, modelMappingPublication, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential, providerDiscoveredModel } from "./schema";

export class MappingPublicationError extends Error {
    constructor(readonly code: "mapping_publication_conflict" | "mapping_publication_invalid", message: string) { super(message); }
}
const conflict = () => new MappingPublicationError("mapping_publication_conflict", "配置、渠道或价格已变化，请保留输入并重新核对生效方案");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receipt = (row: typeof modelMappingPublication.$inferSelect): MappingPublicationReceipt => ({ version: row.version, draftVersion: row.draftVersion, fingerprint: row.fingerprint });
const latest = (tx: SafetyTx) => tx.select().from(modelMappingPublication).orderBy(desc(modelMappingPublication.version)).limit(1);

async function prepare(tx: SafetyTx, geminiImageEnabled: boolean) {
    const [saved] = await tx.select().from(modelMappingDraft).where(eq(modelMappingDraft.id, "catalog")), [current] = await latest(tx);
    const draft = parseMappingDraft(saved?.document);
    if (!saved || !draft) throw new Error("Invalid mapping draft");
    const providers = await tx.select({ id: modelProvider.id, displayName: modelProvider.displayName, adapter: modelProvider.adapter, endpoint: modelProvider.endpoint,
        revision: modelProvider.revision, enabled: modelProvider.enabled, deletedAt: modelProvider.deletedAt, credential: modelProviderCredential.providerId })
        .from(modelProvider).leftJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id)).orderBy(asc(modelProvider.id));
    const inventory = await tx.select({ providerId: providerDiscoveredModel.providerId, providerModel: providerDiscoveredModel.providerModel, available: providerDiscoveredModel.available })
        .from(providerDiscoveredModel).orderBy(asc(providerDiscoveredModel.providerId), asc(providerDiscoveredModel.providerModel));
    const sources: MappingSource[] = inventory.map(item => { const provider = providers.find(row => row.id === item.providerId); return { ...item, available: item.available && !!provider && !provider.deletedAt,
        providerName: provider?.displayName ?? item.providerId, providerEnabled: !!provider?.enabled && !provider.deletedAt }; });
    const compiled = compileMappingPublication(draft, sources), selectedSources = new Set(compiled.targets.map(mappingSourceKey));
    if (!geminiImageEnabled) for (const target of compiled.targets) if (target.rules.sale.template === "image_count")
        compiled.issues.push({ modelId: target.modelId, specification: "", message: "Gemini 按张生成尚未开放，配置可保留为草稿" });
    const oldRoutes = new Set(current?.document.routes.map(route => route.nodeModelId));
    const candidates = await tx.select().from(modelCatalog).orderBy(asc(modelCatalog.id));
    const models = candidates.filter(model => oldRoutes.has(model.publicId) || !model.deletedAt && selectedSources.has(mappingSourceKey(model)));
    const changes: MappingPublicationChange[] = [], rows = [];
    for (const target of compiled.targets) {
        const provider = providers.find(item => item.id === target.providerId)!;
        const model = models.find(item => !item.deletedAt && mappingSourceKey(item) === mappingSourceKey(target));
        const [price] = model ? await tx.select().from(modelPricing).where(eq(modelPricing.modelId, model.id)).orderBy(desc(modelPricing.version)).limit(1) : [];
        const [priceDraft] = model ? await tx.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, model.id)).orderBy(desc(modelPriceDraft.version)).limit(1) : [];
        const [priceSource] = price ? await tx.select({ draft: modelPriceDraft, note: modelPricePublication.publicPriceNote }).from(modelPricePublication).innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId)).where(eq(modelPricePublication.pricingId, price.id)) : [];
        const oldRules = priceDraft ? parseModelPriceRules(priceDraft.rules, target.capability) : null;
        const currentRules = priceSource ? parseModelPriceRules(priceSource.draft.rules, target.capability) : null;
        const rules = { ...target.rules, cost: oldRules?.cost ?? null };
        const binding = { providerId: target.providerId, providerModel: target.providerModel, adapter: provider.adapter, endpoint: provider.endpoint, capability: target.capability };
        const published = publishedDraftPrice(binding, rules);
        if (priceDraft && oldRules?.cost && !modelPriceDraftView(priceDraft, model!.publicId, binding).bindingMatchesCurrent)
            compiled.issues.push({ modelId: target.modelId, specification: "", message: "已有成本草稿的渠道绑定已变化，请先核对成本" });
        if (!provider.credential || !published || model && model.capability !== target.capability || (model?.revision ?? 0) >= 2_147_483_647 || (priceDraft?.version ?? 0) >= 2_147_483_647 || (price?.version ?? 0) >= 2_147_483_647)
            compiled.issues.push({ modelId: target.modelId, specification: "", message: "渠道凭据、协议、模型类型或价格版本无法用于本次生效" });
        const nodeId = model?.publicId ?? `mapped-${hash(mappingSourceKey(target)).slice(0, 24)}-${(current?.version ?? 0) + 1}`;
        if (!model && candidates.some(item => item.publicId === nodeId)) compiled.issues.push({ modelId: target.modelId, specification: "", message: "目标节点编号已被占用，请重新核对" });
        changes.push({ modelId: nodeId, providerId: target.providerId, providerModel: target.providerModel, displayName: target.displayName, capability: target.capability,
            previous: model ? { revision: model.revision, enabled: model.enabled, draftVersion: priceDraft?.version ?? 0, priceVersion: price?.version ?? 0, rules: currentRules, scalarCredits: price?.creditsPerUnit ?? null,
                priceEnabled: price?.enabled ?? false, effectiveFrom: price?.effectiveFrom.toISOString() ?? null, effectiveTo: price?.effectiveTo?.toISOString() ?? null, publicPriceNote: priceSource?.note ?? "" } : null, rules, action: "configure" });
        rows.push({ target, provider, model, price, priceDraft, rules, binding, published, nodeId });
    }
    const retired = models.filter(model => oldRoutes.has(model.publicId) && !rows.some(row => row.model?.id === model.id) && model.enabled && !model.deletedAt);
    for (const model of retired) {
        if (model.revision >= 2_147_483_647) compiled.issues.push({ modelId: model.publicId, specification: "", message: "旧来源版本已达到边界" });
        changes.push({ modelId: model.publicId, providerId: model.providerId, providerModel: model.providerModel, displayName: model.displayName, capability: model.capability as "image" | "video",
            previous: { revision: model.revision, enabled: model.enabled, draftVersion: 0, priceVersion: 0, rules: null, scalarCredits: null, priceEnabled: false, effectiveFrom: null, effectiveTo: null, publicPriceNote: "" }, rules: null, action: "disable" });
    }
    const usedProviders = new Set([...rows.map(row => row.provider.id), ...retired.map(model => model.providerId)]);
    const baseline = { draftVersion: saved.version, draft, publicationVersion: current?.version ?? 0, changes,
        providers: providers.filter(provider => usedProviders.has(provider.id)), inventory: inventory.filter(item => usedProviders.has(item.providerId)),
        // Include immutable draft identity and complete current model metadata in the reviewed CAS.
        models, priceDraftIds: rows.map(row => row.priceDraft?.id ?? null),
        prices: models.length ? await tx.select().from(modelPricing).where(inArray(modelPricing.modelId, models.map(model => model.id))).orderBy(asc(modelPricing.id)) : [], issues: compiled.issues };
    const preview: MappingPublicationPreview = { draftVersion: saved.version, publicationVersion: current?.version ?? 0, fingerprint: hash(baseline), changes, issues: compiled.issues, current: current ? receipt(current) : null };
    return { preview, draft, current, rows, retired, models, usedProviders };
}

export async function previewMappingPublication(db: Database, actor: SafetyActor, geminiImageEnabled = false) {
    return db.transaction(async tx => { await assertSafetyActor(tx, actor, true); return (await prepare(tx, geminiImageEnabled)).preview; }, { isolationLevel: "repeatable read" });
}

/** Existing model/price/publication contracts are committed together, without touching historical tasks. */
export async function publishMappingConfiguration(db: Database, raw: MappingPublicationWrite, actor: SafetyActor, geminiImageEnabled = false): Promise<MappingPublicationReceipt> {
    const input = parseMappingPublicationWrite(raw);
    if (!input) throw new MappingPublicationError("mapping_publication_invalid", "生效方案字段不完整，请重新读取核对");
    try { return await db.transaction(async tx => {
        await lockModelMappingDraft(tx);
        const [existing] = await latest(tx);
        if (existing && existing.version === input.expectedPublicationVersion + 1 && existing.fingerprint === input.fingerprint && existing.draftVersion === input.expectedDraftVersion) {
            await assertSafetyActor(tx, actor, true); return receipt(existing);
        }
        const first = await prepare(tx, geminiImageEnabled);
        if (first.preview.draftVersion !== input.expectedDraftVersion || first.preview.publicationVersion !== input.expectedPublicationVersion || first.preview.fingerprint !== input.fingerprint) throw conflict();
        // Match draft -> models (stable order) -> providers; never take model locks after a provider lock.
        for (const model of first.models) await tx.select({ id: modelCatalog.id }).from(modelCatalog).where(eq(modelCatalog.id, model.id)).for("update");
        for (const id of [...first.usedProviders].sort()) {
            await tx.select({ id: modelProvider.id }).from(modelProvider).where(eq(modelProvider.id, id)).for("share");
            await tx.select({ id: modelProviderCredential.providerId }).from(modelProviderCredential).where(eq(modelProviderCredential.providerId, id)).for("share");
            await tx.select({ name: providerDiscoveredModel.providerModel }).from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, id)).for("share");
        }
        const plan = await prepare(tx, geminiImageEnabled);
        if (plan.preview.fingerprint !== input.fingerprint) throw conflict();
        if (plan.preview.issues.length) throw new MappingPublicationError("mapping_publication_invalid", "仍有未定价、渠道或协议问题，请修正后再生效");
        await assertNoUnfinishedTasks(tx, plan.retired.map(model => model.publicId));
        await assertSafetyActor(tx, actor, true);
        const document: MappingPublicationDocument = { draft: plan.draft, routes: [] }, now = new Date();
        for (const row of plan.rows) {
            const modelId = row.model?.id ?? crypto.randomUUID();
            if (row.model) await tx.update(modelCatalog).set({ displayName: row.target.displayName, enabled: true, revision: row.model.revision + 1, updatedAt: now }).where(eq(modelCatalog.id, modelId));
            else await tx.insert(modelCatalog).values({ id: modelId, publicId: row.nodeId, providerId: row.provider.id, providerModel: row.target.providerModel, displayName: row.target.displayName, capability: row.target.capability, enabled: true });
            const [draft] = await tx.insert(modelPriceDraft).values({ id: crypto.randomUUID(), modelId, version: (row.priceDraft?.version ?? 0) + 1, rules: row.rules, priceNote: row.priceDraft?.priceNote ?? "",
                providerIdSnapshot: row.provider.id, providerModelSnapshot: row.target.providerModel, adapterSnapshot: row.provider.adapter, endpointSnapshot: row.provider.endpoint, capabilitySnapshot: row.target.capability }).returning();
            await tx.update(modelPricing).set({ enabled: false, updatedAt: now }).where(and(eq(modelPricing.modelId, modelId), eq(modelPricing.enabled, true)));
            const [price] = await tx.insert(modelPricing).values({ id: crypto.randomUUID(), modelId, version: (row.price?.version ?? 0) + 1, billingUnit: row.published!.billingUnit, creditsPerUnit: row.published!.creditsPerUnit, effectiveFrom: now, enabled: true }).returning();
            const [publication] = await tx.insert(modelPricePublication).values({ id: crypto.randomUUID(), pricingId: price.id, draftId: draft.id, publicPriceNote: "" }).returning();
            for (const binding of row.target.combinations) document.routes.push({ key: mappingCombinationKey(binding), nodeModelId: row.nodeId, priceVersion: price.version, pricePublicationId: publication.id });
        }
        for (const model of plan.retired) await tx.update(modelCatalog).set({ enabled: false, revision: model.revision + 1, updatedAt: now }).where(eq(modelCatalog.id, model.id));
        const [publication] = await tx.insert(modelMappingPublication).values({ id: crypto.randomUUID(), version: input.expectedPublicationVersion + 1,
            draftVersion: input.expectedDraftVersion, fingerprint: input.fingerprint, document }).returning();
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "model.mapping.published", resourceId: publication.id, revision: publication.version, requestId: actor.requestId });
        return receipt(publication);
    }); } catch (error) {
        if (error && typeof error === "object" && ("code" in error && error.code === "23505" || "cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause && error.cause.code === "23505")) throw conflict();
        throw error;
    }
}

/** Public projection contains no upstream identifiers, endpoint or credential. Availability is rechecked on every read. */
export async function readPublishedMappingCatalog(db: Database) {
    return db.transaction(async tx => {
        const [publication] = await latest(tx);
        if (!publication) return { version: 0, models: [] };
        const draft = parseMappingDraft(publication.document.draft);
        if (!draft) throw new Error("Invalid mapping publication");
        const now = new Date();
        const sources = await tx.select({ providerId: providerDiscoveredModel.providerId, providerModel: providerDiscoveredModel.providerModel })
            .from(providerDiscoveredModel).innerJoin(modelProvider, eq(modelProvider.id, providerDiscoveredModel.providerId)).where(isNull(modelProvider.deletedAt));
        const deletedNodes = await tx.select({ id: modelCatalog.publicId, providerId: modelCatalog.providerId, providerModel: modelCatalog.providerModel }).from(modelCatalog).where(isNotNull(modelCatalog.deletedAt));
        const rows = await tx.select({ id: modelCatalog.publicId, priceId: modelPricePublication.id, version: modelPricing.version })
            .from(modelCatalog).innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
            .innerJoin(providerDiscoveredModel, and(eq(providerDiscoveredModel.providerId, modelProvider.id), eq(providerDiscoveredModel.providerModel, modelCatalog.providerModel)))
            .innerJoin(modelPricing, eq(modelPricing.modelId, modelCatalog.id)).innerJoin(modelPricePublication, eq(modelPricePublication.pricingId, modelPricing.id))
            .innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
            .where(and(eq(modelCatalog.enabled, true), isNull(modelCatalog.deletedAt), eq(modelProvider.enabled, true), isNull(modelProvider.deletedAt), eq(providerDiscoveredModel.available, true), eq(modelPricing.enabled, true),
                lte(modelPricing.effectiveFrom, now), or(isNull(modelPricing.effectiveTo), gt(modelPricing.effectiveTo, now)),
                eq(modelPriceDraft.modelId, modelCatalog.id), eq(modelPriceDraft.capabilitySnapshot, modelCatalog.capability),
                eq(modelPriceDraft.providerIdSnapshot, modelCatalog.providerId), eq(modelPriceDraft.providerModelSnapshot, modelCatalog.providerModel), eq(modelPriceDraft.adapterSnapshot, modelProvider.adapter), eq(modelPriceDraft.endpointSnapshot, modelProvider.endpoint)));
        return { version: publication.version, models: draft.models.filter(model => draft.bindings.some(binding => binding.modelId === model.id &&
            sources.some(source => mappingSourceKey(source) === mappingSourceKey(binding)) &&
            !publication.document.routes.some(route => route.key === mappingCombinationKey(binding) && deletedNodes.some(node => node.id === route.nodeModelId && mappingSourceKey(node) === mappingSourceKey(binding))))).map(model => ({ ...model,
            specifications: draft.specificationOptions[model.capability].filter(spec => draft.modelSpecifications[model.id].includes(spec)),
            combinations: publication.document.routes.flatMap(route => {
                const binding = draft.bindings.find(binding => binding.modelId === model.id && mappingCombinationKey(binding) === route.key);
                if (!binding?.execution) return [];
                const available = rows.some(row => row.id === route.nodeModelId && row.version === route.priceVersion && row.priceId === route.pricePublicationId);
                return [{ specification: binding.specification, execution: binding.execution, credits: Number(draft.prices[route.key]), available,
                    ...(available ? { nodeModelId: route.nodeModelId, priceVersion: route.priceVersion } : {}) }];
            }),
        })) };
    }, { isolationLevel: "repeatable read" });
}
