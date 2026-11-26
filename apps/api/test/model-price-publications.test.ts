import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { AdminModelPriceDraft, AdminModelPricePublication, ModelPriceDraftWrite, ModelPricePublicationPreview, ModelPricePublishWrite, PricingCapability } from "@infinite-canvas/shared";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { auditEvent, generationTask, mediaObject, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, modelProviderCredential, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createMemoryObjectStorage } from "@infinite-canvas/storage";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createGenerationDelivery } from "../src/generation-delivery";
import { createGenerationProvider } from "../src/generation-provider";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { createTestDatabase } from "./database";

if (process.env.SAAS_TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error("Only isolated in-memory PGlite is permitted");
const origin = "http://localhost:4033", secret = "publication-synthetic-" + crypto.randomUUID();
const path = "/api/v1/admin/model-price-publications", draftPath = "/api/v1/admin/model-price-drafts";
const credential = "synthetic-private-provider-credential";
type Identity = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>, disabledApp: ReturnType<typeof createApp>;
let admin: Identity, regular: Identity;
let rateDenied = false;
const queued: GenerationJobPayload[] = [];

function request(url: string, identity = admin, method = "GET", body?: unknown, extra: HeadersInit = {}, handler = app) {
    const headers = new Headers({ origin, cookie: identity.cookie, "x-canvas-account-id": identity.id, "content-type": "application/json" });
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return handler(new Request(new URL(url, origin), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "198.51.100.42");
}
async function register(label: string): Promise<Identity> {
    const email = `publication-${label}@example.test`, password = "synthetic-publication-password";
    expect((await request("/api/auth/sign-up/email", { id: "", cookie: "" }, "POST", { email, password, name: label })).status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const response = await request("/api/auth/sign-in/email", { id: "", cookie: "" }, "POST", { email, password });
    expect(response.status).toBe(200);
    return { id: row!.id, cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
}
async function seed(label: string, capability: PricingCapability = "image"): Promise<ModelPriceDraftWrite> {
    const modelId = `publication-${label}`, providerId = `provider-${label}`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: label, adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", secretRef: "synthetic-private-ref", enabled: true });
    await saveProviderCredential(database.db, secret, providerId, credential);
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: `synthetic-${capability}`, displayName: label, capability, enabled: true });
    return {
        modelId, expectedVersion: 0, binding: { providerId, providerModel: `synthetic-${capability}`, adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability },
        rules: { schemaVersion: 1, cost: null, sale: capability === "text"
            ? { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] }
            : capability === "video" ? { template: "video_count", currency: "credit", bands: [{ parameters: {}, rates: { video: "7" } }] }
                : { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } },
        priceNote: "synthetic-private-draft-note",
    };
}
async function save(input: ModelPriceDraftWrite): Promise<AdminModelPriceDraft> {
    const response = await request(draftPath, admin, "POST", input);
    expect(response.status).toBe(201);
    return (await response.json()).draft;
}
function publishInput(draft: AdminModelPriceDraft, expectedPriceVersion = 0, publicPriceNote = "单张 PNG，按次收费"): ModelPricePublishWrite {
    return { modelId: draft.modelId, draftId: draft.id, expectedDraftVersion: draft.version, expectedPriceVersion, binding: draft.binding, publicPriceNote };
}
async function publish(input: ModelPricePublishWrite): Promise<AdminModelPricePublication> {
    const response = await request(path, admin, "POST", input);
    expect(response.status).toBe(200);
    return (await response.json()).publication;
}
async function preview(modelId: string, handler = app): Promise<ModelPricePublicationPreview> {
    const response = await request(`${path}?modelId=${encodeURIComponent(modelId)}`, admin, "GET", undefined, {}, handler);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return (await response.json()).preview;
}
const publicationState = () => Promise.all([database.db.select().from(modelPricing), database.db.select().from(modelPricePublication), database.db.select().from(auditEvent)]);
const businessState = () => Promise.all([database.db.select().from(wallet), database.db.select().from(walletLedger), database.db.select().from(walletReservation), database.db.select().from(generationTask)]);

beforeAll(async () => {
    database = await createTestDatabase();
    const authRates = createRateStore(database.pool, secret);
    const options = {
        database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { ...authRates, consume: ((bucket, identity, rule) => bucket === "account-read" || bucket === "canvas-save"
            ? Promise.resolve(rateDenied ? { allowed: false, retryAfter: 1 } : { allowed: true })
            : authRates.consume(bucket, identity, rule)) as typeof authRates.consume },
        verifyHuman: async () => true, onFault: () => undefined,
    };
    app = createApp(createAccountApi({ ...options, generation: { enabled: true, queue: { async send(name, payload, supplied) {
        expect(name).toBe("generation"); expect(supplied?.db).toBeDefined();
        queued.push(structuredClone(payload)); return crypto.randomUUID();
    } } } }), "synthetic-site-key");
    disabledApp = createApp(createAccountApi(options), "synthetic-site-key");
    admin = await register("admin"); regular = await register("user");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await database.db.insert(wallet).values({ userId: regular.id, availableUnits: "40" });
});
afterAll(async () => { await database?.close(); });

test("authenticated publication preview is read-only, available while generation is off, and has strict route gates", async () => {
    const input = await seed("preview"), draft = await save(input), body = publishInput(draft);
    const before = { prices: await publicationState(), business: await businessState(), jobs: queued.length };
    expect(await preview(input.modelId, disabledApp)).toMatchObject({ draft: { id: draft.id }, currentPrice: null, latestPriceVersion: 0, publication: null, unavailableReason: null });
    expect((await request("/api/v1/generation/models", regular, "GET", undefined, {}, disabledApp)).status).toBe(503);
    expect({ prices: await publicationState(), business: await businessState(), jobs: queued.length }).toEqual(before);
    for (const [identity, headers, status] of [
        [{ id: "", cookie: "" }, {}, 401], [regular, {}, 403], [admin, { "x-canvas-account-id": "" }, 400],
        [admin, { "x-canvas-account-id": regular.id }, 409], [admin, { origin: "https://foreign.invalid" }, 403],
    ] as const) for (const method of ["GET", "POST"]) {
        expect((await request(method === "GET" ? `${path}?modelId=${input.modelId}` : path, identity, method, method === "POST" ? body : undefined, headers)).status).toBe(status);
    }
    for (const query of ["", "?modelId=", `?modelId=${input.modelId}&extra=1`, `?modelId=${input.modelId}&modelId=${input.modelId}`]) expect((await request(path + query)).status).toBe(400);
    expect((await request(`${path}?modelId=missing`)).status).toBe(404);
    expect((await request(path, admin, "PUT", body)).status).toBe(405);
    for (const invalid of [{ ...body, creditsPerUnit: 1 }, { ...body, binding: { ...body.binding, secret: "hidden" } }, { ...body, expectedPriceVersion: "0" }]) expect((await request(path, admin, "POST", invalid)).status).toBe(400);
    rateDenied = true;
    try { expect((await request(`${path}?modelId=${input.modelId}`)).status).toBe(429); expect((await request(path, admin, "POST", body)).status).toBe(429); }
    finally { rateDenied = false; }
    expect(await publicationState()).toEqual(before.prices);
});

test("saved immutable sources publish once, retain private historical costs, and reject stale drafts or changed replay notes", async () => {
    const input = await seed("versions");
    input.rules.cost = { template: "image_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: null, output_token: "0", image_input_token: "3", image_output_token: "4" } }] };
    const firstDraft = await save(input), firstBody = publishInput(firstDraft), beforeBusiness = await businessState(), jobs = queued.length;
    const first = await publish(firstBody);
    expect(first).toMatchObject({ draftId: firstDraft.id, draftVersion: 1, priceVersion: 1, creditsPerUnit: 7, rules: input.rules, bindingMatchesCurrent: true });
    const once = await publicationState();
    expect(await publish(firstBody)).toEqual(first);
    expect(await publicationState()).toEqual(once);
    const changedNote = await request(path, admin, "POST", { ...firstBody, publicPriceNote: "changed" });
    expect(changedNote.status).toBe(409); expect((await changedNote.json()).error.code).toBe("price_publication_conflict");
    const next = structuredClone(input); next.expectedVersion = 1; next.rules.cost = null; next.rules.sale.bands[0]!.rates.request = "9";
    const secondDraft = await save(next);
    expect((await request(path, admin, "POST", firstBody)).status).toBe(409);
    const beforeConflict = await publicationState();
    expect((await request(path, admin, "POST", publishInput(secondDraft, 0))).status).toBe(409);
    expect(await publicationState()).toEqual(beforeConflict);
    const second = await publish(publishInput(secondDraft, 1));
    expect(second).toMatchObject({ draftVersion: 2, priceVersion: 2, creditsPerUnit: 9, rules: { cost: null } });
    const prices = await database.db.select().from(modelPricing).where(eq(modelPricing.modelId, input.modelId));
    expect(prices.map((row) => ({ version: row.version, enabled: row.enabled })).sort((a, b) => a.version - b.version)).toEqual([{ version: 1, enabled: false }, { version: 2, enabled: true }]);
    const [historical] = await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.id, firstDraft.id));
    expect(historical?.rules.cost).toEqual(input.rules.cost);
    expect(await businessState()).toEqual(beforeBusiness); expect(queued.length).toBe(jobs);
});

