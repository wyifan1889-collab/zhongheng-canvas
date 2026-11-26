import { expect, test } from "bun:test";
import { createProviderGateway } from "../src/provider-gateway";

test("image specification transport appends paths after legal empty URL suffixes without changing the stored binding", async () => {
    for (const suffix of ["", "?", "#", "?#"]) {
        const endpoint = `https://provider.example/v1${suffix}`;
        const target = { providerId: "synthetic-image-url", adapter: "openai-compatible" as const,
            endpoint, credential: "synthetic-image-url-key" };
        const calls: string[] = [];
        const gateway = createProviderGateway(async (url) => {
            calls.push(String(url)); return Response.json({ data: [] });
        }, async () => ["93.184.216.34"]);
        expect(await gateway.request({ target, path: "images/generations", body: { n: 1 } })).toMatchObject({ status: "succeeded" });
        expect(calls).toEqual(["https://provider.example/v1/images/generations"]);
        expect(target.endpoint).toBe(endpoint);
        expect(await gateway.listModels(target)).toEqual({ status: "succeeded", models: [] });
        expect(calls[1]).toBe("https://provider.example/v1/models");
    }
});

test("image specification transport retains rejection of credentials and nonempty URL components", async () => {
    let calls = 0;
    const gateway = createProviderGateway(async () => { calls++; return Response.json({ data: [] }); }, async () => ["93.184.216.34"]);
    for (const endpoint of ["http://provider.example/v1", "https://user:password@provider.example/v1",
        "https://provider.example/v1?query=1", "https://provider.example/v1#fragment"]) {
        expect(await gateway.request({ target: { providerId: "synthetic-image-url", adapter: "openai-compatible", endpoint,
            credential: "synthetic-image-url-key" }, path: "images/generations" })).toEqual({ status: "failed", code: "provider_invalid_response", requestSent: false });
    }
    expect(calls).toBe(0);
});
