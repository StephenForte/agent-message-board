import { expect, test } from 'vitest';
import { authRequestUrl, safeActivationReturn, verificationCallback } from '../../../src/auth/paths';
test('auth request URLs normalize base trailing slashes', () => {
  for (const base of ['https://board.example.com', 'https://board.example.com/']) {
    expect(authRequestUrl(base, '/sign-in/email')).toBe('https://board.example.com/api/auth/sign-in/email');
  }
});
test('verification preserves only validated activation destinations', () => {
  const next = `/activate/${'x'.repeat(43)}`;
  expect(safeActivationReturn(next)).toBe(next);
  const join = `/join/${'y'.repeat(43)}`;
  expect(safeActivationReturn(join)).toBe(join);
  expect(new URL(verificationCallback(next), 'https://example.com').searchParams.get('returnTo')).toBe(next);
  for (const value of ['//evil.example.com', 'https://evil.example.com', '/activate/short', '/activate/' + 'x'.repeat(43) + '?redirect=evil', undefined]) {
    expect(safeActivationReturn(value)).toBeNull(); expect(verificationCallback(value)).toBe('/verify-email');
  }
});