test("draft-only zero, fractions, unsafe integers, other meters and unsupported parameter bands never become active prices", async () => {
    const cases: Array<[string, PricingCapability, (input: ModelPriceDraftWrite) => void]> = [
        ["zero", "image", (v) => { v.rules.sale.bands[0]!.rates.request = "0"; }],
        ["fraction", "image", (v) => { v.rules.sale.bands[0]!.rates.request = "0.1"; }],
        ["unsafe", "image", (v) => { v.rules.sale.bands[0]!.rates.request = "9007199254740993"; }],
        ["count", "image", (v) => { v.rules.sale = { template: "image_count", currency: "credit", bands: [{ parameters: {}, rates: { image: "7" } }] }; }],
        ["tier", "image", (v) => { v.rules.sale.bands[0]!.parameters = { size: "auto" }; }],
        ["text-zero", "text", (v) => { v.rules.sale.bands[0]!.rates.input_token = "0"; }], ["video", "video", () => {}],
        ["adapter", "image", (v) => { v.binding.adapter = "sub2api"; }],
    ];
    for (const [label, capability, mutate] of cases) {
        const input = await seed(`unsupported-${label}`, capability); mutate(input);
        if (input.binding.adapter === "sub2api") await database.db.update(modelProvider).set({ adapter: "sub2api" }).where(eq(modelProvider.id, input.binding.providerId));
        const draft = await save(input), before = await publicationState();
        expect((await preview(input.modelId)).unavailableReason).toBe("unsupported_price_rule");
        const response = await request(path, admin, "POST", publishInput(draft));
        expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("unsupported_price_rule");
        expect(await publicationState()).toEqual(before);
    }
});

