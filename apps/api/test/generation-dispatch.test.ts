import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generationTask, user, wallet, walletReservation } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createTestDatabase } from "./database";
import { computeServerGenerationQuotedUnits, createAndEnqueueGenerationTask, quoteReserveAndEnqueueGenerationTask, quoteReserveAndEnqueueServerGenerationTask, resolveGenerationQuote, resolveServerGenerationQuote } from "../src/generation-dispatch";
import { seedGenerationPricing } from "./generation-fixtures";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const serverPolicyOwnerId = crypto.randomUUID();
const pricedRequestOwnerId = crypto.randomUUID();
const pricedTokenOwnerId = crypto.randomUUID();
const overflowOwnerId = crypto.randomUUID();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([
        { id: ownerId, name: "Dispatch owner", email: `${ownerId}@example.test` },
        { id: serverPolicyOwnerId, name: "Server policy owner", email: `${serverPolicyOwnerId}@example.test` },
        ...[pricedRequestOwnerId, pricedTokenOwnerId, overflowOwnerId].map((id) => ({ id, name: "Priced dispatch owner", email: `${id}@example.test` })),
    ]);
    await seedGenerationPricing(database.db, [
        { modelId: "image-demo", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 1 },
        { modelId: "image-priced", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 7 },
        { modelId: "text-priced", capability: "text", version: 1, billingUnit: "output_token", creditsPerUnit: 4 },
        { modelId: "text-overflow", capability: "text", version: 1, billingUnit: "output_token", creditsPerUnit: Number.MAX_SAFE_INTEGER },
    ]);
});

afterAll(async () => { await database?.close(); });

function input(idempotencyKey: string, requestId = `request-${idempotencyKey}`) {
    return {
        ownerId,
        inputSnapshot: { prompt: "dispatch this" },
        modelId: "image-demo",
        parameterSnapshot: { width: 1024 },
        idempotencyKey,
        requestId,
    };
}

