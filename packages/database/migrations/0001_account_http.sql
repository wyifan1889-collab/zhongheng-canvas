CREATE TABLE "canvas_saas"."audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_id" text NOT NULL,
	"revision" integer NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."rate_limit" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"expire" bigint
);
--> statement-breakpoint
CREATE INDEX "audit_actor_created" ON "canvas_saas"."audit_event" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "rate_limit_expire" ON "canvas_saas"."rate_limit" USING btree ("expire");