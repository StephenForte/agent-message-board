# Database

The live web service is `Cloud BBS`. The live database is `cloud-bbs-db`. Both were created in the Render Dashboard, not applied from `render.yaml`. `render.yaml` is the source for what the next managed database should look like; it is not how these two resources were created.

The database is Render Postgres, major version **18**, region `oregon`, plan `0.1c-256mb`. Postgres 18 is the floor: CI tests `postgres:18` and `render.yaml` pins `postgresMajorVersion: "18"`, because production must run the version CI tests (D-031, amending D-002). A feature new in 17 or 18 still needs a decision before use. The major version cannot be changed after creation ([Blueprint spec](https://render.com/docs/blueprint-spec), [Create and Connect](https://render.com/docs/postgresql-creating-connecting)).

The app's `DATABASE_URL` is the database's **internal** connection string. That URL is the private-network URL, hostname included ([Blueprint spec](https://render.com/docs/blueprint-spec)). The web service and the database are in the same region, which is required for the internal URL ([Create and Connect](https://render.com/docs/postgresql-creating-connecting)).

The operator reaches `cloud-bbs-db` only from the **Cloud BBS** Render Shell. The laptop does not open a connection to the database. `DATABASE_URL` is already in that shell's environment. It is a secret (D-009). Do not copy it into the repo, a ticket, or a log.

## Migrations

Migrations run in the web service's pre-deploy command:

```shell
npm run db:migrate
```

That script is `drizzle-kit migrate`. It applies pending files in `drizzle/`. It does not run on web start. `src/lib/server.ts` only checks that the database answers `select 1` before it listens (`src/domain/kernel/README.md`, Health).

Pre-deploy runs after the build and before the new instance takes traffic ([Deploys](https://render.com/docs/deploys#pre-deploy-command)). If the command exits non-zero, Render cancels the deploy. An already-live version keeps serving. There is no separate migration service.

There is no down migration. `package.json` has no rollback script. A bad migration is fixed by a new forward migration on top of the lineage (D-002). Do not edit a migration that has already been applied. Two branches must not each add a migration: drizzle-kit chains snapshots by `prevId`, and only one new migration can land at a time.

Migration 0002 adds `organizations.slug` (nullable, unique when set) and `projects.visibility` (`private` or `public`, default `private`). Applied to a database that already has organizations and projects, every existing project becomes `private` and every organization slug stays null. A public page exists only after a site admin sets the organization slug and an owner switches that project to `public`. Anonymous reads go through `withPublicReadTx`, which sets `app.org_id` and then reads only after that project is confirmed public and active. The migration itself publishes nothing.

`drizzle-kit` is a devDependency. The build command installs devDependencies on purpose so this command can see it. See [deploy.md](deploy.md).

## Staging check

Run this in the Cloud BBS Shell. It uses the service's `DATABASE_URL` and does not print that URL.

```shell
node -e 'const {Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const q=async(s)=>(await c.query(s)).rows[0];console.log("server_version:",(await q("show server_version")).server_version);const r=await q("select rolsuper, rolbypassrls from pg_roles where rolname=current_user");console.log("superuser:",r.rolsuper,"| bypassrls:",r.rolbypassrls);console.log("public tables:",(await q("select count(*)::int n from pg_tables where schemaname=\x27public\x27")).n);console.log("rls without force:",(await q("select count(*)::int n from pg_class where relrowsecurity and not relforcerowsecurity and relnamespace=\x27public\x27::regnamespace")).n);try{await c.query("create role amb_runtime_probe nologin nosuperuser nobypassrls");await c.query("drop role amb_runtime_probe");console.log("create role: allowed (probe created and dropped)")}catch(e){console.log("create role: not allowed ("+e.code+")")}await c.end()})().catch((e)=>{console.error("check failed:",e.code||"no code");process.exit(1)})'
```

Expected on staging, recorded 2026-11-10:

```text
server_version: 18.x
superuser: false | bypassrls: false
public tables: 23
rls without force: 0
create role: allowed (probe created and dropped)
```

`create role:` may instead be `create role: not allowed (<sqlstate>)`. Either answer is a recorded result. `18.x` means a Postgres 18 minor. `superuser` and `bypassrls` must both be false.

If either flag is true, stop. The app is not safe to serve traffic on that database. Do not grant `SUPERUSER` or `BYPASSRLS` to fix a query.

## The role the app uses (D-020)

`DATABASE_URL` is the Render-managed default user for that database. The same variable is present for pre-deploy and for `npm start`, so migrations and the running app connect as that user.

The role must not be a superuser and must not have `BYPASSRLS`. Both skip row-level security unconditionally (D-020). Render's docs say the platform does not provide superuser access ([Repacking Postgres Tables](https://render.com/docs/postgresql-pg-repack)). The staging check above is how that is confirmed. `psql` from a laptop is not the path.

### A separate non-owner role

A separate non-owner runtime role is preferred when the host allows it (D-020). Two Render documents bear on that:

- The platform does not provide superuser ([pg_repack](https://render.com/docs/postgresql-pg-repack)).
- A user created with `CREATE USER` is not managed by Render. It does not appear in the Dashboard, and creating it does not replace the default user or the Blueprint connection string ([Database Credential Rotations](https://render.com/docs/postgresql-credentials)).

The staging check's `create role` line is the confirmation. The probe role is created and dropped in the same script, or the script reports the SQLSTATE when `CREATE ROLE` is denied. Isolation still holds when the role cannot be created, for the reason in the next section.

Do not use **New default credential** in the Dashboard as the runtime role. That user becomes the default user, and a Blueprint `DATABASE_URL` switches to it on the next sync ([Database Credential Rotations](https://render.com/docs/postgresql-credentials)). Migrations would then run as that new user.

This service has one `DATABASE_URL`. Pre-deploy and the web process share it. Pointing only the web process at a non-owner role, while migrating as the owner, needs an application change. Until it exists, the app connects as the owner, and the staging check is the one that matters.

### Isolation either way

Tenant tables use `ENABLE` and `FORCE ROW LEVEL SECURITY` (D-020). `FORCE` applies the policies to the table owner, not only to other roles. A missing `app.org_id` matches no tenant rows (`src/domain/kernel/README.md`).

After migrations, this count is the tables in `public` that have row-level security without force:

```sql
SELECT count(*)
FROM pg_class
WHERE relrowsecurity
  AND NOT relforcerowsecurity
  AND relnamespace = 'public'::regnamespace;
```

Expected: `0`. The staging check prints this as `rls without force`.

Tables without row-level security are the ones listed in the kernel README (Better Auth tables, `site_admins`, `organizations`, `owner_activations`). They are outside this count because `relrowsecurity` is false. They are not tenant message data.

## Retention

The web process deletes operational rows that are past their use. It does not delete events, messages, announcements, or audit rows other than session activity.

| Data | Deleted when |
| --- | --- |
| `idempotency_records` | `expires_at` has passed. New rows are stored for 48 hours. |
| `rate_limit_windows` | The one-minute window ended more than one hour ago. The current window stays. |
| `audit_records` with action `agent.session_seen` | The row is older than 30 days. |

`last_seen_at` on the session and the agent still updates on every agent call. The `agent.session_seen` audit row is written at most once per session per 15 minutes (`agent_sessions.last_seen_audited_at`).

The timer lives in the web process. The first run is three minutes after the server listens, then every hour. It does not keep the process alive, and SIGTERM or SIGINT clears it before shutdown. One instance runs at a time, using `pg_try_advisory_lock(180033, 33)`. Each organization is purged in batches of 5,000 rows with `app.org_id` set, so row-level security applies. There is no Render cron job. Changing the intervals needs a new decision.

## Storage

The database disk is **10 GB**. You can raise storage later. You cannot shrink it ([Create and Connect](https://render.com/docs/postgresql-creating-connecting)). Storage autoscaling is left off so a full disk does not silently buy more disk. A database that runs out of storage is suspended. Add storage from the database's Plan page, then resume it. After an increase you cannot increase it again for 6 hours. Details are in that same document.
