import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { auditEvent, generationTask, modelCatalog, modelPricing, modelProvider, modelProviderCredential, providerDiscoveredModel, providerDiscoveryReceipt, session as authSession, user } from "@infinite-canvas/database/schema";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { deleteCatalogModel, deleteCatalogProvider } from "@infinite-canvas/database/catalog-deletion";
import { saveNodeModel, saveNodeModelGroups } from "@infinite-canvas/database/node-model-groups";
import { decryptProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { resolveGenerationQuote } from "../src/generation-dispatch";
import { createTestDatabase } from "./database";
import { accountPolicy } from "../src/policy";

const origin = "http://localhost:4017";
const password = "model-catalog-test-password";
const secret = "model-catalog-test-" + crypto.randomUUID();
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let userCookie = "";
let adminCookie = "";
let userId = "";
let adminId = "";
const mails: { to: string; url: string }[] = [];

function request(path: string, session = "", method = "GET", body?: unknown) {
    const accountId = session === adminCookie ? adminId : session === userCookie ? userId : "";
    const headers = new Headers({ origin, cookie: session });
    if (accountId) headers.set("x-canvas-account-id", accountId);
    if (body !== undefined) headers.set("content-type", "application/json");
    return app(new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "198.51.100.17");
}

function cookies(response: Response) {
    return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

async function discover(providerId: string, input: unknown, models: string[]) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ data: models.map(id => ({ id })) })) as typeof fetch;
    try {
        const response = await request(`/api/v1/admin/providers/${providerId}/discover`, adminCookie, "POST", input);
        expect(response.status).toBe(200);
        return await response.json();
    } finally { globalThis.fetch = original; }
}

beforeAll(async () => {
    database = await createTestDatabase();
    const api = createAccountApi({
        database: database.db,
        origin,
        auth: {
            secret,
            sendVerificationEmail: async (mail) => { mails.push(mail); },
            sendResetPassword: async () => {},
        },
        rates: createRateStore(database.pool, secret),
        policy: { ...accountPolicy, save: { points: 500, duration: 60 } },
        verifyHuman: async () => true,
        providerResolver: async () => ["93.184.216.34"],
        onFault: () => {},
    });
    app = createApp(api, "catalog-test-site-key");

    const signUp = await app(new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ name: "Catalog User", email: "catalog-user@example.test", password }),
    }), "198.51.100.17");
    expect(signUp.status).toBe(200);
    const verify = await app(new Request(mails[0]!.url), "198.51.100.17");
    expect(verify.status).toBe(302);
    const signIn = await app(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "catalog-user@example.test", password }),
    }), "198.51.100.17");
    expect(signIn.status).toBe(200);
    adminCookie = cookies(signIn);

    const [owner] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, "catalog-user@example.test"));
    adminId = owner!.id;
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, owner!.id));
    const regularSignUp = await app(new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ name: "Regular User", email: "regular-user@example.test", password }),
    }), "198.51.100.17");
    expect(regularSignUp.status).toBe(200);
    const regularVerify = await app(new Request(mails[1]!.url), "198.51.100.17");
    expect(regularVerify.status).toBe(302);
    const regularSignIn = await app(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "regular-user@example.test", password }),
    }), "198.51.100.17");
    expect(regularSignIn.status).toBe(200);
    userCookie = cookies(regularSignIn);
    const [regular] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, "regular-user@example.test"));
    userId = regular!.id;
    await database.db.insert(modelProvider).values({
        id: "provider-openai-main", displayName: "OpenAI 主线路", adapter: "openai-compatible",
        endpoint: "https://provider.invalid/v1", secretRef: "MODEL_PROVIDER_OPENAI_MAIN", enabled: true,
    });
    await database.db.insert(modelProviderCredential).values({ providerId: "provider-openai-main", ciphertext: "test-ciphertext", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values([
        { id: "model-text", providerId: "provider-openai-main", publicId: "platform-text", providerModel: "gpt-test", displayName: "平台文本模型", capability: "text", enabled: true },
        { id: "model-disabled", providerId: "provider-openai-main", publicId: "platform-disabled", providerModel: "disabled-test", displayName: "已停用模型", capability: "image", enabled: false },
    ]);
    await database.db.insert(modelPricing).values([
        { id: "price-text-v1", modelId: "model-text", version: 1, billingUnit: "request", creditsPerUnit: 3, effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), enabled: true },
        { id: "price-text-future", modelId: "model-text", version: 2, billingUnit: "output_token", creditsPerUnit: 1, effectiveFrom: new Date("2099-01-01T00:00:00.000Z"), enabled: true },
        { id: "price-disabled-model", modelId: "model-disabled", version: 1, billingUnit: "request", creditsPerUnit: 9, effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), enabled: true },
    ]);
});

afterAll(async () => { await database.close(); });

