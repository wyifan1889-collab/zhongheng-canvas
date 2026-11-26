import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import { recordGenerationCheckpoint, type ContentSafetyCheckpoint } from "../src/content-safety-checkpoint";
import { createTestDatabase } from "./database";

const checkpoint: ContentSafetyCheckpoint = {
    actorId: "safety-record-owner", requestId: "safety-record-request", modelId: "safety-record-model", capability: "audio",
};

test("off checkpoint makes no database calls", async () => {
    const db = { execute() { throw new Error("disabled checkpoint cannot access database"); } } as unknown as Database;
    expect(await recordGenerationCheckpoint(db, "off", checkpoint)).toBe("off");
});

test("recording failures are unavailable without content rejection, false success, raw errors or retries", async () => {
    let calls = 0;
    const db = { async execute() { calls++; throw new Error("private-prompt-cookie-and-db-secret"); } } as unknown as Database;
    expect(await recordGenerationCheckpoint(db, "record", checkpoint)).toBe("unavailable");
    expect(calls).toBe(1);
});

test("record checkpoint writes only contract metadata and never content, IP or caller supplied verdicts", async () => {
    const database = await createTestDatabase();
    try {
        await database.db.execute(sql`INSERT INTO "canvas_saas"."user" (id, name, email, email_verified)
            VALUES (${checkpoint.actorId}, 'Synthetic safety owner', 'safety-record@example.test', true)`);
        // Exercise the actual shared migration table; never replace missing DDL with a fixture.
        const rich = { ...checkpoint, prompt: "private prompt", peerIp: "198.51.100.42", apiKey: "private api key",
            mode: "approved", phase: "passed", createdAt: "1970-01-01", id: "caller-controlled" };
        expect(await recordGenerationCheckpoint(database.db, "record", rich)).toBe("recorded");
        expect(await recordGenerationCheckpoint(database.db, "record", checkpoint)).toBe("recorded");
        const stored = await database.pool.query({ text: 'SELECT * FROM "canvas_saas"."content_safety_event"' }) as {
            rows: Array<Record<string, unknown>>;
        };
        expect(stored.rows).toHaveLength(2);
        expect(stored.rows[0]).toMatchObject({
            actor_id: checkpoint.actorId, request_id: checkpoint.requestId, model_id: checkpoint.modelId,
            capability: "audio", phase: "pre_generation", mode: "record",
        });
        expect(stored.rows[0]!.id).not.toBe(stored.rows[1]!.id);
        expect(stored.rows[0]!.id).not.toBe(rich.id);
        for (const secret of [rich.prompt, rich.peerIp, rich.apiKey, rich.mode, rich.phase, rich.createdAt]) {
            expect(JSON.stringify(stored.rows)).not.toContain(secret);
        }
    } finally { await database.close(); }
});
