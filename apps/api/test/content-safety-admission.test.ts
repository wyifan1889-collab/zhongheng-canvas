import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { fromDrizzle } from "@infinite-canvas/jobs";
import { createRateStore, type RateBatchEntry, type RateStore, type RateTransactionRunner } from "@infinite-canvas/database/rate-limit";
import { enforceGenerationAdmission, type GenerationAdmissionInput } from "../src/content-safety-admission";
import type { GenerationRateConfig } from "../src/content-safety-config";
import { createTestDatabase } from "./database";

const input: GenerationAdmissionInput = { actorId: "synthetic-owner", requestId: "synthetic-request", peerIp: "198.51.100.42", modelId: "synthetic-model", capability: "image" };
const configured: GenerationRateConfig = { ip: { points: 2, duration: 13 }, user: { points: 5, duration: 19 }, models: [{ modelId: input.modelId, points: 3, duration: 17 }] };
const unusedTransaction: RateTransactionRunner = async () => { throw new Error("fake store does not execute SQL"); };
const noSingle = async (): Promise<never> => { throw new Error("generation must never use single consume"); };

test("explicitly disabled generation protection makes no calls even without IP or transaction", async () => {
    await enforceGenerationAdmission({ consume: noSingle }, { ip: null, user: null, models: [] }, { ...input, peerIp: undefined });
    await enforceGenerationAdmission({ consume: noSingle }, { ip: null, user: null, models: [{ modelId: "other", points: 1, duration: 1 }] }, input);
});
test("IP, user and model are submitted together using trusted resolved identities", async () => {
    const calls: RateBatchEntry[][] = [];
    const rates: RateStore = { consume: noSingle, async consumeMany(entries, transaction) { expect(transaction).toBe(unusedTransaction); calls.push([...entries]); return { allowed: true }; } };
    await enforceGenerationAdmission(rates, configured, input, unusedTransaction);
    expect(calls).toEqual([[
        { bucket: "generation-ip", identity: input.peerIp!, rule: configured.ip! },
        { bucket: "generation-user", identity: input.actorId, rule: configured.user! },
        { bucket: "generation-model", identity: input.modelId, rule: { points: 3, duration: 17 } },
    ]]);
    await enforceGenerationAdmission(rates, { ...configured, ip: null }, { ...input, peerIp: undefined, modelId: "other" }, unusedTransaction);
    expect(calls[1].map(call => call.bucket)).toEqual(["generation-user"]);
});
test("missing trusted identities or atomic capability fail before consuming any bucket", async () => {
    let calls = 0;
    const rates: RateStore = { consume: noSingle, async consumeMany() { calls++; return { allowed: true }; } };
    for (const peerIp of [undefined, "", "198.51.100.42, 203.0.113.1", "spoofed-body-ip"]) {
        await expect(enforceGenerationAdmission(rates, configured, { ...input, peerIp }, unusedTransaction)).rejects.toMatchObject({ status: 503 });
    }
    await expect(enforceGenerationAdmission(rates, configured, { ...input, actorId: " " }, unusedTransaction)).rejects.toMatchObject({ status: 503 });
    await expect(enforceGenerationAdmission(rates, configured, input)).rejects.toMatchObject({ status: 503 });
    await expect(enforceGenerationAdmission({ consume: noSingle }, configured, input, unusedTransaction)).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(0);
});
test("one atomic rejection returns retry-after once; failures and malformed decisions are sanitized", async () => {
    let calls = 0;
    await expect(enforceGenerationAdmission({ consume: noSingle, async consumeMany() { calls++; return { allowed: false, retryAfter: 23 }; } }, configured, input, unusedTransaction))
        .rejects.toMatchObject({ status: 429, code: "rate_limited", retryAfter: 23 });
    expect(calls).toBe(1);
    for (const consumeMany of [async () => { throw new Error("private-db-secret"); }, async () => ({ allowed: false as const, retryAfter: 0 })]) {
        try { await enforceGenerationAdmission({ consume: noSingle, consumeMany }, configured, input, unusedTransaction); throw new Error("expected rejection"); }
        catch (error) { expect(error).toMatchObject({ status: 503, code: "service_unavailable" }); expect(String(error)).not.toContain("private-db-secret"); }
    }
});
test("compound admission rolls back a preceding IP counter when the model rejects", async () => {
    const database = await createTestDatabase();
    const transaction: RateTransactionRunner = work => database.db.transaction(tx => work({ query: ({ text, values }) => fromDrizzle(tx as unknown as Parameters<typeof fromDrizzle>[0], sql).executeSql(text, values) }));
    try {
        const rates = createRateStore(database.pool, "synthetic-compound-test-secret");
        const rules: GenerationRateConfig = { ip: { points: 2, duration: 300 }, user: { points: 3, duration: 300 }, models: [{ modelId: input.modelId, points: 1, duration: 300 }] };
        await enforceGenerationAdmission(rates, rules, input, transaction);
        const snapshot = async () => (await database.pool.query({ text: 'SELECT key, points, expire FROM "canvas_saas"."rate_limit" ORDER BY key' }) as { rows: unknown[] }).rows;
        const before = await snapshot();
        await expect(enforceGenerationAdmission(rates, rules, { ...input, peerIp: "203.0.113.9", actorId: "other-owner" }, transaction)).rejects.toMatchObject({ status: 429 });
        expect(await snapshot()).toEqual(before);
        await enforceGenerationAdmission(rates, rules, { ...input, modelId: "unlisted" }, transaction);
        const fullIP = await snapshot();
        await expect(enforceGenerationAdmission(rates, rules, { ...input, modelId: "unlisted" }, transaction)).rejects.toMatchObject({ status: 429 });
        expect(await snapshot()).toEqual(fullIP);
        expect(JSON.stringify(await snapshot())).not.toContain(input.peerIp!);
        expect(JSON.stringify(await snapshot())).not.toContain(input.actorId);
        expect(JSON.stringify(await snapshot())).not.toContain(input.modelId);
    } finally { await database.close(); }
}, 30_000);
