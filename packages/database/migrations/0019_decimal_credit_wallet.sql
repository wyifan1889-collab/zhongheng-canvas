ALTER TABLE "canvas_saas"."wallet"
    ALTER COLUMN "available_units" TYPE numeric USING "available_units"::numeric,
    ALTER COLUMN "reserved_units" TYPE numeric USING "reserved_units"::numeric;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet_ledger"
    ALTER COLUMN "delta_available_units" TYPE numeric USING "delta_available_units"::numeric,
    ALTER COLUMN "delta_reserved_units" TYPE numeric USING "delta_reserved_units"::numeric,
    ALTER COLUMN "available_units_after" TYPE numeric USING "available_units_after"::numeric,
    ALTER COLUMN "reserved_units_after" TYPE numeric USING "reserved_units_after"::numeric;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet_reservation"
    ALTER COLUMN "requested_units" TYPE numeric USING "requested_units"::numeric,
    ALTER COLUMN "captured_units" TYPE numeric USING "captured_units"::numeric,
    ALTER COLUMN "released_units" TYPE numeric USING "released_units"::numeric;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet" ADD CONSTRAINT "wallet_amounts_finite" CHECK (
    "available_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "reserved_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet_ledger" ADD CONSTRAINT "wallet_ledger_amounts_finite" CHECK (
    "delta_available_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "delta_reserved_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "available_units_after" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "reserved_units_after" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."wallet_reservation" ADD CONSTRAINT "wallet_reservation_amounts_finite" CHECK (
    "requested_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "captured_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND
    "released_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
);
