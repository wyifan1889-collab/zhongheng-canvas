CREATE TABLE "canvas_saas"."model_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"version" integer NOT NULL,
	"billing_unit" text NOT NULL,
	"credits_per_unit" bigint NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_pricing_version" CHECK ("canvas_saas"."model_pricing"."version" > 0),
	CONSTRAINT "model_pricing_billing_unit" CHECK ("canvas_saas"."model_pricing"."billing_unit" IN ('request', 'input_token', 'output_token', 'second', 'megapixel')),
	CONSTRAINT "model_pricing_credits_positive" CHECK ("canvas_saas"."model_pricing"."credits_per_unit" > 0),
	CONSTRAINT "model_pricing_effective_range" CHECK ("canvas_saas"."model_pricing"."effective_to" IS NULL OR "canvas_saas"."model_pricing"."effective_to" > "canvas_saas"."model_pricing"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" ADD CONSTRAINT "model_pricing_model_id_model_catalog_id_fk" FOREIGN KEY ("model_id") REFERENCES "canvas_saas"."model_catalog"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "model_pricing_model_version_unique" ON "canvas_saas"."model_pricing" USING btree ("model_id","version");
--> statement-breakpoint
CREATE INDEX "model_pricing_active_lookup" ON "canvas_saas"."model_pricing" USING btree ("model_id","enabled","effective_from");
