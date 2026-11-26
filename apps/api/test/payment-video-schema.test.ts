import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDatabase } from "./database";

if (["DATABASE_URL", "SAAS_DATABASE_URL", "SAAS_TEST_DATABASE_URL"].some(key => process.env[key])) throw new Error("视频来源迁移烟测只使用独立内存库");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const parameters = { mode: "text", resolution: "720p", durationSeconds: 2, generateAudio: false, aspectRatio: "16:9" };
const band = { mode: "text", resolution: "720p", durationSeconds: "2", generateAudio: "false", aspectRatio: "16:9" };
const rules = { schemaVersion: 1, cost: null, sale: { template: "video_count", currency: "credit", bands: [{ parameters: band, rates: { video: "7" } }] },
    video: { schemaVersion: 1, protocol: "yunfei-grok-video-v1", usagePolicy: "delivered_video" } };
const binding = { providerId: crypto.randomUUID(), providerModel: "synthetic-video", adapter: "openai-compatible", endpoint: "https://synthetic.invalid/v1", capability: "video" };
beforeAll(async () => { database = await createTestDatabase(); }, 30_000);
afterAll(async () => { await database?.close(); });

async function rate(value: unknown, input: unknown = parameters) {
    const result = await database.db.execute(sql`SELECT canvas_saas.video_spec_task_credits(${JSON.stringify(value)}::jsonb, ${JSON.stringify(input)}::jsonb, ${JSON.stringify(binding)}::jsonb)::text AS credits`);
    return (result as { rows: Array<{ credits: string | null }> }).rows[0]?.credits;
}

test("formal migration accepts the explicit video band and rejects malformed or overlapping alternatives", async () => {
    expect(await rate(rules)).toBe("7");
    expect(await rate(rules, { ...parameters, mode: ["text"] })).toBeNull();
    expect(await rate({ ...rules, video: null })).toBeNull();
    expect(await rate({ ...rules, sale: { ...rules.sale, template: "video_second" } })).toBeNull();
    expect(await rate({ ...rules, sale: { ...rules.sale, bands: [{ parameters: band, rates: { video: "7.1" } }] } })).toBeNull();
    expect(await rate({ ...rules, sale: { ...rules.sale, bands: [...rules.sale.bands, { parameters: { ...band, durationSeconds: "2.0" }, rates: { video: "8" } }] } })).toBeNull();
    expect(await rate({ ...rules, sale: { ...rules.sale, bands: [...rules.sale.bands, { parameters: { ...band, generateAudio: null }, rates: { video: "8" } }] } })).toBeNull();
});

