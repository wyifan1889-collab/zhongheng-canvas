-- Account identifiers are normalized at the HTTP boundary.  This migration
-- makes that invariant hold across processes and older imported rows too.
-- Do not silently choose a winner if legacy data already has case/whitespace
-- duplicates: stop and require an operator to resolve the accounts first.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "canvas_saas"."user"
        GROUP BY lower(btrim("email"))
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'cannot normalize duplicate canvas_saas.user email identifiers';
    END IF;
END $$;
--> statement-breakpoint
UPDATE "canvas_saas"."user"
SET "email" = lower(btrim("email")), "updated_at" = now()
WHERE "email" <> lower(btrim("email"));
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_lower_unique"
ON "canvas_saas"."user" USING btree (lower(btrim("email")));
