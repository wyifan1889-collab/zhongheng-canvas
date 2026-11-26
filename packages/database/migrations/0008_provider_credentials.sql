CREATE TABLE "canvas_saas"."model_provider_credential" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_provider_credential_ciphertext" CHECK (length("canvas_saas"."model_provider_credential"."ciphertext") > 0),
	CONSTRAINT "model_provider_credential_nonce" CHECK (length("canvas_saas"."model_provider_credential"."nonce") = 24),
	CONSTRAINT "model_provider_credential_auth_tag" CHECK (length("canvas_saas"."model_provider_credential"."auth_tag") = 32),
	CONSTRAINT "model_provider_credential_key_version" CHECK ("canvas_saas"."model_provider_credential"."key_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."model_provider_credential" ADD CONSTRAINT "model_provider_credential_provider_id_model_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "canvas_saas"."model_provider"("id") ON DELETE cascade ON UPDATE no action;
