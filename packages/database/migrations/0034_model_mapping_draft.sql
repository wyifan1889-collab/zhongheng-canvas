CREATE TABLE "canvas_saas"."model_mapping_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"document" jsonb DEFAULT '{"models":[],"bindings":[],"preferred":{},"prices":{},"specificationOptions":{"image":["1K","2K","4K"],"video":["480P","720P"]},"modelSpecifications":{}}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_mapping_draft_id" CHECK ("canvas_saas"."model_mapping_draft"."id" = 'catalog'),
	CONSTRAINT "model_mapping_draft_version" CHECK ("canvas_saas"."model_mapping_draft"."version" >= 0),
	CONSTRAINT "model_mapping_draft_object" CHECK (jsonb_typeof("canvas_saas"."model_mapping_draft"."document") = 'object')
);
--> statement-breakpoint
INSERT INTO "canvas_saas"."model_mapping_draft" ("id") VALUES ('catalog');
