import { catalogDeletionReceipt, PlatformServiceError, type AdminGenerationScope, type AdminModel, type AdminProviderModel, type ModelWrite } from "./platform";
import { NODE_MODEL_GROUP_CAPABILITIES, parseNodeModelGroups, type NodeModelGroups, type NodeModelGroupsWrite as NodeModelGroupWrite } from "../../../../packages/shared/src/node-model-groups";
export type { NodeModelGroup, NodeModelGroups, NodeModelGroupsWrite as NodeModelGroupWrite } from "../../../../packages/shared/src/node-model-groups";

export type NodeModelConfiguration = { groups: NodeModelGroups[]; models: AdminModel[]; library: AdminProviderModel[] };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const malformed = () => new PlatformServiceError("配置回执不完整，请重新读取后核对；不会自动重提。");

function groupDocument(value: unknown): NodeModelGroups {
    if (!record(value) || !Array.isArray(value.groups)) throw malformed();
    const document = parseNodeModelGroups({ capability: value.capability, version: value.version,
        groups: value.groups.map(row => record(row) ? { id: row.id, name: row.name } : null) });
    if (!document) throw malformed();
    return document;
}

function adminModel(value: unknown): AdminModel {
    if (!record(value) || !text(value.id) || !text(value.displayName) || !["text", "image", "video", "audio"].includes(String(value.capability))
        || !(value.groupId === null || uuid(value.groupId)) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
        || !text(value.providerId) || !text(value.providerDisplayName) || !text(value.providerModel) || !text(value.endpoint)
        || !["openai-compatible", "sub2api"].includes(String(value.adapter)) || typeof value.enabled !== "boolean"
        || typeof value.providerEnabled !== "boolean" || typeof value.secretRefConfigured !== "boolean" || !time(value.createdAt) || !time(value.updatedAt)) throw malformed();
    return { id: value.id, displayName: value.displayName, capability: value.capability as AdminModel["capability"], groupId: value.groupId as string | null, revision: value.revision as number,
        providerId: value.providerId, providerDisplayName: value.providerDisplayName, providerModel: value.providerModel, endpoint: value.endpoint, adapter: value.adapter as AdminModel["adapter"],
        enabled: value.enabled, providerEnabled: value.providerEnabled, secretRefConfigured: value.secretRefConfigured, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function libraryModels(value: unknown): AdminProviderModel[] {
    if (!record(value) || !Array.isArray(value.models)) throw malformed();
    const models = value.models.map((row): AdminProviderModel => {
        if (!record(row) || !text(row.providerId) || !text(row.providerName) || !text(row.providerModel) || typeof row.providerEnabled !== "boolean" || typeof row.available !== "boolean"
            || !time(row.firstSeenAt) || !time(row.lastSeenAt) || !(row.boundModelId === null || text(row.boundModelId))) throw malformed();
        return { providerId: row.providerId, providerName: row.providerName, providerModel: row.providerModel, providerEnabled: row.providerEnabled, available: row.available,
            firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, boundModelId: row.boundModelId as string | null };
    });
    if (new Set(models.map(row => JSON.stringify([row.providerId, row.providerModel]))).size !== models.length) throw malformed();
    return models;
}

/** One editor epoch; all writes are explicit, versioned and never automatically retried. */
export function createNodeModelConfigurationClient(options: { scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = { ...options.scope };
    let active = true, sequence = 0, pending: AbortController | null = null;
    const current = () => {
        const next = options.getScope();
        if (!next || next.role !== "admin" || next.accountId !== scope.accountId || next.epoch !== scope.epoch) { active = false; pending?.abort(); }
        return active;
    };
    const cancel = () => { ++sequence; pending?.abort(); pending = null; };
    async function operation<T>(run: (request: (path: string, body?: unknown, method?: "DELETE") => Promise<unknown>) => Promise<T>): Promise<T | null> {
        if (!current()) return null;
        cancel(); const version = sequence, controller = new AbortController(); pending = controller;
        const latest = () => current() && sequence === version;
        const request = async (path: string, body?: unknown, method?: "DELETE"): Promise<unknown> => {
            try {
                const response = await (options.fetcher ?? fetch)(path, { method: method ?? (body ? "PUT" : "GET"), credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
                    headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
                if (!response.ok) {
                    const detail: unknown = await response.json().catch(() => null);
                    const code = record(detail) && record(detail.error) ? detail.error.code : null;
                    throw new PlatformServiceError(response.status === 401 ? "管理员会话已失效，请重新登录。" : response.status === 403 ? "当前账户没有后台权限。"
                    : response.status === 409 && code === "catalog_in_use" ? "模型仍有未结束或待核对的生成任务，请先处理任务，完成后再删除。"
                    : response.status === 409 && code === "model_group_in_use" ? "分组内仍有模型，请先调整模型归属，再删除分组。"
                    : response.status === 404 && method === "DELETE" ? "模型已删除，请重新读取配置核对。"
                    : response.status === 409 ? "配置版本或渠道绑定已变化。请重新读取并核对后再编辑。"
                    : response.status === 400 ? "配置字段无效，请核对分组、节点类型和模型来源。"
                    : method === "DELETE" ? "删除结果尚未确认，请重新读取配置核对，勿重复提交。" : body ? "保存结果尚未确认，请重新读取核对后再操作，不要重复提交。" : "配置读取失败，已保存内容保持不变。", response.status);
                }
                return await response.json();
            } catch (error) { throw error instanceof PlatformServiceError ? error : new PlatformServiceError(method === "DELETE" ? "删除结果尚未确认，请重新读取配置核对，勿重复提交。" : body ? "保存结果尚未确认，请重新读取核对后再操作，不要重复提交。" : "配置读取失败，已保存内容保持不变。"); }
        };
        try { const result = await run(request); return latest() ? result : null; }
        catch (error) { if (!latest()) return null; throw error; }
        finally { if (pending === controller) pending = null; }
    }
    return {
        isCurrent: current, cancel, close() { active = false; cancel(); },
        load: () => operation(async request => {
            const [groupData, modelData, libraryData] = await Promise.all([request("/api/v1/admin/model-groups"), request("/api/v1/admin/models"), request("/api/v1/admin/provider-models")]);
            if (!record(groupData) || !Array.isArray(groupData.items) || !record(modelData) || !Array.isArray(modelData.items)) throw malformed();
            const groups = groupData.items.map(groupDocument), models = modelData.items.map(adminModel);
            if (groups.length !== NODE_MODEL_GROUP_CAPABILITIES.length || !NODE_MODEL_GROUP_CAPABILITIES.every(capability => groups.some(row => row.capability === capability)) ||
                new Set(models.map(row => row.id)).size !== models.length) throw malformed();
            if (models.some(row => row.groupId !== null && !groups.some(doc => doc.capability === row.capability && doc.groups.some(group => group.id === row.groupId)))) throw malformed();
            return { groups, models, library: libraryModels(libraryData) };
        }),
        saveGroups: (input: NodeModelGroupWrite) => operation(async request => {
            const response = await request("/api/v1/admin/model-groups", input);
            if (!record(response)) throw malformed();
            const item = groupDocument(response.item);
            if (item.capability !== input.capability || item.version !== input.expectedVersion + 1 || JSON.stringify(item.groups) !== JSON.stringify(input.groups)) throw malformed();
            return item;
        }),
        saveModel: (id: string, input: ModelWrite) => operation(async request => {
            const response = await request(`/api/v1/admin/models/${encodeURIComponent(id)}`, input);
            if (!record(response)) throw malformed();
            const model = adminModel(response.model);
            if (model.id !== id || model.revision !== input.revision + 1 || model.groupId !== input.groupId || model.providerId !== input.providerId || model.providerModel !== input.providerModel
                || model.displayName !== input.displayName || model.capability !== input.capability || model.enabled !== input.enabled) throw malformed();
            return model;
        }),
        removeModel: (id: string, revision: number) => operation(async request => {
            const result = catalogDeletionReceipt(await request(`/api/v1/admin/models/${encodeURIComponent(id)}`, { revision }, "DELETE"), id, revision);
            if (result.modelIds.length !== 1 || result.modelIds[0] !== id) throw malformed();
            return result;
        }),
    };
}
