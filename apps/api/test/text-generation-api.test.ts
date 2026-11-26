import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { deriveModelPriceRules, type ModelPriceDerivation, type ModelPriceBinding } from "@infinite-canvas/shared";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft, validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { generationTask, modelCatalog, modelProvider, officialPriceSource, officialPriceMapping, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import { createApp } from "../src/app";
import { createAccountApi } from "../src/accounts";
import { createGenerationProvider } from "../src/generation-provider";
import { createGenerationDelivery } from "../src/generation-delivery";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Only in-memory PGlite is permitted");
const origin = "http://localhost:4098", secret = `synthetic-text-api-${crypto.randomUUID()}`;
type Identity = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>, disabled: ReturnType<typeof createApp>;
let admin: Identity, alice: Identity, bob: Identity;
let rejectQueue = false, providerCalls = 0;
const jobs: GenerationJobPayload[] = [];
const modelId = "budget-text";
const binding: ModelPriceBinding = { providerId: "text-fixture", providerModel: "private-upstream", adapter: "sub2api", endpoint: "https://provider.invalid/v1", capability: "text" };
const intent = { modelId, input: { prompt: "Synthetic text only" }, parameters: {}, projectId: "synthetic-project", budgetCredits: "0.01" };
const submission = { ...intent, confirmedPriceVersion: 1 };
// Each business scenario below owns a fixed trusted test-network peer. Its
// submissions and replays share that peer; approved default limits stay enabled.
let peerIp = "198.51.100.41";
function request(path: string, identity = alice, body?: unknown, key = crypto.randomUUID(), handler = app, extra: Record<string, string> = {}, trustedPeer = peerIp) {
    return handler(new Request(new URL(path, origin), { method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: identity.cookie, "content-type": "application/json", "x-canvas-account-id": identity.id, "idempotency-key": key, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), trustedPeer);
}
async function register(label: string) {
    const identity = { id: "", cookie: "" }, email = `${label}-text-budget@example.test`, password = "synthetic-text-budget-password";
    expect((await request("/api/auth/sign-up/email", identity, { email, password, name: label })).status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const login = await request("/api/auth/sign-in/email", identity, { email, password });
    expect(login.status).toBe(200);
    return { id: row!.id, cookie: login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}
async function publish(version: number, inputRate: string, outputRate: string, cachedRate = inputRate, manual = false) {
    const entry = { id: "openai:synthetic-three", modelName: "Synthetic three bucket", context: "Synthetic standard; no real prices", rates: [
        { label: "Input", usdPerMillion: inputRate }, { label: "Cached", usdPerMillion: cachedRate }, { label: "Output", usdPerMillion: outputRate }] };
    const stamp = new Date("2026-10-25T00:00:00.000Z");
    await database.db.insert(officialPriceSource).values({ id: "openai", version, checkedAt: stamp, status: "ready", entries: [entry] })
        .onConflictDoUpdate({ target: officialPriceSource.id, set: { version, checkedAt: stamp, entries: [entry] } });
    await database.db.insert(officialPriceMapping).values({ modelId, referenceId: entry.id, version: 1,
        providerIdSnapshot: binding.providerId, providerModelSnapshot: binding.providerModel, adapterSnapshot: binding.adapter,
        endpointSnapshot: binding.endpoint, capabilitySnapshot: "text" }).onConflictDoNothing();
    const derivation: ModelPriceDerivation = { schemaVersion: 1, kind: "multiplier", binding, costMultiplier: null,
        saleMultiplier: "0.01", creditsPerCurrency: "100", basis: { template: "text_cached_tokens", currency: "USD",
            bands: [{ parameters: {}, rates: { input_token: inputRate, cached_input_token: cachedRate, output_token: outputRate } }] },
        source: { kind: "official", application: "fixed_baseline", sourceId: "openai", version, checkedAt: stamp.toISOString(), entry,
            mapping: { Input: "input_token", Cached: "cached_input_token", Output: "output_token" } } };
    const saved = await createModelPriceDraft(database.db, { modelId, expectedVersion: version - 1, binding, priceNote: "private cost note",
        rules: manual ? { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: inputRate, output_token: outputRate } }] } }
            : { ...deriveModelPriceRules(derivation)!, derivation } },
    { actorId: admin.id, requestId: crypto.randomUUID() });
    if (saved.status !== "saved") throw new Error(saved.status);
    const result = await publishModelPriceDraft(database.db, { modelId, draftId: saved.draft.id, expectedDraftVersion: version,
        expectedPriceVersion: version - 1, binding, publicPriceNote: cachedRate === undefined ? "按全部输入和输出计量；预算超出待核对" : "非缓存输入、缓存读取和输出分别计量；缓存写未适配" },
    { actorId: admin.id, requestId: crypto.randomUUID() });
    expect(result.status).toBe("published");
}
const state = async () => ({ tasks: await database.db.select().from(generationTask), reservations: await database.db.select().from(walletReservation),
    wallets: await database.db.select().from(wallet), ledger: await database.db.select().from(walletLedger), jobs: jobs.length });