async function seedGeminiTrial(label: string, providerModel = "gemini-3.1-flash-image-preview") {
    const input = await seed(label);
    input.binding = { ...input.binding, providerModel, endpoint: "https://provider.invalid/" };
    await database.db.update(modelProvider).set({ endpoint: input.binding.endpoint }).where(eq(modelProvider.id, input.binding.providerId));
    await database.db.update(modelCatalog).set({ providerModel }).where(eq(modelCatalog.id, input.modelId));
    input.rules.sale = { template: "image_count", currency: "credit", bands: [
        { parameters: { aspectRatio: "16:9", imageSize: "1K" }, rates: { image: "7" } },
        { parameters: { aspectRatio: "1:1", imageSize: "4K" }, rates: { image: "11" } },
    ] };
    return input;
}

function geminiTrialPath(modelId: string, patch: Record<string, string> = {}) {
    return `${path}?${new URLSearchParams({ modelId, draftVersion: "1", priceVersion: "0", aspectRatio: "16:9", imageSize: "1K", budgetCredits: "17", ...patch })}`;
}

test("IMG-04 estimates a saved exact per-image sale with no publication, task, provider job or wallet writes", async () => {
    const input = await seedGeminiTrial("gemini-trial"), draft = await save(input), trial = geminiTrialPath(input.modelId);
    const prices = await publicationState(), business = await businessState(), jobs = queued.length;
    expect(await preview(input.modelId, disabledApp)).toMatchObject({ draft: { id: draft.id }, publication: null, currentPrice: null, unavailableReason: "unsupported_price_rule" });
    const response = await request(trial, admin, "GET", undefined, {}, disabledApp);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const { quote } = await response.json();
    expect(quote).toEqual({ status: "trial_only", modelId: input.modelId, draftVersion: 1, priceVersion: 0,
        parameters: { aspectRatio: "16:9", imageSize: "1K" }, budgetCredits: 17, creditsPerImage: 7, coveredImages: 2 });
    const second = await request(geminiTrialPath(input.modelId, { aspectRatio: "1:1", imageSize: "4K", budgetCredits: "22" }));
    expect((await second.json()).quote).toMatchObject({ creditsPerImage: 11, coveredImages: 2, budgetCredits: 22 });
    expect((await request(trial, regular)).status).toBe(403);
    expect((await request(trial, admin, "GET", undefined, { "x-canvas-account-id": regular.id })).status).toBe(409);
    expect((await request(trial + "&budgetCredits=17")).status).toBe(400);
    expect((await request(path, admin, "POST", publishInput(draft))).status).toBe(409);
    const generationIntent = { modelId: input.modelId, input: { prompt: "synthetic" }, parameters: quote.parameters };
    expect((await request("/api/v1/generation/quote", regular, "POST", generationIntent)).status).toBe(400);
    expect((await request("/api/v1/generation/tasks", regular, "POST", { ...generationIntent, confirmedPriceVersion: 1 }, { "idempotency-key": "gemini-trial-rejected" })).status).toBe(400);
    const models = await request("/api/v1/generation/models", regular);
    expect(models.status).toBe(200);
    expect(await models.text()).not.toContain(input.modelId);
    expect(await publicationState()).toEqual(prices);
    expect(await businessState()).toEqual(business);
    expect(queued).toHaveLength(jobs);
});

