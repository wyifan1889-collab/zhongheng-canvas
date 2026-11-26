import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { user, wallet } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";
import { createAndEnqueueGenerationTask, quoteReserveAndEnqueueGenerationTask } from "../src/generation-dispatch";
import { createGenerationWalletSettlement, creditsForConsumedUnits, processGenerationJob } from "../src/generation-worker";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const meteredOwnerId = crypto.randomUUID();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([
        { id: ownerId, name: "Worker owner", email: `${ownerId}@example.test` },
        { id: meteredOwnerId, name: "Metered worker owner", email: `${meteredOwnerId}@example.test` },
    ]);
    await seedGenerationPricing(database.db, [
        { modelId: "image-demo", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 1 },
        { modelId: "text-demo", capability: "text", version: 2, billingUnit: "output_token", creditsPerUnit: 4 },
    ]);
});

afterAll(async () => { await database?.close(); });

async function createTask(key: string) {
    const dispatched = await createAndEnqueueGenerationTask(database.db, { async send() { return `job-${key}`; } }, {
        ownerId,
        inputSnapshot: { prompt: "worker" },
        modelId: "image-demo",
        parameterSnapshot: { width: 512 },
        idempotencyKey: key,
        requestId: `request-${key}`,
    });
    return dispatched;
}

