import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { AdminModelPriceDraft, ModelPriceDraftWrite } from "@infinite-canvas/shared";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { resolveActiveGenerationPricing } from "@infinite-canvas/database/pricing";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { generationTask, modelCatalog, modelProvider, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { quoteReserveAndEnqueueServerGenerationTask } from "../src/generation-dispatch";
import { createGenerationProvider } from "../src/generation-provider";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Only isolated in-memory PGlite is permitted");
const origin = "http://localhost:4033", secret = `synthetic-text-publication-${crypto.randomUUID()}`;
const draftPath = "/api/v1/admin/model-price-drafts", publicationPath = "/api/v1/admin/model-price-publications";
const credential = "synthetic-private-text-credential", privateNote = "synthetic-private-draft-description";
const publicNote = "输入与输出分别按每百万 Token 标价；文本生成尚未开放";
type Identity = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>, disabledApp: ReturnType<typeof createApp>;
let admin: Identity, reader: Identity, textInput: ModelPriceDraftWrite;
let queueSends = 0;
const queue = { async send() { queueSends++; return crypto.randomUUID(); } };

function request(path: string, identity = reader, body?: unknown, key: string = crypto.randomUUID(), handler = app) {
    return handler(new Request(new URL(path, origin), { method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: identity.cookie, "x-canvas-account-id": identity.id, "content-type": "application/json", "idempotency-key": key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.47");
}
async function register(label: string): Promise<Identity> {
    const email = `text-publication-${label}@example.test`, password = "synthetic-text-publication-password";
    expect((await request("/api/auth/sign-up/email", { id: "", cookie: "" }, { email, password, name: label })).status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const login = await request("/api/auth/sign-in/email", { id: "", cookie: "" }, { email, password });
    expect(login.status).toBe(200);
    return { id: row!.id, cookie: login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
}
async function seed(capability: "text" | "image"): Promise<ModelPriceDraftWrite> {
    const modelId = `published-${capability}`, providerId = `private-${capability}-provider`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic provider", adapter: "openai-compatible", endpoint: "https://private-provider.invalid/v1", secretRef: "synthetic-private-reference", enabled: true });
    await saveProviderCredential(database.db, secret, providerId, credential);
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: `private-upstream-${capability}`, displayName: `Published ${capability}`, capability, enabled: true });
    return { modelId, expectedVersion: 0, binding: { providerId, providerModel: `private-upstream-${capability}`, adapter: "openai-compatible", endpoint: "https://private-provider.invalid/v1", capability },
        rules: { schemaVersion: 1,
            cost: capability === "text" ? { template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "0.71234567890123456789", output_token: null } }] } : null,
            sale: capability === "text" ? { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "0.000000000000000123", output_token: "7.500" } }] }
                : { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } }, priceNote: privateNote };
}
async function save(input: ModelPriceDraftWrite): Promise<AdminModelPriceDraft> {
    const response = await request(draftPath, admin, input);
    expect(response.status).toBe(201);
    return (await response.json()).draft;
}
async function publish(draft: AdminModelPriceDraft, note: string) {
    const response = await request(publicationPath, admin, { modelId: draft.modelId, draftId: draft.id, expectedDraftVersion: draft.version,
        expectedPriceVersion: 0, binding: draft.binding, publicPriceNote: note });
    expect(response.status).toBe(200);
    return (await response.json()).publication;
}
const businessState = async () => ({ tasks: await database.db.select().from(generationTask), wallets: await database.db.select().from(wallet),
    reservations: await database.db.select().from(walletReservation), ledger: await database.db.select().from(walletLedger), queueSends });

beforeAll(async () => {
    database = await createTestDatabase();
    const options = { database: database.db, origin, auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: createRateStore(database.pool, secret), verifyHuman: async () => true, onFault: () => undefined };
    app = createApp(createAccountApi({ ...options, generation: { enabled: true, queue } }), "synthetic-site-key");
    disabledApp = createApp(createAccountApi(options), "synthetic-site-key");
    admin = await register("admin"); reader = await register("reader");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await database.db.insert(wallet).values({ userId: reader.id, availableUnits: "20" });
    textInput = await seed("text");
    expect(await publish(await save(textInput), publicNote)).toMatchObject({ billingUnit: "text_tokens", creditsPerUnit: null, priceVersion: 1 });
    await publish(await save(await seed("image")), "单张图片每次 7 积分");
});
afterAll(async () => { await database?.close(); });

test("public text prices expose only the exact published sale rates while newer drafts remain private", async () => {
    const before = await businessState();
    const response = await request("/api/v1/model-pricing");
    expect(response.status).toBe(200);
    const item = (await response.json()).items.find((row: { modelId: string }) => row.modelId === textInput.modelId);
    expect(item).toMatchObject({ modelId: textInput.modelId, capability: "text", version: 1, billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: "0.000000000000000123", outputCreditsPerMillion: "7.5", priceNote: publicNote });
    expect(Object.keys(item).sort()).toEqual(["modelId", "displayName", "capability", "version", "billingUnit", "creditsPerUnit", "inputCreditsPerMillion", "outputCreditsPerMillion", "effectiveFrom", "effectiveTo", "priceNote"].sort());
    for (const hidden of [privateNote, credential, textInput.binding.providerId, textInput.binding.providerModel, textInput.binding.endpoint, "0.71234567890123456789", "rules", "draftId", "USD"]) expect(JSON.stringify(item)).not.toContain(hidden);
    const changed = structuredClone(textInput); changed.expectedVersion = 1;
    changed.rules.sale.bands[0]!.rates.input_token = "88"; changed.rules.sale.bands[0]!.rates.output_token = "99";
    await save(changed);
    const reread = await request("/api/v1/model-pricing", reader, undefined, undefined, disabledApp);
    expect(reread.status).toBe(200);
    expect((await reread.json()).items.find((row: { modelId: string }) => row.modelId === textInput.modelId)).toEqual(item);
    expect(await businessState()).toEqual(before);
});

