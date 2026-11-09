# Secrets and environment variables

Nothing in `render.yaml` is a secret value. Generated secrets and operator secrets are stored on the service. Do not print them, put them in a URL, or commit them (D-009).

`src/env.ts` is the startup check. In production it requires every key below that the schema lists, requires `APP_BASE_URL` to start with `https://`, and rejects a secret whose value matches `dev`, `example`, `change-me`, or `placeholder`. The error names the key and does not include the value. T03 adds `RESEND_API_KEY` and `EMAIL_FROM` to that check (D-024). Set them now so the first production boot after T03 does not refuse to start.

Render's own `NODE_ENV=production` is applied at runtime only ([Default Environment Variables](https://render.com/docs/environment-variables)). The Blueprint sets `NODE_ENV` itself so the build and the process agree. See [deploy.md](deploy.md) for why that changes `npm ci`.

## Who sets each key

| Key | Set by | Where | Value |
| --- | --- | --- | --- |
| `NODE_VERSION` | Blueprint | `value: "22"` | Node major. Matches `.nvmrc`. Not a secret. [Node version](https://render.com/docs/node-version). |
| `NODE_ENV` | Blueprint | `value: production` | Must be `production` on Render. |
| `LOG_LEVEL` | Blueprint | `value: info` | One of `debug`, `info`, `warn`, `error`, `silent`. |
| `DATABASE_URL` | Blueprint, from the database | `fromDatabase` `connectionString` | Internal URL. Render refreshes it on Blueprint sync when the referenced property changes ([Blueprint spec](https://render.com/docs/blueprint-spec)). |
| `BETTER_AUTH_SECRET` | Render, once | `generateValue: true` | A new base64-encoded 256-bit value when the variable does not already exist. The documented shape is 44 characters, for example `B0jrphAPOY7pg92AN0c9MN4yecczLMdwnx4OkA1KFUk=` ([Blueprint spec](https://render.com/docs/blueprint-spec)). `src/env.ts` requires at least 32 characters. |
| `CURSOR_HMAC_SECRET` | Render, once | `generateValue: true` | A second, independent 256-bit value. Do not reuse `BETTER_AUTH_SECRET`. |
| `APP_BASE_URL` | Operator | `sync: false` | Public `https://` origin. Staging and production differ. |
| `RESEND_API_KEY` | Operator | `sync: false` | Resend API key for that environment. |
| `EMAIL_FROM` | Operator | `sync: false` | From address Resend is allowed to send as, for that environment. |
| `PORT` | Render | Platform default `10000` | Do not set this in the Blueprint. `src/lib/server.ts` reads it and binds `0.0.0.0`. [Default Environment Variables](https://render.com/docs/environment-variables). |

`generateValue` does not rotate a variable that already has a value ([Blueprint spec](https://render.com/docs/blueprint-spec)). `sync: false` is asked for only during the first Blueprint create. Later syncs ignore those keys. Change them on the service **Environment** page.

Staging and production each get their own generated secrets and their own operator values. Do not copy one environment's values into the other.

If a generated secret happens to contain `dev`, `example`, `change-me`, or `placeholder`, production startup refuses that key. Generate a replacement of at least 32 characters and set it on the Environment page. Do not put the replacement in git.

## Rotation

Change a value on the service's **Environment** page. Choose **Save and deploy** so the running process picks it up ([Environment Variables and Secrets](https://render.com/docs/configure-environment-variables)). A "save only" leaves the old value in the live process until the next deploy.

### `BETTER_AUTH_SECRET`

Generate a new value of at least 32 characters. `openssl rand -base64 32` is the same 256-bit base64 shape Render uses for `generateValue`. Set it on that service and redeploy. Do not commit it.

Existing sessions stop working. People sign in again. Password hashes in the database stay valid. The other environment is unaffected.

### `CURSOR_HMAC_SECRET`

Same procedure, and a different value from `BETTER_AUTH_SECRET`.

Clients that still hold a cursor signed with the old secret get `invalid_cursor` and must resync. That is the expected failure, not a data loss. In-flight cursors from before the deploy are discarded.

### `DATABASE_URL`

Prefer Render's credential rotation so the Blueprint stays the source of the URL ([Database Credential Rotations](https://render.com/docs/postgresql-credentials)):

1. Add a new default credential on the database.
2. Sync the Blueprint so `fromDatabase` picks up the new connection string.
3. Redeploy the web service.
4. Confirm `pg_stat_activity` no longer shows the old user, then delete the old credential.

The docs note that Render does not fully delete the original user. It revokes login, because that user may own objects.

A manual paste of a connection string over the `fromDatabase` value will be replaced on the next Blueprint sync. Do that only for a recovery instance, and expect the next sync to point back at `amb-staging-db` or `amb-prod-db`.

Rotating the database password drops connections that used the old password. The site returns 503 from `/api/health` until the new URL is deployed. Messages already committed stay in the database.

### `APP_BASE_URL`

Set the new `https://` origin and redeploy. Do this when the onrender.com host differs from the name you guessed, and when a custom domain is verified ([deploy.md](deploy.md)). Session cookies are for the host the browser used. Users on the old host sign in again on the new one.

### `RESEND_API_KEY`

Create a new key in Resend, set it on the service, redeploy, then revoke the old key. Until the new key is deployed, verification and password-reset mail fail. The app does not log the key.

### `EMAIL_FROM`

Set the new address and redeploy. Resend must allow that sender. Mail from the old address stops when the new deploy is live.

### `NODE_VERSION`, `NODE_ENV`, `LOG_LEVEL`

These are not secrets. Change them in `render.yaml` and sync the Blueprint. Changing `NODE_VERSION` changes the runtime on the next build. Keep it on the same major as `.nvmrc`.

## What a later Blueprint sync will not do

- It will not regenerate `BETTER_AUTH_SECRET` or `CURSOR_HMAC_SECRET`.
- It will not ask again for `APP_BASE_URL`, `RESEND_API_KEY`, or `EMAIL_FROM`.
- It will refresh `DATABASE_URL` from the database's current internal connection string.
- It will leave environment variables that this file does not mention. Omission does not delete them ([Blueprint spec](https://render.com/docs/blueprint-spec)).
