import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { generationTask, modelCatalog, modelProvider, modelProviderCredential, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { listPublicModelPricing } from "@infinite-canvas/database/pricing";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createAccountApi } from "../src/accounts";
import { getAdminGenerationTaskDetail } from "../src/admin-generation-query";
import { imageQuoteFingerprint } from "../src/generation-image-quote";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Image specification contract requires in-memory PGlite");
const origin = "https://image-spec-contract.example.test";
const low = { size: "512x512", quality: "low" } as const;
const high = { size: "1024x1024", quality: "high" } as const;
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let api: ReturnType<typeof createAccountApi>;
type Actor = { id: string; cookie: string };
let alice: Actor, bob: Actor;
const mails: { to: string; url: string }[] = [], jobs: string[] = [];

function request(path: string, actor?: Actor, body?: unknown, key?: string) {
    return api(new Request(origin + path, { method: body === undefined ? "GET" : "POST",
        headers: { origin, "content-type": "application/json", ...(actor ? { cookie: actor.cookie, "x-canvas-account-id": actor.id } : {}),
            ...(key ? { "idempotency-key": key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.97");
}
async function register(name: string): Promise<Actor> {
    const email = `${name}-${crypto.randomUUID()}@example.test`, password = "synthetic-image-spec-password";
    expect((await request("/api/auth/sign-up/email", undefined, { name, email, password })).status).toBe(200);
    expect((await api(new Request(mails.find((mail) => mail.to === email)!.url), "198.51.100.97")).status).toBe(302);
    const login = await request("/api/auth/sign-in/email", undefined, { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const session = await request("/api/v1/session", { id: "", cookie });
    expect(session.status).toBe(200);
    return { id: (await session.json()).user.id, cookie };
}
beforeAll(async () => {
    database = await createTestDatabase();
    const secret = "synthetic-spec-contract-" + crypto.randomUUID() + crypto.randomUUID();
    api = createAccountApi({ database: database.db, origin,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
        rates: createRateStore(database.pool, secret), verifyHuman: async () => true, onFault: () => {},
        generation: { enabled: true, imageEnabled: true, queue: { async send(_name, payload, options) {
            expect(options?.db).toBeDefined(); jobs.push(payload.taskId); return `synthetic-spec-job-${jobs.length}`;
        } } },
    });
    alice = await register("spec-alice"); bob = await register("spec-bob");
    await database.db.insert(wallet).values([{ userId: alice.id, availableUnits: "1000" }, { userId: bob.id, availableUnits: "1000" }]);
}, 30_000);
afterAll(async () => { await database?.close(); });

async function publish(input: ModelPriceDraftWrite, expectedPriceVersion = 0) {
    const audit = { actorId: alice.id, requestId: crypto.randomUUID() };
    const saved = await createModelPriceDraft(database.db, input, audit);
    if (saved.status !== "saved") throw new Error("Synthetic image draft did not save");
    const published = await publishModelPriceDraft(database.db, { modelId: input.modelId, draftId: saved.draft.id,
        expectedDraftVersion: saved.draft.version, expectedPriceVersion, binding: input.binding, publicPriceNote: "Synthetic public specification price" }, audit);
    if (published.status !== "published") throw new Error("Synthetic image price did not publish");
    return published.publication;
}
async function model(legacy = false) {
    const id = crypto.randomUUID(), modelId = `spec-${id}`, providerId = `spec-provider-${id}`;
    await database.db.insert(modelProvider).values({ id: providerId, displayName: "Synthetic image specs", adapter: "openai-compatible",
        endpoint: "https://provider.invalid/v1", secretRef: "synthetic-unused", enabled: true });
    await database.db.insert(modelProviderCredential).values({ providerId, ciphertext: "unused", nonce: "0".repeat(24), authTag: "0".repeat(32) });
    await database.db.insert(modelCatalog).values({ id: modelId, publicId: modelId, providerId, providerModel: "synthetic-image-spec",
        displayName: "Synthetic image specification", capability: "image", enabled: true });
    const draft: ModelPriceDraftWrite = { modelId, expectedVersion: 0,
        binding: { providerId, providerModel: "synthetic-image-spec", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability: "image" },
        rules: { schemaVersion: 1, cost: null, sale: { template: "image_request", currency: "credit",
            bands: legacy ? [{ parameters: {}, rates: { request: "7" } }] : [
                { parameters: { ...low }, rates: { request: "7" } }, { parameters: { ...high }, rates: { request: "11" } },
            ] } }, priceNote: "private synthetic configuration note" };
    const publication = await publish(draft);
    return { modelId, providerId, draft, publication };
}
const intent = (modelId: string, parameters: Record<string, unknown> = low) => ({ modelId, input: { prompt: "Synthetic exact specification" },
    parameters, projectId: "synthetic-project", nodeId: "synthetic-node" });
async function quote(modelId: string, parameters: Record<string, unknown> = low, actor = alice) {
    const response = await request("/api/v1/generation/quote", actor, intent(modelId, parameters));
    expect(response.status).toBe(200);
    return (await response.json()).quote;
}
function submission(modelId: string, price: { priceVersion: number; quoteFingerprint?: string }, parameters: Record<string, unknown> = low) {
    return { ...intent(modelId, parameters), confirmedPriceVersion: price.priceVersion,
        ...(price.quoteFingerprint === undefined ? {} : { confirmedQuoteFingerprint: price.quoteFingerprint }) };
}
async function moneyAndTasks() {
    return { tasks: await database.db.select().from(generationTask), wallets: await database.db.select().from(wallet),
        reservations: await database.db.select().from(walletReservation), ledger: await database.db.select().from(walletLedger), jobs: [...jobs] };
}

test("spec quotes are exact, principal-bound and safe while the execution catalog includes supported models", async () => {
    const fixture = await model(), first = await quote(fixture.modelId), other = await quote(fixture.modelId, high), bobPrice = await quote(fixture.modelId, low, bob);
    expect(first).toMatchObject({ priceVersion: 1, billingUnit: "request", creditsPerUnit: 7, quotedUnits: 7, imageSpec: { parameters: low } });
    expect(other).toMatchObject({ priceVersion: 1, creditsPerUnit: 11, quotedUnits: 11, imageSpec: { parameters: high } });
    expect(first.quoteFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.quoteFingerprint).not.toBe(other.quoteFingerprint);
    expect(first.quoteFingerprint).not.toBe(bobPrice.quoteFingerprint);
    expect(Object.keys(first).sort()).toEqual(["modelId", "priceVersion", "billingUnit", "creditsPerUnit", "quotedUnits", "priceNote", "imageSpec", "quoteFingerprint"].sort());
    for (const privateValue of [fixture.publication.id, fixture.providerId, "provider.invalid", "private synthetic", "sourceDraft", "binding"]) expect(JSON.stringify(first)).not.toContain(privateValue);
    const catalog = await request("/api/v1/generation/models", alice);
    expect((await catalog.json()).items.some((item: { id: string }) => item.id === fixture.modelId)).toBe(true);
    const publicPrice = (await listPublicModelPricing(database.db)).find((price) => price.modelId === fixture.modelId)!;
    expect(publicPrice).toMatchObject({ billingUnit: "image_specs", creditsPerUnit: null,
        imageSpecs: [{ parameters: low, creditsPerRequest: 7 }, { parameters: high, creditsPerRequest: 11 }] });
    expect((await request("/api/v1/generation/quote", alice, intent(fixture.modelId, { ...low, n: 1 }))).status).toBe(200);
    for (const parameters of [{}, { size: "512x512", quality: "high" }, { ...low, background: "transparent" }, { size: "auto" }, { ...low, n: 11 }, { ...low, n: 2 }]) {
        expect((await request("/api/v1/generation/quote", alice, intent(fixture.modelId, parameters))).status).toBe(400);
    }
});

test("same-version parameter, owner or malformed confirmation cannot reserve or create", async () => {
    const fixture = await model(), price = await quote(fixture.modelId), before = await moneyAndTasks();
    const changed = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price, high), crypto.randomUUID());
    expect(changed.status).toBe(409); expect((await changed.json()).error.code).toBe("price_changed");
    const foreign = await request("/api/v1/generation/tasks", bob, submission(fixture.modelId, price), crypto.randomUUID());
    expect(foreign.status).toBe(409); expect((await foreign.json()).error.code).toBe("price_changed");
    for (const body of [{ ...submission(fixture.modelId, price), input: { prompt: "changed confirmed input" } },
        { ...submission(fixture.modelId, price), nodeId: "changed-confirmed-node" }]) {
        const changedIntent = await request("/api/v1/generation/tasks", alice, body, crypto.randomUUID());
        expect(changedIntent.status).toBe(409); expect((await changedIntent.json()).error.code).toBe("price_changed");
    }
    const { confirmedQuoteFingerprint: _fingerprint, ...missing } = submission(fixture.modelId, price);
    const unconfirmed = await request("/api/v1/generation/tasks", alice, missing, crypto.randomUUID());
    expect(unconfirmed.status).toBe(409); expect((await unconfirmed.json()).error.code).toBe("price_changed");
    expect((await request("/api/v1/generation/tasks", alice, { ...missing, confirmedQuoteFingerprint: "BAD" }, crypto.randomUUID())).status).toBe(400);
    expect((await request("/api/v1/generation/tasks", alice, { ...submission(fixture.modelId, price), quotedUnits: 1 }, crypto.randomUUID())).status).toBe(400);
    expect(await moneyAndTasks()).toEqual(before);
});

test("accepted specification fixes the original source and canonical parameters and reserves only once", async () => {
    const fixture = await model(), price = await quote(fixture.modelId), key = crypto.randomUUID(), jobsBefore = jobs.length;
    const response = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price), key);
    expect(response.status).toBe(201);
    const accepted = await response.json();
    expect(accepted.task).toMatchObject({ priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
        executionStatus: "queued", billingStatus: "reserved", imageSpecSnapshot: { status: "recorded", parameters: low } });
    for (const field of ["pricePublicationId", "ownerId", "reservationId", "parameterSnapshot", "idempotencyKey"]) expect(accepted.task).not.toHaveProperty(field);
    const [row] = await database.db.select().from(generationTask).where(eq(generationTask.id, accepted.task.id));
    expect(row).toMatchObject({ ownerId: alice.id, pricePublicationId: fixture.publication.id, parameterSnapshot: { protocol: "openai-image-v1", ...low, n: 1, output_format: "png" },
        priceVersion: 1, quotedUnits: 7, creditsPerUnitSnapshot: 7, textQuoteSnapshot: null });
    const administrative = await getAdminGenerationTaskDetail(database.db, row!.id);
    expect(administrative.priceSnapshot).toMatchObject({ status: "recorded", publicationId: fixture.publication.id });
    expect(administrative.task).not.toHaveProperty("parameterSnapshot");
    const reservation = await database.db.select().from(walletReservation).where(eq(walletReservation.taskId, row!.id));
    expect(reservation).toHaveLength(1); expect(reservation[0]!.requestedUnits).toBe("7");
    const before = await moneyAndTasks();
    const replay = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price), key);
    expect(replay.status).toBe(200); expect((await replay.json()).created).toBe(false);
    expect(await moneyAndTasks()).toEqual(before); expect(jobs.length).toBe(jobsBefore + 1);
    const own = await request(`/api/v1/generation/tasks/${row!.id}`, alice);
    expect((await own.json()).task.imageSpecSnapshot).toEqual({ status: "recorded", protocol: "openai-image-v1", parameters: low });
    expect((await request(`/api/v1/generation/tasks/${row!.id}`, bob)).status).toBe(404);
});

test("history replay precedes active price gates but a new acceptance must confirm the changed quote", async () => {
    const fixture = await model(), price = await quote(fixture.modelId), key = crypto.randomUUID();
    const first = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price), key);
    expect(first.status).toBe(201); const taskId = (await first.json()).task.id;
    const next = structuredClone(fixture.draft); next.expectedVersion = 1;
    next.rules.sale.bands[0]!.rates.request = "19"; next.rules.sale.bands[1]!.rates.request = "23";
    await publish(next, 1);
    const beforeRejected = await moneyAndTasks();
    const stale = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price), crypto.randomUUID());
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("price_changed");
    expect(await moneyAndTasks()).toEqual(beforeRejected);
    await database.db.update(modelProvider).set({ enabled: false }).where(eq(modelProvider.id, fixture.providerId));
    await database.db.update(modelCatalog).set({ enabled: false }).where(eq(modelCatalog.id, fixture.modelId));
    const beforeReplay = await moneyAndTasks();
    const replay = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price), key);
    expect(replay.status).toBe(200); expect((await replay.json()).task).toMatchObject({ id: taskId, priceVersion: 1, quotedUnits: 7 });
    expect(await moneyAndTasks()).toEqual(beforeReplay);
    for (const body of [submission(fixture.modelId, price, high), { ...submission(fixture.modelId, price), input: { prompt: "changed" } }]) {
        const conflict = await request("/api/v1/generation/tasks", alice, body, key);
        expect(conflict.status).toBe(409); expect((await conflict.json()).error.code).toBe("idempotency_conflict");
    }
    expect(await moneyAndTasks()).toEqual(beforeReplay);
});