test("IMG-04 rejects stale draft or price versions, rebindings and insufficient sample budgets", async () => {
    const input = await seedGeminiTrial("gemini-stale", "gemini-3-pro-image-preview");
    await save(input);
    for (const [patch, status, code] of [[{ budgetCredits: "6" }, 409, "budget_insufficient"],
        [{ imageSize: "512" }, 400, "invalid_input"], [{ imageSize: "2K" }, 409, "unsupported_price_rule"],
        [{ budgetCredits: "9007199254740992" }, 400, "invalid_input"], [{ budgetCredits: "1e2" }, 400, "invalid_input"]] as const) {
        const response = await request(geminiTrialPath(input.modelId, patch));
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
    }
    input.rules.sale.bands[0]!.rates.image = "9";
    await save({ ...input, expectedVersion: 1 });
    expect((await (await request(geminiTrialPath(input.modelId))).json()).error.code).toBe("price_changed");
    const updated = await request(geminiTrialPath(input.modelId, { draftVersion: "2" }));
    expect((await updated.json()).quote).toMatchObject({ draftVersion: 2, creditsPerImage: 9, coveredImages: 1 });
    // A different price version invalidates the trial even if the draft is unchanged.
    await database.db.insert(modelPricing).values({ id: crypto.randomUUID(), modelId: input.modelId, version: 1, billingUnit: "request", creditsPerUnit: 3, effectiveFrom: new Date(), enabled: false });
    expect((await (await request(geminiTrialPath(input.modelId, { draftVersion: "2" }))).json()).error.code).toBe("price_changed");
    await database.db.update(modelProvider).set({ endpoint: "https://changed.invalid/" }).where(eq(modelProvider.id, input.binding.providerId));
    expect((await (await request(geminiTrialPath(input.modelId, { draftVersion: "2", priceVersion: "1" }))).json()).error.code).toBe("model_binding_changed");
});

