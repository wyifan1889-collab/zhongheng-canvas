CREATE TABLE "canvas_saas"."model_price_publication" (
    "id" text PRIMARY KEY NOT NULL,
    "pricing_id" text NOT NULL REFERENCES "canvas_saas"."model_pricing"("id") ON DELETE restrict,
    "draft_id" text NOT NULL REFERENCES "canvas_saas"."model_price_draft"("id") ON DELETE restrict,
    "public_price_note" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_price_publication_pricing_unique" ON "canvas_saas"."model_price_publication" ("pricing_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "model_price_publication_draft_unique" ON "canvas_saas"."model_price_publication" ("draft_id");
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."check_model_price_publication_source"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "canvas_saas"."model_price_draft" d
        JOIN "canvas_saas"."model_pricing" p ON p.model_id = d.model_id
        WHERE d.id = NEW.draft_id AND p.id = NEW.pricing_id
          AND d.capability_snapshot = 'image' AND d.adapter_snapshot = 'openai-compatible'
          AND p.billing_unit = 'request'
          AND d.rules->'sale'->>'template' = 'image_request'
          AND d.rules->'sale'->>'currency' = 'credit'
          AND jsonb_array_length(d.rules->'sale'->'bands') = 1
          AND d.rules->'sale'->'bands'->0->'parameters' = '{}'::jsonb
          AND d.rules->'sale'->'bands'->0->'rates'->>'request' = p.credits_per_unit::text
    ) THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "model_price_publication_source" BEFORE INSERT ON "canvas_saas"."model_price_publication"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."check_model_price_publication_source"();
--> statement-breakpoint
CREATE TRIGGER "model_price_publication_append_only" BEFORE UPDATE OR DELETE ON "canvas_saas"."model_price_publication"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."reject_model_price_draft_mutation"();
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."protect_published_model_price"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "canvas_saas"."model_price_publication" WHERE pricing_id = OLD.id)
       AND ROW(OLD.id, OLD.model_id, OLD.version, OLD.billing_unit, OLD.credits_per_unit)
           IS DISTINCT FROM ROW(NEW.id, NEW.model_id, NEW.version, NEW.billing_unit, NEW.credits_per_unit)
    THEN RAISE EXCEPTION 'Published price identity and amount are immutable'; END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "model_pricing_published_snapshot" BEFORE UPDATE ON "canvas_saas"."model_pricing"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."protect_published_model_price"();
