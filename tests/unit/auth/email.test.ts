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