test("IMG-04 cannot save native price bands on alias, non-root or incompatible model bindings", async () => {
    const input = await seedGeminiTrial("gemini-bad-binding", "gemini-3.1-flash-image-preview-default");
    const before = await publicationState();
    for (const binding of [input.binding, { ...input.binding, providerModel: "gemini-3.1-flash-image-preview", endpoint: "https://provider.invalid/v1" },
        { ...input.binding, providerModel: "gemini-3.1-flash-image-preview", adapter: "sub2api" }]) {
        expect((await request(draftPath, admin, "POST", { ...input, binding })).status).toBe(400);
    }
    expect(await publicationState()).toEqual(before);
    expect((await preview(input.modelId)).draft).toBeNull();
});

test("publishing requires current binding, enabled model/provider and an existing credential", async () => {
    for (const condition of ["binding", "model", "provider", "credential"] as const) {
        const input = await seed(`guard-${condition}`), draft = await save(input);
        if (condition === "binding") await database.db.update(modelProvider).set({ endpoint: "https://changed.invalid/v1" }).where(eq(modelProvider.id, input.binding.providerId));
        if (condition === "model") await database.db.update(modelCatalog).set({ enabled: false }).where(eq(modelCatalog.id, input.modelId));
        if (condition === "provider") await database.db.update(modelProvider).set({ enabled: false }).where(eq(modelProvider.id, input.binding.providerId));
        if (condition === "credential") await database.db.delete(modelProviderCredential).where(eq(modelProviderCredential.providerId, input.binding.providerId));
        const before = await publicationState(), reason = condition === "binding" ? "model_binding_changed" : "model_not_publishable";
        expect((await preview(input.modelId)).unavailableReason).toBe(reason);
        const response = await request(path, admin, "POST", publishInput(draft));
        expect(response.status).toBe(409); expect((await response.json()).error.code).toBe(reason);
        expect(await publicationState()).toEqual(before);
    }
});

test("legacy prices share the publication CAS baseline and cannot bypass a published source", async () => {
    const input = await seed("legacy"), draft = await save(input);
    const legacy = { modelId: input.modelId, billingUnit: "request", creditsPerUnit: 3, enabled: true };
    expect((await request("/api/v1/admin/model-pricing", admin, "POST", legacy)).status).toBe(201);
    expect((await preview(input.modelId)).latestPriceVersion).toBe(1);
    const before = await publicationState();
    expect((await request(path, admin, "POST", publishInput(draft))).status).toBe(409);
    expect(await publicationState()).toEqual(before);
    expect(await publish(publishInput(draft, 1))).toMatchObject({ priceVersion: 2, creditsPerUnit: 7 });
    const published = await publicationState();
    const response = await request("/api/v1/admin/model-pricing", admin, "POST", { ...legacy, creditsPerUnit: 1 });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("price_publication_managed");
    expect(await publicationState()).toEqual(published);
});

test("failed publication audit rolls back price rotation and source rows; confirmed history is immutable", async () => {
    const input = await seed("atomic"), firstDraft = await save(input);
    const first = await publish(publishInput(firstDraft));
    const next = structuredClone(input); next.expectedVersion = 1; next.rules.sale.bands[0]!.rates.request = "9";
    const draft = await save(next), before = await publicationState();
    await database.db.execute(sql`CREATE FUNCTION canvas_saas.reject_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'model.price.published' THEN RAISE EXCEPTION 'synthetic publication audit failure'; END IF; RETURN NEW; END; $$`);
    await database.db.execute(sql`CREATE TRIGGER reject_publication_audit BEFORE INSERT ON canvas_saas.audit_event FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_publication_audit()`);
    try { expect((await request(path, admin, "POST", publishInput(draft, 1))).status).toBe(503); expect(await publicationState()).toEqual(before); }
    finally { await database.db.execute(sql`DROP TRIGGER reject_publication_audit ON canvas_saas.audit_event`); await database.db.execute(sql`DROP FUNCTION canvas_saas.reject_publication_audit()`); }
    expect(await publish(publishInput(draft, 1))).toMatchObject({ priceVersion: 2 });
    await expect(database.db.update(modelPricePublication).set({ publicPriceNote: "overwrite" }).where(eq(modelPricePublication.id, first.id)).execute()).rejects.toThrow();
    await expect(database.db.delete(modelPricePublication).where(eq(modelPricePublication.id, first.id)).execute()).rejects.toThrow();
    await expect(database.db.update(modelPricing).set({ creditsPerUnit: 1 }).where(and(eq(modelPricing.modelId, input.modelId), eq(modelPricing.version, 1))).execute()).rejects.toThrow();
});

