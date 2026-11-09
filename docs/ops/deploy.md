# Deploying on Render

This is the first-time path for someone who has not applied a Render Blueprint before. The definition is `render.yaml` at the repo root. Applying it is the operator's step, after this file is on `main`. This repo does not create Render resources by itself.

Read [secrets.md](secrets.md) before you fill in values. Read [database.md](database.md) before you grant the first site admin. Recovery is in [backups.md](backups.md).

## What the Blueprint creates

One Render project, `agent-message-board`, with two environments (D-004). A Hobby workspace allows two environments per project ([pricing](https://render.com/pricing)).

| Environment | Web service | Database |
| --- | --- | --- |
| `staging` | `amb-staging-web` | `amb-staging-db` |
| `prod` | `amb-prod-web` | `amb-prod-db` |

All four resources are in `oregon`. The web service and its database must share a region so the internal database URL works ([Create and Connect to Render Postgres](https://render.com/docs/postgresql-creating-connecting)).

Each web service:

- Node 22, from `NODE_VERSION` (same major as `.nvmrc`). Render's precedence is `NODE_VERSION`, then `.node-version`, then `.nvmrc`, then `package.json` `engines` ([Setting Your Node.js Version](https://render.com/docs/node-version)). `engines` is `>=22` with no upper bound; left alone, Render would resolve that range to the newest Node, which is not 22. The Blueprint sets `NODE_VERSION` so that does not happen.
- Build: `npm ci --include=dev && npm run build`
- Pre-deploy: `npm run db:migrate`
- Start: `npm start`
- Health check: `GET /api/health`
- Auto-deploy: `checksPass`

`npm start` runs `src/lib/server.ts`. It checks configuration, then listens. `next start` and `output: 'standalone'` skip that check (D-019). The Blueprint does not use them.

## Plans and what they cost

Prices are from [Render's pricing page](https://render.com/pricing) as checked for this file. Confirm them there before you apply. Compute is billed per service, prorated to the second. The Hobby workspace subscription is $0.

| Resource | Plan | Why this plan | Price |
| --- | --- | --- | --- |
| Each web service | `0.5c-512mb` | Cheapest paid web plan. The pre-deploy command exists only on paid web services, private services, and background workers ([Deploys](https://render.com/docs/deploys#pre-deploy-command)). The free web plan does not run it, and it also has no shell ([SSH](https://render.com/docs/ssh)). | $7/month each |
| Each database | `0.1c-256mb` | Cheapest paid Postgres plan. Paid Postgres has point-in-time recovery. The free plan does not ([Recovery and Backups](https://render.com/docs/postgresql-backups)). | $6/month each |
| Each database disk | 15 GB | The default disk for `0.1c-256mb` ([Blueprint spec](https://render.com/docs/blueprint-spec)). Set explicitly so a later default change does not resize it. Storage is $0.30/GB ([pricing](https://render.com/pricing)). | $4.50/month each |

Two environments: **$35/month** before bandwidth. Hobby includes 5 GB of bandwidth, then $0.15/GB. Pipeline minutes for builds and pre-deploy are included up to 500 minutes/month on Hobby, then $5 per 1,000 minutes ([Build Pipeline](https://render.com/docs/build-pipeline)).

Network isolation between environments is a Pro workspace feature ($25/month plus compute) and is left off. On Hobby, private-network addresses in the same account and region can reach each other. Each service's `DATABASE_URL` points only at its own database.

## Why the build command installs devDependencies

Render's automatic `NODE_ENV=production` applies at runtime only ([Default Environment Variables](https://render.com/docs/environment-variables)). This Blueprint also sets `NODE_ENV=production` as a service variable. Service variables are present for the build, so `npm ci` would skip `devDependencies`.

`next build` needs TypeScript, Tailwind, and PostCSS. `npm run db:migrate` runs `drizzle-kit`. All of those are `devDependencies`. `--include=dev` installs them even when `NODE_ENV=production`.

The pre-deploy command runs after the build finishes and before that build is deployed ([Deploys](https://render.com/docs/deploys#pre-deploy-command)). It is a pipeline task, on compute separate from the running service ([Build Pipeline](https://render.com/docs/build-pipeline)). Render's own examples invoke the tool the build installed (`bundle exec rails db:migrate` in [Troubleshooting deploys](https://render.com/docs/troubleshooting-deploys)) and do not reinstall dependencies. Filesystem changes made *during* pre-deploy are not copied into the running service. The build's `node_modules`, including `drizzle-kit`, is the tree pre-deploy uses. Do not prune devDependencies in the build command. A local rehearsal of this exact command is in the pull request.

A build of `npm ci && npm run build` with `NODE_ENV=production` fails. That was the negative control in the same rehearsal.

## First apply (staging, and production is created with it)

One apply creates both environments. Fill staging in first and confirm it is healthy before anyone uses production. Production's resources still deploy as part of the same apply.

1. Merge the pull request that adds `render.yaml`. The Blueprint is read from the GitHub repo, not from a laptop ([Blueprint spec](https://render.com/docs/blueprint-spec)).
2. In the [Render Dashboard](https://dashboard.render.com), choose **New → Blueprint**.
3. Connect the GitHub repo `StephenForte/agent-message-board` and the branch `main`. Render should show the project `agent-message-board` and the four resources named above. If it offers to create different names, stop. The names are how `DATABASE_URL` is wired, and several of them cannot be changed after creation (`name`, `region`, `postgresMajorVersion`).
4. Render prompts for every `sync: false` variable, and only on this first create ([Blueprint spec](https://render.com/docs/blueprint-spec)). Fill all six:

   | Service | Key | Value |
   | --- | --- | --- |
   | `amb-staging-web` | `APP_BASE_URL` | `https://amb-staging-web.onrender.com` |
   | `amb-staging-web` | `RESEND_API_KEY` | The staging Resend API key |
   | `amb-staging-web` | `EMAIL_FROM` | A sender address Resend is allowed to use for staging |
   | `amb-prod-web` | `APP_BASE_URL` | `https://amb-prod-web.onrender.com` |
   | `amb-prod-web` | `RESEND_API_KEY` | The production Resend API key |
   | `amb-prod-web` | `EMAIL_FROM` | A sender address Resend is allowed to use for production |

   `APP_BASE_URL` must be `https://` (see `src/env.ts`). Use a distinct Resend key and from-address per environment. `BETTER_AUTH_SECRET` and `CURSOR_HMAC_SECRET` are generated by Render. Leave them generated. Do not paste secrets into the repo, a shell history you keep, or a ticket.

5. Apply the Blueprint. Render creates the databases, then builds and deploys each web service.
6. Open `amb-staging-web` → **Events** (or the deploy log). A healthy first deploy runs, in order:
   - build: `npm ci --include=dev && npm run build` (pipeline, up to 120 minutes)
   - pre-deploy: `npm run db:migrate` (pipeline, up to 30 minutes)
   - start: `npm start` (must listen within 15 minutes)

   If the build or pre-deploy command fails, the deploy stops and nothing is served ([Deploys](https://render.com/docs/deploys)). On a later deploy, the previous successful version keeps serving.

7. Confirm the onrender.com host. The service page shows it. If Render assigned a host other than `amb-staging-web.onrender.com`, open **Environment**, set `APP_BASE_URL` to `https://` plus that host, and choose **Save and deploy**. A later Blueprint sync does not refresh `sync: false` values ([Blueprint spec](https://render.com/docs/blueprint-spec)).

## What healthy looks like

HTTP health checks succeed on any `2xx` or `3xx` within five seconds ([Health Checks](https://render.com/docs/health-checks)). `/api/health` returns `200` and `{"status":"ok"}` when `select 1` works. It returns `503` and `{"status":"unavailable"}` when the database is down. Render will not route traffic to a new instance until the check passes. If it does not pass within 15 minutes, Render cancels the deploy.

From a laptop, after the deploy is **Live**:

```shell
curl -sS -D - "https://amb-staging-web.onrender.com/api/health"
```

Expect a status line of `200` and a body of `{"status":"ok"}`. Use the host from the service page if it differs.

In the service **Logs**, the matching request line is JSON at info level with `route` `/api/health`, `status` `200`, `request_id`, and `latency_ms`. The process listens on `0.0.0.0` and Render's `PORT` (default `10000`, [Default Environment Variables](https://render.com/docs/environment-variables)). Logs must not contain `DATABASE_URL`, tokens, or secret values.

Startup exits before listen if the database is unreachable or a required variable is missing. The log line names the variable keys and does not print their values (`src/lib/server.ts`, `src/env.ts`).

## First site admin

Do this on staging first. The command is `npm run admin:grant -- <email>` (D-006). T03 adds the script. The user must already have signed up and verified that email. The script is not a sign-up form.

1. Open the staging site and create the account with the email you will grant.
2. Finish email verification. Resend must be working (`RESEND_API_KEY` and `EMAIL_FROM`).
3. Open the **Shell** page for `amb-staging-web`. Paid web services have a dashboard shell ([SSH and Shell Access](https://render.com/docs/ssh)). The shell is the deployed service: same code, same environment variables, including `DATABASE_URL`.
4. Run:

   ```shell
   npm run admin:grant -- you@example.com
   ```

   Use the verified email. The shell shares the instance's 512 MB. The command is short. For a longer session, the Render CLI can open an ephemeral shell (`render ssh <service-id> --ephemeral`) that is deleted when you disconnect and is billed for the time it runs ([SSH](https://render.com/docs/ssh)).

5. Sign in again on the staging site and confirm the site-admin path is available. The admin role is a row in `site_admins`. It does not grant read access to board content (D-006).

Repeat for production only after staging is healthy, with the production email and the production service shell. Do not point the production shell at the staging database.

## How production differs

Production is the `prod` environment: `amb-prod-web` and `amb-prod-db`. Same commands, plans, region, Node major, and health check. Different database, different generated secrets, and the three operator values you entered for production.

Give production its own `APP_BASE_URL`, Resend key, and from-address. Rotating or copying staging's `BETTER_AUTH_SECRET` into production ends sessions and is the wrong direction. See [secrets.md](secrets.md).

Auto-deploy is `checksPass` on both services: a commit on the linked branch deploys only after that commit's GitHub checks pass ([Blueprint spec](https://render.com/docs/blueprint-spec)). CI runs on every push (`.github/workflows/ci.yml`). A red `gate` job holds the deploy. `off` would require a manual deploy for every change. `commit` would deploy before CI finishes.

## Later deploys

Push to `main`. When the `gate` check is green, Render builds, runs `npm run db:migrate`, then starts `npm start`. Migrations are not part of process startup ([database.md](database.md)).

To change a `sync: false` value after the first apply, edit it on the service's **Environment** page and deploy. Adding a new `sync: false` key to `render.yaml` later does not prompt again. Set that key in the Dashboard ([Blueprint spec](https://render.com/docs/blueprint-spec)).

## Custom domains

No domain is configured. When one is chosen:

1. Add it on the service's **Settings → Custom Domains** and follow [Custom Domains](https://render.com/docs/custom-domains) for DNS and verification. Render issues the certificate. HTTP redirects to HTTPS.
2. Set `APP_BASE_URL` to `https://` plus that domain and redeploy. The app's own links and cookies follow `APP_BASE_URL`, not the onrender.com host.
3. Leave the onrender.com subdomain enabled until the custom domain loads. Disabling it is `renderSubdomainPolicy: disabled`, and it requires a verified custom domain ([Blueprint spec](https://render.com/docs/blueprint-spec)).

You can also list the domain under `domains` in `render.yaml` once the name is decided. Until then, keep it out of the file.

## Hostname

`src/lib/server.ts` passes `process.env.HOSTNAME` into Next and then listens on `0.0.0.0`. Render's published environment variables do not include `HOSTNAME` ([Default Environment Variables](https://render.com/docs/environment-variables)). The native Node runtime is Debian, not the Docker runtime ([Native Runtimes](https://render.com/docs/native-runtimes)). Next reads `HOSTNAME` when it emits a standalone `server.js`. This app does not use standalone output (`next.config.ts`, D-019). The listen address stays `0.0.0.0`, which is what Render's port scan requires.

A live shell is the way to see whether the process environment contains `HOSTNAME` anyway. If it does, it still does not change the bind address. No application change is required for this Blueprint.
