import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { dropLoadDatabase, growthSnapshot, ownerUrl, type GrowthSnapshot } from './database';
import { scratchDir, sleep } from './scratch';
import { SMOKE_ENVELOPE, seedEnvelope } from './seed';
import { loadSamples, parseServerLine, perDay, readJsonLines, summarize, type TimedSample, type ToolStats } from './stats';
import type { LoadManifest } from './types';

const PORT = Number(process.env.LOAD_PORT ?? 3200);
const READS = new Set(['check_board', 'list_messages', 'get_thread']);
const WRITES = new Set(['post_message', 'reply_message', 'update_message']);

type LockSample = {
  at: string;
  backends: number;
  lockWaiters: number;
  counterWaiters: number;
  counterMaxQueryAgeSec: number;
  byRelation: Array<{ relation: string; waiters: number; maxQueryAgeSec: number }>;
};

function tsxBin(): string {
  return join(process.cwd(), 'node_modules', '.bin', 'tsx');
}

function serverEnv(manifest: LoadManifest, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    HOSTNAME: '0.0.0.0',
    __NEXT_PRIVATE_ORIGIN: `http://127.0.0.1:${port}`,
    DATABASE_URL: manifest.runtimeUrl,
    BETTER_AUTH_SECRET: 'b'.repeat(48),
    CURSOR_HMAC_SECRET: 'c'.repeat(48),
    APP_BASE_URL: `https://127.0.0.1:${port}/`,
    LOG_LEVEL: 'info',
    RESEND_API_KEY: 're_load_fixture',
    EMAIL_FROM: 'Board <board@example.test>',
  };
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* process still booting */ }
    await sleep(500);
  }
  throw new Error(`production server did not answer on port ${port}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) child.kill('SIGKILL');
}

async function sampleLocks(client: pg.Client): Promise<LockSample> {
  const backends = await client.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where datname = current_database()');
  const waiting = await client.query<{ waiters: number }>(
    `select count(distinct pid)::int as waiters from pg_stat_activity
     where datname = current_database() and wait_event_type = 'Lock'`,
  );
  const counter = await client.query<{ waiters: number; max_age: string }>(
    `select count(distinct a.pid)::int as waiters,
            coalesce(max(extract(epoch from (clock_timestamp() - a.query_start))), 0)::text as max_age
     from pg_stat_activity a
     where a.datname = current_database() and a.wait_event_type = 'Lock'
       and exists (
         select 1 from pg_locks held
         join pg_class c on c.oid = held.relation
         where held.granted and held.pid = any (pg_blocking_pids(a.pid)) and c.relname = 'org_event_counters'
       )`,
  );
  const relations = await client.query<{ relation: string; waiters: number; max_age: string }>(
    `select coalesce(c.relname, waiting.locktype) as relation,
            count(distinct a.pid)::int as waiters,
            coalesce(max(extract(epoch from (clock_timestamp() - a.query_start))), 0)::text as max_age
     from pg_stat_activity a
     join pg_locks waiting on waiting.pid = a.pid and not waiting.granted
     left join lateral (
       select held.relation from pg_locks held
       where held.granted and held.pid = any (pg_blocking_pids(a.pid)) and held.relation is not null
       limit 1
     ) blocker on true
     left join pg_class c on c.oid = coalesce(waiting.relation, blocker.relation)
     where a.datname = current_database() and a.wait_event_type = 'Lock'
     group by 1`,
  );
  return {
    at: new Date().toISOString(),
    backends: backends.rows[0]?.n ?? 0,
    lockWaiters: waiting.rows[0]?.waiters ?? 0,
    counterWaiters: counter.rows[0]?.waiters ?? 0,
    counterMaxQueryAgeSec: Number(counter.rows[0]?.max_age ?? 0),
    byRelation: relations.rows.map((row) => ({
      relation: row.relation, waiters: row.waiters, maxQueryAgeSec: Number(row.max_age),
    })),
  };
}

function sideStats(samples: TimedSample[], names: Set<string>): ToolStats {
  return summarize(samples.filter((sample) => names.has(sample.tool)));
}

async function execute(manifest: LoadManifest, options: { durationSec: number; workersPerOrg: number; port: number }): Promise<void> {
  if (!existsSync(join(process.cwd(), '.next', 'BUILD_ID'))) throw new Error('npm run build is required before the load run');
  const runDir = join(scratchDir(), manifest.smoke ? 'smoke-run' : 'run');
  // A leftover stop file halts the next run immediately, and leftover ready-* files look connected.
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const logFd = openSync(join(runDir, 'server.log'), 'w');
  const server = spawn(tsxBin(), ['src/lib/server.ts'], {
    cwd: process.cwd(), env: serverEnv(manifest, options.port), stdio: ['ignore', logFd, logFd],
  });
  const workers: ChildProcess[] = [];
  const sampler = new pg.Client({ connectionString: ownerUrl(manifest) });
  sampler.on('error', () => undefined);
  let sampling = false;
  try {
    await waitForHealth(options.port);
    const before = await growthSnapshot(manifest);
    const workerCount = manifest.orgs.length * options.workersPerOrg;
    for (let index = 0; index < workerCount; index++) {
      const child = spawn(tsxBin(), ['load/worker.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MANIFEST_PATH: join(scratchDir(), manifest.smoke ? 'smoke-manifest.json' : 'manifest.json'),
          RUN_DIR: runDir,
          ENDPOINT: `http://127.0.0.1:${options.port}/api/mcp`,
          WORKER_INDEX: String(index),
          WORKERS_PER_ORG: String(options.workersPerOrg),
        },
        stdio: ['ignore', 'ignore', openSync(join(runDir, `worker-${index}.err`), 'w')],
      });
      workers.push(child);
    }
    const connectDeadline = Date.now() + 120_000;
    for (;;) {
      const ready = readdirSync(runDir).filter((name) => name.startsWith('ready-')).length;
      const failed = workers.filter((worker) => worker.exitCode !== null && worker.exitCode !== 0);
      if (failed.length) throw new Error(`${failed.length} worker processes exited before the run`);
      if (ready >= workerCount) break;
      if (Date.now() > connectDeadline) throw new Error(`only ${ready} of ${workerCount} workers connected`);
      await sleep(200);
    }
    const startMs = manifest.smoke ? Date.now() + 1_000 : (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 1_000;
    const stopMs = startMs + options.durationSec * 1_000;
    const goPath = join(runDir, 'go.json');
    const partial = `${goPath}.partial`;
    writeFileSync(partial, JSON.stringify({ startMs, stopMs }));
    renameSync(partial, goPath);
    await sampler.connect();
    sampling = true;
    const locks: LockSample[] = [];
    const untilStart = startMs - Date.now();
    if (untilStart > 0) await sleep(untilStart);
    while (Date.now() < stopMs) {
      try { locks.push(await sampleLocks(sampler)); } catch { /* one missed sample does not end the run */ }
      await sleep(1_000);
    }
    writeFileSync(join(runDir, 'stop'), 'stop');
    const workerDeadline = Date.now() + 60_000;
    while (workers.some((worker) => worker.exitCode === null) && Date.now() < workerDeadline) await sleep(200);
    for (const worker of workers) if (worker.exitCode === null) await stopProcess(worker);
    const analysisEnd = Date.now();
    const finalWorker = spawn(tsxBin(), ['load/worker.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env, MODE: 'final',
        MANIFEST_PATH: join(scratchDir(), manifest.smoke ? 'smoke-manifest.json' : 'manifest.json'),
        RUN_DIR: runDir, ENDPOINT: `http://127.0.0.1:${options.port}/api/mcp`,
      },
      stdio: ['ignore', 'ignore', openSync(join(runDir, 'final.err'), 'w')],
    });
    const finalDeadline = Date.now() + 120_000;
    while (finalWorker.exitCode === null && Date.now() < finalDeadline) await sleep(200);
    if (finalWorker.exitCode === null) await stopProcess(finalWorker);
    await stopProcess(server);
    closeSync(logFd);
    sampling = false;
    await sampler.end();
    const after = await growthSnapshot(manifest);
    const summary = await buildSummary({
      manifest, runDir, before, after, locks, startMs, analysisEnd, durationSec: options.durationSec,
      workersPerOrg: options.workersPerOrg, port: options.port,
    });
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({
      phase: 'run-done', smoke: manifest.smoke, durationSec: summary.durationSec,
      serverReadsPerSec: summary.serverReadsPerSec, serverWritesPerSec: summary.serverWritesPerSec,
      readP95Ms: summary.reads.server.p95, writeP95Ms: summary.writes.server.p95,
      passReads: summary.passReads, passWrites: summary.passWrites,
      unavailable: summary.unavailable, http5xx: summary.http5xx, rateLimited: summary.rateLimited,
      maxLockWaiters: summary.maxLockWaiters, maxLockRelation: summary.maxLockRelation,
      counterWaiters: summary.maxCounterWaiters, counterQueryAgeSec: summary.maxCounterQueryAgeSec,
    }));
  } finally {
    writeFileSync(join(runDir, 'stop'), 'stop');
    for (const worker of workers) if (worker.exitCode === null) worker.kill('SIGTERM');
    if (server.exitCode === null) server.kill('SIGTERM');
    if (sampling) await sampler.end().catch(() => undefined);
  }
}

