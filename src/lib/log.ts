import { randomUUID } from 'node:crypto';
import { credentialPathPrefixes } from '../auth/paths';

const agentToken = /amb_[A-Za-z0-9]+_[A-Za-z0-9]+/g;
const sensitiveKey = /^(authorization|proxy-authorization|cookie|set-cookie|password|token|secret|body)$/i;
const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };
type Level = Exclude<keyof typeof levels, 'silent'>;

export function requestId(inbound?: string | null): string {
  return inbound && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(inbound) && !/amb_[A-Za-z0-9]+_[A-Za-z0-9]+/.test(inbound)
    ? inbound : randomUUID();
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return value.replace(agentToken, '[REDACTED]');
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Headers) return redact(Object.fromEntries(value.entries()), seen);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key.replace(agentToken, '[REDACTED]'),
    sensitiveKey.test(key) ? '[REDACTED]' : redact(entry, seen),
  ]));
}

export function createLogger(level: keyof typeof levels = 'info', write: (line: string) => void = console.log) {
  return (severity: Level, fields: Record<string, unknown>) => {
    if (levels[severity] < levels[level]) return;
    write(JSON.stringify(redact({ ...fields, level: severity, time: new Date().toISOString() })));
  };
}

/** Drop queries and redact everything below a known credential-bearing path prefix. */
export function redactRoute(rawUrl: string): string {
  const raw = rawUrl.split(/[?#]/, 1)[0] ?? '/';
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return '/[redacted]'; }
  const prefix = credentialPathPrefixes.find((candidate) => path.toLowerCase().startsWith(candidate.toLowerCase()));
  return prefix ? `${prefix}[redacted]` : raw;
}