describe("platform model catalogue boundary", () => {
    test("requires a verified session and only returns enabled public entries", async () => {
        expect((await request("/api/v1/models")).status).toBe(401);
        const response = await request("/api/v1/models", userCookie);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.items).toEqual([{ id: "platform-text", displayName: "平台文本模型", capability: "text", group: null }]);
        expect(JSON.stringify(result)).not.toContain("MODEL_PROVIDER_OPENAI_MAIN");
        expect(JSON.stringify(result)).not.toContain("gpt-test");
    });

    test("admin projection is guarded and never exposes a provider secret", async () => {
        const denied = await request("/api/v1/admin/models", userCookie);
        expect(denied.status).toBe(403);
        const response = await request("/api/v1/admin/models", adminCookie);
        expect(response.status).toBe(200);
        const result = await response.json();
        const textModel = result.items.find((item: { id: string }) => item.id === "platform-text");
        expect(textModel).toMatchObject({
            id: "platform-text", providerId: "provider-openai-main", adapter: "openai-compatible",
            endpoint: "https://provider.invalid/v1", providerModel: "gpt-test", secretRefConfigured: true,
        });
        expect(JSON.stringify(result)).not.toContain("MODEL_PROVIDER_OPENAI_MAIN");
        expect(textModel.secretRef).toBeUndefined();
    });

    test("admin user projection is guarded and includes only safe wallet totals", async () => {
        expect((await request("/api/v1/admin/users", userCookie)).status).toBe(403);
        const response = await request("/api/v1/admin/users?limit=10", adminCookie);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.items.length).toBe(2);
        expect(result.items[0]).toMatchObject({ emailVerified: true, wallet: { unit: "credit", availableUnits: "0", reservedUnits: "0", totalUnits: "0" } });
        expect(JSON.stringify(result)).not.toContain("password");
    });

    test("admin provider writes encrypt credentials and never return them", async () => {
        expect((await request("/api/v1/admin/providers/provider-openai-main", userCookie, "PUT", {
            displayName: "x", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", enabled: true, apiKey: "admin-only-provider-key",
        })).status).toBe(403);
        const input = {
            displayName: "OpenAI 主线路", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", enabled: true, apiKey: "admin-only-provider-key",
            revision: 1,
        };
        const receipt = await discover("provider-openai-main", input, ["gpt-test", "disabled-test"]);
        const saved = await request("/api/v1/admin/providers/provider-openai-main", adminCookie, "PUT", { ...input, discoveryReceiptId: receipt.receiptId });
        expect(saved.status).toBe(200);
        expect(JSON.stringify(await saved.json())).not.toContain("admin-only-provider-key");
        const [credential] = await database.db.select().from(modelProviderCredential).where(eq(modelProviderCredential.providerId, "provider-openai-main"));
        expect(credential!.ciphertext).not.toContain("admin-only-provider-key");
        expect(decryptProviderCredential(secret, "provider-openai-main", credential!)).toBe("admin-only-provider-key");
        expect(() => decryptProviderCredential(secret + "rotated", "provider-openai-main", credential!)).toThrow();
        const providers = await request("/api/v1/admin/providers", adminCookie);
        expect(providers.status).toBe(200);
        expect((await providers.json()).items.find((item: { id: string }) => item.id === "provider-openai-main")).toMatchObject({ credentialConfigured: true });
    });

    test("admin provider connection test returns only upstream model ids", async () => {
        expect((await request("/api/v1/admin/providers/provider-openai-main/test", userCookie, "POST")).status).toBe(403);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe("https://provider.invalid/v1/models");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-only-provider-key");
            return new Response(JSON.stringify({ data: [{ id: "gpt-test" }, { id: "gpt-vision" }, { id: "gpt-test" }] }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        try {
            const response = await request("/api/v1/admin/providers/provider-openai-main/test", adminCookie, "POST");
            expect(response.status).toBe(200);
            const result = await response.json();
            expect(result).toMatchObject({ providerId: "provider-openai-main", models: ["gpt-test", "gpt-vision"] });
            expect(JSON.stringify(result)).not.toContain("admin-only-provider-key");
            expect(result.bindings).toHaveLength(2);
            expect(result.bindings).toContainEqual(expect.objectContaining({ id: "platform-disabled", providerModel: "disabled-test", enabled: false, found: false }));
            expect(result.bindings).toContainEqual(expect.objectContaining({ id: "platform-text", providerModel: "gpt-test", enabled: true, found: true }));
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("model writes preserve the provider/model binding once pricing exists", async () => {
        const conflict = await request("/api/v1/admin/models/platform-text", adminCookie, "PUT", {
            providerId: "provider-openai-main", providerModel: "gpt-renamed", displayName: "平台文本模型", capability: "text", enabled: true, groupId: null, revision: 1,
        });
        expect(conflict.status).toBe(409);
        const saved = await request("/api/v1/admin/models/platform-text", adminCookie, "PUT", {
            providerId: "provider-openai-main", providerModel: "gpt-test", displayName: "平台文本模型 2", capability: "text", enabled: true, groupId: null, revision: 1,
        });
        expect(saved.status).toBe(200);
        expect((await saved.json()).model).toMatchObject({ id: "platform-text", displayName: "平台文本模型 2" });
    });

    test("public pricing returns only currently effective prices for enabled models", async () => {
        const response = await request("/api/v1/model-pricing", userCookie);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.items).toEqual([{
            modelId: "platform-text", displayName: "平台文本模型 2", capability: "text", version: 1,
            billingUnit: "request", creditsPerUnit: 3,
            effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null,
        }]);
        expect(JSON.stringify(result)).not.toContain("gpt-test");
    });

    test("server generation quote resolver binds the active price to the public model", async () => {
        await expect(resolveGenerationQuote(database.db, { modelId: "platform-text", quotedUnits: 3 })).resolves.toMatchObject({
            modelId: "platform-text", priceVersion: 1, billingUnit: "request", creditsPerUnit: 3, quotedUnits: 3,
        });
        await expect(resolveGenerationQuote(database.db, { modelId: "platform-text", quotedUnits: 3, priceVersion: 2 })).rejects.toThrow("模型价格不可用");
        await expect(resolveGenerationQuote(database.db, { modelId: "missing-model", quotedUnits: 3 })).rejects.toThrow("模型价格不可用");
    });

    test("admin pricing projection is guarded and includes version history", async () => {
        expect((await request("/api/v1/admin/model-pricing", userCookie)).status).toBe(403);
        const response = await request("/api/v1/admin/model-pricing", adminCookie);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.items).toHaveLength(3);
        expect(result.items.find((item: { id: string }) => item.id === "price-text-v1")).toMatchObject({
            modelId: "platform-text", modelCatalogId: "model-text", version: 1,
            billingUnit: "request", creditsPerUnit: 3, enabled: true,
        });
        expect(JSON.stringify(result)).not.toContain("secretRef");
    });

    test("admin pricing writes append a new version and hide the prior active version", async () => {
        expect((await request("/api/v1/admin/model-pricing", userCookie, "POST", {
            modelId: "platform-text", billingUnit: "output_token", creditsPerUnit: 4, enabled: true,
        })).status).toBe(403);
        const saved = await request("/api/v1/admin/model-pricing", adminCookie, "POST", {
            modelId: "platform-text", billingUnit: "output_token", creditsPerUnit: 4,
            effectiveFrom: "2098-01-01T00:00:00.000Z", enabled: true,
        });
        expect(saved.status).toBe(201);
        const result = await saved.json();
        expect(result.pricing).toMatchObject({ modelId: "platform-text", version: 3, billingUnit: "output_token", creditsPerUnit: 4, enabled: true });
        const history = await request("/api/v1/admin/model-pricing", adminCookie);
        const items = (await history.json()).items as { modelId: string; version: number; enabled: boolean }[];
        expect(items.find((item) => item.modelId === "platform-text" && item.version === 1)?.enabled).toBe(false);
        expect(items.find((item) => item.modelId === "platform-text" && item.version === 3)?.enabled).toBe(true);
    });

    test("admin balance adjustments are transactional, append-only and idempotent", async () => {
        expect((await request(`/api/v1/admin/users/${userId}/balance`, userCookie, "POST", { amount: "100", reason: "首笔测试额度" })).status).toBe(403);
        const first = await request(`/api/v1/admin/users/${userId}/balance`, adminCookie, "POST", { amount: "100", reason: "首笔测试额度" });
        expect(first.status).toBe(400);
        const headers = { "idempotency-key": "admin-balance-test-1" };
        const granted = await app(new Request(`${origin}/api/v1/admin/users/${userId}/balance`, {
            method: "POST", headers: new Headers({ origin, cookie: adminCookie, "x-canvas-account-id": adminId, "content-type": "application/json", ...headers }),
            body: JSON.stringify({ amount: "100", reason: "首笔测试额度" }),
        }), "198.51.100.17");
        expect(granted.status).toBe(200);
        const grantedBody = await granted.json();
        expect(grantedBody.wallet).toMatchObject({ availableUnits: "100", reservedUnits: "0", totalUnits: "100" });
        const replay = await app(new Request(`${origin}/api/v1/admin/users/${userId}/balance`, {
            method: "POST", headers: new Headers({ origin, cookie: adminCookie, "x-canvas-account-id": adminId, "content-type": "application/json", ...headers }),
            body: JSON.stringify({ amount: "100", reason: "首笔测试额度" }),
        }), "198.51.100.17");
        expect(replay.status).toBe(200);
        expect((await replay.json()).wallet.availableUnits).toBe("100");
        const conflict = await app(new Request(`${origin}/api/v1/admin/users/${userId}/balance`, {
            method: "POST", headers: new Headers({ origin, cookie: adminCookie, "x-canvas-account-id": adminId, "content-type": "application/json", ...headers }),
            body: JSON.stringify({ amount: "120", reason: "重用幂等键" }),
        }), "198.51.100.17");
        expect(conflict.status).toBe(409);
        const subtract = await app(new Request(`${origin}/api/v1/admin/users/${userId}/balance`, {
            method: "POST", headers: new Headers({ origin, cookie: adminCookie, "x-canvas-account-id": adminId, "content-type": "application/json", "idempotency-key": "admin-balance-test-2" }),
            body: JSON.stringify({ amount: "-40", reason: "扣回测试额度" }),
        }), "198.51.100.17");
        expect(subtract.status).toBe(200);
        expect((await subtract.json()).wallet.availableUnits).toBe("60");
        const overdraft = await app(new Request(`${origin}/api/v1/admin/users/${userId}/balance`, {
            method: "POST", headers: new Headers({ origin, cookie: adminCookie, "x-canvas-account-id": adminId, "content-type": "application/json", "idempotency-key": "admin-balance-test-3" }),
            body: JSON.stringify({ amount: "-61", reason: "不能扣成负数" }),
        }), "198.51.100.17");
        expect(overdraft.status).toBe(409);
    });
});

describe("channel discovery and inventory", () => {
    const newInput = { displayName: "测试渠道", adapter: "openai-compatible", endpoint: "https://catalog.example/v1",
        apiKey: "test-private-discovery-key", enabled: true, revision: 0 };

    test("new channels require server evidence bound to target, and inventory is separate from public models", async () => {
        const id = "discovery-new";
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", newInput)).status).toBe(409);
        expect((await request(`/api/v1/admin/providers/${id}/discover`, userCookie, "POST", newInput)).status).toBe(403);
        const read = await discover(id, newInput, ["shared-model", "image-model"]);
        expect(read).toMatchObject({ providerId: id, revision: 0, added: ["shared-model", "image-model"], missing: [], unchanged: 0 });
        expect((await database.db.select().from(modelProvider).where(eq(modelProvider.id, id)))).toHaveLength(0);
        const receipts = await database.db.select().from(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.id, read.receiptId));
        expect(JSON.stringify(receipts)).not.toContain(newInput.apiKey);
        for (const change of [{ endpoint: "https://changed.example/v1" }, { adapter: "sub2api" }, { apiKey: "different-key" }]) {
            const response = await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...newInput, ...change, discoveryReceiptId: read.receiptId });
            expect(response.status).toBe(409);
        }
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...newInput, discoveryReceiptId: read.receiptId, models: ["injected"] })).status).toBe(400);
        const saved = await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...newInput, discoveryReceiptId: read.receiptId });
        expect(saved.status).toBe(200);
        expect((await saved.json()).provider).toMatchObject({ id, revision: 1, credentialConfigured: true, createdAt: expect.any(String), updatedAt: expect.any(String) });
        expect((await database.db.select().from(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.id, read.receiptId)))).toHaveLength(0);
        const inventory = await request("/api/v1/admin/provider-models", adminCookie);
        const models = (await inventory.json()).models.filter((row: any) => row.providerId === id);
        expect(models.map((row: any) => row.providerModel)).toEqual(["image-model", "shared-model"]);
        expect(models.every((row: any) => row.available && row.boundModelId === null)).toBe(true);
        expect((await request("/api/v1/admin/provider-models", userCookie)).status).toBe(403);
        expect(JSON.stringify(await (await request("/api/v1/models", userCookie)).json())).not.toContain("shared-model");
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...newInput, discoveryReceiptId: read.receiptId })).status).toBe(409);
    });

    test("every channel save requires discovery and stale receipts cannot overwrite", async () => {
        const id = "discovery-new";
        const input = { ...newInput, apiKey: "", revision: 1 };
        const older = await discover(id, input, ["older-result"]);
        const newer = await discover(id, input, ["newer-result"]);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...input, discoveryReceiptId: newer.receiptId })).status).toBe(200);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...input, discoveryReceiptId: older.receiptId })).status).toBe(409);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...input, revision: 2, apiKey: "rotated" })).status).toBe(409);
        const metadata = { ...input, revision: 2, enabled: false, displayName: "核对后停用" };
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", metadata)).status).toBe(409);
        const checked = await discover(id, metadata, ["newer-result"]);
        const saved = await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...metadata, discoveryReceiptId: checked.receiptId });
        expect(saved.status).toBe(200);
        expect((await saved.json()).provider).toMatchObject({ revision: 3, enabled: false, removedModelIds: [] });
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...input, revision: 2, enabled: true })).status).toBe(409);
    });

    test("a bare-host endpoint round-trips and save consumes a previously checked directory without another network call", async () => {
        const id = "bare-host-channel", input = { ...newInput, endpoint: "https://bare.example" };
        const read = await discover(id, input, ["bare-model"]);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...input, discoveryReceiptId: read.receiptId })).status).toBe(200);
        const listed = (await (await request("/api/v1/admin/providers", adminCookie)).json()).items.find((row: any) => row.id === id);
        expect(listed.endpoint).toBe(input.endpoint);
        const edit = { displayName: "裸地址核对后停用", endpoint: listed.endpoint, adapter: listed.adapter,
            enabled: false, revision: listed.revision, apiKey: "" };
        const checked = await discover(id, edit, ["bare-model"]);
        const original = globalThis.fetch;
        globalThis.fetch = (async () => { throw new Error("metadata changes must not call the provider"); }) as typeof fetch;
        try {
            const saved = await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...edit, discoveryReceiptId: checked.receiptId });
            expect(saved.status).toBe(200);
            const { provider } = await saved.json();
            expect(provider).toMatchObject({ endpoint: input.endpoint, displayName: edit.displayName, enabled: false, revision: 2 });
            const [stored] = await database.db.select().from(modelProvider).where(eq(modelProvider.id, id));
            expect(stored!.endpoint).toBe(input.endpoint);
            for (const endpoint of ["https://other.example", "https://bare.example/another-path"]) {
                const refused = await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...edit, revision: 2, endpoint });
                expect(refused.status).toBe(409);
                expect((await refused.json()).error.code).toBe("provider_discovery_required");
            }
        } finally { globalThis.fetch = original; }
    });

    test("offline disable works during an upstream outage and unfinished work, but cannot edit config or enable", async () => {
        const id = "offline-disable-channel", read = await discover(id, newInput, ["offline-image"]);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...newInput, discoveryReceiptId: read.receiptId })).status).toBe(200);
        expect((await request("/api/v1/admin/models/offline-image", adminCookie, "PUT", { providerId: id, providerModel: "offline-image", displayName: "Offline image", capability: "image", enabled: true, groupId: null, revision: 0 })).status).toBe(200);
        const [node] = await database.db.select().from(modelCatalog).where(eq(modelCatalog.publicId, "offline-image"));
        await database.db.insert(modelPricing).values({ id: "price-offline-disable", modelId: node!.id, version: 1, billingUnit: "request", creditsPerUnit: 3, effectiveFrom: new Date(), enabled: true });
        await expect(resolveGenerationQuote(database.db, { modelId: "offline-image", quotedUnits: 3 })).resolves.toMatchObject({ modelId: "offline-image" });
        const task = await createGenerationTaskRepository(database.db).create({ ownerId: adminId, modelId: "offline-image", inputSnapshot: { prompt: "synthetic" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: "offline-test" });
        const inventory = await database.db.select().from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, id));
        const beforeTask = await database.db.select().from(generationTask).where(eq(generationTask.id, task.task.id));
        const edit = { ...newInput, apiKey: "", revision: 1, enabled: false };
        const original = globalThis.fetch;
        globalThis.fetch = (async () => { throw new Error("Synthetic upstream unavailable"); }) as typeof fetch;
        try {
            for (const change of [{ displayName: "Changed" }, { apiKey: "rotated" }, { endpoint: "https://changed.example/v1" }, { adapter: "sub2api" }, { enabled: true }]) {
                expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...edit, ...change })).status).toBe(409);
            }
            const saved = await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", edit);
            expect(saved.status).toBe(200);
            expect((await saved.json()).provider).toMatchObject({ enabled: false, revision: 2, removedModelIds: [] });
            expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", edit)).status).toBe(409);
            expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...edit, revision: 2, enabled: true })).status).toBe(409);
        } finally { globalThis.fetch = original; }
        expect(await database.db.select().from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, id))).toEqual(inventory);
        expect(await database.db.select().from(generationTask).where(eq(generationTask.id, task.task.id))).toEqual(beforeTask);
        await expect(resolveGenerationQuote(database.db, { modelId: "offline-image", quotedUnits: 3 })).rejects.toThrow("模型价格不可用");
        expect((await (await request("/api/v1/models", userCookie)).json()).items.some((row: any) => row.id === "offline-image")).toBe(false);
    });

    test("confirmed empty directory clears inventory and retires node models while preserving prices", async () => {
        const id = "empty-directory-channel";
        const initial = await discover(id, newInput, ["empty-test"]);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...newInput, discoveryReceiptId: initial.receiptId })).status).toBe(200);
        expect((await request("/api/v1/admin/models/empty-directory-node", adminCookie, "PUT", { providerId: id, providerModel: "empty-test", displayName: "空目录测试", capability: "image", enabled: true, groupId: null, revision: 0 })).status).toBe(200);
        const [provider] = await database.db.select().from(modelProvider).where(eq(modelProvider.id, id));
        const beforeModels = await database.db.select().from(modelCatalog).where(eq(modelCatalog.providerId, id));
        await database.db.insert(modelPricing).values({ id: "price-empty-history", modelId: beforeModels[0]!.id, version: 1, billingUnit: "request", creditsPerUnit: 4, effectiveFrom: new Date(), enabled: true });
        const beforePrices = await database.db.select().from(modelPricing);
        const input = { displayName: provider!.displayName, adapter: provider!.adapter, endpoint: provider!.endpoint, enabled: provider!.enabled, revision: provider!.revision };
        const read = await discover(id, input, []);
        expect(read.models).toEqual([]);
        expect(read.missing).toEqual(["empty-test"]);
        expect(read.bindings.find((row: any) => row.id === "empty-directory-node")).toMatchObject({ found: false });
        const saved = await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...input, discoveryReceiptId: read.receiptId });
        expect(saved.status).toBe(200);
        expect((await saved.json()).provider.removedModelIds).toEqual(["empty-directory-node"]);
        const models = (await (await request("/api/v1/admin/provider-models", adminCookie)).json()).models.filter((row: any) => row.providerId === id);
        expect(models).toEqual([]);
        const afterModels = await database.db.select().from(modelCatalog).where(eq(modelCatalog.providerId, id));
        expect(afterModels[0]).toMatchObject({ id: beforeModels[0]!.id, enabled: false, revision: beforeModels[0]!.revision + 1, deletedAt: expect.any(Date) });
        expect((await (await request("/api/v1/admin/models", adminCookie)).json()).items.some((row: any) => row.id === "empty-directory-node")).toBe(false);
        expect(await database.db.select().from(modelPricing)).toEqual(beforePrices);
    });

    test("receipt is account and session bound and expires with the creating session", async () => {
        const id = "session-bound";
        const read = await discover(id, newInput, ["same-model"]);
        const write = { ...newInput, discoveryReceiptId: read.receiptId };
        await database.db.update(user).set({ role: "admin" }).where(eq(user.id, userId));
        try { expect((await request(`/api/v1/admin/providers/${id}`, userCookie, "PUT", write)).status).toBe(409); }
        finally { await database.db.update(user).set({ role: "user" }).where(eq(user.id, userId)); }
        const signedIn = await app(new Request(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ email: "catalog-user@example.test", password }) }), "198.51.100.17");
        expect(signedIn.status).toBe(200);
        const otherSession = await app(new Request(`${origin}/api/v1/admin/providers/${id}`, { method: "PUT",
            headers: { origin, cookie: cookies(signedIn), "content-type": "application/json", "x-canvas-account-id": adminId }, body: JSON.stringify(write) }), "198.51.100.17");
        expect(otherSession.status).toBe(409);
        await database.db.update(providerDiscoveryReceipt).set({ expiresAt: new Date(0) }).where(eq(providerDiscoveryReceipt.id, read.receiptId));
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", write)).status).toBe(409);
        const fresh = await discover(id, newInput, ["same-model"]);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...newInput, discoveryReceiptId: fresh.receiptId })).status).toBe(200);
    });

    test("revoking a session during discovery prevents a late result from issuing a receipt", async () => {
        const beforeSessions = new Set((await database.db.select({ id: authSession.id }).from(authSession)).map(row => row.id));
        const signedIn = await app(new Request(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ email: "catalog-user@example.test", password }) }), "198.51.100.17");
        expect(signedIn.status).toBe(200);
        const created = (await database.db.select({ id: authSession.id }).from(authSession)).find(row => !beforeSessions.has(row.id));
        expect(created).toBeDefined();
        const original = globalThis.fetch;
        let entered!: () => void, finish!: (response: Response) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        globalThis.fetch = (async () => { entered(); return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
        try {
            const pending = app(new Request(`${origin}/api/v1/admin/providers/revoked-session/discover`, { method: "POST",
                headers: { origin, cookie: cookies(signedIn), "content-type": "application/json", "x-canvas-account-id": adminId }, body: JSON.stringify(newInput) }), "198.51.100.17");
            await started;
            await database.db.delete(authSession).where(eq(authSession.id, created!.id));
            finish(Response.json({ data: [{ id: "late-model" }] }));
            const response = await pending;
            expect(response.status).toBe(409);
            expect((await response.json()).error.code).toBe("account_changed");
            expect(await database.db.select().from(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.providerId, "revoked-session"))).toHaveLength(0);
        } finally { globalThis.fetch = original; }
    });

    test("failed reads preserve state and late network completions cannot issue usable evidence after a save", async () => {
        const id = "session-bound", input = { ...newInput, apiKey: "", revision: 1 };
        const original = globalThis.fetch;
        const before = await database.db.select().from(providerDiscoveryReceipt);
        globalThis.fetch = (async () => new Response("private upstream text", { status: 401 })) as typeof fetch;
        try {
            const failed = await request(`/api/v1/admin/providers/${id}/discover`, adminCookie, "POST", input);
            expect(failed.status).toBe(502);
            expect(JSON.stringify(await failed.json())).not.toContain("private upstream text");
            expect(await database.db.select().from(providerDiscoveryReceipt)).toEqual(before);
        } finally { globalThis.fetch = original; }
        const checked = await discover(id, input, ["same-model"]);
        let entered!: () => void, finish!: (response: Response) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        globalThis.fetch = (async () => { entered(); return new Promise<Response>(resolve => { finish = resolve; }); }) as typeof fetch;
        try {
            const pending = request(`/api/v1/admin/providers/${id}/discover`, adminCookie, "POST", input);
            await started;
            expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { ...input, displayName: "更新后的名字", discoveryReceiptId: checked.receiptId })).status).toBe(200);
            finish(Response.json({ data: [{ id: "late-model" }] }));
            expect((await pending).status).toBe(409);
            expect(await database.db.select().from(providerDiscoveryReceipt)).toEqual(before);
        } finally { globalThis.fetch = original; }
    });
});

