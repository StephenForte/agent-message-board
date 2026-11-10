# Retention

Hourly purge of operational rows that are past their use, and the timer that
runs it inside the web process. `src/lib/server.ts` starts it after `listen`
and clears it on SIGTERM and SIGINT before the rest of shutdown. The timer is
`unref`'d, so it does not keep the process alive. There is no Render cron job.

`runRetention({ now, batchSize })` is the entry point. `now` defaults to the
current time. `batchSize` defaults to `RETENTION_BATCH_SIZE` (5,000).

For every organization it:

- deletes `idempotency_records` with `expires_at < now` (rows are written with a 48-hour expiry);
- deletes `rate_limit_windows` whose one-minute window ended more than one hour before `now` (`window_start` older than one hour plus one minute);
- deletes `audit_records` with action `agent.session_seen` older than 30 days.

Events, messages, announcements, and every other audit action stay. Each
delete is a bounded batch under `withOrgMaintenanceTx`, which sets
`app.org_id` for that organization. Tenant tables have `FORCE` row-level
security, so a delete that forgets the helper matches no rows and still
returns success. The runtime role in tests is not a superuser and does not
bypass RLS; a superuser would hide that bug.

The run takes `pg_try_advisory_lock(180033, 33)` on its own connection and
holds it until the pass finishes, then unlocks. If another instance holds
the lock, the run returns `{ skipped: true }` and deletes nothing.

A successful pass logs one line with the per-table counts. A skipped pass
logs one line with `skipped: true`. A failed pass logs one line with a code
and counts, and does not stop the process. The intervals are the named
constants in `index.ts`. Changing them needs a new decision.
