import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { user } from "@infinite-canvas/database/schema";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";
import { createAndEnqueueGenerationTask } from "../src/generation-dispatch";
import { GenerationQueryError, getGenerationTaskForOwner, getGenerationTaskByKeyForOwner, publicTask } from "../src/generation-query";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const otherOwnerId = crypto.randomUUID();
const publicTaskFields = ["id", "spaceId", "projectId", "nodeId", "modelId", "priceVersion", "quotedUnits",
    "billingUnitSnapshot", "creditsPerUnitSnapshot", "textQuoteSnapshot", "executionStatus", "deliveryStatus", "billingStatus",
    "unknownReason", "finishedAt", "createdAt", "updatedAt"].sort();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([
        { id: ownerId, name: "Query owner", email: `${ownerId}@example.test` },
        { id: otherOwnerId, name: "Other query owner", email: `${otherOwnerId}@example.test` },
    ]);
    await seedGenerationPricing(database.db, [{ modelId: "query-image", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 2 }]);
});

afterAll(async () => { await database?.close(); });

describe("generation owner-scoped query projection", () => {
    test("returns task/result state without provider, reservation or idempotency identifiers", async () => {
        const dispatched = await createAndEnqueueGenerationTask(database.db, { async send() { return "job-query"; } }, {
            ownerId,
            inputSnapshot: { prompt: "query" },
            modelId: "query-image",
            parameterSnapshot: {},
            idempotencyKey: "query-task",
            requestId: "query-request",
        });
        await createGenerationResultRepository(database.db).create({
            taskId: dispatched.task.id,
            ownerId,
            status: "succeeded",
            providerStatus: 200,
            providerTaskId: "provider-secret-id",
            resultSnapshot: {
                kind: "text", text: "safe result", usage: { outputTokens: 3 },
                media: { mediaId: dispatched.task.id, kind: "image", contentType: "image/png", sizeBytes: 1, etag: "etag" },
                providerUrl: "https://provider.example/secret", objectKey: "accounts/internal/object", providerPayload: { secret: "do-not-return" },
            },
        });
        const view = await getGenerationTaskForOwner(database.db, { ownerId, taskId: dispatched.task.id });
        expect(view.task).toMatchObject({ id: dispatched.task.id, modelId: "query-image", executionStatus: "queued", deliveryStatus: "pending" });
        expect(view.task).not.toHaveProperty("ownerId");
        expect(view.task).not.toHaveProperty("idempotencyKey");
        expect(view.task).not.toHaveProperty("reservationId");
        expect(view.task).not.toHaveProperty("providerTaskId");
        expect(Object.keys(view.task).sort()).toEqual(publicTaskFields);
        expect(await getGenerationTaskByKeyForOwner(database.db, { ownerId, idempotencyKey: "query-task" })).toEqual(view);
        expect(view.result).toMatchObject({ status: "succeeded", resultSnapshot: { kind: "text", text: "safe result", usage: { outputTokens: 3 }, media: { mediaId: dispatched.task.id } } });
        expect(view.result?.resultSnapshot).toEqual({ kind: "text", text: "safe result", usage: { outputTokens: 3 }, media: { mediaId: dispatched.task.id, kind: "image", contentType: "image/png", sizeBytes: 1, etag: "etag" } });
        expect(view.result).not.toHaveProperty("ownerId");
        expect(view.result).not.toHaveProperty("providerTaskId");
        expect(view.result).not.toHaveProperty("providerStatus");
    });

    test("public task whitelist excludes future private price evidence even if a repository returns it", async () => {
        const dispatched = await createAndEnqueueGenerationTask(database.db, { async send() { return "job-private-price"; } }, {
            ownerId, inputSnapshot: { prompt: "synthetic private prompt" }, modelId: "query-image", parameterSnapshot: {},
            idempotencyKey: "query-private-price", requestId: "query-private-price-request",
        });
        const marker = "synthetic-private-price-evidence";
        // Simulate a future repository addition; TypeScript's Pick does not strip runtime keys.
        const extended = { ...dispatched.task, pricePublicationId: marker,
            taskPriceSnapshot: { cost: { currency: "USD", amount: "0.1234567" }, privateNote: marker }, privateExtra: marker };
        const before = structuredClone(extended);
        const projected = publicTask(extended);
        expect(Object.keys(projected).sort()).toEqual(publicTaskFields);
        expect(projected).toEqual(publicTask(dispatched.task));
        expect(JSON.stringify(projected)).not.toContain(marker);
        expect(projected).not.toHaveProperty("taskPriceSnapshot");
        expect(extended).toEqual(before);
    });

    test("does not reveal another owner's task and validates identifiers", async () => {
        const dispatched = await createAndEnqueueGenerationTask(database.db, { async send() { return "job-query-owner"; } }, {
            ownerId,
            inputSnapshot: {}, modelId: "query-image", parameterSnapshot: {}, idempotencyKey: "query-owner", requestId: "query-owner-request",
        });
        await expect(getGenerationTaskForOwner(database.db, { ownerId: otherOwnerId, taskId: dispatched.task.id })).rejects.toMatchObject<GenerationQueryError>({ code: "not_found" });
        await expect(getGenerationTaskForOwner(database.db, { ownerId: "", taskId: dispatched.task.id })).rejects.toMatchObject<GenerationQueryError>({ code: "invalid_input" });
    });
});
