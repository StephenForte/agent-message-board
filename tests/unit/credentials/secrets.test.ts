import { randomBytes } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { hashSecret, matchesSecret, randomBase62 } from '../../../src/domain/credentials/secrets';

vi.mock('node:crypto', async (original) => ({ ...await original<typeof import('node:crypto')>(), randomBytes: vi.fn() }));

test('rejection sampling discards 248..255 rather than biasing base62 output', () => {
  vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from([248, 249, 250, 251, 252, 253, 254, 255, 0, 61, 62, 247]) as never);
  expect(randomBase62(4)).toBe('0z0z');
});
test('sampling draws again when rejected bytes leave too few characters', () => {
  vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from([255, 1]) as never).mockReturnValueOnce(Buffer.from([2, 3]) as never);
  expect(randomBase62(3)).toBe('123');
});
test('hash comparison handles mismatches and malformed stored hashes safely', () => {
  const digest = hashSecret('test-input');
  expect(digest).toHaveLength(64);
  expect(matchesSecret('test-input', digest)).toBe(true);
  expect(matchesSecret('different', digest)).toBe(false);
  expect(matchesSecret('test-input', '')).toBe(false);
  expect(matchesSecret('test-input', 'g'.repeat(64))).toBe(false);
});
