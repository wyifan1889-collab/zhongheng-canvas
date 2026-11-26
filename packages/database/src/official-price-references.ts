import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { OFFICIAL_PRICE_SOURCES, officialPriceSourceId, parseModelPriceBinding, parseOfficialPriceEntries,
    parseOfficialPriceMappingWrite, parseOfficialPriceSource, sameModelPriceBinding,
    type AdminOfficialPriceCatalog, type OfficialPriceEntry, type OfficialPriceMapping, type OfficialPriceMappingWrite,
    type OfficialPriceSource, type OfficialPriceSourceId, type PublicOfficialPriceReference } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { auditEvent, modelCatalog, modelProvider, modelProviderCredential, officialPriceMapping, officialPriceSource } from "./schema";

const sourceIds = Object.keys(OFFICIAL_PRICE_SOURCES) as OfficialPriceSourceId[];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const canonicalEntries = (entries: OfficialPriceEntry[]) => entries.map(entry => ({ ...entry,
    rates: [...entry.rates].sort((a, b) => compare(a.label, b.label)) })).sort((a, b) => compare(a.id, b.id));
const digest = (entries: OfficialPriceEntry[]) => createHash("sha256").update(JSON.stringify(canonicalEntries(entries))).digest("hex");
const validTime = (now: Date) => { if (!Number.isFinite(now.getTime())) throw new Error("Invalid reference refresh time"); };
type SourceRow = typeof officialPriceSource.$inferSelect;
type MappingRow = typeof officialPriceMapping.$inferSelect;
type Current = { providerId: string; providerModel: string; adapter: string; endpoint: string; capability: string };

function normalizedEntries(entries: OfficialPriceEntry[] | null, source: OfficialPriceSourceId) {
    const parsed = entries === null ? null : parseOfficialPriceEntries(entries, source);
    if (!parsed?.length) return null;
    return parsed;
}
function sourceView(id: OfficialPriceSourceId, row?: SourceRow): OfficialPriceSource {
    const value = row ? parseOfficialPriceSource({ id: row.id, version: row.version, checkedAt: row.checkedAt?.toISOString() ?? null,
        attemptedAt: row.attemptedAt?.toISOString() ?? null, changedAt: row.changedAt?.toISOString() ?? null,
        status: row.status, entries: row.entries, changedEntryIds: row.changedEntryIds }) : null;
    if (row && !value) throw new Error("Invalid stored official price reference");
    return value ?? { id, version: 0, checkedAt: null, attemptedAt: null, changedAt: null,
        status: "unavailable", entries: [], changedEntryIds: [] };
}
function mappingView(row: MappingRow, current: Current): OfficialPriceMapping {
    const binding = parseModelPriceBinding({ providerId: row.providerIdSnapshot, providerModel: row.providerModelSnapshot,
        adapter: row.adapterSnapshot, endpoint: row.endpointSnapshot, capability: row.capabilitySnapshot });
    if (!binding || binding.capability !== "text") throw new Error("Invalid stored official price mapping");
    const now = parseModelPriceBinding(current);
    return { modelId: row.modelId, referenceId: row.referenceId, version: row.version, binding,
        bindingMatchesCurrent: !!now && sameModelPriceBinding(binding, now) };
}
const currentBinding = { providerId: modelProvider.id, providerModel: modelCatalog.providerModel,
    adapter: modelProvider.adapter, endpoint: modelProvider.endpoint, capability: modelCatalog.capability };

/** A bounded lease prevents parallel instances and late HTTP completions from replacing newer state.
 * Attempts, including failures, use the caller's refresh interval; there is no rapid retry loop. */
export async function claimOfficialPriceRefresh(db: Database, source: OfficialPriceSourceId, now: Date, intervalMs: number): Promise<string | null> {
    validTime(now);
    if (!officialPriceSourceId(source) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("Invalid reference refresh configuration");
    return db.transaction(async tx => {
        await tx.insert(officialPriceSource).values({ id: source }).onConflictDoNothing();
        const [row] = await tx.select().from(officialPriceSource).where(eq(officialPriceSource.id, source)).for("update");
        if (row.leaseExpiresAt && row.leaseExpiresAt > now || row.attemptedAt && now.getTime() - row.attemptedAt.getTime() < intervalMs) return null;
        const token = crypto.randomUUID();
        await tx.update(officialPriceSource).set({ attemptedAt: now, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 60_000),
            status: row.version > 0 ? "stale" : "unavailable" }).where(eq(officialPriceSource.id, source));
        return token;
    });
}

/** Returns whether this current, unexpired lease was consumed. null/invalid entries mark failure, retaining the last valid price. */
export async function completeOfficialPriceRefresh(db: Database, source: OfficialPriceSourceId, token: string, entries: OfficialPriceEntry[] | null, now: Date): Promise<boolean> {
    validTime(now);
    if (!officialPriceSourceId(source)) throw new Error("Invalid official price source");
    const next = normalizedEntries(entries, source);
    return db.transaction(async tx => {
        const [row] = await tx.select().from(officialPriceSource).where(eq(officialPriceSource.id, source)).for("update");
        if (!row || row.leaseToken !== token || !row.leaseExpiresAt || row.leaseExpiresAt <= now || !row.attemptedAt || now < row.attemptedAt) return false;
        if (!next) {
            await tx.update(officialPriceSource).set({ leaseToken: null, leaseExpiresAt: null, status: row.version > 0 ? "stale" : "unavailable" })
                .where(eq(officialPriceSource.id, source));
            return true;
        }
        const nextDigest = digest(next), changed = row.digest !== nextDigest;
        const before = new Map(canonicalEntries(row.entries).map(entry => [entry.id, JSON.stringify(entry)]));
        const after = new Map(canonicalEntries(next).map(entry => [entry.id, JSON.stringify(entry)]));
        const changedEntryIds = changed && row.version > 0 ? [...new Set([...before.keys(), ...after.keys()])]
            .filter(id => before.get(id) !== after.get(id)).sort(compare) : row.changedEntryIds;
        if (changed && row.version >= 2_147_483_647) throw new Error("Official price version exhausted");
        await tx.update(officialPriceSource).set({ entries: next, digest: nextDigest, checkedAt: now, status: "ready",
            leaseToken: null, leaseExpiresAt: null, version: row.version + (changed ? 1 : 0), changedEntryIds,
            ...(changed ? { previousEntries: row.entries, previousDigest: row.digest, changedAt: row.version > 0 ? now : null } : {}) })
            .where(eq(officialPriceSource.id, source));
        return true;
    });
}

