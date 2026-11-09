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
| T01 | Scaffold: Next.js, TS, lint, Vitest/Playwright, CI, env, logging, Markdown | 1 | — | mid | planned |
| T02 | Full schema + migration 0000, RLS, domain kernel | 1 | T01 | strong | planned |
| T03 | Human auth, site admin, org provisioning/suspension | 2 | T02 | strong | planned |
| T04 | Projects + credentials domain (tokens, agents, sessions, defaults) | 2 | T02 | strong | planned |
| T05 | Messages domain (threads, flags, lifecycle, search) | 2 | T02 | strong | planned |
| T06 | Announcements domain | 2 | T02 | mid | planned |
| T13 | Render staging deploy, render.yaml, ops docs | 2 | T01 | mid | planned |
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
(the brief names it and its teardown). Wave 1 is serial and runs in the main checkout.

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
