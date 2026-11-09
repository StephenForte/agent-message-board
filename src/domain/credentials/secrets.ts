import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Discard 248..255 so each base62 character has exactly four byte preimages. */
export function randomBase62(length: number): string {
  let result = '';
  while (result.length < length) {
    for (const byte of randomBytes(Math.max(16, length - result.length))) {
      if (byte >= 248) continue;
      result += alphabet[byte % 62];
      if (result.length === length) break;
    }
  }
  return result;
}
export function hashSecret(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function matchesSecret(value: string, expected: string): boolean {
  const actual = Buffer.from(hashSecret(value), 'hex');
  const valid = /^[a-f0-9]{64}$/.test(expected);
  const stored = valid ? Buffer.from(expected, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(actual, stored) && valid;
}
