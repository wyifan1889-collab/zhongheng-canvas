CREATE TABLE "canvas_saas"."model_mapping_publication" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"draft_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_mapping_publication_positive_version" CHECK ("canvas_saas"."model_mapping_publication"."version" > 0 AND "canvas_saas"."model_mapping_publication"."draft_version" >= 0),
	CONSTRAINT "model_mapping_publication_fingerprint" CHECK ("canvas_saas"."model_mapping_publication"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "model_mapping_publication_document" CHECK (jsonb_typeof("canvas_saas"."model_mapping_publication"."document") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_mapping_publication_version" ON "canvas_saas"."model_mapping_publication" USING btree ("version");
--> statement-breakpoint
CREATE TRIGGER "model_mapping_publication_append_only" BEFORE UPDATE OR DELETE ON "canvas_saas"."model_mapping_publication"
    FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."reject_model_price_draft_mutation"();
