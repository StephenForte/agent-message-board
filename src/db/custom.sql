-- amb-custom-start
-- Not emitted by drizzle-kit. scripts/db-append-custom.ts keeps this block at
-- the end of migration 0000. FORCE ROW LEVEL SECURITY (D-020) and the triggers
-- below have no Drizzle schema equivalent in the installed drizzle-kit.

ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "token_project_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_project_defaults" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_session_projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_recipients" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "announcements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "announcement_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org_event_counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rate_limit_windows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_org_event_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO org_event_counters (org_id, last_seq)
  VALUES (NEW.id, 0);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_create_event_counter
AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION app_org_event_counter();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_messages_reply_targets_root()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_root uuid;
BEGIN
  IF NEW.root_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.root_id INTO target_root
  FROM messages m
  WHERE m.org_id = NEW.org_id
    AND m.project_id = NEW.project_id
    AND m.id = NEW.root_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF target_root IS NOT NULL THEN
    RAISE EXCEPTION 'reply must target a root message'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER messages_reply_targets_root
BEFORE INSERT OR UPDATE OF root_id, org_id, project_id ON messages
FOR EACH ROW
EXECUTE FUNCTION app_messages_reply_targets_root();
