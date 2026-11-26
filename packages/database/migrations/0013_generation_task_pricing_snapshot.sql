ALTER TABLE "canvas_saas"."generation_task" ADD COLUMN "billing_unit_snapshot" text;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD COLUMN "credits_per_unit_snapshot" bigint;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_billing_unit_snapshot" CHECK ("canvas_saas"."generation_task"."billing_unit_snapshot" IS NULL OR "canvas_saas"."generation_task"."billing_unit_snapshot" IN ('request', 'input_token', 'output_token', 'second', 'megapixel'));
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_credits_per_unit_snapshot" CHECK ("canvas_saas"."generation_task"."credits_per_unit_snapshot" IS NULL OR "canvas_saas"."generation_task"."credits_per_unit_snapshot" > 0);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_pricing_snapshot_pair" CHECK (("canvas_saas"."generation_task"."billing_unit_snapshot" IS NULL AND "canvas_saas"."generation_task"."credits_per_unit_snapshot" IS NULL) OR ("canvas_saas"."generation_task"."billing_unit_snapshot" IS NOT NULL AND "canvas_saas"."generation_task"."credits_per_unit_snapshot" IS NOT NULL));
