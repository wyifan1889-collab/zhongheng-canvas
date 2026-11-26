-- I1 contract only: image_specs has no global scalar price and does not enable execution.
ALTER TABLE "canvas_saas"."model_pricing" DROP CONSTRAINT "model_pricing_billing_unit";
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" ADD CONSTRAINT "model_pricing_billing_unit"
    CHECK (billing_unit IN ('request', 'input_token', 'output_token', 'second', 'megapixel', 'text_tokens', 'image_specs'));
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" DROP CONSTRAINT "model_pricing_credits_positive";
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" ADD CONSTRAINT "model_pricing_credits_positive"
    CHECK ((billing_unit IN ('text_tokens', 'image_specs') AND credits_per_unit IS NULL)
        OR (billing_unit NOT IN ('text_tokens', 'image_specs') AND credits_per_unit IS NOT NULL AND credits_per_unit > 0));
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."image_spec_task_credits"(rules jsonb, task_parameters jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    sale jsonb;
    bands jsonb;
    band jsonb;
    parameters jsonb;
    priced_parameters jsonb;
    prior jsonb;
    seen jsonb := '[]'::jsonb;
    amount text;
    dimensions text[];
    selected bigint := NULL;
    checked_rule jsonb;
    checked_parameters record;
    meters text[];
    meter text;
    derivation jsonb;
    basis jsonb;
    source jsonb;
    binding jsonb;
    factor text;
    factors numeric[] := ARRAY[]::numeric[];
    band_index integer;
    basis_amount text;
    cost_amount text;
BEGIN
    IF jsonb_typeof(rules) IS DISTINCT FROM 'object' OR rules->'schemaVersion' IS DISTINCT FROM '1'::jsonb
       OR NOT (rules ?& ARRAY['schemaVersion', 'cost', 'sale'])
       OR rules - 'schemaVersion' - 'cost' - 'sale' - 'derivation' IS DISTINCT FROM '{}'::jsonb
       OR jsonb_typeof(task_parameters) IS DISTINCT FROM 'object'
       OR task_parameters->'n' IS DISTINCT FROM '1'::jsonb
       OR task_parameters->'output_format' IS DISTINCT FROM '"png"'::jsonb
       OR task_parameters - 'n' - 'output_format' - 'size' - 'quality' IS DISTINCT FROM '{}'::jsonb
    THEN RETURN NULL; END IF;
    -- Private cost rules and multiplier evidence remain part of the immutable source.
    -- Validate them too: a sale-only subset must not publish a draft rejected by the shared parser.
    IF rules ? 'derivation' THEN
        derivation := rules->'derivation';
        IF jsonb_typeof(derivation) IS DISTINCT FROM 'object'
           OR NOT (derivation ?& ARRAY['schemaVersion', 'kind', 'binding', 'basis', 'costMultiplier', 'saleMultiplier', 'creditsPerCurrency', 'source'])
           OR derivation - 'schemaVersion' - 'kind' - 'binding' - 'basis' - 'costMultiplier' - 'saleMultiplier' - 'creditsPerCurrency' - 'source' IS DISTINCT FROM '{}'::jsonb
           OR derivation->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR derivation->>'kind' IS DISTINCT FROM 'multiplier'
        THEN RETURN NULL; END IF;
        binding := derivation->'binding';
        IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
           OR NOT (binding ?& ARRAY['providerId', 'providerModel', 'adapter', 'endpoint', 'capability'])
           OR binding - 'providerId' - 'providerModel' - 'adapter' - 'endpoint' - 'capability' IS DISTINCT FROM '{}'::jsonb
           OR binding->>'capability' IS DISTINCT FROM 'image' OR binding->>'adapter' IS DISTINCT FROM 'openai-compatible'
        THEN RETURN NULL; END IF;
        FOREACH meter IN ARRAY ARRAY['providerId', 'providerModel', 'endpoint'] LOOP
            amount := binding->>meter;
            IF jsonb_typeof(binding->meter) IS DISTINCT FROM 'string' OR amount = ''
               OR amount ~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]'
            THEN RETURN NULL; END IF;
        END LOOP;
        -- URL.search/hash are empty for bare trailing ?/#; preserve the original binding.
        IF binding->>'endpoint' !~* '^https://[^/?#@[:space:]]+(/[^?#]*)?[?]?[#]?$' THEN RETURN NULL; END IF;
        basis := derivation->'basis';
        -- Image publications cannot use the text-only official-reference derivation.
        source := derivation->'source';
        IF jsonb_typeof(source) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
        IF source->>'kind' = 'custom' THEN
            IF source - 'kind' IS DISTINCT FROM '{}'::jsonb THEN RETURN NULL; END IF;
        ELSIF source->>'kind' = 'saved_cost' THEN
            IF NOT (source ?& ARRAY['kind', 'draftId', 'draftVersion']) OR source - 'kind' - 'draftId' - 'draftVersion' IS DISTINCT FROM '{}'::jsonb
               OR jsonb_typeof(source->'draftId') IS DISTINCT FROM 'string' OR source->>'draftId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               OR jsonb_typeof(source->'draftVersion') IS DISTINCT FROM 'number'
            THEN RETURN NULL; END IF;
            IF (source->>'draftVersion')::numeric < 1 OR (source->>'draftVersion')::numeric > 9007199254740991
               OR trunc((source->>'draftVersion')::numeric) IS DISTINCT FROM (source->>'draftVersion')::numeric
            THEN RETURN NULL; END IF;
        ELSE RETURN NULL; END IF;
        FOREACH meter IN ARRAY ARRAY['costMultiplier', 'saleMultiplier', 'creditsPerCurrency'] LOOP
            IF meter = 'costMultiplier' AND derivation->meter = 'null'::jsonb THEN
                factors := array_append(factors, NULL::numeric);
                CONTINUE;
            END IF;
            factor := derivation->>meter;
            IF jsonb_typeof(derivation->meter) IS DISTINCT FROM 'string' OR factor !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
               OR length(split_part(factor, '.', 1)) > 131072 OR length(rtrim(split_part(factor, '.', 2), '0')) > 16383
            THEN RETURN NULL; END IF;
            factor := split_part(factor, '.', 1) || CASE WHEN rtrim(split_part(factor, '.', 2), '0') = '' THEN '' ELSE '.' || rtrim(split_part(factor, '.', 2), '0') END;
            IF meter <> 'costMultiplier' AND factor::numeric = 0 THEN RETURN NULL; END IF;
            factors := array_append(factors, factor::numeric);
        END LOOP;
    END IF;
    FOR checked_rule IN SELECT value FROM jsonb_array_elements(jsonb_build_array(rules->'cost', COALESCE(basis, 'null'::jsonb))) LOOP
        IF checked_rule = 'null'::jsonb THEN CONTINUE; END IF;
        IF jsonb_typeof(checked_rule) IS DISTINCT FROM 'object'
           OR NOT (checked_rule ?& ARRAY['template', 'currency', 'bands'])
           OR checked_rule - 'template' - 'currency' - 'bands' IS DISTINCT FROM '{}'::jsonb
           OR NOT COALESCE(checked_rule->>'currency' IN ('CNY', 'USD'), false)
           OR jsonb_typeof(checked_rule->'bands') IS DISTINCT FROM 'array'
        THEN RETURN NULL; END IF;
        meters := CASE checked_rule->>'template'
            WHEN 'image_request' THEN ARRAY['request'] WHEN 'image_count' THEN ARRAY['image']
            WHEN 'image_tokens' THEN ARRAY['input_token', 'output_token', 'image_input_token', 'image_output_token'] ELSE NULL END;
        IF meters IS NULL OR jsonb_array_length(checked_rule->'bands') = 0 THEN RETURN NULL; END IF;
        seen := '[]'::jsonb;
        FOR band IN SELECT value FROM jsonb_array_elements(checked_rule->'bands') LOOP
            IF jsonb_typeof(band) IS DISTINCT FROM 'object' OR NOT (band ?& ARRAY['parameters', 'rates'])
               OR band - 'parameters' - 'rates' IS DISTINCT FROM '{}'::jsonb
               OR jsonb_typeof(band->'parameters') IS DISTINCT FROM 'object' OR jsonb_typeof(band->'rates') IS DISTINCT FROM 'object'
               OR NOT (band->'rates' ?& meters) OR (band->'rates') - meters IS DISTINCT FROM '{}'::jsonb
               OR (band->'parameters') - 'size' - 'quality' - 'mode' IS DISTINCT FROM '{}'::jsonb
            THEN RETURN NULL; END IF;
            parameters := band->'parameters';
            FOR checked_parameters IN SELECT key, value FROM jsonb_each(parameters) LOOP
                amount := checked_parameters.value #>> '{}';
                IF jsonb_typeof(checked_parameters.value) IS DISTINCT FROM 'string' OR amount = ''
                   OR amount ~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]'
                THEN RETURN NULL; END IF;
            END LOOP;
            FOREACH meter IN ARRAY meters LOOP
                IF band->'rates'->meter = 'null'::jsonb THEN CONTINUE; END IF;
                amount := band->'rates'->>meter;
                IF jsonb_typeof(band->'rates'->meter) IS DISTINCT FROM 'string' OR amount !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
                   OR length(split_part(amount, '.', 1)) > 131072 OR length(rtrim(split_part(amount, '.', 2), '0')) > 16383
                THEN RETURN NULL; END IF;
            END LOOP;
            FOR prior IN SELECT value FROM jsonb_array_elements(seen) LOOP
                IF NOT EXISTS (SELECT 1 FROM jsonb_each(parameters) a JOIN jsonb_each(prior) b ON a.key = b.key WHERE a.value IS DISTINCT FROM b.value)
                THEN RETURN NULL; END IF;
            END LOOP;
            seen := seen || jsonb_build_array(parameters);
        END LOOP;
    END LOOP;
    priced_parameters := task_parameters - 'n' - 'output_format';
    sale := rules->'sale';
    IF jsonb_typeof(sale) IS DISTINCT FROM 'object'
       OR sale - 'template' - 'currency' - 'bands' IS DISTINCT FROM '{}'::jsonb
       OR sale->>'template' IS DISTINCT FROM 'image_request' OR sale->>'currency' IS DISTINCT FROM 'credit'
       OR jsonb_typeof(sale->'bands') IS DISTINCT FROM 'array'
    THEN RETURN NULL; END IF;
    bands := sale->'bands';
    IF jsonb_array_length(bands) = 0 THEN RETURN NULL; END IF;
    seen := '[]'::jsonb;
    FOR band IN SELECT value FROM jsonb_array_elements(bands) LOOP
        IF jsonb_typeof(band) IS DISTINCT FROM 'object'
           OR band - 'parameters' - 'rates' IS DISTINCT FROM '{}'::jsonb
           OR jsonb_typeof(band->'parameters') IS DISTINCT FROM 'object'
           OR jsonb_typeof(band->'rates') IS DISTINCT FROM 'object'
           OR (band->'rates') - 'request' IS DISTINCT FROM '{}'::jsonb
           OR jsonb_typeof(band->'rates'->'request') IS DISTINCT FROM 'string'
        THEN RETURN NULL; END IF;
        parameters := band->'parameters';
        IF parameters = '{}'::jsonb OR parameters - 'size' - 'quality' IS DISTINCT FROM '{}'::jsonb
        THEN RETURN NULL; END IF;
        IF parameters ? 'size' THEN
            IF jsonb_typeof(parameters->'size') IS DISTINCT FROM 'string' OR parameters->>'size' !~ '^[1-9][0-9]*x[1-9][0-9]*$'
            THEN RETURN NULL; END IF;
            dimensions := string_to_array(parameters->>'size', 'x');
            IF length(dimensions[1]) > 16 OR length(dimensions[2]) > 16 THEN RETURN NULL; END IF;
            IF dimensions[1]::numeric > 9007199254740991 OR dimensions[2]::numeric > 9007199254740991 THEN RETURN NULL; END IF;
        END IF;
        IF parameters ? 'quality' AND (jsonb_typeof(parameters->'quality') IS DISTINCT FROM 'string' OR parameters->>'quality' NOT IN ('low', 'medium', 'high'))
        THEN RETURN NULL; END IF;
        amount := band->'rates'->>'request';
        IF amount !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
           OR length(split_part(amount, '.', 1)) > 131072 OR length(rtrim(split_part(amount, '.', 2), '0')) > 16383
        THEN RETURN NULL; END IF;
        amount := split_part(amount, '.', 1) || CASE WHEN rtrim(split_part(amount, '.', 2), '0') = '' THEN '' ELSE '.' || rtrim(split_part(amount, '.', 2), '0') END;
        IF amount !~ '^[1-9][0-9]*$' OR length(amount) > 16 THEN RETURN NULL; END IF;
        IF amount::numeric > 9007199254740991 THEN RETURN NULL; END IF;
        -- Keep the draft's conjunction/overlap semantics; execution additionally requires exact keys/values.
        FOR prior IN SELECT value FROM jsonb_array_elements(seen) LOOP
            IF NOT EXISTS (SELECT 1 FROM jsonb_each(parameters) a JOIN jsonb_each(prior) b ON a.key = b.key WHERE a.value IS DISTINCT FROM b.value)
            THEN RETURN NULL; END IF;
        END LOOP;
        seen := seen || jsonb_build_array(parameters);
        IF parameters = priced_parameters THEN selected := amount::bigint; END IF;
    END LOOP;
    IF derivation IS NOT NULL THEN
        IF basis->>'template' IS DISTINCT FROM 'image_request' OR jsonb_array_length(basis->'bands') IS DISTINCT FROM jsonb_array_length(bands)
           OR ((factors[1] IS NULL) IS DISTINCT FROM (rules->'cost' = 'null'::jsonb))
        THEN RETURN NULL; END IF;
        IF factors[1] IS NOT NULL AND (rules->'cost'->>'template' IS DISTINCT FROM basis->>'template'
           OR rules->'cost'->>'currency' IS DISTINCT FROM basis->>'currency'
           OR jsonb_array_length(rules->'cost'->'bands') IS DISTINCT FROM jsonb_array_length(bands))
        THEN RETURN NULL; END IF;
        FOR band_index IN 0..jsonb_array_length(bands) - 1 LOOP
            band := basis->'bands'->band_index;
            IF band->'parameters' IS DISTINCT FROM bands->band_index->'parameters' OR band->'rates'->'request' = 'null'::jsonb
            THEN RETURN NULL; END IF;
            basis_amount := band->'rates'->>'request';
            basis_amount := split_part(basis_amount, '.', 1) || CASE WHEN rtrim(split_part(basis_amount, '.', 2), '0') = '' THEN '' ELSE '.' || rtrim(split_part(basis_amount, '.', 2), '0') END;
            IF basis_amount::numeric * factors[2] * factors[3] IS DISTINCT FROM (bands->band_index->'rates'->>'request')::numeric
            THEN RETURN NULL; END IF;
            IF factors[1] IS NOT NULL THEN
                cost_amount := rules->'cost'->'bands'->band_index->'rates'->>'request';
                IF rules->'cost'->'bands'->band_index->'parameters' IS DISTINCT FROM band->'parameters' OR cost_amount IS NULL
                THEN RETURN NULL; END IF;
                cost_amount := split_part(cost_amount, '.', 1) || CASE WHEN rtrim(split_part(cost_amount, '.', 2), '0') = '' THEN '' ELSE '.' || rtrim(split_part(cost_amount, '.', 2), '0') END;
                IF basis_amount::numeric * factors[1] IS DISTINCT FROM cost_amount::numeric THEN RETURN NULL; END IF;
            END IF;
        END LOOP;
    END IF;
    RETURN selected;
