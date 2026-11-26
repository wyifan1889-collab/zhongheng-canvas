CREATE TABLE "canvas_saas"."abuse_report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"subject" text NOT NULL,
	"details" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"received_by" text,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abuse_report_revision" CHECK ("canvas_saas"."abuse_report"."revision" > 0),
	CONSTRAINT "abuse_report_receipt" CHECK (("canvas_saas"."abuse_report"."status" = 'submitted' AND "canvas_saas"."abuse_report"."received_by" IS NULL AND "canvas_saas"."abuse_report"."received_at" IS NULL) OR ("canvas_saas"."abuse_report"."status" = 'received' AND "canvas_saas"."abuse_report"."received_by" IS NOT NULL AND "canvas_saas"."abuse_report"."received_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."account_moderation_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"disabled" boolean NOT NULL,
	"expected_version" integer NOT NULL,
	"revision" integer NOT NULL,
	"reason" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_moderation_operation_versions" CHECK ("canvas_saas"."account_moderation_operation"."expected_version" >= 0 AND "canvas_saas"."account_moderation_operation"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."content_safety_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"model_id" text NOT NULL,
	"capability" text NOT NULL,
	"phase" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_safety_event_capability" CHECK ("canvas_saas"."content_safety_event"."capability" IN ('text', 'image', 'video', 'audio')),
	CONSTRAINT "content_safety_event_phase" CHECK ("canvas_saas"."content_safety_event"."phase" = 'pre_generation'),
	CONSTRAINT "content_safety_event_mode" CHECK ("canvas_saas"."content_safety_event"."mode" = 'record')
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."generation_video_stage" (
	"task_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"protocol" text NOT NULL,
	"provider_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"provider_model" text NOT NULL,
	"price_publication_id" text NOT NULL,
	"parameters_snapshot" jsonb NOT NULL,
	"phase" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"create_attempt_token" text,
	"create_started_at" timestamp with time zone,
	"provider_task_id" text,
	"claim_token" text,
	"lease_until" timestamp with time zone,
	"next_action_at" timestamp with time zone,
	"inspect_attempts" integer DEFAULT 0 NOT NULL,
	"download_attempts" integer DEFAULT 0 NOT NULL,
	"observation_deadline_at" timestamp with time zone,
	"wake_revision" integer,
	"wake_job_id" text,
	"wake_deadline_at" timestamp with time zone,
	"last_reason" text,
	"last_http_status" integer,
	"completed_at" timestamp with time zone,
	"duration_evidence" jsonb,
	"probe_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_video_stage_protocol" CHECK ("canvas_saas"."generation_video_stage"."protocol" = 'yunfei-grok-video-v1'),
	CONSTRAINT "generation_video_stage_phase" CHECK ("canvas_saas"."generation_video_stage"."phase" IN ('ready', 'rejected', 'create_started', 'accepted', 'polling', 'completed', 'failed', 'unknown')),
	CONSTRAINT "generation_video_stage_counters" CHECK ("canvas_saas"."generation_video_stage"."revision" >= 0 AND "canvas_saas"."generation_video_stage"."inspect_attempts" >= 0 AND "canvas_saas"."generation_video_stage"."download_attempts" >= 0 AND ("canvas_saas"."generation_video_stage"."wake_revision" IS NULL OR "canvas_saas"."generation_video_stage"."wake_revision" >= 0)),
	CONSTRAINT "generation_video_stage_http_status" CHECK ("canvas_saas"."generation_video_stage"."last_http_status" IS NULL OR "canvas_saas"."generation_video_stage"."last_http_status" BETWEEN 100 AND 599),
	CONSTRAINT "generation_video_stage_claim_pair" CHECK (("canvas_saas"."generation_video_stage"."claim_token" IS NULL) = ("canvas_saas"."generation_video_stage"."lease_until" IS NULL)),
	CONSTRAINT "generation_video_stage_create_pair" CHECK (("canvas_saas"."generation_video_stage"."create_attempt_token" IS NULL) = ("canvas_saas"."generation_video_stage"."create_started_at" IS NULL)),
	CONSTRAINT "generation_video_stage_id" CHECK ("canvas_saas"."generation_video_stage"."provider_task_id" IS NULL OR (length("canvas_saas"."generation_video_stage"."provider_task_id") BETWEEN 1 AND 200 AND "canvas_saas"."generation_video_stage"."provider_task_id" NOT IN ('.', '..') AND "canvas_saas"."generation_video_stage"."provider_task_id" !~ '[[:cntrl:]]')),
	CONSTRAINT "generation_video_stage_bound_phase" CHECK ("canvas_saas"."generation_video_stage"."phase" NOT IN ('accepted', 'polling', 'completed', 'failed') OR "canvas_saas"."generation_video_stage"."provider_task_id" IS NOT NULL),
	CONSTRAINT "generation_video_stage_rejected" CHECK ("canvas_saas"."generation_video_stage"."phase" <> 'rejected' OR ("canvas_saas"."generation_video_stage"."create_attempt_token" IS NULL AND "canvas_saas"."generation_video_stage"."create_started_at" IS NULL AND "canvas_saas"."generation_video_stage"."provider_task_id" IS NULL)),
	CONSTRAINT "generation_video_stage_parameters" CHECK (jsonb_typeof("canvas_saas"."generation_video_stage"."parameters_snapshot") = 'object'),
	CONSTRAINT "generation_video_stage_probe" CHECK ("canvas_saas"."generation_video_stage"."probe_snapshot" IS NULL OR jsonb_typeof("canvas_saas"."generation_video_stage"."probe_snapshot") = 'object'),
	CONSTRAINT "generation_video_stage_duration" CHECK ("canvas_saas"."generation_video_stage"."duration_evidence" IS NULL OR COALESCE((jsonb_typeof("canvas_saas"."generation_video_stage"."duration_evidence") = 'object' AND (("canvas_saas"."generation_video_stage"."duration_evidence" = '{"status":"missing"}'::jsonb) OR ("canvas_saas"."generation_video_stage"."duration_evidence" = '{"status":"invalid"}'::jsonb) OR ("canvas_saas"."generation_video_stage"."duration_evidence" = jsonb_build_object('status', 'reported', 'rawSeconds', "canvas_saas"."generation_video_stage"."duration_evidence"->>'rawSeconds') AND "canvas_saas"."generation_video_stage"."duration_evidence"->>'rawSeconds' ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$' AND ("canvas_saas"."generation_video_stage"."duration_evidence"->>'rawSeconds')::numeric > 0))), false))
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" DROP CONSTRAINT "model_pricing_billing_unit";--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" DROP CONSTRAINT "model_pricing_credits_positive";--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD COLUMN "video_quote_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "canvas_saas"."session" ADD COLUMN "moderation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_saas"."user" ADD COLUMN "moderation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_saas"."abuse_report" ADD CONSTRAINT "abuse_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."account_moderation_operation" ADD CONSTRAINT "account_moderation_operation_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."account_moderation_operation" ADD CONSTRAINT "account_moderation_operation_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_video_stage" ADD CONSTRAINT "generation_video_stage_task_id_generation_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "canvas_saas"."generation_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_video_stage" ADD CONSTRAINT "generation_video_stage_price_publication_id_model_price_publication_id_fk" FOREIGN KEY ("price_publication_id") REFERENCES "canvas_saas"."model_price_publication"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_report_reporter_created" ON "canvas_saas"."abuse_report" USING btree ("reporter_id","created_at","id");--> statement-breakpoint
CREATE INDEX "abuse_report_status_created" ON "canvas_saas"."abuse_report" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "generation_video_stage_next_action" ON "canvas_saas"."generation_video_stage" USING btree ("next_action_at","task_id");--> statement-breakpoint
CREATE INDEX "generation_video_stage_lease" ON "canvas_saas"."generation_video_stage" USING btree ("lease_until","task_id");--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_video_quote" CHECK ("canvas_saas"."generation_task"."video_quote_snapshot" IS NULL OR (jsonb_typeof("canvas_saas"."generation_task"."video_quote_snapshot") = 'object' AND "canvas_saas"."generation_task"."text_quote_snapshot" IS NULL AND "canvas_saas"."generation_task"."price_version" IS NOT NULL AND "canvas_saas"."generation_task"."quoted_units" IS NOT NULL AND "canvas_saas"."generation_task"."billing_unit_snapshot" = 'request' AND "canvas_saas"."generation_task"."credits_per_unit_snapshot" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" ADD CONSTRAINT "model_pricing_billing_unit" CHECK ("canvas_saas"."model_pricing"."billing_unit" IN ('request', 'input_token', 'output_token', 'second', 'megapixel', 'text_tokens', 'image_specs', 'video_specs'));--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_pricing" ADD CONSTRAINT "model_pricing_credits_positive" CHECK (("canvas_saas"."model_pricing"."billing_unit" IN ('text_tokens', 'image_specs', 'video_specs') AND "canvas_saas"."model_pricing"."credits_per_unit" IS NULL) OR ("canvas_saas"."model_pricing"."billing_unit" NOT IN ('text_tokens', 'image_specs', 'video_specs') AND "canvas_saas"."model_pricing"."credits_per_unit" IS NOT NULL AND "canvas_saas"."model_pricing"."credits_per_unit" > 0));--> statement-breakpoint
ALTER TABLE "canvas_saas"."session" ADD CONSTRAINT "session_moderation_version" CHECK ("canvas_saas"."session"."moderation_version" >= 0);--> statement-breakpoint
ALTER TABLE "canvas_saas"."user" ADD CONSTRAINT "user_moderation_version" CHECK ("canvas_saas"."user"."moderation_version" >= 0);
-- Q1 operation receipts are immutable independently of the API process.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "canvas_saas"."reject_account_moderation_operation_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'account moderation operations are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "account_moderation_operation_immutable"
BEFORE UPDATE OR DELETE ON "canvas_saas"."account_moderation_operation"
FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."reject_account_moderation_operation_mutation"();
