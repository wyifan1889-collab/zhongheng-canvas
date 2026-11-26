CREATE TABLE "canvas_saas"."generation_history_title" (
	"task_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "generation_history_title_nonempty" CHECK (length(trim("canvas_saas"."generation_history_title"."title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_history_title" ADD CONSTRAINT "generation_history_title_task_id_generation_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "canvas_saas"."generation_task"("id") ON DELETE cascade ON UPDATE no action;