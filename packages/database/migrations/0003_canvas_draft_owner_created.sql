CREATE INDEX "canvas_draft_owner_created" ON "canvas_saas"."canvas_draft" USING btree ("owner_id","created_at");
