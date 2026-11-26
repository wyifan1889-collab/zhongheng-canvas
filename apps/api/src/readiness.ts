import { NODE_MODEL_GROUP_CAPABILITIES } from "@infinite-canvas/shared";
import type { ContentSafetyConfig } from "./content-safety-config";

export type RelationQuery = {
    query: (text: string, values?: readonly unknown[]) => Promise<{ rows: Array<{ relation?: unknown }> }>;
};

const CORE_ACCOUNT_RELATIONS = [
    "account", "audit_event", "canvas_draft", "canvas_members", "canvas_shares", "model_catalog", "model_pricing", "model_provider",
    "model_provider_credential", "provider_discovery_receipt", "provider_discovered_model", "model_node_groups",
    "model_mapping_draft", "model_mapping_publication",
    "rate_limit", "session", "user", "verification", "wallet", "wallet_ledger", "wallet_reservation",
] as const;

/** Relations used by the enabled account API, excluding optional cloud media tables. */
type SafetyReadiness = Pick<ContentSafetyConfig, "moderationEnabled" | "reportsEnabled" | "checkpointMode">;
export function requiredAccountRelations(cloudMedia: boolean, safety?: SafetyReadiness): readonly string[] {
    return [...CORE_ACCOUNT_RELATIONS, ...(cloudMedia ? ["media_object", "storage_quota"] : []),
        ...(safety?.moderationEnabled ? ["account_moderation_operation"] : []),
        ...(safety?.reportsEnabled ? ["abuse_report"] : []), ...(safety?.checkpointMode === "record" ? ["content_safety_event"] : [])];
}

/**
 * A user table alone is not a usable account service: auth, rate limits, audit,
 * wallet and admin catalog routes all depend on the complete relation set.
 * Also require the normalized email uniqueness guard from migration 0014;
 * table existence alone must not mark an incompletely migrated service ready.
 * Return only a boolean so database names and SQL errors never leave readiness.
 */
export async function checkAccountDatabaseReadiness(database: RelationQuery, cloudMedia: boolean, safety?: SafetyReadiness): Promise<boolean> {
    const required = requiredAccountRelations(cloudMedia, safety);
    const columns: Array<{ table_name: string; column_name: string; type_name: string; not_null: boolean; default_value?: string }> = [
        { table_name: "user", column_name: "moderation_version", type_name: "int4", not_null: true, default_value: "0" },
        { table_name: "session", column_name: "moderation_version", type_name: "int4", not_null: true, default_value: "0" },
        { table_name: "model_provider", column_name: "deleted_at", type_name: "timestamptz", not_null: false },
        { table_name: "model_catalog", column_name: "deleted_at", type_name: "timestamptz", not_null: false },
    ];
    const constraints = [
        { table_name: "user", name: "user_moderation_version", expression: "moderation_version>=0" },
        { table_name: "session", name: "session_moderation_version", expression: "moderation_version>=0" },
        { table_name: "model_provider", name: "model_provider_deleted_disabled", expression: "deleted_atisnullornotenabled" },
        { table_name: "model_catalog", name: "model_catalog_deleted_disabled", expression: "deleted_atisnullornotenabled" },
        { table_name: "model_node_groups", name: "model_node_groups_capability",
            expression: `capability=anyarray[${NODE_MODEL_GROUP_CAPABILITIES.map(capability => `'${capability}'::text`).join(",")}]` },
    ];
    const addColumns = (table_name: string, fields: Record<string, string>, nullable: string[] = []) => {
        for (const [column_name, type_name] of Object.entries(fields)) columns.push({ table_name, column_name, type_name, not_null: !nullable.includes(column_name) });
    };
    if (safety?.moderationEnabled) {
        addColumns("account_moderation_operation", { id: "uuid", target_user_id: "text", actor_id: "text", disabled: "bool",
            expected_version: "int4", revision: "int4", reason: "text", request_id: "text", created_at: "timestamptz" });
        constraints.push({ table_name: "account_moderation_operation", name: "account_moderation_operation_versions", expression: "expected_version>=0andrevision>=0" });
    }
    if (safety?.reportsEnabled) {
        addColumns("abuse_report", { id: "uuid", reporter_id: "text", subject: "text", details: "text", status: "text", revision: "int4",
            received_by: "text", received_at: "timestamptz", created_at: "timestamptz", updated_at: "timestamptz" }, ["received_by", "received_at"]);
        columns.find(column => column.table_name === "abuse_report" && column.column_name === "status")!.default_value = "'submitted'::text";
        columns.find(column => column.table_name === "abuse_report" && column.column_name === "revision")!.default_value = "1";
        constraints.push({ table_name: "abuse_report", name: "abuse_report_revision", expression: "revision>0" },
            { table_name: "abuse_report", name: "abuse_report_receipt", expression: "status='submitted'::textandreceived_byisnullandreceived_atisnullorstatus='received'::textandreceived_byisnotnullandreceived_atisnotnull" });
    }
    if (safety?.checkpointMode === "record") {
        addColumns("content_safety_event", { id: "uuid", actor_id: "text", request_id: "text", model_id: "text", capability: "text",
            phase: "text", mode: "text", created_at: "timestamptz" });
        constraints.push({ table_name: "content_safety_event", name: "content_safety_event_capability", expression: "capability=anyarray['text'::text,'image'::text,'video'::text,'audio'::text]" },
            { table_name: "content_safety_event", name: "content_safety_event_phase", expression: "phase='pre_generation'::text" },
            { table_name: "content_safety_event", name: "content_safety_event_mode", expression: "mode='record'::text" });
    }
    try {
        const result = await database.query(
            `SELECT n.nspname || '.' || c.relname AS relation
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'canvas_saas'
               AND c.relkind IN ('r', 'p')
               AND c.relname = ANY($1::text[])
             UNION ALL
             SELECT 'constraint.user_email_lower_unique' AS relation
             FROM pg_catalog.pg_index i
             JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'canvas_saas' AND c.relname = 'user_email_lower_unique'
               AND i.indrelid = to_regclass('canvas_saas.user')
               AND i.indisunique AND i.indisvalid AND i.indisready
               AND i.indpred IS NULL AND i.indnkeyatts = 1
               AND pg_get_expr(i.indexprs, i.indrelid) = 'lower(btrim(email))'
             UNION ALL
             SELECT 'column.' || expected.table_name || '.' || expected.column_name
             FROM jsonb_to_recordset($2::jsonb) AS expected(table_name text, column_name text, type_name text, not_null boolean, default_value text)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = to_regclass(format('canvas_saas.%I', expected.table_name)) AND a.attname = expected.column_name
             LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = to_regtype(expected.type_name)
               AND a.attnotnull = expected.not_null AND (expected.default_value IS NULL OR pg_get_expr(d.adbin, d.adrelid) = expected.default_value)
             UNION ALL
             SELECT 'constraint.' || expected.name
             FROM jsonb_to_recordset($3::jsonb) AS expected(table_name text, name text, expression text)
             JOIN pg_catalog.pg_constraint c ON c.conrelid = to_regclass(format('canvas_saas.%I', expected.table_name)) AND c.conname = expected.name
             WHERE c.contype = 'c' AND c.convalidated
               AND lower(regexp_replace(pg_get_expr(c.conbin, c.conrelid), '[[:space:]()"]', '', 'g')) = expected.expression
             UNION ALL
             SELECT 'trigger.account_moderation_operation_immutable'
             FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
             WHERE $4::boolean AND t.tgrelid = to_regclass('canvas_saas.account_moderation_operation')
               AND t.tgname = 'account_moderation_operation_immutable' AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A') AND t.tgtype = 27
               AND p.pronamespace = to_regnamespace('canvas_saas') AND p.proname = 'reject_account_moderation_operation_mutation'
               AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype AND NOT p.prosecdef
               AND btrim(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g')) = 'BEGIN RAISE EXCEPTION ''account moderation operations are immutable''; END;'
             UNION ALL
             SELECT 'model_group.' || capability FROM canvas_saas.model_node_groups WHERE capability = ANY($5::text[])
             UNION ALL
             SELECT 'database.writable' AS relation
             WHERE NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off'`,
            [required, JSON.stringify(columns), JSON.stringify(constraints), safety?.moderationEnabled === true, NODE_MODEL_GROUP_CAPABILITIES],
        );
        const found = new Set(result.rows.map((row) => typeof row.relation === "string" ? row.relation : "").filter(Boolean));
        return required.every((name) => found.has(`canvas_saas.${name}`)) &&
            columns.every(column => found.has(`column.${column.table_name}.${column.column_name}`)) &&
            constraints.every(constraint => found.has(`constraint.${constraint.name}`)) &&
            NODE_MODEL_GROUP_CAPABILITIES.every(capability => found.has(`model_group.${capability}`)) &&
            (!safety?.moderationEnabled || found.has("trigger.account_moderation_operation_immutable")) &&
            found.has("constraint.user_email_lower_unique") && found.has("database.writable") &&
            await checkModelMappingDatabaseReadiness(database);
    } catch {
        return false;
    }
}

