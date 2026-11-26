CREATE TABLE "canvas_saas"."model_price_draft" (
    "id" text PRIMARY KEY NOT NULL,
    "model_id" text NOT NULL REFERENCES "canvas_saas"."model_catalog"("id") ON DELETE restrict,
    "version" integer NOT NULL,
    "rules" jsonb NOT NULL,
    "price_note" text NOT NULL,
    "provider_id_snapshot" text NOT NULL,
    "provider_model_snapshot" text NOT NULL,
    "adapter_snapshot" text NOT NULL,
    "endpoint_snapshot" text NOT NULL,
    "capability_snapshot" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "model_price_draft_version" CHECK ("version" > 0),
    CONSTRAINT "model_price_draft_rules" CHECK (jsonb_typeof("rules") = 'object'),
    CONSTRAINT "model_price_draft_adapter" CHECK ("adapter_snapshot" IN ('openai-compatible', 'sub2api')),
    CONSTRAINT "model_price_draft_capability" CHECK ("capability_snapshot" IN ('text', 'image', 'video'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_price_draft_model_version_unique" ON "canvas_saas"."model_price_draft" ("model_id", "version");
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."reject_model_price_draft_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Model price drafts are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "model_price_draft_append_only" BEFORE UPDATE OR DELETE ON "canvas_saas"."model_price_draft"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."reject_model_price_draft_mutation"();