test("a published text price cannot authorize a public or legacy scalar generation or a provider request", async () => {
    const before = await businessState();
    const models = await request("/api/v1/generation/models");
    expect(models.status).toBe(200);
    expect((await models.json()).items).toEqual([{ id: "published-image", displayName: "Published image", capability: "image", group: null }]);
    const intent = { modelId: textInput.modelId, input: { prompt: "synthetic text must not execute" }, parameters: {} };
    for (const parameters of [{}, { max_tokens: 8 }]) {
        const quote = await request("/api/v1/generation/quote", reader, { ...intent, parameters });
        expect(quote.status).toBe(400); expect((await quote.json()).error.code).toBe("unsupported_generation");
        const submit = await request("/api/v1/generation/tasks", reader, { ...intent, parameters, confirmedPriceVersion: 1 });
        expect(submit.status).toBe(400); expect((await submit.json()).error.code).toBe("unsupported_generation");
    }
    expect((await request("/api/v1/generation/tasks", reader, { ...intent, confirmedPriceVersion: 1 }, undefined, disabledApp)).status).toBe(503);
    expect(await resolveActiveGenerationPricing(database.db, { modelId: textInput.modelId })).toBeNull();
    await expect(quoteReserveAndEnqueueServerGenerationTask(database.db, queue, { ownerId: reader.id, modelId: textInput.modelId,
        inputSnapshot: intent.input, parameterSnapshot: { max_tokens: 8 }, idempotencyKey: "legacy-text-rejected", requestId: crypto.randomUUID() })).rejects.toThrow();
    // Defense-in-depth at the provider seam, using real publication/binding lookups and a synthetic, never-queued task.
    const syntheticTask: GenerationTaskView = { id: crypto.randomUUID(), ownerId: reader.id, spaceId: null, projectId: null, nodeId: null,
        inputSnapshot: intent.input, modelId: textInput.modelId, parameterSnapshot: { max_tokens: 8 }, priceVersion: 1,
        quotedUnits: 1, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 1, textQuoteSnapshot: null, pricePublicationId: null, idempotencyKey: "forged-text-scalar", reservationId: null,
        providerTaskId: null, executionStatus: "queued", deliveryStatus: "pending", billingStatus: "unbilled", unknownReason: null,
        requestId: crypto.randomUUID(), finishedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    let providerCalls = 0;
    const provider = createGenerationProvider({ database: database.db, authSecret: secret, gateway: { async request() { providerCalls++; throw new Error("Text execution must stay closed"); } } });
    expect(await provider(syntheticTask)).toEqual({ status: "failed", errorCode: "model_unavailable" });
    expect(providerCalls).toBe(0);
    expect(await businessState()).toEqual(before);
});

test("the legacy price writer cannot fabricate text publication and the existing image quote still reserves seven once", async () => {
    const before = await businessState();
    const fabricated = await request("/api/v1/admin/model-pricing", admin, { modelId: textInput.modelId, billingUnit: "text_tokens", creditsPerUnit: null, enabled: true });
    expect(fabricated.status).toBe(400);
    expect(await businessState()).toEqual(before);
    const intent = { modelId: "published-image", input: { prompt: "synthetic image intent" }, parameters: {} };
    const response = await request("/api/v1/generation/quote", reader, intent);
    expect(response.status).toBe(200);
    expect((await response.json()).quote).toMatchObject({ priceVersion: 1, billingUnit: "request", creditsPerUnit: 7, quotedUnits: 7, priceNote: "单张图片每次 7 积分" });
    const submission = { ...intent, confirmedPriceVersion: 1 }, key = "text-price-coexisting-image";
    const accepted = await request("/api/v1/generation/tasks", reader, submission, key);
    expect(accepted.status).toBe(201);
    const task = (await accepted.json()).task;
    expect(task).toMatchObject({ quotedUnits: 7, creditsPerUnitSnapshot: 7, billingUnitSnapshot: "request", billingStatus: "reserved" });
    expect(await createWalletRepository(database.db).get(reader.id)).toMatchObject({ availableUnits: "13", reservedUnits: "7", totalUnits: "20" });
    const after = await businessState();
    expect(after.queueSends).toBe(before.queueSends + 1);
    expect(after.reservations).toHaveLength(before.reservations.length + 1);
    expect(after.reservations.find((row) => row.taskId === task.id)).toMatchObject({ requestedUnits: "7", capturedUnits: "0", releasedUnits: "0" });
    expect((await request("/api/v1/generation/tasks", reader, submission, key)).status).toBe(200);
    expect(await businessState()).toEqual(after);
});
