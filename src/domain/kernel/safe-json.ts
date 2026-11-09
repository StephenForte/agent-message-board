import { createHash } from 'node:crypto';
import { DomainError } from './errors';

const secretKeys = new Set([
  'password',
  'secret',
  'token',
  'token_hash',
  'tokenhash',
  'authorization',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'body',
]);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertSafeJson(value: unknown, maxOctets: number): void {
  const normalized = normalize(value);
  rejectSecretKeys(normalized);
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > maxOctets) {
    throw new DomainError('content_too_large');
  }
}

function normalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DomainError('validation_failed', { reason: 'non_finite_number' });
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) throw new DomainError('validation_failed', { reason: 'undefined_field' });
      out[key] = normalize(record[key]);
    }
    return out;
  }
  throw new DomainError('validation_failed', { reason: 'unsupported_json' });
}

function rejectSecretKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretKeys(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (secretKeys.has(key.toLowerCase())) throw new DomainError('validation_failed', { reason: 'secret_field' });
    rejectSecretKeys(child);
  }
}
