import { PlatformServiceError, type AdminGenerationScope } from "./platform";
import { parseMappingPublicationPreview, parseMappingPublicationReceipt, parseMappingPublicationWrite, type MappingPublicationWrite } from "../../../../packages/shared/src/model-mapping-publications";

/** Keep an uncertain submission blocked until an explicit read; account changes invalidate every response. */
export function createMappingPublicationClient(options: { scope: AdminGenerationScope; getScope: () => AdminGenerationScope | null; fetcher?: typeof fetch }) {
    const scope = { ...options.scope };
    let active = true, pending: AbortController | null = null, blocked = false;
    const isCurrent = () => {
        const next = options.getScope();
        if (!next || next.role !== "admin" || next.accountId !== scope.accountId || next.epoch !== scope.epoch) { active = false; pending?.abort(); }
        return active;
    };
    async function request<T>(body: MappingPublicationWrite | undefined, parse: (value: Record<string, unknown>) => T | null): Promise<T | null> {
        if (!isCurrent()) return null;
        if (pending || body && blocked) throw new PlatformServiceError("请先重新读取核对，不能重复生效。");
        const controller = new AbortController(); pending = controller;
        try {
            const response = await (options.fetcher ?? fetch)("/api/v1/admin/model-mapping-publication", { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
                headers: { accept: "application/json", "x-canvas-account-id": scope.accountId, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            if (!response.ok) {
                const failure = await response.json().catch(() => null);
                throw new PlatformServiceError(response.status === 401 || response.status === 403 || failure?.error?.code === "account_changed" ? "管理员会话或权限已变化，请重新登录。"
                    : failure?.error?.code === "catalog_in_use" ? "旧来源仍有未结束或待核对任务，本次未生效；请在生成任务中处理后重新核对。"
                    : response.status === 409 ? "配置、价格或账户状态已变化，请重新读取核对生效回执。"
                    : response.status === 400 ? "生效条件尚未满足，请返回检查规格、来源和积分。"
                    : body ? "生效结果尚未确认，请读取回执核对，不要重复提交。" : "生效方案读取失败，请手动重新读取。", response.status);
            }
            const data = await response.json();
            const result = data && typeof data === "object" && !Array.isArray(data) ? parse(data) : null;
            if (!result) throw new PlatformServiceError("生效回执不完整，请重新读取核对。");
            if (!isCurrent()) return null;
            blocked = false; return result;
        } catch (error) {
            if (!isCurrent()) return null;
            blocked = true;
            throw error instanceof PlatformServiceError ? error : new PlatformServiceError(body ? "生效结果尚未确认，请读取回执核对，不要重复提交。" : "生效方案读取失败，请手动重新读取。");
        } finally { if (pending === controller) pending = null; }
    }
    return { isCurrent, close() { active = false; pending?.abort(); }, load: () => request(undefined, value => parseMappingPublicationPreview(value.preview)),
        publish: (input: MappingPublicationWrite) => {
            const body = parseMappingPublicationWrite(input);
            if (!body) throw new PlatformServiceError("请先读取完整生效方案。");
            return request(body, value => {
                const result = parseMappingPublicationReceipt(value.publication);
                return result?.version === body.expectedPublicationVersion + 1 && result.draftVersion === body.expectedDraftVersion && result.fingerprint === body.fingerprint ? result : null;
            });
        },
    };
}