describe("node model groups and assignment", () => {
    const first = { id: crypto.randomUUID(), name: "GPT" }, second = { id: crypto.randomUUID(), name: "其他文本" };
    const input = { providerId: "provider-openai-main", providerModel: "grouped-text", displayName: "分组文本", capability: "text" as const, enabled: true, groupId: first.id, revision: 0 };

    test("group reads and writes require an administrator and bound account", async () => {
        expect((await request("/api/v1/admin/model-groups")).status).toBe(401);
        expect((await request("/api/v1/admin/model-groups", userCookie)).status).toBe(403);
        const response = await request("/api/v1/admin/model-groups", adminCookie);
        expect(response.status).toBe(200);
        expect((await response.json()).items).toEqual(["text", "image", "video", "audio"].map(capability => ({ capability, version: 0, groups: [] })));
        const wrongAccount = await app(new Request(`${origin}/api/v1/admin/model-groups`, { method: "PUT", headers: { origin, cookie: adminCookie, "content-type": "application/json", "x-canvas-account-id": userId },
            body: JSON.stringify({ capability: "text", expectedVersion: 0, groups: [first] }) }), "198.51.100.17");
        expect(wrongAccount.status).toBe(409);
    });

    test("group creation, ordering and CAS preserve the winning document", async () => {
        const saved = await request("/api/v1/admin/model-groups", adminCookie, "PUT", { capability: "text", expectedVersion: 0, groups: [first, second] });
        expect(saved.status).toBe(200);
        expect((await saved.json()).item).toEqual({ capability: "text", version: 1, groups: [first, second] });
        const stale = await request("/api/v1/admin/model-groups", adminCookie, "PUT", { capability: "text", expectedVersion: 0, groups: [second] });
        expect(stale.status).toBe(409);
        expect((await stale.json()).error.code).toBe("model_group_conflict");
        const duplicate = await request("/api/v1/admin/model-groups", adminCookie, "PUT", { capability: "text", expectedVersion: 1, groups: [first, first] });
        expect(duplicate.status).toBe(400);
    });

    test("model assignment requires matching group type and model revision", async () => {
        await database.db.insert(providerDiscoveredModel).values({ providerId: input.providerId, providerModel: input.providerModel, available: true, firstSeenAt: new Date(), lastSeenAt: new Date() });
        expect((await request("/api/v1/admin/models/grouped-text", adminCookie, "PUT", { ...input, capability: "video" })).status).toBe(400);
        expect((await request("/api/v1/admin/models/grouped-text", adminCookie, "PUT", { ...input, revision: undefined })).status).toBe(400);
        const response = await request("/api/v1/admin/models/grouped-text", adminCookie, "PUT", input);
        expect(response.status).toBe(200);
        expect((await response.json()).model).toMatchObject({ id: "grouped-text", groupId: first.id, revision: 1, group: { ...first, order: 0 }, providerDisplayName: "OpenAI 主线路", secretRefConfigured: true });
        const stale = await request("/api/v1/admin/models/grouped-text", adminCookie, "PUT", input);
        expect(stale.status).toBe(409);
        expect((await stale.json()).error.code).toBe("model_revision_conflict");
    });

    test("renaming and reordering groups changes only safe public presentation", async () => {
        const prices = await database.db.select().from(modelPricing);
        const renamed = { ...first, name: "GPT 文本" };
        expect((await request("/api/v1/admin/model-groups", adminCookie, "PUT", { capability: "text", expectedVersion: 1, groups: [second, renamed] })).status).toBe(200);
        const response = await request("/api/v1/models", userCookie), body = await response.json();
        const model = body.items.find((item: any) => item.id === "grouped-text");
        expect(model).toEqual({ id: "grouped-text", displayName: "分组文本", capability: "text", group: { ...renamed, order: 1 } });
        expect(JSON.stringify(body)).not.toContain("providerId");
        expect(JSON.stringify(body)).not.toContain("providerModel");
        expect(JSON.stringify(body)).not.toContain("revision");
        expect(await database.db.select().from(modelPricing)).toEqual(prices);
    });

    test("referenced groups cannot be removed and priced model capability cannot be reassigned", async () => {
        const removed = await request("/api/v1/admin/model-groups", adminCookie, "PUT", { capability: "text", expectedVersion: 2, groups: [second] });
        expect(removed.status).toBe(409);
        expect((await removed.json()).error.code).toBe("model_group_in_use");
        const prices = await database.db.select().from(modelPricing);
        const changed = await request("/api/v1/admin/models/platform-text", adminCookie, "PUT", { providerId: "provider-openai-main", providerModel: "gpt-test", displayName: "平台文本模型 2", capability: "video", enabled: true, groupId: null, revision: 2 });
        expect(changed.status).toBe(409);
        expect((await changed.json()).error.code).toBe("model_pricing_binding_conflict");
        expect(await database.db.select().from(modelPricing)).toEqual(prices);
        const assigned = await request("/api/v1/admin/models/platform-text", adminCookie, "PUT", { providerId: "provider-openai-main", providerModel: "gpt-test", displayName: "平台文本模型 2", capability: "text", enabled: true, groupId: second.id, revision: 2 });
        expect(assigned.status).toBe(200);
        expect((await assigned.json()).model).toMatchObject({ revision: 3, groupId: second.id });
        expect(await database.db.select().from(modelPricing)).toEqual(prices);
    });

    test("repository rechecks revoked sessions before any configuration commit", async () => {
        const [current] = await database.db.select().from(authSession).where(eq(authSession.userId, adminId));
        const actor = { actorId: adminId, sessionId: crypto.randomUUID(), sessionExpiresAt: current!.expiresAt, requestId: crypto.randomUUID() };
        const beforeAudit = await database.db.select().from(auditEvent);
        await expect(saveNodeModelGroups(database.db as any, { capability: "video", expectedVersion: 0, groups: [] }, actor)).rejects.toMatchObject({ code: "account_changed" });
        await expect(saveNodeModel(database.db as any, "revoked-model", { ...input, groupId: null }, actor)).rejects.toMatchObject({ code: "account_changed" });
        expect(await database.db.select().from(modelCatalog).where(eq(modelCatalog.publicId, "revoked-model"))).toHaveLength(0);
        expect(await database.db.select().from(auditEvent)).toEqual(beforeAudit);
    });

    test("CATALOG-03 audio groups can be saved, assigned, ordered and read without repricing", async () => {
        const path = "/api/v1/admin/model-groups", modelPath = "/api/v1/admin/models/grouped-tts";
        const tts = { id: crypto.randomUUID(), name: "语音合成" }, other = { id: crypto.randomUUID(), name: "其他音频" };
        const write = (expectedVersion: number, groups = [tts, other]) => ({ capability: "audio", expectedVersion, groups });
        const model = { ...input, providerModel: "grouped-tts", displayName: "分组语音", capability: "audio", groupId: tts.id, revision: 1 };
        await database.db.insert(modelCatalog).values({ id: "existing-grouped-tts", publicId: "grouped-tts", providerId: model.providerId,
            providerModel: model.providerModel, displayName: model.displayName, capability: "audio", enabled: true });
        await database.db.insert(modelPricing).values({ id: "price-grouped-tts", modelId: "existing-grouped-tts", version: 1, billingUnit: "request",
            creditsPerUnit: 3, effectiveFrom: new Date("2026-01-01T00:00:00Z"), enabled: true });
        const beforePrices = await database.db.select().from(modelPricing);
        const docs = async () => (await (await request(path, adminCookie)).json()).items;
        const beforeOthers = (await docs()).filter((row: { capability: string }) => row.capability !== "audio");
        // Use an independently seeded text group so this case also runs alone.
        const text = beforeOthers.find((row: { capability: string }) => row.capability === "text");
        const textGroup = { id: crypto.randomUUID(), name: "其他类型测试组" };
        expect((await request(path, adminCookie, "PUT", { capability: "text", expectedVersion: text.version, groups: [...text.groups, textGroup] })).status).toBe(200);
        const textAfterSeed = (await docs()).filter((row: { capability: string }) => row.capability !== "audio");
        expect((await request(path, userCookie, "PUT", write(0))).status).toBe(403);
        const created = await request(path, adminCookie, "PUT", write(0));
        expect(created.status).toBe(200);
        expect((await created.json()).item).toEqual({ capability: "audio", version: 1, groups: [tts, other] });

        const wrongGroup = await request(modelPath, adminCookie, "PUT", { ...model, groupId: textGroup.id });
        expect(wrongGroup.status).toBe(400);
        expect((await wrongGroup.json()).error.code).toBe("model_group_invalid");
        const saved = await request(modelPath, adminCookie, "PUT", model);
        expect(saved.status).toBe(200);
        expect((await saved.json()).model).toMatchObject({ groupId: tts.id, group: { ...tts, order: 0 }, revision: 2 });

        const renamed = { ...tts, name: "文字转语音" };
        expect((await request(path, adminCookie, "PUT", write(1, [other, renamed]))).status).toBe(200);
        const stale = await request(path, adminCookie, "PUT", write(1));
        expect(stale.status).toBe(409);
        expect((await stale.json()).error.code).toBe("model_group_conflict");
        const inUse = await request(path, adminCookie, "PUT", write(2, [other]));
        expect(inUse.status).toBe(409);
        expect((await inUse.json()).error.code).toBe("model_group_in_use");
        const read = await docs();
        expect(read.find((row: { capability: string }) => row.capability === "audio")).toEqual({ capability: "audio", version: 2, groups: [other, renamed] });
        expect(read.filter((row: { capability: string }) => row.capability !== "audio")).toEqual(textAfterSeed);
        const publicModel = (await (await request("/api/v1/models", userCookie)).json()).items.find((row: { id: string }) => row.id === "grouped-tts");
        expect(publicModel).toEqual({ id: "grouped-tts", displayName: model.displayName, capability: "audio", group: { ...renamed, order: 1 } });

        expect((await request(path, adminCookie, "PUT", write(2, [renamed]))).status).toBe(200);
        expect((await docs()).find((row: { capability: string }) => row.capability === "audio")).toEqual({ capability: "audio", version: 3, groups: [renamed] });
        expect(await database.db.select().from(modelPricing)).toEqual(beforePrices);
        const audit = await database.db.select().from(auditEvent).where(eq(auditEvent.resourceId, "audio"));
        expect(audit.map(row => [row.action, row.actorId, row.revision]).sort((a, b) => Number(a[2]) - Number(b[2]))).toEqual(
            [1, 2, 3].map(revision => ["model.groups.saved", adminId, revision]));
    });
});

