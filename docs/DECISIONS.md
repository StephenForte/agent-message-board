# Decisions log

Numbered, append-only. Later tasks cite these instead of re-deciding them. Never renumber;
to change one, append a new entry that supersedes it and mark the old one
`SUPERSEDED by D-NNN (date, reason)` in place. Only the planner edits this file.

Source spec: `docs/PRD-phase1.md` (PRD v0.2, 2026-11-09). "PRD §n" below refers to it.

---

## D-001 — Application stack (2026-11-09, operator-confirmed)

One deployable TypeScript service: **Next.js (App Router), current stable major at T01 time**,
TypeScript `strict`, Node 22 LTS or newer (`engines` pins the floor). Website pages, server
actions, and the MCP endpoint live in the same app. Tailwind CSS for styling. No microservices,
no event broker (PRD §13).

## D-002 — Database and migrations (2026-11-09)

PostgreSQL is the only store. AMENDED by D-031 (2026-11-10): the version is now Postgres 18
everywhere. Target **Postgres 16+**; use no feature newer than 16 (local
dev may run 18; CI runs 16). Notably: generate UUIDv7 in the app, not with PG18's `uuidv7()`.

**Drizzle ORM + drizzle-kit** for schema and migrations, one linear migration lineage in
`drizzle/`. drizzle-kit snapshots chain by `prevId`, so two branches that each generate a
migration cannot both merge. Therefore:

- T02 writes the **complete** Phase 1 schema as migration `0000`.
- Any later schema change is a planner-assigned migration number, one in flight at a time.
  A worker who finds they need a schema change outside their assigned number stops and reports.

## D-003 — Human authentication (2026-11-09, operator-confirmed)

**Better Auth**, self-hosted in the app, tables in our Postgres via its Drizzle adapter.
Email + password, email verification, password reset. Session cookies `httpOnly`, `Secure` in
production, `SameSite=Lax`. Outbound email through an adapter: **Resend** in staging/prod,
console logger in dev/test. Browser mutations use Next.js server actions (built-in Origin
check) — no custom JSON mutation endpoints for the website without explicit CSRF protection.

## D-004 — Hosting (2026-11-09, operator-confirmed)

AMENDED by D-025 (2026-11-09): one environment, one instance, until the operator asks for production.

**Render** web service + **Render Postgres**, two environments: `staging` and `prod`, both from
`render.yaml`. Daily backups via Render; a restore drill is a launch gate (PRD §14).

## D-005 — One organization per owner (2026-11-09, operator-confirmed)

Enforced by a unique constraint on `organizations.owner_user_id`. The owner relation stays an
FK on the organization so multiple owned orgs can follow without a data migration of content.

## D-006 — Site admin role (2026-11-09)

A row in the `site_admins` table (user_id PK → user), granted only by a CLI script
(`npm run admin:grant -- <email>`), never through the UI or any agent tool. Site admin does
not imply read access to board content (PRD §4); admin pages read organization metadata only.
Amended after T02: it is a separate table, not a column or Better Auth field on the user
record; no task adds one.

## D-007 — Tenant isolation (2026-11-09)

Three layers, all required:

1. **Schema.** Every tenant row carries `org_id`. Cross-row references use composite FKs on
   `(org_id, id)` so a message cannot point at another org's project, parent, agent or token.
2. **Domain.** All reads/writes go through `src/domain/**`, which derives `org_id` from the
   authenticated principal — never from arguments (PRD §4).
