# Phase 1 plan — Agent Message Board

Planner-owned. Workers read it; they do not edit it. Spec: `docs/PRD-phase1.md`.
Decisions: `docs/DECISIONS.md` (cited as D-NNN). Agent rules: `AGENTS.md`.
Tracker project: `cc68fecf-ca89-467a-a30f-f298890b4afc` (Supa Agent Tracker).

Status values: `planned` · `dispatched` · `in review` · `merged` (with PR + verification note).

## Commit-and-merge contract

D-017. One task, one branch `task/T<NN>-<slug>` from current `main`, one PR, squash-merged by
the operator after planner review. Workers never touch `docs/PLAN.md`, `docs/DECISIONS.md`,
`AGENTS.md`, or another task's owned paths.

## Model tiering

- **strong** = Opus-class (`claude-opus-5-5`): tenancy, transactions, concurrency, auth,
  protocol surface. Silent-failure risk.
- **mid** = Sonnet-class (`claude-sonnet-5-5`): scaffolding, UI over an existing domain,
  ops config.

## Source layout and ownership

```
src/
  env.ts                    T01   fail-closed config (PRD §13)
  lib/log.ts                T01   structured logs, request id, secret redaction
  components/markdown/      T01   the one sanitized renderer (D-012)
  db/                       T02   drizzle client, schema/, roles
  domain/
    kernel/                 T02   principal, authz, tx (SET LOCAL app.org_id), events, audit,
                                  idempotency, errors (D-007, D-008, D-013, D-015)
    organizations/          T03   provision, owner association, activation, suspend/restore
    projects/               T04   create (human + agent), archive/restore, list, defaults
    credentials/            T04   tokens, agents, sessions, token auth → principal
    messages/               T05   post, reply, flags/lifecycle, list, search, thread
    announcements/          T06   site + org announcements with revisions
    briefing/               T07   check_board, cursors, budgets, JSON + Markdown renderers
    ratelimit/              T11   per-token limits (Postgres-backed, multi-instance safe)
  auth/                     T03   Better Auth config, human principal, email adapter
  mcp/                      T11   tool registry, schemas, error mapping
  app/
    (auth)/                 T03   login, signup/activation, verify, reset
    admin/                  T03   org provisioning, suspension  (T08 adds admin/announcement/)
    (app)/layout, page      T08   shell, org home
    (app)/projects/         T08   list, create, settings   (T09 owns projects/[slug]/)
    (app)/projects/[slug]/  T09   board, thread, composer, history
    (app)/settings/         T08   org announcement, default assignments, audit log
    (app)/tokens/,(app)/agents/  T10
    (app)/connect/          T12   setup wizard, diagnostics
    api/health/             T01
    api/mcp/                T11
drizzle/                    T02 (0000); later numbers assigned by planner only (D-002)
render.yaml, docs/ops/      T13
docs/clients/               T12
tests/security/, docs/capability-matrix.md   T14
load/                       T15
```

Shared, additive-only: `package.json` / `package-lock.json` (deps + scripts; lock conflict
rule in D-017), `.env.example` (append keys), `src/app/admin/layout.tsx` nav (T08 adds a link).

## Task tree

| ID | Title | Wave | After | Model | Status |
|----|-------|------|-------|-------|--------|
| T01 | Scaffold: Next.js, TS, lint, Vitest/Playwright, CI, env, logging, Markdown | 1 | — | mid | merged — PR #2 (274d91a) |
| T02 | Full schema + migration 0000, RLS, domain kernel | 1 | T01 | strong | merged — PR #3 (0fc8997) |
| T03 | Human auth, site admin, org provisioning/suspension | 2 | T02 | strong | approved — PR #9 (2df0799), awaiting merge |
| T04 | Projects + credentials domain (tokens, agents, sessions, defaults) | 2 | T02 | strong | merged — PR #5 (8c8bc69) |
| T05 | Messages domain (threads, flags, lifecycle, search) | 2 | T02 | strong | merged — PR #6 (dc21886) |
| T06 | Announcements domain | 2 | T02 | mid | brief ready — docs/briefs/T06.md |
| T13 | Render staging deploy, render.yaml, ops docs | 2 | T01 | mid | brief ready — docs/briefs/T13.md |
| T07 | Briefing/check_board engine + cursors | 3 | T04,T05,T06 | strong | planned |
| T08 | Web shell: org home, projects, settings, announcement editors, audit view | 3 | T03,T04,T06 | mid | planned |
| T09 | Web board: board, thread, composer, templates, search/filters, flags | 3 | T03,T05 | mid | planned |
| T10 | Web tokens + agents management | 3 | T03,T04 | mid | planned |
| T11 | MCP adapter: 9 tools, errors, rate limits | 4 | T07 | strong | planned |
| T12 | Connect-an-agent wizard, 4 client snippets, diagnostics | 5 | T10,T11 | mid | planned |
| T14 | Security/isolation suite + capability matrix (browser + MCP) | 5 | T11,T08,T09 | strong | planned |
| T15 | Load test at pilot envelope + backup restore drill | 6 | T13,T14 | mid | planned |
| T16 | Four-client release gate + two-agent cross-machine pilot (operator-run) | 6 | T12,T15 | operator | planned |

Wave 2 runs five tasks in parallel in one repo: each parallel worker needs its own clone
(the brief names it and its teardown). Wave 2 clones: `/Users/stephenforte/amb-T03`, `amb-T04`, `amb-T05`,
`amb-T06`, `amb-T13`, each deleted at hand-back. No migration number is assigned in wave 2
(D-002); a worker that needs one stops and reports. Wave-2 dispatch needs docs PR #1 merged
first, so D-019–D-024 and the briefs are on `main`. Wave 1 is serial and runs in the main checkout.

