import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import type { AdminModelPriceDraft, ModelPriceDraftWrite, ModelPricePublishWrite } from "../../shared/src";
import { createAccountApi } from "../../../apps/api/src/accounts";
import { createApp } from "../../../apps/api/src/app";
import { postgresTestUrl } from "../../../apps/api/test/database";

const testUrl = postgresTestUrl();
if (!testUrl || process.env.DATABASE_URL || process.env.SAAS_POSTGRES_TEST_SUITE !== "price-publications") {
    throw new Error("请仅通过 test:postgres --price-publications 的全新隔离数据库运行");
}
const prefix = `price-race-${crypto.randomUUID()}`, origin = "http://localhost:4033";
const secret = `isolated-price-race-${crypto.randomUUID()}`;
const publicationPath = "/api/v1/admin/model-price-publications", draftPath = "/api/v1/admin/model-price-drafts";
const legacyPath = "/api/v1/admin/model-pricing";
function connection(label: string) {
    const url = new URL(testUrl!);
    url.searchParams.set("application_name", `${prefix}-${label}`);
    // The existing 30 s PostgreSQL test deadline also bounds failed SQL cleanup.
    url.searchParams.set("statement_timeout", "30000");
    return createDatabase(url.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const blocker = new Client({ connectionString: testUrl, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
let blockerConnected = false, blockerPid: number;
let identity = { id: "", cookie: "" };
function app(database: ReturnType<typeof createDatabase>) {
    return createApp(createAccountApi({
        database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { consume: async () => ({ allowed: true }) }, verifyHuman: async () => true,
        onFault: () => undefined,
    }), "synthetic-site-key");
}
type Handler = ReturnType<typeof app>;
let firstApp: Handler, secondApp: Handler;
function request(handler: Handler, path: string, body?: unknown) {
    return handler(new Request(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: identity.cookie, "x-canvas-account-id": identity.id, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.42");
}

beforeAll(async () => {
    // Refuse an existing account schema even if an otherwise valid URL was supplied.
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name,
        current_user AS role, host(inet_server_addr()) AS host,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows).toEqual([{ count: 28 }]);
    await blocker.connect(); blockerConnected = true;
    blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    firstApp = app(first); secondApp = app(second);
    const credentials = { email: "postgres-price-race@example.test", password: "synthetic-price-race-password", name: "price race" };
    expect((await request(firstApp, "/api/auth/sign-up/email", credentials)).status).toBe(200);
    const { rows: [account] } = await observer.pool.query('SELECT id FROM canvas_saas."user" WHERE email = $1', [credentials.email]);
    identity.id = account.id;
    await observer.pool.query('UPDATE canvas_saas."user" SET role = $1, email_verified = true WHERE id = $2', ["admin", identity.id]);
    const signedIn = await request(firstApp, "/api/auth/sign-in/email", { email: credentials.email, password: credentials.password });
    expect(signedIn.status).toBe(200);
    identity.cookie = signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(identity.cookie.length).toBeGreaterThan(0);
}, 30_000);

afterAll(async () => {
    try { if (blockerConnected) await blocker.query("ROLLBACK"); }
    finally {
        const closed = await Promise.allSettled([blocker.end(), first.close(), second.close(), observer.close()]);
        if (closed.some((item) => item.status === "rejected")) throw new Error("An isolated database connection did not close cleanly");
    }
});

async function seed(label: string, capability: "image" | "text" = "image"): Promise<{ input: ModelPriceDraftWrite; draft: AdminModelPriceDraft }> {
    const modelId = `pg-race-${label}`, providerId = `pg-provider-${label}`;
    await observer.pool.query(`INSERT INTO canvas_saas.model_provider (id, display_name, adapter, endpoint, secret_ref, enabled)
        VALUES ($1, $2, 'openai-compatible', 'https://provider.invalid/v1', 'synthetic', true)`, [providerId, label]);
    await saveProviderCredential(observer.db, secret, providerId, "synthetic-private-test-key");
    await observer.pool.query(`INSERT INTO canvas_saas.model_catalog (id, public_id, provider_id, provider_model, display_name, capability, enabled)
        VALUES ($1, $1, $2, $3, $4, $5, true)`, [modelId, providerId, `synthetic-${capability}`, label, capability]);
    const input: ModelPriceDraftWrite = {
        modelId, expectedVersion: 0,
        binding: { providerId, providerModel: `synthetic-${capability}`, adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability },
        rules: { schemaVersion: 1, cost: null, sale: capability === "text"
            ? { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "0.0000000000000000001", output_token: "3.125" } }] }
            : { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } },
        priceNote: "private synthetic note",
    };
    const response = await request(firstApp, draftPath, input);
    expect(response.status).toBe(201);
    return { input, draft: (await response.json()).draft };
}
function publishBody(draft: AdminModelPriceDraft, expectedPriceVersion = 0): ModelPricePublishWrite {
    return { modelId: draft.modelId, draftId: draft.id, expectedDraftVersion: draft.version, expectedPriceVersion, binding: draft.binding, publicPriceNote: "单张 PNG" };
}
const legacyBody = (modelId: string) => ({ modelId, billingUnit: "request", creditsPerUnit: 3, enabled: true });

type Pending = { settled: boolean; result: Promise<{ response: Response } | { failed: true }> };
function begin(operation: () => Promise<Response>): Pending {
    const pending: Pending = { settled: false, result: Promise.resolve({ failed: true }) };
    pending.result = operation().then((response) => { pending.settled = true; return { response }; }, () => {
        pending.settled = true; return { failed: true };
    });
    return pending;
}
async function blockedPid(label: "first" | "second", expectedBlocker: number, pending: Pending): Promise<number> {
    // Observe actual PostgreSQL lock waiters; a merely slow promise is not evidence.
    // Bun's usual 5 s test window bounds this observation, within the 30 s test deadline.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (pending.settled) throw new Error("Request completed before the expected database lock wait");
        const { rows } = await observer.pool.query<{ pid: number; blockers: number[] }>(
            "SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
            [`${prefix}-${label}`]);
        const row = rows.find((value) => value.blockers.includes(expectedBlocker));
        if (row) return row.pid;
        await Bun.sleep(10);
    }
    throw new Error("The expected PostgreSQL blocking relationship was not observed");
}
async function orderedPair(modelId: string, a: () => Promise<Response>, b: () => Promise<Response>): Promise<[Response, Response]> {
    const pending: Pending[] = [];
    let locked = false;
    try {
        await blocker.query("BEGIN"); locked = true;
        const held = await blocker.query("SELECT id FROM canvas_saas.model_catalog WHERE public_id = $1 FOR UPDATE", [modelId]);
        expect(held.rowCount).toBe(1);
        pending.push(begin(a));
        const firstPid = await blockedPid("first", blockerPid, pending[0]!);
        pending.push(begin(b));
        const secondPid = await blockedPid("second", firstPid, pending[1]!);
        expect(new Set([blockerPid, firstPid, secondPid]).size).toBe(3);
        expect(pending.every((item) => !item.settled)).toBe(true);
        // Releasing only the test row lock lets the unchanged production transactions race in order.
        await blocker.query("ROLLBACK"); locked = false;
        const outcomes = await Promise.all(pending.map((item) => item.result));
        const aResult = outcomes[0]!, bResult = outcomes[1]!;
        if (!("response" in aResult) || !("response" in bResult)) throw new Error("Isolated handler failed outside its response contract");
        return [aResult.response, bResult.response];
    } finally {
        try { if (locked) await blocker.query("ROLLBACK"); }
        finally { await Promise.allSettled(pending.map((item) => item.result)); }
    }
}
async function state(modelId: string) {
    const prices = (await observer.pool.query("SELECT version, credits_per_unit::int AS credits, enabled FROM canvas_saas.model_pricing WHERE model_id = $1 ORDER BY version", [modelId])).rows;
    const publications = (await observer.pool.query("SELECT p.id, p.draft_id FROM canvas_saas.model_price_publication p JOIN canvas_saas.model_pricing v ON v.id = p.pricing_id WHERE v.model_id = $1 ORDER BY v.version", [modelId])).rows;
    const audits = (await observer.pool.query(`SELECT a.action, count(*)::int AS count FROM canvas_saas.audit_event a WHERE a.resource_id IN (
        SELECT id FROM canvas_saas.model_pricing WHERE model_id = $1 UNION SELECT p.id FROM canvas_saas.model_price_publication p
        JOIN canvas_saas.model_pricing v ON v.id = p.pricing_id WHERE v.model_id = $1) GROUP BY a.action ORDER BY a.action`, [modelId])).rows;
    return { prices, publications, audits };
}
async function businessCounts() {
    return (await observer.pool.query(`SELECT (SELECT count(*)::int FROM canvas_saas.generation_task) AS tasks,
        (SELECT count(*)::int FROM canvas_saas.wallet_reservation) AS reservations,
        (SELECT count(*)::int FROM canvas_saas.wallet_ledger) AS ledger,
        (SELECT count(*)::int FROM canvas_saas.wallet) AS wallets`)).rows;
}

test("two real connections publish the same saved draft only once after an observed row-lock wait", async () => {
    const { input, draft } = await seed("same"), body = publishBody(draft), before = await businessCounts();
    const [a, b] = await orderedPair(input.modelId, () => request(firstApp, publicationPath, body), () => request(secondApp, publicationPath, body));
    expect([a.status, b.status]).toEqual([200, 200]);
    const firstPublication = (await a.json()).publication;
    expect((await b.json()).publication).toEqual(firstPublication);
    expect(await state(input.modelId)).toEqual({
        prices: [{ version: 1, credits: 7, enabled: true }], publications: [{ id: firstPublication.id, draft_id: draft.id }],
        audits: [{ action: "model.price.published", count: 1 }],
    });
    expect(await businessCounts()).toEqual(before);
}, 30_000);

test("a concurrently saved newer draft invalidates the pending old publication and both version baselines must be refreshed", async () => {
    const { input, draft } = await seed("draft-cas");
    expect((await request(firstApp, publicationPath, publishBody(draft))).status).toBe(200);
    const before = await state(input.modelId), business = await businessCounts();
    const next = structuredClone(input); next.expectedVersion = 1; next.rules.sale.bands[0]!.rates.request = "9";
    const [saved, stale] = await orderedPair(input.modelId, () => request(firstApp, draftPath, next), () => request(secondApp, publicationPath, publishBody(draft, 1)));
    expect([saved.status, stale.status]).toEqual([201, 409]);
    expect((await stale.json()).error.code).toBe("price_draft_conflict");
    const nextDraft: AdminModelPriceDraft = (await saved.json()).draft;
    expect(nextDraft.version).toBe(2);
    expect(await state(input.modelId)).toEqual(before);
    const stalePrice = await request(secondApp, publicationPath, publishBody(nextDraft, 0));
    expect(stalePrice.status).toBe(409); expect((await stalePrice.json()).error.code).toBe("price_publication_conflict");
    expect(await state(input.modelId)).toEqual(before);
    const fresh = await request(secondApp, publicationPath, publishBody(nextDraft, 1));
    expect(fresh.status).toBe(200); expect((await fresh.json()).publication).toMatchObject({ draftVersion: 2, priceVersion: 2, creditsPerUnit: 9 });
    const after = await state(input.modelId);
    expect(after.prices).toEqual([{ version: 1, credits: 7, enabled: false }, { version: 2, credits: 9, enabled: true }]);
    expect(after.publications).toHaveLength(2); expect(after.audits).toEqual([{ action: "model.price.published", count: 2 }]);
    expect(await businessCounts()).toEqual(business);
}, 30_000);

test("a legacy price writer winning the shared lock makes the pending publication price CAS fail without a partial write", async () => {
    const { input, draft } = await seed("legacy-first"), business = await businessCounts();
    const [legacy, stale] = await orderedPair(input.modelId, () => request(firstApp, legacyPath, legacyBody(input.modelId)), () => request(secondApp, publicationPath, publishBody(draft)));
    expect([legacy.status, stale.status]).toEqual([201, 409]);
    expect((await stale.json()).error.code).toBe("price_publication_conflict");
    expect(await state(input.modelId)).toEqual({ prices: [{ version: 1, credits: 3, enabled: true }], publications: [], audits: [{ action: "model.pricing.created", count: 1 }] });
    const response = await request(secondApp, publicationPath, publishBody(draft, 1));
    expect(response.status).toBe(200); expect((await response.json()).publication).toMatchObject({ priceVersion: 2, creditsPerUnit: 7 });
    const after = await state(input.modelId);
    expect(after.prices).toEqual([{ version: 1, credits: 3, enabled: false }, { version: 2, credits: 7, enabled: true }]);
    expect(after.publications).toHaveLength(1);
    expect(after.audits).toEqual([{ action: "model.price.published", count: 1 }, { action: "model.pricing.created", count: 1 }]);
    expect(await businessCounts()).toEqual(business);
}, 30_000);

test("a publication winning the shared lock blocks the pending legacy writer from bypassing managed prices", async () => {
    const { input, draft } = await seed("publication-first"), business = await businessCounts();
    const [published, legacy] = await orderedPair(input.modelId, () => request(firstApp, publicationPath, publishBody(draft)), () => request(secondApp, legacyPath, legacyBody(input.modelId)));
    expect([published.status, legacy.status]).toEqual([200, 409]);
    expect((await legacy.json()).error.code).toBe("price_publication_managed");
    const publication = (await published.json()).publication;
    expect(await state(input.modelId)).toEqual({ prices: [{ version: 1, credits: 7, enabled: true }], publications: [{ id: publication.id, draft_id: draft.id }], audits: [{ action: "model.price.published", count: 1 }] });
    expect(await businessCounts()).toEqual(business);
}, 30_000);

test("concurrent administrators publish the same immutable text rates once after real row-lock waits", async () => {
    const { input, draft } = await seed("text-same", "text"), before = await businessCounts();
    const body = { ...publishBody(draft), publicPriceNote: "输入和输出分别按百万 Token 计价" };
    const [a, b] = await orderedPair(input.modelId, () => request(firstApp, publicationPath, body), () => request(secondApp, publicationPath, body));
    expect([a.status, b.status]).toEqual([200, 200]);
    const published = (await a.json()).publication;
    expect(published).toMatchObject({ billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: "0.0000000000000000001", outputCreditsPerMillion: "3.125" });
    expect((await b.json()).publication).toEqual(published);
    expect(await state(input.modelId)).toEqual({ prices: [{ version: 1, credits: null, enabled: true }],
        publications: [{ id: published.id, draft_id: draft.id }], audits: [{ action: "model.price.published", count: 1 }] });
    expect(await businessCounts()).toEqual(before);
}, 30_000);

test("real PostgreSQL rejects an orphan text price at COMMIT and keeps the transaction atomic", async () => {
    const { input } = await seed("text-orphan", "text"), before = await state(input.modelId), business = await businessCounts();
    let committed = false;
    await blocker.query("BEGIN");
    try {
        const inserted = await blocker.query(`INSERT INTO canvas_saas.model_pricing
            (id,model_id,version,billing_unit,credits_per_unit,effective_from,enabled)
            VALUES ($1,$2,1,'text_tokens',NULL,now(),false) RETURNING id`, [crypto.randomUUID(), input.modelId]);
        expect(inserted.rowCount).toBe(1);
        // The INSERT itself succeeds: the deferred publication constraint is checked at COMMIT.
        await expect(blocker.query("COMMIT")).rejects.toThrow("Text price requires an immutable publication source");
        committed = true;
    } finally { if (!committed) await blocker.query("ROLLBACK"); }
    expect(await state(input.modelId)).toEqual(before);
    expect(await businessCounts()).toEqual(business);
}, 30_000);
