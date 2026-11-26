-- Approved V1 video source and durable phase binding; preserves the existing image/text/audio branches.
-- Saved predicate values are strings. Normalize duration before overlap tests.
CREATE FUNCTION "canvas_saas"."video_price_parameters"(input_parameters jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item record; amount text; normalized jsonb := input_parameters;
BEGIN
    IF jsonb_typeof(input_parameters) IS DISTINCT FROM 'object'
       OR input_parameters - ARRAY['mode','resolution','durationSeconds','generateAudio','aspectRatio'] IS DISTINCT FROM '{}'::jsonb
    THEN RETURN NULL; END IF;
    FOR item IN SELECT e.key, e.value FROM jsonb_each(input_parameters) e LOOP
        amount := item.value #>> '{}';
        IF jsonb_typeof(item.value) IS DISTINCT FROM 'string' OR amount = ''
           OR amount ~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]' THEN RETURN NULL; END IF;
        IF item.key = 'durationSeconds' THEN
            IF amount !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
               OR length(split_part(amount,'.',1)) > 131072 OR length(rtrim(split_part(amount,'.',2),'0')) > 16383
            THEN RETURN NULL; END IF;
            amount := split_part(amount,'.',1) || CASE WHEN rtrim(split_part(amount,'.',2),'0') = '' THEN '' ELSE '.' || rtrim(split_part(amount,'.',2),'0') END;
            IF amount = '0' THEN RETURN NULL; END IF;
            normalized := normalized || jsonb_build_object(item.key, amount);
        END IF;
    END LOOP;
    RETURN normalized;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."canonical_video_parameters"(value jsonb, saved_strings boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE p jsonb := value; duration numeric; audio boolean;
BEGIN
    IF saved_strings THEN p := "canvas_saas"."video_price_parameters"(p); END IF;
    IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT (p ?& ARRAY['mode','resolution','durationSeconds','generateAudio'])
       OR p->'mode' NOT IN ('"text"'::jsonb, '"first_frame"'::jsonb)
       OR p->'resolution' NOT IN ('"480p"'::jsonb, '"720p"'::jsonb, '"1080p"'::jsonb)
    THEN RETURN NULL; END IF;
    IF p->>'mode' = 'text' THEN
        IF NOT (p ? 'aspectRatio') OR p - ARRAY['mode','resolution','durationSeconds','generateAudio','aspectRatio'] IS DISTINCT FROM '{}'::jsonb
           OR p->'aspectRatio' NOT IN ('"1:1"'::jsonb,'"16:9"'::jsonb,'"9:16"'::jsonb,'"4:3"'::jsonb,'"3:4"'::jsonb,'"3:2"'::jsonb,'"2:3"'::jsonb)
        THEN RETURN NULL; END IF;
    ELSIF p - ARRAY['mode','resolution','durationSeconds','generateAudio'] IS DISTINCT FROM '{}'::jsonb THEN RETURN NULL;
    END IF;
    IF saved_strings THEN
        IF jsonb_typeof(p->'durationSeconds') IS DISTINCT FROM 'string' OR p->>'durationSeconds' !~ '^[1-9][0-9]*$'
           OR length(p->>'durationSeconds') > 2 OR p->'generateAudio' NOT IN ('"true"'::jsonb,'"false"'::jsonb)
        THEN RETURN NULL; END IF;
        audio := p->>'generateAudio' = 'true';
    ELSE
        IF jsonb_typeof(p->'durationSeconds') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'generateAudio') IS DISTINCT FROM 'boolean'
        THEN RETURN NULL; END IF;
        audio := (p->>'generateAudio')::boolean;
    END IF;
    duration := (p->>'durationSeconds')::numeric;
    IF duration < 1 OR duration > 15 OR trunc(duration) IS DISTINCT FROM duration THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('mode',p->>'mode','resolution',p->>'resolution','durationSeconds',duration::integer,'generateAudio',audio)
        || CASE WHEN p->>'mode' = 'text' THEN jsonb_build_object('aspectRatio',p->>'aspectRatio') ELSE '{}'::jsonb END;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Narrow executable profile, following image_spec_task_credits' existing
