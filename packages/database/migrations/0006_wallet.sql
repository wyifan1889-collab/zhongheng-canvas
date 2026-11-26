CREATE TABLE "canvas_saas"."wallet" (
	"user_id" text PRIMARY KEY NOT NULL,
	"unit" text DEFAULT 'credit' NOT NULL,
	"available_units" bigint DEFAULT 0 NOT NULL,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_unit" CHECK ("canvas_saas"."wallet"."unit" = 'credit'),
	CONSTRAINT "wallet_nonnegative" CHECK ("canvas_saas"."wallet"."available_units" >= 0 AND "canvas_saas"."wallet"."reserved_units" >= 0),
	CONSTRAINT "wallet_version" CHECK ("canvas_saas"."wallet"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."wallet_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"delta_available_units" bigint NOT NULL,
	"delta_reserved_units" bigint NOT NULL,
	"available_units_after" bigint NOT NULL,
	"reserved_units_after" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"actor_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_kind" CHECK ("canvas_saas"."wallet_ledger"."kind" IN ('grant', 'recharge', 'adjustment', 'reserve', 'capture', 'release', 'refund', 'consume')),
	CONSTRAINT "wallet_ledger_balance_after_nonnegative" CHECK ("canvas_saas"."wallet_ledger"."available_units_after" >= 0 AND "canvas_saas"."wallet_ledger"."reserved_units_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."wallet_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"requested_units" bigint NOT NULL,
	"captured_units" bigint DEFAULT 0 NOT NULL,
	"released_units" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_request_id" text,
	"task_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_reservation_status" CHECK ("canvas_saas"."wallet_reservation"."status" IN ('pending', 'captured', 'released', 'expired')),
	CONSTRAINT "wallet_reservation_requested_positive" CHECK ("canvas_saas"."wallet_reservation"."requested_units" > 0),
	CONSTRAINT "wallet_reservation_parts_nonnegative" CHECK ("canvas_saas"."wallet_reservation"."captured_units" >= 0 AND "canvas_saas"."wallet_reservation"."released_units" >= 0),
	CONSTRAINT "wallet_reservation_parts_within_request" CHECK ("canvas_saas"."wallet_reservation"."captured_units" + "canvas_saas"."wallet_reservation"."released_units" <= "canvas_saas"."wallet_reservation"."requested_units")
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet" ADD CONSTRAINT "wallet_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet_ledger" ADD CONSTRAINT "wallet_ledger_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "canvas_saas"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet_reservation" ADD CONSTRAINT "wallet_reservation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_user_idempotency" ON "canvas_saas"."wallet_ledger" USING btree ("user_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "wallet_ledger_user_created" ON "canvas_saas"."wallet_ledger" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_reservation_user_idempotency" ON "canvas_saas"."wallet_reservation" USING btree ("user_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "wallet_reservation_user_status" ON "canvas_saas"."wallet_reservation" USING btree ("user_id","status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "canvas_saas"."reject_wallet_ledger_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'wallet ledger is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "wallet_ledger_append_only" BEFORE UPDATE OR DELETE ON "canvas_saas"."wallet_ledger"
	FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."reject_wallet_ledger_mutation"();
