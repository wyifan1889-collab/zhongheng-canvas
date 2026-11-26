import { parseAdminOfficialPriceCatalog, parseOfficialPriceMappingWrite, parsePublicOfficialPriceReferences,
    type AdminOfficialPriceCatalog, type OfficialPriceMapping, type OfficialPriceMappingWrite, type PublicOfficialPriceReference } from "../../../../packages/shared/src/official-price-reference";
import { sameModelPriceBinding } from "../../../../packages/shared/src/model-pricing-drafts";
import { PlatformServiceError, type AdminGenerationScope } from "./platform";

export { OFFICIAL_PRICE_SOURCES } from "../../../../packages/shared/src/official-price-reference";
export type { AdminOfficialPriceCatalog, OfficialPriceEntry, OfficialPriceMapping, OfficialPriceMappingWrite, OfficialPriceSource, OfficialPriceSourceId, PublicOfficialPriceReference } from "../../../../packages/shared/src/official-price-reference";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const formatError = () => new PlatformServiceError("官方参考价回执格式不一致，请重新读取核对。");

/** Public reference failure is independent of wallet/catalog loading. Never fetch a supplier URL here. */
export async function fetchPublicOfficialPriceReferences(options: { signal?: AbortSignal; isCurrent?: () => boolean; fetcher?: typeof fetch } = {}): Promise<PublicOfficialPriceReference[] | null> {
    const current = () => !options.signal?.aborted && (options.isCurrent?.() ?? true);
    if (!current()) return null;
    try {
        const response = await (options.fetcher ?? fetch)("/api/v1/official-price-references", { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: options.signal, headers: { accept: "application/json" } });
        if (!current()) return null;
        if (!response.ok) throw new PlatformServiceError("官方参考价暂时无法读取；平台价目与余额不受影响。", response.status);
        const data: unknown = await response.json(); if (!current()) return null;
        const items = record(data) ? parsePublicOfficialPriceReferences(data.items) : null;
        if (!items) throw formatError();
        return items;
    } catch (error) {
        if (!current()) return null;
        throw error instanceof PlatformServiceError ? error : new PlatformServiceError("官方参考价暂时无法读取；平台价目与余额不受影响。");
    }
}

/** One confirmed admin/model panel. CAS writes never change drafts, published prices or balances. */
export function createAdminOfficialPriceReferenceClient(options: { scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ ...options.scope });
    let active = true, sequence = 0, pending: AbortController | null = null, catalog: AdminOfficialPriceCatalog | null = null, mustRead = true;
    const current = () => {
        const next = options.getScope();
        if (!next || next.role !== "admin" || next.accountId !== scope.accountId || next.epoch !== scope.epoch) { active = false; pending?.abort(); catalog = null; }
        return active;
    };
    async function request<T>(path: string, parse: (data: unknown) => T, body?: OfficialPriceMappingWrite): Promise<T | null> {
        if (!current()) return null;
        const operation = new AbortController(), token = ++sequence; pending?.abort(); pending = operation;
        const latest = () => current() && token === sequence;
        try {
            const response = await (options.fetcher ?? fetch)(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: operation.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (!latest()) return null;
            if (!response.ok) throw new PlatformServiceError(response.status === 409 ? "对照版本或模型绑定已变化。请手动重新读取、核对后再保存。"
                : body ? "对照保存结果未确认，请先重新读取核对；不会自动重试。" : "官方参考目录读取失败，请稍后手动重读。", response.status);
            const data: unknown = await response.json(); if (!latest()) return null;
            return parse(data);
        } catch (error) {
            if (!latest()) return null;
            throw error instanceof PlatformServiceError ? error : new PlatformServiceError(body ? "对照保存结果未确认，请先重新读取核对；不会自动重试。" : "官方参考目录读取失败，请稍后手动重读。");
        } finally { if (pending === operation) pending = null; }
    }
    return {
        isCurrent: current,
        close() { active = false; ++sequence; pending?.abort(); pending = null; catalog = null; },
        async load() {
            mustRead = true;
            const value = await request("/api/v1/admin/official-price-references", data => { const parsed = parseAdminOfficialPriceCatalog(data); if (!parsed) throw formatError(); return parsed; });
            if (value && current()) { catalog = value; mustRead = false; }
            return value;
        },
        save(input: OfficialPriceMappingWrite): Promise<OfficialPriceMapping | null> {
            if (!current()) return Promise.resolve(null);
            const body = parseOfficialPriceMappingWrite(input), previous = catalog?.mappings.find(m => m.modelId === body?.modelId);
            if (!body || mustRead || !catalog || !Number.isSafeInteger(body.expectedVersion + 1) || body.expectedVersion !== (previous?.version ?? 0)
                || (body.referenceId !== null && !catalog.sources.some(source => source.entries.some(entry => entry.id === body.referenceId)))) {
                return Promise.reject(new PlatformServiceError("请先重新读取目录，明确选择官方条目并核对当前渠道，再保存对照。"));
            }
            mustRead = true;
            return request("/api/v1/admin/official-price-reference-mappings", data => {
                const parsed = record(data) ? parseAdminOfficialPriceCatalog({ sources: [], mappings: [data.mapping] }) : null, mapping = parsed?.mappings[0];
                if (!mapping || mapping.modelId !== body.modelId || mapping.referenceId !== body.referenceId || mapping.version !== body.expectedVersion + 1
                    || !mapping.bindingMatchesCurrent || !sameModelPriceBinding(mapping.binding, body.binding)) throw formatError();
                catalog = { ...catalog!, mappings: [...catalog!.mappings.filter(m => m.modelId !== mapping.modelId), mapping] }; mustRead = false;
                return mapping;
            }, body);
        },
    };
}
