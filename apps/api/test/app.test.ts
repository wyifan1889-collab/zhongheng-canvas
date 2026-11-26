import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

const app = createApp();
const get = (path: string) => app(new Request(`http://localhost${path}`));

describe("public foundation API", () => {
    test("health is process liveness, not a claim of production readiness", async () => {
        expect((await get("/health")).status).toBe(200);
        const response = await get("/health");
        expect(await response.json()).toMatchObject({ phase: "m1-foundation" });
        expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    });
    test("healthz and readyz expose separate runtime gates", async () => {
        const live = await get("/healthz");
        expect(live.status).toBe(200);
        expect(await live.json()).toMatchObject({ phase: "m2-runtime" });
        const ready = await get("/readyz");
        expect(ready.status).toBe(200);
        expect(await ready.json()).toEqual({ status: "ready", service: "infinite-canvas-api", checks: { api: "ok" } });
    });
    test("a failed readiness probe returns a stable non-sensitive response", async () => {
        const broken = createApp(undefined, undefined, false, false, () => { throw new Error("private database details"); });
        const response = await broken(new Request("http://localhost/readyz"));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: "not_ready", service: "infinite-canvas-api", checks: { api: "ok", dependencies: "failed" } });
    });
    test("site config exposes a stable branding contract and closed features", async () => {
        const site = await (await get("/api/v1/site")).json();
        expect(Object.keys(site).sort()).toEqual(["brand", "features", "schemaVersion", "theme"]);
        expect(site.schemaVersion).toBe(1);
        expect(site.brand.name).toBe("无限画布");
        expect(site.features).toEqual({
            registration: false, cloudCanvas: false, cloudMedia: false, recharge: false,
            generation: { text: false, image: false, video: false, audio: false },
        });
        expect(Object.keys(site.theme).sort()).toEqual(["dark", "light"]);
        expect((await get("/api/v1/site")).headers.get("cache-control")).toBe("no-store");
    });
    test("metadata distinguishes foundation code from enabled functionality", async () => {
        const meta = await (await get("/api/v1/meta")).json();
        const site = await (await get("/api/v1/site")).json();
        expect(meta).toMatchObject({ authentication: "foundation-only", billing: "planned" });
        expect(meta.capabilities).toEqual([]);
        expect(meta.supportedCapabilities).toEqual(["text", "image", "video", "audio"]);
        expect(meta.features).toEqual(site.features);
        expect(meta.features.registration).toBe(false);
        expect(meta.features.cloudCanvas).toBe(false);
    });
    test("auth, cloud drafts, payments and generation are not public routes", async () => {
        for (const path of ["/api/auth/sign-up/email", "/api/v1/canvases", "/api/v1/payments", "/api/v1/generate", "/api/v1/generation/quote", "/api/v1/generation/tasks"]) {
            expect((await app(new Request(`http://localhost${path}`, { method: "POST" }))).status).toBe(404);
            expect((await get(path)).status).toBe(404);
        }
    });
    test("the handler also serves real loopback HTTP without starting other services", async () => {
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app(request) });
        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/site`);
            expect(response.status).toBe(200);
            expect((await response.json()).features.registration).toBe(false);
        } finally {
            await server.stop(true);
        }
    });
});
