import { mappingExecutionKey, parseMappingExecution, type MappingExecution } from "./model-mapping-execution";
export { parseMappingExecution, type MappingExecution } from "./model-mapping-execution";
/** Administrative planning only. These labels and prices never authorize generation. */
export type MappingCapability = "image" | "video";
export type MappingSource = { providerId: string; providerName: string; providerModel: string; available: boolean; providerEnabled: boolean };
export type MappingModel = { id: string; displayName: string; capability: MappingCapability; group: string };
export type MappingBinding = { providerId: string; providerModel: string; modelId: string; specification: string; execution?: MappingExecution };
export type MappingDraft = { models: MappingModel[]; bindings: MappingBinding[]; preferred: Record<string, string | null>; prices: Record<string, string>;
    specificationOptions: Record<MappingCapability, string[]>; modelSpecifications: Record<string, string[]> };
export type MappingProviderRevision = { providerId: string; revision: number | null };
export type MappingCatalog = { version: number; draft: MappingDraft; providers: MappingProviderRevision[]; sources: MappingSource[] };
export type MappingDraftWrite = { expectedVersion: number; draft: MappingDraft; providers: MappingProviderRevision[] };

export const emptyMappingDraft = (): MappingDraft => ({ models: [], bindings: [], preferred: {}, prices: {},
    specificationOptions: { image: ["1K", "2K", "4K"], video: ["480P", "720P"] }, modelSpecifications: {} });
export const mappingSourceKey = (source: Pick<MappingSource, "providerId" | "providerModel">) => JSON.stringify([source.providerId, source.providerModel]);
export const mappingSpecKey = (modelId: string, specification: string, execution?: MappingExecution) => JSON.stringify([modelId, specification, ...(execution ? [mappingExecutionKey(execution)] : [])]);
export const mappingCombinationKey = (binding: Pick<MappingBinding, "modelId" | "specification" | "execution">) => mappingSpecKey(binding.modelId, binding.specification, binding.execution);
export const mappingBindingKey = (binding: MappingBinding) => JSON.stringify([mappingSourceKey(binding), mappingCombinationKey(binding)]);
export const validMappingSpecification = (value: string, capability: MappingCapability) => capability === "image" ? value === "512" || /^[1-9]\d*K$/.test(value) : capability === "video" && /^[1-9]\d*(?:P|K)$/.test(value);
export const validMappingPrice = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

