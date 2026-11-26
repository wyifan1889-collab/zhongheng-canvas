CREATE TABLE "canvas_saas"."official_price_source" (
    "id" text PRIMARY KEY NOT NULL,
    "version" integer DEFAULT 0 NOT NULL,
    "entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "digest" text,
    "previous_entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "previous_digest" text,
    "checked_at" timestamp with time zone,
    "attempted_at" timestamp with time zone,
    "changed_at" timestamp with time zone,
    "status" text DEFAULT 'unavailable' NOT NULL,
    "changed_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "lease_token" text,
    "lease_expires_at" timestamp with time zone,
    CONSTRAINT "official_price_source_id" CHECK (id IN ('openai','anthropic')),
    CONSTRAINT "official_price_source_version" CHECK (version >= 0),
    CONSTRAINT "official_price_source_status" CHECK (status IN ('ready','stale','unavailable')),
    CONSTRAINT "official_price_source_arrays" CHECK (jsonb_typeof(entries) = 'array' AND jsonb_typeof(previous_entries) = 'array' AND jsonb_typeof(changed_entry_ids) = 'array'),
    CONSTRAINT "official_price_source_lease" CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."official_price_mapping" (
    "model_id" text PRIMARY KEY NOT NULL REFERENCES "canvas_saas"."model_catalog"("public_id") ON DELETE restrict,
    "reference_id" text,
    "version" integer NOT NULL,
    "provider_id_snapshot" text NOT NULL,
    "provider_model_snapshot" text NOT NULL,
    "adapter_snapshot" text NOT NULL,
    "endpoint_snapshot" text NOT NULL,
    "capability_snapshot" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "official_price_mapping_version" CHECK (version > 0),
    CONSTRAINT "official_price_mapping_reference" CHECK (reference_id IS NULL OR reference_id ~ '^(openai|anthropic):.+'),
    CONSTRAINT "official_price_mapping_adapter" CHECK (adapter_snapshot IN ('openai-compatible','sub2api')),
    CONSTRAINT "official_price_mapping_capability" CHECK (capability_snapshot = 'text')
);
