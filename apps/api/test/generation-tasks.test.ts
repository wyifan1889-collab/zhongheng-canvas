import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createGenerationTaskRepository, GenerationTaskError } from "@infinite-canvas/database/generation-tasks";
import { generationTask, user } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const otherOwnerId = crypto.randomUUID();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([
        { id: ownerId, name: "Generation owner", email: `${ownerId}@example.test` },
        { id: otherOwnerId, name: "Generation other", email: `${otherOwnerId}@example.test` },
    ]);
});

afterAll(async () => { await database?.close(); });

describe("generation task identity and state boundaries", () => {
    test("same owner and idempotency key replays the original task without duplicating it", async () => {
        const repository = createGenerationTaskRepository(database.db);
        const input = {
            ownerId,
            projectId: "project-1",
            nodeId: "node-1",
            inputSnapshot: { prompt: "a quiet lake", nested: { b: 2, a: 1 } },
            modelId: "image-demo",
            parameterSnapshot: { width: 1024, height: 1024 },
            priceVersion: 3,
            quotedUnits: 12,
            billingUnitSnapshot: "request",
            creditsPerUnitSnapshot: 1,
            idempotencyKey: "task-create-1",
            requestId: "request-1",
        };
        const first = await repository.create(input);
        const replay = await repository.create({
            ...input,
            requestId: "request-after-timeout",
            inputSnapshot: { nested: { a: 1, b: 2 }, prompt: "a quiet lake" },
        });
        expect(first.created).toBe(true);
        expect(replay.created).toBe(false);
        expect(replay.task.id).toBe(first.task.id);
        expect(await database.db.select().from(generationTask)).toHaveLength(1);
    });

    test("a reused key with a different payload is rejected and ownership remains scoped", async () => {
        const repository = createGenerationTaskRepository(database.db);
        await expect(repository.create({
            ownerId,
            inputSnapshot: { prompt: "different" },
            modelId: "image-demo",
            parameterSnapshot: {},
            idempotencyKey: "task-create-1",
            requestId: "request-conflict",
        })).rejects.toMatchObject<GenerationTaskError>({ code: "idempotency_conflict" });
        const otherAccountTask = await repository.create({
            ownerId: otherOwnerId,
            inputSnapshot: { prompt: "different" },
            modelId: "image-demo",
            parameterSnapshot: {},
            idempotencyKey: "task-create-1",
            requestId: "request-other-owner",
        });
        expect(otherAccountTask.created).toBe(true);
        expect(await repository.get(otherOwnerId, "missing-task")).toBeNull();
    });

    test("execution, delivery and billing state transitions remain independent", async () => {
        const repository = createGenerationTaskRepository(database.db);
        const created = await repository.create({
            ownerId,
            inputSnapshot: { prompt: "state machine" },
            modelId: "image-demo",
            parameterSnapshot: {},
            idempotencyKey: "task-state-1",
            requestId: "request-state-1",
        });
        const queued = await repository.transitionExecution({ ownerId, taskId: created.task.id, status: "queued" });
        expect(queued).toMatchObject({ executionStatus: "queued", deliveryStatus: "pending", billingStatus: "unbilled" });
        await repository.transitionExecution({ ownerId, taskId: created.task.id, status: "running", providerTaskId: "provider-task-1" });
        const unknown = await repository.transitionExecution({ ownerId, taskId: created.task.id, status: "unknown", unknownReason: "provider response timed out" });
        expect(unknown).toMatchObject({ executionStatus: "unknown", providerTaskId: "provider-task-1", unknownReason: "provider response timed out" });
        const reconciled = await repository.transitionExecution({ ownerId, taskId: created.task.id, status: "succeeded" });
        expect(reconciled).toMatchObject({ executionStatus: "succeeded", unknownReason: null });
        const saved = await repository.transitionDelivery({ ownerId, taskId: created.task.id, status: "saved" });
        expect(saved).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "unbilled" });
        await repository.transitionDelivery({ ownerId, taskId: created.task.id, status: "visible" });
        await repository.transitionBilling({ ownerId, taskId: created.task.id, status: "reserved" });
        const review = await repository.transitionBilling({ ownerId, taskId: created.task.id, status: "pending_review" });
        expect(review).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "pending_review" });
        const released = await repository.transitionBilling({ ownerId, taskId: created.task.id, status: "released" });
        expect(released.billingStatus).toBe("released");
    });

    test("invalid transitions and missing unknown reasons fail closed", async () => {
        const repository = createGenerationTaskRepository(database.db);
        const created = await repository.create({
            ownerId,
            inputSnapshot: { prompt: "invalid transition" },
            modelId: "image-demo",
            parameterSnapshot: {},
            idempotencyKey: "task-state-2",
            requestId: "request-state-2",
        });
        await expect(repository.transitionExecution({ ownerId, taskId: created.task.id, status: "unknown" }))
            .rejects.toMatchObject<GenerationTaskError>({ code: "invalid_input" });
        await expect(repository.transitionExecution({ ownerId, taskId: created.task.id, status: "succeeded" }))
            .rejects.toMatchObject<GenerationTaskError>({ code: "invalid_transition" });
        await expect(repository.transitionBilling({ ownerId, taskId: created.task.id, status: "captured" }))
            .rejects.toMatchObject<GenerationTaskError>({ code: "invalid_transition" });
    });
});