-- private cost/derivation checks; no new price evaluator or billing policy.
CREATE FUNCTION "canvas_saas"."video_spec_task_credits"(rules jsonb, task_parameters jsonb, binding jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    derivation jsonb; basis jsonb; source jsonb; checked_rule jsonb; rule_index integer;
    band jsonb; parameters jsonb; canonical jsonb; prior jsonb; seen jsonb; normalized_bands jsonb;
    normalized_rules jsonb := '[]'::jsonb; rates jsonb; meter text; amount text; factor_name text;
    factors numeric[] := ARRAY[]::numeric[]; selected bigint := NULL; matches integer := 0; band_index integer;
BEGIN
    IF jsonb_typeof(rules) IS DISTINCT FROM 'object' OR NOT (rules ?& ARRAY['schemaVersion','cost','sale','video'])
       OR rules - ARRAY['schemaVersion','cost','sale','video','derivation'] IS DISTINCT FROM '{}'::jsonb
       OR rules->'schemaVersion' IS DISTINCT FROM '1'::jsonb
       OR rules->'video' IS DISTINCT FROM '{"schemaVersion":1,"protocol":"yunfei-grok-video-v1","usagePolicy":"delivered_video"}'::jsonb
       OR "canvas_saas"."canonical_video_parameters"(task_parameters) IS NULL
       OR binding->>'capability' IS DISTINCT FROM 'video' OR binding->>'adapter' IS DISTINCT FROM 'openai-compatible'
       OR NOT COALESCE(binding->>'endpoint' ~ '^[Hh][Tt][Tt][Pp][Ss]://[^/?#@[:space:]]+(/[^?#]*)?/v1/?[?]?[#]?$', false)
    THEN RETURN NULL; END IF;
    FOREACH meter IN ARRAY ARRAY['providerId','providerModel','endpoint'] LOOP
        IF jsonb_typeof(binding->meter) IS DISTINCT FROM 'string' OR binding->>meter = ''
           OR binding->>meter ~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]' THEN RETURN NULL; END IF;
    END LOOP;
    IF rules ? 'derivation' THEN
        derivation := rules->'derivation';
        IF jsonb_typeof(derivation) IS DISTINCT FROM 'object'
           OR NOT (derivation ?& ARRAY['schemaVersion','kind','binding','basis','costMultiplier','saleMultiplier','creditsPerCurrency','source'])
           OR derivation - ARRAY['schemaVersion','kind','binding','basis','costMultiplier','saleMultiplier','creditsPerCurrency','source'] IS DISTINCT FROM '{}'::jsonb
           OR derivation->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR derivation->>'kind' IS DISTINCT FROM 'multiplier'
           OR derivation->'binding' IS DISTINCT FROM binding OR jsonb_typeof(derivation->'basis') IS DISTINCT FROM 'object'
        THEN RETURN NULL; END IF;
        basis := derivation->'basis'; source := derivation->'source';
        IF jsonb_typeof(source) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
        IF source->'kind' = '"custom"'::jsonb THEN
            IF source - 'kind' IS DISTINCT FROM '{}'::jsonb THEN RETURN NULL; END IF;
        ELSIF source->'kind' = '"saved_cost"'::jsonb THEN
            IF NOT (source ?& ARRAY['kind','draftId','draftVersion']) OR source - ARRAY['kind','draftId','draftVersion'] IS DISTINCT FROM '{}'::jsonb
               OR jsonb_typeof(source->'draftId') IS DISTINCT FROM 'string'
               OR source->>'draftId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               OR jsonb_typeof(source->'draftVersion') IS DISTINCT FROM 'number'
            THEN RETURN NULL; END IF;
            IF (source->>'draftVersion')::numeric < 1 OR (source->>'draftVersion')::numeric > 9007199254740991
               OR trunc((source->>'draftVersion')::numeric) IS DISTINCT FROM (source->>'draftVersion')::numeric THEN RETURN NULL; END IF;
        ELSE RETURN NULL; END IF;
        FOREACH factor_name IN ARRAY ARRAY['costMultiplier','saleMultiplier','creditsPerCurrency'] LOOP
            IF factor_name = 'costMultiplier' AND derivation->factor_name = 'null'::jsonb THEN factors := array_append(factors,NULL::numeric); CONTINUE; END IF;
            amount := derivation->>factor_name;
            IF jsonb_typeof(derivation->factor_name) IS DISTINCT FROM 'string' OR amount !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
               OR length(split_part(amount,'.',1)) > 131072 OR length(rtrim(split_part(amount,'.',2),'0')) > 16383 THEN RETURN NULL; END IF;
            IF factor_name <> 'costMultiplier' AND amount::numeric = 0 THEN RETURN NULL; END IF;
            factors := array_append(factors,amount::numeric);
        END LOOP;
    END IF;
    -- Cost can be video_second or video_count; only the sale is delivered video_count.
    FOR rule_index IN 0..2 LOOP
        checked_rule := CASE rule_index WHEN 0 THEN rules->'cost' WHEN 1 THEN COALESCE(basis,'null'::jsonb) ELSE rules->'sale' END;
        IF checked_rule = 'null'::jsonb AND rule_index < 2 THEN normalized_rules := normalized_rules || jsonb_build_array(NULL); CONTINUE; END IF;
        IF jsonb_typeof(checked_rule) IS DISTINCT FROM 'object' OR NOT (checked_rule ?& ARRAY['template','currency','bands'])
           OR checked_rule - ARRAY['template','currency','bands'] IS DISTINCT FROM '{}'::jsonb
           OR jsonb_typeof(checked_rule->'bands') IS DISTINCT FROM 'array'
           OR (rule_index < 2 AND NOT COALESCE(checked_rule->>'currency' IN ('CNY','USD'),false))
           OR (rule_index = 2 AND (checked_rule->>'currency' IS DISTINCT FROM 'credit' OR checked_rule->>'template' IS DISTINCT FROM 'video_count'))
        THEN RETURN NULL; END IF;
        meter := CASE checked_rule->>'template' WHEN 'video_count' THEN 'video' WHEN 'video_second' THEN 'second' ELSE NULL END;
        IF meter IS NULL OR jsonb_array_length(checked_rule->'bands') = 0 THEN RETURN NULL; END IF;
        normalized_bands := '[]'::jsonb; seen := '[]'::jsonb;
        FOR band IN SELECT value FROM jsonb_array_elements(checked_rule->'bands') LOOP
            IF jsonb_typeof(band) IS DISTINCT FROM 'object' OR NOT (band ?& ARRAY['parameters','rates'])
               OR band - ARRAY['parameters','rates'] IS DISTINCT FROM '{}'::jsonb OR jsonb_typeof(band->'rates') IS DISTINCT FROM 'object'
               OR NOT (band->'rates' ? meter) OR (band->'rates') - meter IS DISTINCT FROM '{}'::jsonb THEN RETURN NULL; END IF;
            parameters := "canvas_saas"."video_price_parameters"(band->'parameters');
            IF parameters IS NULL THEN RETURN NULL; END IF;
            FOR prior IN SELECT value FROM jsonb_array_elements(seen) LOOP
                IF NOT EXISTS (SELECT 1 FROM jsonb_each(parameters) a JOIN jsonb_each(prior) b ON a.key=b.key WHERE a.value IS DISTINCT FROM b.value)
                THEN RETURN NULL; END IF;
            END LOOP;
            seen := seen || jsonb_build_array(parameters);
            IF rule_index = 0 AND band->'rates'->meter = 'null'::jsonb THEN rates := jsonb_build_object(meter,NULL);
            ELSE
                amount := band->'rates'->>meter;
                IF jsonb_typeof(band->'rates'->meter) IS DISTINCT FROM 'string' OR amount !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
                   OR length(split_part(amount,'.',1)) > 131072 OR length(rtrim(split_part(amount,'.',2),'0')) > 16383 THEN RETURN NULL; END IF;
                amount := split_part(amount,'.',1) || CASE WHEN rtrim(split_part(amount,'.',2),'0') = '' THEN '' ELSE '.' || rtrim(split_part(amount,'.',2),'0') END;
                rates := jsonb_build_object(meter,amount);
            END IF;
            IF rule_index = 2 THEN
                canonical := "canvas_saas"."canonical_video_parameters"(parameters,true);
                IF canonical IS NULL OR amount !~ '^[1-9][0-9]*$' OR length(amount) > 16 THEN RETURN NULL; END IF;
                IF amount::numeric > 9007199254740991 THEN RETURN NULL; END IF;
                IF canonical = task_parameters THEN selected := amount::bigint; matches := matches+1; END IF;
            END IF;
            normalized_bands := normalized_bands || jsonb_build_array(jsonb_build_object('parameters',parameters,'rates',rates));
        END LOOP;
        normalized_rules := normalized_rules || jsonb_build_array(jsonb_build_object('template',checked_rule->>'template','currency',checked_rule->>'currency','bands',normalized_bands));
    END LOOP;
    IF derivation IS NOT NULL THEN
        basis := normalized_rules->1;
        IF basis->>'template' IS DISTINCT FROM 'video_count'
           OR jsonb_array_length(basis->'bands') IS DISTINCT FROM jsonb_array_length(normalized_rules->2->'bands')
           OR ((factors[1] IS NULL) IS DISTINCT FROM (rules->'cost' = 'null'::jsonb)) THEN RETURN NULL; END IF;
        IF factors[1] IS NOT NULL AND (normalized_rules->0->>'template' IS DISTINCT FROM basis->>'template'
           OR normalized_rules->0->>'currency' IS DISTINCT FROM basis->>'currency'
           OR jsonb_array_length(normalized_rules->0->'bands') IS DISTINCT FROM jsonb_array_length(basis->'bands')) THEN RETURN NULL; END IF;
        FOR band_index IN 0..jsonb_array_length(basis->'bands')-1 LOOP
            band := basis->'bands'->band_index;
            IF band->'parameters' IS DISTINCT FROM normalized_rules->2->'bands'->band_index->'parameters'
               OR (band->'rates'->>'video')::numeric*factors[2]*factors[3] IS DISTINCT FROM (normalized_rules->2->'bands'->band_index->'rates'->>'video')::numeric THEN RETURN NULL; END IF;
            IF factors[1] IS NOT NULL AND (normalized_rules->0->'bands'->band_index->'parameters' IS DISTINCT FROM band->'parameters'
               OR jsonb_typeof(normalized_rules->0->'bands'->band_index->'rates'->'video') IS DISTINCT FROM 'string'
               OR (band->'rates'->>'video')::numeric*factors[1] IS DISTINCT FROM (normalized_rules->0->'bands'->band_index->'rates'->>'video')::numeric) THEN RETURN NULL; END IF;
        END LOOP;
    END IF;
    RETURN CASE WHEN matches = 1 THEN selected ELSE NULL END;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
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
    video_credits bigint;
    video_quote jsonb;
    expected_video_quote jsonb;
    reference_snapshot jsonb;
    reference_row record;
    is_video boolean;
