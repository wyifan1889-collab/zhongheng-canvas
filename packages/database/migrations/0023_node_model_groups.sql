CREATE TABLE "canvas_saas"."model_node_groups" (
    "capability" text PRIMARY KEY NOT NULL,
    "version" integer DEFAULT 0 NOT NULL,
    "groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "model_node_groups_capability" CHECK (capability IN ('text', 'image', 'video')),
    CONSTRAINT "model_node_groups_version" CHECK (version >= 0),
    CONSTRAINT "model_node_groups_array" CHECK (jsonb_typeof(groups) = 'array')
);
--> statement-breakpoint
INSERT INTO "canvas_saas"."model_node_groups" ("capability") VALUES ('text'), ('image'), ('video');
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_catalog" ADD COLUMN "group_id" text;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_catalog" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_catalog" ADD CONSTRAINT "model_catalog_revision" CHECK (revision > 0);
