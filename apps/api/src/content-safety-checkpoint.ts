import type { Database } from "@infinite-canvas/database";
import { recordContentSafetyEvent, type ContentSafetyCheckpoint } from "../../../packages/database/src/content-safety-events";
import type { ContentSafetyMode } from "./content-safety-config";

export type { ContentSafetyCheckpoint };

/** Recording is observable but cannot silently become content blocking. */
export async function recordGenerationCheckpoint(
    db: Database, mode: ContentSafetyMode, input: ContentSafetyCheckpoint,
): Promise<"off" | "recorded" | "unavailable"> {
    if (mode === "off") return "off";
    try {
        await recordContentSafetyEvent(db, input);
        return "recorded";
    } catch { return "unavailable"; }
}