BEGIN
    -- Start from the historical price, so an image_specs row with a missing publication cannot become legacy.
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
    END IF;
    NEW.price_publication_id := source.id;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "canvas_saas"."protect_generation_task_price_source"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.id, OLD.owner_id, OLD.idempotency_key, OLD.request_id, OLD.model_id, OLD.input_snapshot, OLD.parameter_snapshot,
           OLD.space_id, OLD.project_id, OLD.node_id, OLD.price_version, OLD.quoted_units, OLD.billing_unit_snapshot,
           OLD.credits_per_unit_snapshot, OLD.price_publication_id, OLD.text_quote_snapshot, OLD.video_quote_snapshot, OLD.created_at)
       IS DISTINCT FROM
       ROW(NEW.id, NEW.owner_id, NEW.idempotency_key, NEW.request_id, NEW.model_id, NEW.input_snapshot, NEW.parameter_snapshot,
           NEW.space_id, NEW.project_id, NEW.node_id, NEW.price_version, NEW.quoted_units, NEW.billing_unit_snapshot,
           NEW.credits_per_unit_snapshot, NEW.price_publication_id, NEW.text_quote_snapshot, NEW.video_quote_snapshot, NEW.created_at)
    THEN RAISE EXCEPTION 'Generation task identity, intent, price snapshot and publication source are immutable'; END IF;
    IF OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    THEN RAISE EXCEPTION 'Generation task reservation binding is immutable once set'; END IF;
    IF NEW.video_quote_snapshot IS NOT NULL THEN
        IF OLD.provider_task_id IS NOT NULL AND NEW.provider_task_id IS DISTINCT FROM OLD.provider_task_id
        THEN RAISE EXCEPTION 'Video provider task identity is immutable once bound'; END IF;
        IF NEW.provider_task_id IS NOT NULL AND (length(NEW.provider_task_id) NOT BETWEEN 1 AND 200
           OR NEW.provider_task_id IN ('.','..') OR NEW.provider_task_id <> btrim(NEW.provider_task_id)
           OR NEW.provider_task_id ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'Invalid video provider task identity'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Parent and attachment can bind their provider ID in either statement order.
-- Only the final transaction state is compared by the constraint triggers.
CREATE FUNCTION "canvas_saas"."protect_generation_video_stage"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Direct delete/reinsert must not erase a spent create token. Parent deletion still cascades.
        IF EXISTS (SELECT 1 FROM "canvas_saas"."generation_task" WHERE id=OLD.task_id)
        THEN RAISE EXCEPTION 'Video execution attachment cannot be deleted while its task exists'; END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF ROW(OLD.task_id,OLD.owner_id,OLD.protocol,OLD.provider_id,OLD.endpoint,OLD.provider_model,OLD.price_publication_id,OLD.parameters_snapshot,OLD.created_at)
           IS DISTINCT FROM ROW(NEW.task_id,NEW.owner_id,NEW.protocol,NEW.provider_id,NEW.endpoint,NEW.provider_model,NEW.price_publication_id,NEW.parameters_snapshot,NEW.created_at)
        THEN RAISE EXCEPTION 'Video attachment identity and source are immutable'; END IF;
        IF OLD.create_attempt_token IS NOT NULL AND ROW(NEW.create_attempt_token,NEW.create_started_at) IS DISTINCT FROM ROW(OLD.create_attempt_token,OLD.create_started_at)
        THEN RAISE EXCEPTION 'Video create authorization is immutable once written'; END IF;
        IF OLD.create_attempt_token IS NULL AND NEW.create_attempt_token IS NOT NULL
           AND (OLD.phase IS DISTINCT FROM 'ready' OR NEW.phase IS DISTINCT FROM 'create_started')
        THEN RAISE EXCEPTION 'Video create authorization requires the original ready transition'; END IF;
        IF NEW.phase = 'ready' AND OLD.phase IS DISTINCT FROM 'ready'
        THEN RAISE EXCEPTION 'Video execution cannot return to a new create'; END IF;
        IF OLD.provider_task_id IS NOT NULL AND NEW.provider_task_id IS DISTINCT FROM OLD.provider_task_id
        THEN RAISE EXCEPTION 'Video attachment provider identity is immutable once bound'; END IF;
        IF NEW.revision::bigint IS DISTINCT FROM OLD.revision::bigint+1
        THEN RAISE EXCEPTION 'Video attachment update requires its next revision'; END IF;
    ELSIF NEW.phase IS DISTINCT FROM 'ready' OR NEW.revision IS DISTINCT FROM 0
       OR NEW.create_attempt_token IS NOT NULL OR NEW.create_started_at IS NOT NULL OR NEW.provider_task_id IS NOT NULL
    THEN RAISE EXCEPTION 'Video attachment must begin without create authorization'; END IF;
    IF NEW.create_attempt_token IS NOT NULL AND (NEW.create_attempt_token = '' OR NEW.create_attempt_token <> btrim(NEW.create_attempt_token)
       OR NEW.create_attempt_token ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'Invalid video create token'; END IF;
    IF NEW.provider_task_id IS NOT NULL AND (NEW.create_attempt_token IS NULL OR NEW.provider_task_id <> btrim(NEW.provider_task_id)
       OR NEW.phase IN ('ready','rejected')) THEN RAISE EXCEPTION 'Video identity requires the original create authorization'; END IF;
    SELECT t.owner_id,t.parameter_snapshot,t.video_quote_snapshot,t.price_publication_id,
           d.provider_id_snapshot,d.provider_model_snapshot,d.endpoint_snapshot,d.adapter_snapshot,d.capability_snapshot
      INTO source FROM "canvas_saas"."generation_task" t
      JOIN "canvas_saas"."model_price_publication" p ON p.id=t.price_publication_id
      JOIN "canvas_saas"."model_price_draft" d ON d.id=p.draft_id
     WHERE t.id=NEW.task_id FOR KEY SHARE OF t;
    IF NOT FOUND OR source.video_quote_snapshot IS NULL OR source.owner_id IS DISTINCT FROM NEW.owner_id
       OR NEW.protocol IS DISTINCT FROM 'yunfei-grok-video-v1' OR source.adapter_snapshot IS DISTINCT FROM 'openai-compatible'
       OR source.capability_snapshot IS DISTINCT FROM 'video' OR NEW.price_publication_id IS DISTINCT FROM source.price_publication_id
       OR NEW.provider_id IS DISTINCT FROM source.provider_id_snapshot OR NEW.provider_model IS DISTINCT FROM source.provider_model_snapshot
       OR NEW.endpoint IS DISTINCT FROM source.endpoint_snapshot OR NEW.parameters_snapshot IS DISTINCT FROM source.parameter_snapshot
       OR NEW.parameters_snapshot IS DISTINCT FROM source.video_quote_snapshot->'selectedBand'->'parameters'
       OR "canvas_saas"."canonical_video_parameters"(NEW.parameters_snapshot) IS NULL
    THEN RAISE EXCEPTION 'Video attachment does not match its task owner, source and parameters'; END IF;
    -- Probe fields remain owned by V1: 0029 only requires an object, not guessed keys.
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "generation_video_stage_immutable"
    BEFORE INSERT OR UPDATE OR DELETE ON "canvas_saas"."generation_video_stage"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."protect_generation_video_stage"();
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."check_generation_video_stage_final"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_task_id text; task_row record; stage_row record; result_row record;
BEGIN
    IF TG_TABLE_NAME = 'generation_task' THEN checked_task_id := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN checked_task_id := OLD.task_id;
    ELSE checked_task_id := NEW.task_id;
    END IF;
    SELECT t.* INTO task_row FROM "canvas_saas"."generation_task" t WHERE t.id=checked_task_id;
    IF NOT FOUND THEN RETURN NULL; END IF; -- Parent deletion / its attachment cascade.
    SELECT s.* INTO stage_row FROM "canvas_saas"."generation_video_stage" s WHERE s.task_id=checked_task_id;
    IF task_row.video_quote_snapshot IS NULL THEN
        IF FOUND THEN RAISE EXCEPTION 'A non-video task cannot own a video attachment'; END IF;
        RETURN NULL;
    END IF;
    IF NOT FOUND OR stage_row.owner_id IS DISTINCT FROM task_row.owner_id
       OR stage_row.price_publication_id IS DISTINCT FROM task_row.price_publication_id
       OR stage_row.parameters_snapshot IS DISTINCT FROM task_row.parameter_snapshot
       OR stage_row.provider_task_id IS DISTINCT FROM task_row.provider_task_id
       OR (stage_row.provider_task_id IS NOT NULL AND (stage_row.create_attempt_token IS NULL OR stage_row.create_started_at IS NULL))
    THEN RAISE EXCEPTION 'Video task and attachment must commit one matching provider identity'; END IF;
    SELECT r.* INTO result_row FROM "canvas_saas"."generation_result" r WHERE r.task_id=checked_task_id;
    IF FOUND THEN
        IF result_row.owner_id IS DISTINCT FROM task_row.owner_id OR result_row.provider_task_id IS DISTINCT FROM stage_row.provider_task_id
           OR result_row.status = 'unknown'
           OR (result_row.status = 'succeeded' AND (stage_row.phase IS DISTINCT FROM 'completed' OR task_row.execution_status IS DISTINCT FROM 'succeeded'))
           OR (result_row.status = 'failed' AND (stage_row.phase NOT IN ('failed','rejected') OR task_row.execution_status IS DISTINCT FROM 'failed'))
        THEN RAISE EXCEPTION 'Video terminal result must match its original task and stage'; END IF;
    ELSIF stage_row.phase IN ('completed','failed','rejected') THEN
        RAISE EXCEPTION 'A terminal video stage requires its matching terminal result';
    END IF;
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "generation_task_video_stage_final"
    AFTER INSERT OR UPDATE ON "canvas_saas"."generation_task"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION "canvas_saas"."check_generation_video_stage_final"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "generation_video_stage_task_final"
    AFTER INSERT OR UPDATE OR DELETE ON "canvas_saas"."generation_video_stage"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION "canvas_saas"."check_generation_video_stage_final"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "generation_video_result_final"
    AFTER INSERT OR UPDATE OR DELETE ON "canvas_saas"."generation_result"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION "canvas_saas"."check_generation_video_stage_final"();
--> statement-breakpoint
