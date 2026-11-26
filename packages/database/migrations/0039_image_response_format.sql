CREATE OR REPLACE FUNCTION "canvas_saas"."image_spec_task_credits"(rules jsonb, task_parameters jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE policy jsonb;
BEGIN
    IF task_parameters ? 'protocol' AND task_parameters->'protocol' IS DISTINCT FROM '"openai-image-v1"'::jsonb
    THEN RETURN NULL; END IF;
    IF rules ? 'image' THEN
        policy := rules->'image';
        IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
        IF NOT (policy ?& ARRAY['schemaVersion', 'protocol'])
           OR policy - 'schemaVersion' - 'protocol' - 'maxImagesPerRequest' - 'responseFormat' IS DISTINCT FROM '{}'::jsonb
           OR policy->'schemaVersion' IS DISTINCT FROM '1'::jsonb
           OR policy->'protocol' IS DISTINCT FROM '"openai-image-v1"'::jsonb
        THEN RETURN NULL; END IF;
        IF policy ? 'maxImagesPerRequest' THEN
            IF jsonb_typeof(policy->'maxImagesPerRequest') IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
            IF (policy->>'maxImagesPerRequest')::numeric < 1 OR (policy->>'maxImagesPerRequest')::numeric > 10
               OR trunc((policy->>'maxImagesPerRequest')::numeric) IS DISTINCT FROM (policy->>'maxImagesPerRequest')::numeric
            THEN RETURN NULL; END IF;
        END IF;
        IF policy ? 'responseFormat' AND policy->'responseFormat' IS DISTINCT FROM '"b64_json"'::jsonb
        THEN RETURN NULL; END IF;
    END IF;
    IF task_parameters->'response_format' IS DISTINCT FROM policy->'responseFormat'
    THEN RETURN NULL; END IF;
    RETURN "canvas_saas"."image_spec_task_credits_core"(rules - 'image', task_parameters - 'protocol' - 'response_format');
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