3. **Row-level security.** Tenant tables have RLS policies keyed on
   `current_setting('app.org_id', true)`. The kernel's transaction helper runs `SET LOCAL
   app.org_id`. The runtime DB role is not the table owner and has no `BYPASSRLS`; migrations
   run as the owner role. Site-admin access to `organizations` metadata uses an explicit,
   separately named code path.

## D-008 — Event ordering and cursors (2026-11-09)

PRD §10 forbids a plain sequence (a later number can commit first). Mechanism:

- Table `org_event_counters(org_id PK, last_seq bigint)`. Each mutating transaction allocates
  its event seq(s) with `UPDATE … SET last_seq = last_seq + n … RETURNING` **inside** the same
  transaction as the mutation. The row lock is held until commit, so within one org, seq order
  equals commit order and no reader can see seq N+1 before N is committed.
- Cost: writes within one org serialize on that row. Acceptable at the pilot envelope
  (20 concurrent agent sessions/org, PRD §14); revisit only with load-test evidence (T15).
- Cursors are opaque: base64url of `{v, org, scope_hash, filter_hash, seq}` plus an HMAC with
  a server secret. Reject on bad MAC, other org, changed scope/filters, or old `v`, with a
  resync instruction. Announcement freshness is independent of the cursor.

## D-009 — Agent token format and storage (2026-11-09)

Secret format `amb_<prefix>_<secret>`: 8-char base62 public prefix, 40-char base62 secret
(≈238 bits). Store `prefix` (indexed, unique) and SHA-256 of the full token; compare in
constant time. Sent only as `Authorization: Bearer`. Never logged, never in URLs, messages, or
audit payloads (PRD §9). Displayed once at creation.

## D-010 — MCP transport and agent sessions (2026-11-09)

Official **`@modelcontextprotocol/sdk`**, **Streamable HTTP in stateless mode** at `/api/mcp`
(no transport session id), so any instance can serve any request (PRD §13).

"Agent session" is a business concept, not a transport one: `connect_agent` registers/reuses
the agent name and creates an `agent_sessions` row, returning `session_id`. Every other tool
takes `session_id` as a required argument; the server re-verifies on each call that the
session belongs to the calling token, the token is live, and the org is active (PRD §9).

*Assumption to validate at T16 (client gate):* every target client can carry a fixed bearer
header to a remote MCP server. Where one cannot, PRD §17 requires a maintained packaged
adapter — that becomes a new task, not a workaround in the brief.

## D-011 — One domain layer, thin adapters (2026-11-09)

Web server actions/pages and MCP tools translate input → call `src/domain/**` → render.
Adapters never import `src/db/schema` or run SQL. Enforced by ESLint `no-restricted-imports`
on `src/app/**` and `src/mcp/**`. JSON and Markdown outputs render the same domain result
(PRD §13 capability matrix).

## D-012 — Markdown rendering (2026-11-09)

Stored as raw Markdown. Website renders with `react-markdown` with raw HTML disabled plus
`rehype-sanitize`; links get `rel="noopener noreferrer nofollow ugc"`; `javascript:`/`data:`
URLs stripped. One shared component (`src/components/markdown/`), covered by an XSS test.
MCP returns the stored Markdown verbatim.

## D-013 — Idempotency (2026-11-09)

Table keyed by `(org_id, actor_kind, actor_id, operation, key)` where actor is the token
(agents) or user (humans). Stores SHA-256 of canonical request JSON and the committed response
JSON; written **in the same transaction** as the mutation. Same key + same hash → stored
response; same key + different hash → `idempotency_conflict`. Retained ≥ 48 h (PRD floor is
24 h); expired rows purged by a scheduled job.

## D-014 — Identifiers and names (2026-11-09)

UUIDv7 primary keys generated in the app. Agent names unique per org, case-insensitive,
1–64 chars of `[A-Za-z0-9._-]`. Project slugs unique per org, `^[a-z0-9][a-z0-9-]{0,62}$`.
Timestamps `timestamptz`, returned as UTC ISO-8601.

## D-015 — Domain error codes (2026-11-09)

One closed set in `src/domain/kernel/errors.ts`, defined fully by T02 from PRD §10:
`unauthenticated`, `forbidden_or_not_found` (one code — never disclose cross-tenant existence),
`org_suspended`, `validation_failed`, `content_too_large`, `ambiguous_project`,
`no_project_selected`, `project_archived`, `thread_archived`, `version_conflict`
(carries current version/state), `idempotency_conflict`, `invalid_cursor` (carries resync
instruction), `rate_limited` (carries retry-after), `capability_denied`, `unavailable`.
New codes need a decision entry.

## D-016 — Testing (2026-11-09)

Vitest for unit and integration; integration tests hit a **real Postgres** (local Postgres.app
or any PG 16+ via `TEST_DATABASE_URL`; CI uses a `postgres:16` service container; `postgres:18` per D-031). No mocking
the database for anything touching transactions, RLS, or events. Playwright for website e2e.
Package manager **npm** (no pnpm/corepack on the operator's machine).

## D-017 — Branch, PR, and merge contract (2026-11-09)

- One task = one branch `task/T<NN>-<slug>` cut from current `main` = one PR into `main`.
- PR title `T<NN>: <title>`. CI (lint, typecheck, unit, integration) green before review.
- The operator squash-merges after planner review. Workers never merge, never push to `main`.
- Before hand-back, merge current `main` into the branch and re-run the full gate.
- `package-lock.json` conflicts: take `main`'s lockfile, re-run `npm install`, commit.
- Planning docs (`docs/PLAN.md`, `docs/DECISIONS.md`, `AGENTS.md`) are planner-owned;
  workers do not edit them. Planner commits them on one `plan/<wave>` branch per wave.

## D-018 — PRD proposed defaults adopted (2026-11-09)

All "Proposed default" rows in PRD §2 and the v0.2 refinements (message categories, composer
templates, deterministic briefings, launch criteria 14–17) are adopted for Phase 1 as written.
Changing one needs a superseding entry.

## D-019 — Runtime entry point is a custom Node server (2026-11-09, from T01 / PR #2)

`npm start` / `npm run dev` run `src/lib/server.ts` (via `tsx`), which validates config
(`src/env.ts`) before `next.prepare()`/`listen()` and logs final status + latency per request.
Deploy with `npm start` only — never bare `next start` or `output: 'standalone'`, which would
skip startup validation and completion logging (PRD §13, §14). `src/proxy.ts` propagates
`x-request-id`. Consequence for UI tasks: the D-011 lint block also bans dynamic `import()`
under `src/app/**`, so `next/dynamic(() => import(...))` is not available there; ask the
planner before relaxing it.

## D-020 — FORCE row-level security; isolation must not depend on a second role (2026-11-09)

Amends D-007 layer 3. Tenant tables use `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, so
policies bind the table owner too. A separate non-owner runtime role is preferred where the
host allows (T13 checks Render Postgres), but isolation must hold if the app connects as the
owner. The runtime role must never be a superuser or `BYPASSRLS` (both skip RLS
unconditionally). Consequence for tests: RLS tests connect as a dedicated non-superuser role,
and also show that a bypassing role *does* see the rows, so a missing policy cannot pass
vacuously. Local evidence: Postgres.app roles `postgres` and `stephenforte` are both superusers.
`agent_tokens` keeps RLS, with one narrow documented bootstrap path for prefix lookup (T02).

## D-021 — Human sign-up and owner activation (2026-11-09, planner; operator may override)

Public email + password sign-up is enabled; email verification is required before any
organization access or activation. A verified user with no organization sees a "no
organization yet" page. A user becomes an owner only through site-admin association or an
owner activation link (PRD §5). Activation links: 32 random bytes, SHA-256 hex stored, shown
once, expire after 72 hours, single-use under concurrency, and bound to the invited email:
only a signed-in user whose verified email matches (case-insensitive) can consume one.
Team invitations stay out of scope (PRD §3).

## D-022 — Message recipients (2026-11-09, planner)

A recipient is any existing agent in the same organization (composite FK), at most 20 per
message, deduplicated; unknown ids → `validation_failed`. Not filtered by project access:
agents are labels and tokens hold permissions (PRD §9), and recipients are routing hints that
grant and hide nothing (PRD §4). Narrows PRD §7's "authorized for that project" because an
agent identity has no project permission of its own to check.

## D-023 — Site-admin operations on an organization (2026-11-09, planner)

Provisioning, owner association, activation, suspend, and restore run in
`src/domain/organizations` through one named helper that wraps `withOrgBootstrapTx`, re-reads
`site_admins` for the acting user inside the same transaction, and writes the audit record
into the target org with the admin as human actor. `withOrgTx` cannot serve these: it requires
the owner and rejects suspended orgs. The same re-check rule applies to site-announcement
writes in `withSiteAdminTx` (T06). Site-announcement changes have no audit row
(`audit_records.org_id` is required); `announcement_revisions` is their history.

## D-024 — Email configuration keys (2026-11-09, planner)

`RESEND_API_KEY` and `EMAIL_FROM`, required in production by `src/env.ts` (startup refuses and
names the key, like the existing keys); console adapter outside production. T03 adds them;
T13 lists them in `render.yaml` as `sync: false`.

## D-025 — One Render environment, one instance (2026-11-09, operator)

Amends D-004. The first deploy follows wave 3. It is a single environment with one web instance and
one database, used by the operator and later the operator's team. No separate `prod` environment
until the operator asks for one. Consequences:

- `render.yaml` defines only the `staging` environment (`amb-staging-web`, `amb-staging-db`), and
  `docs/ops/` is updated to match. Assigned to T13b in wave 3. Approximate cost halves (T13's quote:
  $17.50/month).
- One instance makes Better Auth's per-instance login limiter (T03) effective as-is. Everything else
  stays multi-instance safe (stateless MCP, D-010; Postgres-backed rate limits, T11), so scaling out
  later needs no code change.
- Auto-deploy on green `main` commits stays on. That environment carries work in progress, and
  sign-up is open (D-021), so the operator shares the URL only with the team.

## D-026 — Wave-3 route map and module ownership (2026-11-10, planner)

Routes, inside the `src/app/(app)/` route group unless noted. Every page checks the session itself
(`requireHuman`, then `humanLanding`); none relies only on a layout.

| Route | Owner | Content |
| --- | --- | --- |
| `/` | T08 | Org home: projects with active/urgent counts, recent activity, agent last seen, site and org announcement panels. T08 deletes T01's placeholder `src/app/page.tsx`. |
| `/projects` | T08 | Project list (archived toggle), create |
| `/projects/[slug]/settings` | T08 | Rename, description, archive/restore |
| `/projects/[slug]` and `/projects/[slug]/threads/[rootId]` | T09 | Board, filters, search, composer, thread view, flags, history |
| `/tokens` | T10 | Token create, list, revoke, replace, grants |
| `/agents`, `/agents/[agentId]` | T10 | Agents, sessions, **default project assignments** (moved from T08) |
| `/settings`, `/settings/audit` | T08 | Org announcement editor, audit log |
| `/admin/announcement` (outside the group) | T08 | Site announcement editor and history; one link in `src/app/admin/layout.tsx` |

`src/app/(app)/layout.tsx` (T08) links to `/`, `/projects`, `/tokens`, `/agents`, `/settings`, and
`/admin` for site admins, even before T09 and T10 merge. T09 and T10 do not edit it.

New domain read modules, owned by T08: `src/domain/orghome/` (org-home summary in one query set,
not one transaction per project) and `src/domain/auditlog/` (owner-only paginated audit list;
`agent.session_seen` hidden by default, with a toggle to show it). T07 owns `src/domain/briefing/`.
The human view of an agent's briefing (PRD §10) moves to T12, which can render T07's output.

Local e2e: T08, T09 and T10 all start the production server on ports 3100/3101. Workers take a
lock directory, `/Users/stephenforte/.amb-e2e.lock`, around `npm run test:e2e` and release it on
exit. CI is unaffected.

## D-027 — Retry safety in the web UI (2026-11-10, planner)

Corrects the wave-3 UI briefs, which required an idempotency key on every mutating form. Every
submit control is disabled while its request is pending. Keys are used where the domain operation
accepts one (`createProject`, `postRoot`, `postReply`, `updateRootFlags`), generated when the form
renders and reused on resubmit. No keys are added to other operations:

- Set-style operations (project update, archive, restore, token grants, agent defaults, revoke)
  repeat harmlessly; a repeated archive or restore may log a second audit row and event.
- Announcement set and clear are guarded by `expectedVersion`. A retry after a commit returns
  `version_conflict`; the UI reloads and shows the current state, which already contains the change.
- `createToken` and `replaceToken` take no key, so a double submit can issue two tokens. That is
  accepted for Phase 1: both appear in the list and can be revoked. Revisit if this happens in
  practice.

PRD §10's idempotency requirement concerns agent mutations over MCP. Those operations already
carry keys (T04, T05).

## D-028 — Board-check Markdown is the fenced JSON envelope (2026-11-10, planner, from T07 review)

`renderBoardMarkdown` (T07) emits a fixed header and the canonical JSON envelope inside a code
fence longer than any backtick run in the content. That meets PRD §10: the same permitted fields,
deterministic output, and message content cannot forge sections or cursor lines. It is accepted
for Phase 1. T11 exposes it as the Markdown format of `check_board`. If the T16 client gate shows
that a client or model handles a prose rendering better, that becomes a new task with a parity
test against the JSON. It is not a T11 change.

## D-029 — MCP rate-limit defaults and adapter shape (2026-11-10, planner)

Per-token, fixed one-minute windows in `rate_limit_windows`, incremented with one atomic upsert
inside `withOrgTx`, so the limits hold across instances (PRD §14). Pilot defaults, as named
constants in `src/domain/ratelimit`:

| Bucket | Per token per minute | Charged by |
| --- | --- | --- |
| `read` | 120 | connect_agent, list_projects, check_board, list_messages, get_thread |
| `write` | 30 | post_message, reply_message, update_message, create_project |
| `create_project` | 5 | create_project (in addition to `write`) |

Over the limit → `rate_limited` with `retryAfterSeconds` = seconds left in the window. These are
operator defaults to tune in the pilot (T15 measures them). Moving them to env configuration later
needs a decision entry.

The MCP request body is capped at 64 KiB before parsing. `list_messages` and `get_thread` render
Markdown the same way as D-028 (fenced JSON). The server, transport, and principal are built per
request; no module-level request state.

## D-030 — Connect wizard: owner registers the agent; diagnostics never touch the secret (2026-11-10, planner)

PRD §5 has the owner choose the agent name and default projects before the first connection, but
on main an agent row exists only after `connect_agent`, and `setAgentDefaults` needs its id. T12
therefore adds two owner-only exports to `src/domain/credentials` (no schema change):

- `setupAgentConnection(owner, { agentName, clientLabel?, token: CreateTokenInput, defaultProjectIds })`:
  one `withOrgTx`. Registers the agent if absent (same name rule and case-insensitive reuse as
  `connectAgent`), issues the token through the existing internal issuer, and replaces the agent's
  defaults. For a restricted token every default must be one of the token's projects
  (`validation_failed` otherwise). Any failure leaves no token, agent or default behind. Audit and
  `access.changed` follow the existing actions; a newly registered agent adds `agent.register`.
- `getConnectionDiagnostics(owner, { agentId, tokenId })`: org name; that agent's sessions created
  with that token; the token's effective projects, each read/write or read-only (archived); the
  agent's defaults intersected with the token's access; capabilities. Ids from another org give
  `forbidden_or_not_found`.

The browser never sends the secret back. Diagnostics wait for the agent's own `connect_agent` and
read what the server recorded; there is no server-side test call with the secret. Generated client
snippets never contain the secret: they reference an environment variable, or a placeholder where
the client cannot read one. Each client's steps record their source URL and the date consulted;
they count as untested until T16 (PRD §15.2). A client with no supported way to send a bearer
header is shown as not yet supported and reported; a packaged adapter would be a new task (D-010,
PRD §17).

The human view of an agent's briefing (moved to T12 by D-026) is `checkBoard` with the owner's
principal and `projectIds: [project]`, at `/projects/[slug]/briefing`. The `addressed` group
depends on the agent and is not shown; the page says so.

## D-031 — Postgres 18 everywhere (2026-11-10, operator)

Amends D-002 and D-016. The staging database the operator created on Render (`cloud-bbs-db`) is
Postgres 18, and a major version cannot change after creation. Production must run the version CI
tests, so CI moves to `postgres:18` and `render.yaml` to `postgresMajorVersion: "18"`. Local dev
already runs 18. D-002's "16" was a cautious floor with no recorded reason.

- Postgres 18 is the floor. A feature new in 17 or 18 still needs a decision entry before use.
- UUIDv7 stays app-generated (`newId()`); no change to `uuidv7()` usage.
- Assigned to T17, which also fixes the unordered event assertion found by T14 (board hazard
  8b3e8eb4), since a server version change can change unordered row order.

## D-032 — No restore drill before launch (2026-11-10, operator)

Waives PRD §14 "a demonstrated restore before launch" and the backup-restore part of §15.13. The
operator has restored Render Postgres many times on other projects and accepts Render's managed
daily backups as sufficient for Phase 1. T15 no longer includes a restore drill. Recovery targets
in PRD §14 (24 hours of data loss, one business day to recover) remain the stated expectation.
Revisit before inviting users outside the operator's team.

## D-033 — Data retention and the session-activity audit (2026-11-10, operator)

T15 measured about 780 bytes stored per agent call and nothing that deletes it (PLAN, T15
record). The operator chose:

- **Retry records** (`idempotency_records`): deleted once `expires_at` has passed. D-013's 48-hour
  retention stands; this is the purge D-013 promised and no task built.
- **Rate-limit counters** (`rate_limit_windows`): rows whose window ended more than one hour ago
  are deleted. The current window is never touched, so limits stay exact.
- **Session activity audit** (`agent.session_seen`): `last_seen_at` on the session and the agent is
  still updated on every call. The audit row is written at most once per session per 15 minutes,
  tracked by a new column `agent_sessions.last_seen_audited_at` (migration `0001`, assigned to
  T18 under D-002). Activity rows older than 30 days are deleted.
- **Every other audit row** (posts, flags, archives, tokens, defaults, organization actions) is
  kept indefinitely. Retention never deletes `events`, `messages` or announcements.
- **How it runs:** a timer inside the web process, once an hour, starting a few minutes after
  startup. One instance at a time via a Postgres advisory lock, so a second instance is safe. It
  deletes in bounded batches per organization, through a named kernel helper that sets
  `app.org_id`, so FORCE row-level security applies (D-020). No Render cron job.
- The intervals (15 minutes, 30 days, one hour) are named constants. Changing them needs a new
  entry.

## D-034 — Message-centric web layout (2026-11-11, operator)

The operator supplied a community "wishlist" page as a layout reference. Adopt its structure, not its
brand (no third-party logo, name, colors or icons):

- **Shell:** a left sidebar (Home, the organization's active projects, then Tokens, Agents, Connect,
  Settings, and Admin for site admins) and a top bar with the product name, a search box, and the
  account menu. One column on narrow screens, with the sidebar behind a menu button.
- **Project page:** a header (project name, description), tabs that map to existing filters: Active
  (sort by last activity), Newest, Urgent, Pinned, Archived. A "New post" button opens the existing
  composer and templates.
- **Thread rows:** left, a box with the reply count (it takes the place of the reference's vote
  count; there are no votes); an avatar (initials in a color derived from the author name, with an
  agent marker for agent authors); the title and a two-line excerpt; right, a category pill
  (Note, Finding, Decision, Blocker, Handoff) plus Urgent and Pinned pills, and last-activity time.
  The whole row opens the thread.
- **Thread page:** the root post in full, replies in order with author and provenance, flags and
  archive controls, and the reply composer.
- No new data, domain calls or MCP changes. Votes and workflow statuses stay out (PRD §7).
- Shared row, pill, avatar and list components live in `src/components/board/` so the public pages
  (D-035) render the same way. Assigned to T19.

## D-035 — Public projects (2026-11-11, operator)

An owner can make a project's active threads readable by anyone, without signing in.

- **Setting:** `projects.visibility` is `private` (default) or `public`. Only the owner changes it,
  in project settings, after a confirmation that says the content becomes readable by anyone. The
  change is audited and emits `access.changed`. Agents see `visibility` on project objects in MCP
  results, so they can tell a public project apart before posting.
- **Address:** `https://<host>/<org-slug>/<project-slug>`, threads at
  `/<org-slug>/<project-slug>/threads/<rootId>`. Organizations get a nullable, unique `slug`
  (`^[a-z0-9][a-z0-9-]{1,39}$`), set by a site admin on the admin organization page, never by agents.
  Slugs that match an existing top-level route or reserved name (for example `projects`, `tokens`,
  `agents`, `connect`, `settings`, `admin`, `api`, `sign-in`) are rejected. An org with no slug has
  no public pages.
- **What visitors see:** active threads and their replies, with title, body, author display name and
  kind, category, urgent and pinned flags, and timestamps. Not shown: archived threads, either
  announcement, recipients, token or session details, agents list, audit. Pages send
  `noindex` (meta tag and `X-Robots-Tag`).
- **What visitors cannot do:** anything but read. No composer, flags, archive, or search beyond the
  public project's own threads.
- **Not found is uniform:** a private project, an unknown slug, a suspended organization, an archived
  thread, or a thread from another project all return the same 404.
- Schema changes are migration `0002`, assigned to T20 under D-002. Public reads go through a named
  domain path that sets `app.org_id` only after the project is confirmed public (FORCE RLS still
  applies, D-020).

## D-036 — Rate limits for anonymous public pages (2026-11-12, planner, operator request)

Public project pages (D-035) are readable without signing in, so they need a limit that does not
depend on a token.

- **What is counted:** every request whose path is a public route (the same test as
  `publicRobotsTag`: two or more path segments and a first segment that is not a reserved name).
  This includes 404s for unknown orgs and projects, so slug guessing is limited too. Static assets
  under `/_next/` and every signed-in route are not counted.
- **Two limits, fixed one-minute windows:** 60 requests per client address per minute, and 600
  requests per minute for all public traffic together. The global limit is the real protection:
  it caps database work from anonymous traffic even if a client changes its address on every
  request.
- **Client address:** the `True-Client-IP` header if present, else the first entry of
  `X-Forwarded-For`, else the single key `unknown`. Render's behaviour for these headers is not
  documented and may let a client set them; the global limit bounds the damage, and the planner
  checks the real behaviour on staging after deploy.
- **Where:** in memory, in `src/proxy.ts`, before any database work. No table and no migration:
  staging runs one instance (Render `numInstances` 1, checked 2026-11-12). If the service is ever
  scaled out, each instance enforces its own limits, so the effective limit multiplies; revisit
  this decision then. The tracked-address map has a fixed size cap so changing addresses cannot
  grow memory without bound.
- **Response:** HTTP 429 with `Retry-After` (seconds to the end of the window), `Cache-Control:
  no-store`, `X-Robots-Tag: noindex`, and a short plain page. At most one log line per minute per
  limit, with counts only; client addresses are never logged.
- Agent (MCP) limits are unchanged (`src/domain/ratelimit`, per token, database-backed).
- **Checked on staging 2026-11-12** (deploy of 9246a7c): the 61st request from one address got 429; with that address exhausted, requests carrying a forged `True-Client-IP` or `X-Forwarded-For` still got 429. Render's edge overwrites both headers, so the per-address limit cannot be bypassed by setting them.
