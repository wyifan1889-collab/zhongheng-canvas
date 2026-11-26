ALTER TABLE "canvas_saas"."generation_task" DROP CONSTRAINT "generation_task_billing_unit_snapshot";
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_billing_unit_snapshot" CHECK
    (billing_unit_snapshot IS NULL OR billing_unit_snapshot IN ('request','input_token','output_token','second','megapixel','image'));
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."gemini_image_spec_valid"(model text, spec jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(model IN ('gemini-3.1-flash-image-preview','gemini-3-pro-image-preview')
        AND jsonb_typeof(spec) = 'object' AND spec - 'aspectRatio' - 'imageSize' = '{}'::jsonb
        AND (spec->>'aspectRatio' IN ('1:1','2:3','3:2','4:3','3:4','4:5','5:4','16:9','9:16','21:9')
             OR model = 'gemini-3.1-flash-image-preview' AND spec->>'aspectRatio' IN ('1:4','4:1','1:8','8:1'))
        AND (spec->'imageSize' IN ('"1K"','"2K"','"4K"') OR model = 'gemini-3.1-flash-image-preview' AND spec->'imageSize'='"512"'),false);
$$;
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."gemini_image_unit_price"(rules jsonb, model text, endpoint text, selected_spec jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE band jsonb; seen jsonb := '[]'; spec jsonb; sale jsonb := rules->'sale'; cost jsonb := rules->'cost';
        amount text; selected bigint; mapped_cost_bands jsonb := '[]'; has_native_cost boolean;
BEGIN
    IF NOT "canvas_saas"."gemini_image_spec_valid"(model,selected_spec) OR endpoint IS NULL OR endpoint !~* '^https://[^/?#@[:space:]]+/?$'
       OR rules->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR NOT (rules ? 'cost')
       OR rules - 'schemaVersion' - 'sale' - 'cost' IS DISTINCT FROM '{}'::jsonb
       OR sale->>'currency' IS DISTINCT FROM 'credit' OR sale->>'template' IS DISTINCT FROM 'image_count'
       OR sale - 'template' - 'currency' - 'bands' IS DISTINCT FROM '{}'::jsonb OR jsonb_typeof(sale->'bands') IS DISTINCT FROM 'array'
    THEN RETURN NULL; END IF;
    FOR band IN SELECT value FROM jsonb_array_elements(sale->'bands') LOOP
        spec := band->'parameters'; amount := band->'rates'->>'image';
        IF NOT "canvas_saas"."gemini_image_spec_valid"(model,spec) OR seen @> jsonb_build_array(spec)
           OR band - 'parameters' - 'rates' IS DISTINCT FROM '{}'::jsonb OR (band->'rates') - 'image' IS DISTINCT FROM '{}'::jsonb
           OR jsonb_typeof(band->'rates'->'image') IS DISTINCT FROM 'string' OR amount !~ '^[1-9][0-9]*$' OR length(amount)>16
        THEN RETURN NULL; END IF;
        IF amount::numeric > 9007199254740991 THEN RETURN NULL; END IF;
        seen := seen || jsonb_build_array(spec);
        IF spec = selected_spec THEN selected := amount::bigint; END IF;
    END LOOP;
    IF cost <> 'null'::jsonb THEN
        IF jsonb_typeof(cost->'bands') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
        SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(cost->'bands') b WHERE (b->'parameters') ?| ARRAY['aspectRatio','imageSize']) INTO has_native_cost;
        IF has_native_cost THEN
            IF cost->>'template' IS DISTINCT FROM 'image_count' THEN RETURN NULL; END IF;
            FOR band IN SELECT value FROM jsonb_array_elements(cost->'bands') LOOP
                spec := band->'parameters';
                IF NOT "canvas_saas"."gemini_image_spec_valid"(model,spec) THEN RETURN NULL; END IF;
                mapped_cost_bands := mapped_cost_bands || jsonb_build_array(band || jsonb_build_object('parameters', jsonb_build_object('mode',concat(spec->>'aspectRatio','/',spec->>'imageSize'))));
            END LOOP;
            cost := cost || jsonb_build_object('bands',mapped_cost_bands);
        END IF;
        -- Only the private cost rule uses the existing cost/overlap validator, with a constant valid sale.
        IF "canvas_saas"."image_spec_task_credits_core"(jsonb_build_object('schemaVersion',1,'cost',cost,'sale',
            '{"template":"image_request","currency":"credit","bands":[{"parameters":{"quality":"low"},"rates":{"request":"1"}}]}'::jsonb),
            '{"quality":"low","n":1,"output_format":"png"}') IS NULL THEN RETURN NULL; END IF;
    END IF;
    RETURN selected;
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
    IF source.capability_snapshot = 'video' OR source.billing_unit = 'video_specs' THEN
        IF source.capability_snapshot IS DISTINCT FROM 'video' OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible'
           OR source.billing_unit IS DISTINCT FROM 'video_specs' OR source.credits_per_unit IS NOT NULL
           OR source.rules->'video' IS DISTINCT FROM '{"schemaVersion":1,"protocol":"yunfei-grok-video-v1","usagePolicy":"delivered_video"}'::jsonb
           OR "canvas_saas"."video_spec_task_credits"(source.rules,
                "canvas_saas"."canonical_video_parameters"(source.rules->'sale'->'bands'->0->'parameters',true),
                jsonb_build_object('providerId',source.provider_id_snapshot,'providerModel',source.provider_model_snapshot,
                    'adapter',source.adapter_snapshot,'endpoint',source.endpoint_snapshot,'capability',source.capability_snapshot)) IS NULL
        THEN RAISE EXCEPTION 'Publication source does not match its video_specs price'; END IF;
        RETURN NEW;
    END IF;
    IF source.rules ? 'video' THEN RAISE EXCEPTION 'A non-video publication cannot carry a video policy'; END IF;
    IF source.rules->'sale'->>'template' = 'image_count' THEN
        IF source.billing_unit IS DISTINCT FROM 'image_specs' OR source.credits_per_unit IS NOT NULL
           OR source.capability_snapshot IS DISTINCT FROM 'image' OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible'
           OR "canvas_saas"."gemini_image_unit_price"(source.rules, source.provider_model_snapshot, source.endpoint_snapshot,
               source.rules->'sale'->'bands'->0->'parameters') IS NULL
        THEN RAISE EXCEPTION 'Invalid Gemini per-image publication'; END IF;
        RETURN NEW;
    END IF;
    IF source.billing_unit = 'image_specs' THEN
        IF source.adapter_snapshot IS DISTINCT FROM 'openai-compatible' OR source.capability_snapshot IS DISTINCT FROM 'image'
           OR source.credits_per_unit IS NOT NULL
           OR (source.rules ? 'derivation' AND source.rules->'derivation'->'binding' IS DISTINCT FROM jsonb_build_object(
                'providerId', source.provider_id_snapshot, 'providerModel', source.provider_model_snapshot,
                'adapter', source.adapter_snapshot, 'endpoint', source.endpoint_snapshot, 'capability', source.capability_snapshot))
           OR "canvas_saas"."image_spec_task_credits"(source.rules,
                (source.rules->'sale'->'bands'->0->'parameters') || '{"n":1,"output_format":"png"}'::jsonb
                    || CASE WHEN source.rules->'image' ? 'responseFormat'
                        THEN jsonb_build_object('response_format',source.rules->'image'->'responseFormat') ELSE '{}'::jsonb END) IS NULL
        THEN RAISE EXCEPTION 'Publication source does not match its image_specs price'; END IF;
        RETURN NEW;
    END IF;
    IF source.rules->'sale'->>'currency' IS DISTINCT FROM 'credit'
       OR jsonb_typeof(source.rules->'sale'->'bands') IS DISTINCT FROM 'array'
       OR jsonb_array_length(source.rules->'sale'->'bands') IS DISTINCT FROM 1
       OR source.rules->'sale'->'bands'->0->'parameters' IS DISTINCT FROM '{}'::jsonb
    THEN RAISE EXCEPTION 'Publication source does not match its price'; END IF;
    rates := source.rules->'sale'->'bands'->0->'rates';
    IF source.adapter_snapshot = 'openai-compatible' AND source.billing_unit = 'request'
       AND ((source.capability_snapshot = 'image' AND source.rules->'sale'->>'template' = 'image_request')
         OR (source.capability_snapshot = 'audio' AND source.rules->'sale'->>'template' = 'audio_request'
             AND jsonb_typeof(rates) = 'object' AND rates - 'request' = '{}'::jsonb
             AND jsonb_typeof(rates->'request') = 'string' AND rates->>'request' ~ '^[1-9][0-9]*$'
             AND source.credits_per_unit BETWEEN 1 AND 9007199254740991))
       AND rates->>'request' = source.credits_per_unit::text
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
    image_count numeric;
    video_credits bigint;
    video_quote jsonb;
    expected_video_quote jsonb;
    reference_snapshot jsonb;
    reference_row record;
    is_video boolean;
BEGIN
    SELECT publication.id, model.capability AS model_capability, price.version AS price_version, price.billing_unit, price.credits_per_unit, draft.rules, draft.capability_snapshot, draft.adapter_snapshot,
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
    video_quote := NEW.video_quote_snapshot;
    is_video := video_quote IS NOT NULL OR COALESCE(source.billing_unit = 'video_specs' OR source.capability_snapshot = 'video',false)
        OR EXISTS (SELECT 1 FROM "canvas_saas"."model_catalog" WHERE public_id=NEW.model_id AND capability='video');
    IF NEW.billing_unit_snapshot = 'image' OR NEW.parameter_snapshot->>'protocol' = 'gemini-generate-content-v1'
       OR source.rules->'sale'->>'template' = 'image_count' THEN
        image_credits := "canvas_saas"."gemini_image_unit_price"(source.rules, source.provider_model_snapshot, source.endpoint_snapshot,
            NEW.parameter_snapshot - 'protocol' - 'budgetCredits');
        IF is_video OR source.id IS NULL OR source.billing_unit IS DISTINCT FROM 'image_specs' OR source.model_capability IS DISTINCT FROM 'image'
           OR source.capability_snapshot IS DISTINCT FROM 'image' OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible'
           OR source.credits_per_unit IS NOT NULL OR quote IS NOT NULL OR image_credits IS NULL OR NEW.provider_task_id IS NOT NULL
           OR NEW.credits_per_unit_snapshot IS DISTINCT FROM image_credits OR NEW.billing_unit_snapshot IS DISTINCT FROM 'image'
           OR NEW.quoted_units IS NULL OR NEW.quoted_units < image_credits OR NEW.quoted_units > 9007199254740991
           OR NEW.parameter_snapshot->'protocol' IS DISTINCT FROM '"gemini-generate-content-v1"'::jsonb
           OR NEW.parameter_snapshot->'budgetCredits' IS DISTINCT FROM to_jsonb(NEW.quoted_units)
           OR jsonb_typeof(NEW.input_snapshot->'prompt') IS DISTINCT FROM 'string'
           OR NEW.input_snapshot IS DISTINCT FROM jsonb_build_object('prompt',NEW.input_snapshot->'prompt')
           OR NOT COALESCE(NEW.input_snapshot->>'prompt' ~ '[^[:space:]]',false)
        THEN RAISE EXCEPTION 'Gemini task requires its original published per-image price and budget'; END IF;
        NEW.price_publication_id := source.id;
        RETURN NEW;
    END IF;
    IF is_video THEN
        video_credits := "canvas_saas"."video_spec_task_credits"(source.rules,NEW.parameter_snapshot,
            jsonb_build_object('providerId',source.provider_id_snapshot,'providerModel',source.provider_model_snapshot,
                'adapter',source.adapter_snapshot,'endpoint',source.endpoint_snapshot,'capability',source.capability_snapshot));
        IF source.id IS NULL OR source.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR source.model_capability IS DISTINCT FROM 'video' OR source.capability_snapshot IS DISTINCT FROM 'video'
           OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible' OR source.billing_unit IS DISTINCT FROM 'video_specs'
           OR source.credits_per_unit IS NOT NULL OR quote IS NOT NULL OR video_credits IS NULL
           OR jsonb_typeof(video_quote) IS DISTINCT FROM 'object' OR NEW.provider_task_id IS NOT NULL
           OR ROW(NEW.billing_unit_snapshot,NEW.credits_per_unit_snapshot,NEW.quoted_units)
              IS DISTINCT FROM ROW('request'::text,video_credits,video_credits)
           OR jsonb_typeof(NEW.input_snapshot) IS DISTINCT FROM 'object'
           OR jsonb_typeof(NEW.input_snapshot->'prompt') IS DISTINCT FROM 'string'
           OR NOT COALESCE(NEW.input_snapshot->>'prompt' ~ '[^[:space:]]',false)
        THEN RAISE EXCEPTION 'Generation video task requires its exact published quote'; END IF;
        IF NEW.parameter_snapshot->>'mode' = 'first_frame' THEN
            reference_snapshot := video_quote->'referenceSnapshot';
            IF jsonb_typeof(reference_snapshot) IS DISTINCT FROM 'object'
               OR jsonb_typeof(reference_snapshot->'mediaId') IS DISTINCT FROM 'string'
               OR reference_snapshot->>'mediaId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN RAISE EXCEPTION 'Generation video reference is not a private media snapshot'; END IF;
            SELECT m.* INTO reference_row FROM "canvas_saas"."media_object" m
                WHERE m.id=reference_snapshot->>'mediaId' AND m.owner_id=NEW.owner_id FOR SHARE;
            IF NOT FOUND OR reference_row.kind IS DISTINCT FROM 'image'
               OR reference_row.etag !~ '^[0-9a-f]{64}$' OR reference_row.content_type !~ '^image/[a-z0-9.+-]+$'
               OR reference_row.size_bytes < 1 OR reference_row.size_bytes > 9007199254740991
               OR NEW.input_snapshot IS DISTINCT FROM jsonb_build_object('prompt',NEW.input_snapshot->'prompt','referenceMediaId',reference_row.id)
            THEN RAISE EXCEPTION 'Generation video reference owner or metadata does not match'; END IF;
            reference_snapshot := jsonb_build_object('mediaId',reference_row.id,'etag',reference_row.etag,'contentType',reference_row.content_type,'sizeBytes',reference_row.size_bytes);
        ELSE
            reference_snapshot := NULL;
            IF NEW.input_snapshot IS DISTINCT FROM jsonb_build_object('prompt',NEW.input_snapshot->'prompt')
            THEN RAISE EXCEPTION 'Text video input cannot carry a reference'; END IF;
        END IF;
        expected_video_quote := jsonb_build_object('schemaVersion',1,'protocol','yunfei-grok-video-v1','usagePolicy','delivered_video',
            'publicationId',source.id,'priceVersion',source.price_version,'selectedBand',jsonb_build_object('parameters',NEW.parameter_snapshot,'creditsPerVideo',video_credits),
            'quotedVideoUnits',1,'maxVideoUnits',1,'reservedCredits',video_credits)
            || CASE WHEN reference_snapshot IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('referenceSnapshot',reference_snapshot) END;
        IF video_quote IS DISTINCT FROM expected_video_quote THEN RAISE EXCEPTION 'Generation video quote fields are incomplete or inconsistent'; END IF;
    ELSE
    IF source.billing_unit = 'image_specs' THEN
        IF jsonb_typeof(NEW.parameter_snapshot->'n') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid image count'; END IF;
        image_count := (NEW.parameter_snapshot->>'n')::numeric;
        IF image_count < 1 OR image_count > 10 OR trunc(image_count) IS DISTINCT FROM image_count
           OR (image_count > 1 AND NOT COALESCE(source.provider_model_snapshot ~ '^(gpt-image-(1-mini|1\.5|2(-2026-04-21)?|2\.[56]-(sunburst|flare)(-[0-9]{4}-[0-9]{2}-[0-9]{2})?)|chatgpt-image-latest)$',false)
               AND NOT COALESCE(jsonb_typeof(source.rules->'image') = 'object'
                   AND source.rules->'image'->>'schemaVersion' = '1'
                   AND source.rules->'image'->>'protocol' = 'openai-image-v1'
                   AND jsonb_typeof(source.rules->'image'->'maxImagesPerRequest') = 'number'
                   AND source.rules->'image'->>'maxImagesPerRequest' ~ '^(10|[1-9])$',false))
        THEN RAISE EXCEPTION 'Unsupported image count for published model'; END IF;
        image_credits := "canvas_saas"."image_spec_task_credits"(source.rules, NEW.parameter_snapshot || '{"n":1}'::jsonb);
        IF source.id IS NULL OR source.capability_snapshot IS DISTINCT FROM 'image' OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible'
           OR source.credits_per_unit IS NOT NULL OR quote IS NOT NULL OR image_credits IS NULL
           OR image_credits::numeric * image_count > 9007199254740991
           OR (source.rules ? 'derivation' AND source.rules->'derivation'->'binding' IS DISTINCT FROM jsonb_build_object(
                'providerId', source.provider_id_snapshot, 'providerModel', source.provider_model_snapshot,
                'adapter', source.adapter_snapshot, 'endpoint', source.endpoint_snapshot, 'capability', source.capability_snapshot))
           OR ROW(NEW.billing_unit_snapshot, NEW.credits_per_unit_snapshot, NEW.quoted_units)
              IS DISTINCT FROM ROW('request'::text, image_credits, (image_credits::numeric * image_count)::bigint)
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
    END IF;
    NEW.price_publication_id := source.id;
    RETURN NEW;
END;
$$;
