CREATE TABLE "canvas_saas"."generation_rate_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"active_version_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_rate_settings_id" CHECK ("canvas_saas"."generation_rate_settings"."id" = 'generation'),
	CONSTRAINT "generation_rate_settings_revision" CHECK (("canvas_saas"."generation_rate_settings"."revision" = 0 AND "canvas_saas"."generation_rate_settings"."active_version_id" IS NULL) OR ("canvas_saas"."generation_rate_settings"."revision" > 0 AND "canvas_saas"."generation_rate_settings"."active_version_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "canvas_saas"."generation_rate_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"expected_revision" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_rate_version_revision" CHECK ("canvas_saas"."generation_rate_version"."revision" > 0 AND "canvas_saas"."generation_rate_version"."expected_revision" >= 0 AND "canvas_saas"."generation_rate_version"."revision"::bigint = "canvas_saas"."generation_rate_version"."expected_revision"::bigint + 1),
	CONSTRAINT "generation_rate_version_policy" CHECK ((jsonb_typeof("canvas_saas"."generation_rate_version"."policy") = 'object' AND "canvas_saas"."generation_rate_version"."policy" - 'ip' - 'user' = '{}'::jsonb AND
        (
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'ip') = 'object' AND
                "canvas_saas"."generation_rate_version"."policy"->'ip' ?& ARRAY['enabled','points','duration'] AND
                ("canvas_saas"."generation_rate_version"."policy"->'ip') - 'enabled' - 'points' - 'duration' = '{}'::jsonb AND
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'ip'->'enabled') = 'boolean' AND
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'ip'->'points') = 'number' AND
                ("canvas_saas"."generation_rate_version"."policy"->'ip'->>'points')::numeric BETWEEN 1 AND 2147483647 AND
                trunc(("canvas_saas"."generation_rate_version"."policy"->'ip'->>'points')::numeric) = ("canvas_saas"."generation_rate_version"."policy"->'ip'->>'points')::numeric AND
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'ip'->'duration') = 'number' AND
                ("canvas_saas"."generation_rate_version"."policy"->'ip'->>'duration')::numeric BETWEEN 1 AND 9007199254740 AND
                trunc(("canvas_saas"."generation_rate_version"."policy"->'ip'->>'duration')::numeric) = ("canvas_saas"."generation_rate_version"."policy"->'ip'->>'duration')::numeric
            ) AND (
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'user') = 'object' AND
                "canvas_saas"."generation_rate_version"."policy"->'user' ?& ARRAY['enabled','points','duration'] AND
                ("canvas_saas"."generation_rate_version"."policy"->'user') - 'enabled' - 'points' - 'duration' = '{}'::jsonb AND
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'user'->'enabled') = 'boolean' AND
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'user'->'points') = 'number' AND
                ("canvas_saas"."generation_rate_version"."policy"->'user'->>'points')::numeric BETWEEN 1 AND 2147483647 AND
                trunc(("canvas_saas"."generation_rate_version"."policy"->'user'->>'points')::numeric) = ("canvas_saas"."generation_rate_version"."policy"->'user'->>'points')::numeric AND
                jsonb_typeof("canvas_saas"."generation_rate_version"."policy"->'user'->'duration') = 'number' AND
                ("canvas_saas"."generation_rate_version"."policy"->'user'->>'duration')::numeric BETWEEN 1 AND 9007199254740 AND
                trunc(("canvas_saas"."generation_rate_version"."policy"->'user'->>'duration')::numeric) = ("canvas_saas"."generation_rate_version"."policy"->'user'->>'duration')::numeric
            )) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_rate_settings" ADD CONSTRAINT "generation_rate_settings_active_version_id_generation_rate_version_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "canvas_saas"."generation_rate_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_saas"."generation_rate_version" ADD CONSTRAINT "generation_rate_version_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "canvas_saas"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_rate_version_revision" ON "canvas_saas"."generation_rate_version" USING btree ("revision");
--> statement-breakpoint
CREATE FUNCTION canvas_saas.reject_generation_rate_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'published generation rate versions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER generation_rate_version_immutable BEFORE UPDATE OR DELETE ON canvas_saas.generation_rate_version
FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_generation_rate_version_mutation();
--> statement-breakpoint
INSERT INTO canvas_saas.generation_rate_settings (id, revision, active_version_id) VALUES ('generation', 0, NULL);