### Task notes

- **T01** — Fail-closed `env.ts` (production refuses to start without `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `CURSOR_HMAC_SECRET`, `APP_BASE_URL`; PRD §13). No in-memory fallback
  anywhere. Logger redacts `Authorization`, `amb_*` strings, and bodies by default (PRD §14).
- **T02** — Covers every PRD §13 entity (incl. Better Auth tables, idempotency, events,
  audit, announcement revisions, agent sessions, rate-limit windows). Integration tests must
  prove: (a) a late-committing event cannot be skipped by a reader cursor (PRD §15.17);
  (b) RLS blocks cross-org reads with the runtime role; (c) mutation + event + audit roll back
  together. Exposes `withOrgTx(principal, fn)` and `authorize*` helpers used by all domains.
- **T03** — Activation link single-use, expiring, hashed at rest. Suspension blocks human
  content access and agent ops on the next request (PRD §6, §15.8).
- **T04** — Restricted-token project creation: project + grant + default assignment + audit
  in one transaction (PRD §5, §15.7). Defaults never widen scope (PRD §4).
- **T05** — Concurrent archive vs reply must serialize: no reply lands in an archived thread
  (PRD §10). Flag changes need `expected_version`. Bodies immutable. FTS over roots + replies.
- **Wave-3 note from T04 review** — `resolveAgentSession` writes an `agent.session_seen` audit row and updates `last_seen_at` on every agent call. T08's audit view must filter or group session-seen rows so real changes stay visible; T15 measures audit growth at the pilot envelope.
- **T07** — The hardest PRD paragraph (§10 Board check contract). Budget 12 KiB default,
  20 items default / 100 max, never silently omit urgent/pinned/announcements.
- **T11** — Thin: every tool maps to one domain call (D-011). No business logic in `src/mcp`.
- **T16** — Not dispatchable to an agent: requires the operator's four clients on two
  machines. Planner writes the checklist; operator records versions/OS.

## Integration order and predicted conflicts

1. T01 → T02 (serial, wave 1).
2. Wave 2 merge order: T02-dependents in any order; **T13 any time after T01**.
   Predicted conflicts: `package.json`/lockfile (every task) — D-017 rule;
   `.env.example` appends (T03, T13) — keep both.
3. Wave 3: T07 merges independently of web tasks. T08 first among web tasks (owns layout);
   T09/T10 rebase onto it — predicted conflict in nav links only.
4. T11 after T07. T12/T14 after T11.

## Verification log

(Planner records what was verified for each merge, and how.)

- **T01** (PR #2, head `8cbed34`, approved 2026-11-09): planner fresh clone on macOS/Node 26/PG 18. lint, typecheck, secret-free build pass; unit 28/28; integration 2/2; startup-proof 3/3. e2e 3/3 taken from the CI log (no local Chromium). 17 probes (Markdown XSS variants with a negative control, prod env rejection without value echo, nested token redaction) all green. Bugbot WebSocket finding is a false positive: `next/dist/server/next.js:336-350`. Review: PR #2 comment 6751297434.
- **T02** (PR #3, head `cd82bdb`, approved 2026-11-09): planner fresh clone on macOS/PG 18. lint, typecheck, build pass; unit 32/32; integration 16/16 (non-superuser runtime role); db:check no drift; CI gate green. Probe for the single-role Render shape: NOSUPERUSER NOBYPASSRLS role owning the tables, migrated as that role. Cross-org select, insert, update and delete are blocked; no org and blank org both see 0 rows. Negative control: NO FORCE shows 2 rows. Property 1 holds a real counter-lock wait (pg_locks). Both Bugbot findings on 62d519e were real and fixed in cd82bdb. D-006 wording amended to the site_admins table. Review: PR #3 comment 6753160291.
- **T05** (PR #6, head `95e36eb`, approved 2026-11-09): planner fresh clone on macOS/PG 18. lint, typecheck, build pass; unit 41/41; integration 26/26; db:check no drift; CI green. Negative control: removing the root `FOR UPDATE` turned 3 tests red (both lock-barrier orders and concurrent flags). Read: authorization precedes counts and full-text search; the reply's project is derived from the root; scope comes from `ctx`; HMAC cursors are bound to org, actor, project set and filters. The Bugbot finding on c592b8e (un-normalized history id) was real and fixed in 95e36eb. Review: PR #6 comment 6754445312.
- **T04** (PR #5, head `85ce184`, approved 2026-11-09): planner gate on the head merged with main dc21886. lint, typecheck, build, db:check pass; unit 46/46 (41+5); integration 45/45 (26+19). Negative controls: making defaults ignore grants turned 4 tests red; granting agent-created projects to every restricted token turned the exact-grant test red. Read: prefix-only lookup, constant-time compare that also runs on a miss, fresh grants via ctx, rejection-sampled base62. Bugbot: 0 findings. Review: PR #5 comment 6754561279.
- **T03** (PR #9, head `2df0799`, approved 2026-11-09): planner gate on the head merged with main 8c8bc69. lint, typecheck, build, db:check pass; unit 55/55 (46+9); integration 59/59 (45+14); startup-proof 6/6; e2e 11/11 on local Chromium. Negative controls each turned a named test red: activation without the lock and used_at condition (concurrent consume), site admin trusting the principal claim, activation not bound to the email, and route redaction off (unit plus e2e auth.spec.ts:119). Three Bugbot findings on 81c1234 were real and fixed. Wave-3 contract is in board handoff 483a84c5 (requireHuman/requireAdmin, humanLanding, performAuth). Review: PR #9 comment 6754623145.
