import { afterEach, expect, test, vi } from 'vitest';
import { CapturingEmailAdapter, ConsoleEmailAdapter, ResendEmailAdapter } from '../../../src/auth/email';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test('capturing adapter retains exact messages without logging', async () => {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const email = new CapturingEmailAdapter();
  const message = { to: 'owner@example.com', subject: 'Verification', text: 'A test link' };
  await email.send(message); expect(email.messages).toEqual([message]); expect(spy).not.toHaveBeenCalled();
});
test('Resend sends using the adapter contract and suppresses provider error content', async () => {
  const send = vi.fn().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response('private provider payload', { status: 403 }));
  vi.stubGlobal('fetch', send);
  const email = new ResendEmailAdapter('test-key', 'board@example.com');
  const message = { to: 'owner@example.com', subject: 'Reset', text: 'test link' };
  await email.send(message);
  expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ from: 'board@example.com', ...message });
  await expect(email.send(message)).rejects.toThrow(/^Email delivery unavailable$/);
});
test('console delivery fails closed in production', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  await expect(new ConsoleEmailAdapter().send({ to: 'owner@example.com', subject: 'Test', text: 'test link' })).rejects.toThrow('disabled');
});

test('development console verification links omit activation credentials but still verify the account', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const credential = 'synthetic-activation-credential';
  const callback = `/verify-email?${new URLSearchParams({ returnTo: `/activate/${'x'.repeat(43)}` })}`;
  const link = new URL('http://localhost:3000/api/auth/verify-email');
  link.searchParams.set('token', 'synthetic-verification-probe');
  link.searchParams.set('callbackURL', callback);
  await new ConsoleEmailAdapter().send({ to: 'owner@example.com', subject: 'Verify', text: `Verify: ${link}` });
  const logged = spy.mock.calls[0][1];
  expect(JSON.stringify(logged)).not.toContain('x'.repeat(43));
  const loggedLink = new URL(logged.text.match(/https?:\/\/\S+/)![0]);
  expect(loggedLink.pathname).toBe('/api/auth/verify-email');
  expect(loggedLink.searchParams.get('token')).toBe('synthetic-verification-probe');
  expect(loggedLink.searchParams.get('callbackURL')).toBe('/verify-email');
  await new ConsoleEmailAdapter().send({ to: 'owner@example.com', subject: 'Test', text: `http://localhost:3000/activate/${credential}` });
  expect(JSON.stringify(spy.mock.calls)).not.toContain(credential);
});
