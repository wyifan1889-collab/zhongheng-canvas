CREATE SCHEMA "canvas_saas";
--> statement-breakpoint
CREATE TABLE "canvas_saas"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."canvas_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"document_version" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canvas_draft_revision" CHECK ("canvas_saas"."canvas_draft"."revision" > 0),
	CONSTRAINT "canvas_draft_version" CHECK ("canvas_saas"."canvas_draft"."document_version" = 1),
	CONSTRAINT "canvas_draft_object" CHECK (jsonb_typeof("canvas_saas"."canvas_draft"."document") = 'object')
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_role" CHECK ("canvas_saas"."user"."role" IN ('user', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."canvas_draft" ADD CONSTRAINT "canvas_draft_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "canvas_saas"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user" ON "canvas_saas"."account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_identity" ON "canvas_saas"."account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "canvas_draft_owner" ON "canvas_saas"."canvas_draft" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "session_user" ON "canvas_saas"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier" ON "canvas_saas"."verification" USING btree ("identifier");