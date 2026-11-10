# Database

The database is `amb-staging-db`, the only one (D-025). It is Render Postgres, major version **18**, region `oregon`, plan `0.1c-256mb`. Postgres 18 is the floor: CI tests `postgres:18` and `render.yaml` pins `postgresMajorVersion: "18"`, because production must run the version CI tests (D-031, amending D-002). A feature new in 17 or 18 still needs a decision before use. The major version cannot be changed after creation ([Blueprint spec](https://render.com/docs/blueprint-spec), [Create and Connect](https://render.com/docs/postgresql-creating-connecting)).

The operator's live resources were created by hand as `Cloud BBS` and `cloud-bbs-db`, not from the Blueprint, so their settings are configured in the dashboard.

The app's `DATABASE_URL` is the database's **internal** connection string (`fromDatabase` / `connectionString`). That URL is the private-network URL, hostname included ([Blueprint spec](https://render.com/docs/blueprint-spec)). The web service and the database are in the same region, which is required for the internal URL ([Create and Connect](https://render.com/docs/postgresql-creating-connecting)).

## Migrations

Migrations run in the web service's pre-deploy command:

```shell
npm run db:migrate
```

That script is `drizzle-kit migrate`. It applies pending files in `drizzle/`. It does not run on web start. `src/lib/server.ts` only checks that the database answers `select 1` before it listens (`src/domain/kernel/README.md`, Health).

Pre-deploy runs after the build and before the new instance takes traffic ([Deploys](https://render.com/docs/deploys#pre-deploy-command)). If the command exits non-zero, Render cancels the deploy. An already-live version keeps serving. There is no separate migration service.

There is no down migration. `package.json` has no rollback script. A bad migration is fixed by a new forward migration on top of the lineage (D-002). Do not edit a migration that has already been applied. Two branches must not each add a migration: drizzle-kit chains snapshots by `prevId`, and only one new migration can land at a time.

`drizzle-kit` is a devDependency. The build command installs devDependencies on purpose so this command can see it. See [deploy.md](deploy.md).

## Connect from a laptop

Use the **external** URL. It is on the database's page in the Dashboard, under **Connect**. The shape is:

```text
postgresql://USER:PASSWORD@EXTERNAL_HOST:PORT/DATABASE
```

External connections are TLS. Render rejects `sslmode=disable`. Add `sslmode=require` ([Create and Connect](https://render.com/docs/postgresql-creating-connecting)):

```shell
psql "postgresql://USER:PASSWORD@EXTERNAL_HOST:PORT/DATABASE?sslmode=require"
```

The Dashboard also offers a **PSQL Command** that is the same connection. The client must support TLS 1.2 or newer.

The external URL is a secret (it contains the password). Do not put it in the repo, a ticket, or a log (D-009). Prefer the internal URL from any Render service in `oregon` on the same account. Internal TLS is optional and the certificate is self-signed, so `verify-full` is not supported. The app uses the internal URL as Render generates it, without an `sslmode` parameter ([Create and Connect](https://render.com/docs/postgresql-creating-connecting)).

`ipAllowList` is omitted, so a new database allows every source address and still requires the password ([Blueprint spec](https://render.com/docs/blueprint-spec)). Tighten that list in the Dashboard when the operator's IPs are known.

## The role the app uses (D-020)

`DATABASE_URL` is the Render-managed default user for that database. The same variable is present for pre-deploy and for `npm start`, so migrations and the running app connect as that user.

The role must not be a superuser and must not have `BYPASSRLS`. Both skip row-level security unconditionally (D-020). Render's docs say the platform does not provide superuser access ([Repacking Postgres Tables](https://render.com/docs/postgresql-pg-repack)). They do not publish `rolbypassrls` for the default user. Confirm both flags on staging, connected as the app's user (the external URL above):

```sql
SELECT rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = current_user;
```

Expected:

```text
 rolsuper | rolbypassrls
----------+--------------
 f        | f
```

`psql -Atc` prints that as `f|f`.

If either column is `t`, stop. The app is not safe to serve traffic on that database. Do not grant `SUPERUSER` or `BYPASSRLS` to fix a query.

### A separate non-owner role

A separate non-owner runtime role is preferred when the host allows it (D-020). Two Render documents bear on that:

- The platform does not provide superuser ([pg_repack](https://render.com/docs/postgresql-pg-repack)).
- A user created with `CREATE USER` is not managed by Render. It does not appear in the Dashboard, and creating it does not replace the default user or the Blueprint connection string ([Database Credential Rotations](https://render.com/docs/postgresql-credentials)).

So the docs describe `CREATE ROLE` / `CREATE USER` as available, and they describe it as something that will **not** take over `DATABASE_URL`. Confirm on staging, still as the default user:

```sql
CREATE ROLE amb_runtime_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
```

Expected: `CREATE ROLE`. Then remove the probe:

```sql
DROP ROLE amb_runtime_probe;
```

Expected: `DROP ROLE`.

If `CREATE ROLE` returns permission denied, a separate role is not available on this database. Record the error. Isolation still holds, for the reason in the next section.

Do not use **New default credential** in the Dashboard as the runtime role. That user becomes the default user, and the Blueprint's `DATABASE_URL` switches to it on the next sync ([Database Credential Rotations](https://render.com/docs/postgresql-credentials)). Migrations would then run as that new user.

This service has one `DATABASE_URL`. Pre-deploy and the web process share it. Pointing only the web process at a non-owner role, while migrating as the owner, needs an application change. That change is outside this Blueprint. Until it exists, the app connects as the owner, and the check above is the one that matters.

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

Expected: `0`.

Tables without row-level security are the ones listed in the kernel README (Better Auth tables, `site_admins`, `organizations`, `owner_activations`). They are outside this count because `relrowsecurity` is false. They are not tenant message data.

## Storage

The database is created with a 15 GB disk. You can raise storage later. You cannot shrink it ([Create and Connect](https://render.com/docs/postgresql-creating-connecting)). Storage autoscaling is left off so a full disk does not silently buy more disk. A database that runs out of storage is suspended. Add storage from the database's Plan page, then resume it. After an increase you cannot increase it again for 6 hours. Details are in that same document.
