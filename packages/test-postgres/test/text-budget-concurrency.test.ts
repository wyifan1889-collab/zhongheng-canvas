import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createModelPriceDraft } from "@infinite-canvas/database/model-price-drafts";
import { publishModelPriceDraft } from "@infinite-canvas/database/model-price-publications";
import { createJobQueue } from "@infinite-canvas/jobs";
import { createAccountApi } from "../../../apps/api/src/accounts";
import { createApp } from "../../../apps/api/src/app";
import { runGenerationWorkerSchemaOperation } from "../../../apps/api/src/generation-worker-schema";
import { postgresTestUrl } from "../../../apps/api/test/database";

const testUrl = postgresTestUrl();
if (!testUrl || process.env.DATABASE_URL || process.env.SAAS_POSTGRES_TEST_SUITE !== "text-budget") {
    throw new Error("Use test:postgres --text-budget with a fresh isolated database");
}
const prefix = `text-budget-${crypto.randomUUID()}`, origin = "http://localhost:4034";
const secret = `synthetic-text-budget-${crypto.randomUUID()}`;
const path = "/api/v1/generation/text/tasks", modelId = "synthetic-budget-text";
const binding = { providerId: "synthetic-text-provider", providerModel: "private-synthetic-text", adapter: "sub2api" as const,
    endpoint: "https://provider.invalid/v1", capability: "text" as const };
const submission = { modelId, input: { prompt: "Synthetic concurrent text request" }, parameters: {},
    projectId: "synthetic-project", budgetCredits: "0.01", confirmedPriceVersion: 1 };
