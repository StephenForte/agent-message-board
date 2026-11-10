import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../../env';
import { invalidCursor, isUuid } from '../kernel';

export function auditScope(orgId: string, includeSessionSeen: boolean): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, orgId, includeSessionSeen })).digest('hex');
}

type Position = { at: string; id: string };

function mac(value: string): Buffer {
  return createHmac('sha256', loadEnv().CURSOR_HMAC_SECRET).update(value).digest();
}

export function encodeAuditCursor(scope: string, position: Position): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, scope, ...position })).toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}

export function decodeAuditCursor(cursor: string | undefined, scope: string): Position | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parts = cursor.split('.');
    if (parts.length !== 2) throw new Error('malformed');
    const [payload, signature] = parts as [string, string];
    const supplied = Buffer.from(signature, 'base64url');
    const expected = mac(payload);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('signature');
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('payload');
    const record = value as { v?: unknown; scope?: unknown; at?: unknown; id?: unknown };
    if (record.v !== 1 || record.scope !== scope || typeof record.id !== 'string' || !isUuid(record.id)) throw new Error('scope');
    if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) throw new Error('time');
    return { at: record.at, id: record.id };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw invalidCursor('Restart this audit log without a cursor. Its page link may be out of date.');
  }
}
