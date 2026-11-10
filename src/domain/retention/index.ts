import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { getDb } from '../../db/client';
import { organizations } from '../../db/schema/org';
import { DomainError, withOrgMaintenanceTx } from '../kernel';

/** `agent.session_seen` rows older than this are deleted. Every other audit action is kept. */
export const SESSION_SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** D-029 windows are one minute. A row is eligible once that window has ended. */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** Keep rate-limit rows until the window has been over for this long. The open window stays. */
export const RATE_LIMIT_RETENTION_GRACE_MS = 60 * 60 * 1000;
/** Rows removed per DELETE so one statement does not hold locks for long. */
export const RETENTION_BATCH_SIZE = 5_000;
/** First purge after listen. The process is already serving by then. */
export const RETENTION_START_DELAY_MS = 3 * 60 * 1000;
/** How often the web process runs retention after the first delay. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Session advisory lock so two web processes do not purge at once.
 * `select pg_try_advisory_lock(180033, 33)`.
 */
export const RETENTION_ADVISORY_LOCK_CLASS_ID = 180033;
export const RETENTION_ADVISORY_LOCK_OBJECT_ID = 33;
/** Must match the action `resolveAgentSession` writes. */
export const SESSION_SEEN_AUDIT_ACTION = 'agent.session_seen';

export type RetentionCounts = {
  idempotencyRecords: number;
  rateLimitWindows: number;
  sessionSeen: number;
};

export type RetentionReport = RetentionCounts & { skipped: boolean };

const emptyCounts = (): RetentionCounts => ({ idempotencyRecords: 0, rateLimitWindows: 0, sessionSeen: 0 });

/** A purge that threw. `message` is the code only; the cause is not logged. */
export class RetentionFailure extends Error {
  readonly code = 'retention_failed';
  constructor(readonly counts: RetentionCounts, cause?: unknown) {
    super('retention_failed');
    this.name = 'RetentionFailure';
    if (cause !== undefined) this.cause = cause;
  }
}

export type RetentionOptions = {
  now?: Date;
  batchSize?: number;
};

/**
 * Deletes expired retry rows, old rate-limit windows, and old session-activity
 * audit rows for every organization. One instance at a time. A run that cannot
 * take the advisory lock returns `skipped: true` and deletes nothing.
 */
export async function runRetention(options: RetentionOptions = {}): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100_000) {
    throw new DomainError('validation_failed', { field: 'batchSize' });
  }
  const counts = emptyCounts();
  let held = false;
  try {
    held = await withRetentionLock(async () => {
      const orgs = await getDb().select({ id: organizations.id }).from(organizations);
      for (const org of orgs) {
        await deleteBatches(org.id, batchSize, (tx) => deleteIdempotency(tx, org.id, now, batchSize), (n) => { counts.idempotencyRecords += n; });
        await deleteBatches(org.id, batchSize, (tx) => deleteRateLimits(tx, org.id, now, batchSize), (n) => { counts.rateLimitWindows += n; });
        await deleteBatches(org.id, batchSize, (tx) => deleteSessionSeen(tx, org.id, now, batchSize), (n) => { counts.sessionSeen += n; });
      }
    });
  } catch (error) {
    throw new RetentionFailure({ ...counts }, error);
  }
  if (!held) return { skipped: true, ...emptyCounts() };
  return { skipped: false, ...counts };
}

async function deleteBatches(
  orgId: string,
  batchSize: number,
  batch: (tx: DbTx) => Promise<number>,
  add: (deleted: number) => void,
): Promise<void> {
  for (;;) {
    const deleted = await withOrgMaintenanceTx(orgId, batch);
    add(deleted);
    if (deleted < batchSize) return;
  }
}

async function deleteIdempotency(tx: DbTx, orgId: string, now: Date, batchSize: number): Promise<number> {
  const limit = sql.raw(String(batchSize));
  const result = await tx.execute(sql`
    with doomed as (
      select id from idempotency_records
      where org_id = ${orgId}::uuid
        and expires_at < ${now}::timestamptz
      limit ${limit}
    )
    delete from idempotency_records
    where id in (select id from doomed)
    returning id
  `);
  return affected(result);
}

