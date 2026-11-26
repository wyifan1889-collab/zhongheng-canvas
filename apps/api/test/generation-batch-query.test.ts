import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "@infinite-canvas/database";
import { generationTask, user } from "@infinite-canvas/database/schema";
import { createGenerationResultRepository } from "@infinite-canvas/database/generation-results";
import { GenerationQueryError, getGenerationTasksForOwner, publicTrackingTask } from "../src/generation-query";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Generation batch query tests require isolated in-memory PGlite");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const ownerId = crypto.randomUUID(), foreignOwnerId = crypto.randomUUID();
const ownedIds = Array.from({ length: 50 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`);
const foreignId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", missingId = "cccccccc-cccc-4ccc-8ccc-000000000001";
const updatedAt = new Date("2026-10-26T01:02:03.456Z"), privateMarker = "synthetic-private-batch-evidence";
const trackingFields = ["taskId", "projectId", "nodeId", "modelId", "executionStatus", "deliveryStatus", "billingStatus", "updatedAt"].sort();
const selectionFields = ["id", "projectId", "nodeId", "modelId", "executionStatus", "deliveryStatus", "billingStatus", "updatedAt"] as const;

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([
        { id: ownerId, name: "Synthetic batch owner", email: `${ownerId}@example.test` },
        { id: foreignOwnerId, name: "Synthetic foreign owner", email: `${foreignOwnerId}@example.test` },
    ]);
    // Legal unpriced legacy rows require no supplier, wallet or current catalog entry.
    await database.db.insert(generationTask).values([...ownedIds, foreignId].map((id, index) => ({
        id, ownerId: id === foreignId ? foreignOwnerId : ownerId,
        modelId: index % 2 ? "synthetic-historical-text" : "synthetic-historical-image",
        projectId: index % 2 ? null : `synthetic-project-${index}`, nodeId: index % 2 ? null : `synthetic-node-${index}`,
        inputSnapshot: { prompt: privateMarker, credential: privateMarker }, parameterSnapshot: { privateProvider: privateMarker },
        providerTaskId: privateMarker, unknownReason: privateMarker, idempotencyKey: `synthetic-batch-${id}`,
        requestId: `synthetic-request-${id}`, updatedAt,
    })));
    await createGenerationResultRepository(database.db).create({ ownerId, taskId: ownedIds[0], status: "succeeded", consumedUnits: 23,
        providerStatus: 200, providerTaskId: privateMarker,
        resultSnapshot: { kind: "text", text: "x".repeat(200_000), media: { mediaId: ownedIds[0] }, providerPayload: { credential: privateMarker } } });
}, 30_000);
afterAll(async () => { await database?.close(); });

test("tracking projection reconstructs its whitelist and never exposes injected private fields", () => {
    const row = { id: ownedIds[0], projectId: "original-project", nodeId: null, modelId: "historical-model-id",
        executionStatus: "unknown" as const, deliveryStatus: "unknown" as const, billingStatus: "pending_review" as const, updatedAt,
        ownerId: privateMarker, inputSnapshot: { prompt: privateMarker }, parameterSnapshot: { credential: privateMarker },
        providerTaskId: privateMarker, idempotencyKey: privateMarker, reservationId: privateMarker, pricePublicationId: privateMarker,
        unknownReason: privateMarker, errorCode: privateMarker, quotedUnits: 999, consumedUnits: 999,
        textQuoteSnapshot: { budgetCredits: "999" }, resultSnapshot: { text: privateMarker }, displayName: privateMarker };
    const before = structuredClone(row), projected = publicTrackingTask(row);
    expect(projected).toEqual({ taskId: ownedIds[0], projectId: "original-project", nodeId: null, modelId: "historical-model-id",
        executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review", updatedAt: updatedAt.toISOString() });
    expect(Object.keys(projected).sort()).toEqual(trackingFields);
    expect(JSON.stringify(projected)).not.toContain(privateMarker);
    expect(row).toEqual(before);
});

test("owner, foreign and absent IDs form one normalized ordered partition without revealing ownership", async () => {
    const result = await getGenerationTasksForOwner(database.db, { ownerId,
        taskIds: [ownedIds[1].toUpperCase(), foreignId.toUpperCase(), ownedIds[0], ownedIds[1], missingId.toUpperCase(), foreignId] });
    expect(result.items.map(item => item.taskId)).toEqual([ownedIds[1], ownedIds[0]]);
    expect(result.missingTaskIds).toEqual([foreignId, missingId]);
    expect(result.items[0]).toMatchObject({ projectId: null, nodeId: null, modelId: "synthetic-historical-text",
        executionStatus: "pending", deliveryStatus: "pending", billingStatus: "unbilled", updatedAt: updatedAt.toISOString() });
    expect(result.items[1]).toMatchObject({ projectId: "synthetic-project-0", nodeId: "synthetic-node-0", modelId: "synthetic-historical-image" });
    for (const item of result.items) expect(Object.keys(item).sort()).toEqual(trackingFields);
    expect(new Set([...result.items.map(item => item.taskId), ...result.missingTaskIds]).size).toBe(4);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
    const foreign = await getGenerationTasksForOwner(database.db, { ownerId: foreignOwnerId, taskIds: [ownedIds[0], foreignId, missingId] });
    expect(foreign.items.map(item => item.taskId)).toEqual([foreignId]);
    expect(foreign.missingTaskIds).toEqual([ownedIds[0], missingId]);
});

test("the actual batch selects only eight columns once and filters owner and normalized IDs in SQL", async () => {
    const observed = observeSelections();
    const result = await getGenerationTasksForOwner(observed.db, { ownerId, taskIds: [ownedIds[1].toUpperCase(), ownedIds[0], ownedIds[1]] });
    expect(result.items.map(item => item.taskId)).toEqual([ownedIds[1], ownedIds[0]]);
    expect(observed.selections).toHaveLength(1); expect(observed.tables).toEqual([generationTask]); expect(observed.statements).toHaveLength(1);
    const fields = observed.selections[0] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual([...selectionFields].sort());
    for (const field of selectionFields) expect(fields[field]).toBe(generationTask[field]);
    const statement = observed.statements[0];
    expect(statement.params).toEqual([ownerId, ownedIds[1], ownedIds[0]]);
    expect(statement.sql).toContain('"owner_id"'); expect(statement.sql).toContain(" in (");
    expect(statement.sql).not.toMatch(/\bjoin\b|generation_result|wallet|model_catalog|model_pricing|input_snapshot|parameter_snapshot|unknown_reason|quoted_units|price_version|provider_task_id|idempotency_key/i);
});

test("empty batches return before touching a database and invalid owners still fail", async () => {
    let selects = 0;
    const unavailable = { select() { selects++; throw new Error("No batch read was expected"); } } as unknown as Database;
    expect(await getGenerationTasksForOwner(unavailable, { ownerId, taskIds: [] })).toEqual({ items: [], missingTaskIds: [] });
    for (const invalidOwner of ["", " ", "x".repeat(201), null, 1]) {
        await expect(getGenerationTasksForOwner(unavailable, { ownerId: invalidOwner as string, taskIds: [] })).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(selects).toBe(0);
});

test("raw fifty is accepted, raw fifty-one is rejected before deduplication, and IDs stay strict", async () => {
    const ordered = [...ownedIds].reverse(), result = await getGenerationTasksForOwner(database.db, { ownerId, taskIds: ordered });
    expect(result.items.map(item => item.taskId)).toEqual(ordered); expect(result.missingTaskIds).toEqual([]);
    expect((await getGenerationTasksForOwner(database.db, { ownerId, taskIds: Array(50).fill(ownedIds[0]) })).items.map(item => item.taskId)).toEqual([ownedIds[0]]);
    let selects = 0;
    const unavailable = { select() { selects++; throw new Error("Invalid input reached the database"); } } as unknown as Database;
    const invalidLists: unknown[] = [undefined, null, {}, "not-an-array", Array(51).fill(ownedIds[0]), [...ownedIds, missingId],
        ["not-a-uuid"], [1], [null], [` ${ownedIds[0]}`], [ownedIds[0], "provider-job-id"]];
    for (const taskIds of invalidLists) await expect(getGenerationTasksForOwner(unavailable, { ownerId, taskIds: taskIds as string[] }))
        .rejects.toMatchObject<GenerationQueryError>({ code: "invalid_input" });
    expect(selects).toBe(0);
});

test("a database read failure rejects the whole batch instead of reporting all IDs missing", async () => {
    const failure = new Error("synthetic batch read unavailable");
    let selects = 0;
    const unavailable = { select() { selects++; return { from() { return { where() { return Promise.reject(failure); } }; } }; } } as unknown as Database;
    await expect(getGenerationTasksForOwner(unavailable, { ownerId, taskIds: [ownedIds[0], missingId] })).rejects.toBe(failure);
    expect(selects).toBe(1);
});

function observeSelections() {
    const selections: unknown[] = [], tables: unknown[] = [], statements: Array<{ sql: string; params: unknown[] }> = [];
    const observed = new Proxy(database.db, {
        get(target, property, receiver) {
            if (property !== "select") return Reflect.get(target, property, receiver);
            return (...args: unknown[]) => {
                selections.push(args[0]);
                const builder = Reflect.apply(target.select, target, args);
                return { from(table: unknown) {
                    tables.push(table);
                    const query = builder.from(table);
                    return { where(condition: unknown) {
                        const statement = query.where(condition);
                        statements.push(statement.toSQL());
                        return statement;
                    } };
                } };
            };
        },
    });
    return { db: observed as Database, selections, tables, statements };
}
