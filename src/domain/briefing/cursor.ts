import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../env';
import { invalidCursor } from '../kernel';

export const CURSOR_VERSION = 1;
export const RESYNC = 'Start a fresh board check without cursor or continuation; scope, permissions, or filters may have changed.';
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function mac(payload: string) {
  return createHmac('sha256', loadEnv().CURSOR_HMAC_SECRET).update(payload).digest();
}
export type Binding = { org: string; scope_hash: string; filter_hash: string };
export function sign(binding: Binding, fields: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...binding, ...fields })).toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}
export function verify(token: string, binding: Binding): Record<string, unknown> {
  try {
    if (token.length > 65536 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new Error();
    const [payload, signature] = token.split('.') as [string, string];
    const expected = mac(payload);
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (value.v !== CURSOR_VERSION || value.org !== binding.org || value.scope_hash !== binding.scope_hash
      || value.filter_hash !== binding.filter_hash) throw new Error();
    return value;
  } catch {
    throw invalidCursor(RESYNC);
  }
}
export function sequence(token: string, binding: Binding): number {
  const value = verify(token, binding);
  if (value.type !== 'events' || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0) throw invalidCursor(RESYNC);
  return Number(value.seq);
}
