import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { AdminModelPriceDraft, AdminModelPriceDraftCatalog, ModelPriceDraftWrite, ModelPriceRules, PricingCapability } from "@infinite-canvas/shared";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { resolveActiveGenerationPricing } from "@infinite-canvas/database/pricing";
import { auditEvent, cnyPriceDraft, generationTask, modelCatalog, modelPriceDraft, modelPricing, modelProvider, modelProviderCredential, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

if (process.env.SAAS_TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error("Only in-memory PGlite is permitted");
const origin = "http://localhost:4032";
const path = "/api/v1/admin/model-price-drafts";
const secret = "price-drafts-synthetic-" + crypto.randomUUID();
const password = "price-drafts-synthetic-password";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let admin = { id: "", cookie: "" };
let regular = { id: "", cookie: "" };
let rejectAccountRate = false;
let queueCalls = 0;
const accountRateBuckets: string[] = [];

function request(url = path, session = admin, method = "GET", body?: unknown, extra: HeadersInit = {}) {
    const headers = new Headers({ origin, cookie: session.cookie, "x-canvas-account-id": session.id, "content-type": "application/json" });
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return app(new Request(`${origin}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "198.51.100.32");
}

async function register(email: string) {
    expect((await request("/api/auth/sign-up/email", { id: "", cookie: "" }, "POST", { email, password, name: "Synthetic price user" })).status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const signin = await request("/api/auth/sign-in/email", { id: "", cookie: "" }, "POST", { email, password });
    expect(signin.status).toBe(200);
    return { id: row!.id, cookie: signin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
}

function rulesFor(capability: PricingCapability): ModelPriceRules {
    if (capability === "text") return { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "1.25", output_token: "3.5" } }] } };
    if (capability === "video") return { schemaVersion: 1, cost: null, sale: { template: "video_second", currency: "credit", bands: [{ parameters: { resolution: "720p" }, rates: { second: "0.3" } }] } };
    return { schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "0.3" } }] } };
}

async function seedModel(suffix: string, capability: PricingCapability = "image", enabled = false): Promise<ModelPriceDraftWrite> {
    const providerId = `provider-${suffix}`, modelId = `model-${suffix}`;
    await database.db.insert(modelProvider).values({
        id: providerId, displayName: `Synthetic ${suffix}`, adapter: "openai-compatible",
        endpoint: "https://provider.invalid/v1", secretRef: "synthetic-private-reference", enabled,
    });
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "synthetic-private-ciphertext", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({
        id: modelId, publicId: modelId, providerId, providerModel: `synthetic-${capability}`, displayName: `Synthetic ${suffix}`, capability, enabled,
    });
    return {
        modelId, expectedVersion: 0,
        binding: { providerId, providerModel: `synthetic-${capability}`, adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability },
        rules: rulesFor(capability), priceNote: "管理员草稿；不改变当前收费",
    };
}

async function readDrafts(): Promise<AdminModelPriceDraftCatalog> {
    const response = await request();
    expect(response.status).toBe(200);
    return response.json();
}

beforeAll(async () => {
    database = await createTestDatabase();
    const authRates = createRateStore(database.pool, secret);
    app = createApp(createAccountApi({
        database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) {
            if (bucket === "account-read" || bucket === "canvas-save") {
                accountRateBuckets.push(bucket);
                return rejectAccountRate ? { allowed: false, retryAfter: 1 } : { allowed: true };
            }
            return authRates.consume(bucket, identity, rule);
        } },
        verifyHuman: async () => true,
        generation: { enabled: false, queue: { async send() { queueCalls++; throw new Error("queue must not be called"); } } },
        onFault: () => undefined,
    }), "synthetic-price-site-key");
    admin = await register("price-admin@example.test");
    regular = await register("price-user@example.test");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
});
afterAll(async () => { await database?.close(); });

test("generic drafts list four capabilities while leaving legacy CNY, credit, wallet, task and public state unchanged", async () => {
    const input = await seedModel("isolation", "image", true);
    const text = await seedModel("disabled-text", "text"), video = await seedModel("disabled-video", "video");
    const audio = await seedModel("audio");
    await database.db.update(modelCatalog).set({ capability: "audio" }).where(eq(modelCatalog.id, audio.modelId));
    await database.db.insert(cnyPriceDraft).values({
        id: "synthetic-old-cny", modelId: input.modelId, version: 1, saleAmount: "123", costAmount: "12", priceNote: "historical CNY draft",
        providerIdSnapshot: input.binding.providerId, providerModelSnapshot: input.binding.providerModel,
        adapterSnapshot: input.binding.adapter, endpointSnapshot: input.binding.endpoint,
    });
    await database.db.insert(modelPricing).values({ id: "synthetic-credit-price", modelId: input.modelId, version: 1, billingUnit: "request", creditsPerUnit: 7, effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), enabled: true });
    await database.db.insert(wallet).values({ userId: regular.id, availableUnits: "7" });
    await database.db.insert(generationTask).values({
        id: crypto.randomUUID(), ownerId: regular.id, modelId: input.modelId, inputSnapshot: { prompt: "synthetic-private-prompt" }, parameterSnapshot: {},
        idempotencyKey: "synthetic-private-key", requestId: "synthetic-original-request", priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
    });
    const snapshot = () => Promise.all([
        database.db.select().from(cnyPriceDraft), database.db.select().from(modelPricing), database.db.select().from(wallet), database.db.select().from(walletLedger),
        database.db.select().from(walletReservation), database.db.select().from(generationTask), database.db.select().from(modelProviderCredential),
    ]);
    const before = await snapshot();
    const publicBefore = await (await request("/api/v1/models", regular)).json();
    const pricesBefore = await (await request("/api/v1/model-pricing", regular)).json();
    const quoteBefore = await resolveActiveGenerationPricing(database.db, { modelId: input.modelId });
    expect((await readDrafts()).items).toHaveLength(0);
    expect((await request(path, admin, "POST", input)).status).toBe(201);
    const response = await request();
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as AdminModelPriceDraftCatalog;
    expect(body.models.map((model) => model.modelId)).toContain(text.modelId);
    expect(body.models.map((model) => model.modelId)).toContain(video.modelId);
    expect(body.models.map((model) => model.modelId)).toContain(audio.modelId);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].rules).toEqual(input.rules);
    expect(JSON.stringify(body)).not.toContain("synthetic-private-");
    expect(JSON.stringify(body)).not.toContain("historical CNY");
    expect(await snapshot()).toEqual(before);
    expect((await (await request("/api/v1/models", regular)).json()).items).toEqual(publicBefore.items);
    expect((await (await request("/api/v1/model-pricing", regular)).json()).items).toEqual(pricesBefore.items);
    expect(await resolveActiveGenerationPricing(database.db, { modelId: input.modelId })).toEqual(quoteBefore);
    expect((await request("/api/v1/generation/models")).status).toBe(503);
    expect(queueCalls).toBe(0);
    expect((await request(path, admin, "POST", { modelId: input.modelId, expectedVersion: 1, binding: input.binding, costAmount: null, saleAmount: "1", priceNote: "retired contract" })).status).toBe(400);
});

test("real authenticated handler enforces admin, account context, source, method and rate gates", async () => {
    const input = await seedModel("permissions");
    for (const [session, headers, status, code] of [
        [{ id: "", cookie: "" }, {}, 401, "unauthorized"], [regular, {}, 403, "forbidden"],
        [admin, { "x-canvas-account-id": "" }, 400, "account_context_required"], [admin, { "x-canvas-account-id": regular.id }, 409, "account_changed"],
        [admin, { origin: "http://untrusted.invalid" }, 403, "invalid_origin"],
    ] as const) {
        for (const method of ["GET", "POST"]) {
            const response = await request(path, session, method, method === "POST" ? input : undefined, headers);
            expect(response.status).toBe(status);
            expect((await response.json()).error.code).toBe(code);
        }
    }
    expect((await request(path, admin, "PUT", input)).status).toBe(405);
    rejectAccountRate = true;
    try { expect((await request()).status).toBe(429); expect((await request(path, admin, "POST", input)).status).toBe(429); }
    finally { rejectAccountRate = false; }
    expect(accountRateBuckets).toContain("account-read");
    expect(accountRateBuckets).toContain("canvas-save");
});

test("a text version retains both meters, image and video costs use independent units, and null stays distinct from zero", async () => {
    const text = await seedModel("text-rules", "text");
    text.rules.cost = { template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: null, output_token: "0" } }] };
    const image = await seedModel("image-rules");
    image.rules.cost = { template: "image_tokens", currency: "CNY", bands: [{ parameters: {}, rates: { input_token: "0.2", output_token: "0.5", image_input_token: "2", image_output_token: "8" } }] };
    image.rules.sale = { template: "image_count", currency: "credit", bands: [{ parameters: { size: "1024x1024" }, rates: { image: "1" } }, { parameters: { size: "1536x1024" }, rates: { image: "1.5" } }] };
    const video = await seedModel("video-rules", "video");
    video.rules.cost = { template: "video_second", currency: "USD", bands: [{ parameters: { resolution: "720p" }, rates: { second: "0.03" } }] };
    video.rules.sale = { template: "video_count", currency: "credit", bands: [{ parameters: { resolution: "720p", durationSeconds: "5" }, rates: { video: "5" } }, { parameters: { resolution: "1080p", durationSeconds: "10" }, rates: { video: "12" } }] };
    for (const input of [text, image, video]) {
        const response = await request(path, admin, "POST", input);
        expect(response.status).toBe(201);
        const saved = (await response.json()).draft as AdminModelPriceDraft;
        expect(saved.rules).toEqual(input.rules);
        expect((await readDrafts()).items.find((item) => item.id === saved.id)).toEqual(saved);
        expect(Object.hasOwn(saved, "estimatedGrossMargin")).toBe(false);
    }
});

test("decimal prices round-trip without floating point or rounding and reject invalid values", async () => {
    const input = await seedModel("exact");
    const savePrice = (value: unknown, version = 0) => request(path, admin, "POST", { ...input, expectedVersion: version, rules: { ...input.rules, sale: { ...input.rules.sale, bands: [{ parameters: {}, rates: { request: value } }] } } });
    const exact = "9007199254740993.00000000000000000001";
    const first = await savePrice(exact + "00");
    expect(first.status).toBe(201);
    expect((await first.json()).draft.rules.sale.bands[0].rates.request).toBe(exact);
    const maximumScale = "0." + "0".repeat(16382) + "1";
    const second = await savePrice(maximumScale + "0", 1);
    expect(second.status).toBe(201);
    expect((await second.json()).draft.rules.sale.bands[0].rates.request).toBe(maximumScale);
    for (const value of [0.3, "1e-3", "NaN", "Infinity", "-0.1", "01.2", " 0.3", "0.3\n", "0.3\r\n", ".3", "", null, maximumScale + "1", "1".repeat(131073)]) {
        const response = await savePrice(value, 2);
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("invalid_input");
    }
    expect((await readDrafts()).items.find((item) => item.modelId === input.modelId)?.version).toBe(2);
});

test("strict nested rule contracts reject extras, mismatched templates, missing meters and overlapping bands", async () => {
    const input = await seedModel("invalid"), sale = input.rules.sale;
    const invalid: unknown[] = [
        { ...input, extra: true }, { ...input, expectedVersion: -1 }, { ...input, binding: { ...input.binding, secret: "synthetic-hidden" } },
        { ...input, binding: { ...input.binding, endpoint: "https://127.0.0.1/v1" } },
        { ...input, rules: { ...input.rules, extra: true } }, { ...input, rules: { ...input.rules, schemaVersion: 2 } },
        { ...input, rules: { ...input.rules, sale: { ...sale, extra: true } } },
        { ...input, rules: { ...input.rules, sale: { ...sale, currency: "CNY" } } },
        { ...input, rules: { ...input.rules, cost: { ...sale, currency: "credit" } } },
        { ...input, rules: { ...input.rules, sale: rulesFor("text").sale } },
        ...[
            [], [{ parameters: {}, rates: {} }], [{ parameters: {}, rates: { request: "1", image: "2" } }],
            [{ parameters: {}, rates: { request: "1" }, extra: true }], [{ parameters: { secret: "hidden" }, rates: { request: "1" } }],
            [{ parameters: {}, rates: { request: "1" } }, { parameters: { size: "1024x1024" }, rates: { request: "2" } }],
        ].map((bands) => ({ ...input, rules: { ...input.rules, sale: { ...sale, bands } } })),
    ];
    for (const body of invalid) expect((await request(path, admin, "POST", body)).status).toBe(400);
    expect(await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, input.modelId))).toHaveLength(0);
});

test("stale expectedVersion cannot overwrite confirmed rules or add an audit", async () => {
    const input = await seedModel("versions", "text");
    expect((await request(path, admin, "POST", input)).status).toBe(201);
    const before = await database.db.select().from(auditEvent);
    const changed: ModelPriceRules = { ...input.rules, sale: { ...input.rules.sale, bands: [{ parameters: {}, rates: { input_token: "2", output_token: "9" } }] } };
    const stale = await request(path, admin, "POST", { ...input, rules: changed });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("price_draft_conflict");
    expect(await database.db.select().from(auditEvent)).toEqual(before);
    expect((await readDrafts()).items.find((item) => item.modelId === input.modelId)?.rules).toEqual(input.rules);
    const second = await request(path, admin, "POST", { ...input, expectedVersion: 1, rules: changed });
    expect(second.status).toBe(201);
    const rows = await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, input.modelId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.version === 1)?.rules).toEqual(input.rules);
    const latest = (await readDrafts()).items.filter((item) => item.modelId === input.modelId);
    expect(latest).toHaveLength(1);
    expect(latest[0].rules).toEqual(changed);
});

test("endpoint, adapter, upstream model, provider and capability changes invalidate the saved binding", async () => {
    const input = await seedModel("binding");
    expect((await request(path, admin, "POST", input)).status).toBe(201);
    const rejected = async () => {
        const response = await request(path, admin, "POST", { ...input, expectedVersion: 1 });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe("model_binding_changed");
        expect((await readDrafts()).items.find((item) => item.modelId === input.modelId)).toMatchObject({ version: 1, bindingMatchesCurrent: false, binding: input.binding });
    };
    await database.db.update(modelProvider).set({ endpoint: "https://changed.invalid/v1" }).where(eq(modelProvider.id, input.binding.providerId));
    await rejected();
    await database.db.update(modelProvider).set({ endpoint: input.binding.endpoint, adapter: "sub2api" }).where(eq(modelProvider.id, input.binding.providerId));
    await rejected();
    await database.db.update(modelProvider).set({ adapter: input.binding.adapter }).where(eq(modelProvider.id, input.binding.providerId));
    await database.db.update(modelCatalog).set({ providerModel: "changed-upstream" }).where(eq(modelCatalog.id, input.modelId));
    await rejected();
    await database.db.insert(modelProvider).values({ id: "replacement-provider", displayName: "Synthetic replacement", adapter: input.binding.adapter, endpoint: input.binding.endpoint, secretRef: "synthetic-private-replacement", enabled: false });
    await database.db.update(modelCatalog).set({ providerId: "replacement-provider", providerModel: input.binding.providerModel }).where(eq(modelCatalog.id, input.modelId));
    await rejected();
    await database.db.update(modelCatalog).set({ providerId: input.binding.providerId, capability: "text" }).where(eq(modelCatalog.id, input.modelId));
    await rejected();
    await database.db.update(modelCatalog).set({ capability: "audio" }).where(eq(modelCatalog.id, input.modelId));
    await rejected();
    expect((await readDrafts()).models.some((model) => model.modelId === input.modelId)).toBe(true);
    expect((await request(path, admin, "POST", { ...input, modelId: "missing-model" })).status).toBe(404);
});

test("database enforces append-only history and readback rejects malformed stored rule objects", async () => {
    const input = await seedModel("db-checks");
    const response = await request(path, admin, "POST", input);
    expect(response.status).toBe(201);
    const saved = (await response.json()).draft as AdminModelPriceDraft;
    await expect(database.db.update(modelPriceDraft).set({ rules: { ...input.rules, cost: null } }).where(eq(modelPriceDraft.id, saved.id)).execute()).rejects.toThrow();
    await expect(database.db.delete(modelPriceDraft).where(eq(modelPriceDraft.id, saved.id)).execute()).rejects.toThrow();
    expect((await readDrafts()).items.find((item) => item.id === saved.id)?.rules).toEqual(input.rules);
    // A private transaction probes malformed legacy/manual data without retaining it.
    await expect(database.db.transaction(async (tx) => {
        await tx.insert(modelPriceDraft).values({ ...saved, id: crypto.randomUUID(), modelId: input.modelId, version: 2,
            providerIdSnapshot: input.binding.providerId, providerModelSnapshot: input.binding.providerModel,
            adapterSnapshot: input.binding.adapter, endpointSnapshot: input.binding.endpoint, capabilitySnapshot: input.binding.capability,
            rules: sql`'{"schemaVersion":1,"cost":null,"sale":{"secret":"synthetic-private-secret"}}'::jsonb`, createdAt: new Date(),
        });
        const { listModelPriceDrafts } = await import("@infinite-canvas/database/model-price-drafts");
        await listModelPriceDrafts(tx);
    })).rejects.toThrow("Invalid stored model price draft rules");
    expect((await readDrafts()).items.find((item) => item.modelId === input.modelId)?.version).toBe(1);
});

test("audit failure rolls back the draft and version allocation", async () => {
    const input = await seedModel("audit-failure");
    await database.db.execute(sql`CREATE FUNCTION canvas_saas.reject_synthetic_price_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'model.price-draft.created' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
    await database.db.execute(sql`CREATE TRIGGER reject_synthetic_price_audit BEFORE INSERT ON canvas_saas.audit_event FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_synthetic_price_audit()`);
    try {
        expect((await request(path, admin, "POST", input)).status).toBe(503);
        expect(await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, input.modelId))).toHaveLength(0);
    } finally {
        await database.db.execute(sql`DROP TRIGGER reject_synthetic_price_audit ON canvas_saas.audit_event`);
        await database.db.execute(sql`DROP FUNCTION canvas_saas.reject_synthetic_price_audit()`);
    }
    const retry = await request(path, admin, "POST", input);
    expect(retry.status).toBe(201);
    expect((await retry.json()).draft.version).toBe(1);
});
