ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug") WHERE "organizations"."slug" is not null;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug" CHECK ("organizations"."slug" is null or "organizations"."slug" ~ '^[a-z0-9][a-z0-9-]{1,39}$');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_visibility" CHECK ("projects"."visibility" in ('private', 'public'));