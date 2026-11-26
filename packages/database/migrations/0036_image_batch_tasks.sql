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
