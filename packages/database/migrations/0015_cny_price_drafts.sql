CREATE TABLE "canvas_saas"."cny_price_draft" (
    "id" text PRIMARY KEY NOT NULL,
    "model_id" text NOT NULL REFERENCES "canvas_saas"."model_catalog"("id") ON DELETE restrict,
    "version" integer NOT NULL,
    "currency" text DEFAULT 'CNY' NOT NULL,
    "billing_unit" text DEFAULT 'request' NOT NULL,
    "cost_amount" numeric,
    "sale_amount" numeric NOT NULL,
    "price_note" text NOT NULL,
    "provider_id_snapshot" text NOT NULL,
    "provider_model_snapshot" text NOT NULL,
    "adapter_snapshot" text NOT NULL,
    "endpoint_snapshot" text NOT NULL,
    "capability_snapshot" text DEFAULT 'image' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "cny_price_draft_version" CHECK ("version" > 0),
    CONSTRAINT "cny_price_draft_currency" CHECK ("currency" = 'CNY'),
    CONSTRAINT "cny_price_draft_billing_unit" CHECK ("billing_unit" = 'request'),
    CONSTRAINT "cny_price_draft_cost_amount" CHECK ("cost_amount" IS NULL OR ("cost_amount" >= 0 AND "cost_amount"::text NOT IN ('NaN', 'Infinity', '-Infinity'))),
    CONSTRAINT "cny_price_draft_sale_amount" CHECK ("sale_amount" >= 0 AND "sale_amount"::text NOT IN ('NaN', 'Infinity', '-Infinity')),
    CONSTRAINT "cny_price_draft_adapter" CHECK ("adapter_snapshot" IN ('openai-compatible', 'sub2api')),
    CONSTRAINT "cny_price_draft_capability" CHECK ("capability_snapshot" = 'image')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cny_price_draft_model_version_unique" ON "canvas_saas"."cny_price_draft" ("model_id", "version");
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."reject_cny_price_draft_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'CNY price drafts are append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "cny_price_draft_append_only" BEFORE UPDATE OR DELETE ON "canvas_saas"."cny_price_draft"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."reject_cny_price_draft_mutation"();
