CREATE TABLE "canvas_saas"."generation_task" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"space_id" text,
	"project_id" text,
	"node_id" text,
	"input_snapshot" jsonb NOT NULL,
	"model_id" text NOT NULL,
	"parameter_snapshot" jsonb NOT NULL,
	"price_version" integer,
	"quoted_units" bigint,
	"idempotency_key" text NOT NULL,
	"provider_task_id" text,
	"execution_status" text DEFAULT 'pending' NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"billing_status" text DEFAULT 'unbilled' NOT NULL,
	"unknown_reason" text,
	"request_id" text NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_task_input_object" CHECK (jsonb_typeof("canvas_saas"."generation_task"."input_snapshot") = 'object'),
	CONSTRAINT "generation_task_parameters_object" CHECK (jsonb_typeof("canvas_saas"."generation_task"."parameter_snapshot") = 'object'),
	CONSTRAINT "generation_task_model_id" CHECK (length(trim("canvas_saas"."generation_task"."model_id")) > 0),
	CONSTRAINT "generation_task_idempotency_key" CHECK (length(trim("canvas_saas"."generation_task"."idempotency_key")) > 0),
	CONSTRAINT "generation_task_request_id" CHECK (length(trim("canvas_saas"."generation_task"."request_id")) > 0),
	CONSTRAINT "generation_task_price_version" CHECK ("canvas_saas"."generation_task"."price_version" IS NULL OR "canvas_saas"."generation_task"."price_version" > 0),
	CONSTRAINT "generation_task_quoted_units" CHECK ("canvas_saas"."generation_task"."quoted_units" IS NULL OR "canvas_saas"."generation_task"."quoted_units" >= 0),
	CONSTRAINT "generation_task_execution_status" CHECK ("canvas_saas"."generation_task"."execution_status" IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'timeout')),
	CONSTRAINT "generation_task_delivery_status" CHECK ("canvas_saas"."generation_task"."delivery_status" IN ('pending', 'saved', 'visible', 'failed', 'unknown')),
	CONSTRAINT "generation_task_billing_status" CHECK ("canvas_saas"."generation_task"."billing_status" IN ('unbilled', 'reserved', 'captured', 'released', 'pending_review')),
	CONSTRAINT "generation_task_unknown_reason" CHECK ("canvas_saas"."generation_task"."execution_status" <> 'unknown' OR ("canvas_saas"."generation_task"."unknown_reason" IS NOT NULL AND length(trim("canvas_saas"."generation_task"."unknown_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "generation_task_owner_idempotency" ON "canvas_saas"."generation_task" USING btree ("owner_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "generation_task_owner_created" ON "canvas_saas"."generation_task" USING btree ("owner_id", "created_at");
--> statement-breakpoint
CREATE INDEX "generation_task_owner_execution" ON "canvas_saas"."generation_task" USING btree ("owner_id", "execution_status", "updated_at");
--> statement-breakpoint
CREATE INDEX "generation_task_provider_task" ON "canvas_saas"."generation_task" USING btree ("provider_task_id");