beforeAll(async () => {
    database = await createTestDatabase();
    const rates = createRateStore(database.pool, secret);
    const options = { database: database.db, origin, auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { ...rates, async consume(bucket, identity, rule) { return bucket === "account-read" || bucket === "canvas-save" ? { allowed: true } : rates.consume(bucket, identity, rule); } } as typeof rates,
        verifyHuman: async () => true, onFault: () => undefined };
    const queue = { async send(_name: string, payload: GenerationJobPayload) { if (rejectQueue) throw new Error("synthetic queue unavailable"); jobs.push(payload); return crypto.randomUUID(); } };
    app = createApp(createAccountApi({ ...options, generation: { enabled: true, imageEnabled: false, textEnabled: true, queue } }), "synthetic-site-key", false, false, undefined, { text: true });
    disabled = createApp(createAccountApi({ ...options, generation: { enabled: true, queue } }), "synthetic-site-key");
    admin = await register("admin"); alice = await register("alice"); bob = await register("bob");
    await database.db.insert(wallet).values({ userId: alice.id, availableUnits: "10" });
    await database.db.insert(modelProvider).values({ id: binding.providerId, displayName: "Synthetic", adapter: binding.adapter, endpoint: binding.endpoint, secretRef: "test", enabled: true });
    await saveProviderCredential(database.db, secret, binding.providerId, "synthetic-credential");
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, displayName: "Text fixture", capability: "text", enabled: true, providerId: binding.providerId, providerModel: binding.providerModel });
    await publish(1, "1", "2");
});
afterAll(async () => { await database?.close(); });

test("text catalog and exact quote are separately gated, read-only and omit private configuration", async () => {
    peerIp = "198.51.100.51";
    const before = await state();
    expect((await request("/api/v1/generation/text/models", alice, undefined, "unused", disabled)).status).toBe(503);
    expect((await request("/api/v1/generation/models")).status).toBe(503);
    expect(await (await request("/api/v1/generation/text/models")).json()).toMatchObject({ items: [{ id: modelId, capability: "text", group: null }] });
    const response = await request("/api/v1/generation/text/quote", alice, intent);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.quote).toMatchObject({ budgetCredits: "0.01", priceVersion: 1, billingUnit: "text_tokens", inputCreditsPerMillion: "1", outputCreditsPerMillion: "2", usageSource: "responses" });
    expect(JSON.stringify(data)).not.toMatch(/private-upstream|private cost note|synthetic-credential|provider.invalid/);
    for (const body of [{ ...intent, budgetCredits: 1 }, { ...intent, budgetCredits: "0" }, { ...intent, budgetCredits: "-1" },
        { ...intent, quotedUnits: 1 }, { ...intent, parameters: { max_tokens: 1 } }]) expect((await request("/api/v1/generation/text/quote", alice, body)).status).toBe(400);
    expect(await state()).toEqual(before);
});