EXCEPTION WHEN numeric_value_out_of_range THEN RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "canvas_saas"."check_model_price_publication_source"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source record;
    rates jsonb;
    amount text;
    meter text;
    template text;
    meters text[];
BEGIN
    SELECT d.*, p.billing_unit, p.credits_per_unit INTO source
      FROM "canvas_saas"."model_price_draft" d
      JOIN "canvas_saas"."model_pricing" p ON p.model_id = d.model_id
     WHERE d.id = NEW.draft_id AND p.id = NEW.pricing_id;
    IF NOT FOUND OR source.adapter_snapshot NOT IN ('openai-compatible', 'sub2api')
    THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;
    IF source.billing_unit = 'image_specs' THEN
        IF source.adapter_snapshot IS DISTINCT FROM 'openai-compatible' OR source.capability_snapshot IS DISTINCT FROM 'image'
           OR source.credits_per_unit IS NOT NULL
           OR (source.rules ? 'derivation' AND source.rules->'derivation'->'binding' IS DISTINCT FROM jsonb_build_object(
                'providerId', source.provider_id_snapshot, 'providerModel', source.provider_model_snapshot,
                'adapter', source.adapter_snapshot, 'endpoint', source.endpoint_snapshot, 'capability', source.capability_snapshot))
           OR "canvas_saas"."image_spec_task_credits"(source.rules,
                (source.rules->'sale'->'bands'->0->'parameters') || '{"n":1,"output_format":"png"}'::jsonb) IS NULL
        THEN RAISE EXCEPTION 'Publication source does not match its image_specs price'; END IF;
        RETURN NEW;
    END IF;
    IF source.rules->'sale'->>'currency' IS DISTINCT FROM 'credit'
       OR jsonb_typeof(source.rules->'sale'->'bands') IS DISTINCT FROM 'array'
       OR jsonb_array_length(source.rules->'sale'->'bands') IS DISTINCT FROM 1
       OR source.rules->'sale'->'bands'->0->'parameters' IS DISTINCT FROM '{}'::jsonb
    THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;
    rates := source.rules->'sale'->'bands'->0->'rates';
    IF source.adapter_snapshot = 'openai-compatible' AND source.capability_snapshot = 'image' AND source.billing_unit = 'request'
       AND source.rules->'sale'->>'template' = 'image_request' AND rates->>'request' = source.credits_per_unit::text
    THEN RETURN NEW; END IF;
    template := source.rules->'sale'->>'template';
    IF source.capability_snapshot IS DISTINCT FROM 'text' OR source.billing_unit IS DISTINCT FROM 'text_tokens'
       OR source.credits_per_unit IS NOT NULL
       OR (template IS DISTINCT FROM 'text_tokens' AND template IS DISTINCT FROM 'text_cached_tokens')
       OR jsonb_typeof(rates) IS DISTINCT FROM 'object'
       OR (CASE template WHEN 'text_cached_tokens' THEN rates - 'input_token' - 'cached_input_token' - 'output_token'
                ELSE rates - 'input_token' - 'output_token' END) IS DISTINCT FROM '{}'::jsonb
    THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;
    meters := CASE template WHEN 'text_cached_tokens' THEN ARRAY['input_token', 'cached_input_token', 'output_token']
                   ELSE ARRAY['input_token', 'output_token'] END;
    FOREACH meter IN ARRAY meters LOOP
        amount := rates->>meter;
        IF jsonb_typeof(rates->meter) IS DISTINCT FROM 'string'
           OR amount !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' OR amount = '0'
           OR length(split_part(amount, '.', 1)) > 131072 OR length(split_part(amount, '.', 2)) > 16383
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
    image_credits bigint;