describe("generation task dispatch boundary", () => {
    test("server quote policy computes request units and refuses self-reported input tokens", async () => {
        const quote = await resolveServerGenerationQuote(database.db, {
            modelId: "image-demo",
            inputSnapshot: { prompt: "one request" },
            parameterSnapshot: { quotedUnits: 999 },
        });
        expect(quote).toMatchObject({ modelId: "image-demo", priceVersion: 1, billingUnit: "request", quotedUnits: 1, creditsPerUnit: 1 });
        expect(computeServerGenerationQuotedUnits("output_token", { max_tokens: 120 })).toBe(120);
        expect(() => computeServerGenerationQuotedUnits("input_token", { inputTokens: 1 })).toThrow("tokenizer");
    });

    test("server dispatch wrapper reserves the policy result instead of a client total", async () => {
        await database.db.insert(wallet).values({ userId: serverPolicyOwnerId, availableUnits: "20" });
        const result = await quoteReserveAndEnqueueServerGenerationTask(database.db, { async send() { return "job-server-policy"; } }, {
            ...input("server-policy"), ownerId: serverPolicyOwnerId,
        });
        expect(result.task).toMatchObject({ quotedUnits: 1, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 1, billingStatus: "reserved" });
        expect(result.reservation).toMatchObject({ requestedUnits: "1", status: "pending", taskId: result.task.id });
    });

    test("request pricing reserves credits once while explicit server quotes remain credit totals", async () => {
        await database.db.insert(wallet).values({ userId: pricedRequestOwnerId, availableUnits: "20" });
        let sent = 0;
        const queue = { async send() { return `priced-request-${++sent}`; } };
        const request = { ...input("priced-request"), ownerId: pricedRequestOwnerId, modelId: "image-priced" };
        const first = await quoteReserveAndEnqueueServerGenerationTask(database.db, queue, request);
        const replay = await quoteReserveAndEnqueueServerGenerationTask(database.db, queue, request);
        expect(first.task).toMatchObject({ quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7 });
        expect(first.reservation.requestedUnits).toBe("7");
        expect(replay).toMatchObject({ created: false, reservation: { id: first.reservation.id } });
        expect(sent).toBe(1);
        expect(await createWalletRepository(database.db).get(pricedRequestOwnerId)).toMatchObject({ availableUnits: "13", reservedUnits: "7" });

        const explicit = await resolveGenerationQuote(database.db, { modelId: "image-priced", quotedUnits: 13 });
        expect(explicit).toMatchObject({ quotedUnits: 13, creditsPerUnit: 7 });
        const result = await quoteReserveAndEnqueueGenerationTask(database.db, queue, { ...request, idempotencyKey: "explicit-credit-total" }, explicit);
        expect(result.reservation.requestedUnits).toBe("13");
        expect(await createWalletRepository(database.db).get(pricedRequestOwnerId)).toMatchObject({ availableUnits: "0", reservedUnits: "20" });
    });

    test("output token pricing converts the maximum token count to reserved credits", async () => {
        await database.db.insert(wallet).values({ userId: pricedTokenOwnerId, availableUnits: "12" });
        const result = await quoteReserveAndEnqueueServerGenerationTask(database.db, { async send() { return "priced-token-job"; } }, {
            ...input("priced-tokens"), ownerId: pricedTokenOwnerId, modelId: "text-priced",
            parameterSnapshot: { max_tokens: 3, quotedUnits: 1 },
        });
        expect(result.task).toMatchObject({ quotedUnits: 12, billingUnitSnapshot: "output_token", creditsPerUnitSnapshot: 4 });
        expect(result.reservation.requestedUnits).toBe("12");
        expect(await createWalletRepository(database.db).get(pricedTokenOwnerId)).toMatchObject({ availableUnits: "0", reservedUnits: "12" });
    });

    test("overflowing credit quotes reject before creating a task, reservation or queue message", async () => {
        await database.db.insert(wallet).values({ userId: overflowOwnerId, availableUnits: "20" });
        let sent = 0;
        await expect(quoteReserveAndEnqueueServerGenerationTask(database.db, { async send() { sent += 1; return "must-not-enqueue"; } }, {
            ...input("overflowing-quote"), ownerId: overflowOwnerId, modelId: "text-overflow",
            parameterSnapshot: { max_tokens: 2 },
        })).rejects.toThrow("生成报价积分溢出");
        expect(sent).toBe(0);
        expect(await database.db.select().from(generationTask).where(eq(generationTask.ownerId, overflowOwnerId))).toHaveLength(0);
        expect(await database.db.select().from(walletReservation).where(eq(walletReservation.userId, overflowOwnerId))).toHaveLength(0);
        expect(await createWalletRepository(database.db).get(overflowOwnerId)).toMatchObject({ availableUnits: "20", reservedUnits: "0", version: 1 });
    });

    test("commits a queued task and exactly one queue message", async () => {
        const sent: Array<{ name: string; payload: unknown; options?: { db?: unknown } }> = [];
        const queue = {
            async send(name: string, payload: any, options?: { db?: unknown }) {
                sent.push({ name, payload, options });
                return "job-1";
            },
        };
        const first = await createAndEnqueueGenerationTask(database.db, queue, input("dispatch-1"));
        const replay = await createAndEnqueueGenerationTask(database.db, queue, input("dispatch-1"));
        expect(first).toMatchObject({ created: true, jobId: "job-1", task: { executionStatus: "queued" } });
        expect(replay).toMatchObject({ created: false, jobId: null, task: { id: first.task.id, executionStatus: "queued" } });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ name: "generation", payload: { schemaVersion: 1, taskId: first.task.id, ownerId, requestId: "request-dispatch-1" } });
        expect(sent[0].options?.db).toBeDefined();
    });

    test("queue failure rolls back the task", async () => {
        const queue = {
            async send() { throw new Error("queue unavailable"); },
        };
        await expect(createAndEnqueueGenerationTask(database.db, queue, input("dispatch-rollback"))).rejects.toThrow("queue unavailable");
        const retryQueue = { async send() { return "job-retry"; } };
        const retry = await createAndEnqueueGenerationTask(database.db, retryQueue, input("dispatch-rollback"));
        expect(retry.created).toBe(true);
        expect(retry.task.executionStatus).toBe("queued");
    });

    test("quote and reserve bind one reservation to one queued task and replay safely", async () => {
        await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "20" });
        const sent: string[] = [];
        const queue = { async send(_name: string, _payload: any) { sent.push("job"); return `job-${sent.length}`; } };
        const quote = { modelId: "image-demo", priceVersion: 1, quotedUnits: 6, billingUnit: "request" as const, creditsPerUnit: 1 };
        const first = await quoteReserveAndEnqueueGenerationTask(database.db, queue, input("reserve-1"), quote);
        const replay = await quoteReserveAndEnqueueGenerationTask(database.db, queue, input("reserve-1", "retry-request"), quote);
        expect(first).toMatchObject({ created: true, task: { executionStatus: "queued", billingStatus: "reserved", billingUnitSnapshot: "request", creditsPerUnitSnapshot: 1 }, reservation: { requestedUnits: "6", status: "pending", taskId: first.task.id } });
        expect(replay).toMatchObject({ created: false, jobId: null, task: { id: first.task.id, reservationId: first.reservation.id, billingStatus: "reserved" }, reservation: { id: first.reservation.id } });
        await expect(quoteReserveAndEnqueueGenerationTask(database.db, queue, input("reserve-1", "retry-price-change"), { modelId: "image-demo", priceVersion: 1, quotedUnits: 7, billingUnit: "request", creditsPerUnit: 1 })).rejects.toThrow("幂等键已用于其他生成请求");
        expect(sent).toHaveLength(1);
        expect(await createWalletRepository(database.db).get(ownerId)).toMatchObject({ availableUnits: "14", reservedUnits: "6" });
    });

    test("insufficient balance and queue failure do not leave a task or frozen credits", async () => {
        const insufficient = { async send() { throw new Error("must not enqueue"); } };
        await expect(quoteReserveAndEnqueueGenerationTask(database.db, insufficient, input("reserve-insufficient"), { modelId: "image-demo", priceVersion: 1, quotedUnits: 100, billingUnit: "request", creditsPerUnit: 1 })).rejects.toThrow("余额不足");
        const failedQueue = { async send() { throw new Error("queue unavailable"); } };
        await expect(quoteReserveAndEnqueueGenerationTask(database.db, failedQueue, input("reserve-rollback"), { modelId: "image-demo", priceVersion: 1, quotedUnits: 3, billingUnit: "request", creditsPerUnit: 1 })).rejects.toThrow("queue unavailable");
        await expect(quoteReserveAndEnqueueGenerationTask(database.db, failedQueue, input("reserve-forged-price"), { modelId: "image-demo", priceVersion: 1, quotedUnits: 3, billingUnit: "request", creditsPerUnit: 99 })).rejects.toThrow("生成报价与当前价格不匹配");
        expect(await createWalletRepository(database.db).get(ownerId)).toMatchObject({ availableUnits: "14", reservedUnits: "6" });
    });
});
