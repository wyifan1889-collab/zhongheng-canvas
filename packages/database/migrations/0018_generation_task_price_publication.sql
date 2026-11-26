ALTER TABLE "canvas_saas"."generation_task" ADD COLUMN "price_publication_id" text REFERENCES "canvas_saas"."model_price_publication"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."bind_generation_task_price_publication"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    source_id text;
    source_unit text;
    source_credits bigint;
BEGIN
    -- Resolve the confirmed historical version, not whichever price is active now.
    -- BEFORE INSERT also runs for an ON CONFLICT replay of an accepted old quote.
    SELECT publication.id, price.billing_unit, price.credits_per_unit
      INTO source_id, source_unit, source_credits
      FROM "canvas_saas"."model_price_publication" publication
      JOIN "canvas_saas"."model_pricing" price ON price.id = publication.pricing_id
      JOIN "canvas_saas"."model_catalog" model ON model.id = price.model_id
     WHERE model.public_id = NEW.model_id AND price.version = NEW.price_version;

    IF NEW.price_publication_id IS NOT NULL AND NEW.price_publication_id IS DISTINCT FROM source_id THEN
        RAISE EXCEPTION 'Generation task publication source does not match its confirmed price';
    END IF;
    IF source_id IS NOT NULL AND (
        source_unit IS DISTINCT FROM 'request' OR
        ROW(NEW.billing_unit_snapshot, NEW.credits_per_unit_snapshot, NEW.quoted_units)
            IS DISTINCT FROM ROW(source_unit, source_credits, source_credits)
    ) THEN
        RAISE EXCEPTION 'Generation task snapshot does not match its published single-request price';
    END IF;
    NEW.price_publication_id := source_id;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "generation_task_price_publication_insert" BEFORE INSERT ON "canvas_saas"."generation_task"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."bind_generation_task_price_publication"();
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."protect_generation_task_price_source"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(OLD.model_id, OLD.price_version, OLD.quoted_units, OLD.billing_unit_snapshot, OLD.credits_per_unit_snapshot, OLD.price_publication_id)
       IS DISTINCT FROM ROW(NEW.model_id, NEW.price_version, NEW.quoted_units, NEW.billing_unit_snapshot, NEW.credits_per_unit_snapshot, NEW.price_publication_id)
    THEN RAISE EXCEPTION 'Generation task price snapshot and publication source are immutable'; END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "generation_task_price_source_immutable" BEFORE UPDATE ON "canvas_saas"."generation_task"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."protect_generation_task_price_source"();