BEGIN
    -- Start from the historical price, so an image_specs row with a missing publication cannot become legacy.
    SELECT publication.id, price.billing_unit, price.credits_per_unit, draft.rules, draft.capability_snapshot, draft.adapter_snapshot,
           draft.provider_id_snapshot, draft.provider_model_snapshot, draft.endpoint_snapshot
      INTO source
      FROM "canvas_saas"."model_pricing" price
      JOIN "canvas_saas"."model_catalog" model ON model.id = price.model_id
      LEFT JOIN "canvas_saas"."model_price_publication" publication ON publication.pricing_id = price.id
      LEFT JOIN "canvas_saas"."model_price_draft" draft ON draft.id = publication.draft_id
     WHERE model.public_id = NEW.model_id AND price.version = NEW.price_version;
    IF NEW.price_publication_id IS NOT NULL AND NEW.price_publication_id IS DISTINCT FROM source.id THEN
        RAISE EXCEPTION 'Generation task publication source does not match its confirmed price';
    END IF;
    quote := NEW.text_quote_snapshot;
    IF source.billing_unit = 'image_specs' THEN
        image_credits := "canvas_saas"."image_spec_task_credits"(source.rules, NEW.parameter_snapshot);
        IF source.id IS NULL OR source.capability_snapshot IS DISTINCT FROM 'image' OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible'
           OR source.credits_per_unit IS NOT NULL OR quote IS NOT NULL OR image_credits IS NULL
           OR (source.rules ? 'derivation' AND source.rules->'derivation'->'binding' IS DISTINCT FROM jsonb_build_object(
                'providerId', source.provider_id_snapshot, 'providerModel', source.provider_model_snapshot,
                'adapter', source.adapter_snapshot, 'endpoint', source.endpoint_snapshot, 'capability', source.capability_snapshot))
           OR ROW(NEW.billing_unit_snapshot, NEW.credits_per_unit_snapshot, NEW.quoted_units)
              IS DISTINCT FROM ROW('request'::text, image_credits, image_credits)
           OR jsonb_typeof(NEW.input_snapshot) IS DISTINCT FROM 'object'
           OR NEW.input_snapshot - 'prompt' IS DISTINCT FROM '{}'::jsonb
           OR jsonb_typeof(NEW.input_snapshot->'prompt') IS DISTINCT FROM 'string'
           OR (NEW.input_snapshot->>'prompt') !~ '[^[:space:]]'
        THEN RAISE EXCEPTION 'Generation image_specs task does not match its exact published specification'; END IF;
    ELSIF quote IS NOT NULL OR source.billing_unit = 'text_tokens' THEN
        IF source.id IS NULL OR source.billing_unit IS DISTINCT FROM 'text_tokens' OR source.capability_snapshot IS DISTINCT FROM 'text'
           OR source.credits_per_unit IS NOT NULL OR quote IS NULL OR jsonb_typeof(quote) IS DISTINCT FROM 'object'
           OR quote - 'schemaVersion' - 'budgetCredits' - 'inputCreditsPerMillion' - 'outputCreditsPerMillion' - 'cachedInputCreditsPerMillion' - 'usageSource' IS DISTINCT FROM '{}'::jsonb
           OR ((quote ? 'cachedInputCreditsPerMillion') IS DISTINCT FROM (source.rules->'sale'->>'template' = 'text_cached_tokens'))
           OR (source.rules->'sale'->>'template' IS DISTINCT FROM 'text_tokens' AND source.rules->'sale'->>'template' IS DISTINCT FROM 'text_cached_tokens')
           OR quote->'cachedInputCreditsPerMillion' IS DISTINCT FROM source.rules->'sale'->'bands'->0->'rates'->'cached_input_token'
           OR quote->'schemaVersion' IS DISTINCT FROM '1'::jsonb
           OR jsonb_typeof(quote->'budgetCredits') IS DISTINCT FROM 'string'
           OR quote->'inputCreditsPerMillion' IS DISTINCT FROM source.rules->'sale'->'bands'->0->'rates'->'input_token'
           OR quote->'outputCreditsPerMillion' IS DISTINCT FROM source.rules->'sale'->'bands'->0->'rates'->'output_token'
           OR quote->>'usageSource' IS DISTINCT FROM (CASE source.adapter_snapshot WHEN 'sub2api' THEN 'responses' WHEN 'openai-compatible' THEN 'chat_completions' ELSE NULL END)
           OR NEW.quoted_units IS NOT NULL OR NEW.billing_unit_snapshot IS NOT NULL OR NEW.credits_per_unit_snapshot IS NOT NULL
        THEN RAISE EXCEPTION 'Generation text quote does not match its published rates'; END IF;
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
    IF ROW(OLD.id, OLD.owner_id, OLD.idempotency_key, OLD.request_id, OLD.model_id, OLD.input_snapshot, OLD.parameter_snapshot,
           OLD.space_id, OLD.project_id, OLD.node_id, OLD.price_version, OLD.quoted_units, OLD.billing_unit_snapshot,
           OLD.credits_per_unit_snapshot, OLD.price_publication_id, OLD.text_quote_snapshot, OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.owner_id, NEW.idempotency_key, NEW.request_id, NEW.model_id, NEW.input_snapshot, NEW.parameter_snapshot,
           NEW.space_id, NEW.project_id, NEW.node_id, NEW.price_version, NEW.quoted_units, NEW.billing_unit_snapshot,
           NEW.credits_per_unit_snapshot, NEW.price_publication_id, NEW.text_quote_snapshot, NEW.created_at)
    THEN RAISE EXCEPTION 'Generation task identity, intent, price snapshot and publication source are immutable'; END IF;
    IF OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    THEN RAISE EXCEPTION 'Generation task reservation binding is immutable once set'; END IF;
    RETURN NEW;
END;
$$;
