ALTER TABLE "canvas_saas"."model_provider" ADD COLUMN "deleted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_catalog" ADD COLUMN "deleted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_provider" ADD CONSTRAINT "model_provider_deleted_disabled" CHECK ("deleted_at" IS NULL OR NOT "enabled");
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_catalog" ADD CONSTRAINT "model_catalog_deleted_disabled" CHECK ("deleted_at" IS NULL OR NOT "enabled");
--> statement-breakpoint
DROP INDEX "canvas_saas"."model_catalog_provider_model_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "model_catalog_provider_model_unique" ON "canvas_saas"."model_catalog" ("provider_id", "provider_model") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "generation_task_model" ON "canvas_saas"."generation_task" ("model_id");