test("public quote and accepted dispatch settle the old seven-credit snapshot after a nine-credit publication", async () => {
    const input = await seed("pipeline");
    input.rules.cost = { template: "image_request", currency: "CNY", bands: [{ parameters: {}, rates: { request: "0.3141592653589" } }] };
    await publish(publishInput(await save(input), 0, "公开：单张 PNG 每次 7 积分"));
    const intent = { modelId: input.modelId, input: { prompt: "synthetic four-colour image" }, parameters: {}, projectId: "publication-canvas" };
    const firstQuote = await request("/api/v1/generation/quote", regular, "POST", intent);
    expect(firstQuote.status).toBe(200);
    const quote = (await firstQuote.json()).quote;
    expect(quote).toMatchObject({ priceVersion: 1, quotedUnits: 7, billingUnit: "request", priceNote: "公开：单张 PNG 每次 7 积分" });
    const publicPrices = await (await request("/api/v1/model-pricing", regular)).json();
    const publicPrice = publicPrices.items.find((item: { modelId: string }) => item.modelId === input.modelId);
    expect(publicPrice).toMatchObject({ version: 1, creditsPerUnit: 7, priceNote: quote.priceNote });
    for (const value of [quote, publicPrice]) for (const hidden of [input.priceNote, "0.3141592653589", input.binding.providerId, "provider.invalid", credential, "rules", "draftId"]) expect(JSON.stringify(value)).not.toContain(hidden);
    const headers = { "idempotency-key": "publication-accepted-seven" }, submission = { ...intent, confirmedPriceVersion: 1 };
    const accepted = await request("/api/v1/generation/tasks", regular, "POST", submission, headers);
    expect(accepted.status).toBe(201);
    const task = (await accepted.json()).task;
    const job = queued.find((item) => item.taskId === task.id)!;
    expect(job).toBeDefined();
    const wallets = createWalletRepository(database.db);
    expect(await wallets.get(regular.id)).toMatchObject({ availableUnits: "33", reservedUnits: "7" });
    const next = structuredClone(input); next.expectedVersion = 1; next.rules.sale.bands[0]!.rates.request = "9"; next.rules.cost = null;
    await publish(publishInput(await save(next), 1, "公开：每次 9 积分"));
    const beforeStale = { business: await businessState(), jobs: queued.length };
    const stale = await request("/api/v1/generation/tasks", regular, "POST", submission, { "idempotency-key": "publication-unaccepted-seven" });
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("price_changed");
    expect({ business: await businessState(), jobs: queued.length }).toEqual(beforeStale);
    expect((await (await request("/api/v1/generation/quote", regular, "POST", intent)).json()).quote).toMatchObject({ priceVersion: 2, quotedUnits: 9, priceNote: "公开：每次 9 积分" });
    const replay = await request("/api/v1/generation/tasks", regular, "POST", submission, headers);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ created: false, task: { id: task.id, priceVersion: 1, quotedUnits: 7 } });
    expect(queued.length).toBe(beforeStale.jobs);
    // Real provider normalization, delivery and settlement; synthetic gateway and memory object storage.
    const png = new Uint8Array(await Bun.file(new URL("../../../web/scripts/fixtures/media-recovery.png", import.meta.url)).arrayBuffer());
    let upstreamCalls = 0;
    const dependencies = {
        provider: createGenerationProvider({ database: database.db, authSecret: secret, imageMaxBytes: png.length, gateway: { async request() {
            upstreamCalls++; return { status: "succeeded" as const, upstreamStatus: 200, payload: { data: [{ b64_json: Buffer.from(png).toString("base64") }] } };
        } } }),
        deliver: createGenerationDelivery({ database: database.db, storage: createMemoryObjectStorage(), quotaBytes: png.length * 2, maxBytes: { image: png.length, video: png.length, audio: png.length } }),
        settleBilling: createGenerationWalletSettlement(database.db),
    };
    const completed = await processGenerationJob(database.db, job, dependencies);
    expect(completed.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured", priceVersion: 1, creditsPerUnitSnapshot: 7 });
    expect(completed.result.consumedUnits).toBe(1);
    expect(await wallets.get(regular.id)).toMatchObject({ availableUnits: "33", reservedUnits: "0" });
    const ledger = (await wallets.listLedger(regular.id)).filter((row) => row.referenceId === task.id);
    expect(ledger.filter((row) => row.kind === "reserve")).toHaveLength(1); expect(ledger.filter((row) => row.kind === "capture")).toHaveLength(1); expect(ledger.filter((row) => row.kind === "release")).toHaveLength(0);
    expect(await wallets.getReservation(regular.id, completed.task.reservationId!)).toMatchObject({ requestedUnits: "7", capturedUnits: "7", releasedUnits: "0" });
    expect(await database.db.select().from(mediaObject).where(eq(mediaObject.id, task.id))).toHaveLength(1);
    const settled = await businessState();
    expect((await processGenerationJob(database.db, job, dependencies)).replay).toBe(true);
    expect((await request("/api/v1/generation/tasks", regular, "POST", submission, headers)).status).toBe(200);
    expect(await businessState()).toEqual(settled); expect(upstreamCalls).toBe(1); expect(queued.length).toBe(beforeStale.jobs);
    const acceptedNine = await request("/api/v1/generation/tasks", regular, "POST", { ...intent, confirmedPriceVersion: 2 }, { "idempotency-key": "publication-accepted-nine" });
    expect(acceptedNine.status).toBe(201);
    const newTask = (await acceptedNine.json()).task;
    expect(newTask).toMatchObject({ priceVersion: 2, quotedUnits: 9, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 9, billingStatus: "reserved" });
    const [newRow] = await database.db.select().from(generationTask).where(eq(generationTask.id, newTask.id));
    expect(await wallets.getReservation(regular.id, newRow!.reservationId!)).toMatchObject({ status: "pending", requestedUnits: "9", capturedUnits: "0", releasedUnits: "0" });
    expect(await wallets.get(regular.id)).toMatchObject({ availableUnits: "24", reservedUnits: "9" });
    expect(queued.length).toBe(beforeStale.jobs + 1); expect(upstreamCalls).toBe(1);
});

