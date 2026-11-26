CREATE TABLE "canvas_saas"."canvas_members" (
	"canvas_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text,
	"joined_at" timestamp with time zone,
	CONSTRAINT "canvas_members_pk" PRIMARY KEY("canvas_id","user_id"),
	CONSTRAINT "canvas_members_role" CHECK ("canvas_saas"."canvas_members"."role" IN ('viewer', 'editor', 'owner')),
	CONSTRAINT "canvas_members_owner_active" CHECK ("canvas_saas"."canvas_members"."role" <> 'owner' OR "canvas_saas"."canvas_members"."joined_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."canvas_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"token" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canvas_shares_role" CHECK ("canvas_saas"."canvas_shares"."role" IN ('viewer', 'editor'))
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."canvas_members" ADD CONSTRAINT "canvas_members_canvas_id_canvas_draft_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "canvas_saas"."canvas_draft"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."canvas_members" ADD CONSTRAINT "canvas_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."canvas_members" ADD CONSTRAINT "canvas_members_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "canvas_saas"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."canvas_shares" ADD CONSTRAINT "canvas_shares_canvas_id_canvas_draft_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "canvas_saas"."canvas_draft"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."canvas_shares" ADD CONSTRAINT "canvas_shares_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "canvas_saas"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "canvas_members_user" ON "canvas_saas"."canvas_members" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_members_one_owner" ON "canvas_saas"."canvas_members" USING btree ("canvas_id") WHERE "canvas_saas"."canvas_members"."role" = 'owner';
--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_shares_canvas_unique" ON "canvas_saas"."canvas_shares" USING btree ("canvas_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_shares_token_unique" ON "canvas_saas"."canvas_shares" USING btree ("token");
--> statement-breakpoint
-- Manual invariant additions follow the two generated tables/FKs/indexes.
-- Older 0002--0027 migrations lack snapshots; their duplicate generated DDL was
-- removed from this migration, with the untouched generation output kept as evidence.
CREATE FUNCTION "canvas_saas"."guard_canvas_member_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_canvas text;
    actual_owner text;
BEGIN
    IF TG_OP = 'UPDATE' AND ROW(NEW.canvas_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.canvas_id, OLD.user_id)
    THEN RAISE EXCEPTION 'Canvas member identity is immutable'; END IF;
    IF TG_OP = 'DELETE' THEN target_canvas := OLD.canvas_id;
    ELSE target_canvas := NEW.canvas_id; END IF;
    -- Also serialize direct SQL mutations with authorized canvas reads/saves.
    SELECT owner_id INTO actual_owner FROM "canvas_saas"."canvas_draft" WHERE id = target_canvas FOR UPDATE;
    IF NOT FOUND THEN
        -- A real parent DELETE has already removed the canvas when its FK cascades.
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'Canvas owner is unavailable';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.user_id = actual_owner OR OLD.role = 'owner'
        THEN RAISE EXCEPTION 'Canvas owner member cannot be deleted'; END IF;
        RETURN OLD;
    END IF;
    IF NEW.user_id = actual_owner THEN
        IF NEW.role IS DISTINCT FROM 'owner' OR NEW.joined_at IS NULL
        THEN RAISE EXCEPTION 'Canvas owner member must remain active owner'; END IF;
        IF TG_OP = 'UPDATE' AND ROW(NEW.role, NEW.joined_at) IS DISTINCT FROM ROW(OLD.role, OLD.joined_at)
        THEN RAISE EXCEPTION 'Canvas owner member authority is immutable'; END IF;
    ELSIF NEW.role = 'owner' OR (TG_OP = 'UPDATE' AND OLD.role = 'owner') THEN
        RAISE EXCEPTION 'Canvas owner member must match the draft owner';
    END IF;
    -- invited_by may become NULL through its user FK; it grants no authority.
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "canvas_members_owner_guard" BEFORE INSERT OR UPDATE OR DELETE ON "canvas_saas"."canvas_members"
FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."guard_canvas_member_owner"();
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."guard_canvas_draft_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id, NEW.owner_id) IS DISTINCT FROM ROW(OLD.id, OLD.owner_id)
    THEN RAISE EXCEPTION 'Canvas identity and owner are immutable'; END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "canvas_draft_owner_immutable" BEFORE UPDATE OF id, owner_id ON "canvas_saas"."canvas_draft"
FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."guard_canvas_draft_owner"();
--> statement-breakpoint
CREATE FUNCTION "canvas_saas"."seed_canvas_owner_member"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "canvas_saas"."canvas_members" (canvas_id, user_id, role, invited_by, joined_at)
    VALUES (NEW.id, NEW.owner_id, 'owner', NULL, NEW.created_at);
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "canvas_draft_owner_member" AFTER INSERT ON "canvas_saas"."canvas_draft"
FOR EACH ROW EXECUTE FUNCTION "canvas_saas"."seed_canvas_owner_member"();
--> statement-breakpoint
-- Existing owners are already authoritative. Preserve their real activation time.
INSERT INTO "canvas_saas"."canvas_members" (canvas_id, user_id, role, invited_by, joined_at)
SELECT id, owner_id, 'owner', NULL, created_at FROM "canvas_saas"."canvas_draft";
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "canvas_saas"."canvas_draft" d
        LEFT JOIN "canvas_saas"."canvas_members" m
          ON m.canvas_id = d.id AND m.user_id = d.owner_id AND m.role = 'owner' AND m.joined_at IS NOT NULL
        WHERE m.canvas_id IS NULL
    ) THEN RAISE EXCEPTION 'Canvas owner member backfill is incomplete'; END IF;
END;
$$;
