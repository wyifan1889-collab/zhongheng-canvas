ALTER TABLE "canvas_saas"."model_pricing" ALTER COLUMN "credits_per_unit" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" DROP CONSTRAINT "model_pricing_billing_unit";
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" ADD CONSTRAINT "model_pricing_billing_unit"
    CHECK (billing_unit IN ('request', 'input_token', 'output_token', 'second', 'megapixel', 'text_tokens'));
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" DROP CONSTRAINT "model_pricing_credits_positive";
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" ADD CONSTRAINT "model_pricing_credits_positive" CHECK (
    (billing_unit = 'text_tokens' AND credits_per_unit IS NULL) OR
    (billing_unit <> 'text_tokens' AND credits_per_unit IS NOT NULL AND credits_per_unit > 0)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "canvas_saas"."check_model_price_publication_source"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source record;
    rates jsonb;
    amount text;
    meter text;
BEGIN
    SELECT d.*, p.billing_unit, p.credits_per_unit INTO source
      FROM "canvas_saas"."model_price_draft" d
      JOIN "canvas_saas"."model_pricing" p ON p.model_id = d.model_id
     WHERE d.id = NEW.draft_id AND p.id = NEW.pricing_id;
    IF NOT FOUND OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible'
       OR source.rules->'sale'->>'currency' IS DISTINCT FROM 'credit'
       OR jsonb_typeof(source.rules->'sale'->'bands') IS DISTINCT FROM 'array'
       OR jsonb_array_length(source.rules->'sale'->'bands') IS DISTINCT FROM 1
       OR source.rules->'sale'->'bands'->0->'parameters' IS DISTINCT FROM '{}'::jsonb
    THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;

    rates := source.rules->'sale'->'bands'->0->'rates';
    IF source.capability_snapshot = 'image' AND source.billing_unit = 'request'
       AND source.rules->'sale'->>'template' = 'image_request'
       AND rates->>'request' = source.credits_per_unit::text
    THEN RETURN NEW; END IF;

    IF source.capability_snapshot IS DISTINCT FROM 'text' OR source.billing_unit IS DISTINCT FROM 'text_tokens'
       OR source.credits_per_unit IS NOT NULL
       OR source.rules->'sale'->>'template' IS DISTINCT FROM 'text_tokens'
       OR jsonb_typeof(rates) IS DISTINCT FROM 'object'
       OR rates - 'input_token' - 'output_token' IS DISTINCT FROM '{}'::jsonb
    THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;
    FOREACH meter IN ARRAY ARRAY['input_token', 'output_token'] LOOP
        amount := rates->>meter;
        -- Canonical positive decimal strings, within PostgreSQL numeric's native range.
        -- Rates remain in the immutable draft; no scalar approximation is stored.
        IF jsonb_typeof(rates->meter) IS DISTINCT FROM 'string'
           OR amount !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' OR amount = '0'
           OR length(split_part(amount, '.', 1)) > 131072
           OR length(split_part(amount, '.', 2)) > 16383
        THEN RAISE EXCEPTION 'Invalid published text rate'; END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."require_text_price_publication"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "canvas_saas"."model_pricing" p WHERE p.id = NEW.id AND p.billing_unit = 'text_tokens'
        AND NOT EXISTS (SELECT 1 FROM "canvas_saas"."model_price_publication" publication WHERE publication.pricing_id = p.id))
    THEN RAISE EXCEPTION 'Text price requires an immutable publication source'; END IF;
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "model_pricing_text_publication_required"
    AFTER INSERT OR UPDATE ON "canvas_saas"."model_pricing" DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."require_text_price_publication"();