describe("catalog deletion preserves historical data", () => {
    async function seed(label: string, count = 1, groupId: string | null = null) {
        const id = `deletion-${label}`;
        await database.db.insert(modelProvider).values({ id, displayName: label, adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", secretRef: "synthetic-only", enabled: true });
        await database.db.insert(modelProviderCredential).values({ providerId: id, ciphertext: "synthetic", nonce: "0".repeat(24), authTag: "0".repeat(32) });
        const models = Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, publicId: `${id}-${index}`, providerId: id, providerModel: `upstream-${index}`,
            displayName: `${label} ${index}`, capability: "image" as const, enabled: true, groupId }));
        await database.db.insert(modelCatalog).values(models);
        await database.db.insert(providerDiscoveredModel).values(models.map(model => ({ providerId: id, providerModel: model.providerModel })));
        await database.db.insert(modelPricing).values(models.map(model => ({ id: `${model.id}-price`, modelId: model.id, version: 1, billingUnit: "request" as const, creditsPerUnit: 3,
            effectiveFrom: new Date("2026-01-01T00:00:00Z"), enabled: true })));
        return { id, models };
    }

    test("delete requires an active admin, trusted origin, matching account and current revision", async () => {
        const { id, models } = await seed("guards");
        const path = `/api/v1/admin/providers/${id}`;
        expect((await request(path, "", "DELETE", { revision: 1 })).status).toBe(401);
        expect((await request(path, userCookie, "DELETE", { revision: 1 })).status).toBe(403);
        for (const [headers, status] of [[{ origin: "https://untrusted.invalid", "x-canvas-account-id": adminId }, 403], [{ origin }, 400], [{ origin, "x-canvas-account-id": userId }, 409]] as const) {
            expect((await app(new Request(`${origin}${path}`, { method: "DELETE", headers: { ...headers, cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ revision: 1 }) }), "198.51.100.17")).status).toBe(status);
        }
        expect((await request(path, adminCookie, "DELETE", { revision: 0 })).status).toBe(400);
        expect((await request(path, adminCookie, "DELETE", { revision: 2 })).status).toBe(409);
        expect((await request(`/api/v1/admin/models/${models[0].publicId}`, userCookie, "DELETE", { revision: 1 })).status).toBe(403);
        const actor = { actorId: adminId, sessionId: "revoked-session", sessionExpiresAt: new Date(Date.now() + 60_000), requestId: "deletion-test" };
        await expect(deleteCatalogProvider(database.db as any, id, 1, actor)).rejects.toMatchObject({ code: "account_changed" });
        await expect(deleteCatalogModel(database.db as any, models[0].publicId, 1, actor)).rejects.toMatchObject({ code: "account_changed" });
        expect((await database.db.select().from(modelProvider).where(eq(modelProvider.id, id)))[0]).toMatchObject({ revision: 1, enabled: true, deletedAt: null });
    });

    test("unfinished execution, delivery or billing blocks both model and cascading channel deletion", async () => {
        const { id, models } = await seed("unfinished");
        const tasks = createGenerationTaskRepository(database.db as any), modelId = models[0].publicId;
        const { task } = await tasks.create({ ownerId: userId, modelId, inputSnapshot: { prompt: "Synthetic" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: "deletion-test" });
        const states = [
            { executionStatus: "queued", deliveryStatus: "pending", billingStatus: "unbilled" },
            { executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved" },
            { executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review", unknownReason: "synthetic" },
            { executionStatus: "succeeded", deliveryStatus: "pending", billingStatus: "captured" },
            { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "reserved" },
        ] as const;
        for (const state of states) {
            await database.db.update(generationTask).set(state).where(eq(generationTask.id, task.id));
            for (const path of [`/api/v1/admin/providers/${id}`, `/api/v1/admin/models/${modelId}`]) {
                const response = await request(path, adminCookie, "DELETE", { revision: 1 });
                expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("catalog_in_use");
            }
        }
        expect((await database.db.select().from(modelCatalog).where(eq(modelCatalog.publicId, modelId)))[0].deletedAt).toBeNull();
        expect(await database.db.select().from(modelProviderCredential).where(eq(modelProviderCredential.providerId, id))).toHaveLength(1);
        await database.db.update(generationTask).set({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" }).where(eq(generationTask.id, task.id));
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "DELETE", { revision: 1 })).status).toBe(200);
        expect(await tasks.get(userId, task.id)).not.toBeNull();
    });

    test("model deletion retains prices and finished tasks, rejects resurrection and releases group membership", async () => {
        const group = { id: crypto.randomUUID(), name: "待删除分组" };
        const documents = (await (await request("/api/v1/admin/model-groups", adminCookie)).json()).items;
        const image = documents.find((row: any) => row.capability === "image");
        expect((await request("/api/v1/admin/model-groups", adminCookie, "PUT", { capability: "image", expectedVersion: image.version, groups: [...image.groups, group] })).status).toBe(200);
        const { id, models } = await seed("model", 1, group.id), modelId = models[0].publicId;
        const tasks = createGenerationTaskRepository(database.db as any);
        const intent = { ownerId: userId, modelId, inputSnapshot: { prompt: "Historical" }, parameterSnapshot: {}, idempotencyKey: crypto.randomUUID(), requestId: "history-test" };
        const { task } = await tasks.create(intent);
        await database.db.update(generationTask).set({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released" }).where(eq(generationTask.id, task.id));
        const before = await tasks.get(userId, task.id), prices = await database.db.select().from(modelPricing).where(eq(modelPricing.modelId, models[0].id));
        const removal = { capability: "image", expectedVersion: image.version + 1, groups: image.groups };
        expect((await request("/api/v1/admin/model-groups", adminCookie, "PUT", removal)).status).toBe(409);
        const response = await request(`/api/v1/admin/models/${modelId}`, adminCookie, "DELETE", { revision: 1 });
        expect(response.status).toBe(200); expect((await response.json()).deleted).toEqual({ id: modelId, revision: 2, modelIds: [modelId] });
        expect(await tasks.get(userId, task.id)).toEqual(before);
        expect((await tasks.create(intent)).created).toBe(false);
        await expect(tasks.create({ ...intent, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "model_unavailable" });
        expect(await database.db.select().from(modelPricing).where(eq(modelPricing.modelId, models[0].id))).toEqual(prices);
        const publicRows = (await (await request("/api/v1/models", userCookie)).json()).items;
        expect(publicRows.some((row: any) => row.id === modelId)).toBe(false);
        const adminRows = (await (await request("/api/v1/admin/models", adminCookie)).json()).items;
        expect(adminRows.some((row: any) => row.id === modelId)).toBe(false);
        const history = (await (await request("/api/v1/admin/model-pricing", adminCookie)).json()).items;
        expect(history.find((row: any) => row.modelId === modelId).deleted).toBe(true);
        const library = (await (await request("/api/v1/admin/provider-models", adminCookie)).json()).models;
        expect(library.find((row: any) => row.providerId === id).boundModelId).toBeNull();
        const body = { providerId: id, providerModel: "upstream-0", displayName: "不能复活", capability: "image", groupId: null, enabled: true, revision: 2 };
        expect((await request(`/api/v1/admin/models/${modelId}`, adminCookie, "PUT", body)).status).toBe(409);
        expect((await request(`/api/v1/admin/models/${modelId}-new`, adminCookie, "PUT", { ...body, revision: 0 })).status).toBe(200);
        expect((await request("/api/v1/admin/model-groups", adminCookie, "PUT", removal)).status).toBe(200);
    });

    test("channel deletion removes all node types and inventory together, keeps other channels and history", async () => {
        const { id, models } = await seed("cascade", 2), other = await seed("unaffected");
        await database.db.update(modelCatalog).set({ capability: "text", enabled: false }).where(eq(modelCatalog.id, models[1].id));
        const beforePrices = await database.db.select().from(modelPricing);
        const response = await request(`/api/v1/admin/providers/${id}`, adminCookie, "DELETE", { revision: 1 });
        expect(response.status).toBe(200);
        expect((await response.json()).deleted).toEqual({ id, revision: 2, modelIds: models.map(row => row.publicId) });
        const providers = (await (await request("/api/v1/admin/providers", adminCookie)).json()).items;
        expect(providers.some((row: any) => row.id === id)).toBe(false); expect(providers.some((row: any) => row.id === other.id)).toBe(true);
        const configured = (await (await request("/api/v1/admin/models", adminCookie)).json()).items;
        expect(configured.some((row: any) => row.providerId === id)).toBe(false);
        expect(configured.some((row: any) => row.providerId === other.id)).toBe(true);
        const drafts = (await (await request("/api/v1/admin/model-price-drafts", adminCookie)).json()).models;
        expect(drafts.some((row: any) => models.some(model => model.publicId === row.modelId))).toBe(false);
        expect(await database.db.select().from(modelProviderCredential).where(eq(modelProviderCredential.providerId, id))).toHaveLength(0);
        expect(await database.db.select().from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, id))).toHaveLength(0);
        expect(await database.db.select().from(modelPricing)).toEqual(beforePrices);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "DELETE", { revision: 1 })).status).toBe(404);
        expect((await request(`/api/v1/admin/providers/${id}`, adminCookie, "PUT", { revision: 2, displayName: "旧输入", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", enabled: true })).status).toBe(409);
        expect((await request(`/api/v1/admin/providers/${id}/discover`, adminCookie, "POST", { revision: 2, displayName: "旧输入", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", enabled: true, apiKey: "synthetic" })).status).toBe(409);
        const input = { providerId: id, providerModel: "upstream-0", displayName: "旧模型", capability: "image", groupId: null, enabled: true, revision: 1 };
        expect((await request(`/api/v1/admin/models/${models[0].publicId}`, adminCookie, "PUT", input)).status).toBe(400);
    });
});
