import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { user, wallet } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";
import { quoteReserveAndEnqueueGenerationTask } from "../src/generation-dispatch";
import { processGenerationJob } from "../src/generation-worker";
import { listGenerationReviewTasks, reconcileGenerationTask } from "../src/generation-reconciliation";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const imageOwnerId = crypto.randomUUID();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([ownerId, imageOwnerId].map(id => ({ id, name: "Review owner", email: `${id}@example.test` })));
    await seedGenerationPricing(database.db, [
        { modelId: "text-demo", capability: "text", version: 1, billingUnit: "request", creditsPerUnit: 1 },
        { modelId: "image-demo", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 1 },
    ]);
    await database.db.insert(wallet).values([ownerId, imageOwnerId].map(userId => ({ userId, availableUnits: "10" })));
});
afterAll(async () => { await database?.close(); });

async function unknownTask(ownerId: string, modelId: string) {
    const dispatched = await quoteReserveAndEnqueueGenerationTask(database.db, { async send() { return "job-review"; } }, {
        ownerId, inputSnapshot: { prompt: "review" }, modelId, parameterSnapshot: {}, idempotencyKey: "review-1", requestId: `request-review-${modelId}`,
    }, { modelId, priceVersion: 1, quotedUnits: 6, billingUnit: "request", creditsPerUnit: 1 });
    const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
    let calls = 0;
    const unknown = await processGenerationJob(database.db, payload, {
        async provider() { calls += 1; return { status: "unknown" as const, unknownReason: "provider_timeout" }; },
    });
    return { dispatched, unknown, calls: () => calls };
}

describe("generation unknown-result reconciliation boundary", () => {
    test("lists unknown text and resolves it without retrying the provider", async () => {
        const { dispatched, unknown, calls } = await unknownTask(ownerId, "text-demo");
        expect(unknown.task.billingStatus).toBe("pending_review");
        expect(await createWalletRepository(database.db).get(ownerId)).toMatchObject({ availableUnits: "4", reservedUnits: "6" });
        expect(await listGenerationReviewTasks(database.db, ownerId)).toEqual([expect.objectContaining({ id: dispatched.task.id, executionStatus: "unknown", billingStatus: "pending_review" })]);
        const resolved = await reconcileGenerationTask(database.db, {
            ownerId,
            taskId: dispatched.task.id,
            decision: { resolution: "succeeded", resultSnapshot: { kind: "text", text: "verified review result" }, consumedUnits: 3, delivery: "visible", providerStatus: 200, providerTaskId: "provider-review" },
        });
        expect(resolved).toMatchObject({ task: { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" }, result: { status: "succeeded", consumedUnits: 3, unknownReason: null, errorCode: null } });
        expect(calls()).toBe(1);
        expect(await createWalletRepository(database.db).get(ownerId)).toMatchObject({ availableUnits: "7", reservedUnits: "0" });
        expect(await createWalletRepository(database.db).getReservation(ownerId, dispatched.reservation.id)).toMatchObject({ status: "captured", capturedUnits: "3", releasedUnits: "3" });
        expect(await listGenerationReviewTasks(database.db, ownerId)).toEqual([]);
        const replay = await reconcileGenerationTask(database.db, {
            ownerId,
            taskId: dispatched.task.id,
            decision: { resolution: "succeeded", resultSnapshot: { kind: "text", text: "verified review result" }, consumedUnits: 3, delivery: "visible", providerStatus: 200, providerTaskId: "provider-review" },
        });
        expect(replay).toMatchObject({ task: { billingStatus: "captured" }, result: { status: "succeeded", consumedUnits: 3 } });
    });

    test("a legacy image cannot be declared delivered by hand, even when the decision claims text", async () => {
        const ownerId = imageOwnerId;
        const { dispatched, unknown, calls } = await unknownTask(ownerId, "image-demo");
        const taskId = dispatched.task.id, wallets = createWalletRepository(database.db);
        for (const resultSnapshot of [{ assetKey: "gen/review.png" }, { kind: "text", text: "not the original model type" }]) {
            await expect(reconcileGenerationTask(database.db, { ownerId, taskId,
                decision: { resolution: "succeeded", resultSnapshot, consumedUnits: 1, delivery: "visible", providerStatus: 200 },
            })).rejects.toMatchObject({ code: "invalid_resolution" });
        }
        expect(await createGenerationTaskRepository(database.db).get(ownerId, taskId)).toEqual(unknown.task);
        expect(await createGenerationResultRepository(database.db).get(ownerId, taskId)).toEqual(unknown.result);
        expect(await wallets.getReservation(ownerId, dispatched.reservation.id)).toMatchObject({ status: "pending", capturedUnits: "0", releasedUnits: "0" });
        const failed = await reconcileGenerationTask(database.db, { ownerId, taskId,
            decision: { resolution: "failed", errorCode: "provider_confirmed_failure", providerStatus: 400 },
        });
        expect(failed).toMatchObject({ task: { executionStatus: "failed", billingStatus: "released" }, result: { status: "failed" } });
        expect(await wallets.getReservation(ownerId, dispatched.reservation.id)).toMatchObject({ status: "released", capturedUnits: "0", releasedUnits: "6" });
        expect(calls()).toBe(1);
    });
});