async function buildSummary(input: {
  manifest: LoadManifest; runDir: string; before: GrowthSnapshot; after: GrowthSnapshot;
  locks: LockSample[]; startMs: number; analysisEnd: number; durationSec: number;
  workersPerOrg: number; port: number;
}) {
  const serverLines = await readJsonLines(join(input.runDir, 'server.log'));
  const serverTools: TimedSample[] = [];
  let http5xx = 0;
  for (const line of serverLines) {
    const parsed = parseServerLine(line);
    if (!parsed || parsed.at < input.startMs || parsed.at > input.analysisEnd) continue;
    if (parsed.kind === 'http') {
      if (parsed.route.includes('/api/mcp') && parsed.status >= 500) http5xx += 1;
      continue;
    }
    serverTools.push({ tool: parsed.tool, ms: parsed.ms, ok: parsed.outcome === 'ok', code: parsed.outcome === 'ok' ? null : parsed.outcome, at: parsed.at });
  }
  const timingPaths = readdirSync(input.runDir).filter((name) => /^timing-\d+\.jsonl$/.test(name)).map((name) => join(input.runDir, name));
  const clientTools = (await loadSamples(timingPaths)).filter((sample) => sample.at >= input.startMs && sample.at <= input.analysisEnd);
  const durationSec = (input.analysisEnd - input.startMs) / 1_000;
  const tools = [...READS, ...WRITES];
  const perTool: Record<string, { server: ToolStats; client: ToolStats }> = {};
  for (const tool of tools) {
    perTool[tool] = {
      server: summarize(serverTools.filter((sample) => sample.tool === tool)),
      client: summarize(clientTools.filter((sample) => sample.tool === tool)),
    };
  }
  const reads = { server: sideStats(serverTools, READS), client: sideStats(clientTools, READS) };
  const writes = { server: sideStats(serverTools, WRITES), client: sideStats(clientTools, WRITES) };
  const unavailable = serverTools.filter((sample) => sample.code === 'unavailable').length;
  const rateLimited = serverTools.filter((sample) => sample.code === 'rate_limited').length;
  let maxLockWaiters = 0;
  let maxLockRelation = 'none';
  let maxCounterWaiters = 0;
  let maxCounterQueryAgeSec = 0;
  let maxBackends = 0;
  for (const sample of input.locks) {
    maxBackends = Math.max(maxBackends, sample.backends);
    maxCounterWaiters = Math.max(maxCounterWaiters, sample.counterWaiters);
    maxCounterQueryAgeSec = Math.max(maxCounterQueryAgeSec, sample.counterMaxQueryAgeSec);
    if (sample.lockWaiters > maxLockWaiters) {
      maxLockWaiters = sample.lockWaiters;
      maxLockRelation = sample.byRelation.sort((a, b) => b.waiters - a.waiters)[0]?.relation ?? 'unattributed';
    }
  }
  const metas = readdirSync(input.runDir).filter((name) => name.endsWith('-meta.json')).map((name) => JSON.parse(readFileSync(join(input.runDir, name), 'utf8')) as { maxCpuPercent: number; maxEventLoopLagMs: number });
  const finalPath = join(input.runDir, 'final.json');
  const finalChecks = existsSync(finalPath) ? JSON.parse(readFileSync(finalPath, 'utf8')) as unknown[] : [];
  const finalServerChecks = summarize(serverLines.flatMap((line) => {
    const parsed = parseServerLine(line);
    if (!parsed || parsed.kind !== 'tool' || parsed.tool !== 'check_board' || parsed.at <= input.analysisEnd) return [];
    return [{ tool: parsed.tool, ms: parsed.ms, ok: parsed.outcome === 'ok', code: parsed.outcome === 'ok' ? null : parsed.outcome, at: parsed.at }];
  }));
  const growth = (key: keyof GrowthSnapshot['counts']) => ({
    before: input.before.counts[key], after: input.after.counts[key],
    perDay: perDay(input.before.counts[key], input.after.counts[key], durationSec),
  });
  const relation = (name: string) => ({
    before: input.before.relations[name] ?? 0, after: input.after.relations[name] ?? 0,
    perDay: perDay(input.before.relations[name] ?? 0, input.after.relations[name] ?? 0, durationSec),
  });
  return {
    commit: input.manifest.commit,
    smoke: input.manifest.smoke,
    serverVersion: input.manifest.serverVersion,
    port: input.port,
    workersPerOrg: input.workersPerOrg,
    seed: { seconds: input.manifest.seedSeconds, databaseBytes: input.manifest.databaseBytes, counts: input.manifest.counts },
    durationSec, requestedDurationSec: input.durationSec,
    serverReadsPerSec: reads.server.count / durationSec,
    serverWritesPerSec: writes.server.count / durationSec,
    clientReadsPerSec: reads.client.count / durationSec,
    clientWritesPerSec: writes.client.count / durationSec,
    tools: perTool, reads, writes,
    passReads: (reads.server.p95 ?? Infinity) < 1_000,
    passWrites: (writes.server.p95 ?? Infinity) < 1_000,
    unavailable, rateLimited, http5xx,
    maxLockWaiters, maxLockRelation, maxCounterWaiters, maxCounterQueryAgeSec, maxBackends,
    lockSamples: input.locks.length,
    workerMaxCpuPercent: metas.reduce((max, meta) => Math.max(max, meta.maxCpuPercent), 0),
    workerMaxEventLoopLagMs: metas.reduce((max, meta) => Math.max(max, meta.maxEventLoopLagMs), 0),
    finalChecks, finalServerChecks,
    growth: {
      databaseBytes: { before: input.before.databaseBytes, after: input.after.databaseBytes, perDay: perDay(input.before.databaseBytes, input.after.databaseBytes, durationSec) },
      auditRecords: growth('auditRecords'), sessionSeen: growth('sessionSeen'),
      rateLimitWindows: growth('rateLimitWindows'), events: growth('events'),
      idempotencyRecords: growth('idempotencyRecords'), messages: growth('messages'),
      relationBytes: {
        audit_records: relation('audit_records'), rate_limit_windows: relation('rate_limit_windows'),
        events: relation('events'), idempotency_records: relation('idempotency_records'), messages: relation('messages'),
      },
    },
    hardware: 'Apple M3 Max, 14 cores, 36 GB; Postgres.app 18 on localhost. Much faster than Render 0.5 CPU / 512 MB web and 0.1 CPU / 256 MB database.',
  };
}

async function main(): Promise<void> {
  const smoke = process.argv.includes('--smoke');
  const directory = scratchDir();
  if (smoke) {
    const manifestPath = join(directory, 'smoke-manifest.json');
    const manifest = await seedEnvelope(SMOKE_ENVELOPE, manifestPath);
    try {
      await execute(manifest, { durationSec: 30, workersPerOrg: 1, port: PORT });
    } finally {
      await dropLoadDatabase(manifest);
    }
    return;
  }
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('missing manifest; run npm run load:seed first');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LoadManifest;
  await execute(manifest, { durationSec: 600, workersPerOrg: 2, port: PORT });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'load run failed';
    console.error(message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]').replace(/amb_[A-Za-z0-9]+_[A-Za-z0-9]+/g, '[redacted]'));
    process.exit(1);
  });
}