test("changed publication binding hides public availability and prevents an accepted worker from calling upstream", async () => {
    const input = await seed("binding-worker"), draft = await save(input);
    await publish(publishInput(draft));
    const intent = { modelId: input.modelId, input: { prompt: "synthetic binding guard" }, parameters: {} };
    const response = await request("/api/v1/generation/tasks", regular, "POST", { ...intent, confirmedPriceVersion: 1 }, { "idempotency-key": "publication-binding-worker" });
    expect(response.status).toBe(201);
    const task = (await response.json()).task, job = queued.find((row) => row.taskId === task.id)!;
    await database.db.update(modelProvider).set({ endpoint: "https://changed.invalid/v1" }).where(eq(modelProvider.id, input.binding.providerId));
    expect((await preview(input.modelId)).unavailableReason).toBe("model_binding_changed");
    expect((await (await request("/api/v1/generation/models", regular)).json()).items.some((row: { id: string }) => row.id === input.modelId)).toBe(false);
    expect((await (await request("/api/v1/model-pricing", regular)).json()).items.some((row: { modelId: string }) => row.modelId === input.modelId)).toBe(false);
    expect((await request("/api/v1/generation/quote", regular, "POST", intent)).status).toBe(400);
    let calls = 0;
    const result = await processGenerationJob(database.db, job, {
        provider: createGenerationProvider({ database: database.db, authSecret: secret, imageMaxBytes: 232, gateway: { async request() { calls++; throw new Error("changed binding must never call upstream"); } } }),
        settleBilling: createGenerationWalletSettlement(database.db),
    });
    expect(result.result).toMatchObject({ status: "failed", errorCode: "model_unavailable" });
    expect(result.task.billingStatus).toBe("released"); expect(calls).toBe(0);
    const reservation = await createWalletRepository(database.db).getReservation(regular.id, result.task.reservationId!);
    expect(reservation).toMatchObject({ requestedUnits: "7", capturedUnits: "0", releasedUnits: "7" });
});
