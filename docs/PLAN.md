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
    retention/              T18   hourly purge of expired retry, rate-limit and old activity rows (D-033)
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
drizzle/                    T02 (0000); 0001 T18 (D-033); 0002 T20 (D-035); later numbers by planner only (D-002)
render.yaml, docs/ops/      T13
docs/clients/               T12
tests/{unit,integration,e2e}/security/, docs/capability-matrix.md   T14 (configs only run those three trees)
load/                       T15
```

Shared, additive-only: `package.json` / `package-lock.json` (deps + scripts; lock conflict
rule in D-017), `.env.example` (append keys), `src/app/admin/layout.tsx` nav (T08 adds a link).

## Task tree

| ID | Title | Wave | After | Model | Status |
|----|-------|------|-------|-------|--------|
| T01 | Scaffold: Next.js, TS, lint, Vitest/Playwright, CI, env, logging, Markdown | 1 | — | mid | merged — PR #2 (274d91a) |
| T02 | Full schema + migration 0000, RLS, domain kernel | 1 | T01 | strong | merged — PR #3 (0fc8997) |
| T03 | Human auth, site admin, org provisioning/suspension | 2 | T02 | strong | merged — PR #9 (fc12b2d) |
| T04 | Projects + credentials domain (tokens, agents, sessions, defaults) | 2 | T02 | strong | merged — PR #5 (8c8bc69) |
| T05 | Messages domain (threads, flags, lifecycle, search) | 2 | T02 | strong | merged — PR #6 (dc21886) |
| T06 | Announcements domain | 2 | T02 | mid | merged — PR #8 (ada7557) |
| T13 | Render staging deploy, render.yaml, ops docs | 2 | T01 | mid | merged — PR #7 (6ccd287); Render not yet applied (operator decision) |
| T06b | Fix flaky announcement test teardown (57P01 on CI) | 3 | T06 | mid | merged — PR #11 (c10ea64) |
| T13b | Trim render.yaml to one staging environment (D-025) | 3 | T13 | mid | merged — PR #13 (8afd901) |
| T07 | Briefing/check_board engine + cursors | 3 | T04,T05,T06 | strong | merged — PR #14 (ebfd473) |
| T08 | Web shell: org home, projects, settings, announcement editors, audit view | 3 | T03,T04,T06 | mid | merged — PR #17 (573f752) |
| T09 | Web board: board, thread, composer, templates, search/filters, flags | 3 | T03,T05 | mid | merged — PR #15 (9393cc6) |
| T10 | Web tokens + agents management | 3 | T03,T04 | mid | merged — PR #16 (fec5d08) |
| T11 | MCP adapter: 9 tools, errors, rate limits | 4 | T07 | strong | merged — PR #18 (dbfcc05) |
| T12 | Connect-an-agent wizard, 4 client snippets, diagnostics, human briefing view (D-030) | 4 | T10,T11 | strong | merged — PR #20 (b44c8ef) |
| T14 | Security/isolation suite + capability matrix (browser + MCP); organizations.test.ts flake fix | 4 | T11,T08,T09 | strong | merged — PR #21 (1ac3882) |
| T17 | Postgres 18 in CI and render.yaml (D-031); messages.test.ts event ordering | 5 | — | mid | merged — PR #22 (58305ff) |
| T15 | Local load test at the pilot envelope (restore drill waived, D-032); database.md refresh | 5 | T17 | strong | merged — PR #23 (ead5181) |
| T18 | Data retention and throttled session-activity audit (D-033); migration 0001 | 5 | T15 | strong | merged — PR #24 (56c6709) |
| T16 | Four-client release gate + two-agent cross-machine pilot (operator-run) | 6 | T12,T15 | operator | passed 2026-11-11 — see verification log |
| T19 | Message-centric web layout (D-034) | 7 | — | mid | merged — PR #26 (19bddd9) |
| T20 | Public projects: visibility, org slug, read-only public pages (D-035); migration 0002 | 7 | T19 | strong | merged — PR #27 |
| T21 | Rate limits for anonymous public pages, in memory in the proxy (D-036); no migration | 8 | T20 | mid | dispatched |

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
- **T14 note from T11 review** — add a response-body assertion that MCP errors from non-domain failures never contain internal text (T11's test checks the code and the logs, not the response; a planner probe proved the behaviour is correct).
- **Wave-4 notes** — T12 became strong: D-030 adds owner-only `setupAgentConnection` and `getConnectionDiagnostics` (tenant boundary on guessed ids). Its model in this table was mid. T14 owns the fix for the flaky `tests/integration/auth/organizations.test.ts:142` (unordered audit query; failed on plan/wave-4 push run 42756740582, main CI on dbfcc05 green). Defects T14 finds are committed as expected-to-fail tests and become planner-dispatched fix tasks.
- **T07** — The hardest PRD paragraph (§10 Board check contract). Budget 12 KiB default,
  20 items default / 100 max, never silently omit urgent/pinned/announcements.
- **T11** — Thin: every tool maps to one domain call (D-011). No business logic in `src/mcp`.
- **T16 note from T12 review** — Claude Desktop's custom-connector request headers (the only bearer path, docs/clients/claude-desktop.md) are beta and available to a limited set of organizations per the cited Anthropic doc. Before T16, the operator checks whether the Add custom connector dialog shows Request headers. If not, Claude Desktop is unsupported for this account and D-010's packaged-adapter task applies.
- **Next test-touching brief** — add `orderBy(events.seq)` at `tests/integration/messages/messages.test.ts:182` (board hazard 8b3e8eb4) and cite T12's diagnostics tests in `docs/capability-matrix.md`.
- **Backlog (operator, 2026-11-10)** — site-admin UX is clunky (sign-up, verify, shell `admin:grant`); improve later. Capability matrix still lacks rows citing T12's diagnostics tests (needs evidence for all six role columns).
- **T16** — Not dispatchable to an agent: requires the operator's four clients on two
  machines. Planner writes the checklist; operator records versions/OS.

## Integration order and predicted conflicts

1. T01 → T02 (serial, wave 1).
2. Wave 2 merge order: T02-dependents in any order; **T13 any time after T01**.
   Predicted conflicts: `package.json`/lockfile (every task) — D-017 rule;
   `.env.example` appends (T03, T13) — keep both.
3. Wave 3 (D-026 route map): T07, T08, T09, T10, T13b run in parallel in clones `/Users/stephenforte/amb-<ID>`. Local e2e is serialized by the `/Users/stephenforte/.amb-e2e.lock` directory. Default assignments moved from T08 to T10; the human briefing preview moved to T12. T07 merges independently of web tasks. T08 first among web tasks (owns layout);
   T09/T10 rebase onto it — predicted conflict in nav links only.
4. T11 after T07. T12/T14 after T11.
5. Wave 4: T12 and T14 run in parallel in clones `/Users/stephenforte/amb-T12` and `amb-T14`, sharing the e2e lock. No shared files: T12 adds two exports to `src/domain/credentials` and one link each to the (app) layout and the board page; T14 changes only tests and `docs/capability-matrix.md`. Either may merge first; the second re-runs its gate on merged main. T14's matrix cites T12's diagnostics test only after both merge (planner follow-up).
7. Wave 6 (post-Phase-1, operator request): T19 then T20, serial. T20 reuses `src/components/board/` from T19, adds top-level `src/app/[org]/` public routes and migration 0002.
8. Wave 7: T21 alone. Touches `src/proxy.ts` (also edited by T20) and adds `src/lib/public-rate-limit.ts`; no shared-file conflicts expected.
6. Wave 5: T17 first and alone (Postgres 18, D-031). The operator created Render resources by hand (`Cloud BBS`, `cloud-bbs-db`, Postgres 18) rather than from the Blueprint; their env vars, pre-deploy migrate, build command, health check and CI-gated auto-deploy are set in the dashboard. T15 starts after the staging deploy is healthy.

## Verification log

(Planner records what was verified for each merge, and how.)

- **T01** (PR #2, head `8cbed34`, approved 2026-11-09): planner fresh clone on macOS/Node 26/PG 18. lint, typecheck, secret-free build pass; unit 28/28; integration 2/2; startup-proof 3/3. e2e 3/3 taken from the CI log (no local Chromium). 17 probes (Markdown XSS variants with a negative control, prod env rejection without value echo, nested token redaction) all green. Bugbot WebSocket finding is a false positive: `next/dist/server/next.js:336-350`. Review: PR #2 comment 6751297434.
- **T02** (PR #3, head `cd82bdb`, approved 2026-11-09): planner fresh clone on macOS/PG 18. lint, typecheck, build pass; unit 32/32; integration 16/16 (non-superuser runtime role); db:check no drift; CI gate green. Probe for the single-role Render shape: NOSUPERUSER NOBYPASSRLS role owning the tables, migrated as that role. Cross-org select, insert, update and delete are blocked; no org and blank org both see 0 rows. Negative control: NO FORCE shows 2 rows. Property 1 holds a real counter-lock wait (pg_locks). Both Bugbot findings on 62d519e were real and fixed in cd82bdb. D-006 wording amended to the site_admins table. Review: PR #3 comment 6753160291.
- **T05** (PR #6, head `95e36eb`, approved 2026-11-09): planner fresh clone on macOS/PG 18. lint, typecheck, build pass; unit 41/41; integration 26/26; db:check no drift; CI green. Negative control: removing the root `FOR UPDATE` turned 3 tests red (both lock-barrier orders and concurrent flags). Read: authorization precedes counts and full-text search; the reply's project is derived from the root; scope comes from `ctx`; HMAC cursors are bound to org, actor, project set and filters. The Bugbot finding on c592b8e (un-normalized history id) was real and fixed in 95e36eb. Review: PR #6 comment 6754445312.
- **T04** (PR #5, head `85ce184`, approved 2026-11-09): planner gate on the head merged with main dc21886. lint, typecheck, build, db:check pass; unit 46/46 (41+5); integration 45/45 (26+19). Negative controls: making defaults ignore grants turned 4 tests red; granting agent-created projects to every restricted token turned the exact-grant test red. Read: prefix-only lookup, constant-time compare that also runs on a miss, fresh grants via ctx, rejection-sampled base62. Bugbot: 0 findings. Review: PR #5 comment 6754561279.
- **T03** (PR #9, head `2df0799`, approved 2026-11-09): planner gate on the head merged with main 8c8bc69. lint, typecheck, build, db:check pass; unit 55/55 (46+9); integration 59/59 (45+14); startup-proof 6/6; e2e 11/11 on local Chromium. Negative controls each turned a named test red: activation without the lock and used_at condition (concurrent consume), site admin trusting the principal claim, activation not bound to the email, and route redaction off (unit plus e2e auth.spec.ts:119). Three Bugbot findings on 81c1234 were real and fixed. Wave-3 contract is in board handoff 483a84c5 (requireHuman/requireAdmin, humanLanding, performAuth). Review: PR #9 comment 6754623145.
- **T06** (PR #8, head `fcea6bb`, approved 2026-11-09): planner gate on the head merged with main fc12b2d. lint, typecheck, build, db:check pass; unit 58/58 (55+3); integration 67/67 (59+8). Negative controls: removing the site-admin re-check turned 2 tests red; removing the version check turned 2 red. Removing the row lock and unique-violation mapping left the suite green: its allSettled race resolves sequentially. A planner barrier probe (rival insert held uncommitted, call blocked per pg_stat_activity) returned version_conflict on PR code and went red with the mapping removed. Review: PR #8 comment 6754684950.
- **T13** (PR #7, head `e853044`, approved 2026-11-09): planner Render-shaped rehearsal on the head merged with main ada7557, as a NOSUPERUSER NOBYPASSRLS owner role. Negative control `NODE_ENV=production npm ci && npm run build` exits 1; render.yaml's build exits 0; pre-deploy migrate applies; start with exactly render.yaml's keys gives health 200; f|f; 0 tables with RLS but no FORCE. Every env.ts key on main (including T03's email keys) is present for both environments. Still unproven until a real staging deploy (docs give the checks): pre-deploy sees node_modules, rolsuper/rolbypassrls f|f, CREATE ROLE, HOSTNAME. Cost ≈ $35/mo for both environments, as quoted by the worker and not re-verified. Review: PR #7 comment 6754738679.
- **T06b** (PR #11, head `a6910f5`, approved 2026-11-10): the CI flake was 4 of 12 runs failing with 57P01 from the announcements fixture's `pool.end()` followed by `DROP … WITH (FORCE)`. The worker's corked-socket reproduction fails with the exact CI error when the old drop is restored, and passes on the fix (wait until pg_stat_activity is empty, then drop without FORCE). Local gate: unit 58, integration 68. CI on a6910f5: 5/5 attempts green plus the pull_request run. Review: PR #11 comment 6756386239. Planner process change: reviews now check the PR's recent CI run history, not only its latest run.
- **T13b** (PR #13, head `1a58501`, approved 2026-11-10): the staging block in render.yaml is byte-identical to main (one trailing blank line aside); the only added line is the title comment; amb-prod appears only in deploy.md's 'Adding production later'; the team-only warning is present. CI push and PR runs green; no earlier runs. Review: PR #13 comment.
- **T09** (PR #15, head `384f20b`, approved 2026-11-10): planner gate on the head merged with main 8afd901. Unit 63, integration 68, e2e 23 on local Chromium; CI history all green. Negative controls: rendering a body via dangerouslySetInnerHTML turned the hostile-Markdown e2e red; a fresh key per submit turned the double-submit e2e red. T09's `[slug]/layout.tsx` also wraps T08's `/projects/[slug]/settings` (project header plus archived banner): check the nesting when reviewing T08.
- **T07** (PR #14, head `4dbceef`, approved 2026-11-10): planner gate on the head merged with main 9393cc6. Unit 65, integration 83, no drift; CI history all green. Negative controls each turned a named test red: next cursor = W, events above W kept, events not project-filtered, W read after the snapshot. Query counts 32/52/127 for 1/5/20 projects (linear in projects, flat in items). The Bugbot microsecond-ordering finding was real and fixed. The Markdown-as-fenced-JSON choice is recorded as D-028. Review: PR #14 comment 6758241979.
- **T08** (PR #17, head `42c57f2`, changes requested 2026-11-10): merged with main ebfd473, T09's cross-org e2e returns 200 instead of 404. Proven cause: `(app)/loading.tsx` and `(app)/projects/loading.tsx` stream before T09's `notFound()`. Removing both gives full e2e 29/29; removing either alone does not. No data leaks, but main's CI would go red. Everything else passed: unit 71, integration 85; the cross-user-cache negative control turned the two-org e2e red. Review: PR #17 comment 6758344962. Lesson: parallel UI tasks are reviewed on the merged tree, where interactions show up.
- **T08 re-review** (head `7a36cbe` on main ebfd473): the delta is exactly the two loading.tsx deletions; full e2e 29/29 on the head, including T09's cross-org 404; CI green.
- **T10** (PR #16, head `a80ba42`, changes requested 2026-11-10): merged with main 573f752, the secret e2e fails a strict locator because tokens/shell.tsx's `Sections` nav duplicates T08's Primary nav links (D-026 gives nav to T08). Removing that nav gives full e2e 37/37. On the fixed tree, the log-the-secret and secret-in-URL negative controls both turn the secret e2e red. Unit 73, integration 85. All 3 Bugbot findings were real and fixed.
- **T10 re-review** (head `0275fb9` on main 573f752): the delta is exactly the Sections nav removal; full e2e 37/37 including the secret test; CI green.
- **T11** (PR #18, head `9ee8a15`, approved 2026-11-10): planner gate on the head merged with main d204b80. Unit 102, integration 98, e2e 38 (SDK client against the production server); CI and Bugbot clean. Negative controls: a module-level principal cache turned 6 tests red (including the 20-call cross-org isolation test); removing the body cap and making the limiter non-atomic each turned their tests red. Leaking error messages stayed green because the test checks logs, not responses; a planner probe showed the code returns a generic message, and the assertion is assigned to T14. Review: PR #18 comment.
- **T14** (PR #21, head `6616c2a`, approved 2026-11-10): brief v1 item 9 was wrong (it required RLS on `owner_activations`, which is deliberately exempt); the worker stopped correctly and v2 fixed it. Planner gate on the head (main dbfcc05): unit 103, integration 110, e2e 44; CI history 4/4 green; Bugbot 0. Negative controls: `errorResult` echoing non-domain errors turned the raw-response hygiene test red; revocation ignored in `authenticateBearer` alone stayed green because `withOrgTx` re-checks it (defense in depth), and breaking both turned two revocation tests red. Worker's four controls (error disclosure, cursor scope hash, restricted grant, NO FORCE) reported red. Follow-up: board hazard 8b3e8eb4, `tests/integration/messages/messages.test.ts:182` compares event kinds without ORDER BY; fold `orderBy(events.seq)` into the next brief that touches tests. Review: PR #21 comment 6772485086.
- **T12** (PR #20, head `8998c09`, approved 2026-11-10): planner gate on the head merged with main 1ac3882 (T14 included): unit 108, integration 114, e2e 45; 0 secret-pattern hits in the e2e log; CI history 6/6 green. Negative controls: secret in the diagnostics URL, sessions not filtered by token, and restricted defaults outside scope each turned a named test red. Removing the wizard's back/forward clearing stayed green because Next remounts on Back; the e2e still asserts the secret is gone after Back and reload. Claude Desktop request headers are beta for limited orgs (see T16 note). Review: PR #20 comment 6772951726.
- **T17** (PR #22, head `a2e54a1`, approved 2026-11-10): diff limited to the five allowed files; CI 2/2 green, both logs show `server_version=18.6` and the PR run has unit 108, integration 114, e2e 45. The version gate rejects 16.x, 17.x and an empty result (checked by feeding values to its case statement). The ORDER BY on events.seq resolves board hazard 8b3e8eb4. Not re-run locally (CI config plus one ORDER BY). Review: PR #22 comment.
- **Staging deploy checks** (2026-11-10, operator in the Cloud BBS Render shell; planner-supplied read-only Node check using the app's `pg` and `DATABASE_URL`): `server_version` 18.6; app role `rolsuper` false, `rolbypassrls` false; 23 public tables (matches `tenantTableNames` + `rlsExemptTableNames`); 0 tables with RLS but no FORCE; `CREATE ROLE` allowed (probe created and dropped). `HOSTNAME` is set (`srv-…-nvxpm`); the deploy is Live with health passing, so it does not affect the bind address. Closes the four items T13 left unproven. Pending: first site admin via `npm run admin:grant`. Follow-up: refresh docs/ops/database.md (Postgres 18, Cloud BBS / cloud-bbs-db, shell-only access, this check) in the next brief.
- **T15** (PR #23, head `3c83058`, approved 2026-11-10): measurement only; no `src/**` or test changes, CI 4/4 green; load not re-run by the planner. Seed 100k messages in 10.9 s. Steady run held 200 requests in flight against a pool of 10: 158.8 calls/s, server p95 1,228 ms reads / 1,162 ms writes, zero errors. Planner reading: closed-loop latency = 200 ÷ 158.8 ≈ 1.26 s, so this is a throughput ceiling (~160 calls/s on an M3 Max), not slow queries (idle check_board p95 88 ms). The brief's load definition (every agent at 80% of its rate limit, continuously) was the planner's overreach beyond PRD §14. Real finding: about 780 bytes stored per agent call, mostly `agent.session_seen` audit and idempotency rows, and nothing purges idempotency (D-013's job was never assigned) or `rate_limit_windows`. Retention task to follow. Review: PR #23 comment 6779107879.
- **T18** (PR #24, head `dd6baa5`, approved 2026-11-10): planner gate on the head (main ead5181): unit 111, integration 119, e2e 45; CI 2/2 green. Migration 0001 is a single nullable `ADD COLUMN` (catalog-only on PG 18); the worker's forward proof on the T15 seed kept 200 sessions and 101,610 audit rows. Negative controls, each red: maintenance helper without `app.org_id` (3 tests), throttle claiming every call, session-seen purge ignoring age, purge of every audit action, rate-limit purge without the grace. Measured 808.4 → 464.4 bytes per agent call; session_seen 1.01 → 0.01 per call. Review: PR #24 comment 6780401082.
- **T16 client gate, in progress** (2026-11-10, operator-run against staging `https://cloudbbs.ai/api/mcp`, project `t16-smoke`; planner cross-checked each report with `list_messages`):
  - **Claude Code** (desktop app, macOS 27.0.1, agent `Claude`): connect_agent, list_projects, create_project, post_message, list_messages, check_board — pass. Created `t16-smoke`.
  - **Cursor 3.29.15** (macOS 27.0.1 arm64, agent `cursor-mac`): connect_agent, check_board, list_messages, post_message (handoff), reply_message, cursor check_board (events seq 7–8) — pass.
  - **Codex** (desktop, app version not reported; CLI 0.167.0-alpha.3.2; macOS 27.0.1 arm64, agent `codex-mac`): same six steps — pass; replied to Cursor's handoff (events seq 11–12). Operator confirmed 0.167.0-alpha.3.2 as the recorded Codex version (2026-11-10).
  - **Claude Desktop 5.1231.0** (Electron 45.2.1, macOS darwin arm64, agent `claude-desktop-mac`): custom connector with a fixed `Authorization` request header (the beta is enabled on the operator's account); same six steps — pass; replied to Codex's handoff (events seq 13–14).
  - **Four-client gate (PRD §15.2): passed on 2026-11-10**, all four on one Mac. Second machine (operator-reported, 2026-11-11 04:45 UTC): Cursor 3.29.15 as `cursor-mac`, new session, read all four earlier threads, posted a handoff (`01a1c8ed-4f28…`) and replied to Claude Code's root (events seq 15–16); planner confirmed on the board. Restart (2026-11-11 04:48:39 UTC, operator via Render; confirmed in logs): sessions opened before the restart kept working on both machines (planner's Claude Code session at 04:49:11; the Mac mini's Cursor session), and all 5 threads and their replies were intact. Human reply (2026-11-11 04:50–04:51 UTC): the operator replied twice on the website (one addressed to `cursor-mac`); the planner's agent session saw both as `message.replied` events (seq 17–18) with author kind human, "Stephen Forte". **PRD §15.2 and §15.14 passed; T16 complete.**
  - Observation: a first `check_board` omits `note` posts (the recent group is decision/blocker/handoff, PRD §10), so a fresh agent sees a plain note only through `list_messages`. Not changed; revisit if pilot use shows agents missing notes.
- **T19** (PR #26, head `1df087f`, changes requested 2026-11-11): gate green (unit 118, integration 119, e2e 46; CI 5/5). The project page opens Filters and New post by default (`<details open>`), so the thread list starts ~1,600 px down; D-034 asks for list first. Removing `open` made exactly 10 existing e2e tests fail (they fill the composer or filters without opening them), which is why the panels were left open. Requested: closed by default, auto-open on active filters or a failed submit, an added open step in those 10 tests (assertions unchanged), readable relative times, new screenshots. Review: PR #26 comment 6804001220.
- **T19 re-review** (head `b1b35ee`): panels closed by default (Filters auto-opens on active filters; composer stays open after a failed submit or template); readable times via `TimeStamp`; the 10 tests gained open-panel clicks only (25 added lines, no assertion changes). Planner gate: unit 119, integration 119, e2e 46; CI 2/2 green. New 1440×900 screenshot shows the list on first load.
- **T20** (PR #27, head `8d27569`, approved 2026-11-11): planner gate on the head (main 19bddd9): unit 122, integration 124, e2e 49; CI 4/4 green. Migration 0002: two columns, a partial unique index, two checks. Negative controls (suspended org served, roots not limited to the project, gate ignoring visibility) each turned the public isolation test red; worker's four controls (gate, active filter, private field, noindex header) also red. `src/proxy.ts` changed outside the brief's list (3 additive lines for X-Robots-Tag); accepted. Open: anonymous traffic is not rate limited; fix before sharing public URLs beyond the team. Review: PR #27 comment.
