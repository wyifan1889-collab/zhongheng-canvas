import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const url = process.env.SAAS_CONTEXT_PG_URL, sourceRoot = process.env.SAAS_CONTEXT_SOURCE_ROOT, label = process.env.SAAS_CONTEXT_SCHEMA_LABEL;
if (!url || !sourceRoot || process.env.SAAS_CONTEXT_PG_RUN !== "owned" || process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL || !["main", "narrow"].includes(label ?? "")) {
    throw new Error("Run only through context-tiers-runner with its newly owned native cluster");
}
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.username !== "context_test_app" || target.pathname !== "/context_tiers_native") throw new Error("Not an owned native test database");
const load = (path: string): Promise<any> => import(pathToFileURL(join(sourceRoot, path)).href);
const { createDatabase } = await load("packages/database/src/client.ts");
const { migrateDatabase } = await load("packages/database/src/migrate.ts");
const { createModelPriceDraft } = await load("packages/database/src/model-price-drafts.ts");
const { publishModelPriceDraft } = await load("packages/database/src/model-price-publications.ts");
const { saveProviderCredential } = await load("packages/database/src/provider-credentials.ts");
const { createGenerationTaskRepository } = await load("packages/database/src/generation-tasks.ts");
const { createWalletRepository } = await load("packages/database/src/wallet.ts");
const { deriveModelPriceRules } = await load("packages/shared/src/model-price-derivation.ts");
const { composeTextContextTierNote } = await load("packages/shared/src/model-price-publications.ts");
const observer = createDatabase(url), first = createDatabase(url + "?application_name=context-first"), second = createDatabase(url + "?application_name=context-second");
const blocker = new Client({ connectionString: url, application_name: "context-blocker", statement_timeout: 30_000 });
let connected = false;
const owner = "context-native-owner", otherOwner = "context-native-other", modelId = "context-native-text", stamp = new Date("2026-10-29T07:29:08.289Z");
const binding = { providerId: "context-native-provider", providerModel: "context-native-model", adapter: "sub2api", endpoint: "https://synthetic.invalid/v1", capability: "text" };
const entry = { id: "openai:gpt-6.1-sol", modelName: "gpt-6.1-sol", context: "Synthetic copied source shape; official input threshold retained, platform total policy separate", rates: [
    ["短上下文输入", "2"], ["短上下文输出", "10"], ["短上下文缓存读取", "0.1"], ["短上下文缓存写入（30 分钟）", "2.5"], ["短上下文缓存写入（12 小时）", "5"],
    ["长上下文输入", "4"], ["长上下文输出", "15"], ["长上下文缓存读取", "0.2"], ["长上下文缓存写入（30 分钟）", "5"], ["长上下文缓存写入（12 小时）", "10"],
].map(([label, usdPerMillion]) => ({ label, usdPerMillion })) };
const derivation = { schemaVersion: 2, kind: "multiplier", binding, costMultiplier: null, saleMultiplier: "0.36", creditsPerCurrency: "100",
    basis: { template: "text_cached_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.1", output_token: "10" } }] },
    source: { kind: "official", application: "context_tiers", sourceId: "openai", version: 1, checkedAt: stamp.toISOString(), entry,
        selection: { metric: "total_tokens", shortMaxTotalTokens: 272000,
            short: { "短上下文输入": "input_token", "短上下文缓存读取": "cached_input_token", "短上下文输出": "output_token" },
            long: { "长上下文输入": "input_token", "长上下文缓存读取": "cached_input_token", "长上下文输出": "output_token" } } } };
