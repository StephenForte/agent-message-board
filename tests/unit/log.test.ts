import { expect, test } from 'vitest';
import { createLogger, redact, requestId, redactRoute } from '../../src/lib/log';

test('redacts nested secrets, bodies, headers and agent tokens in any substring', () => {
  const input = {
    headers: { Authorization: 'Bearer private', COOKIE: 'session=private', 'set-cookie': 'private' },
    nested: [{ password: 'private', token: 'private', secret: 'private', body: 'private' }],
    message: 'before amb_Ab12_Zx34 after',
    amb_Ab12_Zx34: 'key',
  };
  const result = JSON.stringify(redact(input));
  expect(result).not.toContain('private');
  expect(result).not.toContain('amb_Ab12_Zx34');
  expect(result).toContain('before [REDACTED] after');
  expect(input.headers.Authorization).toBe('Bearer private');
});
test('redacts Headers instances and tolerates cycles', () => {
  expect(redact(new Headers({ authorization: 'private' }))).toEqual({ authorization: '[REDACTED]' });
  const input: Record<string, unknown> = {}; input.self = input;
  expect(redact(input)).toEqual({ self: '[Circular]' });
});
test('emits structured request fields and respects LOG_LEVEL', () => {
  const lines: string[] = [];
  const log = createLogger('warn', (line) => lines.push(line));
  log('info', { body: 'private' });
  log('warn', { request_id: 'request-1', route: '/api/health', status: 503, latency_ms: 10, token: 'private' });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({ request_id: 'request-1', route: '/api/health', status: 503, latency_ms: 10, token: '[REDACTED]' });
});
test('honours safe request ids and replaces unsafe or secret ids', () => {
  expect(requestId('request-123')).toBe('request-123');
  for (const input of [null, '', 'bad id', 'a'.repeat(129), 'amb_public_private', 'line\nbreak']) {
    expect(requestId(input)).toMatch(/^[a-f0-9-]{36}$/);
  }
});

test('credential path segments are redacted while ordinary paths retain their names', () => {
  expect(redactRoute('/activate/private-credential?next=secret')).toBe('/activate/[redacted]');
  expect(redactRoute('/join/private-credential?next=secret')).toBe('/join/[redacted]');
  expect(redactRoute('/api/auth/reset-password/private-credential')).toBe('/api/auth/reset-password/[redacted]');
  expect(redactRoute('/%61ctivate/private-credential/extra')).toBe('/activate/[redacted]');
  expect(redactRoute('//activate/private-credential')).toBe('/activate/[redacted]');
  expect(redactRoute('/ignored/../activate/private-credential')).toBe('/activate/[redacted]');
  expect(redactRoute('https://example.com/api/auth/reset-password/private-credential')).toBe('/api/auth/reset-password/[redacted]');
  expect(redactRoute('/api/health?private=secret')).toBe('/api/health');
  expect(redactRoute('/projects/alpha')).toBe('/projects/alpha');
  expect(redactRoute('/activate/%bad')).toBe('/[redacted]');
});
