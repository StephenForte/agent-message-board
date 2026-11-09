import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../env';
import { invalidCursor, isUuid } from '../kernel';

export function binding(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
type Position = { at: string; id: string };
function mac(value: string): Buffer {
  return createHmac('sha256', loadEnv().CURSOR_HMAC_SECRET).update(value).digest();
}
export function encodeCursor(scope: string, position: Position): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, scope, ...position })).toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}
export function decodeCursor(cursor: string | undefined, scope: string): Position | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parts = cursor.split('.');
    if (parts.length !== 2) throw new Error();
    const [payload, signature] = parts as [string, string];
    const supplied = Buffer.from(signature, 'base64url');
    const expected = mac(payload);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.scope !== scope || !isUuid(value.id) || typeof value.at !== 'string'
      || !Number.isFinite(Date.parse(value.at))) throw new Error();
    return { at: value.at, id: value.id };
  } catch {
    throw invalidCursor('Restart this list without a cursor; its scope or filters may have changed.');
  }
}
