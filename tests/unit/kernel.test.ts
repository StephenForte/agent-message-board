import { describe, expect, test } from 'vitest';
import { createDatabase } from '../../src/db/client';
import { domainErrorCodes, invalidCursor, rateLimited, versionConflict } from '../../src/domain/kernel/errors';
import { checkDatabase } from '../../src/domain/kernel/health';
import { isUuid, newId } from '../../src/domain/kernel/ids';
import { canonicalJson, sha256Hex } from '../../src/domain/kernel/safe-json';

test('newId returns a UUIDv7', () => {
  const id = newId();
  expect(isUuid(id)).toBe(true);
  expect(id[14]).toBe('7');
  expect(newId()).not.toBe(id);
});

test('domain error codes are the closed D-015 set', () => {
  expect(domainErrorCodes).toEqual([
    'unauthenticated',
    'forbidden_or_not_found',
    'org_suspended',
    'validation_failed',
    'content_too_large',
    'ambiguous_project',
    'no_project_selected',
    'project_archived',
    'thread_archived',
    'version_conflict',
    'idempotency_conflict',
    'invalid_cursor',
    'rate_limited',
    'capability_denied',
    'unavailable',
  ]);
  expect(versionConflict(3, { status: 'active' }).details).toEqual({ currentVersion: 3, state: { status: 'active' } });
  expect(invalidCursor('check again without a cursor').details.resync).toBe('check again without a cursor');
  expect(rateLimited(12).details.retryAfterSeconds).toBe(12);
});

test('canonical json ignores key order', () => {
  expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  expect(sha256Hex('a')).toHaveLength(64);
});

describe('checkDatabase', () => {
  test('returns false for an unreachable database without throwing the URL', async () => {
    const url = 'postgresql://amb_invalid:amb_invalid@127.0.0.1:59999/amb_unreachable';
    const { db, pool } = createDatabase(url);
    try {
      let thrown: unknown;
      try {
        expect(await checkDatabase(db)).toBe(false);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