/** Remove only this channel's missing sources; never promote another channel to preferred. */
export function pruneMappingProvider(draft: MappingDraft, providerId: string, models: readonly string[]): MappingDraft {
    const found = new Set(models), removed = draft.bindings.filter(item => item.providerId === providerId && !found.has(item.providerModel));
    if (!removed.length) return draft;
    const removedKeys = new Set(removed.map(mappingSourceKey)), affectedModels = new Set(removed.map(item => item.modelId));
    const bindings = draft.bindings.filter(item => !removedKeys.has(mappingSourceKey(item)));
    const remainingModels = new Set(bindings.map(item => item.modelId)), remainingSpecs = new Set(bindings.map(mappingCombinationKey));
    const keptModels = draft.models.filter(item => !affectedModels.has(item.id) || remainingModels.has(item.id));
    return { ...draft, models: keptModels, bindings,
        modelSpecifications: Object.fromEntries(keptModels.map(item => [item.id, draft.modelSpecifications[item.id]])),
        prices: Object.fromEntries(Object.entries(draft.prices).filter(([key]) => remainingSpecs.has(key))),
        preferred: Object.fromEntries(Object.entries(draft.preferred).filter(([key]) => remainingSpecs.has(key)).map(([key, source]) => [key, source && removedKeys.has(source) ? null : source])) };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const text = (value: unknown): value is string => typeof value === "string" && !!value && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;

export function parseMappingDraft(value: unknown): MappingDraft | null {
    if (!object(value) || !exact(value, ["models", "bindings", "preferred", "prices", "specificationOptions", "modelSpecifications"]) ||
        !Array.isArray(value.models) || !Array.isArray(value.bindings) || !object(value.preferred) || !object(value.prices) ||
        !object(value.modelSpecifications) || !object(value.specificationOptions) || !exact(value.specificationOptions, ["image", "video"])) return null;
    const options = value.specificationOptions;
    for (const kind of ["image", "video"] as const) {
        if (!Array.isArray(options[kind]) || options[kind].some(item => typeof item !== "string" || !validMappingSpecification(item, kind)) || new Set(options[kind]).size !== options[kind].length) return null;
    }
    const models = new Map<string, MappingModel>(), sources = new Map<string, string>(), bindings: MappingBinding[] = [], keys = new Set<string>(), requestLabels = new Map<string, string>(), specs = new Map<string, Set<string>>();
    for (const item of value.models) {
        if (!object(item) || !exact(item, ["id", "displayName", "capability", "group"]) || !text(item.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(item.id) ||
            !text(item.displayName) || item.displayName.length > 120 || (item.capability !== "image" && item.capability !== "video") ||
            !(item.group === "" || text(item.group) && item.group.length <= 120) || models.has(item.id)) return null;
        models.set(item.id, item as MappingModel);
    }
    if (Object.keys(value.modelSpecifications).length !== models.size) return null;
    for (const [id, model] of models) {
        const selected = value.modelSpecifications[id];
        if (!Array.isArray(selected) || selected.some(item => !(options[model.capability] as string[]).includes(item)) || new Set(selected).size !== selected.length) return null;
    }
    for (const item of value.bindings) {
        if (!object(item) || !exact(item, ["providerId", "providerModel", "modelId", "specification", ...(Object.hasOwn(item, "execution") ? ["execution"] : [])]) || !text(item.providerId) || !text(item.providerModel) || item.providerModel.length > 200 || !text(item.modelId) || !text(item.specification)) return null;
        const model = models.get(item.modelId), source = mappingSourceKey(item as MappingBinding);
        if (!model || !(options[model.capability] as string[]).includes(item.specification) || sources.has(source) && sources.get(source) !== item.modelId) return null;
        const execution = Object.hasOwn(item, "execution") ? parseMappingExecution(item.execution, model.capability, item.specification) : undefined;
        if (execution === null) return null;
        const binding: MappingBinding = { providerId: item.providerId, providerModel: item.providerModel, modelId: item.modelId, specification: item.specification, ...(execution ? { execution } : {}) };
        const bindingKey = mappingBindingKey(binding); if (keys.has(bindingKey)) return null;
        if (execution) {
            const request = JSON.stringify([source, mappingExecutionKey(execution)]);
            if (requestLabels.has(request) && requestLabels.get(request) !== item.specification) return null;
            requestLabels.set(request, item.specification);
        }
        keys.add(bindingKey); sources.set(source, item.modelId); bindings.push(binding);
        const key = mappingCombinationKey(binding), routes = specs.get(key) ?? new Set<string>();
        routes.add(source); specs.set(key, routes);
    }
    for (const [key, source] of Object.entries(value.preferred)) if (!specs.has(key) || !(source === null || typeof source === "string" && specs.get(key)!.has(source))) return null;
    for (const [key, price] of Object.entries(value.prices)) if (!specs.has(key) || typeof price !== "string" || price !== "" && !validMappingPrice(price)) return null;
    // jsonb reorders object keys. Canonical field order avoids false dirty/receipt mismatches.
    const sorted = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
    return { models: [...models.values()].map(item => ({ id: item.id, displayName: item.displayName, capability: item.capability, group: item.group })),
        bindings,
        preferred: sorted(value.preferred) as MappingDraft["preferred"], prices: sorted(value.prices) as MappingDraft["prices"],
        specificationOptions: { image: [...options.image as string[]], video: [...options.video as string[]] },
        modelSpecifications: Object.fromEntries([...models.keys()].map(id => [id, [...value.modelSpecifications[id] as string[]]])) };
}

function parseProviders(value: unknown): MappingProviderRevision[] | null {
    if (!Array.isArray(value)) return null;
    const ids = new Set<string>();
    for (const item of value) {
        if (!object(item) || !exact(item, ["providerId", "revision"]) || !text(item.providerId) || ids.has(item.providerId) || !(item.revision === null || revision(item.revision) && item.revision > 0)) return null;
        ids.add(item.providerId);
    }
    return structuredClone(value) as MappingProviderRevision[];
}
export function parseMappingDraftWrite(value: unknown): MappingDraftWrite | null {
    if (!object(value) || !exact(value, ["expectedVersion", "draft", "providers"]) || !revision(value.expectedVersion) || value.expectedVersion === 2_147_483_647) return null;
    const draft = parseMappingDraft(value.draft), providers = parseProviders(value.providers);
    const ids = new Set(draft?.bindings.map(item => item.providerId));
    return draft && providers && providers.length === ids.size && providers.every(item => ids.has(item.providerId)) ? { expectedVersion: value.expectedVersion, draft, providers } : null;
}
export function parseMappingCatalog(value: unknown): MappingCatalog | null {
    if (!object(value) || !exact(value, ["version", "draft", "providers", "sources"]) || !revision(value.version) || !Array.isArray(value.sources)) return null;
    const draft = parseMappingDraft(value.draft), providers = parseProviders(value.providers), keys = new Set<string>();
    if (!draft || !providers || providers.some(item => item.revision === null)) return null;
    for (const item of value.sources) {
        if (!object(item) || !exact(item, ["providerId", "providerName", "providerModel", "available", "providerEnabled"]) ||
            !text(item.providerId) || !text(item.providerName) || !text(item.providerModel) || typeof item.available !== "boolean" || typeof item.providerEnabled !== "boolean" ||
            !providers.some(provider => provider.providerId === item.providerId)) return null;
        const key = mappingSourceKey(item as MappingSource); if (keys.has(key)) return null; keys.add(key);
    }
    return { version: value.version, draft, providers, sources: structuredClone(value.sources) as MappingSource[] };
}
