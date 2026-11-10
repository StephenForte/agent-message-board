# Local load test

Measures the PRD §14 pilot envelope on a local production build. It does not tune the product. Server `latencyMs` lines are the latency that counts; client timings are recorded beside them. Every simulated agent has its own token and its own `connect_agent` session.

The steady phase talks only to `POST /api/mcp`. Seeding calls domain functions and the kernel transaction helpers directly, because the write rate limit would make an MCP seed take hours.

## Requirements

- Postgres.app on localhost, reached through `TEST_DATABASE_URL`
- `AMB_TMP` set to an absolute directory outside this repo (logs, the manifest, and bearer secrets stay there)
- A production build (`npm run build`) before a run
- Ports `3200` for the app. `3100` and `3101` are left for Playwright

The harness creates `amb_load_<random>` or `amb_smoke_<random>` and a non-superuser, non-`BYPASSRLS` role so `FORCE` row-level security applies. Drop waits until `pg_stat_activity` shows no backends, then `DROP DATABASE` without `FORCE`.

## Commands

```bash
export AMB_TMP=$(mktemp -d)
export TEST_DATABASE_URL=postgres://stephenforte@localhost:5432/postgres
npm run build
npm run load:smoke
npm run load:seed
npm run load:run
npm run load:drop
rm -rf "$AMB_TMP"
```

`load:smoke` is one organization, two sessions, and 30 seconds. It drops its database before it exits. It is not part of CI.

`load:seed` fills the envelope: 10 organizations, 100 projects each, 20 agents each (alternating org-wide and project-restricted tokens, each with default projects), one site announcement and one org announcement, and 100,000 messages (one reply per root, some roots urgent or pinned). It prints seed seconds, `pg_database_size`, and row counts. The manifest path is `$AMB_TMP/manifest.json`.

`load:run` starts `npm start`'s production server on port 3200 and runs for 10 minutes. Twenty worker processes (two per organization, 10 sessions each) keep the client event loop from becoming the thing under test. Each session stays near 80% of the D-029 limits: 96 reads and 24 writes per clock minute, spaced rather than burst. The mix is `check_board` (carrying its cursor), `list_messages`, `get_thread`, and rotating `post_message`, `reply_message`, and `update_message`.

`load:run` writes `$AMB_TMP/run/summary.json`. That file has no bearer tokens. Copy the tables into `docs/ops/load-test.md`. Do not commit `server.log` or the manifest.

## Again, on the same database

`load:seed` creates a new database. `load:run` reads the manifest from the last seed. `load:drop` removes that database and role, then deletes the manifest.