async function deleteRateLimits(tx: DbTx, orgId: string, now: Date, batchSize: number): Promise<number> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_RETENTION_GRACE_MS - RATE_LIMIT_WINDOW_MS);
  const limit = sql.raw(String(batchSize));
  const result = await tx.execute(sql`
    with doomed as (
      select org_id, token_id, bucket, window_start
      from rate_limit_windows
      where org_id = ${orgId}::uuid
        and window_start < ${cutoff}::timestamptz
      limit ${limit}
    )
    delete from rate_limit_windows as windows
    using doomed
    where windows.org_id = doomed.org_id
      and windows.token_id = doomed.token_id
      and windows.bucket = doomed.bucket
      and windows.window_start = doomed.window_start
    returning windows.org_id
  `);
  return affected(result);
}

async function deleteSessionSeen(tx: DbTx, orgId: string, now: Date, batchSize: number): Promise<number> {
  const cutoff = new Date(now.getTime() - SESSION_SEEN_RETENTION_MS);
  const limit = sql.raw(String(batchSize));
  const result = await tx.execute(sql`
    with doomed as (
      select id from audit_records
      where org_id = ${orgId}::uuid
        and action = ${SESSION_SEEN_AUDIT_ACTION}
        and created_at < ${cutoff}::timestamptz
      limit ${limit}
    )
    delete from audit_records
    where id in (select id from doomed)
    returning id
  `);
  return affected(result);
}

function affected(result: unknown): number {
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) return result.rows.length;
  if (result && typeof result === 'object' && 'rowCount' in result && typeof result.rowCount === 'number') return result.rowCount;
  throw new Error('retention_failed');
}

/** Holds the lock on its own connection for the whole run, then unlocks it. */
async function withRetentionLock(fn: () => Promise<void>): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new RetentionFailure(emptyCounts());
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined);
  await client.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1::int, $2::int) as locked',
      [RETENTION_ADVISORY_LOCK_CLASS_ID, RETENTION_ADVISORY_LOCK_OBJECT_ID],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return false;
    await fn();
    return true;
  } finally {
    if (locked) {
      await client.query('select pg_advisory_unlock($1::int, $2::int)', [
        RETENTION_ADVISORY_LOCK_CLASS_ID, RETENTION_ADVISORY_LOCK_OBJECT_ID,
      ]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

export type RetentionLog = (severity: 'info' | 'error', fields: Record<string, unknown>) => void;

/**
 * First run after `startDelayMs`, then every `intervalMs`. Both timers are
 * unref'd. `stop` clears them; an in-flight run is allowed to finish.
 */
export function startRetentionTimer(options: {
  run?: () => Promise<RetentionReport>;
  log?: RetentionLog;
  startDelayMs?: number;
  intervalMs?: number;
} = {}): { stop: () => void } {
  const run = options.run ?? (() => runRetention());
  const log = options.log ?? ((severity, fields) => {
    console.log(JSON.stringify({ level: severity, ...fields, time: new Date().toISOString() }));
  });
  const startDelayMs = options.startDelayMs ?? RETENTION_START_DELAY_MS;
  const intervalMs = options.intervalMs ?? RETENTION_INTERVAL_MS;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    void Promise.resolve().then(run).then(
      (report) => log('info', {
        operation: 'retention',
        skipped: report.skipped,
        idempotencyRecords: report.idempotencyRecords,
        rateLimitWindows: report.rateLimitWindows,
        sessionSeen: report.sessionSeen,
      }),
      (error: unknown) => log('error', failureFields(error)),
    );
  };
  const starter = setTimeout(() => {
    if (stopped) return;
    tick();
    interval = setInterval(() => { if (!stopped) tick(); }, intervalMs);
    interval.unref();
  }, startDelayMs);
  starter.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(starter);
      if (interval) clearInterval(interval);
    },
  };
}

function failureFields(error: unknown): Record<string, unknown> {
  const counts = error instanceof RetentionFailure ? error.counts : emptyCounts();
  const code = error instanceof RetentionFailure ? error.code
    : error instanceof DomainError ? error.code
      : 'retention_failed';
  return { operation: 'retention', code, ...counts };
}