export async function listAdminOfficialPriceCatalog(db: Database): Promise<AdminOfficialPriceCatalog> {
    return db.transaction(async tx => {
        const sources = await tx.select().from(officialPriceSource);
        const rows = await tx.select({ mapping: officialPriceMapping, current: currentBinding }).from(officialPriceMapping)
            .innerJoin(modelCatalog, eq(modelCatalog.publicId, officialPriceMapping.modelId))
            .innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .where(and(isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt))).orderBy(asc(officialPriceMapping.modelId));
        return { sources: sourceIds.map(id => sourceView(id, sources.find(row => row.id === id))),
            mappings: rows.map(row => mappingView(row.mapping, row.current)) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function listPublicOfficialPriceReferences(db: Database): Promise<PublicOfficialPriceReference[]> {
    return db.transaction(async tx => {
        const sources = await tx.select().from(officialPriceSource);
        const rows = await tx.select({ mapping: officialPriceMapping, current: currentBinding }).from(officialPriceMapping)
            .innerJoin(modelCatalog, eq(modelCatalog.publicId, officialPriceMapping.modelId))
            .innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
            .where(and(eq(modelCatalog.enabled, true), eq(modelProvider.enabled, true), eq(modelCatalog.capability, "text")))
            .orderBy(asc(officialPriceMapping.modelId));
        const items: PublicOfficialPriceReference[] = [];
        for (const row of rows) {
            const mapping = mappingView(row.mapping, row.current);
            if (!mapping.bindingMatchesCurrent || !mapping.referenceId) continue;
            const sourceId = mapping.referenceId.split(":", 1)[0];
            if (!officialPriceSourceId(sourceId)) throw new Error("Invalid stored reference identity");
            const source = sourceView(sourceId, sources.find(value => value.id === sourceId));
            const entry = source.entries.find(value => value.id === mapping.referenceId);
            if (!source.checkedAt || !entry) continue;
            items.push({ modelId: mapping.modelId, sourceId, version: source.version, checkedAt: source.checkedAt,
                changedAt: source.changedAt, stale: source.status !== "ready", entry });
        }
        return items;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

type SaveResult = { status: "saved"; mapping: OfficialPriceMapping } |
    { status: "model_not_found" | "model_binding_changed" | "official_price_mapping_conflict" | "official_price_reference_unavailable" };
export async function saveOfficialPriceMapping(db: Database, input: OfficialPriceMappingWrite, audit: { actorId: string; requestId: string }): Promise<SaveResult> {
    if (!parseOfficialPriceMappingWrite(input)) throw new Error("Invalid official price mapping");
    return db.transaction<SaveResult>(async tx => {
        const [model] = await tx.select().from(modelCatalog).where(eq(modelCatalog.publicId, input.modelId)).for("update");
        if (!model || model.deletedAt) return { status: "model_not_found" };
        const [provider] = await tx.select().from(modelProvider).where(eq(modelProvider.id, model.providerId)).for("share");
        if (!provider || provider.deletedAt) return { status: "model_binding_changed" };
        const current = parseModelPriceBinding({ providerId: provider.id, providerModel: model.providerModel,
            adapter: provider.adapter, endpoint: provider.endpoint, capability: model.capability });
        if (!current || current.capability !== "text" || !sameModelPriceBinding(current, input.binding)) return { status: "model_binding_changed" };
        const [prior] = await tx.select().from(officialPriceMapping).where(eq(officialPriceMapping.modelId, input.modelId)).for("update");
        if ((prior?.version ?? 0) !== input.expectedVersion || input.expectedVersion >= 2_147_483_647) return { status: "official_price_mapping_conflict" };
        if (input.referenceId) {
            const sourceId = input.referenceId.split(":", 1)[0];
            if (!officialPriceSourceId(sourceId)) return { status: "official_price_reference_unavailable" };
            const [source] = await tx.select().from(officialPriceSource).where(eq(officialPriceSource.id, sourceId)).for("share");
            if (!sourceView(sourceId, source).entries.some(entry => entry.id === input.referenceId)) return { status: "official_price_reference_unavailable" };
        }
        const values = { modelId: input.modelId, referenceId: input.referenceId, version: input.expectedVersion + 1,
            providerIdSnapshot: current.providerId, providerModelSnapshot: current.providerModel, adapterSnapshot: current.adapter,
            endpointSnapshot: current.endpoint, capabilitySnapshot: "text" as const, updatedAt: new Date() };
        const [saved] = await tx.insert(officialPriceMapping).values(values).onConflictDoUpdate({ target: officialPriceMapping.modelId, set: values }).returning();
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: audit.actorId, action: "model.official-price-mapping.saved",
            resourceId: input.modelId, revision: saved.version, requestId: audit.requestId });
        return { status: "saved", mapping: mappingView(saved, current) };
    });
}
