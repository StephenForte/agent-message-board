import { vi } from 'vitest';
import { describe, expect, test } from 'vitest';
import { DomainError, versionConflict } from '../../../src/domain/kernel';
import { auditScope, decodeAuditCursor, encodeAuditCursor } from '../../../src/domain/auditlog/cursor';
import { actorLabel, summarizeChange } from '../../../src/domain/auditlog/summary';
import { domainFailure } from '../../../src/app/(app)/domain-message';
import { newId } from '../../../src/domain/kernel/ids';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgres://localhost/amb');

test('actor label names a human, or an agent with its token prefix', () => {
  expect(actorLabel('human', 'Ada', null)).toBe('Human, Ada');
  expect(actorLabel('human', null, null)).toBe('Human');
  expect(actorLabel('agent', 'worker', 'abcd1234')).toBe('Agent worker, token abcd1234');
  expect(actorLabel('agent', null, null)).toBe('Agent');
  expect(actorLabel('system', null, null)).toBe('System');
});

test('change summary lists before and after without implying a live status', () => {
  expect(summarizeChange(null, null)).toBe('No field changes recorded.');
  expect(summarizeChange({ status: 'active' }, { status: 'archived', name: 'Board' })).toBe('name: empty to "Board"; status: "active" to "archived"');
  expect(summarizeChange({ version: 1 }, { version: 1 }).includes('running')).toBe(false);
});

test('audit cursors are scoped to the org and the session-activity flag', () => {
  const id = newId();
  const scope = auditScope('org-a', false);
  const cursor = encodeAuditCursor(scope, { at: '2026-11-09T00:00:00.000000Z', id });
  expect(decodeAuditCursor(cursor, scope)).toEqual({ at: '2026-11-09T00:00:00.000000Z', id });
  expect(() => decodeAuditCursor(cursor, auditScope('org-b', false))).toThrow(DomainError);
  expect(() => decodeAuditCursor(cursor, auditScope('org-a', true))).toThrow(DomainError);
  expect(() => decodeAuditCursor(`${cursor}x`, scope)).toThrow(DomainError);
  expect(() => decodeAuditCursor(undefined, scope)).not.toThrow();
});

describe('domain failure text', () => {
  test('maps slug errors onto the field and hides driver errors', () => {
    expect(domainFailure(new DomainError('validation_failed', { field: 'slug' }))).toMatchObject({ field: 'slug' });
    expect(domainFailure(new DomainError('forbidden_or_not_found')).notFound).toBe(true);
    expect(domainFailure(new DomainError('org_suspended')).redirect).toBe('/suspended');
    expect(domainFailure(new Error('password authentication failed for user "secret"')).message).toBe('The page could not be loaded. Try again.');
    expect(domainFailure(new Error('password authentication failed for user "secret"')).message.includes('secret')).toBe(false);
  });

  test('version conflicts keep a current version label', () => {
    const failure = domainFailure(versionConflict(4, 'cleared'));
    expect(failure.conflict).toEqual({ currentVersion: 4, stateLabel: 'cleared' });
    expect(failure.message).toContain('Current version is 4');
    expect(failure.message).toContain('draft');
  });
});
