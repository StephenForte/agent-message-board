# Backups and recovery

`amb-staging-db` uses the paid plan `0.1c-256mb`. It is the only database (D-025). Paid Render Postgres is backed up continuously for point-in-time recovery. The free plan has no recovery and no logical backups ([Recovery and Backups](https://render.com/docs/postgresql-backups)). Databases are encrypted at rest with AES-256, and that encryption covers backups ([Create and Connect](https://render.com/docs/postgresql-creating-connecting)).

## What this plan provides

From [Recovery and Backups](https://render.com/docs/postgresql-backups) and the [pricing page](https://render.com/pricing):

| Capability | What Render does | Workspace |
| --- | --- | --- |
| Point-in-time recovery | Continuous backup. You restore to a chosen time by creating a new database instance. You cannot restore to the most recent ten minutes. | Recovery window is the past **3 days** on Hobby, **7 days** on Pro or higher. Upgrading the workspace does not backfill the longer window. |
| Logical export | You create an export from the database's Recovery page. Render keeps it for **7 days**. This is not an automatic daily job. | Any workspace. Not available on the free database plan until you upgrade it. |
| Deleted instances | Render does not keep backups of a database you have deleted. Download anything you still need before deleting. | Any |

A restore does not rewind the existing instance in place. Render creates a new instance at the chosen time. You check it, then point services at it, then delete or suspend the old one. Steps, including the Dashboard path (database → Recovery → Restore Database), are in [Recovery and Backups](https://render.com/docs/postgresql-backups).

The internal and external URLs of the new instance are new. `DATABASE_URL` on the web service is wired with `fromDatabase` to `amb-staging-db`. A recovered instance is a different database until you either update that wiring or replace the original. Read the connection strings from the Dashboard. Do not paste them into git.

## How this meets the Phase 1 targets

PRD §14 requires daily automated backups, no more than 24 hours of data loss, and recovery within one business day. D-004 assigns the backups to Render and leaves a restore drill as a launch gate.

Point-in-time recovery is stricter than a daily snapshot. The recovery point can be any time in the window except the last ten minutes, so the data-loss target of 24 hours is met for as long as the window is intact (3 days on Hobby). Recovery is an operator action in the Dashboard, not an automatic failover. Doing it the same business day meets the recovery-time target. The drill that proves the steps on this schema is T15, not this Blueprint.

Logical exports are a second copy you trigger yourself. They are retained for 7 days. They are not the daily automation PRD §14 names. The continuous backup is that automation. Keep an export when you want a file you can download. Restoring an export uses `pg_restore` against an empty database, as in the Render doc. Prefer point-in-time recovery for an incident. An export is older than a point-in-time target by however long it has been since you created it.

High availability (a standby that takes over) is a different feature. It needs a Pro workspace or higher, at least 1 CPU, and Postgres 13 or newer ([Blueprint spec](https://render.com/docs/blueprint-spec)). This database is on `0.1c-256mb`. HA is not configured.

## What T15 still has to do

This file describes the mechanism. It does not demonstrate a restore.

T15's restore drill should, on staging:

1. Note a time, write a row that is safe to throw away, and restore a new instance to a moment before that row.
2. Confirm the row is absent on the new instance and present on the original.
3. Confirm the recovered instance accepts a connection with `sslmode=require` on the external URL, and that `/api/health` can be pointed at it only after `DATABASE_URL` is changed on purpose.
4. Drop the recovered instance when the check is done. Restored instances cost the same plan until they are deleted.

Also still open, and not part of T15's drill unless the planner adds it:

- Alerting beyond Render's built-in health-check notifications ([Health Checks](https://render.com/docs/health-checks)). A failed check restarts a live instance after 60 seconds and cancels a deploy that does not pass within 15 minutes. Nobody is paged by this Blueprint.
- A logical export on a schedule. Render's exports are manual. A cron that runs `pg_dump` is a later decision.
- Load at the PRD §14 pilot envelope.

## Operating notes

- Take a logical export before a risky migration if you want a file as well as the point-in-time window.
- A migration that fails in pre-deploy never becomes the live version ([Deploys](https://render.com/docs/deploys)). That is not a backup. It does not undo a migration that already committed.
- Storage filling up suspends the database ([database.md](database.md)). A suspended database is not serving, and the recovery window only helps if backups were completing before the disk filled. Watch disk usage on the database Metrics page.