/** Fail closed on pre-0026 or partially applied task-price schema, before enqueue or worker startup. */
export async function checkGenerationDatabaseReadiness(database: RelationQuery, audioEnabled = false): Promise<boolean> {
    const required = ["column.text_quote_snapshot", "constraint.generation_task_text_quote",
        "constraint.model_pricing_billing_unit", "constraint.model_pricing_credits_positive", "function.image_spec_task_credits",
        "trigger.generation_task_price_publication_insert", "trigger.generation_task_price_source_immutable",
        "trigger.model_price_publication_source", "database.writable"];
    if (audioEnabled) required.push("constraint.model_price_draft_audio", "function.audio_request_publication");
    try {
        const result = await database.query(`
            SELECT 'column.text_quote_snapshot' AS relation FROM pg_catalog.pg_attribute
            WHERE attrelid = to_regclass('canvas_saas.generation_task') AND attname = 'text_quote_snapshot'
              AND atttypid = 'jsonb'::regtype AND NOT attisdropped
            UNION ALL
            SELECT 'constraint.generation_task_text_quote' FROM pg_catalog.pg_constraint
            WHERE conrelid = to_regclass('canvas_saas.generation_task') AND conname = 'generation_task_text_quote'
              AND contype = 'c' AND convalidated
            UNION ALL
            SELECT 'constraint.' || conname FROM pg_catalog.pg_constraint
            WHERE conrelid = to_regclass('canvas_saas.model_pricing') AND contype = 'c' AND convalidated
              AND conname IN ('model_pricing_billing_unit', 'model_pricing_credits_positive')
              AND pg_get_constraintdef(oid) LIKE '%image_specs%'
            UNION ALL
            SELECT 'function.image_spec_task_credits' FROM pg_catalog.pg_proc p
            WHERE p.pronamespace = to_regnamespace('canvas_saas')
              AND p.pronargs = 2 AND oidvectortypes(p.proargtypes) = 'jsonb, jsonb'
              AND p.prorettype = 'bigint'::regtype AND p.provolatile = 'i' AND NOT p.prosecdef
              AND NOT p.proretset AND p.provariadic = 0
              AND ((p.proname = 'image_spec_task_credits' AND to_regprocedure('canvas_saas.image_spec_task_credits_core(jsonb,jsonb)') IS NULL)
                OR (p.proname = 'image_spec_task_credits_core' AND EXISTS (
                    SELECT 1 FROM pg_catalog.pg_proc wrapper JOIN pg_catalog.pg_language lang ON lang.oid = wrapper.prolang
                    WHERE wrapper.oid = to_regprocedure('canvas_saas.image_spec_task_credits(jsonb,jsonb)')
                      AND wrapper.prorettype = 'bigint'::regtype AND wrapper.provolatile = 'i' AND NOT wrapper.prosecdef
                      AND NOT wrapper.proretset AND wrapper.provariadic = 0 AND lang.lanname = 'plpgsql'
                      -- The formal 0039 wrapper must still call the guarded core with all protocol/format checks intact.
                      AND encode(sha256(convert_to(replace(wrapper.prosrc, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex') =
                          'a837d547437ea1ca3709fdc5e376e1f25c39e4ea4b4cf31a9dac30aff3561083')))
              AND p.prosrc LIKE ALL (ARRAY['%schemaVersion%', '%image_request%', '%credit%', '%bands%',
                  '%size%', '%quality%', '%task_parameters%', '%priced_parameters%', '%seen%', '%output_format%', '%png%', '%9007199254740991%',
                  '%jsonb_typeof(checked_rule)%', '%jsonb_typeof(derivation)%', '%jsonb_typeof(binding)%', '%jsonb_typeof(source)%',
                  '%costMultiplier%', '%saleMultiplier%', '%creditsPerCurrency%', '%saved_cost%', '%draftVersion%',
                  '%basis_amount::numeric * factors[2] * factors[3]%', '%basis_amount::numeric * factors[1]%', '%cost_amount::numeric%', '%numeric_value_out_of_range%'])
            UNION ALL
            SELECT 'trigger.' || t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
            WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
              AND p.pronamespace = to_regnamespace('canvas_saas') AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype AND NOT p.prosecdef AND (
                (t.tgrelid = to_regclass('canvas_saas.generation_task') AND t.tgtype = 7
                 AND t.tgname = 'generation_task_price_publication_insert' AND p.proname = 'bind_generation_task_price_publication'
                 AND p.prosrc LIKE '%text_quote_snapshot%' AND p.prosrc LIKE '%inputCreditsPerMillion%'
                 AND p.prosrc LIKE '%cachedInputCreditsPerMillion%' AND p.prosrc LIKE '%text_cached_tokens%'
                 AND p.prosrc LIKE '%image_specs%' AND p.prosrc LIKE '%image_spec_task_credits%'
                 AND p.prosrc LIKE ALL (ARRAY['%derivation%', '%jsonb_build_object%', '%source.provider_id_snapshot%',
                    '%source.provider_model_snapshot%', '%source.adapter_snapshot%', '%source.endpoint_snapshot%', '%source.capability_snapshot%'])) OR
                (t.tgrelid = to_regclass('canvas_saas.generation_task') AND t.tgtype = 19
                 AND t.tgname = 'generation_task_price_source_immutable' AND p.proname = 'protect_generation_task_price_source'
                 AND p.prosrc LIKE ALL (ARRAY[
                    '%OLD.id,%', '%NEW.id,%', '%OLD.owner_id%', '%NEW.owner_id%', '%OLD.idempotency_key%', '%NEW.idempotency_key%',
                    '%OLD.request_id%', '%NEW.request_id%', '%OLD.model_id%', '%NEW.model_id%',
                    '%OLD.input_snapshot%', '%NEW.input_snapshot%', '%OLD.parameter_snapshot%', '%NEW.parameter_snapshot%',
                    '%OLD.space_id%', '%NEW.space_id%', '%OLD.project_id%', '%NEW.project_id%', '%OLD.node_id%', '%NEW.node_id%',
                    '%OLD.price_version%', '%NEW.price_version%', '%OLD.quoted_units%', '%NEW.quoted_units%',
                    '%OLD.billing_unit_snapshot%', '%NEW.billing_unit_snapshot%', '%OLD.credits_per_unit_snapshot%', '%NEW.credits_per_unit_snapshot%',
                    '%OLD.price_publication_id%', '%NEW.price_publication_id%', '%OLD.text_quote_snapshot%', '%NEW.text_quote_snapshot%',
                    '%OLD.created_at%', '%NEW.created_at%', '%OLD.reservation_id%', '%NEW.reservation_id%'])) OR
                (t.tgrelid = to_regclass('canvas_saas.model_price_publication') AND t.tgtype = 7
                 AND t.tgname = 'model_price_publication_source' AND p.proname = 'check_model_price_publication_source'
                 AND p.prosrc LIKE '%sub2api%' AND p.prosrc LIKE '%text_tokens%'
                 AND p.prosrc LIKE '%text_cached_tokens%' AND p.prosrc LIKE '%cached_input_token%'
                 AND p.prosrc LIKE '%image_specs%' AND p.prosrc LIKE '%image_spec_task_credits%'
                 AND p.prosrc LIKE ALL (ARRAY['%derivation%', '%jsonb_build_object%', '%source.provider_id_snapshot%',
                    '%source.provider_model_snapshot%', '%source.adapter_snapshot%', '%source.endpoint_snapshot%', '%source.capability_snapshot%'])))
            UNION ALL SELECT 'database.writable'
            WHERE NOT pg_is_in_recovery() AND current_setting('transaction_read_only') = 'off'`);
        const found = new Set(result.rows.map((row) => row.relation));
        if (audioEnabled) {
            const audio = await database.query(`SELECT 'constraint.model_price_draft_audio' AS relation FROM pg_catalog.pg_constraint
                WHERE conrelid = to_regclass('canvas_saas.model_price_draft') AND conname = 'model_price_draft_capability'
                  AND contype = 'c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%audio%'
                UNION ALL SELECT 'function.audio_request_publication' FROM pg_catalog.pg_proc
                WHERE pronamespace = to_regnamespace('canvas_saas') AND proname = 'check_model_price_publication_source'
                  AND pronargs = 0 AND prorettype = 'trigger'::regtype AND NOT prosecdef
                  AND prosrc LIKE '%audio_request%' AND prosrc LIKE '%source.capability_snapshot = ''audio''%'`);
            for (const row of audio.rows) found.add(row.relation);
        }
        return required.every((marker) => found.has(marker));
    } catch { return false; }
}

