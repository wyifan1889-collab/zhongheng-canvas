ALTER TABLE "canvas_saas"."generation_result" ADD COLUMN "consumed_units" bigint;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_result" ADD CONSTRAINT "generation_result_consumed_units" CHECK ("canvas_saas"."generation_result"."consumed_units" IS NULL OR "canvas_saas"."generation_result"."consumed_units" >= 0);
