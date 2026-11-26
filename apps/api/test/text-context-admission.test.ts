import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { validatePublishedGenerationTask } from "@infinite-canvas/database/model-price-publications";
import { auditEvent, generationTask, modelCatalog, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, officialPriceMapping,
    officialPriceSource, rateLimit, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { deriveModelPriceRules, type ModelPriceDerivationV2 } from "../../../packages/shared/src/model-price-derivation";
import { composeTextContextTierNote } from "../../../packages/shared/src/model-price-publications";
import { normalizeResponsesUsage } from "../../../packages/shared/src/text-usage";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL || process.env.SAAS_CONTEXT_PG_URL) throw new Error("This HTTP fixture only accepts its own in-memory PGlite");
const origin = "http://localhost:4091", secret = `context-admission-${crypto.randomUUID()}`;
const draftsPath = "/api/v1/admin/model-price-drafts", publicationPath = "/api/v1/admin/model-price-publications";
type Identity = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>, app: ReturnType<typeof createApp>, singleConsumeApp: ReturnType<typeof createApp>;
let admin: Identity, alice: Identity, bob: Identity;
const jobs: GenerationJobPayload[] = [];
const binding = { providerId: "context-http-provider", providerModel: "private-sol", adapter: "sub2api" as const,
    endpoint: "https://provider.invalid/v1", capability: "text" as const };
const labels = ["短上下文输入", "短上下文输出", "短上下文缓存读取", "短上下文缓存写入（30 分钟）", "短上下文缓存写入（12 小时）",
    "长上下文输入", "长上下文输出", "长上下文缓存读取", "长上下文缓存写入（30 分钟）", "长上下文缓存写入（12 小时）"];
