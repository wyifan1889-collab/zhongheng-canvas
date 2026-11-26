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
           OR policy - 'schemaVersion' - 'protocol' - 'maxImagesPerRequest' IS DISTINCT FROM '{}'::jsonb
           OR policy->'schemaVersion' IS DISTINCT FROM '1'::jsonb
           OR policy->'protocol' IS DISTINCT FROM '"openai-image-v1"'::jsonb
        THEN RETURN NULL; END IF;
        IF policy ? 'maxImagesPerRequest' THEN
            IF jsonb_typeof(policy->'maxImagesPerRequest') IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
            IF (policy->>'maxImagesPerRequest')::numeric < 1 OR (policy->>'maxImagesPerRequest')::numeric > 10
               OR trunc((policy->>'maxImagesPerRequest')::numeric) IS DISTINCT FROM (policy->>'maxImagesPerRequest')::numeric
            THEN RETURN NULL; END IF;
        END IF;
    END IF;
    RETURN "canvas_saas"."image_spec_task_credits_core"(rules - 'image', task_parameters - 'protocol');
END;
$$;
