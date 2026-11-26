ALTER TABLE "canvas_saas"."model_provider" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_provider" ADD CONSTRAINT "model_provider_revision" CHECK (revision > 0);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."provider_discovery_receipt" (
    "id" text PRIMARY KEY NOT NULL,
    "actor_id" text NOT NULL REFERENCES "canvas_saas"."user"("id") ON DELETE cascade,
    "session_id" text NOT NULL REFERENCES "canvas_saas"."session"("id") ON DELETE cascade,
    "provider_id" text NOT NULL,
    "revision" integer NOT NULL,
    "target_fingerprint" text NOT NULL,
    "models" jsonb NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "provider_discovery_receipt_revision" CHECK (revision >= 0),
    CONSTRAINT "provider_discovery_receipt_models" CHECK (jsonb_typeof(models) = 'array')
);
--> statement-breakpoint
CREATE INDEX "provider_discovery_receipt_session" ON "canvas_saas"."provider_discovery_receipt" ("session_id");
--> statement-breakpoint
CREATE TABLE "canvas_saas"."provider_discovered_model" (
    "provider_id" text NOT NULL REFERENCES "canvas_saas"."model_provider"("id") ON DELETE restrict,
    "provider_model" text NOT NULL,
    "available" boolean DEFAULT true NOT NULL,
    "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "provider_discovered_model_id" CHECK (length(btrim(provider_model)) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_discovered_model_unique" ON "canvas_saas"."provider_discovered_model" ("provider_id", "provider_model");
