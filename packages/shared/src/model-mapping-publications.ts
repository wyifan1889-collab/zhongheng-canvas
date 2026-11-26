import { mappingCombinationKey, mappingSourceKey, parseMappingDraft, validMappingPrice, type MappingBinding, type MappingCapability, type MappingDraft, type MappingSource } from "./model-mapping-drafts";
import { parseModelPriceRules, type ModelPriceRules } from "./model-pricing-drafts";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY } from "./generation-video";
import { GEMINI_IMAGE_PROTOCOL, parseGeminiImageSpecification } from "./generation-gemini-image";

export type MappingPublicationIssue = { modelId: string; specification: string; message: string };
export type MappingPublicationTarget = { providerId: string; providerModel: string; modelId: string; displayName: string; capability: MappingCapability; combinations: MappingBinding[]; rules: ModelPriceRules };
export type MappingPublicationRoute = { key: string; nodeModelId: string; priceVersion: number; pricePublicationId: string };
export type MappingPublicationDocument = { draft: MappingDraft; routes: MappingPublicationRoute[] };
export type MappingPublicationReceipt = { version: number; draftVersion: number; fingerprint: string };
export type MappingPublicationWrite = { expectedDraftVersion: number; expectedPublicationVersion: number; fingerprint: string };
export type MappingPublicationChange = { modelId: string; providerId: string; providerModel: string; displayName: string; capability: MappingCapability;
    previous: { revision: number; enabled: boolean; draftVersion: number; priceVersion: number; rules: ModelPriceRules | null; scalarCredits: number | null; priceEnabled: boolean; effectiveFrom: string | null; effectiveTo: string | null; publicPriceNote: string } | null;
    rules: ModelPriceRules | null; action: "configure" | "disable" };
export type MappingPublicationPreview = { draftVersion: number; publicationVersion: number; fingerprint: string;
    changes: MappingPublicationChange[]; issues: MappingPublicationIssue[]; current: MappingPublicationReceipt | null };

/** Compile only explicitly displayed, complete and priced combinations. Missing labels remain disabled. */
export function compileMappingPublication(raw: MappingDraft, sources: readonly MappingSource[]): { targets: MappingPublicationTarget[]; issues: MappingPublicationIssue[] } {
    const draft = parseMappingDraft(raw);
    if (!draft) throw new Error("Invalid mapping publication draft");
    const directory = new Map(sources.map(source => [mappingSourceKey(source), source]));
    const targets = new Map<string, MappingPublicationTarget>(), issues: MappingPublicationIssue[] = [];
    const combinations = new Map<string, MappingBinding[]>();
    for (const binding of draft.bindings) {
        if (!binding.execution || !draft.modelSpecifications[binding.modelId].includes(binding.specification)) continue;
        const key = mappingCombinationKey(binding), rows = combinations.get(key) ?? []; rows.push(binding); combinations.set(key, rows);
    }
    for (const [key, bindings] of combinations) {
        const first = bindings[0], model = draft.models.find(model => model.id === first.modelId)!;
        const problem = (message: string) => issues.push({ modelId: model.id, specification: first.specification, message });
        const selected = Object.hasOwn(draft.preferred, key) ? bindings.find(binding => mappingSourceKey(binding) === draft.preferred[key]) : bindings.length === 1 ? first : undefined;
        if (!selected) { problem("请明确选择调用渠道"); continue; }
        const source = directory.get(mappingSourceKey(selected));
        if (!source?.available || !source.providerEnabled) { problem("所选渠道已停用或型号缺失，请重新配置"); continue; }
        const gemini = selected.execution?.protocol === GEMINI_IMAGE_PROTOCOL;
        if (gemini && !parseGeminiImageSpecification(source.providerModel, selected.execution!.parameters)) {
            problem("该精确型号不支持已选 Gemini 原生规格"); continue;
        }
        const credits = draft.prices[key];
        if (!validMappingPrice(credits ?? "")) { problem("请填写该完整参数组合的正整数积分"); continue; }
        const sourceKey = mappingSourceKey(selected);
        let target = targets.get(sourceKey);
        if (!target) {
            target = { providerId: selected.providerId, providerModel: selected.providerModel, modelId: model.id, displayName: model.displayName, capability: model.capability, combinations: [],
                rules: { schemaVersion: 1, cost: null, sale: { template: model.capability === "image" ? gemini ? "image_count" : "image_request" : "video_count", currency: "credit", bands: [] },
                    ...(model.capability === "video" ? { video: { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY } } : {}) } };
            targets.set(sourceKey, target);
        }
        if (target.combinations.some(item => item.execution?.protocol !== selected.execution?.protocol)) { problem("同一渠道型号的图片协议须一致"); continue; }
        if (selected.execution?.protocol === "openai-image-v1") {
            const limit = selected.execution.maxImagesPerRequest, responseFormat = selected.execution.responseFormat;
            if (target.combinations.length && target.rules.image?.maxImagesPerRequest !== limit) { problem("同一渠道型号的单次张数上限须一致"); continue; }
            if (target.combinations.length && target.rules.image?.responseFormat !== responseFormat) { problem("同一渠道型号的图片返回方式须一致"); continue; }
            target.rules.image = { schemaVersion: 1, protocol: selected.execution.protocol, ...(limit === undefined ? {} : { maxImagesPerRequest: limit }),
                ...(responseFormat === undefined ? {} : { responseFormat }) };
        }
        target.combinations.push(selected);
        target.rules.sale.bands.push({ parameters: Object.fromEntries(Object.entries(selected.execution!.parameters).map(([field, value]) => [field, String(value)])), rates: { [model.capability === "image" ? gemini ? "image" : "request" : "video"]: credits } });
    }
    for (const target of targets.values()) if (!parseModelPriceRules(target.rules, target.capability)) issues.push({ modelId: target.modelId, specification: "", message: "参数组合存在重叠，不能形成唯一报价" });
    return { targets: [...targets.values()].sort((a, b) => mappingSourceKey(a).localeCompare(mappingSourceKey(b))), issues };
}