function connection(label: string) {
    const url = new URL(testUrl!);
    url.searchParams.set("application_name", `${prefix}-${label}`);
    // Reuse the existing isolated runner deadline; this is not a product timeout.
    url.searchParams.set("statement_timeout", "30000");
    return createDatabase(url.toString());
}
const observer = connection("observer"), first = connection("first"), second = connection("second");
const blocker = new Client({ connectionString: testUrl, application_name: `${prefix}-blocker`, statement_timeout: 30_000 });
const queueErrors: Error[] = [], queue = createJobQueue(testUrl, error => queueErrors.push(error));
let blockerConnected = false, blockerPid: number;
const identity = { id: "", cookie: "" };
function app(database: ReturnType<typeof createDatabase>) {
    return createApp(createAccountApi({ database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { consume: async () => ({ allowed: true }) }, verifyHuman: async () => true, onFault: () => undefined,
        generation: { enabled: true, imageEnabled: false, textEnabled: true, queue },
    }), "synthetic-site-key", false, false, undefined, { text: true });
}
type Handler = ReturnType<typeof app>;
let firstApp: Handler, secondApp: Handler;
function request(handler: Handler, requestPath: string, body: unknown, key = "unused") {
    return handler(new Request(new URL(requestPath, origin), { method: "POST",
        headers: { origin, cookie: identity.cookie, "x-canvas-account-id": identity.id,
            "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body),
    }), "198.51.100.43");
}

beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged,
        to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh`);
    expect(boundary).toEqual({ name: "canvas_saas_test", role: "canvas_test_app", host: "127.0.0.1", privileged: false, fresh: true });
    await migrateDatabase(observer.db);
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows).toEqual([{ count: 28 }]);
    const installed = await runGenerationWorkerSchemaOperation({ apply: true, env: {
        GENERATION_WORKER_ENABLED: "true", GENERATION_WORKER_ENVIRONMENT: "staging", GENERATION_WORKER_QUEUE_URL: testUrl!,
        SAAS_DATABASE_URL: testUrl!, SAAS_ORIGIN: "https://isolated-text-budget.example.test",
    } });
    expect(installed.queue).toMatchObject({ state: "ready", applied: true, settings: { policy: "standard", retryLimit: 0 } });
    // Producer only. No worker is created and no provider can be invoked by this test.
    await queue.start();
    await blocker.connect(); blockerConnected = true;
    blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    firstApp = app(first); secondApp = app(second);
    const credentials = { email: "postgres-text-budget@example.test", password: "synthetic-text-budget-password", name: "Synthetic text budget" };
    expect((await request(firstApp, "/api/auth/sign-up/email", credentials)).status).toBe(200);
    identity.id = (await observer.pool.query('SELECT id FROM canvas_saas."user" WHERE email=$1', [credentials.email])).rows[0].id;
    await observer.pool.query('UPDATE canvas_saas."user" SET email_verified=true WHERE id=$1', [identity.id]);
    const signedIn = await request(firstApp, "/api/auth/sign-in/email", { email: credentials.email, password: credentials.password });
    expect(signedIn.status).toBe(200);
    identity.cookie = signedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    await observer.pool.query("INSERT INTO canvas_saas.wallet (user_id,available_units) VALUES ($1,10)", [identity.id]);
    await observer.pool.query(`INSERT INTO canvas_saas.model_provider (id,display_name,adapter,endpoint,secret_ref,enabled)
        VALUES ($1,'Synthetic text','sub2api',$2,'synthetic',true)`, [binding.providerId, binding.endpoint]);
    await saveProviderCredential(observer.db, secret, binding.providerId, "synthetic-test-credential");
    await observer.pool.query(`INSERT INTO canvas_saas.model_catalog (id,public_id,provider_id,provider_model,display_name,capability,enabled)
        VALUES ($1,$1,$2,$3,'Synthetic text','text',true)`, [modelId, binding.providerId, binding.providerModel]);
    const draft = await createModelPriceDraft(observer.db, { modelId, expectedVersion: 0, binding, priceNote: "Synthetic price fixture",
        rules: { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {},
            rates: { input_token: "1", output_token: "2" } }] } } }, { actorId: identity.id, requestId: "synthetic-draft" });
    if (draft.status !== "saved") throw new Error("Synthetic draft failed");
    const publication = await publishModelPriceDraft(observer.db, { modelId, draftId: draft.draft.id, expectedDraftVersion: 1,
        expectedPriceVersion: 0, binding, publicPriceNote: "Synthetic dual-rate budget" }, { actorId: identity.id, requestId: "synthetic-publication" });
    expect(publication.status).toBe("published");
}, 30_000);

afterAll(async () => {
    try { if (blockerConnected) await blocker.query("ROLLBACK"); }
    finally {
        const closed = await Promise.allSettled([queue.stop(), blocker.end(), first.close(), second.close(), observer.close()]);
        if (closed.some(entry => entry.status === "rejected")) throw new Error("An isolated text-budget connection did not close cleanly");
    }
    expect(queueErrors).toHaveLength(0);
});

type Pending = { settled: boolean; result: Promise<{ response: Response } | { failed: true }> };
function begin(operation: () => Promise<Response>): Pending {
    const pending: Pending = { settled: false, result: Promise.resolve({ failed: true }) };
    pending.result = operation().then(response => { pending.settled = true; return { response }; }, () => {
        pending.settled = true; return { failed: true };
    });
    return pending;
}
async function blockedPid(label: "first" | "second", expectedBlocker: number, pending: Pending, table: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (pending.settled) throw new Error("Request completed before the expected PostgreSQL lock wait");
        const { rows } = await observer.pool.query<{ pid: number; blockers: number[]; query: string }>(
            "SELECT pid,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [`${prefix}-${label}`]);
        const waiting = rows.find(row => row.blockers.includes(expectedBlocker) && row.query.includes(table));
        if (waiting) return waiting.pid;
        await Bun.sleep(10);
    }
    throw new Error("The expected PostgreSQL blocking relationship was not observed");
}
async function compete(key: string, secondBudget: string): Promise<[Response, Response]> {
    const pending: Pending[] = []; let locked = false;
    try {
        await blocker.query("BEGIN"); locked = true;
        expect((await blocker.query("SELECT user_id FROM canvas_saas.wallet WHERE user_id=$1 FOR UPDATE", [identity.id])).rowCount).toBe(1);
        pending.push(begin(() => request(firstApp, path, submission, key)));
        const firstPid = await blockedPid("first", blockerPid, pending[0]!, "wallet");
        // The first transaction has already inserted the task but cannot commit its reserve.
        // The second must reach the same-key INSERT and wait on that uncommitted task.
        pending.push(begin(() => request(secondApp, path, { ...submission, budgetCredits: secondBudget }, key)));
        const secondPid = await blockedPid("second", firstPid, pending[1]!, "generation_task");
        expect(new Set([blockerPid, firstPid, secondPid]).size).toBe(3);
        expect(pending.every(entry => !entry.settled)).toBe(true);
        await blocker.query("ROLLBACK"); locked = false;
        const outcomes = await Promise.all(pending.map(entry => entry.result));
        if (!("response" in outcomes[0]!) || !("response" in outcomes[1]!)) throw new Error("Isolated handler failed outside its response contract");
        return [outcomes[0].response, outcomes[1].response];
    } finally {
        try { if (locked) await blocker.query("ROLLBACK"); }
        finally { await Promise.allSettled(pending.map(entry => entry.result)); }
    }
}
async function assertOneAccepted(key: string, id: string, available: string, reserved: string) {
    const { rows } = await observer.pool.query(`SELECT id,execution_status,billing_status,text_quote_snapshot,price_version,
        quoted_units,billing_unit_snapshot,credits_per_unit_snapshot FROM canvas_saas.generation_task WHERE owner_id=$1 AND idempotency_key=$2`, [identity.id, key]);
    expect(rows).toEqual([{ id, execution_status: "queued", billing_status: "reserved", price_version: 1,
        quoted_units: null, billing_unit_snapshot: null, credits_per_unit_snapshot: null,
        text_quote_snapshot: { schemaVersion: 1, budgetCredits: "0.01", inputCreditsPerMillion: "1", outputCreditsPerMillion: "2", usageSource: "responses" } }]);
    expect((await observer.pool.query(`SELECT requested_units,captured_units,released_units,status FROM canvas_saas.wallet_reservation
        WHERE user_id=$1 AND task_id=$2`, [identity.id, id])).rows).toEqual([{ requested_units: "0.01", captured_units: "0", released_units: "0", status: "pending" }]);
    expect((await observer.pool.query(`SELECT kind,delta_available_units,delta_reserved_units FROM canvas_saas.wallet_ledger
        WHERE user_id=$1 AND reference_id=$2`, [identity.id, id])).rows).toEqual([{ kind: "reserve", delta_available_units: "-0.01", delta_reserved_units: "0.01" }]);
    expect((await observer.pool.query("SELECT available_units,reserved_units FROM canvas_saas.wallet WHERE user_id=$1", [identity.id])).rows)
        .toEqual([{ available_units: available, reserved_units: reserved }]);
    const jobs = (await observer.pool.query("SELECT data,state FROM canvas_jobs.job WHERE name='generation' AND data->>'taskId'=$1", [id])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ data: { schemaVersion: 1, taskId: id, ownerId: identity.id }, state: "created" });
    expect((await observer.pool.query("SELECT count(*)::int AS count FROM canvas_saas.generation_result")).rows).toEqual([{ count: 0 }]);
}

test("concurrent same-key text submissions create one task, reservation, ledger entry and real queue job", async () => {
    const [a, b] = await compete("same-text-budget", "0.01");
    expect([a.status, b.status]).toEqual([201, 200]);
    const first = await a.json(), second = await b.json();
    expect(first.created).toBe(true); expect(second.created).toBe(false);
    expect(second.task).toEqual(first.task);
    await assertOneAccepted("same-text-budget", first.task.id, "9.99", "0.01");
}, 30_000);

test("concurrent same-key text submissions with different budgets return conflict without another reserve or job", async () => {
    const [a, b] = await compete("conflicting-text-budget", "0.02");
    expect([a.status, b.status]).toEqual([201, 409]);
    expect((await b.json()).error.code).toBe("idempotency_conflict");
    await assertOneAccepted("conflicting-text-budget", (await a.json()).task.id, "9.98", "0.02");
}, 30_000);
