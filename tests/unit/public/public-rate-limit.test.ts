import { expect, test } from 'vitest';
import {
  PUBLIC_RATE_LIMIT_GLOBAL,
  PUBLIC_RATE_LIMIT_MAX_ADDRESSES,
  PUBLIC_RATE_LIMIT_PER_ADDRESS,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
  createPublicRateLimiter,
  publicClientAddress,
} from '../../../src/lib/public-rate-limit';
import { isPublicRateLimitedPath } from '../../../src/proxy';

test('exports the D-036 defaults', () => {
  expect(PUBLIC_RATE_LIMIT_PER_ADDRESS).toBe(60);
  expect(PUBLIC_RATE_LIMIT_GLOBAL).toBe(600);
  expect(PUBLIC_RATE_LIMIT_MAX_ADDRESSES).toBe(10_000);
  expect(PUBLIC_RATE_LIMIT_WINDOW_MS).toBe(60_000);
});

test('per-address limit allows N and rejects N+1', () => {
  const check = createPublicRateLimiter({
    perAddress: 3, global: 100, maxAddresses: 10, windowMs: 60_000, now: () => 0,
  });
  expect(check('203.0.113.1')).toEqual({ allowed: true });
  expect(check('203.0.113.1')).toEqual({ allowed: true });
  expect(check('203.0.113.1')).toEqual({ allowed: true });
  expect(check('203.0.113.1')).toEqual({ allowed: false, scope: 'address', retryAfterSeconds: 60 });
  expect(check('203.0.113.2')).toEqual({ allowed: true });
});

test('global limit rejects across many addresses', () => {
  const check = createPublicRateLimiter({
    perAddress: 10, global: 3, maxAddresses: 10, windowMs: 60_000, now: () => 0,
  });
  expect(check('a').allowed).toBe(true);
  expect(check('b').allowed).toBe(true);
  expect(check('c').allowed).toBe(true);
  expect(check('d')).toEqual({ allowed: false, scope: 'global', retryAfterSeconds: 60 });
  expect(check('e')).toEqual({ allowed: false, scope: 'global', retryAfterSeconds: 60 });
});

test('checks per-address before global so a rejected address does not drain global budget', () => {
  const check = createPublicRateLimiter({
    perAddress: 1, global: 2, maxAddresses: 10, windowMs: 60_000, now: () => 0,
  });
  expect(check('noisy').allowed).toBe(true);
  expect(check('noisy')).toMatchObject({ allowed: false, scope: 'address' });
  expect(check('noisy')).toMatchObject({ allowed: false, scope: 'address' });
  expect(check('other').allowed).toBe(true);
  expect(check('third')).toEqual({ allowed: false, scope: 'global', retryAfterSeconds: 60 });
});

test('a global rejection does not consume that address slot', () => {
  const check = createPublicRateLimiter({
    perAddress: 1, global: 1, maxAddresses: 1, windowMs: 60_000, now: () => 0,
  });
  expect(check('kept').allowed).toBe(true);
  expect(check('blocked')).toEqual({ allowed: false, scope: 'global', retryAfterSeconds: 60 });
  expect(check('kept')).toEqual({ allowed: false, scope: 'address', retryAfterSeconds: 60 });
});

test('a new window resets both counts and retryAfterSeconds is correct mid-window', () => {
  let now = 0;
  const check = createPublicRateLimiter({
    perAddress: 1, global: 2, maxAddresses: 10, windowMs: 60_000, now: () => now,
  });
  expect(check('a')).toEqual({ allowed: true });
  expect(check('a')).toEqual({ allowed: false, scope: 'address', retryAfterSeconds: 60 });
  expect(check('b')).toEqual({ allowed: true });
  expect(check('c')).toEqual({ allowed: false, scope: 'global', retryAfterSeconds: 60 });
  now = 30_000;
  expect(check('c')).toEqual({ allowed: false, scope: 'global', retryAfterSeconds: 30 });
  now = 59_001;
  expect(check('c')).toEqual({ allowed: false, scope: 'global', retryAfterSeconds: 1 });
  now = 60_000;
  expect(check('a')).toEqual({ allowed: true });
  expect(check('c')).toEqual({ allowed: true });
});

test('retryAfterSeconds stays inside 1 to 60 when the window is longer', () => {
  const check = createPublicRateLimiter({
    perAddress: 1, global: 100, maxAddresses: 10, windowMs: 120_000, now: () => 0,
  });
  expect(check('a').allowed).toBe(true);
  expect(check('a')).toEqual({ allowed: false, scope: 'address', retryAfterSeconds: 60 });
});

test('address cap stays full and drops past-window entries before a new address', () => {
  let now = 0;
  const check = createPublicRateLimiter({
    perAddress: 1, global: 100, maxAddresses: 2, windowMs: 60_000, now: () => now,
  });
  expect(check('a').allowed).toBe(true);
  expect(check('b').allowed).toBe(true);
  expect(check('c').allowed).toBe(true);
  expect(check('c').allowed).toBe(true);
  expect(check('a')).toMatchObject({ allowed: false, scope: 'address' });
  expect(check('b')).toMatchObject({ allowed: false, scope: 'address' });

  now = 60_000;
  expect(check('past').allowed).toBe(true);
  now = 120_000;
  expect(check('current').allowed).toBe(true);
  expect(check('fresh').allowed).toBe(true);
  expect(check('fresh')).toMatchObject({ allowed: false, scope: 'address' });
  expect(check('current')).toMatchObject({ allowed: false, scope: 'address' });
  expect(check('past').allowed).toBe(true);
  expect(check('past').allowed).toBe(true);
  expect(check('overflow').allowed).toBe(true);
  expect(check('overflow').allowed).toBe(true);
});

test('client address prefers True-Client-IP, then the first forwarded hop, else unknown', () => {
  const headers = (init: Record<string, string>) => new Headers(init);
  expect(publicClientAddress(headers({
    'True-Client-IP': ' 203.0.113.5 ',
    'X-Forwarded-For': '198.51.100.1',
  }))).toBe('203.0.113.5');
  expect(publicClientAddress(headers({
    'X-Forwarded-For': ' 198.51.100.8 , 203.0.113.9 ',
  }))).toBe('198.51.100.8');
  expect(publicClientAddress(headers({
    'True-Client-IP': '   ',
    'X-Forwarded-For': '198.51.100.2',
  }))).toBe('198.51.100.2');
  expect(publicClientAddress(headers({ 'X-Forwarded-For': ' , 198.51.100.3' }))).toBe('unknown');
  expect(publicClientAddress(headers({ 'True-Client-IP': '', 'X-Forwarded-For': '   ' }))).toBe('unknown');
  expect(publicClientAddress(headers({}))).toBe('unknown');
  const long = '9'.repeat(70);
  expect(publicClientAddress(headers({ 'True-Client-IP': `  ${long}  ` }))).toBe('9'.repeat(64));
  expect(publicClientAddress(headers({ 'X-Forwarded-For': `${long}, 1.2.3.4` }))).toBe('9'.repeat(64));
});

test('only public paths count toward the public rate limit', () => {
  for (const path of ['/supa/t16-smoke', '/supa/t16-smoke/threads/x', '/nope/missing']) {
    expect(isPublicRateLimitedPath(path), path).toBe(true);
  }
  for (const path of ['/projects/x', '/_next/static/a.js', '/api/mcp', '/', '/supa']) {
    expect(isPublicRateLimitedPath(path), path).toBe(false);
  }
});
