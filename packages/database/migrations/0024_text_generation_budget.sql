ALTER TABLE "canvas_saas"."generation_task" ADD COLUMN "text_quote_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_text_quote" CHECK (
    text_quote_snapshot IS NULL OR (jsonb_typeof(text_quote_snapshot) = 'object' AND price_version IS NOT NULL
    AND quoted_units IS NULL AND billing_unit_snapshot IS NULL AND credits_per_unit_snapshot IS NULL)
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
    IF NOT FOUND OR source.adapter_snapshot NOT IN ('openai-compatible', 'sub2api')
       OR source.rules->'sale'->>'currency' IS DISTINCT FROM 'credit'
       OR jsonb_typeof(source.rules->'sale'->'bands') IS DISTINCT FROM 'array'
       OR jsonb_array_length(source.rules->'sale'->'bands') IS DISTINCT FROM 1
       OR source.rules->'sale'->'bands'->0->'parameters' IS DISTINCT FROM '{}'::jsonb
    THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;

    rates := source.rules->'sale'->'bands'->0->'rates';
    IF source.adapter_snapshot = 'openai-compatible' AND source.capability_snapshot = 'image' AND source.billing_unit = 'request'
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
CREATE OR REPLACE FUNCTION "canvas_saas"."bind_generation_task_price_publication"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source record;
    quote jsonb;
    amount text;
BEGIN
    SELECT publication.id, price.billing_unit, price.credits_per_unit, draft.rules, draft.capability_snapshot, draft.adapter_snapshot
      INTO source
      FROM "canvas_saas"."model_price_publication" publication
      JOIN "canvas_saas"."model_pricing" price ON price.id = publication.pricing_id
      JOIN "canvas_saas"."model_price_draft" draft ON draft.id = publication.draft_id
      JOIN "canvas_saas"."model_catalog" model ON model.id = price.model_id
     WHERE model.public_id = NEW.model_id AND price.version = NEW.price_version;
    IF NEW.price_publication_id IS NOT NULL AND NEW.price_publication_id IS DISTINCT FROM source.id THEN
        RAISE EXCEPTION 'Generation task publication source does not match its confirmed price';
    END IF;
    quote := NEW.text_quote_snapshot;
    IF quote IS NOT NULL OR source.billing_unit = 'text_tokens' THEN
        IF source.id IS NULL OR source.billing_unit IS DISTINCT FROM 'text_tokens' OR source.capability_snapshot IS DISTINCT FROM 'text'
           OR source.credits_per_unit IS NOT NULL OR quote IS NULL OR jsonb_typeof(quote) IS DISTINCT FROM 'object'
           OR quote - 'schemaVersion' - 'budgetCredits' - 'inputCreditsPerMillion' - 'outputCreditsPerMillion' - 'usageSource' IS DISTINCT FROM '{}'::jsonb
           OR quote->'schemaVersion' IS DISTINCT FROM '1'::jsonb
           OR jsonb_typeof(quote->'budgetCredits') IS DISTINCT FROM 'string'
           OR quote->'inputCreditsPerMillion' IS DISTINCT FROM source.rules->'sale'->'bands'->0->'rates'->'input_token'
           OR quote->'outputCreditsPerMillion' IS DISTINCT FROM source.rules->'sale'->'bands'->0->'rates'->'output_token'
           OR quote->>'usageSource' IS DISTINCT FROM (CASE source.adapter_snapshot WHEN 'sub2api' THEN 'responses' WHEN 'openai-compatible' THEN 'chat_completions' ELSE NULL END)
           OR NEW.quoted_units IS NOT NULL OR NEW.billing_unit_snapshot IS NOT NULL OR NEW.credits_per_unit_snapshot IS NOT NULL
        THEN RAISE EXCEPTION 'Generation text quote does not match its published dual rates'; END IF;
        amount := quote->>'budgetCredits';
        IF amount !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' OR amount = '0'
           OR length(split_part(amount, '.', 1)) > 131072 OR length(split_part(amount, '.', 2)) > 16383
        THEN RAISE EXCEPTION 'Invalid generation text budget'; END IF;
    ELSIF source.id IS NOT NULL AND (
        source.billing_unit IS DISTINCT FROM 'request' OR
        ROW(NEW.billing_unit_snapshot, NEW.credits_per_unit_snapshot, NEW.quoted_units)
          IS DISTINCT FROM ROW(source.billing_unit, source.credits_per_unit, source.credits_per_unit)
    ) THEN RAISE EXCEPTION 'Generation task snapshot does not match its published single-request price'; END IF;
    NEW.price_publication_id := source.id;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "canvas_saas"."protect_generation_task_price_source"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.model_id, OLD.price_version, OLD.quoted_units, OLD.billing_unit_snapshot, OLD.credits_per_unit_snapshot, OLD.price_publication_id, OLD.text_quote_snapshot)
       IS DISTINCT FROM ROW(NEW.model_id, NEW.price_version, NEW.quoted_units, NEW.billing_unit_snapshot, NEW.credits_per_unit_snapshot, NEW.price_publication_id, NEW.text_quote_snapshot)
    THEN RAISE EXCEPTION 'Generation task price snapshot and publication source are immutable'; END IF;
    RETURN NEW;
END;
$$;