type LaunchColumn = { table: string; name: string; type: string; required: boolean; defaultValue?: string };
type LaunchCheck = { table: string; name: string; expression: string };
type LaunchIndex = { table: string; name: string; columns: string[]; predicate?: string };
type LaunchFunction = { name: string; args: string; returns: string; volatility: string; language: string; parts: string[]; exact?: string };
type LaunchTrigger = { table: string; name: string; function: string; events: number; deferred?: boolean };
type LaunchForeignKey = { table: string; name: string; column: string; reference: string; onDelete: "r" | "c" };
const launchColumns = (table: string, fields: Record<string, string>, nullable: string[] = [], defaults: Record<string, string> = {}): LaunchColumn[] =>
    Object.entries(fields).map(([name, type]) => ({ table, name, type, required: !nullable.includes(name), ...(defaults[name] ? { defaultValue: defaults[name] } : {}) }));
const enumExpression = (column: string, values: string[]) => `(${column}=ANY(ARRAY[${values.map(value => `'${value}'::text`).join(",")}]))`;
const triggerFunction = (name: string, parts: string[], exact?: string): LaunchFunction => ({ name, args: "", returns: "trigger", volatility: "v", language: "plpgsql", parts, exact });

/** Fixed launch-object checks, not an attestation of arbitrary installed function semantics. */
async function checkLaunchObjects(database: RelationQuery, objects: { columns: LaunchColumn[]; checks: LaunchCheck[]; indexes: LaunchIndex[];
    functions: LaunchFunction[]; triggers: LaunchTrigger[]; foreignKeys: LaunchForeignKey[] }): Promise<boolean> {
    const wanted = ["database.writable", ...objects.columns.map(row => `column.${row.table}.${row.name}`), ...objects.checks.map(row => `check.${row.table}.${row.name}`),
        ...objects.indexes.map(row => `index.${row.name}`), ...objects.functions.map(row => `function.${row.name}`), ...objects.triggers.map(row => `trigger.${row.name}`),
        ...objects.foreignKeys.map(row => `foreign.${row.name}`)];
    try {
        const result = await database.query(`
            SELECT 'column.' || e."table" || '.' || e.name AS relation
            FROM jsonb_to_recordset($1::jsonb) AS e("table" text, name text, type text, required boolean, "defaultValue" text)
            JOIN pg_catalog.pg_class c ON c.oid=to_regclass(format('canvas_saas.%I',e."table")) AND c.relkind IN ('r','p')
            JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=e.name
            LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attnum>0 AND NOT a.attisdropped AND a.atttypid=to_regtype(e.type) AND a.attnotnull=e.required
              AND (e.type <> 'numeric' OR a.atttypmod=-1)
              AND (e."defaultValue" IS NULL OR pg_get_expr(d.adbin,d.adrelid)=e."defaultValue")
            UNION ALL SELECT 'check.' || e."table" || '.' || e.name
            FROM jsonb_to_recordset($2::jsonb) AS e("table" text,name text,expression text)
            JOIN pg_catalog.pg_constraint c ON c.conrelid=to_regclass(format('canvas_saas.%I',e."table")) AND c.conname=e.name::name
            WHERE c.contype='c' AND c.convalidated AND regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]]','','g')=e.expression
            UNION ALL SELECT 'index.' || e.name
            FROM jsonb_to_recordset($3::jsonb) AS e("table" text,name text,columns text[],predicate text)
            JOIN pg_catalog.pg_class c ON c.oid=to_regclass(format('canvas_saas.%I',e.name))
            JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid AND i.indrelid=to_regclass(format('canvas_saas.%I',e."table"))
            WHERE i.indisunique AND i.indisvalid AND i.indisready AND i.indexprs IS NULL AND i.indnkeyatts=cardinality(e.columns)
              AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(number,position)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.number WHERE k.position<=i.indnkeyatts ORDER BY k.position)=e.columns
              AND ((e.predicate IS NULL AND i.indpred IS NULL) OR (e.predicate IS NOT NULL AND regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]]','','g')=e.predicate))
            UNION ALL SELECT 'function.' || e.name
            FROM jsonb_to_recordset($4::jsonb) AS e(name text,args text,"returns" text,volatility text,language text,parts text[],exact text)
            JOIN pg_catalog.pg_proc p ON p.pronamespace=to_regnamespace('canvas_saas') AND p.proname=e.name
            JOIN pg_catalog.pg_language l ON l.oid=p.prolang
            WHERE oidvectortypes(p.proargtypes)=e.args AND p.prorettype=to_regtype(e."returns") AND p.provolatile::text=e.volatility
              AND l.lanname=e.language AND NOT p.prosecdef AND NOT p.proretset AND p.provariadic=0
              AND NOT EXISTS (SELECT 1 FROM unnest(e.parts) part WHERE position(regexp_replace(part,'[[:space:]]','','g') IN regexp_replace(p.prosrc,'[[:space:]]','','g'))=0)
              AND (e.exact IS NULL OR regexp_replace(p.prosrc,'[[:space:]]','','g')=regexp_replace(e.exact,'[[:space:]]','','g'))
            UNION ALL SELECT 'trigger.' || e.name
            FROM jsonb_to_recordset($5::jsonb) AS e("table" text,name text,"function" text,events integer,deferred boolean)
            JOIN pg_catalog.pg_trigger t ON t.tgrelid=to_regclass(format('canvas_saas.%I',e."table")) AND t.tgname=e.name
            JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
            WHERE NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=e.events AND t.tgqual IS NULL AND t.tgnargs=0
              AND t.tgdeferrable=COALESCE(e.deferred,false) AND t.tginitdeferred=COALESCE(e.deferred,false)
              AND (NOT COALESCE(e.deferred,false) OR t.tgconstraint<>0)
              AND p.pronamespace=to_regnamespace('canvas_saas') AND p.proname=e."function" AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND NOT p.prosecdef
            UNION ALL SELECT 'foreign.' || e.name
            FROM jsonb_to_recordset($6::jsonb) AS e("table" text,name text,"column" text,"reference" text,"onDelete" text)
            JOIN pg_catalog.pg_constraint c ON c.conrelid=to_regclass(format('canvas_saas.%I',e."table")) AND c.conname=e.name::name
            JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attname=e."column"
            JOIN pg_catalog.pg_attribute target ON target.attrelid=c.confrelid AND target.attname='id'
            WHERE c.contype='f' AND c.convalidated AND c.confrelid=to_regclass(format('canvas_saas.%I',e."reference"))
              AND c.conkey=ARRAY[a.attnum] AND c.confkey=ARRAY[target.attnum] AND c.confdeltype::text=e."onDelete"
            UNION ALL SELECT 'database.writable' WHERE NOT pg_is_in_recovery() AND current_setting('transaction_read_only')='off'`,
            [objects.columns, objects.checks, objects.indexes, objects.functions, objects.triggers, objects.foreignKeys].map(value => JSON.stringify(value)));
        const found = new Set(result.rows.map(row => row.relation));
        return wanted.every(item => found.has(item));
    } catch { return false; }
}