const amounts = ["2", "10", "0.1", "2.5", "5", "4", "15", "0.2", "5", "10"];
const derivation = (): ModelPriceDerivationV2 => ({ schemaVersion: 2, kind: "multiplier", binding, costMultiplier: null,
    saleMultiplier: "0.36", creditsPerCurrency: "100", basis: { template: "text_cached_tokens", currency: "USD",
        bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.1", output_token: "10" } }] },
    source: { kind: "official", application: "context_tiers", sourceId: "openai", version: 1, checkedAt: "2026-10-29T00:00:00.000Z",
        entry: { id: "openai:gpt-6.1-sol", modelName: "gpt-6.1-sol", context: "官方输入阈值272K；平台按输入与输出总量判档。合成测试。",
            rates: labels.map((label, i) => ({ label, usdPerMillion: amounts[i] })) },
        selection: { metric: "total_tokens", shortMaxTotalTokens: 272000,
            short: { "短上下文输入": "input_token", "短上下文缓存读取": "cached_input_token", "短上下文输出": "output_token" },
            long: { "长上下文输入": "input_token", "长上下文缓存读取": "cached_input_token", "长上下文输出": "output_token" } } } });
function rules(d = derivation()) { return { ...deriveModelPriceRules(d)!, derivation: d }; }
function intent(modelId: string) { return { modelId, input: { prompt: "Synthetic context HTTP test" }, parameters: {}, projectId: "context-http-project", budgetCredits: "100" }; }
// Fixed trusted peers isolate business scenarios without disabling default limits.
let peerIp = "198.51.100.71";
function request(path: string, identity = alice, body?: unknown, key = crypto.randomUUID(), extra: Record<string, string> = {}, handler = app, trustedPeer = peerIp) {
    return handler(new Request(new URL(path, origin), { method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: identity.cookie, "content-type": "application/json", "x-canvas-account-id": identity.id, "idempotency-key": key, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), trustedPeer);
}
async function register(label: string) {
    const empty = { id: "", cookie: "" }, email = `context-http-${label}@example.test`, password = "synthetic-context-http-password";
    expect((await request("/api/auth/sign-up/email", empty, { email, password, name: label })).status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const response = await request("/api/auth/sign-in/email", empty, { email, password }); expect(response.status).toBe(200);
    return { id: row!.id, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}
async function source(d = derivation()) {
    await database.db.insert(officialPriceSource).values({ id: "openai", version: d.source.version, checkedAt: new Date(d.source.checkedAt), status: "ready", entries: [d.source.entry] })
        .onConflictDoUpdate({ target: officialPriceSource.id, set: { version: d.source.version, checkedAt: new Date(d.source.checkedAt), entries: [d.source.entry] } });
}
async function seed(suffix: string, modelBinding = binding) {
    const modelId = `context-http-${suffix}`;
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, displayName: suffix, providerId: modelBinding.providerId,
        providerModel: modelBinding.providerModel, capability: "text", enabled: true });
    await database.db.insert(officialPriceMapping).values({ modelId, referenceId: derivation().source.entry.id, version: 1,
        providerIdSnapshot: modelBinding.providerId, providerModelSnapshot: modelBinding.providerModel, adapterSnapshot: modelBinding.adapter,
        endpointSnapshot: modelBinding.endpoint, capabilitySnapshot: "text" });
    return modelId;
}
const businessState = async () => ({ tasks: await database.db.select().from(generationTask), reservations: await database.db.select().from(walletReservation),
    wallets: await database.db.select().from(wallet), ledger: await database.db.select().from(walletLedger), jobs: jobs.length });
const priceState = async () => ({ drafts: await database.db.select().from(modelPriceDraft), prices: await database.db.select().from(modelPricing),
    publications: await database.db.select().from(modelPricePublication), audit: await database.db.select().from(auditEvent) });
async function save(modelId: string, d = derivation(), expectedVersion = 0) {
    const response = await request(draftsPath, admin, { modelId, expectedVersion, binding, rules: rules(d), priceNote: "private procurement note" });
    expect(response.status).toBe(201); return (await response.json()).draft;
}
function publication(modelId: string, draftId: string, version = 1, d = derivation()) {
    return { modelId, draftId, expectedDraftVersion: version, expectedPriceVersion: version - 1, binding,
        publicPriceNote: composeTextContextTierNote(rules(d), binding, "HTTP fixture")! };
}
async function publish(modelId: string, draftId: string, version = 1, d = derivation()) {
    const response = await request(publicationPath, admin, publication(modelId, draftId, version, d)); expect(response.status).toBe(200);
    return (await response.json()).publication;
}
beforeAll(async () => {
    database = await createTestDatabase(); const rates = createRateStore(database.pool, secret);
    const options: Parameters<typeof createAccountApi>[0] = { database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { ...rates, consume: ((bucket, identity, rule) => bucket === "account-read" || bucket === "canvas-save"
            ? Promise.resolve({ allowed: true }) : rates.consume(bucket, identity, rule)) as typeof rates.consume },
        verifyHuman: async () => true, onFault: () => undefined,
        generation: { enabled: true, imageEnabled: false, textEnabled: true, queue: { async send(name, payload, supplied) {
            expect(name).toBe("generation"); expect(supplied?.db).toBeDefined(); jobs.push(structuredClone(payload)); return crypto.randomUUID();
        } } } };
    app = createApp(createAccountApi(options), "synthetic-site-key", false, false, undefined, { text: true });
    singleConsumeApp = createApp(createAccountApi({ ...options, rates: { consume: options.rates.consume } }), "synthetic-site-key", false, false, undefined, { text: true });
    admin = await register("admin"); alice = await register("alice"); bob = await register("bob");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await database.db.insert(wallet).values([{ userId: alice.id, availableUnits: "10000" }, { userId: bob.id, availableUnits: "10000" }]);
    await database.db.insert(modelProvider).values({ id: binding.providerId, displayName: "Synthetic context", adapter: binding.adapter,
        endpoint: binding.endpoint, secretRef: "private-ref", enabled: true });
    await saveProviderCredential(database.db, secret, binding.providerId, "private-provider-credential"); await source();
});
afterAll(async () => { await database?.close(); });

let modelId: string, draftId: string, publicationId: string, taskId: string;
test("authenticated v2 save rejects missing, duplicate, cross-tier and TTL-tampered complete source without writes", async () => {
    peerIp = "198.51.100.72";
    modelId = await seed("main"); const initial = { modelId, expectedVersion: 0, binding, rules: rules(), priceNote: "fixture" };
    const before = await priceState();
    expect((await request(draftsPath, alice, initial)).status).toBe(403);
    expect((await request(draftsPath, admin, initial, "unused", { "x-canvas-account-id": bob.id })).status).toBe(409);
    const patches = [
        (d: ModelPriceDerivationV2) => { delete d.source.selection.long["长上下文输出"]; },
        (d: ModelPriceDerivationV2) => { d.source.selection.long["长上下文输出"] = "input_token"; },
        (d: ModelPriceDerivationV2) => { delete d.source.selection.long["长上下文输入"]; d.source.selection.long["短上下文输入"] = "input_token"; },
        (d: ModelPriceDerivationV2) => { d.source.entry.rates.splice(8, 1); },
        (d: ModelPriceDerivationV2) => { delete d.source.selection.long["长上下文输入"]; d.source.selection.long["长上下文缓存写入（12 小时）"] = "input_token"; },
    ];
    for (const patch of patches) {
        const d = derivation(); patch(d);
        expect((await request(draftsPath, admin, { ...initial, rules: { ...initial.rules, derivation: d } })).status).toBe(400);
        expect(await priceState()).toEqual(before);
    }
    const tampered = derivation(); tampered.source.entry.rates[3].usdPerMillion = "999";
    const refused = await request(draftsPath, admin, { ...initial, rules: rules(tampered) });
    expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("price_derivation_source_changed");
    expect(await priceState()).toEqual(before);
    draftId = (await save(modelId)).id;
});

test("publish rejects a missing mandatory note, preserves final note exactly and replays only one immutable publication", async () => {
    peerIp = "198.51.100.73";
    const body = publication(modelId, draftId), before = await priceState();
    expect((await request(publicationPath, alice, body)).status).toBe(403);
    expect((await request(publicationPath, admin, { ...body, publicPriceNote: "Only an optional admin comment" })).status).toBe(409);
    expect(await priceState()).toEqual(before);
    const first = await publish(modelId, draftId); publicationId = first.id;
    expect(first.publicPriceNote).toBe(body.publicPriceNote); expect(first.rules.derivation.source.entry.rates).toHaveLength(10);
    const saved = await priceState(), replay = await publish(modelId, draftId);
    expect(replay.id).toBe(publicationId); expect(replay.publicPriceNote).toBe(body.publicPriceNote); expect(await priceState()).toEqual(saved);
});

test("free authenticated quote returns short rates and same mandatory note without business side effects", async () => {
    peerIp = "198.51.100.74";
    const before = await businessState();
    const response = await request("/api/v1/generation/text/quote", alice, intent(modelId)); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.quote).toMatchObject({ priceVersion: 1, inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360", budgetCredits: "100" });
    expect(data.quote.priceNote).toBe(publication(modelId, draftId).publicPriceNote); expect(data.quote.priceNote).toContain("超过272K按长档计价");
    expect(JSON.stringify(data)).not.toMatch(/private-sol|private procurement|private-provider|provider.invalid|binding|costMultiplier/);
    expect(await businessState()).toEqual(before);
});

test("quote and first submit refuse omitted note or incomplete selected rows in explicitly bypassed isolated fixtures", async () => {
    peerIp = "198.51.100.75";
    // Direct SQL here demonstrates the documented trust boundary: the old SQL
    // validates the short sale/publication shape, not the new application policy.
    // No existing source is mutated and no trigger is disabled.
    for (const fault of ["missing-note", "missing-long"] as const) {
        const badBinding = { ...binding, providerModel: `${binding.providerModel}-${fault}` };
        const id = await seed(fault, badBinding), d = derivation(); d.binding = badBinding;
        const fixed = rules(d);
        const badRules = structuredClone(fixed);
        if (fault === "missing-long") delete badRules.derivation.source.selection.long["长上下文输出"];
        const did = crypto.randomUUID(), pid = crypto.randomUUID(), pubid = crypto.randomUUID();
        await database.db.transaction(async tx => {
            await tx.insert(modelPriceDraft).values({ id: did, modelId: id, version: 1, rules: badRules, priceNote: "isolated bypass fixture",
                providerIdSnapshot: badBinding.providerId, providerModelSnapshot: badBinding.providerModel, adapterSnapshot: badBinding.adapter,
                endpointSnapshot: badBinding.endpoint, capabilitySnapshot: "text" });
            await tx.insert(modelPricing).values({ id: pid, modelId: id, version: 1, billingUnit: "text_tokens", creditsPerUnit: null, effectiveFrom: new Date(), enabled: true });
            await tx.insert(modelPricePublication).values({ id: pubid, pricingId: pid, draftId: did,
                publicPriceNote: fault === "missing-note" ? "omitted required policy" : composeTextContextTierNote(fixed, badBinding, "fixture")! });
        });
        const before = await businessState();
        for (const route of ["quote", "tasks"]) {
            const response = await request(`/api/v1/generation/text/${route}`, alice, { ...intent(id), ...(route === "tasks" ? { confirmedPriceVersion: 1 } : {}) }, `bad-${fault}-${route}`);
            expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("unsupported_generation");
            expect(await businessState()).toEqual(before);
        }
    }
});

test("first submit revalidates mapping after successful quote without reserving or enqueuing on changed binding", async () => {
    peerIp = "198.51.100.76";
    expect((await request("/api/v1/generation/text/quote", alice, intent(modelId))).status).toBe(200);
    await database.db.update(officialPriceMapping).set({ providerModelSnapshot: "changed-mapping" }).where(eq(officialPriceMapping.modelId, modelId));
    const before = await businessState();
    const response = await request("/api/v1/generation/text/tasks", alice, { ...intent(modelId), confirmedPriceVersion: 1 }, "changed-after-quote");
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("unsupported_generation"); expect(await businessState()).toEqual(before);
    await database.db.update(officialPriceMapping).set({ providerModelSnapshot: binding.providerModel }).where(eq(officialPriceMapping.modelId, modelId));
});

test("an HTTP store missing compound consume rejects before task, reservation, ledger, queue or rate writes", async () => {
    peerIp = "198.51.100.77";
    const before = await businessState(), beforeRates = await database.db.select().from(rateLimit);
    const response = await request("/api/v1/generation/text/tasks", alice, { ...intent(modelId), confirmedPriceVersion: 1 }, "missing-compound", {}, singleConsumeApp);
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("service_unavailable");
    expect(await businessState()).toEqual(before); expect(await database.db.select().from(rateLimit)).toEqual(beforeRates);
});

test("concurrent same-key authenticated submits bind one publication, reservation, ledger freeze and queue payload", async () => {
    peerIp = "198.51.100.78";
    const before = await businessState(), body = { ...intent(modelId), confirmedPriceVersion: 1 };
    const replies = await Promise.all([request("/api/v1/generation/text/tasks", alice, body, "concurrent-v2"), request("/api/v1/generation/text/tasks", alice, body, "concurrent-v2")]);
    expect(replies.map(response => response.status).sort()).toEqual([200, 201]);
    const data = await Promise.all(replies.map(response => response.json())); taskId = data[0].task.id;
    expect(data[1].task.id).toBe(taskId); expect(data[0].task.textQuoteSnapshot).toMatchObject({ schemaVersion: 1, inputCreditsPerMillion: "72", budgetCredits: "100" });
    const after = await businessState();
    expect(after.tasks.length - before.tasks.length).toBe(1); expect(after.reservations.length - before.reservations.length).toBe(1);
    expect(after.ledger.length - before.ledger.length).toBe(1); expect(after.jobs - before.jobs).toBe(1);
    expect(after.tasks.find(task => task.id === taskId)).toMatchObject({ ownerId: alice.id, pricePublicationId: publicationId, priceVersion: 1 });
    expect(after.wallets.find(row => row.userId === alice.id)).toMatchObject({ availableUnits: "9900", reservedUnits: "100" });
    expect((await request(`/api/v1/generation/tasks/${taskId}`, bob)).status).toBe(404);
    expect((await request("/api/v1/generation/tasks/by-key/concurrent-v2", bob)).status).toBe(404);
});

test("new source, new price and current binding changes preserve accepted owner replay and original long explanation", async () => {
    peerIp = "198.51.100.79";
    const next = derivation(); next.source.version = 2; next.saleMultiplier = "0.5"; await source(next);
    const draft = await save(modelId, next, 1); await publish(modelId, draft.id, 2, next);
    expect((await (await request("/api/v1/generation/text/quote", alice, intent(modelId))).json()).quote.inputCreditsPerMillion).toBe("100");
    const beforeStale = await businessState();
    expect((await request("/api/v1/generation/text/tasks", alice, { ...intent(modelId), confirmedPriceVersion: 1 }, "stale-first-submit")).status).toBe(409);
    expect(await businessState()).toEqual(beforeStale);
    await database.db.update(officialPriceSource).set({ version: 99, entries: [] }).where(eq(officialPriceSource.id, "openai"));
    await database.db.update(modelCatalog).set({ providerModel: "current-binding-changed" }).where(eq(modelCatalog.id, modelId));
    const beforeReplay = await businessState();
    const replay = await request("/api/v1/generation/text/tasks", alice, { ...intent(modelId), confirmedPriceVersion: 1 }, "concurrent-v2", {}, app, "198.51.100.78");
    expect(replay.status).toBe(200); expect((await replay.json()).task).toMatchObject({ id: taskId, priceVersion: 1, textQuoteSnapshot: { inputCreditsPerMillion: "72" } });
    expect(await businessState()).toEqual(beforeReplay);
    const [original] = await database.db.select().from(generationTask).where(eq(generationTask.id, taskId));
    expect(await validatePublishedGenerationTask(database.db, original!, { ...binding, providerModel: "current-binding-changed" })).toBe(false);
    await database.db.update(modelCatalog).set({ providerModel: binding.providerModel }).where(eq(modelCatalog.id, modelId));
    const job = jobs.find(job => job.taskId === taskId)!;
    let calls = 0;
    const deps = { provider: async () => { calls++; return { status: "succeeded" as const, resultSnapshot: { kind: "text", text: "Synthetic completed text",
        usageEvidence: normalizeResponsesUsage({ input_tokens: 272000, output_tokens: 1, total_tokens: 272001, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }) } }; },
        deliver: async () => ({ status: "saved" as const }), settleBilling: createGenerationWalletSettlement(database.db) };
    expect((await processGenerationJob(database.db, job, deps)).task.billingStatus).toBe("captured");
    const settled = await businessState(); await processGenerationJob(database.db, job, deps); expect(calls).toBe(1); expect(await businessState()).toEqual(settled);
    for (const route of [`/api/v1/generation/tasks/${taskId}`, "/api/v1/generation/tasks/by-key/concurrent-v2"]) {
        const response = await request(route); expect(response.status).toBe(200); const data = await response.json();
        expect(data.task).toMatchObject({ id: taskId, priceVersion: 1, textQuoteSnapshot: { inputCreditsPerMillion: "72" },
            textBillingExplanation: { policy: "context_tiers", tier: "long", totalTokens: 272001, expectedCredits: "39.16854",
                rates: { inputCreditsPerMillion: "144", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "540" } },
            billing: { reservedCredits: "100", capturedCredits: "39.16854", releasedCredits: "60.83146" } });
        expect(JSON.stringify(data)).not.toMatch(/private-sol|private procurement|private-provider|provider.invalid|binding|costMultiplier/);
        expect((await request(route, bob)).status).toBe(404);
    }
});