test("pre-protocol accepted tasks replay with their original fingerprint and no new task, reservation or job", async () => {
    const fixture = await model(), key = crypto.randomUUID(), requestId = crypto.randomUUID();
    const parameters = { ...low, n: 1, output_format: "png" };
    const tasks = createGenerationTaskRepository(database.db), wallets = createWalletRepository(database.db);
    const created = await tasks.create({ ownerId: alice.id, modelId: fixture.modelId, inputSnapshot: intent(fixture.modelId).input,
        parameterSnapshot: parameters, priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
        projectId: "synthetic-project", nodeId: "synthetic-node", idempotencyKey: key, requestId });
    const reservation = await wallets.reserve({ userId: alice.id, requestedUnits: 7, idempotencyKey: `g:${key}`,
        providerRequestId: requestId, taskId: created.task.id, referenceType: "generation", referenceId: created.task.id });
    await tasks.setReservationId({ ownerId: alice.id, taskId: created.task.id, reservationId: reservation.id });
    await tasks.transitionBilling({ ownerId: alice.id, taskId: created.task.id, status: "reserved" });
    await tasks.transitionExecution({ ownerId: alice.id, taskId: created.task.id, status: "queued" });
    const fingerprint = imageQuoteFingerprint(alice.id, { modelId: fixture.modelId, inputSnapshot: created.task.inputSnapshot,
        parameterSnapshot: parameters, projectId: "synthetic-project", nodeId: "synthetic-node" },
        { pricePublicationId: fixture.publication.id, priceVersion: 1, creditsPerUnit: 7, quotedUnits: 7 });
    const before = await moneyAndTasks();
    const response = await request("/api/v1/generation/tasks", alice,
        submission(fixture.modelId, { priceVersion: 1, quoteFingerprint: fingerprint }), key);
    expect(response.status).toBe(200);
    expect((await response.json()).task.imageSpecSnapshot).toEqual({ status: "recorded", protocol: "openai-image-v1", parameters: low });
    expect(await moneyAndTasks()).toEqual(before);
    expect((await tasks.get(alice.id, created.task.id))?.parameterSnapshot).toEqual(parameters);
});