/** Mapping routes are part of the account API even when paid generation is disabled. */
async function checkModelMappingDatabaseReadiness(database: RelationQuery): Promise<boolean> {
    const columns = [
        ...launchColumns("model_mapping_draft", { id: "text", version: "int4", document: "jsonb", updated_at: "timestamptz" }, [], { version: "0", updated_at: "now()" }),
        ...launchColumns("model_mapping_publication", { id: "text", version: "int4", draft_version: "int4", fingerprint: "text", document: "jsonb", created_at: "timestamptz" }, [], { created_at: "now()" }),
    ];
    const checks: LaunchCheck[] = [
        { table: "model_mapping_draft", name: "model_mapping_draft_id", expression: "(id='catalog'::text)" },
        { table: "model_mapping_draft", name: "model_mapping_draft_version", expression: "(version>=0)" },
        { table: "model_mapping_draft", name: "model_mapping_draft_object", expression: "(jsonb_typeof(document)='object'::text)" },
        { table: "model_mapping_publication", name: "model_mapping_publication_positive_version", expression: "((version>0)AND(draft_version>=0))" },
        { table: "model_mapping_publication", name: "model_mapping_publication_fingerprint", expression: "(fingerprint~'^[a-f0-9]{64}$'::text)" },
        { table: "model_mapping_publication", name: "model_mapping_publication_document", expression: "(jsonb_typeof(document)='object'::text)" },
    ];
    const indexes: LaunchIndex[] = [
        ...["model_mapping_draft", "model_mapping_publication"].map(table => ({ table, name: `${table}_pkey`, columns: ["id"] })),
        { table: "model_mapping_publication", name: "model_mapping_publication_version", columns: ["version"] },
    ];
    if (!await checkLaunchObjects(database, { columns, checks, indexes,
        functions: [triggerFunction("reject_model_price_draft_mutation", [], "BEGIN RAISE EXCEPTION 'Model price drafts are append-only'; END;")],
        triggers: [{ table: "model_mapping_publication", name: "model_mapping_publication_append_only", function: "reject_model_price_draft_mutation", events: 27 }],
        foreignKeys: [],
    })) return false;
    const seed = await database.query("SELECT 'mapping.catalog' AS relation FROM canvas_saas.model_mapping_draft WHERE id='catalog'");
    return seed.rows.some(row => row.relation === "mapping.catalog");
}

