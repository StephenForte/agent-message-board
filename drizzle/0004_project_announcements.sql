ALTER TABLE "announcement_revisions" DROP CONSTRAINT "announcement_revisions_version";--> statement-breakpoint
ALTER TABLE "announcement_revisions" DROP CONSTRAINT "announcement_revisions_scope";--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT "announcements_scope";--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD CONSTRAINT "announcement_revisions_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_org_id_project_id_projects_org_id_id_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_one_project" ON "announcements" USING btree ("project_id") WHERE "announcements"."scope" = 'project';--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD CONSTRAINT "announcement_revisions_version" UNIQUE NULLS NOT DISTINCT("scope","org_id","project_id","version");--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD CONSTRAINT "announcement_revisions_scope" CHECK ((("announcement_revisions"."scope" = 'site' and "announcement_revisions"."org_id" is null and "announcement_revisions"."project_id" is null) or ("announcement_revisions"."scope" = 'org' and "announcement_revisions"."org_id" is not null and "announcement_revisions"."project_id" is null) or ("announcement_revisions"."scope" = 'project' and "announcement_revisions"."org_id" is not null and "announcement_revisions"."project_id" is not null)));--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_scope" CHECK ((("announcements"."scope" = 'site' and "announcements"."org_id" is null and "announcements"."project_id" is null) or ("announcements"."scope" = 'org' and "announcements"."org_id" is not null and "announcements"."project_id" is null) or ("announcements"."scope" = 'project' and "announcements"."org_id" is not null and "announcements"."project_id" is not null)));--> statement-breakpoint
ALTER POLICY "announcement_revisions_tenant_insert" ON "announcement_revisions" TO public WITH CHECK ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  ));--> statement-breakpoint
ALTER POLICY "announcement_revisions_tenant_update" ON "announcement_revisions" TO public USING ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  )) WITH CHECK ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  ));--> statement-breakpoint
ALTER POLICY "announcement_revisions_tenant_delete" ON "announcement_revisions" TO public USING ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  ));--> statement-breakpoint
ALTER POLICY "announcements_tenant_insert" ON "announcements" TO public WITH CHECK ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  ));--> statement-breakpoint
ALTER POLICY "announcements_tenant_update" ON "announcements" TO public USING ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  )) WITH CHECK ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  ));--> statement-breakpoint
ALTER POLICY "announcements_tenant_delete" ON "announcements" TO public USING ((
    (
      scope IN ('org', 'project')
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  ));