import { expect, test, vi } from 'vitest';
import { binding, decodeCursor, encodeCursor } from '../../../src/domain/messages/cursor';
import { flagsInput, listInput, parse, replyInput, rootInput } from '../../../src/domain/messages/validation';

const id = '019a0000-0000-7000-8000-000000000001';
test('defaults and recipient normalization are deterministic', () => {
  expect(parse(rootInput, { projectId: id, title: 'title', body: 'raw', recipients: [id, id], idempotencyKey: 'key' }))
    .toMatchObject({ category: 'note', urgent: false, pinned: false, recipients: [id] });
  expect(parse(listInput, { projectIds: [id, id] })).toEqual({ projectIds: [id], status: 'active', sort: 'activity', limit: 20 });
});
test.each([0, 101, 1.5])('page limit %s is rejected', (limit) => {
  expect(() => parse(listInput, { projectIds: [id], limit })).toThrow('validation_failed');
});
test('recipient cap applies before deduplication', () => {
  expect(() => parse(replyInput, { rootId: id, body: '', recipients: Array(21).fill(id), idempotencyKey: 'key' })).toThrow('validation_failed');
});
test('flags never accept immutable body/title or toggles', () => {
  for (const field of ['body', 'title', 'toggleUrgent']) expect(() => parse(flagsInput, { rootId: id, expectedVersion: 1, idempotencyKey: 'key', [field]: 'bad' })).toThrow('validation_failed');
});
test('UTF-8 byte count controls bodies and Unicode code points control titles', () => {
  const input = { projectId: id, title: '😀'.repeat(200), body: '😀'.repeat(8192), idempotencyKey: 'key' };
  expect(parse(rootInput, input).body).toBe(input.body);
  expect(() => parse(rootInput, { ...input, body: input.body + 'a' })).toThrow('content_too_large');
  expect(() => parse(rootInput, { ...input, title: input.title + 'a' })).toThrow('validation_failed');
});
test('NUL and malformed identifiers are domain validation errors', () => {
  expect(() => parse(rootInput, { projectId: id, title: 'x', body: '\0', idempotencyKey: 'key' })).toThrow('validation_failed');
  expect(() => parse(listInput, { projectIds: ['bad'] })).toThrow('validation_failed');
});
test('signed cursor retains PG precision and binds filters/scope', () => {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost/test');
  try {
    const scope = binding({ org: id, filters: 'a' });
    const position = { at: '2026-01-01T00:00:00.000001Z', id };
    const cursor = encodeCursor(scope, position);
    expect(decodeCursor(cursor, scope)).toEqual(position);
    expect(() => decodeCursor(cursor, binding({ org: id, filters: 'b' }))).toThrow('invalid_cursor');
    expect(() => decodeCursor(cursor.replace(/^./, cursor[0] === 'a' ? 'b' : 'a'), scope)).toThrow('invalid_cursor');
    expect(decodeCursor(undefined, scope)).toBeUndefined();
  } finally { vi.unstubAllEnvs(); }
});
