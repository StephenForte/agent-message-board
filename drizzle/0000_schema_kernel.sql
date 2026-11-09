CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_project_defaults" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_project_defaults_pkey" PRIMARY KEY("org_id","agent_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "agent_project_defaults" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_session_projects" (
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_projects_pkey" PRIMARY KEY("org_id","session_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "agent_session_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"client_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_pkey" PRIMARY KEY("id"),
	CONSTRAINT "agent_sessions_org_id_id" UNIQUE("org_id","id"),
	CONSTRAINT "agent_sessions_client_label_len" CHECK ("agent_sessions"."client_label" is null or char_length("agent_sessions"."client_label") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text NOT NULL,
	"can_create_projects" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tokens_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "agent_tokens_org_id_id" UNIQUE("org_id","id"),
	CONSTRAINT "agent_tokens_label_len" CHECK (char_length("agent_tokens"."label") between 1 and 200),
	CONSTRAINT "agent_tokens_prefix" CHECK ("agent_tokens"."prefix" ~ '^[0-9A-Za-z]{8}$'),
	CONSTRAINT "agent_tokens_hash" CHECK ("agent_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_tokens_scope" CHECK ("agent_tokens"."scope" in ('org', 'projects'))
);
--> statement-breakpoint
ALTER TABLE "agent_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_org_id_id" UNIQUE("org_id","id"),
	CONSTRAINT "agents_name" CHECK ("agents"."name" ~ '^[A-Za-z0-9._-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "announcement_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"announcement_id" uuid,
	"scope" text NOT NULL,
	"org_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" integer NOT NULL,
	"author_user_id" text NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_revisions_version" UNIQUE NULLS NOT DISTINCT("scope","org_id","version"),
	CONSTRAINT "announcement_revisions_scope" CHECK ((("announcement_revisions"."scope" = 'site' and "announcement_revisions"."org_id" is null) or ("announcement_revisions"."scope" = 'org' and "announcement_revisions"."org_id" is not null))),
	CONSTRAINT "announcement_revisions_title_len" CHECK (octet_length("announcement_revisions"."title") between 1 and 16384),
	CONSTRAINT "announcement_revisions_body_len" CHECK (octet_length("announcement_revisions"."body") <= 16384),
	CONSTRAINT "announcement_revisions_version_min" CHECK ("announcement_revisions"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "announcement_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"org_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" integer NOT NULL,
	"author_user_id" text NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_scope" CHECK ((("announcements"."scope" = 'site' and "announcements"."org_id" is null) or ("announcements"."scope" = 'org' and "announcements"."org_id" is not null))),
	CONSTRAINT "announcements_title_len" CHECK (octet_length("announcements"."title") between 1 and 16384),
	CONSTRAINT "announcements_body_len" CHECK (octet_length("announcements"."body") <= 16384),
	CONSTRAINT "announcements_version" CHECK ("announcements"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "announcements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"user_id" text,
	"token_id" uuid,
	"agent_id" uuid,
	"session_id" uuid,
	"interface" text NOT NULL,
	"request_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_records_actor_kind" CHECK ("audit_records"."actor_kind" in ('human', 'agent', 'system')),
	CONSTRAINT "audit_records_interface" CHECK ("audit_records"."interface" in ('web', 'mcp', 'cli')),
	CONSTRAINT "audit_records_action_len" CHECK (char_length("audit_records"."action") between 1 and 200),
	CONSTRAINT "audit_records_entity_len" CHECK (char_length("audit_records"."entity_type") between 1 and 100 and char_length("audit_records"."entity_id") between 1 and 200),
	CONSTRAINT "audit_records_request_len" CHECK (char_length("audit_records"."request_id") between 1 and 200),
	CONSTRAINT "audit_records_before_size" CHECK ("audit_records"."before" is null or octet_length("audit_records"."before"::text) <= 16384),
	CONSTRAINT "audit_records_after_size" CHECK ("audit_records"."after" is null or octet_length("audit_records"."after"::text) <= 16384),
	CONSTRAINT "audit_records_actor" CHECK ((
    ("audit_records"."actor_kind" = 'human' and "audit_records"."user_id" is not null and "audit_records"."token_id" is null)
    or ("audit_records"."actor_kind" = 'agent' and "audit_records"."token_id" is not null and "audit_records"."user_id" is null)
    or ("audit_records"."actor_kind" = 'system' and "audit_records"."user_id" is null and "audit_records"."token_id" is null and "audit_records"."agent_id" is null and "audit_records"."session_id" is null)
  ))
);
--> statement-breakpoint
ALTER TABLE "audit_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "events" (
	"org_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"project_id" uuid,
	"message_id" uuid,
	"root_id" uuid,
	"agent_id" uuid,
	"token_id" uuid,
	"entity_type" text,
	"entity_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY("org_id","seq"),
	CONSTRAINT "events_seq_positive" CHECK ("events"."seq" > 0),
	CONSTRAINT "events_kind" CHECK ("events"."kind" in ('message.created', 'message.replied', 'message.flag_changed', 'message.archived', 'message.restored', 'project.created', 'project.updated', 'project.archived', 'project.restored', 'access.changed')),
	CONSTRAINT "events_payload_size" CHECK (octet_length("events"."payload"::text) <= 4096),
	CONSTRAINT "events_entity_len" CHECK ("events"."entity_type" is null or char_length("events"."entity_type") <= 100)
);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_actor_op_key" UNIQUE("org_id","actor_kind","actor_id","operation","idempotency_key"),
	CONSTRAINT "idempotency_records_actor_kind" CHECK ("idempotency_records"."actor_kind" in ('human', 'agent', 'system')),
	CONSTRAINT "idempotency_records_hash" CHECK ("idempotency_records"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_records_key_len" CHECK (char_length("idempotency_records"."idempotency_key") between 1 and 200 and char_length("idempotency_records"."operation") between 1 and 200),
	CONSTRAINT "idempotency_records_actor_len" CHECK (char_length("idempotency_records"."actor_id") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_recipients" (
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_recipients_pkey" PRIMARY KEY("org_id","message_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "message_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"root_id" uuid,
	"title" text,
	"body" text NOT NULL,
	"category" text,
	"status" text,
	"urgent" boolean,
	"pinned" boolean,
	"version" integer,
	"last_activity_at" timestamp with time zone,
	"author_kind" text NOT NULL,
	"author_user_id" text,
	"author_token_id" uuid,
	"author_agent_id" uuid,
	"author_session_id" uuid,
	"author_display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || body)) STORED,
	CONSTRAINT "messages_pkey" PRIMARY KEY("id"),
	CONSTRAINT "messages_org_id_id" UNIQUE("org_id","id"),
	CONSTRAINT "messages_org_project_id" UNIQUE("org_id","project_id","id"),
	CONSTRAINT "messages_body_len" CHECK (octet_length("messages"."body") <= 32768),
	CONSTRAINT "messages_title_len" CHECK ("messages"."title" is null or char_length("messages"."title") <= 200),
	CONSTRAINT "messages_display_name_len" CHECK (char_length("messages"."author_display_name") between 1 and 200),
	CONSTRAINT "messages_root_shape" CHECK ((
    (
      "messages"."root_id" is null
      and "messages"."title" is not null
      and char_length("messages"."title") between 1 and 200
      and "messages"."category" in ('note', 'finding', 'decision', 'blocker', 'handoff')
      and "messages"."status" in ('active', 'archived')
      and "messages"."urgent" is not null
      and "messages"."pinned" is not null
      and "messages"."version" is not null
      and "messages"."version" >= 1
      and "messages"."last_activity_at" is not null
    )
    or
    (
      "messages"."root_id" is not null
      and "messages"."root_id" <> "messages"."id"
      and "messages"."title" is null
      and "messages"."category" is null
      and "messages"."status" is null
      and "messages"."urgent" is null
      and "messages"."pinned" is null
      and "messages"."version" is null
      and "messages"."last_activity_at" is null
    )
  )),
	CONSTRAINT "messages_author" CHECK ((
    (
      "messages"."author_kind" = 'human'
      and "messages"."author_user_id" is not null
      and "messages"."author_token_id" is null
      and "messages"."author_agent_id" is null
      and "messages"."author_session_id" is null
    )
    or
    (
      "messages"."author_kind" = 'agent'
      and "messages"."author_user_id" is null
      and "messages"."author_token_id" is not null
      and "messages"."author_agent_id" is not null
      and "messages"."author_session_id" is not null
    )
  ))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_event_counters" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "org_event_counters_last_seq" CHECK ("org_event_counters"."last_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "org_event_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_name_len" CHECK (char_length("organizations"."name") between 1 and 200),
	CONSTRAINT "organizations_status" CHECK ("organizations"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "owner_activations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"org_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_activations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "owner_activations_token_hash" CHECK ("owner_activations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "owner_activations_email_len" CHECK (char_length("owner_activations"."email") between 3 and 320)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" text,
	"created_by_token_id" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_pkey" PRIMARY KEY("id"),
	CONSTRAINT "projects_org_id_id" UNIQUE("org_id","id"),
	CONSTRAINT "projects_org_slug" UNIQUE("org_id","slug"),
	CONSTRAINT "projects_slug" CHECK ("projects"."slug" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "projects_name_len" CHECK (char_length("projects"."name") between 1 and 200),
	CONSTRAINT "projects_description_len" CHECK ("projects"."description" is null or octet_length("projects"."description") <= 8192),
	CONSTRAINT "projects_status" CHECK ("projects"."status" in ('active', 'archived')),
	CONSTRAINT "projects_creator" CHECK ((
    ("projects"."created_by_kind" = 'human'
      and "projects"."created_by_user_id" is not null
      and "projects"."created_by_token_id" is null
      and "projects"."created_by_agent_id" is null)
    or
    ("projects"."created_by_kind" = 'agent'
      and "projects"."created_by_user_id" is null
      and "projects"."created_by_token_id" is not null
      and "projects"."created_by_agent_id" is not null)
  ))
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rate_limit_windows" (
	"org_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY("org_id","token_id","bucket","window_start"),
	CONSTRAINT "rate_limit_windows_count" CHECK ("rate_limit_windows"."count" >= 0),
	CONSTRAINT "rate_limit_windows_bucket" CHECK (char_length("rate_limit_windows"."bucket") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "rate_limit_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "site_admins" (
	"user_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_project_grants" (
	"org_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_project_grants_pkey" PRIMARY KEY("org_id","token_id","project_id"),
	CONSTRAINT "token_project_grants_source" CHECK ("token_project_grants"."source" in ('owner', 'agent_create'))
);
--> statement-breakpoint
ALTER TABLE "token_project_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_project_defaults" ADD CONSTRAINT "agent_project_defaults_agent_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_project_defaults" ADD CONSTRAINT "agent_project_defaults_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_projects" ADD CONSTRAINT "agent_session_projects_session_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "public"."agent_sessions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_projects" ADD CONSTRAINT "agent_session_projects_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_token_fk" FOREIGN KEY ("org_id","token_id") REFERENCES "public"."agent_tokens"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD CONSTRAINT "announcement_revisions_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD CONSTRAINT "announcement_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_revisions" ADD CONSTRAINT "announcement_revisions_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_token_fk" FOREIGN KEY ("org_id","token_id") REFERENCES "public"."agent_tokens"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_agent_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_session_fk" FOREIGN KEY ("org_id","session_id") REFERENCES "public"."agent_sessions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_message_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "public"."messages"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_root_fk" FOREIGN KEY ("org_id","root_id") REFERENCES "public"."messages"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_agent_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_token_fk" FOREIGN KEY ("org_id","token_id") REFERENCES "public"."agent_tokens"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_recipients" ADD CONSTRAINT "message_recipients_message_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "public"."messages"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_recipients" ADD CONSTRAINT "message_recipients_agent_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_root_fk" FOREIGN KEY ("org_id","project_id","root_id") REFERENCES "public"."messages"("org_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_token_fk" FOREIGN KEY ("org_id","author_token_id") REFERENCES "public"."agent_tokens"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_agent_fk" FOREIGN KEY ("org_id","author_agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_session_fk" FOREIGN KEY ("org_id","author_session_id") REFERENCES "public"."agent_sessions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_event_counters" ADD CONSTRAINT "org_event_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_activations" ADD CONSTRAINT "owner_activations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_activations" ADD CONSTRAINT "owner_activations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_token_fk" FOREIGN KEY ("org_id","created_by_token_id") REFERENCES "public"."agent_tokens"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_agent_fk" FOREIGN KEY ("org_id","created_by_agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_windows" ADD CONSTRAINT "rate_limit_windows_token_fk" FOREIGN KEY ("org_id","token_id") REFERENCES "public"."agent_tokens"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_admins" ADD CONSTRAINT "site_admins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_project_grants" ADD CONSTRAINT "token_project_grants_token_fk" FOREIGN KEY ("org_id","token_id") REFERENCES "public"."agent_tokens"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_project_grants" ADD CONSTRAINT "token_project_grants_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_lower_name" ON "agents" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_one_site" ON "announcements" USING btree ("scope") WHERE "announcements"."scope" = 'site';--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_one_org" ON "announcements" USING btree ("org_id") WHERE "announcements"."scope" = 'org';--> statement-breakpoint
CREATE INDEX "audit_records_org_created" ON "audit_records" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_at" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "message_recipients_by_agent" ON "message_recipients" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "messages_active_roots_activity" ON "messages" USING btree ("org_id","project_id","last_activity_at" DESC NULLS LAST) WHERE "messages"."root_id" is null and "messages"."status" = 'active';--> statement-breakpoint
CREATE INDEX "messages_replies_by_root" ON "messages" USING btree ("org_id","root_id","created_at") WHERE "messages"."root_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_owner_user_id_unique" ON "organizations" USING btree ("owner_user_id") WHERE "organizations"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE POLICY "agent_project_defaults_tenant" ON "agent_project_defaults" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_session_projects_tenant" ON "agent_session_projects" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_sessions_tenant" ON "agent_sessions" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agent_tokens_tenant" ON "agent_tokens" AS PERMISSIVE FOR ALL TO public USING ((
      org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
      OR (
        NULLIF(current_setting('app.org_id', true), '') IS NULL
        AND prefix = NULLIF(current_setting('app.token_prefix', true), '')
      )
    )) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agents_tenant" ON "agents" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "announcement_revisions_tenant" ON "announcement_revisions" AS PERMISSIVE FOR ALL TO public USING ((
      (
        NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
        AND (
          scope = 'site'
          OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
        )
      )
      OR (
        current_setting('app.site_admin', true) = '1'
        AND scope = 'site'
      )
    )) WITH CHECK ((
      (
        scope = 'org'
        AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
      )
      OR (
        scope = 'site'
        AND org_id IS NULL
        AND current_setting('app.site_admin', true) = '1'
      )
    ));--> statement-breakpoint
CREATE POLICY "announcements_tenant" ON "announcements" AS PERMISSIVE FOR ALL TO public USING ((
      (
        NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
        AND (
          scope = 'site'
          OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
        )
      )
      OR (
        current_setting('app.site_admin', true) = '1'
        AND scope = 'site'
      )
    )) WITH CHECK ((
      (
        scope = 'org'
        AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
      )
      OR (
        scope = 'site'
        AND org_id IS NULL
        AND current_setting('app.site_admin', true) = '1'
      )
    ));--> statement-breakpoint
CREATE POLICY "audit_records_tenant" ON "audit_records" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "events_tenant" ON "events" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "idempotency_records_tenant" ON "idempotency_records" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_recipients_tenant" ON "message_recipients" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messages_tenant" ON "messages" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "org_event_counters_tenant" ON "org_event_counters" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_tenant" ON "projects" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "rate_limit_windows_tenant" ON "rate_limit_windows" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "token_project_grants_tenant" ON "token_project_grants" AS PERMISSIVE FOR ALL TO public USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
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