test("published video source, immutable task quote and deferred identity mirrors commit in the real statement order", async () => {
    const owner = crypto.randomUUID(), model = crypto.randomUUID(), publicId = `synthetic-${model}`;
    const draft = crypto.randomUUID(), price = crypto.randomUUID(), publication = crypto.randomUUID(), task = crypto.randomUUID();
    await database.db.execute(sql`INSERT INTO canvas_saas."user" (id,name,email) VALUES (${owner},'Synthetic SQL owner',${`${owner}@example.test`})`);
    await database.db.execute(sql`INSERT INTO canvas_saas.model_provider (id,display_name,adapter,endpoint,secret_ref)
        VALUES (${binding.providerId},'Synthetic video',${binding.adapter},${binding.endpoint},'synthetic-only')`);
    await database.db.execute(sql`INSERT INTO canvas_saas.model_catalog (id,provider_id,public_id,provider_model,display_name,capability)
        VALUES (${model},${binding.providerId},${publicId},${binding.providerModel},'Synthetic video','video')`);
    await database.db.transaction(async tx => {
        await tx.execute(sql`INSERT INTO canvas_saas.model_price_draft
            (id,model_id,version,rules,price_note,provider_id_snapshot,provider_model_snapshot,adapter_snapshot,endpoint_snapshot,capability_snapshot)
            VALUES (${draft},${model},1,${JSON.stringify(rules)}::jsonb,'Synthetic SQL fixture',${binding.providerId},${binding.providerModel},${binding.adapter},${binding.endpoint},'video')`);
        await tx.execute(sql`INSERT INTO canvas_saas.model_pricing (id,model_id,version,billing_unit,credits_per_unit,effective_from)
            VALUES (${price},${model},1,'video_specs',NULL,now())`);
        await tx.execute(sql`INSERT INTO canvas_saas.model_price_publication (id,draft_id,pricing_id,public_price_note) VALUES (${publication},${draft},${price},'Synthetic SQL fixture')`);
    });
    const quote = { schemaVersion: 1, protocol: "yunfei-grok-video-v1", usagePolicy: "delivered_video", publicationId: publication, priceVersion: 1,
        selectedBand: { parameters, creditsPerVideo: 7 }, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 7 };
    await database.db.transaction(async tx => {
        await tx.execute(sql`INSERT INTO canvas_saas.generation_task
            (id,owner_id,input_snapshot,model_id,parameter_snapshot,price_version,quoted_units,billing_unit_snapshot,credits_per_unit_snapshot,video_quote_snapshot,idempotency_key,request_id)
            VALUES (${task},${owner},'{"prompt":"Synthetic SQL check"}'::jsonb,${publicId},${JSON.stringify(parameters)}::jsonb,1,7,'request',7,${JSON.stringify(quote)}::jsonb,${task},${task})`);
        await tx.execute(sql`INSERT INTO canvas_saas.generation_video_stage
            (task_id,owner_id,protocol,provider_id,endpoint,provider_model,price_publication_id,parameters_snapshot,phase)
            VALUES (${task},${owner},'yunfei-grok-video-v1',${binding.providerId},${binding.endpoint},${binding.providerModel},${publication},${JSON.stringify(parameters)}::jsonb,'ready')`);
    });
    await database.db.transaction(async tx => {
        await tx.execute(sql`UPDATE canvas_saas.generation_video_stage SET phase='create_started',create_attempt_token='synthetic-original',create_started_at=now(),revision=1 WHERE task_id=${task}`);
        await tx.execute(sql`UPDATE canvas_saas.generation_task SET provider_task_id='synthetic-provider-id' WHERE id=${task}`);
        await tx.execute(sql`UPDATE canvas_saas.generation_video_stage SET phase='accepted',provider_task_id='synthetic-provider-id',revision=2 WHERE task_id=${task}`);
    });
    await expect(Promise.resolve(database.db.execute(sql`UPDATE canvas_saas.generation_video_stage SET provider_task_id='synthetic-replacement',revision=3 WHERE task_id=${task}`))).rejects.toThrow();
    await expect(Promise.resolve(database.db.execute(sql`UPDATE canvas_saas.generation_task SET video_quote_snapshot=NULL WHERE id=${task}`))).rejects.toThrow();
    await expect(Promise.resolve(database.db.execute(sql`DELETE FROM canvas_saas.generation_video_stage WHERE task_id=${task}`))).rejects.toThrow();
    await database.db.transaction(async tx => {
        await tx.execute(sql`UPDATE canvas_saas.generation_task SET execution_status='succeeded' WHERE id=${task}`);
        await tx.execute(sql`UPDATE canvas_saas.generation_video_stage SET phase='completed',completed_at=now(),revision=3 WHERE task_id=${task}`);
        await tx.execute(sql`INSERT INTO canvas_saas.generation_result (id,task_id,owner_id,status,provider_task_id,result_snapshot)
            VALUES (${crypto.randomUUID()},${task},${owner},'succeeded','synthetic-provider-id','{}'::jsonb)`);
    });
    const result = await database.db.execute(sql`SELECT t.provider_task_id, s.phase FROM canvas_saas.generation_task t JOIN canvas_saas.generation_video_stage s ON s.task_id=t.id WHERE t.id=${task}`);
    expect((result as { rows: unknown[] }).rows).toEqual([{ provider_task_id: "synthetic-provider-id", phase: "completed" }]);
});
