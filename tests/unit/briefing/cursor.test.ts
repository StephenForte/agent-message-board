import { beforeAll, expect, test } from 'vitest';
import { hash, sequence, sign, verify } from '../../../src/domain/briefing/cursor';
import { utf8Prefix } from '../../../src/domain/briefing';

beforeAll(() => { process.env.DATABASE_URL = 'postgres://localhost/unit_fixture'; process.env.CURSOR_HMAC_SECRET = 'unit-test-briefing-signing-key-over-thirty-two-characters'; });
const binding = { org: 'org', scope_hash: hash(['actor', 'project']), filter_hash: hash('all') };
test('event format is distinct, authenticated, scoped and versioned', () => {
  const cursor = sign(binding, { type: 'events', seq: 17 });
  expect(sequence(cursor, binding)).toBe(17);
  expect(verify(cursor, binding)).toMatchObject({ v: 1, ...binding, seq: 17 });
  for (const other of [ { ...binding, org: 'other' }, { ...binding, scope_hash: 'other' }, { ...binding, filter_hash: 'other' } ]) {
    expect(() => sequence(cursor, other)).toThrow(expect.objectContaining({ code: 'invalid_cursor' }));
  }
  for (const token of ['bad', cursor + 'x', sign(binding, { type: 'group', seq: 17 }), sign(binding, { type: 'events', seq: -1 }), sign(binding, { v: 0, type: 'events', seq: 17 })]) {
    expect(() => sequence(token, binding)).toThrow(expect.objectContaining({ code: 'invalid_cursor', details: { resync: expect.any(String) } }));
  }
});
test('UTF-8 clipping returns only verbatim complete code points within budget', () => {
  const text = 'a🌊é漢b';
  for (let bytes = 0; bytes <= 15; bytes++) {
    const result = utf8Prefix(text, bytes);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(bytes);
    expect(text.startsWith(result)).toBe(true);
    expect(result).not.toContain('\ufffd');
  }
});
