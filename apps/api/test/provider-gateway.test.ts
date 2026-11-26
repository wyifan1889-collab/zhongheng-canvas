import { describe, expect, test } from "bun:test";
import { createProviderGateway, isBlockedProviderAddress, isBlockedProviderHostname, type ProviderTarget } from "../src/provider-gateway";

const target: ProviderTarget = {
    providerId: "provider-test", adapter: "openai-compatible", endpoint: "https://provider.example/v1", credential: "secret-key",
};

const resolvePublic = async () => ["93.184.216.34"];

describe("provider gateway boundary", () => {
    test("uses the server credential and normalizes a model catalogue", async () => {
        const calls: { input: string; init?: RequestInit }[] = [];
        const gateway = createProviderGateway(async (input, init) => {
            calls.push({ input: String(input), init });
            return Response.json({ data: [{ id: "gpt-a" }, { id: "gpt-a" }, "gpt-b"] });
        }, resolvePublic);
        const result = await gateway.listModels(target);
        expect(result).toEqual({ status: "succeeded", models: ["gpt-a", "gpt-b"] });
        expect(calls[0]?.input).toBe("https://provider.example/v1/models");
        expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret-key");
        expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
        expect(calls[0]?.init?.redirect).toBe("error");
    });

    test("keeps the legacy /v1 path for endpoints that omit it", async () => {
        let requested = "";
        const gateway = createProviderGateway(async (input) => {
            requested = String(input);
            return Response.json({ models: ["model-a"] });
        }, resolvePublic);
        await gateway.listModels({ ...target, endpoint: "https://provider.example" });
        expect(requested).toBe("https://provider.example/v1/models");
    });

    test("keeps the complete directory, accepts empty arrays, and rejects malformed or partial lists", async () => {
        const models = Array.from({ length: 151 }, (_, index) => `model-${index}`);
        const full = createProviderGateway(async () => Response.json({ data: models.map(id => ({ id })) }), resolvePublic);
        expect(await full.listModels(target)).toEqual({ status: "succeeded", models });
        const empty = createProviderGateway(async () => Response.json({ data: [] }), resolvePublic);
        expect(await empty.listModels(target)).toEqual({ status: "succeeded", models: [] });
        for (const payload of [{}, { data: ["valid", {}] }, { data: [" "] }, { data: [123] }, { data: ["a".repeat(201)] },
            { data: ["valid"], has_more: true }, { data: ["valid"], next_cursor: "page2" },
            { data: ["valid"], pagination: { total: 2 } }, { data: ["valid"], links: { next: "/page2" } }]) {
            const invalid = createProviderGateway(async () => Response.json(payload), resolvePublic);
            expect(await invalid.listModels(target)).toEqual({ status: "failed", code: "provider_invalid_response" });
        }
    });

    test("sync refuses ambiguous totals, final partial pages and error envelopes instead of treating them as an empty catalog", async () => {
        for (const payload of [{ data: [], total: "2" }, { data: ["one"], total: 0 }, { data: [], success: false }, { data: [], error: { message: "rejected" } },
            { data: [], models: ["one"] }, { data: [], pagination: [] }, { data: ["one"], has_more: "false" },
            { data: ["last"], pagination: { page: 2, has_more: false } }, { data: ["last"], links: { prev: "/page1" } },
            { data: ["one"], pagination: { page: 1, total_pages: 2 } }, { data: ["one"], last_page: 2 },
            { data: ["last"], offset: 10 }, { data: ["one"], pagination: { limit: 1 } },
            { data: ["one"], meta: { page: 1, total: 2 } }, { data: ["one"], links: { last: "/page2" } }]) {
            expect(await createProviderGateway(async () => Response.json(payload), resolvePublic).listModels(target)).toEqual({ status: "failed", code: "provider_invalid_response" });
        }
        expect(await createProviderGateway(async () => Response.json({ data: [], pagination: { page: 1, total: 0, has_more: false }, links: { next: null } }), resolvePublic).listModels(target)).toEqual({ status: "succeeded", models: [] });
        expect(await createProviderGateway(async () => Response.json({ data: ["one"], pagination: { page: 1, total_pages: 1, total: 1 } }), resolvePublic).listModels(target)).toEqual({ status: "succeeded", models: ["one"] });
    });

    test("does not expose upstream response details for rejected or malformed responses", async () => {
        const rejected = createProviderGateway(async () => new Response("provider-secret-error", { status: 401 }), resolvePublic);
        expect(await rejected.request({ target, path: "chat/completions", body: { model: "gpt-a" } })).toEqual({ status: "failed", code: "provider_rejected" });
        const malformed = createProviderGateway(async () => new Response("not-json", { status: 200 }), resolvePublic);
        expect(await malformed.request({ target, path: "chat/completions", body: { model: "gpt-a" } })).toEqual({ status: "failed", code: "provider_invalid_response" });
    });

    test("classifies network and timeout failures as unknown and never marks them retryable", async () => {
        const network = createProviderGateway(async () => { throw new Error("socket details should stay private"); }, resolvePublic);
        expect(await network.request({ target, path: "chat/completions", body: { model: "gpt-a" } })).toEqual({ status: "unknown", code: "provider_unreachable", retryable: false });
        const timeout = createProviderGateway(async () => { throw new DOMException("aborted", "AbortError"); }, resolvePublic);
        expect(await timeout.request({ target, path: "chat/completions", body: { model: "gpt-a" } })).toEqual({ status: "unknown", code: "provider_timeout", retryable: false });
        const timedOut = createProviderGateway(async () => { throw new DOMException("timed out", "TimeoutError"); }, resolvePublic);
        expect(await timedOut.listModels(target)).toEqual({ status: "unknown", code: "provider_timeout", retryable: false });
        const bodyTimedOut = createProviderGateway(async () => Object.assign(Response.json({}), {
            json: async () => { throw new DOMException("timed out", "TimeoutError"); },
        }), resolvePublic);
        expect(await bodyTimedOut.listModels(target)).toEqual({ status: "unknown", code: "provider_timeout", retryable: false });
    });

    test("keeps upstream 5xx outcomes unknown without reading their body or retrying", async () => {
        for (const status of [500, 502, 503, 504]) {
            let calls = 0;
            const response = new Response("private upstream error details", { status });
            const gateway = createProviderGateway(async () => { calls++; return response; }, resolvePublic);
            expect(await gateway.request({ target, path: "images/generations", body: { model: "image-test" } }))
                .toEqual({ status: "unknown", code: "provider_response_unknown", retryable: false });
            expect(response.bodyUsed).toBe(false);
            expect(calls).toBe(1);
        }
    });

    test("rejects unsafe endpoints and paths before making a network request", async () => {
        let called = false;
        const gateway = createProviderGateway(async () => { called = true; return Response.json({}); }, resolvePublic);
        expect(await gateway.request({ ...({ target: { ...target, endpoint: "https://user:pass@provider.example/v1" }, path: "models" }) })).toEqual({ status: "failed", code: "provider_invalid_response", requestSent: false });
        expect(await gateway.request({ target, path: "../models" })).toEqual({ status: "failed", code: "provider_invalid_response", requestSent: false });
        expect(called).toBe(false);
    });

    test("rejects locally scoped literal addresses and metadata hostnames", () => {
        for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
            expect(isBlockedProviderAddress(address)).toBe(true);
        }
        for (const hostname of ["localhost", "foo.localhost", "metadata.google.internal", "metadata.azure.com", "service.internal"]) {
            expect(isBlockedProviderHostname(hostname)).toBe(true);
        }
        expect(isBlockedProviderHostname("provider.example")).toBe(false);
    });

    test("rejects a hostname when any DNS answer is locally scoped before fetching", async () => {
        let called = false;
        const gateway = createProviderGateway(async () => { called = true; return Response.json({}); }, async () => ["93.184.216.34", "192.168.1.9"]);
        expect(await gateway.request({ target, path: "models" })).toEqual({ status: "failed", code: "provider_invalid_response", requestSent: false });
        expect(called).toBe(false);
    });

    test("classifies DNS failures as unreachable without contacting the target", async () => {
        let called = false;
        const gateway = createProviderGateway(async () => { called = true; return Response.json({}); }, async () => { throw new Error("DNS failed"); });
        expect(await gateway.request({ target, path: "models" })).toEqual({ status: "unknown", code: "provider_unreachable", retryable: false });
        expect(called).toBe(false);
    });
});

