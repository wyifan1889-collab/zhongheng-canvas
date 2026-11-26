import type { RelationQuery } from "./readiness";

/** Read-only video gate. A structural migration alone cannot admit paid tasks. */
export async function checkGenerationVideoDatabaseReadiness(database: RelationQuery): Promise<boolean> {
    try {
        const result = await database.query(`
            SELECT 'stage' AS relation WHERE to_regclass('canvas_saas.generation_video_stage') IS NOT NULL
            UNION ALL SELECT 'quote' FROM pg_attribute WHERE attrelid=to_regclass('canvas_saas.generation_task')
              AND attname='video_quote_snapshot' AND atttypid='jsonb'::regtype AND NOT attisdropped
            UNION ALL SELECT 'source' FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
              WHERE t.tgrelid=to_regclass('canvas_saas.model_price_publication') AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
              AND p.prosrc LIKE '%video_specs%' AND p.prosrc LIKE '%yunfei-grok-video-v1%' AND p.prosrc LIKE '%delivered_video%'
            UNION ALL SELECT 'binding' FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
              WHERE t.tgrelid=to_regclass('canvas_saas.generation_task') AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
              AND p.prosrc LIKE '%video_quote_snapshot%' AND p.prosrc LIKE '%video_specs%' AND p.prosrc LIKE '%reservedCredits%'
            UNION ALL SELECT 'immutable_stage' FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
              WHERE t.tgrelid=to_regclass('canvas_saas.generation_video_stage') AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
              AND p.prosrc LIKE '%provider_task_id%' AND p.prosrc LIKE '%create_attempt_token%' AND p.prosrc LIKE '%endpoint%'
            UNION ALL SELECT 'writable' WHERE NOT pg_is_in_recovery() AND current_setting('transaction_read_only')='off'`);
        const found = new Set(result.rows.map(row => row.relation));
        return ["stage", "quote", "source", "binding", "immutable_stage", "writable"].every(key => found.has(key));
    } catch { return false; }
}