/** Called only by the payment opt-in gate; a paid query alone grants no credit. */
export async function checkPaymentDatabaseReadiness(database: RelationQuery): Promise<boolean> {
    const columns = [
        ...launchColumns("payment_merchant_version", { id: "uuid", merchant_id: "text", protocol: "text", currency: "text", payment_type: "text", channel_id: "text",
            product_name: "text", notify_url: "text", ciphertext: "text", nonce: "text", auth_tag: "text", key_version: "int4", actor_id: "text", created_at: "timestamptz" }, ["channel_id"]),
        ...launchColumns("payment_offer_version", { id: "uuid", offer_id: "uuid", revision: "int4", label: "text", amount_minor: "text", credit_units: "numeric",
            policy_reference: "text", actor_id: "text", created_at: "timestamptz" }, ["policy_reference"]),
        ...launchColumns("payment_settings", { id: "text", revision: "int4", new_orders_enabled: "bool", merchant_version_id: "uuid", offer_version_ids: "jsonb", updated_at: "timestamptz" },
            ["merchant_version_id"], { revision: "0", new_orders_enabled: "false", offer_version_ids: "'[]'::jsonb" }),
        ...launchColumns("payment_order", { id: "uuid", owner_id: "text", create_key: "text", provider: "text", merchant_version_id: "uuid", offer_version_id: "uuid", merchant_id: "text",
            merchant_order_id: "text", currency: "text", amount_minor: "text", credit_units: "numeric", payment_type: "text", product_name: "text", channel_id: "text", create_state: "text",
            create_attempt_token: "uuid", create_attempted_at: "timestamptz", provider_trade_no: "text", provider_order_id: "text", payment_links: "jsonb", payment_state: "text",
            credit_state: "text", refund_state: "text", credited_ledger_id: "text", credited_at: "timestamptz", last_reason: "text", created_at: "timestamptz", updated_at: "timestamptz" },
            ["channel_id", "create_attempt_token", "create_attempted_at", "provider_trade_no", "provider_order_id", "payment_links", "credited_ledger_id", "credited_at", "last_reason"],
            { create_state: "'pending'::text", payment_state: "'unknown'::text", credit_state: "'pending'::text", refund_state: "'none'::text" }),
        ...launchColumns("payment_event", { id: "uuid", order_id: "uuid", kind: "text", event_identity: "text", outcome: "text", evidence: "jsonb", ciphertext: "text", nonce: "text", auth_tag: "text",
            key_version: "int4", request_id: "text", created_at: "timestamptz" }, ["event_identity", "ciphertext", "nonce", "auth_tag", "key_version"]),
        ...launchColumns("wallet", { user_id: "text", available_units: "numeric", reserved_units: "numeric", version: "int4" }),
        ...launchColumns("wallet_ledger", { id: "text", user_id: "text", kind: "text", delta_available_units: "numeric", delta_reserved_units: "numeric", available_units_after: "numeric",
            reserved_units_after: "numeric", idempotency_key: "text", reference_type: "text", reference_id: "text", metadata: "jsonb" }, ["reference_type", "reference_id", "metadata"]),
    ];
    const checks: LaunchCheck[] = [];
    const add = (table: string, values: Record<string, string>) => { for (const [name, expression] of Object.entries(values)) checks.push({ table, name, expression }); };
    add("payment_merchant_version", { payment_merchant_identity: "(merchant_id~'^[A-Za-z0-9_-]+$'::text)",
        payment_merchant_protocol: "((protocol='zpay-epay-md5-doc-03b0f9fb1ff6'::text)AND(currency='CNY'::text))",
        payment_merchant_type: enumExpression("payment_type", ["alipay", "wxpay"]), payment_merchant_credential: "((length(ciphertext)>0)AND(length(nonce)=24)AND(length(auth_tag)=32)AND(key_version=1))" });
    add("payment_offer_version", { payment_offer_revision: "(revision>0)", payment_offer_amount: "(amount_minor~'^[1-9][0-9]*$'::text)",
        payment_offer_credits: "((credit_units>(0)::numeric)AND(credit_units<>ALL(ARRAY['NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric])))" });
    add("payment_settings", { payment_settings_id: "(id='zpay'::text)", payment_settings_revision: "(revision>=0)", payment_settings_offers: "(jsonb_typeof(offer_version_ids)='array'::text)",
        payment_settings_enablement: "((NOTnew_orders_enabled)OR((merchant_version_idISNOTNULL)AND(jsonb_array_length(offer_version_ids)>0)))" });
    add("payment_order", { payment_order_identity: "((provider='zpay'::text)AND(currency='CNY'::text)AND(merchant_id~'^[A-Za-z0-9_-]+$'::text)AND(merchant_order_id~'^[A-Za-z0-9_-]{1,32}$'::text)AND((provider_trade_noISNULL)OR(provider_trade_no~'^[A-Za-z0-9_-]+$'::text)))",
        payment_order_amount: "((amount_minor~'^[1-9][0-9]*$'::text)AND(credit_units>(0)::numeric)AND(credit_units<>ALL(ARRAY['NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric])))",
        payment_order_type: enumExpression("payment_type", ["alipay", "wxpay"]), payment_order_create_state: enumExpression("create_state", ["pending", "attempting", "accepted", "rejected", "unknown"]),
        payment_order_attempt_pair: "((create_attempt_tokenISNULL)=(create_attempted_atISNULL))", payment_order_payment_state: enumExpression("payment_state", ["unknown", "unpaid", "paid"]),
        payment_order_refund_state: enumExpression("refund_state", ["none", "pending_review", "refunded"]),
        payment_order_credit_state: "(((credit_state='pending'::text)AND(credited_ledger_idISNULL)AND(credited_atISNULL))OR((credit_state='credited'::text)AND(credited_ledger_idISNOTNULL)AND(credited_atISNOTNULL)AND(provider_trade_noISNOTNULL)AND(payment_state='paid'::text)))" });
    add("payment_event", { payment_event_kind: enumExpression("kind", ["notification", "query", "create", "reconcile"]), payment_event_evidence: "(jsonb_typeof(evidence)='object'::text)",
        payment_event_notice_cipher: "(((kind='notification'::text)AND(event_identityISNOTNULL)AND(ciphertextISNOTNULL)AND(length(ciphertext)>0)AND(nonceISNOTNULL)AND(length(nonce)=24)AND(auth_tagISNOTNULL)AND(length(auth_tag)=32)AND(key_versionISNOTNULL)AND(key_version=1))OR((kind<>'notification'::text)AND(ciphertextISNULL)AND(nonceISNULL)AND(auth_tagISNULL)AND(key_versionISNULL)))" });
    const indexes: LaunchIndex[] = [
        ...["payment_merchant_version", "payment_offer_version", "payment_settings", "payment_order", "payment_event", "wallet_ledger"].map(table => ({ table, name: `${table}_pkey`, columns: ["id"] })),
        { table: "wallet", name: "wallet_pkey", columns: ["user_id"] },
        { table: "payment_offer_version", name: "payment_offer_version_unique", columns: ["offer_id", "revision"] },
        { table: "payment_order", name: "payment_order_owner_key", columns: ["owner_id", "create_key"] },
        { table: "payment_order", name: "payment_order_merchant_number", columns: ["provider", "merchant_id", "merchant_order_id"] },
        { table: "payment_order", name: "payment_order_merchant_transaction", columns: ["provider", "merchant_id", "provider_trade_no"] },
        { table: "payment_order", name: "payment_order_credited_ledger", columns: ["credited_ledger_id"] },
        { table: "payment_event", name: "payment_event_identity", columns: ["event_identity"], predicate: "(kind='notification'::text)" },
        { table: "wallet_ledger", name: "wallet_ledger_payment_order_unique", columns: ["reference_id"], predicate: "((kind='recharge'::text)AND(reference_type='payment_order'::text))" },
        { table: "wallet_ledger", name: "wallet_ledger_user_idempotency", columns: ["user_id", "idempotency_key"] },
    ];
    const functions: LaunchFunction[] = [
        triggerFunction("reject_payment_evidence_mutation", [], "BEGIN RAISE EXCEPTION 'payment versions and evidence are immutable'; END;"),
        triggerFunction("reject_wallet_ledger_mutation", [], "BEGIN RAISE EXCEPTION 'wallet ledger is append-only'; END;"),
        triggerFunction("protect_payment_order", ["TG_OP = 'DELETE'", "merchant.id IS NULL OR offer.id IS NULL", "NEW.amount_minor IS DISTINCT FROM offer.amount_minor", "NEW.credit_units IS DISTINCT FROM offer.credit_units",
            "NEW.owner_id", "OLD.owner_id", "OLD.create_attempt_token IS NOT NULL", "OLD.provider_trade_no IS NOT NULL", "OLD.payment_state = 'paid'", "OLD.credit_state = 'credited'", "RAISE EXCEPTION"]),
        { name: "payment_credit_evidence_matches", args: "uuid, uuid, uuid", returns: "bool", volatility: "s", language: "sql", parts: ["SELECT EXISTS", "n.id = notice_id AND n.order_id = o.id", "q.id = query_id AND q.order_id = o.id",
            "n.evidence->>'merchantId' = o.merchant_id", "n.evidence->>'providerTradeNo' = o.provider_trade_no", "jsonb_typeof(n.evidence->'amountMinor') = 'string'",
            "q.evidence->>'jsonMemberUniqueness' = 'checked_unique'", "zpay-order-query-doc-03b0f9fb1ff6", "jsonb_typeof(q.evidence->'evidence'->'amountMinor') = 'string'", "TRADE_SUCCESS", "eventIdentity"] },
        triggerFunction("check_payment_credit_final", ["TG_TABLE_NAME = 'wallet_ledger'", "o.refund_state <> 'none'", "l.user_id IS DISTINCT FROM o.owner_id", "l.delta_available_units IS DISTINCT FROM o.credit_units",
            "l.delta_reserved_units <> 0", "l.idempotency_key IS DISTINCT FROM 'payment:' || target::text || ':recharge'", "notificationEventId", "queryEventId", "payment_credit_evidence_matches", "RAISE EXCEPTION"]),
    ];
    const triggers: LaunchTrigger[] = [
        ...["payment_merchant_version", "payment_offer_version", "payment_event"].map(table => ({ table, name: `${table}_immutable`, function: "reject_payment_evidence_mutation", events: 27 })),
        { table: "payment_order", name: "payment_order_protected", function: "protect_payment_order", events: 31 },
        { table: "wallet_ledger", name: "wallet_ledger_append_only", function: "reject_wallet_ledger_mutation", events: 27 },
        { table: "payment_order", name: "payment_order_credit_consistent", function: "check_payment_credit_final", events: 21, deferred: true },
        { table: "wallet_ledger", name: "wallet_ledger_payment_consistent", function: "check_payment_credit_final", events: 5, deferred: true },
    ];
    const foreignKeys: LaunchForeignKey[] = [
        { table: "payment_event", name: "payment_event_order_id_payment_order_id_fk", column: "order_id", reference: "payment_order", onDelete: "r" },
        ...["merchant", "offer"].map(kind => ({ table: "payment_order", name: `payment_order_${kind}_version_id_payment_${kind}_version_id_fk`, column: `${kind}_version_id`, reference: `payment_${kind}_version`, onDelete: "r" as const })),
        { table: "payment_order", name: "payment_order_owner_id_user_id_fk", column: "owner_id", reference: "user", onDelete: "r" },
        { table: "payment_order", name: "payment_order_credited_ledger_id_wallet_ledger_id_fk", column: "credited_ledger_id", reference: "wallet_ledger", onDelete: "r" },
        { table: "payment_settings", name: "payment_settings_merchant_version_id_payment_merchant_version_id_fk", column: "merchant_version_id", reference: "payment_merchant_version", onDelete: "r" },
    ];
    return checkLaunchObjects(database, { columns, checks, indexes, functions, triggers, foreignKeys });
}

