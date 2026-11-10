# Local load test — pilot envelope

Date: 2026-11-10. Product commit: `58305ff` (origin/main, T17). Postgres 18.6 (Postgres.app). The app connected as a non-superuser role with `NOBYPASSRLS`, so `FORCE` row-level security was on.

Hardware for every latency figure below: Apple M3 Max, 14 cores, 36 GB. That machine is much faster than the Render web service (0.5 CPU, 512 MB) and database (0.1 CPU, 256 MB). A miss here is a miss on the faster machine.

Seed wall time: 10.9 s, including creating the database and migrating. Steady-run wall time: 615.8 s, of which the scored window is 602.5 s. Smoke (1 org, 2 sessions, 30 s) was 35 s and is not part of the numbers below. Measurement wall time for smoke + seed + steady run: about 11 minutes.

## Envelope

| | Seeded |
| --- | ---: |
| Organizations | 10 |
| Projects | 1,000 |
| Agents, each with its own token and, during the run, its own session | 200 |
| Messages | 100,000 (50,000 roots + 50,000 replies) |
| Database size after seed | 164,574,911 bytes (157 MiB) |

Roots and replies are one-to-one. Some roots are urgent, some are pinned. One site announcement and one announcement per organization are set. Tokens alternate org-wide and project-restricted. Each agent has default projects. Seeded messages are owner-authored through the kernel transaction helpers (events and audit included). The steady run is the agent-authored traffic, and it goes only through `/api/mcp` on a local `npm start` of the production build (port 3200).

The steady run aimed at about 80% of the D-029 per-token limits: 96 reads and 24 writes per minute, which is 320 reads/s and 80 writes/s across 200 tokens. Clients kept one call in flight and did not burst to catch up. Twenty worker processes (two per organization) drove them. The busiest worker used 3.5% of one core. Event-loop lag peaked at 4 ms. The harness was not CPU-bound.

## Result

**Fail.** Server-side tool p95 is 1,228 ms for reads and 1,162 ms for writes. The target is under 1,000 ms. There were no `unavailable` outcomes and no HTTP 5xx. There were no `rate_limited` outcomes. A fresh `check_board` per organization after the run returned a cursor, both announcements, and a server p95 of 88 ms.

The server sustained 127.2 reads/s and 31.6 writes/s, about 40% of the aimed rate. Sessions were waiting on the server, not on the rate limiter.

Primary latency is the server's `latencyMs` on the tool log line (handler time, after the request is accepted). Client time is the SDK call. HTTP `latency_ms` is the whole request, including routing and token authentication. Percentiles are nearest-rank.

### Server tool latency (primary)

| Tool | Count | Errors | p50 | p95 | p99 | max |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| check_board | 38,357 | none | 846 ms | 1,266 ms | 1,590 ms | 1,905 ms |
| list_messages | 19,172 | none | 835 ms | 1,266 ms | 1,425 ms | 1,651 ms |
| get_thread | 19,099 | none | 578 ms | 971 ms | 1,121 ms | 1,749 ms |
| post_message | 6,381 | none | 848 ms | 1,276 ms | 1,428 ms | 1,927 ms |
| reply_message | 6,400 | none | 650 ms | 1,031 ms | 1,172 ms | 1,386 ms |
| update_message | 6,284 | none | 635 ms | 1,022 ms | 1,149 ms | 1,545 ms |
| All reads | 76,628 | none | 781 ms | **1,228 ms** | 1,484 ms | 1,905 ms |
| All writes | 19,065 | none | 707 ms | **1,162 ms** | 1,340 ms | 1,927 ms |

### Client and HTTP latency (alongside)

| | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| Client reads | 1,249 ms | 1,882 ms | 2,174 ms | 2,433 ms |
| Client writes | 1,177 ms | 1,765 ms | 2,030 ms | 2,596 ms |
| HTTP `/api/mcp` (`latency_ms`, 173,359 lines in the 600 s window, statuses 200 and 202 only) | 879 ms | 1,742 ms | 2,082 ms | 2,594 ms |

Forty client `check_board` calls failed as transport errors inside a 3 ms burst. The server log has no matching 5xx and no `unavailable`. They are not in the server error counts above.

## Growth over the steady run

Scored window 602.5 s. "Per day" is that delta scaled by 86,400 / 602.5. It is the achieved call rate (127 reads/s, 32 writes/s), not the higher rate the envelope asked for.

| | Before | After | Per day |
| --- | ---: | ---: | ---: |
| audit_records rows | 101,610 | 216,588 | 16.5 million |
| of which `agent.session_seen` | 0 | 95,703 | 13.7 million |
| rate_limit_windows rows | 0 | 4,409 | 632 thousand |
| events rows | 101,400 | 120,465 | 2.73 million |
| idempotency_records rows | 1,000 | 20,065 | 2.73 million |
| messages rows | 100,000 | 112,781 | 1.83 million |
| database size | 164,574,911 | 238,843,583 | 10.6 GB/day |

Relation size (`pg_total_relation_size`), per day at the same rate:

| Relation | Per day |
| --- | ---: |
| audit_records | 6.09 GB |
| idempotency_records | 3.12 GB |
| events | 0.82 GB |
| messages | 0.37 GB |
| rate_limit_windows | 0.11 GB |

83% of the new audit rows are `agent.session_seen` (one per agent tool call that resolves a session). New events and idempotency rows match the write count (19,065). New messages match posts plus replies (6,381 + 6,400).

`rate_limit_windows` grew by one row per token per bucket per minute window, not per call (4,409 rows, about 11 windows × 200 tokens × 2 buckets, plus the connect minute). Nothing deletes those rows. Held for a full day at this population that is about 576,000 rows, independent of how far under the limit the traffic sits.

From the seeded 157 MiB, growth of 10.6 GB/day fills a 10 GiB disk in about one day. The seeded envelope is not what fills it. Audit and idempotency are. D-013 describes a 48-hour idempotency retention purged by a scheduled job. There is no such job in this tree. At 3.1 GB/day, two days of idempotency alone is about 6 GB, and without a job the table does not stop.

## Contention

`pg_stat_activity` and `pg_locks` were sampled about once a second (598 samples). The maximum number of sessions waiting on a lock was **1**, on `org_event_counters_pkey`. The oldest waiting statement in that sample had been running for 0.006 s. That age upper-bounds the lock wait. D-008's per-org counter serialization is visible. The waits are milliseconds, and they do not account for a 1.2 s p95. Peak backends on the database was 12, against the server pool of 10 plus the sampler.

## What this run cannot show

Render's 0.5 CPU web process and 0.1 CPU database are slower than this Mac, so the latency miss would not improve there. The run never reached 320 reads/s or 80 writes/s; the server fell behind with one call in flight per session. A second call in flight per session was not tried. Single-threaded Next.js, the pool of 10, and `check_board` query cost are all inside the server times above and were not separated. Backup restore was not run (D-032).
