import { PlatformServiceError, type AdminGenerationScope } from "./platform";
import { parseMappingCatalog, parseMappingDraft, parseMappingDraftWrite, type MappingDraftWrite } from "../../../../packages/shared/src/model-mapping-drafts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** One confirmed administrator scope, no automatic retries or optimistic success. */
export function createModelMappingDraftClient(options: { scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = { ...options.scope };
    let active = true, serial = 0, pending: AbortController | null = null, blocked = false;
    const cancel = () => { serial++; pending?.abort(); pending = null; };
    const isCurrent = () => {
        const current = options.getScope();
        if (!current || current.role !== "admin" || current.accountId !== scope.accountId || current.epoch !== scope.epoch) { active = false; cancel(); }
        return active;
    };
    async function request<T>(body: MappingDraftWrite | undefined, parse: (value: unknown) => T | null): Promise<T | null> {
        if (!isCurrent()) return null;
        if (pending || body && blocked) throw new PlatformServiceError("请先读取并核对配置，不能重复提交。");
        const controller = new AbortController(), sequence = ++serial;
        pending = controller;
        try {
            const response = await (options.fetcher ?? fetch)("/api/v1/admin/model-mapping-draft", { method: body ? "PUT" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (!response.ok) throw new PlatformServiceError(response.status === 401 ? "管理员会话已失效，请重新登录。" : response.status === 403 ? "当前账户没有后台权限。"
                : response.status === 409 ? "草稿版本或渠道目录已变化，输入已保留，请重新读取核对。" : response.status === 400 ? "模型、规格或价格草稿无效，请核对输入。"
                : body ? "保存结果尚未确认，输入已保留，请重新读取核对，不要重复提交。" : "配置读取失败，当前输入保持不变。", response.status);
            const result = parse(await response.json());
            if (!result) throw new PlatformServiceError("配置回执不完整，请重新读取核对；不会自动重提。");
            if (!isCurrent() || sequence !== serial) return null;
            blocked = false; return result;
        } catch (error) {
            if (!isCurrent() || sequence !== serial) return null;
            blocked = true;
            throw error instanceof PlatformServiceError ? error : new PlatformServiceError(body ? "保存结果尚未确认，输入已保留，请重新读取核对，不要重复提交。" : "配置读取失败，当前输入保持不变。");
        } finally { if (pending === controller) pending = null; }
    }
    return { isCurrent, close() { active = false; cancel(); },
        load: () => request(undefined, value => object(value) ? parseMappingCatalog(value.catalog) : null),
        save: (input: MappingDraftWrite) => {
            const parsed = parseMappingDraftWrite(input);
            if (!parsed) throw new PlatformServiceError("请补齐模型名称，核对规格、来源和正整数积分草稿。");
            return request(parsed, value => {
                if (!object(value) || !object(value.saved) || value.saved.version !== parsed.expectedVersion + 1) return null;
                const draft = parseMappingDraft(value.saved.draft);
                return draft && JSON.stringify(draft) === JSON.stringify(parsed.draft) ? { version: value.saved.version as number, draft } : null;
            });
        },
    };
}
