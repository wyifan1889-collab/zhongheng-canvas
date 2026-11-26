CREATE TABLE "canvas_saas"."payment_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event_identity" text,
	"outcome" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"ciphertext" text,
	"nonce" text,
	"auth_tag" text,
	"key_version" integer,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_event_kind" CHECK ("canvas_saas"."payment_event"."kind" IN ('notification', 'query', 'create', 'reconcile')),
	CONSTRAINT "payment_event_evidence" CHECK (jsonb_typeof("canvas_saas"."payment_event"."evidence") = 'object'),
	CONSTRAINT "payment_event_notice_cipher" CHECK (("canvas_saas"."payment_event"."kind" = 'notification' AND "canvas_saas"."payment_event"."event_identity" IS NOT NULL AND "canvas_saas"."payment_event"."ciphertext" IS NOT NULL AND length("canvas_saas"."payment_event"."ciphertext") > 0 AND "canvas_saas"."payment_event"."nonce" IS NOT NULL AND length("canvas_saas"."payment_event"."nonce") = 24 AND "canvas_saas"."payment_event"."auth_tag" IS NOT NULL AND length("canvas_saas"."payment_event"."auth_tag") = 32 AND "canvas_saas"."payment_event"."key_version" IS NOT NULL AND "canvas_saas"."payment_event"."key_version" = 1) OR ("canvas_saas"."payment_event"."kind" <> 'notification' AND "canvas_saas"."payment_event"."ciphertext" IS NULL AND "canvas_saas"."payment_event"."nonce" IS NULL AND "canvas_saas"."payment_event"."auth_tag" IS NULL AND "canvas_saas"."payment_event"."key_version" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."payment_merchant_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"protocol" text NOT NULL,
	"currency" text NOT NULL,
	"payment_type" text NOT NULL,
	"channel_id" text,
	"product_name" text NOT NULL,
	"notify_url" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_merchant_identity" CHECK ("canvas_saas"."payment_merchant_version"."merchant_id" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "payment_merchant_protocol" CHECK ("canvas_saas"."payment_merchant_version"."protocol" = 'zpay-epay-md5-doc-03b0f9fb1ff6' AND "canvas_saas"."payment_merchant_version"."currency" = 'CNY'),
	CONSTRAINT "payment_merchant_type" CHECK ("canvas_saas"."payment_merchant_version"."payment_type" IN ('alipay', 'wxpay')),
	CONSTRAINT "payment_merchant_credential" CHECK (length("canvas_saas"."payment_merchant_version"."ciphertext") > 0 AND length("canvas_saas"."payment_merchant_version"."nonce") = 24 AND length("canvas_saas"."payment_merchant_version"."auth_tag") = 32 AND "canvas_saas"."payment_merchant_version"."key_version" = 1)
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."payment_offer_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"label" text NOT NULL,
	"amount_minor" text NOT NULL,
	"credit_units" numeric NOT NULL,
	"policy_reference" text,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_offer_revision" CHECK ("canvas_saas"."payment_offer_version"."revision" > 0),
	CONSTRAINT "payment_offer_amount" CHECK ("canvas_saas"."payment_offer_version"."amount_minor" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "payment_offer_credits" CHECK ("canvas_saas"."payment_offer_version"."credit_units" > 0 AND "canvas_saas"."payment_offer_version"."credit_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."payment_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"create_key" text NOT NULL,
	"provider" text NOT NULL,
	"merchant_version_id" uuid NOT NULL,
	"offer_version_id" uuid NOT NULL,
	"merchant_id" text NOT NULL,
	"merchant_order_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount_minor" text NOT NULL,
	"credit_units" numeric NOT NULL,
	"payment_type" text NOT NULL,
	"product_name" text NOT NULL,
	"channel_id" text,
	"create_state" text DEFAULT 'pending' NOT NULL,
	"create_attempt_token" uuid,
	"create_attempted_at" timestamp with time zone,
	"provider_trade_no" text,
	"provider_order_id" text,
	"payment_links" jsonb,
	"payment_state" text DEFAULT 'unknown' NOT NULL,
	"credit_state" text DEFAULT 'pending' NOT NULL,
	"refund_state" text DEFAULT 'none' NOT NULL,
	"credited_ledger_id" text,
	"credited_at" timestamp with time zone,
	"last_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_order_identity" CHECK ("canvas_saas"."payment_order"."provider" = 'zpay' AND "canvas_saas"."payment_order"."currency" = 'CNY' AND "canvas_saas"."payment_order"."merchant_id" ~ '^[A-Za-z0-9_-]+$' AND "canvas_saas"."payment_order"."merchant_order_id" ~ '^[A-Za-z0-9_-]{1,32}$' AND ("canvas_saas"."payment_order"."provider_trade_no" IS NULL OR "canvas_saas"."payment_order"."provider_trade_no" ~ '^[A-Za-z0-9_-]+$')),
	CONSTRAINT "payment_order_amount" CHECK ("canvas_saas"."payment_order"."amount_minor" ~ '^[1-9][0-9]*$' AND "canvas_saas"."payment_order"."credit_units" > 0 AND "canvas_saas"."payment_order"."credit_units" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
	CONSTRAINT "payment_order_type" CHECK ("canvas_saas"."payment_order"."payment_type" IN ('alipay', 'wxpay')),
	CONSTRAINT "payment_order_create_state" CHECK ("canvas_saas"."payment_order"."create_state" IN ('pending', 'attempting', 'accepted', 'rejected', 'unknown')),
	CONSTRAINT "payment_order_attempt_pair" CHECK (("canvas_saas"."payment_order"."create_attempt_token" IS NULL) = ("canvas_saas"."payment_order"."create_attempted_at" IS NULL)),
	CONSTRAINT "payment_order_payment_state" CHECK ("canvas_saas"."payment_order"."payment_state" IN ('unknown', 'unpaid', 'paid')),
	CONSTRAINT "payment_order_refund_state" CHECK ("canvas_saas"."payment_order"."refund_state" IN ('none', 'pending_review', 'refunded')),
	CONSTRAINT "payment_order_credit_state" CHECK (("canvas_saas"."payment_order"."credit_state" = 'pending' AND "canvas_saas"."payment_order"."credited_ledger_id" IS NULL AND "canvas_saas"."payment_order"."credited_at" IS NULL) OR ("canvas_saas"."payment_order"."credit_state" = 'credited' AND "canvas_saas"."payment_order"."credited_ledger_id" IS NOT NULL AND "canvas_saas"."payment_order"."credited_at" IS NOT NULL AND "canvas_saas"."payment_order"."provider_trade_no" IS NOT NULL AND "canvas_saas"."payment_order"."payment_state" = 'paid'))
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."payment_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"new_orders_enabled" boolean DEFAULT false NOT NULL,
	"merchant_version_id" uuid,
	"offer_version_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_settings_id" CHECK ("canvas_saas"."payment_settings"."id" = 'zpay'),
	CONSTRAINT "payment_settings_revision" CHECK ("canvas_saas"."payment_settings"."revision" >= 0),
	CONSTRAINT "payment_settings_offers" CHECK (jsonb_typeof("canvas_saas"."payment_settings"."offer_version_ids") = 'array'),
	CONSTRAINT "payment_settings_enablement" CHECK (NOT "canvas_saas"."payment_settings"."new_orders_enabled" OR ("canvas_saas"."payment_settings"."merchant_version_id" IS NOT NULL AND jsonb_array_length("canvas_saas"."payment_settings"."offer_version_ids") > 0))
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_event" ADD CONSTRAINT "payment_event_order_id_payment_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "canvas_saas"."payment_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_merchant_version" ADD CONSTRAINT "payment_merchant_version_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_offer_version" ADD CONSTRAINT "payment_offer_version_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_order" ADD CONSTRAINT "payment_order_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_order" ADD CONSTRAINT "payment_order_merchant_version_id_payment_merchant_version_id_fk" FOREIGN KEY ("merchant_version_id") REFERENCES "canvas_saas"."payment_merchant_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_order" ADD CONSTRAINT "payment_order_offer_version_id_payment_offer_version_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "canvas_saas"."payment_offer_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_order" ADD CONSTRAINT "payment_order_credited_ledger_id_wallet_ledger_id_fk" FOREIGN KEY ("credited_ledger_id") REFERENCES "canvas_saas"."wallet_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."payment_settings" ADD CONSTRAINT "payment_settings_merchant_version_id_payment_merchant_version_id_fk" FOREIGN KEY ("merchant_version_id") REFERENCES "canvas_saas"."payment_merchant_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_event_identity" ON "canvas_saas"."payment_event" USING btree ("event_identity") WHERE "canvas_saas"."payment_event"."kind" = 'notification';--> statement-breakpoint
CREATE INDEX "payment_event_order_created" ON "canvas_saas"."payment_event" USING btree ("order_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_offer_version_unique" ON "canvas_saas"."payment_offer_version" USING btree ("offer_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_owner_key" ON "canvas_saas"."payment_order" USING btree ("owner_id","create_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_merchant_number" ON "canvas_saas"."payment_order" USING btree ("provider","merchant_id","merchant_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_merchant_transaction" ON "canvas_saas"."payment_order" USING btree ("provider","merchant_id","provider_trade_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_order_credited_ledger" ON "canvas_saas"."payment_order" USING btree ("credited_ledger_id");--> statement-breakpoint
CREATE INDEX "payment_order_owner_created" ON "canvas_saas"."payment_order" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_payment_order_unique" ON "canvas_saas"."wallet_ledger" USING btree ("reference_id") WHERE "canvas_saas"."wallet_ledger"."kind" = 'recharge' AND "canvas_saas"."wallet_ledger"."reference_type" = 'payment_order';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION canvas_saas.reject_payment_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'payment versions and evidence are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_merchant_version_immutable BEFORE UPDATE OR DELETE ON canvas_saas.payment_merchant_version
FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_payment_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_offer_version_immutable BEFORE UPDATE OR DELETE ON canvas_saas.payment_offer_version
FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_payment_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_event_immutable BEFORE UPDATE OR DELETE ON canvas_saas.payment_event
FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_payment_evidence_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION canvas_saas.protect_payment_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    merchant canvas_saas.payment_merchant_version%ROWTYPE;
    offer canvas_saas.payment_offer_version%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payment orders cannot be deleted'; END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO merchant FROM canvas_saas.payment_merchant_version WHERE id = NEW.merchant_version_id;
        SELECT * INTO offer FROM canvas_saas.payment_offer_version WHERE id = NEW.offer_version_id;
        IF merchant.id IS NULL OR offer.id IS NULL OR
            ROW(NEW.merchant_id, NEW.currency, NEW.payment_type, NEW.product_name, NEW.channel_id)
                IS DISTINCT FROM ROW(merchant.merchant_id, merchant.currency, merchant.payment_type, merchant.product_name, merchant.channel_id) OR
            NEW.amount_minor IS DISTINCT FROM offer.amount_minor OR NEW.credit_units IS DISTINCT FROM offer.credit_units OR
            NEW.create_state <> 'pending' OR NEW.create_attempt_token IS NOT NULL OR NEW.provider_trade_no IS NOT NULL OR
            NEW.credit_state <> 'pending' OR NEW.payment_state <> 'unknown' OR NEW.refund_state <> 'none' THEN
            RAISE EXCEPTION 'payment order must bind original server configuration';
        END IF;
    ELSE
        IF ROW(NEW.id, NEW.owner_id, NEW.create_key, NEW.provider, NEW.merchant_version_id, NEW.offer_version_id,
                NEW.merchant_id, NEW.merchant_order_id, NEW.currency, NEW.amount_minor, NEW.credit_units,
                NEW.payment_type, NEW.product_name, NEW.channel_id, NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.create_key, OLD.provider, OLD.merchant_version_id, OLD.offer_version_id,
                OLD.merchant_id, OLD.merchant_order_id, OLD.currency, OLD.amount_minor, OLD.credit_units,
                OLD.payment_type, OLD.product_name, OLD.channel_id, OLD.created_at) OR
            (OLD.create_attempt_token IS NOT NULL AND ROW(NEW.create_attempt_token, NEW.create_attempted_at)
                IS DISTINCT FROM ROW(OLD.create_attempt_token, OLD.create_attempted_at)) OR
            (OLD.provider_trade_no IS NOT NULL AND NEW.provider_trade_no IS DISTINCT FROM OLD.provider_trade_no) OR
            (OLD.create_state <> 'pending' AND NEW.create_state = 'pending') OR
            (OLD.create_state IN ('accepted', 'rejected') AND NEW.create_state IS DISTINCT FROM OLD.create_state) OR
            (OLD.payment_state = 'paid' AND NEW.payment_state <> 'paid') OR
            (OLD.refund_state = 'refunded' AND NEW.refund_state <> 'refunded') OR
            (OLD.credit_state = 'credited' AND ROW(NEW.credit_state, NEW.credited_ledger_id, NEW.credited_at)
                IS DISTINCT FROM ROW(OLD.credit_state, OLD.credited_ledger_id, OLD.credited_at)) THEN
            RAISE EXCEPTION 'payment order identity and completed facts are immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_order_protected BEFORE INSERT OR UPDATE OR DELETE ON canvas_saas.payment_order
FOR EACH ROW EXECUTE FUNCTION canvas_saas.protect_payment_order();
--> statement-breakpoint
-- Strictly compare the two private evidence records against the original cash contract.
-- The notification's authentication and the query's HTTP origin are server boundary duties;
-- neither a public DTO nor an arbitrary query observation is accepted as this pair.
CREATE OR REPLACE FUNCTION canvas_saas.payment_credit_evidence_matches(target uuid, notice_id uuid, query_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM canvas_saas.payment_order o
        JOIN canvas_saas.payment_event n ON n.id = notice_id AND n.order_id = o.id
        JOIN canvas_saas.payment_event q ON q.id = query_id AND q.order_id = o.id
        WHERE o.id = target AND o.provider_trade_no IS NOT NULL AND o.payment_state = 'paid'
          AND n.kind = 'notification' AND n.outcome = 'verified_success'
          AND n.evidence->>'protocol' = 'zpay-epay-md5-doc-03b0f9fb1ff6'
          AND n.evidence->>'provider' = 'zpay' AND n.evidence->>'kind' = 'payment_success_notification'
          AND n.evidence->>'tradeStatus' = 'TRADE_SUCCESS'
          AND n.evidence->>'merchantId' = o.merchant_id AND n.evidence->>'merchantOrderId' = o.merchant_order_id
          AND n.evidence->>'providerTradeNo' = o.provider_trade_no AND n.evidence->>'paymentType' = o.payment_type
          AND n.evidence->>'currency' = 'CNY' AND n.evidence->>'amountMinor' = o.amount_minor
          AND n.evidence @> jsonb_build_object('merchantId', o.merchant_id, 'merchantOrderId', o.merchant_order_id,
              'providerTradeNo', o.provider_trade_no, 'paymentType', o.payment_type, 'amountMinor', o.amount_minor)
          AND jsonb_typeof(n.evidence->'amountMinor') = 'string'
          AND n.evidence->>'eventIdentity' = n.event_identity
          AND n.evidence->>'orderIdentity' = replace(jsonb_build_array('zpay', o.merchant_id, o.merchant_order_id)::text, ', ', ',')
          AND n.event_identity = replace(jsonb_build_array('zpay', o.merchant_id, o.provider_trade_no, 'TRADE_SUCCESS')::text, ', ', ',')
          AND q.kind = 'query' AND q.outcome = 'paid' AND q.evidence->>'status' = 'paid'
          AND q.evidence->>'jsonMemberUniqueness' = 'checked_unique'
          AND q.evidence->'evidence'->>'source' = 'zpay-order-query-doc-03b0f9fb1ff6'
          AND q.evidence->'evidence'->>'level' = 'bound_query_observation'
          AND q.evidence->'evidence'->>'jsonMemberUniqueness' = 'not_checked'
          AND q.evidence->'evidence'->>'provider' = 'zpay'
          AND q.evidence->'evidence'->>'merchantId' = o.merchant_id
          AND q.evidence->'evidence'->>'merchantOrderId' = o.merchant_order_id
          AND q.evidence->'evidence'->>'providerTradeNo' = o.provider_trade_no
          AND q.evidence->'evidence'->>'paymentType' = o.payment_type
          AND q.evidence->'evidence'->>'currency' = 'CNY'
          AND q.evidence->'evidence'->>'amountMinor' = o.amount_minor
          AND q.evidence->'evidence' @> jsonb_build_object('merchantId', o.merchant_id, 'merchantOrderId', o.merchant_order_id,
              'providerTradeNo', o.provider_trade_no, 'paymentType', o.payment_type, 'amountMinor', o.amount_minor)
          AND jsonb_typeof(q.evidence->'evidence'->'amountMinor') = 'string'
          AND q.evidence->'evidence'->>'orderIdentity' = n.evidence->>'orderIdentity'
          AND q.evidence->'evidence'->>'paymentIdentity' = replace(jsonb_build_array('zpay', o.merchant_id, o.provider_trade_no)::text, ', ', ',')
          AND q.evidence->'evidence'->'notification'->>'kind' = 'payment_success_notification'
          AND q.evidence->'evidence'->'notification'->>'eventIdentity' = n.event_identity
    );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION canvas_saas.check_payment_credit_final()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
    o canvas_saas.payment_order%ROWTYPE;
    l canvas_saas.wallet_ledger%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'wallet_ledger' THEN
        IF NEW.kind <> 'recharge' THEN RETURN NULL; END IF;
        IF NEW.reference_type IS DISTINCT FROM 'payment_order' OR NEW.reference_id IS NULL THEN
            RAISE EXCEPTION 'recharge must reference an original payment order';
        END IF;
        target := NEW.reference_id::uuid;
    ELSE target := NEW.id;
    END IF;
    SELECT * INTO o FROM canvas_saas.payment_order WHERE id = target;
    IF o.id IS NULL THEN RAISE EXCEPTION 'recharge order is missing'; END IF;
    IF TG_TABLE_NAME = 'wallet_ledger' AND o.refund_state <> 'none' THEN
        RAISE EXCEPTION 'new recharge is forbidden for a refund-marked payment';
    END IF;
    SELECT * INTO l FROM canvas_saas.wallet_ledger
        WHERE kind = 'recharge' AND reference_type = 'payment_order' AND reference_id = target::text;
    IF o.credit_state = 'pending' AND l.id IS NULL THEN RETURN NULL; END IF;
    IF o.credit_state <> 'credited' OR l.id IS NULL OR o.credited_ledger_id IS DISTINCT FROM l.id OR
        l.user_id IS DISTINCT FROM o.owner_id OR l.idempotency_key IS DISTINCT FROM 'payment:' || target::text || ':recharge' OR
        l.delta_available_units IS DISTINCT FROM o.credit_units OR l.delta_reserved_units <> 0 OR
        jsonb_typeof(l.metadata->'notificationEventId') IS DISTINCT FROM 'string' OR
        jsonb_typeof(l.metadata->'queryEventId') IS DISTINCT FROM 'string' OR
        NOT canvas_saas.payment_credit_evidence_matches(target, (l.metadata->>'notificationEventId')::uuid, (l.metadata->>'queryEventId')::uuid) THEN
        RAISE EXCEPTION 'payment order and recharge evidence must commit together';
    END IF;
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_order_credit_consistent AFTER INSERT OR UPDATE ON canvas_saas.payment_order
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION canvas_saas.check_payment_credit_final();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wallet_ledger_payment_consistent AFTER INSERT ON canvas_saas.wallet_ledger
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION canvas_saas.check_payment_credit_final();
