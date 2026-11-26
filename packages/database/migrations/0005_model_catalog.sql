CREATE TABLE "canvas_saas"."model_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"adapter" text NOT NULL,
	"endpoint" text NOT NULL,
	"secret_ref" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_provider_adapter" CHECK ("canvas_saas"."model_provider"."adapter" IN ('openai-compatible', 'sub2api')),
	CONSTRAINT "model_provider_secret_ref" CHECK (length(trim("canvas_saas"."model_provider"."secret_ref")) > 0)
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."model_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"public_id" text NOT NULL,
	"provider_model" text NOT NULL,
	"display_name" text NOT NULL,
	"capability" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_capability" CHECK ("canvas_saas"."model_catalog"."capability" IN ('text', 'image', 'video', 'audio')),
	CONSTRAINT "model_catalog_public_id" CHECK (length(trim("canvas_saas"."model_catalog"."public_id")) > 0),
	CONSTRAINT "model_catalog_provider_model" CHECK (length(trim("canvas_saas"."model_catalog"."provider_model")) > 0)
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_catalog" ADD CONSTRAINT "model_catalog_provider_id_model_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "canvas_saas"."model_provider"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "model_catalog_public_id_unique" ON "canvas_saas"."model_catalog" USING btree ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "model_catalog_provider_model_unique" ON "canvas_saas"."model_catalog" USING btree ("provider_id","provider_model");
--> statement-breakpoint
CREATE INDEX "model_catalog_enabled_capability" ON "canvas_saas"."model_catalog" USING btree ("enabled","capability");
