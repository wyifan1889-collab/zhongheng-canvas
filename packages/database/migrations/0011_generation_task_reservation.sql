ALTER TABLE "canvas_saas"."generation_task" ADD COLUMN "reservation_id" text;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_task" ADD CONSTRAINT "generation_task_reservation_id_wallet_reservation_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "canvas_saas"."wallet_reservation"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "generation_task_reservation" ON "canvas_saas"."generation_task" USING btree ("reservation_id");
