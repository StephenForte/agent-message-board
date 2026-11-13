CREATE TABLE "member_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"org_id" uuid NOT NULL,
	"can_create_projects" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "member_invitations_token_hash" CHECK ("member_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "member_invitations_email_len" CHECK (char_length("member_invitations"."email") between 3 and 320)
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"can_create_projects" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_user_id_unique" ON "org_members" USING btree ("user_id");