test("legacy scalar acceptance and replay retain the original empty parameter snapshot without a fingerprint", async () => {
    const fixture = await model(true), price = await quote(fixture.modelId, {}), key = crypto.randomUUID();
    expect(price).not.toHaveProperty("quoteFingerprint"); expect(price).not.toHaveProperty("imageSpec");
    const accepted = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price, {}), key);
    expect(accepted.status).toBe(201); const taskId = (await accepted.json()).task.id;
    const next = structuredClone(fixture.draft); next.expectedVersion = 1;
    next.rules.sale.bands = [{ parameters: { ...low }, rates: { request: "13" } }];
    await publish(next, 1);
    const before = await moneyAndTasks();
    const replay = await request("/api/v1/generation/tasks", alice, submission(fixture.modelId, price, {}), key);
    expect(replay.status).toBe(200); expect((await replay.json()).created).toBe(false);
    expect(await moneyAndTasks()).toEqual(before);
    const [row] = await database.db.select().from(generationTask).where(eq(generationTask.id, taskId));
    expect(row!.parameterSnapshot).toEqual({}); expect(row!.quotedUnits).toBe(7);
});

test("fingerprints use codepoint key canonicalization and bind every confirmed intent field", () => {
    const original = { modelId: "synthetic", inputSnapshot: { prompt: " exact whitespace " },
        parameterSnapshot: { quality: "low", size: "512x512", n: 1, output_format: "png" }, projectId: "project" };
    const price = { pricePublicationId: "synthetic-publication", priceVersion: 1, creditsPerUnit: 7, quotedUnits: 7 };
    const fingerprint = imageQuoteFingerprint("synthetic-owner", original, price);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(imageQuoteFingerprint("synthetic-owner", { ...original, parameterSnapshot: { output_format: "png", n: 1, size: "512x512", quality: "low" } }, price)).toBe(fingerprint);
    for (const changed of [{ ...original, modelId: "other" }, { ...original, spaceId: "other" },
        { ...original, projectId: "other" }, { ...original, nodeId: "other" }, { ...original, inputSnapshot: { prompt: "exact whitespace" } },
        { ...original, parameterSnapshot: { ...original.parameterSnapshot, quality: "high" } },
        { ...original, parameterSnapshot: { ...original.parameterSnapshot, response_format: "b64_json" } },
        { ...original, parameterSnapshot: { ...original.parameterSnapshot, protocol: "openai-image-v1" } },
        { ...original, parameterSnapshot: { ...original.parameterSnapshot, protocol: "gemini" } }]) expect(imageQuoteFingerprint("synthetic-owner", changed, price)).not.toBe(fingerprint);
    expect(imageQuoteFingerprint("other-owner", original, price)).not.toBe(fingerprint);
    expect(imageQuoteFingerprint("synthetic-owner", original, { ...price, pricePublicationId: "other" })).not.toBe(fingerprint);
    expect(imageQuoteFingerprint("synthetic-owner", original, { ...price, priceVersion: 2 })).not.toBe(fingerprint);
    expect(imageQuoteFingerprint("synthetic-owner", original, { ...price, creditsPerUnit: 11, quotedUnits: 11 })).not.toBe(fingerprint);
});
