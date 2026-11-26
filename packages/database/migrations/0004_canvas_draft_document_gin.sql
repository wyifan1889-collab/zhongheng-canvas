CREATE INDEX "canvas_draft_document_gin" ON "canvas_saas"."canvas_draft" USING gin ("document" jsonb_path_ops);