/** Persisted generation limits require a complete immutable policy and one valid active pointer. */
export async function checkGenerationRateDatabaseReadiness(database: RelationQuery): Promise<boolean> {
    const columns = [
        ...launchColumns("generation_rate_version", { id: "uuid", revision: "int4", expected_revision: "int4", policy: "jsonb", actor_id: "text", request_id: "text", created_at: "timestamptz" }),
        ...launchColumns("generation_rate_settings", { id: "text", revision: "int4", active_version_id: "uuid", updated_at: "timestamptz" }, ["active_version_id"], { revision: "0" }),
    ];
    const checks: LaunchCheck[] = [
        { table: "generation_rate_version", name: "generation_rate_version_revision", expression: "((revision>0)AND(expected_revision>=0)AND((revision)::bigint=((expected_revision)::bigint+1)))" },
        { table: "generation_rate_version", name: "generation_rate_version_policy", expression: "(((jsonb_typeof(policy)='object'::text)AND(((policy-'ip'::text)-'user'::text)='{}'::jsonb)AND((jsonb_typeof((policy->'ip'::text))='object'::text)AND((policy->'ip'::text)?&ARRAY['enabled'::text,'points'::text,'duration'::text])AND(((((policy->'ip'::text)-'enabled'::text)-'points'::text)-'duration'::text)='{}'::jsonb)AND(jsonb_typeof(((policy->'ip'::text)->'enabled'::text))='boolean'::text)AND(jsonb_typeof(((policy->'ip'::text)->'points'::text))='number'::text)AND(((((policy->'ip'::text)->>'points'::text))::numeric>=(1)::numeric)AND((((policy->'ip'::text)->>'points'::text))::numeric<=(2147483647)::numeric))AND(trunc((((policy->'ip'::text)->>'points'::text))::numeric)=(((policy->'ip'::text)->>'points'::text))::numeric)AND(jsonb_typeof(((policy->'ip'::text)->'duration'::text))='number'::text)AND(((((policy->'ip'::text)->>'duration'::text))::numeric>=(1)::numeric)AND((((policy->'ip'::text)->>'duration'::text))::numeric<=('9007199254740'::bigint)::numeric))AND(trunc((((policy->'ip'::text)->>'duration'::text))::numeric)=(((policy->'ip'::text)->>'duration'::text))::numeric))AND((jsonb_typeof((policy->'user'::text))='object'::text)AND((policy->'user'::text)?&ARRAY['enabled'::text,'points'::text,'duration'::text])AND(((((policy->'user'::text)-'enabled'::text)-'points'::text)-'duration'::text)='{}'::jsonb)AND(jsonb_typeof(((policy->'user'::text)->'enabled'::text))='boolean'::text)AND(jsonb_typeof(((policy->'user'::text)->'points'::text))='number'::text)AND(((((policy->'user'::text)->>'points'::text))::numeric>=(1)::numeric)AND((((policy->'user'::text)->>'points'::text))::numeric<=(2147483647)::numeric))AND(trunc((((policy->'user'::text)->>'points'::text))::numeric)=(((policy->'user'::text)->>'points'::text))::numeric)AND(jsonb_typeof(((policy->'user'::text)->'duration'::text))='number'::text)AND(((((policy->'user'::text)->>'duration'::text))::numeric>=(1)::numeric)AND((((policy->'user'::text)->>'duration'::text))::numeric<=('9007199254740'::bigint)::numeric))AND(trunc((((policy->'user'::text)->>'duration'::text))::numeric)=(((policy->'user'::text)->>'duration'::text))::numeric)))ISTRUE)" },
        { table: "generation_rate_settings", name: "generation_rate_settings_id", expression: "(id='generation'::text)" },
        { table: "generation_rate_settings", name: "generation_rate_settings_revision", expression: "(((revision=0)AND(active_version_idISNULL))OR((revision>0)AND(active_version_idISNOTNULL)))" },
    ];
    const indexes: LaunchIndex[] = [
        ...["generation_rate_version", "generation_rate_settings"].map(table => ({ table, name: `${table}_pkey`, columns: ["id"] })),
        { table: "generation_rate_version", name: "generation_rate_version_revision", columns: ["revision"] },
    ];
    const functions = [triggerFunction("reject_generation_rate_version_mutation", [], "BEGIN RAISE EXCEPTION 'published generation rate versions are immutable'; END;")];
    const triggers = [{ table: "generation_rate_version", name: "generation_rate_version_immutable", function: "reject_generation_rate_version_mutation", events: 27 }];
    const foreignKeys: LaunchForeignKey[] = [
        { table: "generation_rate_version", name: "generation_rate_version_actor_id_user_id_fk", column: "actor_id", reference: "user", onDelete: "r" },
        { table: "generation_rate_settings", name: "generation_rate_settings_active_version_id_generation_rate_version_id_fk", column: "active_version_id", reference: "generation_rate_version", onDelete: "r" },
    ];
    if (!await checkLaunchObjects(database, { columns, checks, indexes, functions, triggers, foreignKeys })) return false;
    try {
        const active = await database.query(`SELECT 'generation_rate.active' AS relation
            WHERE NOT pg_is_in_recovery() AND current_setting('transaction_read_only')='off'
              AND (SELECT count(*) FROM canvas_saas.generation_rate_settings)=1
              AND EXISTS (SELECT 1 FROM canvas_saas.generation_rate_settings s
                LEFT JOIN canvas_saas.generation_rate_version v ON v.id=s.active_version_id
                WHERE s.id='generation' AND ((s.revision=0 AND s.active_version_id IS NULL)
                    OR (s.revision>0 AND v.id IS NOT NULL AND v.revision=s.revision)))`);
        return active.rows.some(row => row.relation === "generation_rate.active");
    } catch { return false; }
}

