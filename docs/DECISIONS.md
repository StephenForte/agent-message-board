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

PostgreSQL is the only store. Target **Postgres 16+**; use no feature newer than 16 (local
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

**Render** web service + **Render Postgres**, two environments: `staging` and `prod`, both from
`render.yaml`. Daily backups via Render; a restore drill is a launch gate (PRD §14).

## D-005 — One organization per owner (2026-11-09, operator-confirmed)

Enforced by a unique constraint on `organizations.owner_user_id`. The owner relation stays an
FK on the organization so multiple owned orgs can follow without a data migration of content.

## D-006 — Site admin role (2026-11-09)

A boolean/role on the user record, granted only by a CLI script
(`npm run admin:grant -- <email>`), never through the UI or any agent tool. Site admin does
not imply read access to board content (PRD §4); admin pages read organization metadata only.

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
or any PG 16+ via `TEST_DATABASE_URL`; CI uses a `postgres:16` service container). No mocking
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
