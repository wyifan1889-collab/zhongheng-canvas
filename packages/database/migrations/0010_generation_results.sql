CREATE TABLE "canvas_saas"."generation_result" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text NOT NULL,
	"provider_status" integer,
	"provider_task_id" text,
	"result_snapshot" jsonb NOT NULL,
	"error_code" text,
	"unknown_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_result_status" CHECK ("canvas_saas"."generation_result"."status" IN ('succeeded', 'failed', 'unknown')),
	CONSTRAINT "generation_result_provider_status" CHECK ("canvas_saas"."generation_result"."provider_status" IS NULL OR ("canvas_saas"."generation_result"."provider_status" >= 100 AND "canvas_saas"."generation_result"."provider_status" <= 599)),
	CONSTRAINT "generation_result_snapshot_object" CHECK (jsonb_typeof("canvas_saas"."generation_result"."result_snapshot") = 'object'),
	CONSTRAINT "generation_result_failed_code" CHECK ("canvas_saas"."generation_result"."status" <> 'failed' OR ("canvas_saas"."generation_result"."error_code" IS NOT NULL AND length(trim("canvas_saas"."generation_result"."error_code")) > 0)),
	CONSTRAINT "generation_result_unknown_reason" CHECK ("canvas_saas"."generation_result"."status" <> 'unknown' OR ("canvas_saas"."generation_result"."unknown_reason" IS NOT NULL AND length(trim("canvas_saas"."generation_result"."unknown_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_result" ADD CONSTRAINT "generation_result_task_id_generation_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "canvas_saas"."generation_task"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_result" ADD CONSTRAINT "generation_result_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_result_task_id_unique" ON "canvas_saas"."generation_result" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "generation_result_owner_created" ON "canvas_saas"."generation_result" USING btree ("owner_id","created_at");
