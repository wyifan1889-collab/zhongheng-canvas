CREATE TABLE "canvas_saas"."storage_quota" (
	"user_id" text PRIMARY KEY NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_quota_nonnegative" CHECK ("quota_bytes" >= 0 AND "used_bytes" >= 0),
	CONSTRAINT "storage_quota_used_within_quota" CHECK ("used_bytes" <= "quota_bytes")
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."media_object" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"object_key" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_object_size_positive" CHECK ("size_bytes" > 0),
	CONSTRAINT "media_object_kind" CHECK ("kind" IN ('image', 'video', 'audio'))
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."storage_quota" ADD CONSTRAINT "storage_quota_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "canvas_saas"."media_object" ADD CONSTRAINT "media_object_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "canvas_saas"."user"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "media_object_object_key_unique" ON "canvas_saas"."media_object" USING btree ("object_key");
--> statement-breakpoint
CREATE INDEX "media_object_owner_created" ON "canvas_saas"."media_object" USING btree ("owner_id","created_at");
