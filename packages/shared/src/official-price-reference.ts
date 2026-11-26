import { normalizePriceAmount, parseModelPriceBinding, type ModelPriceBinding } from "./model-pricing-drafts";

/** Read-only supplier list prices. Execution never reads this mutable catalogue;
 * explicit administrator derivation materializes a verified immutable draft snapshot. */
export const OFFICIAL_PRICE_SOURCES = {
    openai: { name: "OpenAI", url: "https://developers.openai.com/api/docs/pricing", documentUrl: "https://developers.openai.com/api/docs/pricing.md" },
    anthropic: { name: "Anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing", documentUrl: "https://platform.claude.com/docs/en/about-claude/pricing.md" },
} as const;
export type OfficialPriceSourceId = keyof typeof OFFICIAL_PRICE_SOURCES;
export type OfficialPriceRate = { label: string; usdPerMillion: string | null };
export type OfficialPriceEntry = { id: string; modelName: string; context: string; rates: OfficialPriceRate[] };
export type OfficialPriceSource = {
    id: OfficialPriceSourceId; version: number; checkedAt: string | null; attemptedAt: string | null;
    changedAt: string | null; status: "ready" | "stale" | "unavailable";
    entries: OfficialPriceEntry[]; changedEntryIds: string[];
};
export type OfficialPriceMapping = { modelId: string; referenceId: string | null; version: number; binding: ModelPriceBinding; bindingMatchesCurrent: boolean };
export type OfficialPriceMappingWrite = Omit<OfficialPriceMapping, "version" | "bindingMatchesCurrent"> & { expectedVersion: number };
export type AdminOfficialPriceCatalog = { sources: OfficialPriceSource[]; mappings: OfficialPriceMapping[] };
export type PublicOfficialPriceReference = { modelId: string; sourceId: OfficialPriceSourceId; version: number; checkedAt: string; changedAt: string | null; stale: boolean; entry: OfficialPriceEntry };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const version = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
export function officialPriceSourceId(v: unknown): v is OfficialPriceSourceId { return v === "openai" || v === "anthropic"; }
export function parseOfficialPriceEntries(value: unknown, source: OfficialPriceSourceId): OfficialPriceEntry[] | null {
    if (!Array.isArray(value) || value.length > 500) return null;
    const entries: OfficialPriceEntry[] = [];
    for (const item of value) {
        if (!object(item) || !text(item.id, 250) || !item.id.startsWith(source + ":") || !text(item.modelName, 200) || !text(item.context, 1500) ||
            !Array.isArray(item.rates) || !item.rates.length || item.rates.length > 16 || entries.some(e => e.id === item.id)) return null;
        const rates: OfficialPriceRate[] = [];
        for (const rate of item.rates) {
            if (!object(rate) || !text(rate.label, 100) || rates.some(r => r.label === rate.label)) return null;
            const amount = rate.usdPerMillion === null ? null : normalizePriceAmount(rate.usdPerMillion);
            if (rate.usdPerMillion !== null && (amount === null || amount.length > 50)) return null;
            rates.push({ label: rate.label, usdPerMillion: amount });
        }
        entries.push({ id: item.id, modelName: item.modelName, context: item.context, rates });
    }
    return entries;
}
export function parseOfficialPriceSource(value: unknown): OfficialPriceSource | null {
    if (!object(value) || !officialPriceSourceId(value.id) || !version(value.version) || !["ready", "stale", "unavailable"].includes(value.status as string) ||
        ![value.checkedAt, value.attemptedAt, value.changedAt].every(d => d === null || date(d)) || !Array.isArray(value.changedEntryIds) || value.changedEntryIds.length > 1000 || new Set(value.changedEntryIds).size !== value.changedEntryIds.length ||
        !value.changedEntryIds.every(id => text(id, 250) && id.startsWith(value.id + ":"))) return null;
    const entries = parseOfficialPriceEntries(value.entries, value.id);
    if (!entries || (value.version === 0 ? entries.length !== 0 || value.checkedAt !== null : !entries.length || value.checkedAt === null) ||
        (value.status === "ready" && value.checkedAt === null) || (value.status === "unavailable" && value.version !== 0)) return null;
    return { id: value.id, version: value.version as number, status: value.status as OfficialPriceSource["status"], checkedAt: value.checkedAt as string | null,
        attemptedAt: value.attemptedAt as string | null, changedAt: value.changedAt as string | null, entries, changedEntryIds: [...value.changedEntryIds] as string[] };
}
export function parseOfficialPriceMappingWrite(value: unknown): OfficialPriceMappingWrite | null {
    if (!object(value) || Object.keys(value).sort().join() !== "binding,expectedVersion,modelId,referenceId" || !text(value.modelId, 250) || !version(value.expectedVersion) ||
        (value.referenceId !== null && (!text(value.referenceId, 250) || !/^(openai|anthropic):/.test(value.referenceId)))) return null;
    const binding = parseModelPriceBinding(value.binding);
    return binding?.capability === "text" ? { modelId: value.modelId, referenceId: value.referenceId as string | null, expectedVersion: value.expectedVersion as number, binding } : null;
}
export function parseAdminOfficialPriceCatalog(value: unknown): AdminOfficialPriceCatalog | null {
    if (!object(value) || !Array.isArray(value.sources) || !Array.isArray(value.mappings)) return null;
    const sources = value.sources.map(parseOfficialPriceSource), mappings: OfficialPriceMapping[] = [];
    if (sources.some(s => !s) || new Set(sources.map(s => s!.id)).size !== sources.length) return null;
    for (const m of value.mappings) {
        if (!object(m) || typeof m.bindingMatchesCurrent !== "boolean" || !version(m.version) || m.version === 0) return null;
        const parsed = parseOfficialPriceMappingWrite({ modelId: m.modelId, referenceId: m.referenceId, expectedVersion: m.version, binding: m.binding });
        if (!parsed || mappings.some(p => p.modelId === parsed.modelId)) return null;
        mappings.push({ modelId: parsed.modelId, referenceId: parsed.referenceId, binding: parsed.binding, version: parsed.expectedVersion, bindingMatchesCurrent: m.bindingMatchesCurrent });
    }
    return { sources: sources as OfficialPriceSource[], mappings };
}
export function parsePublicOfficialPriceReferences(value: unknown): PublicOfficialPriceReference[] | null {
    if (!Array.isArray(value)) return null;
    const items: PublicOfficialPriceReference[] = [];
    for (const v of value) {
        if (!object(v) || !text(v.modelId, 250) || !officialPriceSourceId(v.sourceId) || !version(v.version) || v.version === 0 || !date(v.checkedAt) ||
            (v.changedAt !== null && !date(v.changedAt)) || typeof v.stale !== "boolean" || items.some(i => i.modelId === v.modelId)) return null;
        const entry = parseOfficialPriceEntries([v.entry], v.sourceId)?.[0];
        if (!entry) return null;
        items.push({ modelId: v.modelId, sourceId: v.sourceId, version: v.version as number, checkedAt: v.checkedAt, changedAt: v.changedAt as string | null, stale: v.stale, entry });
    }
    return items;
}