const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
export function parseMappingPublicationWrite(value: unknown): MappingPublicationWrite | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    return Object.keys(row).length === 3 && version(row.expectedDraftVersion) && version(row.expectedPublicationVersion) && row.expectedPublicationVersion < 2_147_483_647 && typeof row.fingerprint === "string" && /^[a-f0-9]{64}$/.test(row.fingerprint)
        ? { expectedDraftVersion: row.expectedDraftVersion, expectedPublicationVersion: row.expectedPublicationVersion, fingerprint: row.fingerprint } : null;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function parseMappingPublicationReceipt(value: unknown): MappingPublicationReceipt | null {
    if (!object(value) || !version(value.version) || value.version < 1 || !version(value.draftVersion) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return null;
    return { version: value.version, draftVersion: value.draftVersion, fingerprint: value.fingerprint };
}
export function parseMappingPublicationPreview(value: unknown): MappingPublicationPreview | null {
    if (!object(value) || !version(value.draftVersion) || !version(value.publicationVersion) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
        !Array.isArray(value.changes) || !Array.isArray(value.issues)) return null;
    const current = value.current === null ? null : parseMappingPublicationReceipt(value.current);
    if (value.current !== null && !current || (current?.version ?? 0) !== value.publicationVersion) return null;
    const changes: MappingPublicationChange[] = [];
    const nullableDate = (date: unknown) => date === null || typeof date === "string" && Number.isFinite(Date.parse(date));
    for (const row of value.changes) {
        if (!object(row) || !["modelId", "providerId", "providerModel", "displayName"].every(key => typeof row[key] === "string" && row[key]) ||
            row.capability !== "image" && row.capability !== "video" || row.action !== "configure" && row.action !== "disable") return null;
        const rules = row.rules === null ? null : parseModelPriceRules(row.rules, row.capability);
        if (row.action === "configure" ? !rules : row.rules !== null) return null;
        let previous: MappingPublicationChange["previous"] = null;
        if (row.previous !== null) {
            const p = row.previous;
            if (!object(p) || !version(p.revision) || !version(p.draftVersion) || !version(p.priceVersion) || typeof p.enabled !== "boolean" || typeof p.priceEnabled !== "boolean" ||
                !nullableDate(p.effectiveFrom) || !nullableDate(p.effectiveTo) || typeof p.publicPriceNote !== "string" ||
                p.scalarCredits !== null && (!Number.isSafeInteger(p.scalarCredits) || Number(p.scalarCredits) <= 0)) return null;
            const oldRules = p.rules === null ? null : parseModelPriceRules(p.rules, row.capability);
            if (p.rules !== null && !oldRules) return null;
            previous = { ...p, rules: oldRules } as MappingPublicationChange["previous"];
        }
        changes.push({ modelId: row.modelId as string, providerId: row.providerId as string, providerModel: row.providerModel as string, displayName: row.displayName as string,
            capability: row.capability, action: row.action, rules, previous });
    }
    if (new Set(changes.map(row => row.modelId)).size !== changes.length || !value.issues.every(row => object(row) && ["modelId", "specification", "message"].every(key => typeof row[key] === "string"))) return null;
    return { draftVersion: value.draftVersion, publicationVersion: value.publicationVersion, fingerprint: value.fingerprint, changes, issues: value.issues as MappingPublicationIssue[], current };
}
