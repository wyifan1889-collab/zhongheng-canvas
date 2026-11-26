import { siteConfig } from "./site";
import { json } from "./http";
import type { createAccountApi } from "./accounts";
import type { InspirationStore } from "./inspiration-store";

const generationCapabilities = ["text", "image", "video", "audio"] as const;

export type ReadinessResult = {
    ready: boolean;
    checks?: Record<string, "ok" | "failed" | "disabled">;
};

export type ReadinessProbe = () => ReadinessResult | boolean | Promise<ReadinessResult | boolean>;

function withRequestId(response: Response, requestId: string): Response {
    if (response.headers.has("x-request-id")) return response;
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createApp(
    accounts?: ReturnType<typeof createAccountApi>,
    publicSiteKey?: string,
    cloudCanvas = false,
    cloudMedia = false,
    readiness: ReadinessProbe = () => ({ ready: true, checks: { api: "ok" } }),
    generation: Partial<Record<(typeof generationCapabilities)[number], boolean>> = {},
    inspiration?: InspirationStore,
) {
    if (accounts && !publicSiteKey) throw new Error("启用账户接口必须提供人机验证公钥");
    const startedAt = new Date().toISOString();
    const site = accounts ? {
        ...siteConfig,
        features: { ...siteConfig.features, registration: true, cloudCanvas, cloudMedia, generation: { ...siteConfig.features.generation, ...generation } },
        authentication: { method: "email-password", captcha: { provider: "turnstile", siteKey: publicSiteKey, action: "account" } },
    } : siteConfig;
    return async (request: Request, peerIp?: string): Promise<Response> => {
        const requestId = crypto.randomUUID();
        const responseHeaders = new Headers({ "x-request-id": requestId });
        try {
            const url = new URL(request.url);
            if (request.method === "GET" && url.pathname === "/health") {
                return json({ status: "ok", service: "infinite-canvas-api", phase: "m1-foundation", startedAt }, 200, responseHeaders);
            }
            if (request.method === "GET" && url.pathname === "/healthz") {
                return json({ status: "ok", service: "infinite-canvas-api", phase: "m2-runtime", startedAt }, 200, responseHeaders);
            }
            if (request.method === "GET" && url.pathname === "/readyz") {
                let result: ReadinessResult;
                try {
                    const probed = await readiness();
                    result = typeof probed === "boolean" ? { ready: probed } : probed;
                } catch {
                    result = { ready: false, checks: { api: "ok", dependencies: "failed" } };
                }
                return json({ status: result.ready ? "ready" : "not_ready", service: "infinite-canvas-api", checks: result.checks ?? {} }, result.ready ? 200 : 503, responseHeaders);
            }
            if (request.method === "GET" && url.pathname === "/api/v1/meta") {
                const enabledCapabilities = generationCapabilities.filter((capability) => site.features.generation[capability]);
                return json({
                    service: "infinite-canvas-api", apiVersion: "v1",
                    // `capabilities` describes what this runtime currently exposes.
                    // Keep the full implementation vocabulary separate so a closed
                    // generation gate cannot look like an enabled model endpoint.
                    capabilities: enabledCapabilities,
                    supportedCapabilities: generationCapabilities,
                    authentication: accounts ? "enabled" : "foundation-only", billing: "planned", providers: "server-side-only",
                    features: site.features,
                }, 200, responseHeaders);
            }
            if (request.method === "GET" && url.pathname === "/api/v1/site") return json(site, 200, responseHeaders);
            if (url.pathname === "/api/v1/inspiration/items") {
                if (request.method !== "GET") return json({ error: { code: "method_not_allowed", message: "不支持此操作" }, requestId }, 405, responseHeaders);
                if ([...url.searchParams].length) return json({ error: { code: "invalid_input", message: "此接口不接受查询参数" }, requestId }, 400, responseHeaders);
                // Curated file only; never consult account histories or private storage.
                return json({ items: (await inspiration?.read())?.items ?? [], requestId }, 200, responseHeaders);
            }
            if (accounts) return withRequestId(await accounts(request, peerIp), requestId);
            // No environment/configuration means no public account, draft or billing writes.
            return json({ error: "not_found", requestId }, 404, responseHeaders);
        } catch {
            return json({ error: { code: "service_unavailable", message: "服务暂时不可用，请稍后再试" }, requestId }, 503, responseHeaders);
        }
    };
}