describe("generation worker result boundary", () => {
    test("refuses missing or overflowing pricing snapshots", () => {
        expect(creditsForConsumedUnits({ billingUnitSnapshot: null, creditsPerUnitSnapshot: null } as any, 1)).toBeNull();
        expect(creditsForConsumedUnits({ billingUnitSnapshot: "output_token", creditsPerUnitSnapshot: -1 } as any, 2)).toBeNull();
        expect(creditsForConsumedUnits({ billingUnitSnapshot: "output_token", creditsPerUnitSnapshot: Number.MAX_SAFE_INTEGER + 1 } as any, 1)).toBeNull();
        expect(creditsForConsumedUnits({ billingUnitSnapshot: "output_token", creditsPerUnitSnapshot: Number.MAX_SAFE_INTEGER } as any, 2)).toBeNull();
    });

    test("settles actual usage and releases the quote remainder idempotently", async () => {
        await database.db.insert(wallet).values({ userId: ownerId, availableUnits: "10" });
        const dispatched = await quoteReserveAndEnqueueGenerationTask(database.db, { async send() { return "job-settle"; } }, {
            ownerId, inputSnapshot: { prompt: "settle" }, modelId: "image-demo", parameterSnapshot: {}, idempotencyKey: "worker-settle", requestId: "request-worker-settle",
        }, { modelId: "image-demo", priceVersion: 1, quotedUnits: 6, billingUnit: "request", creditsPerUnit: 1 });
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        let calls = 0;
        const dependencies = {
            async provider() { calls += 1; return { status: "succeeded" as const, consumedUnits: 4, resultSnapshot: { assetKey: "gen/settle.png" } }; },
            async deliver() { return { status: "visible" as const }; },
            settleBilling: createGenerationWalletSettlement(database.db),
        };
        const first = await processGenerationJob(database.db, payload, dependencies);
        const replay = await processGenerationJob(database.db, payload, dependencies);
        expect(first.task).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
        expect(replay.task.billingStatus).toBe("captured");
        expect(replay.result.consumedUnits).toBe(4);
        expect(calls).toBe(1);
        expect(await createWalletRepository(database.db).get(ownerId)).toMatchObject({ availableUnits: "6", reservedUnits: "0" });
        expect(await createWalletRepository(database.db).getReservation(ownerId, dispatched.reservation.id)).toMatchObject({ status: "captured", capturedUnits: "4", releasedUnits: "2" });
    });

    test("normalizes a provider success, persists delivery, and replays without a second call", async () => {
        const dispatched = await createTask("worker-success");
        let calls = 0;
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const dependencies = {
            async provider() {
                calls += 1;
                return { status: "succeeded" as const, providerStatus: 200, providerTaskId: "provider-1", resultSnapshot: { assetKey: "gen/1.png", contentType: "image/png" } };
            },
            async deliver() { return { status: "visible" as const }; },
        };
        const first = await processGenerationJob(database.db, payload, dependencies);
        const replay = await processGenerationJob(database.db, payload, dependencies);
        expect(first).toMatchObject({ replay: false, task: { executionStatus: "succeeded", deliveryStatus: "visible" }, result: { status: "succeeded" } });
        expect(replay).toMatchObject({ replay: true, task: { id: dispatched.task.id }, result: { providerTaskId: "provider-1" } });
        expect(calls).toBe(1);
        expect(await createGenerationResultRepository(database.db).get(ownerId, dispatched.task.id)).toMatchObject({ status: "succeeded", resultSnapshot: { assetKey: "gen/1.png" } });
    });

    test("recovers after the real capture committed but before the unused reservation was released", async () => {
        const crashOwnerId = crypto.randomUUID();
        await database.db.insert(user).values({ id: crashOwnerId, name: "Capture crash owner", email: `${crashOwnerId}@example.test` });
        await database.db.insert(wallet).values({ userId: crashOwnerId, availableUnits: "20" });
        const dispatched = await quoteReserveAndEnqueueGenerationTask(database.db, { async send() { return "synthetic-capture-crash"; } }, {
            ownerId: crashOwnerId, inputSnapshot: { prompt: "capture crash" }, modelId: "image-demo", parameterSnapshot: {},
            idempotencyKey: "capture-crash", requestId: "capture-crash-request",
        }, { modelId: "image-demo", priceVersion: 1, quotedUnits: 10, billingUnit: "request", creditsPerUnit: 1 });
        const tasks = createGenerationTaskRepository(database.db), wallets = createWalletRepository(database.db);
        await tasks.transitionExecution({ ownerId: crashOwnerId, taskId: dispatched.task.id, status: "running" });
        await createGenerationResultRepository(database.db).create({ ownerId: crashOwnerId, taskId: dispatched.task.id,
            status: "succeeded", consumedUnits: 7, resultSnapshot: { assetKey: "synthetic-capture-crash" } });
        await tasks.transitionExecution({ ownerId: crashOwnerId, taskId: dispatched.task.id, status: "succeeded" });
        await tasks.transitionDelivery({ ownerId: crashOwnerId, taskId: dispatched.task.id, status: "saved" });
        await tasks.transitionDelivery({ ownerId: crashOwnerId, taskId: dispatched.task.id, status: "visible" });
        await wallets.capture({ userId: crashOwnerId, reservationId: dispatched.reservation.id, capturedUnits: "7",
            idempotencyKey: `generation:${dispatched.task.id}:capture`, referenceType: "generation", referenceId: dispatched.task.id });
        expect(await wallets.getReservation(crashOwnerId, dispatched.reservation.id)).toMatchObject({ requestedUnits: "10", capturedUnits: "7", releasedUnits: "0", status: "pending" });
        expect(await wallets.get(crashOwnerId)).toMatchObject({ availableUnits: "10", reservedUnits: "3" });
        let providerCalls = 0, deliveryCalls = 0;
        const dependencies = {
            async provider() { providerCalls++; return { status: "failed" as const, errorCode: "unexpected_provider_call" }; },
            async deliver() { deliveryCalls++; return { status: "visible" as const }; },
            settleBilling: createGenerationWalletSettlement(database.db),
        };
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId: crashOwnerId, requestId: dispatched.task.requestId };
        const recovered = await processGenerationJob(database.db, payload, dependencies);
        expect(recovered).toMatchObject({ replay: true, task: { billingStatus: "captured", executionStatus: "succeeded", deliveryStatus: "visible" }, result: { consumedUnits: 7 } });
        const finalWallet = await wallets.get(crashOwnerId), finalReservation = await wallets.getReservation(crashOwnerId, dispatched.reservation.id);
        const finalLedger = await wallets.listLedger(crashOwnerId);
        expect(finalWallet).toMatchObject({ availableUnits: "13", reservedUnits: "0", totalUnits: "13", version: 4 });
        expect(finalReservation).toMatchObject({ requestedUnits: "10", capturedUnits: "7", releasedUnits: "3", status: "captured" });
        expect(finalLedger).toHaveLength(3);
        expect(finalLedger.filter((entry) => entry.kind === "capture")).toMatchObject([{ deltaAvailableUnits: "0", deltaReservedUnits: "-7", referenceId: dispatched.task.id }]);
        expect(finalLedger.filter((entry) => entry.kind === "release")).toMatchObject([{ deltaAvailableUnits: "3", deltaReservedUnits: "-3", referenceId: dispatched.task.id }]);
        expect((await processGenerationJob(database.db, payload, dependencies)).task.billingStatus).toBe("captured");
        expect(await wallets.get(crashOwnerId)).toEqual(finalWallet);
        expect(await wallets.getReservation(crashOwnerId, dispatched.reservation.id)).toEqual(finalReservation);
        expect(await wallets.listLedger(crashOwnerId)).toEqual(finalLedger);
        expect(providerCalls).toBe(0); expect(deliveryCalls).toBe(0);
    });

    test("converts provider meter units with the task pricing snapshot before capture", async () => {
        await database.db.insert(wallet).values({ userId: meteredOwnerId, availableUnits: "500" });
        const dispatched = await quoteReserveAndEnqueueGenerationTask(database.db, { async send() { return "job-metered"; } }, {
            ownerId: meteredOwnerId, inputSnapshot: { prompt: "metered" }, modelId: "text-demo", parameterSnapshot: {}, idempotencyKey: "worker-metered", requestId: "request-worker-metered",
        }, { modelId: "text-demo", priceVersion: 2, quotedUnits: 400, billingUnit: "output_token", creditsPerUnit: 4 });
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId: meteredOwnerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "succeeded" as const, consumedUnits: 100, resultSnapshot: { text: "ok" } }; },
            async deliver() { return { status: "visible" as const }; },
            settleBilling: createGenerationWalletSettlement(database.db),
        });
        expect(result.task).toMatchObject({ billingStatus: "captured", billingUnitSnapshot: "output_token", creditsPerUnitSnapshot: 4 });
        expect(result.result.consumedUnits).toBe(100);
        expect(await createWalletRepository(database.db).get(meteredOwnerId)).toMatchObject({ availableUnits: "100", reservedUnits: "0" });
        expect(await createWalletRepository(database.db).getReservation(meteredOwnerId, dispatched.reservation.id)).toMatchObject({ capturedUnits: "400", releasedUnits: "0", status: "captured" });
    });

    test("provider rejection marks delivery failed and releases a reserved task", async () => {
        const dispatched = await createTask("worker-failed");
        await createGenerationTaskRepository(database.db).transitionBilling({ ownerId, taskId: dispatched.task.id, status: "reserved" });
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "failed" as const, errorCode: "provider_rejected", providerStatus: 429 }; },
        });
        expect(result.task).toMatchObject({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "pending_review" });
        expect(result.result).toMatchObject({ status: "failed", errorCode: "provider_rejected", providerStatus: 429 });
    });

    test("injected wallet settlement releases a failed reserved task", async () => {
        const dispatched = await quoteReserveAndEnqueueGenerationTask(database.db, { async send() { return "job-failed-settle"; } }, {
            ownerId, inputSnapshot: { prompt: "failed-settle" }, modelId: "image-demo", parameterSnapshot: {}, idempotencyKey: "worker-failed-settle", requestId: "request-worker-failed-settle",
        }, { modelId: "image-demo", priceVersion: 1, quotedUnits: 2, billingUnit: "request", creditsPerUnit: 1 });
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "failed" as const, errorCode: "provider_rejected", providerStatus: 429 }; },
            settleBilling: createGenerationWalletSettlement(database.db),
        });
        expect(result.task).toMatchObject({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released" });
        expect(await createWalletRepository(database.db).getReservation(ownerId, dispatched.reservation.id)).toMatchObject({ status: "released", capturedUnits: "0", releasedUnits: "2" });
    });

    test("timeout becomes unknown and moves reserved billing to review without retrying", async () => {
        const dispatched = await createTask("worker-unknown");
        await createGenerationTaskRepository(database.db).transitionBilling({ ownerId, taskId: dispatched.task.id, status: "reserved" });
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "unknown" as const, errorCode: "provider_timeout", unknownReason: "provider_timeout" }; },
        });
        expect(result.task).toMatchObject({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
        expect(result.result).toMatchObject({ status: "unknown", errorCode: "provider_timeout", unknownReason: "provider_timeout" });
    });

    test("invalid text response preserves the real reservation and ledger through replay", async () => {
        const textOwnerId = crypto.randomUUID();
        await database.db.insert(user).values({ id: textOwnerId, name: "Unknown text owner", email: `${textOwnerId}@example.test` });
        await database.db.insert(wallet).values({ userId: textOwnerId, availableUnits: "20" });
        const dispatched = await quoteReserveAndEnqueueGenerationTask(database.db, { async send() { return "job-invalid-text"; } }, {
            ownerId: textOwnerId, inputSnapshot: { prompt: "invalid text" }, modelId: "text-demo", parameterSnapshot: {},
            idempotencyKey: "worker-invalid-text", requestId: "request-worker-invalid-text",
        }, { modelId: "text-demo", priceVersion: 2, quotedUnits: 8, billingUnit: "output_token", creditsPerUnit: 4 });
        const wallets = createWalletRepository(database.db);
        const beforeWallet = await wallets.get(textOwnerId);
        const beforeReservation = await wallets.getReservation(textOwnerId, dispatched.reservation.id);
        const beforeLedger = await wallets.listLedger(textOwnerId);
        expect(beforeWallet).toMatchObject({ availableUnits: "12", reservedUnits: "8" });
        expect(beforeReservation).toMatchObject({ status: "pending", requestedUnits: "8", capturedUnits: "0", releasedUnits: "0" });
        expect(beforeLedger).toHaveLength(1);
        expect(beforeLedger[0]).toMatchObject({ kind: "reserve", deltaAvailableUnits: "-8", deltaReservedUnits: "8", referenceType: "generation", referenceId: dispatched.task.id });
        let providerCalls = 0;
        let deliveryCalls = 0;
        const dependencies = {
            async provider() {
                providerCalls += 1;
                return { status: "unknown" as const, providerStatus: 200, errorCode: "provider_text_invalid_response", unknownReason: "provider_text_invalid_response" };
            },
            async deliver() { deliveryCalls += 1; return { status: "visible" as const }; },
            settleBilling: createGenerationWalletSettlement(database.db),
        };
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId: textOwnerId, requestId: dispatched.task.requestId };
        for (const replay of [false, true]) {
            const result = await processGenerationJob(database.db, payload, dependencies);
            expect(result).toMatchObject({ replay, task: { executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" }, delivery: { status: "unknown" } });
            expect(await createGenerationResultRepository(database.db).get(textOwnerId, dispatched.task.id)).toMatchObject({ status: "unknown", providerStatus: 200, errorCode: "provider_text_invalid_response", unknownReason: "provider_text_invalid_response", consumedUnits: null, resultSnapshot: {} });
            expect(await wallets.get(textOwnerId)).toEqual(beforeWallet);
            expect(await wallets.getReservation(textOwnerId, dispatched.reservation.id)).toEqual(beforeReservation);
            expect(await wallets.listLedger(textOwnerId)).toEqual(beforeLedger);
        }
        expect(providerCalls).toBe(1);
        expect(deliveryCalls).toBe(0);
    });

    test("a replay after a running worker crash records unknown without calling the provider again", async () => {
        const dispatched = await createTask("worker-recovery");
        await createGenerationTaskRepository(database.db).transitionExecution({ ownerId, taskId: dispatched.task.id, status: "running" });
        let calls = 0;
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { calls += 1; return { status: "succeeded" as const, resultSnapshot: {} }; },
            runningLeaseMs: 0,
        });
        expect(result).toMatchObject({ replay: true, task: { executionStatus: "unknown", deliveryStatus: "unknown" }, result: { status: "unknown" } });
        expect(calls).toBe(0);
    });

    test("atomically claims queued work so a duplicate message cannot call the provider twice", async () => {
        const dispatched = await createTask("worker-claim");
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        let calls = 0;
        let started!: () => void;
        let release!: () => void;
        const providerStarted = new Promise<void>((resolve) => { started = resolve; });
        const providerRelease = new Promise<void>((resolve) => { release = resolve; });
        const firstPromise = processGenerationJob(database.db, payload, {
            async provider() {
                calls += 1;
                started();
                await providerRelease;
                return { status: "failed" as const, errorCode: "provider_rejected" };
            },
        });
        await providerStarted;
        await expect(processGenerationJob(database.db, payload, {
            async provider() { calls += 1; return { status: "failed" as const, errorCode: "duplicate" }; },
        })).rejects.toMatchObject({ code: "invalid_state" });
        release();
        await firstPromise;
        expect(calls).toBe(1);
    });

    test("reconciles a committed result when the worker crashed before its task transition", async () => {
        const dispatched = await createTask("worker-result-commit");
        const tasks = createGenerationTaskRepository(database.db);
        await tasks.transitionExecution({ ownerId, taskId: dispatched.task.id, status: "running" });
        const resultRepository = createGenerationResultRepository(database.db);
        await resultRepository.create({ taskId: dispatched.task.id, ownerId, status: "succeeded", resultSnapshot: { assetKey: "gen/recovered.png" } });
        let calls = 0;
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { calls += 1; return { status: "succeeded" as const, resultSnapshot: {} }; },
        });
        expect(result).toMatchObject({ replay: true, task: { executionStatus: "succeeded", deliveryStatus: "pending" }, result: { status: "succeeded" } });
        expect(calls).toBe(0);
    });
});
