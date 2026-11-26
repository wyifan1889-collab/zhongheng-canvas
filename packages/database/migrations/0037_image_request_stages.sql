ALTER FUNCTION "canvas_saas"."image_spec_task_credits"(jsonb, jsonb) RENAME TO "image_spec_task_credits_core";
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."image_spec_task_credits"(rules jsonb, task_parameters jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE policy jsonb;
BEGIN
    IF rules ? 'image' THEN
        policy := rules->'image';
        IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
           OR NOT (policy ?& ARRAY['schemaVersion', 'protocol', 'maxImagesPerRequest'])
           OR policy - 'schemaVersion' - 'protocol' - 'maxImagesPerRequest' IS DISTINCT FROM '{}'::jsonb
           OR policy->'schemaVersion' IS DISTINCT FROM '1'::jsonb
           OR policy->>'protocol' IS DISTINCT FROM 'openai-image-v1'
           OR jsonb_typeof(policy->'maxImagesPerRequest') IS DISTINCT FROM 'number'
        THEN RETURN NULL; END IF;
        IF (policy->>'maxImagesPerRequest')::numeric < 1 OR (policy->>'maxImagesPerRequest')::numeric > 10
           OR trunc((policy->>'maxImagesPerRequest')::numeric) IS DISTINCT FROM (policy->>'maxImagesPerRequest')::numeric
        THEN RETURN NULL; END IF;
    END IF;
    RETURN "canvas_saas"."image_spec_task_credits_core"(rules - 'image', task_parameters);
END;
$$;
--> statement-breakpoint
CREATE TABLE "canvas_saas"."generation_image_request" (
    "task_id" text NOT NULL CONSTRAINT "generation_image_request_task_id_generation_task_id_fk" REFERENCES "canvas_saas"."generation_task"("id") ON DELETE CASCADE,
    "owner_id" text NOT NULL CONSTRAINT "generation_image_request_owner_id_user_id_fk" REFERENCES "canvas_saas"."user"("id") ON DELETE CASCADE,
    "request_index" integer NOT NULL,
    "image_count" integer NOT NULL,
    "publication_id" text NOT NULL CONSTRAINT "generation_image_request_publication_id_model_price_publication_id_fk" REFERENCES "canvas_saas"."model_price_publication"("id") ON DELETE RESTRICT,
    "binding_snapshot" jsonb NOT NULL,
    "parameters_snapshot" jsonb NOT NULL,
    "phase" text DEFAULT 'ready' NOT NULL,
    "attempt_token" text,
    "result_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "last_reason" text,
    "started_at" timestamptz,
    "completed_at" timestamptz,
    CONSTRAINT "generation_image_request_task_id_request_index_pk" PRIMARY KEY ("task_id", "request_index"),
    CONSTRAINT "generation_image_request_count" CHECK ("request_index" BETWEEN 0 AND 9 AND "image_count" BETWEEN 1 AND 10),
    CONSTRAINT "generation_image_request_phase" CHECK ("phase" IN ('ready', 'started', 'succeeded', 'failed', 'unknown')),
    CONSTRAINT "generation_image_request_attempt" CHECK (("phase" = 'ready' AND "attempt_token" IS NULL AND "started_at" IS NULL) OR ("phase" <> 'ready' AND "attempt_token" IS NOT NULL AND "started_at" IS NOT NULL)),
    CONSTRAINT "generation_image_request_snapshots" CHECK (jsonb_typeof("binding_snapshot") = 'object' AND jsonb_typeof("parameters_snapshot") = 'object' AND jsonb_typeof("result_snapshot") = 'object')
);