/** Video opt-in requires the exact durable attachment/source/mirror installation. */
export async function checkVideoDatabaseReadiness(database: RelationQuery): Promise<boolean> {
    const columns = [
        ...launchColumns("generation_task", { video_quote_snapshot: "jsonb", provider_task_id: "text", owner_id: "text", price_publication_id: "text" }, ["video_quote_snapshot", "provider_task_id", "price_publication_id"]),
        ...launchColumns("generation_video_stage", { task_id: "text", owner_id: "text", protocol: "text", provider_id: "text", endpoint: "text", provider_model: "text", price_publication_id: "text",
            parameters_snapshot: "jsonb", phase: "text", revision: "int4", create_attempt_token: "text", create_started_at: "timestamptz", provider_task_id: "text", claim_token: "text", lease_until: "timestamptz",
            next_action_at: "timestamptz", inspect_attempts: "int4", download_attempts: "int4", observation_deadline_at: "timestamptz", wake_revision: "int4", wake_job_id: "text", wake_deadline_at: "timestamptz",
            last_reason: "text", last_http_status: "int4", completed_at: "timestamptz", duration_evidence: "jsonb", probe_snapshot: "jsonb", created_at: "timestamptz", updated_at: "timestamptz" },
            ["create_attempt_token", "create_started_at", "provider_task_id", "claim_token", "lease_until", "next_action_at", "observation_deadline_at", "wake_revision", "wake_job_id", "wake_deadline_at", "last_reason", "last_http_status", "completed_at", "duration_evidence", "probe_snapshot"],
            { revision: "0", inspect_attempts: "0", download_attempts: "0" }),
        ...launchColumns("generation_result", { task_id: "text", owner_id: "text", status: "text", provider_task_id: "text" }, ["provider_task_id"]),
    ];
    const checks: LaunchCheck[] = [
        { table: "generation_task", name: "generation_task_video_quote", expression: "((video_quote_snapshotISNULL)OR((jsonb_typeof(video_quote_snapshot)='object'::text)AND(text_quote_snapshotISNULL)AND(price_versionISNOTNULL)AND(quoted_unitsISNOTNULL)AND(billing_unit_snapshot='request'::text)AND(credits_per_unit_snapshotISNOTNULL)))" },
        { table: "generation_video_stage", name: "generation_video_stage_protocol", expression: "(protocol='yunfei-grok-video-v1'::text)" },
        { table: "generation_video_stage", name: "generation_video_stage_phase", expression: enumExpression("phase", ["ready", "rejected", "create_started", "accepted", "polling", "completed", "failed", "unknown"]) },
        { table: "generation_video_stage", name: "generation_video_stage_counters", expression: "((revision>=0)AND(inspect_attempts>=0)AND(download_attempts>=0)AND((wake_revisionISNULL)OR(wake_revision>=0)))" },
        { table: "generation_video_stage", name: "generation_video_stage_claim_pair", expression: "((claim_tokenISNULL)=(lease_untilISNULL))" },
        { table: "generation_video_stage", name: "generation_video_stage_create_pair", expression: "((create_attempt_tokenISNULL)=(create_started_atISNULL))" },
        { table: "generation_video_stage", name: "generation_video_stage_parameters", expression: "(jsonb_typeof(parameters_snapshot)='object'::text)" },
        { table: "generation_video_stage", name: "generation_video_stage_bound_phase", expression: "((phase<>ALL(ARRAY['accepted'::text,'polling'::text,'completed'::text,'failed'::text]))OR(provider_task_idISNOTNULL))" },
        { table: "generation_video_stage", name: "generation_video_stage_rejected", expression: "((phase<>'rejected'::text)OR((create_attempt_tokenISNULL)AND(create_started_atISNULL)AND(provider_task_idISNULL)))" },
        { table: "generation_video_stage", name: "generation_video_stage_http_status", expression: "((last_http_statusISNULL)OR((last_http_status>=100)AND(last_http_status<=599)))" },
        { table: "generation_video_stage", name: "generation_video_stage_id", expression: "((provider_task_idISNULL)OR(((length(provider_task_id)>=1)AND(length(provider_task_id)<=200))AND(provider_task_id<>ALL(ARRAY['.'::text,'..'::text]))AND(provider_task_id!~'[[:cntrl:]]'::text)))" },
        { table: "model_pricing", name: "model_pricing_billing_unit", expression: enumExpression("billing_unit", ["request", "input_token", "output_token", "second", "megapixel", "text_tokens", "image_specs", "video_specs"]) },
        { table: "model_pricing", name: "model_pricing_credits_positive", expression: "(((billing_unit=ANY(ARRAY['text_tokens'::text,'image_specs'::text,'video_specs'::text]))AND(credits_per_unitISNULL))OR((billing_unit<>ALL(ARRAY['text_tokens'::text,'image_specs'::text,'video_specs'::text]))AND(credits_per_unitISNOTNULL)AND(credits_per_unit>0)))" },
    ];
    const functions: LaunchFunction[] = [
        { name: "video_price_parameters", args: "jsonb", returns: "jsonb", volatility: "i", language: "plpgsql", parts: ["durationSeconds", "jsonb_each", "RETURN normalized"] },
        { name: "canonical_video_parameters", args: "jsonb, boolean", returns: "jsonb", volatility: "i", language: "plpgsql", parts: ["saved_strings", "video_price_parameters", "duration < 1 OR duration > 15", "generateAudio", "aspectRatio"] },
        { name: "video_spec_task_credits", args: "jsonb, jsonb, jsonb", returns: "bigint", volatility: "i", language: "plpgsql", parts: ["yunfei-grok-video-v1", "delivered_video", "canonical_video_parameters", "binding->>'endpoint'", "video_count", "video_second", "matches = 1", "9007199254740991"] },
        triggerFunction("check_model_price_publication_source", ["video_specs", "video_spec_task_credits", "canonical_video_parameters", "image_spec_task_credits", "text_cached_tokens", "audio_request", "RAISE EXCEPTION"]),
        triggerFunction("bind_generation_task_price_publication", ["video_quote_snapshot", "expected_video_quote", "video_spec_task_credits", "m.owner_id=NEW.owner_id", "source.id", "image_spec_task_credits", "text_cached_tokens", "RAISE EXCEPTION"]),
        triggerFunction("protect_generation_task_price_source", ["OLD.owner_id", "NEW.owner_id", "OLD.video_quote_snapshot", "NEW.video_quote_snapshot", "OLD.provider_task_id IS NOT NULL", "NEW.provider_task_id IS DISTINCT FROM OLD.provider_task_id", "RAISE EXCEPTION"]),
        triggerFunction("protect_generation_video_stage", ["TG_OP = 'DELETE'", "OLD.create_attempt_token", "NEW.create_attempt_token", "NEW.revision::bigint IS DISTINCT FROM OLD.revision::bigint+1", "source.owner_id IS DISTINCT FROM NEW.owner_id",
            "NEW.parameters_snapshot IS DISTINCT FROM source.parameter_snapshot", "NEW.provider_id IS DISTINCT FROM source.provider_id_snapshot", "RAISE EXCEPTION"]),
        triggerFunction("check_generation_video_stage_final", ["TG_TABLE_NAME", "generation_task", "generation_video_stage", "generation_result", "stage_row.owner_id IS DISTINCT FROM task_row.owner_id", "stage_row.provider_task_id IS DISTINCT FROM task_row.provider_task_id",
            "result_row.status = 'unknown'", "task_row.execution_status IS DISTINCT FROM 'succeeded'", "stage_row.phase IN ('completed','failed','rejected')", "RAISE EXCEPTION"]),
    ];
    const triggers: LaunchTrigger[] = [
        { table: "model_price_publication", name: "model_price_publication_source", function: "check_model_price_publication_source", events: 7 },
        { table: "generation_task", name: "generation_task_price_publication_insert", function: "bind_generation_task_price_publication", events: 7 },
        { table: "generation_task", name: "generation_task_price_source_immutable", function: "protect_generation_task_price_source", events: 19 },
        { table: "generation_video_stage", name: "generation_video_stage_immutable", function: "protect_generation_video_stage", events: 31 },
        { table: "generation_task", name: "generation_task_video_stage_final", function: "check_generation_video_stage_final", events: 21, deferred: true },
        { table: "generation_video_stage", name: "generation_video_stage_task_final", function: "check_generation_video_stage_final", events: 29, deferred: true },
        { table: "generation_result", name: "generation_video_result_final", function: "check_generation_video_stage_final", events: 29, deferred: true },
    ];
    return checkLaunchObjects(database, { columns, checks, functions, triggers,
        indexes: [{ table: "generation_video_stage", name: "generation_video_stage_pkey", columns: ["task_id"] },
            { table: "generation_result", name: "generation_result_task_id_unique", columns: ["task_id"] }],
        foreignKeys: [{ table: "generation_video_stage", name: "generation_video_stage_task_id_generation_task_id_fk", column: "task_id", reference: "generation_task", onDelete: "c" },
            { table: "generation_video_stage", name: "generation_video_stage_price_publication_id_model_price_publication_id_fk", column: "price_publication_id", reference: "model_price_publication", onDelete: "r" }],
    });
}