let firstId: string;
test("confirmed budget submits once, enforces account context and rejects changed replay intent", async () => {
    peerIp = "198.51.100.52";
    const response = await request("/api/v1/generation/text/tasks", alice, submission, "text-once");
    expect(response.status).toBe(201);
    const data = await response.json(); firstId = data.task.id;
    expect(data.task).toMatchObject({ quotedUnits: null, billingStatus: "reserved", textQuoteSnapshot: { budgetCredits: "0.01", usageSource: "responses" },
        billing: { reservedCredits: "0.01", capturedCredits: "0", releasedCredits: "0" } });
    expect(data.task).not.toHaveProperty("pricePublicationId");
    const replay = await request("/api/v1/generation/text/tasks", alice, submission, "text-once", app, {}, "198.51.100.52");
    expect(replay.status).toBe(200); expect((await replay.json()).task.id).toBe(firstId); expect(jobs).toHaveLength(1);
    expect((await request("/api/v1/generation/text/tasks", alice, { ...submission, budgetCredits: "0.02" }, "text-once")).status).toBe(409);
    expect((await request(`/api/v1/generation/tasks/${firstId}`, bob)).status).toBe(404);
    expect((await request("/api/v1/generation/text/quote", alice, intent, "unused", app, { "x-canvas-account-id": bob.id })).status).toBe(409);
    expect((await request("/api/v1/generation/text/quote", alice, intent, "unused", app, { origin: "https://other.invalid" })).status).toBe(403);
    expect((await request("/api/v1/generation/text/tasks", bob, submission, "insufficient")).status).toBe(402);
    expect(jobs).toHaveLength(1);
});

