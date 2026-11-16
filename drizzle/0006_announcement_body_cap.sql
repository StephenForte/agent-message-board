ALTER TABLE "announcement_revisions" DROP CONSTRAINT "announcement_revisions_body_len";--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT "announcements_body_len";--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD CONSTRAINT "announcement_revisions_body_len" CHECK (octet_length("announcement_revisions"."body") <= 262144);--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_body_len" CHECK (octet_length("announcements"."body") <= 262144);