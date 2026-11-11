import { afterEach, expect, test, vi } from 'vitest';
import {
  RATE_LIMIT_RETENTION_GRACE_MS, RATE_LIMIT_WINDOW_MS, RETENTION_BATCH_SIZE, RETENTION_INTERVAL_MS,
  RETENTION_START_DELAY_MS, SESSION_SEEN_RETENTION_MS, startRetentionTimer,
} from '../../../src/domain/retention';
import { SESSION_SEEN_AUDIT_INTERVAL_MS } from '../../../src/domain/credentials';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('retention intervals are the named constants from D-033', () => {
  expect(SESSION_SEEN_AUDIT_INTERVAL_MS).toBe(15 * 60 * 1000);
  expect(SESSION_SEEN_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  expect(RATE_LIMIT_WINDOW_MS).toBe(60 * 1000);
  expect(RATE_LIMIT_RETENTION_GRACE_MS).toBe(60 * 60 * 1000);
  expect(RETENTION_BATCH_SIZE).toBe(5_000);
  expect(RETENTION_START_DELAY_MS).toBe(3 * 60 * 1000);
  expect(RETENTION_INTERVAL_MS).toBe(60 * 60 * 1000);
});

test('the timer runs after the delay, then hourly, is unrefd, and clears on stop', async () => {
  vi.useFakeTimers();
  let unrefs = 0;
  const spyTimer = (name: 'setTimeout' | 'setInterval') => {
    const real = globalThis[name] as (...args: never[]) => { unref?: () => unknown };
    vi.spyOn(globalThis, name).mockImplementation(((...args: never[]) => {
      const handle = real(...args);
      const unref = handle.unref?.bind(handle);
      if (unref) handle.unref = () => { unrefs += 1; return unref(); };
      return handle;
    }) as never);
  };
  spyTimer('setTimeout');
  spyTimer('setInterval');

  const run = vi.fn(async () => ({ skipped: false, idempotencyRecords: 1, rateLimitWindows: 2, sessionSeen: 3 }));
  const lines: Array<{ severity: string; fields: Record<string, unknown> }> = [];
  const timer = startRetentionTimer({
    run, startDelayMs: RETENTION_START_DELAY_MS, intervalMs: RETENTION_INTERVAL_MS,
    log: (severity, fields) => { lines.push({ severity, fields }); },
  });

  expect(unrefs).toBe(1);
  await vi.advanceTimersByTimeAsync(RETENTION_START_DELAY_MS - 1);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  expect(unrefs).toBe(2);
  expect(lines).toEqual([{
    severity: 'info',
    fields: { operation: 'retention', skipped: false, idempotencyRecords: 1, rateLimitWindows: 2, sessionSeen: 3 },
  }]);

  await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);
  timer.stop();
  await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 3);
  expect(run).toHaveBeenCalledTimes(2);
});

test('a failed run logs a code and counts and the timer stays armed', async () => {
  vi.useFakeTimers();
  const run = vi.fn()
    .mockRejectedValueOnce(new Error('delete from idempotency_records where token = secret'))
    .mockResolvedValueOnce({ skipped: true, idempotencyRecords: 0, rateLimitWindows: 0, sessionSeen: 0 });
  const lines: Array<{ severity: string; fields: Record<string, unknown> }> = [];
  const timer = startRetentionTimer({
    run, startDelayMs: 5_000, intervalMs: 60_000,
    log: (severity, fields) => { lines.push({ severity, fields }); },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(lines).toEqual([{
    severity: 'error',
    fields: { operation: 'retention', code: 'retention_failed', idempotencyRecords: 0, rateLimitWindows: 0, sessionSeen: 0 },
  }]);
  expect(JSON.stringify(lines)).not.toContain('idempotency_records');
  expect(JSON.stringify(lines)).not.toContain('secret');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(lines[1]?.fields).toMatchObject({ operation: 'retention', skipped: true });
  timer.stop();
});
