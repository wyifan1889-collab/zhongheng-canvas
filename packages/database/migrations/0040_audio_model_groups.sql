ALTER TABLE "canvas_saas"."model_node_groups"
    DROP CONSTRAINT "model_node_groups_capability",
    ADD CONSTRAINT "model_node_groups_capability" CHECK (capability IN ('text', 'image', 'video', 'audio'));
--> statement-breakpoint
INSERT INTO "canvas_saas"."model_node_groups" ("capability") VALUES ('audio');
