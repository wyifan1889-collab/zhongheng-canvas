import { sql } from "drizzle-orm";
import type { Database } from "./client";

export type ContentSafetyCheckpoint = {
    actorId: string;
    requestId: string;
    modelId: string;
    capability: "text" | "image" | "video" | "audio";
};

/** Metadata only; this event asserts neither inspection nor an approval verdict. */
export async function recordContentSafetyEvent(db: Database, input: ContentSafetyCheckpoint): Promise<void> {
    // Schema/DDL belongs to the shared owner. Bind every value and select only
    // contract fields even if an internal caller supplies a larger object.
    await db.execute(sql`INSERT INTO "canvas_saas"."content_safety_event"
        ("id", "actor_id", "request_id", "model_id", "capability", "phase", "mode")
        VALUES (${crypto.randomUUID()}, ${input.actorId}, ${input.requestId}, ${input.modelId}, ${input.capability}, 'pre_generation', 'record')`);
}