async function execute(job: GenerationJobPayload, missingUsage = false, inputDetails: Record<string, unknown> = { cached_tokens: 300, cache_write_tokens: 0 }) {
    return processGenerationJob(database.db, job, { provider: createGenerationProvider({ database: database.db, authSecret: secret,
        gateway: { async request(input) {
            providerCalls++;
            expect(input.path).toBe("responses");
            expect(input.body).not.toHaveProperty("budgetCredits");
            return { status: "succeeded", upstreamStatus: 200, payload: { id: "private-response-id", status: "completed",
                output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "A synthetic result" }] }],
                ...(missingUsage ? {} : { usage: { input_tokens: 400, output_tokens: 200, total_tokens: 600,
                    input_tokens_details: inputDetails, output_tokens_details: { reasoning_tokens: 100 } } }) } };
        } } }), deliver: createGenerationDelivery(), settleBilling: createGenerationWalletSettlement(database.db) });
}
test("API submission to provider and saved text settles exact cost once and releases unused budget", async () => {
    peerIp = "198.51.100.53";
    const completed = await execute(jobs[0]);
    expect(completed.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    const view = await (await request(`/api/v1/generation/tasks/${firstId}`)).json();
    expect(view.task.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0.0008", releasedCredits: "0.0092" });
    expect(view.result.resultSnapshot).toMatchObject({ kind: "text", text: "A synthetic result", usageEvidence: { source: "responses", cachedInputTokens: 300, reasoningOutputTokens: 100 } });
    expect(JSON.stringify(view)).not.toMatch(/private-response-id|private-upstream|synthetic-credential|private cost note/);
    const before = await state(); await execute(jobs[0]); expect(await state()).toEqual(before); expect(providerCalls).toBe(1);
    expect(await createWalletRepository(database.db).get(alice.id)).toMatchObject({ availableUnits: "9.9992", reservedUnits: "0" });
});

test("missing usage and over-budget costs keep reservations pending without extra debits", async () => {
    peerIp = "198.51.100.54";
    for (const [key, budgetCredits, missing] of [["over-budget", "0.0001", false], ["missing-usage", "0.01", true]] as const) {
        expect((await request("/api/v1/generation/text/tasks", alice, { ...submission, budgetCredits }, key)).status).toBe(201);
        const completed = await execute(jobs.at(-1)!, missing);
        expect(completed.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "pending_review" });
        const view = await (await request(`/api/v1/generation/tasks/${completed.task.id}`)).json();
        expect(view.task.billing).toEqual({ reservedCredits: budgetCredits, capturedCredits: "0", releasedCredits: "0" });
        expect(view.result.resultSnapshot.text).toBe("A synthetic result");
    }
});

test("queue failure rolls back the task and budget; price changes require confirmation without breaking accepted replay", async () => {
    peerIp = "198.51.100.55";
    const before = await state(); rejectQueue = true;
    expect((await request("/api/v1/generation/text/tasks", alice, submission, "queue-failed")).status).toBe(503);
    rejectQueue = false; expect(await state()).toEqual(before);
    await publish(2, "3", "4");
    const rotated = await state();
    const stale = await request("/api/v1/generation/text/tasks", alice, submission, "stale-quote");
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("price_changed");
    expect(await state()).toEqual(rotated);
    const replay = await request("/api/v1/generation/text/tasks", alice, submission, "text-once", app, {}, "198.51.100.52");
    expect(replay.status).toBe(200); expect((await replay.json()).task.textQuoteSnapshot.inputCreditsPerMillion).toBe("1");
    expect(await state()).toEqual(rotated);
});

test("cache-read publication flows through public price, budget quote, immutable task and exact settlement", async () => {
    peerIp = "198.51.100.56";
    await publish(3, "2", "4", "0.5");
    const before = await state();
    const prices = await (await request("/api/v1/model-pricing")).json();
    const price = prices.items.find((row: { modelId: string }) => row.modelId === modelId);
    expect(price).toMatchObject({ version: 3, billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: "2", cachedInputCreditsPerMillion: "0.5", outputCreditsPerMillion: "4" });
    expect(JSON.stringify(price)).not.toMatch(/private-upstream|private cost note|synthetic-credential|provider.invalid|rules/);
    const quoted = await (await request("/api/v1/generation/text/quote", alice, intent)).json();
    expect(quoted.quote).toMatchObject({ priceVersion: 3, budgetCredits: "0.01", inputCreditsPerMillion: "2",
        cachedInputCreditsPerMillion: "0.5", outputCreditsPerMillion: "4", usageSource: "responses" });
    expect(await state()).toEqual(before);
    const accepted = await request("/api/v1/generation/text/tasks", alice, { ...intent, confirmedPriceVersion: 3 }, "cached-once");
    expect(accepted.status).toBe(201);
    const item = (await accepted.json()).task;
    expect(item.textQuoteSnapshot).toMatchObject({ budgetCredits: "0.01", cachedInputCreditsPerMillion: "0.5" });
    expect(Object.keys(item.textQuoteSnapshot).sort()).toEqual(["schemaVersion", "budgetCredits", "inputCreditsPerMillion", "cachedInputCreditsPerMillion", "outputCreditsPerMillion", "usageSource"].sort());
    expect(item.textQuoteSnapshot).not.toHaveProperty("textPriceDerivation");
    expect(item.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0", releasedCredits: "0" });
    for (const cachedRate of [undefined, null, "0", "0.6"]) {
        const quote = { ...item.textQuoteSnapshot };
        if (cachedRate === undefined) delete quote.cachedInputCreditsPerMillion;
        else quote.cachedInputCreditsPerMillion = cachedRate;
        await expect(database.db.insert(generationTask).values({ id: crypto.randomUUID(), ownerId: alice.id, modelId,
            inputSnapshot: { prompt: "synthetic" }, parameterSnapshot: {}, priceVersion: 3, textQuoteSnapshot: quote,
            idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }).execute()).rejects.toThrow();
    }
    await expect(database.db.update(generationTask).set({ textQuoteSnapshot: { ...item.textQuoteSnapshot, cachedInputCreditsPerMillion: "0.6" } })
        .where(eq(generationTask.id, item.id)).execute()).rejects.toThrow();
    await execute(jobs.at(-1)!, false, { cached_tokens: 300, cache_write_tokens: 0 });
    const completed = await (await request(`/api/v1/generation/tasks/${item.id}`)).json();
    // (400 - 300) * 2 + 300 * 0.5 + 200 * 4, once per million.
    expect(completed.task.billingStatus).toBe("captured");
    expect(completed.task.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0.00115", releasedCredits: "0.00885" });
    expect(completed.result.resultSnapshot.usageEvidence).toMatchObject({ cachedInputTokens: 300, cacheWriteTokens: 0 });
    const once = await state(), calls = providerCalls;
    await execute(jobs.at(-1)!, false, { cached_tokens: 300, cache_write_tokens: 0 });
    expect(await state()).toEqual(once); expect(providerCalls).toBe(calls);
    const replay = await request("/api/v1/generation/text/tasks", alice, submission, "text-once", app, {}, "198.51.100.52");
    expect(replay.status).toBe(200);
    expect((await replay.json()).task.textQuoteSnapshot.cachedInputCreditsPerMillion).toBe("1");
});

test("cache tariff holds incomplete read/write evidence, unsupported writes and above-budget charges for review", async () => {
    peerIp = "198.51.100.57";
    for (const [key, budgetCredits, details] of [
        ["missing-read", "0.01", { cache_write_tokens: 0 }],
        ["missing-write", "0.01", { cached_tokens: 300 }],
        ["null-write", "0.01", { cached_tokens: 300, cache_write_tokens: null }],
        ["contradictory-read", "0.01", { cached_tokens: 401, cache_write_tokens: 0 }],
        ["positive-write", "0.01", { cached_tokens: 300, cache_write_tokens: 1 }],
        ["over", "0.0001", { cached_tokens: 300, cache_write_tokens: 0 }],
    ] as const) {
        const response = await request("/api/v1/generation/text/tasks", alice, { ...intent, budgetCredits, confirmedPriceVersion: 3 }, `cached-${key}`);
        expect(response.status).toBe(201);
        const { task } = await response.json();
        const afterReservation = await state();
        const completed = await execute(jobs.at(-1)!, false, details);
        expect(completed.task.billingStatus).toBe("pending_review");
        const view = await (await request(`/api/v1/generation/tasks/${task.id}`)).json();
        expect(view.task.billing).toEqual({ reservedCredits: budgetCredits, capturedCredits: "0", releasedCredits: "0" });
        expect(view.result.resultSnapshot.text).toBe("A synthetic result");
        const after = await state();
        expect(after.wallets).toEqual(afterReservation.wallets); expect(after.ledger).toEqual(afterReservation.ledger);
    }
});

test("an accepted cache-price task retains its historical publication and settles old rates after a newer cache price", async () => {
    peerIp = "198.51.100.58";
    const key = "cached-historical", acceptedBody = { ...intent, confirmedPriceVersion: 3 };
    const response = await request("/api/v1/generation/text/tasks", alice, acceptedBody, key);
    expect(response.status).toBe(201);
    const { task } = await response.json(), job = jobs.at(-1)!;
    const [accepted] = await database.db.select().from(generationTask).where(eq(generationTask.id, task.id));
    expect(accepted!.priceVersion).toBe(3);
    expect(accepted!.pricePublicationId).not.toBeNull();
    expect(accepted!.textQuoteSnapshot).toMatchObject({ cachedInputCreditsPerMillion: "0.5" });
    expect(task.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0", releasedCredits: "0" });

    await publish(4, "2", "4", "0.25");
    const quote = await (await request("/api/v1/generation/text/quote", alice, intent)).json();
    expect(quote.quote).toMatchObject({ priceVersion: 4, cachedInputCreditsPerMillion: "0.25" });
    expect(await validatePublishedGenerationTask(database.db, accepted!, binding)).toBe(true);
    await execute(job, false, { cached_tokens: 300, cache_write_tokens: 0 });
    const [finished] = await database.db.select().from(generationTask).where(eq(generationTask.id, task.id));
    expect(finished!.pricePublicationId).toBe(accepted!.pricePublicationId);
    expect(finished!.textQuoteSnapshot).toEqual(accepted!.textQuoteSnapshot);
    expect(finished!.priceVersion).toBe(3);
    expect(await validatePublishedGenerationTask(database.db, finished!, binding)).toBe(true);
    const view = await (await request(`/api/v1/generation/tasks/${task.id}`)).json();
    expect(view.task.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0.00115", releasedCredits: "0.00885" });

    const settled = await state(), calls = providerCalls;
    const replay = await request("/api/v1/generation/text/tasks", alice, acceptedBody, key);
    expect(replay.status).toBe(200);
    expect((await replay.json()).task).toMatchObject({ id: task.id, priceVersion: 3,
        textQuoteSnapshot: { cachedInputCreditsPerMillion: "0.5" }, billingStatus: "captured" });
    await execute(job, false, { cached_tokens: 300, cache_write_tokens: 0 });
    expect(await state()).toEqual(settled);
    expect(providerCalls).toBe(calls);
});

test("a source refresh never reprices frozen admissions; missing or changed mapping rejects only new admissions", async () => {
    peerIp = "198.51.100.59";
    const acceptedBody = { ...intent, confirmedPriceVersion: 4 }, key = "mapping-frozen";
    expect((await request("/api/v1/generation/text/tasks", alice, acceptedBody, key)).status).toBe(201);
    const job = jobs.at(-1)!;
    const oldQuote = (await (await request("/api/v1/generation/text/quote", alice, intent)).json()).quote;
    expect(oldQuote.textPriceDerivation).toMatchObject({ priceVersion: 4, sourceVersion: 4, saleMultiplier: "0.01" });
    await database.db.update(officialPriceSource).set({ version: 55, checkedAt: new Date("2026-10-29T00:00:00Z"), entries: [] }).where(eq(officialPriceSource.id, "openai"));
    expect((await (await request("/api/v1/generation/text/quote", alice, intent)).json()).quote).toEqual(oldQuote);
    const [mapping] = await database.db.select().from(officialPriceMapping).where(eq(officialPriceMapping.modelId, modelId));
    for (const action of ["changed", "missing"] as const) {
        if (action === "changed") await database.db.update(officialPriceMapping).set({ providerModelSnapshot: "wrong" }).where(eq(officialPriceMapping.modelId, modelId));
        else await database.db.delete(officialPriceMapping).where(eq(officialPriceMapping.modelId, modelId));
        const before = await state();
        expect((await request("/api/v1/generation/text/quote", alice, intent)).status).toBe(400);
        expect((await request("/api/v1/generation/text/tasks", alice, acceptedBody, `new-${action}`)).status).toBe(400);
        expect((await (await request("/api/v1/generation/text/models")).json()).items).toEqual([]);
        const replay = await request("/api/v1/generation/text/tasks", alice, acceptedBody, key);
        expect(replay.status).toBe(200); expect((await replay.json()).task.priceVersion).toBe(4);
        expect((await request("/api/v1/generation/text/tasks", bob, acceptedBody, key)).status).toBe(400);
        expect(await state()).toEqual(before);
    }
    await execute(job);
    const view = await (await request(`/api/v1/generation/tasks/${job.taskId}`)).json();
    expect(view.task.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0.001075", releasedCredits: "0.008925" });
    expect(view.task.textQuoteSnapshot).not.toHaveProperty("textPriceDerivation");
    await database.db.insert(officialPriceMapping).values(mapping!);
});

test("legacy all-input accepted requests recover by original owner/key, while new legacy requests have no fallback", async () => {
    peerIp = "198.51.100.60";
    await publish(5, "1", "2", "1", true);
    const tasks = createGenerationTaskRepository(database.db), wallets = createWalletRepository(database.db), key = "legacy-no-derivation";
    const textQuoteSnapshot = { schemaVersion: 1 as const, budgetCredits: "0.01", inputCreditsPerMillion: "1", outputCreditsPerMillion: "2", usageSource: "responses" as const };
    const created = await tasks.create({ ownerId: alice.id, modelId, projectId: intent.projectId, inputSnapshot: intent.input,
        parameterSnapshot: {}, priceVersion: 5, textQuoteSnapshot, idempotencyKey: key, requestId: key });
    const reservation = await wallets.reserve({ userId: alice.id, requestedUnits: "0.01", taskId: created.task.id,
        idempotencyKey: `g:${key}`, referenceType: "generation", referenceId: created.task.id });
    await tasks.setReservationId({ ownerId: alice.id, taskId: created.task.id, reservationId: reservation.id });
    await tasks.transitionBilling({ ownerId: alice.id, taskId: created.task.id, status: "reserved" });
    await tasks.transitionExecution({ ownerId: alice.id, taskId: created.task.id, status: "queued" });
    const before = await state(), body = { ...intent, confirmedPriceVersion: 5 };
    expect((await request("/api/v1/generation/text/quote", alice, intent)).status).toBe(400);
    expect((await request("/api/v1/generation/text/tasks", alice, body, "legacy-new-key")).status).toBe(400);
    const replay = await request("/api/v1/generation/text/tasks", alice, body, key);
    expect(replay.status).toBe(200); expect((await replay.json()).task).toMatchObject({ id: created.task.id, priceVersion: 5, textQuoteSnapshot });
    expect((await request("/api/v1/generation/text/tasks", bob, body, key)).status).toBe(400);
    expect((await request(`/api/v1/generation/tasks/${created.task.id}`, bob)).status).toBe(404);
    expect(await state()).toEqual(before);
    await execute({ schemaVersion: 1, taskId: created.task.id, ownerId: alice.id, requestId: key });
    const view = await (await request(`/api/v1/generation/tasks/${created.task.id}`)).json();
    expect(view.task.billing).toEqual({ reservedCredits: "0.01", capturedCredits: "0.0008", releasedCredits: "0.0092" });
});