const rules = { ...deriveModelPriceRules(derivation), derivation };
const quote = { schemaVersion: 1, budgetCredits: "50", inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360", usageSource: "responses" };
let draft: any, publication: any, task: any;
const audit = () => ({ actorId: owner, requestId: crypto.randomUUID() });
const write = () => ({ modelId, expectedVersion: 0, binding, rules, priceNote: "native-only synthetic" });

beforeAll(async () => {
    const { rows: [boundary] } = await observer.pool.query(`SELECT current_database() AS name, current_user AS role,
        host(inet_server_addr()) AS host, to_regnamespace('canvas_saas') IS NULL AS fresh,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged`);
    expect(boundary).toEqual({ name: "context_tiers_native", role: "context_test_app", host: "127.0.0.1", fresh: true, privileged: false });
    await migrateDatabase(observer.db);
    await blocker.connect(); connected = true;
    await observer.pool.query('INSERT INTO canvas_saas."user" (id,name,email,role,email_verified) VALUES ($1,$1,$2,\'admin\',true),($3,$3,$4,\'user\',true)', [owner, "context-owner@example.test", otherOwner, "context-other@example.test"]);
    await observer.pool.query("INSERT INTO canvas_saas.wallet(user_id,available_units) VALUES ($1,1000),($2,1000)", [owner, otherOwner]);
    await observer.pool.query("INSERT INTO canvas_saas.model_provider(id,display_name,adapter,endpoint,secret_ref,enabled) VALUES ($1,'native','sub2api',$2,'synthetic',true)", [binding.providerId, binding.endpoint]);
    await saveProviderCredential(observer.db, "native-context-synthetic-secret-at-least-32", binding.providerId, "native-context-synthetic-key");
    await observer.pool.query("INSERT INTO canvas_saas.model_catalog(id,public_id,provider_id,provider_model,display_name,capability,enabled) VALUES ($1,$1,$2,$3,'native','text',true)", [modelId, binding.providerId, binding.providerModel]);
    await observer.pool.query("INSERT INTO canvas_saas.official_price_source(id,version,checked_at,status,entries) VALUES ('openai',1,$1,'ready',$2)", [stamp, JSON.stringify([entry])]);
    await observer.pool.query("INSERT INTO canvas_saas.official_price_mapping(model_id,reference_id,version,provider_id_snapshot,provider_model_snapshot,adapter_snapshot,endpoint_snapshot,capability_snapshot) VALUES ($1,$2,1,$3,$4,'sub2api',$5,'text')", [modelId, entry.id, binding.providerId, binding.providerModel, binding.endpoint]);
}, 30_000);

afterAll(async () => {
    try { if (connected) await blocker.query("ROLLBACK"); }
    finally {
        const closed = await Promise.allSettled([blocker.end(), observer.close(), first.close(), second.close()]);
        if (closed.some(value => value.status === "rejected")) throw new Error("Native context connections did not close");
    }
});

test("installs this source root's full migration set and inspects final native functions", async () => {
    const journal = JSON.parse(await readFile(join(sourceRoot, "packages/database/migrations/meta/_journal.json"), "utf8"));
    const count = (await observer.pool.query("SELECT count(*)::int AS n FROM canvas_migrations.__drizzle_migrations")).rows[0].n;
    expect(count).toBe(journal.entries.length);
    const functions: Record<string, string> = {};
    for (const name of ["check_model_price_publication_source", "bind_generation_task_price_publication", "protect_generation_task_price_source"]) {
        const def = (await observer.pool.query("SELECT pg_get_functiondef($1::regproc) AS definition", [`canvas_saas.${name}`])).rows[0].definition;
        functions[name] = def;
        expect(def).toContain(name);
    }
    expect(functions.check_model_price_publication_source).toContain("text_cached_tokens");
    expect(functions.bind_generation_task_price_publication).toContain("cachedInputCreditsPerMillion");
    expect(functions.bind_generation_task_price_publication).toContain("source.id");
    expect(functions.protect_generation_task_price_source).toContain("OLD.owner_id");
    expect(functions.protect_generation_task_price_source).toContain("OLD.text_quote_snapshot");
    if (label === "main") {
        expect(journal.entries.some((item: any) => item.tag === "0030_video_source_binding")).toBe(true);
        expect(functions.bind_generation_task_price_publication).toContain("expected_video_quote");
    } else {
        expect(journal.entries.some((item: any) => /^0029|^0030|^0031/.test(item.tag))).toBe(false);
        expect(functions.bind_generation_task_price_publication).not.toContain("expected_video_quote");
        expect(functions.check_model_price_publication_source).toContain("audio_request");
    }
    console.log(JSON.stringify({ kind: "context-native-installed-schema", label, count, bindingVideoBranch: functions.bind_generation_task_price_publication.includes("expected_video_quote"), sourceTextThreeBuckets: true, immutableOwnerAndQuote: true }));
});

test("saves full v2 source and publishes the one-band short quote without a SQL change", async () => {
    const saved = await createModelPriceDraft(observer.db, write(), audit());
    expect(saved.status).toBe("saved"); draft = saved.draft;
    expect(draft.rules.derivation.source.entry.rates.length).toBe(10);
    const input = { modelId, draftId: draft.id, expectedDraftVersion: 1, expectedPriceVersion: 0, binding,
        publicPriceNote: composeTextContextTierNote(rules, binding, "native synthetic") };
    const published = await publishModelPriceDraft(observer.db, input, audit());
    expect(published.status).toBe("published"); publication = published.publication;
    expect((await publishModelPriceDraft(observer.db, input, audit())).publication.id).toBe(publication.id);
    const created = await createGenerationTaskRepository(observer.db).create({ ownerId: owner, modelId, inputSnapshot: { prompt: "native synthetic" }, parameterSnapshot: {}, priceVersion: 1,
        textQuoteSnapshot: quote, idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() });
    task = created.task;
    expect(task.pricePublicationId).toBe(publication.id);
    expect(task.textQuoteSnapshot).toEqual(quote);
    const rows = (await observer.pool.query("SELECT d.rules->'derivation'->>'schemaVersion' AS version FROM canvas_saas.generation_task t JOIN canvas_saas.model_price_publication p ON p.id=t.price_publication_id JOIN canvas_saas.model_price_draft d ON d.id=p.draft_id WHERE t.id=$1", [task.id])).rows;
    expect(rows).toEqual([{ version: "2" }]);
});

async function insertTask(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = { id: crypto.randomUUID(), owner_id: owner, input_snapshot: { prompt: "native rejected" }, model_id: modelId, parameter_snapshot: {}, price_version: 1,
        text_quote_snapshot: quote, idempotency_key: crypto.randomUUID(), request_id: crypto.randomUUID(), ...overrides };
    const fields = Object.keys(values);
    return observer.pool.query(`INSERT INTO canvas_saas.generation_task (${fields.join(",")}) VALUES (${fields.map((_, index) => "$" + (index + 1)).join(",")})`, fields.map(key => ["input_snapshot", "parameter_snapshot", "text_quote_snapshot"].includes(key) ? JSON.stringify(values[key]) : values[key]));
}
async function sqlRejected(operation: Promise<unknown>) {
    let code: unknown;
    try { await operation; } catch (error) { code = (error as { code?: string }).code; }
    // Inspect PostgreSQL's error code without asking Bun's matcher to render a native PG Error.
    expect(typeof code).toBe("string");
    expect(["P0001", "23503", "23514"]).toContain(code);
}

test("native task binding rejects wrong model/version/publication/short price and extra quote fields", async () => {
    const before = (await observer.pool.query("SELECT count(*)::int AS n FROM canvas_saas.generation_task")).rows[0].n;
    for (const invalid of [
        { model_id: "unknown-model" }, { price_version: 999 }, { price_publication_id: crypto.randomUUID() },
        { text_quote_snapshot: { ...quote, inputCreditsPerMillion: "73" } }, { text_quote_snapshot: { ...quote, longInputCreditsPerMillion: "144" } },
        { text_quote_snapshot: { ...quote, usageSource: "chat_completions" } },
    ]) await sqlRejected(insertTask(invalid));
    expect((await observer.pool.query("SELECT count(*)::int AS n FROM canvas_saas.generation_task")).rows[0].n).toBe(before);
    for (const sql of [
        "UPDATE canvas_saas.model_price_draft SET price_note='changed' WHERE id=$1", "DELETE FROM canvas_saas.model_price_draft WHERE id=$1",
    ]) await sqlRejected(observer.pool.query(sql, [draft.id]));
    for (const sql of ["UPDATE canvas_saas.model_price_publication SET public_price_note='changed' WHERE id=$1", "DELETE FROM canvas_saas.model_price_publication WHERE id=$1"]) await sqlRejected(observer.pool.query(sql, [publication.id]));
    await sqlRejected(observer.pool.query("UPDATE canvas_saas.generation_task SET price_publication_id=NULL WHERE id=$1", [task.id]));
    await sqlRejected(observer.pool.query("UPDATE canvas_saas.generation_task SET text_quote_snapshot=$2 WHERE id=$1", [task.id, JSON.stringify({ ...quote, inputCreditsPerMillion: "73" })]));
});

test("a real second connection source refresh blocks save then rejects stale complete evidence", async () => {
    const changed = structuredClone(derivation); changed.saleMultiplier = "0.4";
    const input = { ...write(), expectedVersion: 1, rules: { ...deriveModelPriceRules(changed), derivation: changed } };
    const before = (await observer.pool.query("SELECT count(*)::int AS n FROM canvas_saas.model_price_draft")).rows[0].n;
    await blocker.query("BEGIN");
    let save: Promise<any> | undefined;
    try {
        const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await blocker.query("SELECT id FROM canvas_saas.official_price_source WHERE id='openai' FOR UPDATE");
        save = createModelPriceDraft(first.db, input, audit());
        const deadline = Date.now() + 5_000;
        let observed = false;
        while (Date.now() < deadline) {
            const rows = (await observer.pool.query("SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name='context-first' AND wait_event_type='Lock'")).rows;
            if (rows.some((row: any) => row.blockers.includes(blockerPid))) { observed = true; break; }
            await Bun.sleep(10);
        }
        expect(observed).toBe(true);
        await blocker.query("UPDATE canvas_saas.official_price_source SET version=2 WHERE id='openai'");
        await blocker.query("COMMIT");
        expect((await save).status).toBe("price_derivation_source_changed");
        expect((await observer.pool.query("SELECT count(*)::int AS n FROM canvas_saas.model_price_draft")).rows[0].n).toBe(before);
        expect((await observer.pool.query("SELECT rules->'derivation'->'source'->>'version' AS v FROM canvas_saas.model_price_draft WHERE id=$1", [draft.id])).rows).toEqual([{ v: "1" }]);
    } finally { await blocker.query("ROLLBACK"); if (save) await save; }
}, 30_000);

test("real concurrent exact capture and reconnect release recover one ledger pair without cross-owner access", async () => {
    const wallet = createWalletRepository(observer.db), a = createWalletRepository(first.db), b = createWalletRepository(second.db);
    const reservation = await wallet.reserve({ userId: owner, requestedUnits: "50", idempotencyKey: "context-native-reserve", referenceType: "generation", referenceId: task.id, taskId: task.id });
    const capture = { userId: owner, reservationId: reservation.id, capturedUnits: "25.48854", idempotencyKey: "context-native-capture", referenceType: "generation", referenceId: task.id };
    const pair = await Promise.all([a.capture(capture), b.capture(capture)]);
    expect(pair.map(item => item.capturedUnits)).toEqual(["25.48854", "25.48854"]);
    expect(await b.getReservation(otherOwner, reservation.id)).toBeNull();
    const fresh = createDatabase(url);
    try {
        const restarted = createWalletRepository(fresh.db);
        expect((await restarted.capture(capture)).capturedUnits).toBe("25.48854");
        const release = { userId: owner, reservationId: reservation.id, releasedUnits: "24.51146", idempotencyKey: "context-native-release", referenceType: "generation", referenceId: task.id };
        const released = await Promise.all([restarted.release(release), b.release(release)]);
        expect(released.map(item => item.releasedUnits)).toEqual(["24.51146", "24.51146"]);
    } finally { await fresh.close(); }
    expect(await wallet.get(owner)).toMatchObject({ availableUnits: "974.51146", reservedUnits: "0", totalUnits: "974.51146" });
    expect((await observer.pool.query("SELECT kind,count(*)::int AS n FROM canvas_saas.wallet_ledger WHERE reference_id=$1 GROUP BY kind ORDER BY kind", [task.id])).rows).toEqual([{ kind: "capture", n: 1 }, { kind: "release", n: 1 }, { kind: "reserve", n: 1 }]);
    expect((await observer.pool.query("SELECT count(*)::int AS n FROM canvas_saas.wallet_ledger WHERE user_id=$1", [otherOwner])).rows).toEqual([{ n: 0 }]);
});
