import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMediaRepository } from "@infinite-canvas/database/media";
import { user } from "@infinite-canvas/database/schema";
import { objectKey, createMemoryObjectStorage } from "@infinite-canvas/storage";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";
import { createAndEnqueueGenerationTask } from "../src/generation-dispatch";
import { createGenerationMediaDelivery } from "../src/generation-delivery";
import { processGenerationJob } from "../src/generation-worker";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID();
const quotaOwnerId = crypto.randomUUID();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([
        { id: ownerId, name: "Delivery owner", email: `${ownerId}@example.test` },
        { id: quotaOwnerId, name: "Quota delivery owner", email: `${quotaOwnerId}@example.test` },
    ]);
    await seedGenerationPricing(database.db, [{ modelId: "image-delivery", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 1 }]);
});

afterAll(async () => { await database?.close(); });

async function createTask(key: string, taskOwnerId = ownerId) {
    return createAndEnqueueGenerationTask(database.db, { async send() { return `job-${key}`; } }, {
        ownerId: taskOwnerId,
        inputSnapshot: { prompt: "delivery" },
        modelId: "image-delivery",
        parameterSnapshot: {},
        idempotencyKey: key,
        requestId: `request-${key}`,
    });
}

describe("generation media delivery", () => {
    test("persists one account-owned media object and attaches it to the result", async () => {
        const storage = createMemoryObjectStorage();
        let resolves = 0;
        const deliver = createGenerationMediaDelivery({
            database: database.db,
            storage,
            quotaBytes: 100,
            maxBytes: { image: 20, video: 20, audio: 20 },
            async resolveAsset() {
                resolves += 1;
                return { kind: "image", contentType: "image/png", body: new Uint8Array([1, 2, 3]) };
            },
        });
        const dispatched = await createTask("delivery-success");
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const first = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "succeeded" as const, resultSnapshot: { text: "evidence" } }; },
            deliver,
        });
        const replay = await processGenerationJob(database.db, payload, {
            async provider() { throw new Error("provider must not be called"); },
            deliver,
        });
        const media = await createMediaRepository(database.db).get(ownerId, dispatched.task.id);
        expect(first.task.deliveryStatus).toBe("visible");
        expect(first.result.resultSnapshot).toMatchObject({ text: "evidence", media: { mediaId: dispatched.task.id, kind: "image", contentType: "image/png", sizeBytes: 3 } });
        expect(replay.result.resultSnapshot).toMatchObject({ media: { mediaId: dispatched.task.id } });
        expect(resolves).toBe(1);
        expect(media).toMatchObject({ id: dispatched.task.id, ownerId, objectKey: `accounts/${Buffer.from(ownerId).toString("base64url")}/media/${dispatched.task.id}`, sizeBytes: 3 });
        expect(await storage.get(objectKey(media!.objectKey))).toMatchObject({ metadata: { etag: media!.etag, sizeBytes: 3 } });
        expect(await createMediaRepository(database.db).getQuota(ownerId, 100)).toMatchObject({ usedBytes: 3, availableBytes: 97 });
    });

    test("cleans the object on quota refusal", async () => {
        const storage = createMemoryObjectStorage();
        const deliver = createGenerationMediaDelivery({
            database: database.db,
            storage,
            quotaBytes: 2,
            maxBytes: { image: 20, video: 20, audio: 20 },
            async resolveAsset() { return { kind: "image", contentType: "image/png", body: new Uint8Array([1, 2, 3]) }; },
        });
        const dispatched = await createTask("delivery-quota", quotaOwnerId);
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId: quotaOwnerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "succeeded" as const, resultSnapshot: {} }; },
            deliver,
        });
        expect(result.task.deliveryStatus).toBe("failed");
        expect(result.delivery).toMatchObject({ status: "failed", errorCode: "delivery_quota_exceeded" });
        expect(await createMediaRepository(database.db).get(quotaOwnerId, dispatched.task.id)).toBeNull();
    });

    test("rejects a content type that does not match the media allowlist", async () => {
        const deliver = createGenerationMediaDelivery({
            database: database.db,
            storage: createMemoryObjectStorage(),
            quotaBytes: 20,
            maxBytes: { image: 20, video: 20, audio: 20 },
            async resolveAsset() { return { kind: "image", contentType: "text/plain", body: new Uint8Array([1]) }; },
        });
        const dispatched = await createTask("delivery-mime");
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "succeeded" as const, resultSnapshot: {} }; },
            deliver,
        });
        expect(result.task.deliveryStatus).toBe("failed");
        expect(result.delivery).toMatchObject({ status: "failed", errorCode: "delivery_content_type_invalid" });
    });

    test("turns resolver failures into an unknown delivery for review", async () => {
        const deliver = createGenerationMediaDelivery({
            database: database.db,
            storage: createMemoryObjectStorage(),
            quotaBytes: 20,
            maxBytes: { image: 20, video: 20, audio: 20 },
            async resolveAsset() { throw new Error("provider payload is unavailable"); },
        });
        const dispatched = await createTask("delivery-unknown");
        const payload = { schemaVersion: 1 as const, taskId: dispatched.task.id, ownerId, requestId: dispatched.task.requestId };
        const result = await processGenerationJob(database.db, payload, {
            async provider() { return { status: "succeeded" as const, resultSnapshot: {} }; },
            deliver,
        });
        expect(result.task.deliveryStatus).toBe("unknown");
        expect(result.delivery).toMatchObject({ status: "unknown", unknownReason: "delivery_asset_resolver_exception" });
    });
});
